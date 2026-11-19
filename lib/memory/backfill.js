import { chunkEvents } from "./chunking.js";
import { embedTexts } from "./embed-client.js";
import { UNKNOWN_PEER_KEY } from "./peer.js";
import { appendRows, chunkKey, emptyMeta, loadIndex, writeMeta, } from "./index-store.js";
import { listSessionIdsByCwd, readSessionDigest } from "./transcript-source.js";
/**
 * 单批送进 /embed 的 chunk 数。
 * 定这个值的不是吞吐而是**超时**：11-19 实测 512 token 宽的推理约 625ms/行（本机 q8 单线程、
 * 截断修好后重测：1 行 759ms、4 行 2525ms、8 行 4996ms、16 行 9989ms），而客户端吃
 * `memory.timeoutMs`（默认 8000）的 `AbortSignal.timeout` —— 一批里只要凑够十几条长文，
 * 16 行满宽就是 10 秒，一定超时，于是整轮原地重试。8 行把最坏情况压到 5 秒，
 * 而算力本来就由逐行推理主导，批次减半几乎不影响总耗时。
 */
const EMBED_BATCH = 8;
/** 单次作业最多落多少 chunk：首轮全量回填不许把机器吃满 */
const PER_RUN_CHUNK_LIMIT = 240;
const MAX_ATTEMPTS = 3;
function letLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
/**
 * 跑一轮同步。永不抛：失败收敛成 `summary.failed` + 只含 code 的 warn。
 */
export async function runBackfillOnce(deps) {
    const { ctx, logger, dir } = deps;
    const summary = {
        sessions: 0,
        indexed: 0,
        peerUnknown: 0,
        unreadable: 0,
        dropped: 0,
        droppedScaffold: 0,
        failed: false,
        rebuilt: false,
    };
    const status = await loadIndex(dir);
    if (status.state === 'rebuilt') {
        summary.rebuilt = true;
        logger.warn(`akane memory: 索引与当前 schema/模型/维度不一致或已错位，清空重建（reason=${status.reason}）`);
    }
    const meta = status.state === 'ready' ? status.meta : emptyMeta();
    const known = status.state === 'ready' ? status.keys : new Set();
    if (deps.probe) {
        let up = false;
        try {
            up = await deps.probe();
        }
        catch {
            up = false;
        }
        if (!up) {
            summary.failed = true;
            summary.failureCode = 'EMBED_UNREACHABLE';
            return summary;
        }
    }
    const listed = await listSessionIdsByCwd(ctx, deps.cwd, logger);
    if (!listed.ok || listed.value === undefined) {
        summary.failed = true;
        summary.failureCode = listed.code ?? 'QUERY_FAILED';
        return summary;
    }
    for (const sessionId of listed.value) {
        if (summary.indexed >= PER_RUN_CHUNK_LIMIT)
            break;
        summary.sessions += 1;
        const digest = await readSessionDigest(ctx, sessionId, logger);
        if (!digest.ok || digest.value === undefined) {
            // 单份读抛只影响这一份，整轮继续（§5 的「单份读抛」分支）
            summary.unreadable += 1;
            await letLoop();
            continue;
        }
        const cursor = meta.cursors[sessionId] ?? 0;
        const fresh = digest.value.events.filter((event) => event.seq > cursor);
        const lastSeq = digest.value.events.reduce((max, event) => (event.seq > max ? event.seq : max), cursor);
        if (fresh.length === 0) {
            if (lastSeq > cursor)
                meta.cursors[sessionId] = lastSeq;
            await letLoop();
            continue;
        }
        const { chunks: drafts, dropped } = chunkEvents(fresh, deps.quietWindowMs, { strictGap: true });
        summary.dropped += dropped.length;
        summary.droppedScaffold += dropped.filter((item) => item.reason === 'no-current-message').length;
        const pending = [];
        for (const draft of drafts) {
            if (summary.indexed + pending.length >= PER_RUN_CHUNK_LIMIT)
                break;
            if (known.has(chunkKey(sessionId, draft.seqStart, draft.seqEnd)))
                continue;
            pending.push(draft);
        }
        if (pending.length === 0) {
            meta.cursors[sessionId] = lastSeq;
            await letLoop();
            continue;
        }
        const vectors = await embedWithRetry(pending.map((draft) => draft.text), deps, logger);
        if (vectors === undefined) {
            summary.failed = true;
            summary.failureCode = 'EMBED_UNAVAILABLE';
            break; // 游标不动，下一轮从这里重试
        }
        const peer = deps.resolvePeer(sessionId);
        if (peer === UNKNOWN_PEER_KEY)
            summary.peerUnknown += pending.length;
        const rows = pending.map((draft) => ({
            ...draft,
            key: chunkKey(sessionId, draft.seqStart, draft.seqEnd),
            sessionId,
            peer,
        }));
        meta.cursors[sessionId] = lastSeq;
        meta.chunks += rows.length;
        try {
            await appendRows(dir, rows, vectors, meta);
        }
        catch {
            summary.failed = true;
            summary.failureCode = 'WRITE_FAILED';
            logger.warn('akane memory: 索引写入失败（code=WRITE_FAILED）');
            break;
        }
        for (const row of rows)
            known.add(row.key);
        summary.indexed += rows.length;
        await letLoop();
    }
    try {
        await writeMeta(dir, meta);
    }
    catch {
        logger.warn('akane memory: meta 写入失败（code=WRITE_FAILED）');
    }
    return summary;
}
/** 每批独立重试 ≤3 次；任一批彻底失败即整轮判失败（不做半批落盘） */
async function embedWithRetry(texts, deps, logger) {
    const vectors = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const slice = texts.slice(i, i + EMBED_BATCH);
        let done = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt += 1) {
            const result = await embedTexts(slice, deps.embed);
            if (result.ok) {
                vectors.push(...result.vectors);
                done = true;
                break;
            }
            logger.warn(`akane memory: 嵌入失败（code=${result.code}，attempt=${attempt}）`);
            await letLoop();
        }
        if (!done)
            return undefined;
    }
    return vectors;
}
/**
 * 起后台同步：先跑一轮（首轮即全量回填），之后按间隔增量。
 * 服务不可达时不轰炸重试，只按间隔自然复探 —— 启停归用户（§5）。
 */
export function startMemorySync(deps, intervalMs) {
    let stopped = false;
    let running = false;
    const tick = async () => {
        if (stopped || running)
            return;
        running = true;
        try {
            const summary = await runBackfillOnce(deps);
            if (summary.indexed > 0 || summary.rebuilt || summary.droppedScaffold > 0) {
                deps.logger.info(`akane memory: 同步 sessions=${summary.sessions} indexed=${summary.indexed} ` +
                    `peerUnknown=${summary.peerUnknown} unreadable=${summary.unreadable} ` +
                    `dropped=${summary.dropped}(脚手架错位 ${summary.droppedScaffold}) rebuilt=${summary.rebuilt}`);
            }
            if (summary.failed)
                deps.logger.warn(`akane memory: 同步未完成（code=${summary.failureCode}）`);
        }
        catch {
            deps.logger.warn('akane memory: 同步作业异常（code=JOB_CRASHED）');
        }
        finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}
//# sourceMappingURL=backfill.js.map