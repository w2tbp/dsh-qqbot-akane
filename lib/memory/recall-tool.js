import { embedTexts } from "./embed-client.js";
import { loadIndex, readChunkRows, readVectors } from "./index-store.js";
import { peerKeyOfSessionRecord, samePeer, UNKNOWN_PEER_KEY } from "./peer.js";
import { buildLists, matchesLiteral, queryTokens, selectCandidates, vectorRanked, DEFAULT_FRAGMENT_LIMIT, MAX_FRAGMENT_CHARS, MAX_RETURN_CHARS, } from "./retrieval.js";
import { containsHostLeak, readEventWindow, scrubForReturn } from "./transcript-source.js";
export const RECALL_TOOL_NAME = 'akane_recall';
/** §6 第 3 条要求返回体自带命中来源；两种来源之外再加一档「两档都命中」 */
const SOURCE_LABEL = {
    literal: '字面',
    vector: '语义',
    'literal,vector': '字面+语义',
};
const NO_QUERY = '没查到（这次的问题里没有可匹配的关键词，换一种说法再问）。';
const NOTHING_INDEXED = '没查到（她的历史索引里还没有可检索的内容）。';
const NOT_LOCATED = '没查到（暂时检索不了：当前会话没定位到，不能确定该看谁的历史）。';
const NO_MATCH = '没查到（索引里没有语义或字面够得上的记录；不要把相近的说法当成事实复述）。';
const DESCRIPTION = 'Recall what was said earlier in THIS conversation (with this same person or group), '
    + 'including turns from before the current session or a restart. '
    + 'Use it when someone asks "上次/刚才/前几天我们说过的那个…", or before stating a fact '
    + 'about what somebody said earlier. It returns quoted fragments with a timestamp and '
    + 'which lane (literal or semantic) matched. '
    + 'A weak similarity is NOT a hit: if it answers "没查到", say you do not remember instead '
    + 'of inventing an answer. Never shares memories of one person/group with another.';
