/** 本模块允许触碰的方法名白名单（测试钉住：出现 search* 即红） */
export const ALLOWED_METHODS = [
    'listSessions',
    'filterSessions',
    'filterEvents',
    'readSession',
    'readEvent',
    'listEvents',
    'observeSession',
    'readSurface',
    'traceSession',
];
/** ctx.get 的非抛出版本（与 host/adapter.ts 同一手法，这里不引它以免拉进无关能力） */
function safeGet(ctx, name) {
    try {
        return ctx.get(name);
    }
    catch {
        return undefined;
    }
}
/** 取服务面；缺失或形态不对都回 undefined（调用方降级，不抛） */
function queryService(ctx) {
    const service = safeGet(ctx, 'sessionQuery');
    if (!service)
        return undefined;
    if (typeof service.filterSessions !== 'function' || typeof service.readSession !== 'function')
        return undefined;
    return service;
}
/**
 * 从单个事件取正文 —— **只从 type 推角色，绝不把 data 原样丢回**。
 *
 * 两种 payload 形状不对称，实测自她现网转录（136/136 条 user 事件）：
 * `user/message` 的 data 直接就是消息本身（keys = content/id/role/source），
 * 而 `assistant/message` 的 data 包一层 `{turn,step,message,...}`。
 * 写成同一条路径会静默产出 0 条对方发言 —— 整条索引只剩她自己的话。
 */
export function eventToTranscript(event) {
    const rec = event;
    if (!rec || typeof rec !== 'object')
        return undefined;
    const type = rec['type'];
    const seq = rec['seq'];
    const time = rec['time'];
    if (typeof seq !== 'number' || typeof time !== 'number')
        return undefined;
    const role = type === 'user/message' ? 'peer' : type === 'assistant/message' ? 'akane' : undefined;
    if (role === undefined)
        return undefined;
    const data = rec['data'];
    if (!data)
        return undefined;
    const message = role === 'peer' ? data : data['message'];
    const content = message?.['content'];
    if (!Array.isArray(content))
        return undefined;
    const text = content
        .filter((b) => !!b && typeof b === 'object')
        .filter((b) => b['type'] === 'text' && typeof b['text'] === 'string')
        .map((b) => b['text'])
        .join('\n');
    return { seq, time, role, rawText: text };
}
/**
 * 按 cwd 圈出「她自己的」转录供回填遍历。
 *
 * 这条只用于**取哪些文件来建索引**，绝不参与召回过滤 —— 召回只认 chunk.peer。
 * 同根目录下另有 11 份别人的转录（含用户本人的开发对话），把它们混进语料是
 * 本项目最贵的一种错，所以本模块不提供任何「按 cwd 放宽」的入口。
 */
export async function listSessionIdsByCwd(ctx, cwd, logger) {
    const service = queryService(ctx);
    if (!service) {
        logger.warn('akane memory: sessionQuery 服务不可用（code=SERVICE_ABSENT）');
        return { ok: false, code: 'SERVICE_ABSENT' };
    }
    try {
        const records = await service.filterSessions([{ kind: 'cwd', values: [cwd] }]);
        const ids = [];
        for (const record of records) {
            const header = record?.header;
            if (typeof header?.id === 'string')
                ids.push(header.id);
        }
        ids.sort(); // 稳定顺序：回填游标与幂等判定都依赖它
        return { ok: true, value: ids };
    }
    catch (err) {
        logger.warn(`akane memory: 会话列举失败（code=${codeOf(err)}）`);
        return { ok: false, code: 'QUERY_FAILED' };
    }
}
/** 读单份转录并抽成事件序列；单份读抛只影响这一份（§5 的「单份读抛」分支） */
export async function readSessionDigest(ctx, sessionId, logger, 
/**
 * 服务端时间过滤起点（**epoch 毫秒**，11-19 实测：`{kind:'time',from}` 接受
 * `Date.UTC(...)` 的数值并命中记录，字符串只命中恰等于该字符串的事件）。
 * 给定时宿主只回该时刻之后的事件，回填每轮不必把整份 8.6MB 重解析一遍。
 * 游标判定仍以 `seq` 为准 —— 时间只是取数优化，不是正确性依赖。
 */
fromTime) {
    const service = queryService(ctx);
    if (!service)
        return { ok: false, code: 'SERVICE_ABSENT' };
    let snapshot;
    try {
        snapshot = await service.readSession(sessionId);
    }
    catch (err) {
        logger.warn(`akane memory: 单份转录读取失败（code=${codeOf(err)}）`);
        return { ok: false, code: codeOf(err) === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 'SESSION_NOT_FOUND' : 'QUERY_FAILED' };
    }
    const log = snapshot;
    if (!log || !Array.isArray(log.events))
        return { ok: false, code: 'SHAPE_UNEXPECTED' };
    const events = [];
    for (const event of log.events) {
        if (typeof fromTime === 'number') {
            const time = event.time;
            if (typeof time === 'number' && time < fromTime)
                continue;
        }
        const lite = eventToTranscript(event);
        if (lite)
            events.push(lite);
    }
    events.sort((a, b) => a.seq - b.seq);
    return { ok: true, value: { sessionId, events } };
}
/**
 * 回 T1 取一段窗口（§2 取链的「回 T1 取原文」）：命中事件本身 + 前后各几条。
 *
 * 窗口自己封顶，因为宿主超范围是**抛** `SESSION_QUERY_INVALID_WINDOW` 而不是截断
 * （`_readWindow`，lib/index.js:1236-1241）。返回的是同 `eventToTranscript` 那套形状，
 * 调用方负责洗 —— 窗口里同样可能出现脚手架与图片路径行。
 */
