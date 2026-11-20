import { persistCredentialsToProfile, removeCredentialsFromProfile, updateProfileConfig, } from "./persist.js";
import { getProfileDir } from "../shared/index.js";
import { AccessControlSchema, MemoryConfigSchema } from "../config.js";
import { BIND_CONFIG_PATH, BIND_MANUAL_PATH, BIND_REFRESH_PATH, BIND_STATE_PATH, BIND_UNBIND_PATH, } from "../shared/bind-protocol.js";
// 协议单一来源：shared/bind-protocol.ts（类型 + 路径常量，客户端共用）
export { BIND_CONFIG_PATH, BIND_MANUAL_PATH, BIND_REFRESH_PATH, BIND_STATE_PATH, BIND_UNBIND_PATH };
/**
 * 静默窗口四栏（键名与设置页那份是手抄的两份，改动时两边都要动 ——
 * 客户端不 import 本模块，免得把 node 侧依赖拖进浏览器包）。
 *
 * 上限压到 120 秒：窗口是**直接加在她每次回话延迟上**的成本，设置页又给了「填了再也不回话」
 * 的旋钮面，服务端替它封顶。真实需要的量级在分钟以下。
 */
const QUIET_WINDOW_KEYS = [
    'quietWindowMs', 'quietWindowEmptyShellMs', 'quietWindowMaxWaitMs', 'quietWindowMaxFragments',
];
const MAX_QUIET_WINDOW_MS = 120000;
const MAX_QUIET_WINDOW_FRAGMENTS = 20;
/** 可经 UI 编辑的配置键（白名单：只收用户必要的字段，其余走 patch/env） */
const EDITABLE_CONFIG_KEYS = new Set([
    'requireMention', 'streaming', 'showToolResults', 'debug',
    'provider', 'model', 'preset',
    'groupPrompt', 'directPrompt',
    'wakeWords', 'wakeWordsWeak', 'wakeWordExcludes',
    ...QUIET_WINDOW_KEYS,
    'access',
    'personaEnabled', 'stickersEnabled', 'memory',
]);
/**
 * 白名单键的子 Schema（服务端校验：客户端校验仅为体验，安全边界在宿主）。
 *
 * 签名 `(value, current) => unknown`：`current` 是当前生效配置（`options.currentConfig()`），
 * 只有 `memory` 用到它（局部合并：UI 只改 `enabled`，其余四键按现值补，不刷回默认）。
 */
const EDITABLE_CONFIG_SCHEMAS = {
    requireMention: (v) => booleanSchema(v, 'requireMention'),
    streaming: (v) => booleanSchema(v, 'streaming'),
    showToolResults: (v) => booleanSchema(v, 'showToolResults'),
    debug: (v) => booleanSchema(v, 'debug'),
    provider: stringSchema('provider'),
    model: stringSchema('model'),
    preset: stringSchema('preset'),
    groupPrompt: stringSchema('groupPrompt'),
    directPrompt: stringSchema('directPrompt'),
    wakeWords: wakeListSchema('强唤醒词'),
    wakeWordsWeak: wakeListSchema('弱唤醒词'),
    wakeWordExcludes: wakeListSchema('唤醒排除片段'),
    quietWindowMs: integerSchema('静默窗口', 0, MAX_QUIET_WINDOW_MS),
    quietWindowEmptyShellMs: integerSchema('空壳长窗口', 0, MAX_QUIET_WINDOW_MS),
    quietWindowMaxWaitMs: integerSchema('等待硬顶', 0, MAX_QUIET_WINDOW_MS),
    quietWindowMaxFragments: integerSchema('每批最多攒几条', 1, MAX_QUIET_WINDOW_FRAGMENTS),
    access: (v) => AccessControlSchema(v),
    personaEnabled: (v) => booleanSchema(v, 'personaEnabled'),
    stickersEnabled: (v) => booleanSchema(v, 'stickersEnabled'),
    memory: (v, current) => memoryPartialSchema(v, current.memory),
};
/**
 * 记忆库局部合并校验：UI 只提交 `{enabled: v}`（或带其余四键的完整块），
 * 按现值补其余四键，别把 YAML 里手写的 `embedBaseUrl` 等刷回默认。
 */