/** 召回一次。永不抛。 */
export async function recallOnce(query, deps) {
    try {
        return await recallInner(query, deps);
    }
    catch {
        // 到这里只剩「我们自己写崩了」这一种情况：宿主错误都在下层收敛成 code 了
        deps.logger.warn('akane memory: 召回作业异常（code=RECALL_CRASHED）');
        return { text: NOTHING_INDEXED, hits: 0, degraded: false };
    }
}
async function recallInner(query, deps) {
    const limit = deps.limit ?? DEFAULT_FRAGMENT_LIMIT;
    const tokens = queryTokens(query);
    if (tokens.length === 0)
        return { text: NO_QUERY, hits: 0, degraded: false };
    const currentPeer = deps.currentPeer;
    if (currentPeer === undefined || currentPeer === UNKNOWN_PEER_KEY) {
        deps.logger.warn('akane memory: 当前会话归属未定位，按 fail-closed 不召回（code=PEER_UNRESOLVED）');
        return { text: NOT_LOCATED, hits: 0, degraded: false };
    }
    const status = await loadIndex(deps.dir);
    const rows = status.state === 'empty' ? [] : await readChunkRows(deps.dir);
    const scoped = [];
    const positions = [];
    rows.forEach((row, index) => {
        // 归属过滤在打分之前：别的 peer 的 chunk 连分数都不该有
        if (samePeer(row.peer, currentPeer)) {
            scoped.push(row);
            positions.push(index);
        }
    });
    if (scoped.length === 0)
        return { text: NOTHING_INDEXED, hits: 0, degraded: false };
    const literalKeys = scoped
        .filter((row) => matchesLiteral(row.text, tokens))
        .sort((a, b) => b.time - a.time)
        .map((row) => row.key);
    let degraded = false;
    const queryVector = await embedQuery(query, deps);
    if (queryVector === undefined)
        degraded = true;
    let vectorKeys = [];
    if (queryVector !== undefined) {
        const all = await readVectors(deps.dir, rows.length);
        if (all === undefined) {
            // 文本与向量对不上：宁缺毋滥，错位的向量算出来的相似度是假的
            deps.logger.warn('akane memory: 向量与文本条数不匹配，语义档跳过（code=VECTOR_MISMATCH）');
            degraded = true;
        }
        else {
            vectorKeys = vectorRanked(scoped, positions.map((index) => all[index]), queryVector, limit * 3);
        }
    }
    const candidates = selectCandidates(scoped, buildLists({ literalKeys, vectorKeys }), limit);
    if (candidates.length === 0) {
        return { text: degraded ? `${NO_MATCH}（这次只有字面档可用）` : NO_MATCH, hits: 0, degraded };
    }
    const fragments = await Promise.all(candidates.map((candidate) => renderFragment(candidate, deps)));
    const kept = fragments.filter((fragment) => fragment !== undefined);
    if (kept.length === 0)
        return { text: NO_MATCH, hits: 0, degraded };
    const header = degraded
        ? '以下片段来自她的历史索引（语义档这次不可用，只按字面匹配）：'
        : '以下片段来自她的历史索引，按命中强度排列：';
    const body = joinWithinBudget([header, ...kept], MAX_RETURN_CHARS);
    return { text: body, hits: kept.length, degraded };
}
/** 查询向量；服务不可达/维度不对一律回 undefined（不许降级到远程 API） */
async function embedQuery(query, deps) {
    const result = await embedTexts([query], deps.embed);
    if (!result.ok) {
        deps.logger.warn(`akane memory: 查询嵌入不可用，走字面档（code=${result.code}）`);
        return undefined;
    }
    const vector = result.vectors[0];
    if (vector === undefined)
        return undefined;
    return Float32Array.from(vector);
}
/** 单片段：回 T1 取原文窗口，取不到就用索引里存的那份 */
async function renderFragment(candidate, deps) {
    let body;
    if (deps.readWindow) {
        try {
            const window = await deps.readWindow(candidate.sessionId, candidate.seqStart);
            if (window !== undefined && window.length > 0) {
                body = window
                    .map((event) => scrubForReturn(event.rawText))
                    .filter((text) => text !== '' && !containsHostLeak(text))
                    .join('\n');
            }
        }
        catch {
            deps.logger.warn('akane memory: T1 窗口回读异常，回落索引文本（code=WINDOW_READ_FAILED）');
        }
    }
    const text = (body && body !== '' ? body : scrubForReturn(candidate.text)).slice(0, MAX_FRAGMENT_CHARS);
    if (text === '' || containsHostLeak(text)) {
        deps.logger.warn('akane memory: 片段清洗后仍含主机路径，整条丢弃（code=LEAK_DROPPED）');
        return undefined;
    }
    const when = new Date(candidate.time);
    const stamp = Number.isFinite(candidate.time)
        ? `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
        : '时间未知';
    const who = candidate.role === 'akane' ? '她说过' : '对方说过';
    const source = SOURCE_LABEL[candidate.sources.join(',')] ?? '字面';
    const tail = candidate.vectorScore === undefined ? '' : `，相似度 ${candidate.vectorScore.toFixed(3)}`;
    return `[${stamp}] ${who}（来源：${source}${tail}）\n${text}`;
}
/** 逐条累加到硬顶；超限那条整条丢掉并补一行截断标记（不切半句，半句最容易被当成原话引用） */
function joinWithinBudget(lines, budget) {
    let out = '';
    for (const line of lines) {
        const next = out === '' ? line : `${out}\n\n${line}`;
        if (next.length > budget) {
            return `${out}\n\n…（还有更多命中未列出，已达返回体上限）`;
        }
        out = next;
    }
    return out;
}
function pad(value) {
    return value < 10 ? `0${value}` : String(value);
}
/** 注册 `akane_recall`；由调用方在 `memory.enabled` 为真时才调，这里不再判开关 */
export function registerRecallTool(ctx, manager, deps) {
    const tools = ctx.get?.('tools');
    if (!tools?.register) {
        deps.logger.warn('akane memory: tools 服务不可用，akane_recall 未注册');
        return;
    }
    tools.register({
        name: RECALL_TOOL_NAME,
        description: DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'What to look for, in the words somebody would actually use. Chinese keywords work best.',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    hits: { type: 'integer' },
                    degraded: { type: 'boolean' },
                },
                required: ['text', 'hits', 'degraded'],
                additionalProperties: false,
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: v.text }];
            },
        },
        async execute(args, exec) {
            const query = args?.query;
            if (typeof query !== 'string' || query.trim() === '') {
                return { text: NO_QUERY, hits: 0, degraded: false };
            }
            const record = manager.findByAgent(exec.agent);
            const peer = record === undefined ? undefined : peerKeyOfSessionRecord(record);
            return recallOnce(query, {
                ...deps,
                currentPeer: peer,
                readWindow: (sessionId, seq) => readEventWindow(ctx, sessionId, seq, 4, 2, deps.logger).then((result) => result.value),
            });
        },
    });
    deps.logger.info('akane memory: akane_recall 工具已注册');
}
//# sourceMappingURL=recall-tool.js.map