export async function readEventWindow(ctx, sessionId, seq, before, after, logger) {
    const service = queryService(ctx);
    if (!service)
        return { ok: false, code: 'SERVICE_ABSENT' };
    const readEvent = service.readEvent;
    if (typeof readEvent !== 'function') {
        logger.warn('akane memory: 宿主 sessionQuery 缺 readEvent（code=METHOD_MISSING）');
        return { ok: false, code: 'METHOD_MISSING' };
    }
    try {
        const result = (await readEvent({
            sessionId,
            seq,
            before: cappedWindow(before),
            after: cappedWindow(after),
        }));
        const raw = Array.isArray(result?.events) ? result.events : [];
        const events = [];
        for (const event of raw) {
            const lite = eventToTranscript(event);
            if (lite)
                events.push(lite);
        }
        return { ok: true, value: events };
    }
    catch (err) {
        logger.warn(`akane memory: 窗口回读失败（code=${codeOf(err)}）`);
        return { ok: false, code: 'QUERY_FAILED' };
    }
}
/** 宿主单侧上限 50，一期取更小的固定值：她要看的是那轮上下文，不是整份转录 */
const HOST_WINDOW_MAX = 8;
function cappedWindow(value) {
    if (!Number.isFinite(value) || value <= 0)
        return 0;
    return Math.min(Math.floor(value), HOST_WINDOW_MAX);
}
const MEDIA_LINE = /^[ \t]*└[ \t]*Image:[^\n]*$/gm;
/**
 * 群历史**整块**删（含中间那些「名字 (openid): 正文」行）。
 *
 * 只删头尾两行标记是不够的：中间行是别人的话和 openid，一样不能出门。
 */
const HISTORY_BLOCK = /\[Chat history begins\][\s\S]*?\[Chat history ends\][ \t]*\n?/g;
/** 头尾没配对（渲染变了或整块被截）→ 从头部标记起整段剪掉，宁可少回不许漏 */
const HISTORY_TRAILING = /\[Chat history begins\][\s\S]*$/g;
const CURRENT_MARKER = /\[Current message\][ \t]*/g;
const ENVELOPE_TAG = /^[ \t]*(?:<time=[^>\n]*>|<\|[A-Za-z_]+[|>])[ \t]*/gm;
const MENTION_MARKER = /<@!?\d+>/g;
/** 两段以上「/ + 非空白」才算主机路径：单个 /embed 与 2/3 这种不误伤 */
const ABSOLUTE_PATH = /(?:\/[^\s]*){2,}/g;
/** 判存在用的无 `g` 版本：共享带 `g` 的正则会因 lastIndex 漂移漏检 */
const ABSOLUTE_PATH_TEST = /(?:\/[^\s]*){2,}/;
/**
 * 返回体清洗（§5 红线 + §9 测试 3 的执行点）。四步都不许省：
 * 图片路径行整行删（换成 `[图片]` 占位，她要知道那轮有图但不能知道在哪）、
 * 群历史整块删（那里面是别人的话和 openid）、@marker 删（含 appId）、
 * 最后兜底剪绝对路径 —— 前面漏了也不能让 `/home/...` 出门。
 */
export function scrubForReturn(text) {
    let out = text
        .replace(MEDIA_LINE, '[图片]')
        .replace(HISTORY_BLOCK, '')
        .replace(HISTORY_TRAILING, '')
        .replace(CURRENT_MARKER, '')
        .replace(ENVELOPE_TAG, '')
        .replace(MENTION_MARKER, '');
    if (ABSOLUTE_PATH_TEST.test(out))
        out = out.replace(ABSOLUTE_PATH, '[路径已隐藏]');
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
/**
 * 出门前最后一道闸：清洗后仍判定含主机路径 → 调用方整条丢弃。
 *
 * 宁可少回一条命中，也不能把带路径的片段发进 QQ。判存在一律用不带 `g` 的副本 ——
 * 共享带 `g` 的正则会因 lastIndex 漂移漏检。
 */
export function containsHostLeak(text) {
    return new RegExp(MEDIA_LINE.source).test(text)
        || new RegExp(ABSOLUTE_PATH.source).test(text)
        || /└\s*Image:/.test(text);
}
/** 把宿主错误收敛到封闭集合：只认 code 字段，回退 UNKNOWN，绝不取 message 文本 */
function codeOf(err) {
    const code = err?.code;
    return typeof code === 'string' ? code : 'UNKNOWN';
}
//# sourceMappingURL=transcript-source.js.map