function memoryPartialSchema(value, current) {
    if (typeof value !== 'object' || value === null) {
        throw new TypeError('记忆库配置必须是对象');
    }
    const base = (typeof current === 'object' && current !== null ? current : {});
    const merged = { ...base, ...value };
    return MemoryConfigSchema(merged);
}
/**
 * 整数栏校验（min/max 含端点）。
 *
 * 允许字符串形态的数字：URL 查询串与某些前端状态天然把数字存成文本，这里规范化掉，
 * 落盘的一律是数字，免得 YAML 里出现 `quietWindowMs: "12000"` 让 Schema 那边犯难。
 */
function integerSchema(name, min, max) {
    return (value) => {
        const num = typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim() !== ''
                ? Number(value)
                : Number.NaN;
        if (!Number.isInteger(num) || num < min || num > max) {
            throw new TypeError(`${name}：必须是 ${min} 到 ${max} 之间的整数`);
        }
        return num;
    };
}
/**
 * 窗口栏的跨键校验，单键 Schema 看不见这层。
 *
 * 只拦一条：`quietWindowMs > 0` 而 `quietWindowMaxWaitMs` 为 0 时，`akaneQuietWindow`
 * 挂载就抛（没有硬顶的连发永远不会放行），fiber 起不来等于整个插件下线。其余组合
 * （比如空壳值不大于短窗口）只是效果打折，交给界面文案说明，不替用户做主。
 */
function quietWindowComboError(merged) {
    const asInt = (value) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
    if (asInt(merged.quietWindowMs) > 0 && asInt(merged.quietWindowMaxWaitMs) <= 0) {
        return '静默窗口开着时「等待硬顶」必须大于 0，否则插件挂载会失败';
    }
    return null;
}
function booleanSchema(value, name) {
    if (typeof value !== 'boolean')
        throw new TypeError(`${name} 必须是布尔值`);
    return value;
}
function stringSchema(name) {
    return (value) => {
        if (typeof value !== 'string')
            throw new TypeError(`${name} 必须是字符串`);
        if (value.length > 20000)
            throw new TypeError(`${name} 过长`);
        return value;
    };
}
/** 唤醒词表单项上限：词面会编成 RegExp，不给设置页留任意大的匹配面 */
const MAX_WAKE_WORD_CHARS = 20;
/** 唤醒词表条数上限 */
const MAX_WAKE_WORD_ITEMS = 100;
/**
 * 唤醒词三张表共用的校验：字符串数组 → 逐项 trim、丢空、按原序去重。
 *
 * 返回规范化值而非原值：这里落盘就是词表正本，不依赖客户端先整理过。
 * 按码点计长，「茜茜」这类 CJK 词与拉丁词在界面上是同一份量。
 */
function wakeListSchema(name) {
    return (value) => {
        if (!Array.isArray(value))
            throw new TypeError(`${name}：必须是数组，一行一个词`);
        if (value.length > MAX_WAKE_WORD_ITEMS) {
            throw new TypeError(`${name}：最多 ${MAX_WAKE_WORD_ITEMS} 个，当前 ${value.length} 个`);
        }
        const words = new Set();
        for (const item of value) {
            if (typeof item !== 'string')
                throw new TypeError(`${name}：每一行都必须是文本`);
            const word = item.trim();
            if (word === '')
                continue;
            if ([...word].length > MAX_WAKE_WORD_CHARS) {
                throw new TypeError(`${name}：「${word.slice(0, 10)}…」超过 ${MAX_WAKE_WORD_CHARS} 个字`);
            }
            words.add(word);
        }
        return [...words];
    };
}
/** manual 请求体大小上限（appId + appSecret 远小于此值） */
const MAX_MANUAL_BODY_BYTES = 4096;
/**
 * config 请求体大小上限：对齐 Schema 的业务边界——白名单字符串字段单个
 * 允许 20000 字符（全中文 UTF-8 约 60KB），allowlist 不设条目上限（openid
 * 短标识，512KB 约容纳 1.4 万条）。上限只是反滥用闸门，语义校验在 Schema。
 */
const MAX_CONFIG_BODY_BYTES = 512 * 1024;
/**
 * 注册绑定路由（状态查询 / 刷新二维码 / 手动凭据）。
 *
 * @param webServer - ctx.webServer
 * @param service - 绑定状态机；已绑定 fiber 传 null（无扫码流程）
 * @param logger - 日志
 * @param options - 行为注入（bound 态回显、manual 处理）
 * @returns 注销函数（与插件 fiber 生命周期绑定）
 */
export function registerBindRoutes(webServer, service, logger, options = {}) {
    const defaultManual = (credentials) => {
        const persisted = persistCredentialsToProfile(credentials, getProfileDir() ?? undefined, logger);
        return persisted ? { persisted: true } : { persisted: false, error: '无法定位 profile 目录或写入失败，请改用环境变量配置' };
    };
    const handleManualSubmit = options.onManualCredentials ?? defaultManual;
    const disposers = [
        webServer.register({
            kind: 'exact',
            path: BIND_STATE_PATH,
            handler: (req, res) => { handleState(req, res, service, options); },
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_REFRESH_PATH,
            handler: (req, res) => { handleRefresh(req, res, service); },
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_MANUAL_PATH,
            handler: (req, res) => handleManual(req, res, handleManualSubmit),
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_UNBIND_PATH,
            handler: (req, res) => handleUnbind(req, res, options),
        }),
        webServer.register({
            kind: 'exact',
            path: BIND_CONFIG_PATH,
            handler: (req, res) => handleConfig(req, res, options),
        }),
    ];
    logger.info(`im-qqbot-akane: 端内绑定页已就绪: ${BIND_STATE_PATH}`);
    return () => { for (const dispose of disposers)
        dispose(); };
}
/**
 * 请求来源校验（最小 CSRF 防护）。
 *
 * 带 Origin 的请求必须与 Host 同源；同源 fetch 与 Desktop IPC 桥
 * （后者会删除 origin 头）均放行。本路由数据不敏感且动作无害，
 * 该级别的防护足够。
 */
function trusted(req) {
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === req.headers.host;
    }
    catch {
        return false;
    }
}
function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(payload);
}
function handleState(req, res, service, options) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    // 已绑定优先（appSecret 不回传，appId 非机密可回显）
    const boundAppId = options.boundAppId?.() ?? null;
    if (boundAppId !== null) {
        sendJson(res, 200, { phase: 'bound', appId: boundAppId });
        return;
    }
    sendJson(res, 200, service === null ? { phase: 'starting' } : service.wireState());
}
function handleRefresh(req, res, service) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    // 丢弃可能的请求体（refresh 无参数）
    req.resume();
    service?.refresh();
    // 新二维码异步生成，统一由状态轮询收敛
    sendJson(res, 200, { phase: 'starting' });
}
/** 读取并解析 JSON 请求体（带大小上限） */
async function readJsonBody(req, maxBytes = MAX_MANUAL_BODY_BYTES) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = chunk;
        size += buffer.length;
        if (size > maxBytes)
            throw new Error('request body too large');
        chunks.push(buffer);
    }
    if (size === 0)
        throw new Error('empty request body');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** 校验手动提交的凭据形态（不打印内容） */
function parseCredentials(body) {
    if (typeof body !== 'object' || body === null)
        return null;
    const record = body;
    const appId = typeof record.appId === 'string' ? record.appId.trim() : '';
    const appSecret = typeof record.appSecret === 'string' ? record.appSecret.trim() : '';
    if (appId.length === 0 || appSecret.length === 0)
        return null;
    if (appId.length > 128 || appSecret.length > 256)
        return null;
    return { appId, appSecret };
}
async function handleManual(req, res, submit) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    let body;
    try {
        body = await readJsonBody(req);
    }
    catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
        return;
    }
    const credentials = parseCredentials(body);
    if (credentials === null) {
        sendJson(res, 400, { ok: false, error: 'appId 与 appSecret 不能为空' });
        return;
    }
    const result = submit(credentials);
    if (!result.persisted) {
        sendJson(res, 500, { ok: false, error: result.error ?? '保存失败' });
        return;
    }
    // 写入 profile patch 触发 HMR 重载，新 fiber 以新凭据启动网关
    sendJson(res, 200, { ok: true, message: '凭据已保存，插件将自动重载' });
}
/** 解绑：仅已绑定态可执行；移除 profile patch 中的凭据并触发 HMR 重载 */
function handleUnbind(req, res, options) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    req.resume();
    if ((options.boundAppId?.() ?? null) === null) {
        sendJson(res, 409, { ok: false, error: '当前未绑定' });
        return;
    }
    const result = options.onUnbind === undefined
        ? (() => {
            const removed = removeCredentialsFromProfile(getProfileDir() ?? undefined, undefined);
            if (removed) {
                // 清除进程内凭据：扫码绑定成功时会写入 env（供热更新后的下次
                // apply 兜底读取）；不清则 HMR 重载后新 fiber 仍从 env 读到
                // 凭据，解绑不生效（状态一直停留在 bound）
                delete process.env.QQBOT_APPID;
                delete process.env.QQBOT_SECRET;
            }
            return removed
                ? { persisted: true }
                : { persisted: false, error: '无法定位 profile 目录或写入失败，请手动编辑 cordis.patch.yml' };
        })()
        : options.onUnbind();
    if (!result.persisted) {
        sendJson(res, 500, { ok: false, error: result.error ?? '解绑失败' });
        return;
    }
    // 移除后写入触发 HMR 重载，插件回到未绑定态（绑定流程重新可用）
    sendJson(res, 200, { ok: true, message: '已解绑，插件将重载并重新进入绑定流程' });
}
/**
 * 配置读写：
 * - GET：回显当前生效配置（appSecret 剔除，cwd 等只读字段正常返回）
 * - POST：白名单 + 子 Schema 校验 → 最小写入 profile patch → HMR 重载
 */
async function handleConfig(req, res, options) {
    if (!trusted(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    if (req.method === 'GET') {
        const current = options.currentConfig?.() ?? {};
        // appSecret 永不回传；其余（含只读 cwd）原样回显
        const { appSecret: _s, ...safe } = current;
        sendJson(res, 200, { config: safe });
        return;
    }
    let body;
    try {
        body = await readJsonBody(req, MAX_CONFIG_BODY_BYTES);
    }
    catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
        return;
    }
    if (typeof body !== 'object' || body === null) {
        sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
        return;
    }
    const submitted = body;
    // 白名单与凭据/只读字段拦截
    for (const key of Object.keys(submitted)) {
        if (!EDITABLE_CONFIG_KEYS.has(key)) {
            const reason = key === 'appId' || key === 'appSecret'
                ? '凭据请使用绑定/更换/解绑功能'
                : key === 'cwd'
                    ? 'cwd 为只读字段'
                    : '不支持的字段';
            sendJson(res, 400, { ok: false, error: `${reason}: ${key}` });
            return;
        }
    }
    // 逐键 Schema 校验（非法值拒绝，返回首个错误）
    let validated = {};
    try {
        const current = options.currentConfig?.() ?? {};
        validated = Object.fromEntries(Object.entries(submitted).map(([key, value]) => {
            const check = EDITABLE_CONFIG_SCHEMAS[key];
            if (check === undefined)
                throw new TypeError(`不支持的字段: ${key}`);
            return [key, check(value, current)];
        }));
    }
    catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof TypeError ? err.message : String(err) });
        return;
    }
    // 窗口栏的跨键校验：合并「当前生效值 + 本次提交」再判，半改也会撞上挂载即抛的组合
    if (QUIET_WINDOW_KEYS.some((key) => key in validated)) {
        const comboError = quietWindowComboError({ ...(options.currentConfig?.() ?? {}), ...validated });
        if (comboError !== null) {
            sendJson(res, 400, { ok: false, error: comboError });
            return;
        }
    }
    const persisted = options.onUpdateConfig === undefined
        ? updateProfileConfig(validated, getProfileDir() ?? undefined, undefined)
        : options.onUpdateConfig(validated);
    if (!persisted) {
        sendJson(res, 500, { ok: false, error: '无法定位 profile 目录或写入失败' });
        return;
    }
    sendJson(res, 200, { ok: true, message: '配置已保存，插件将自动重载（进行中的机器人会话将重置）' });
}
//# sourceMappingURL=bind-routes.js.map