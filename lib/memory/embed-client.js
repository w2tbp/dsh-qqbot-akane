/**
 * 本机 embedding 服务的客户端（§5 隐私边界的执行点之一）
 *
 * 三条硬规矩：
 * 1. **只准打回环地址**。送进 `/embed` 的就是 chunk 正文，非回环端点等于把聊天内容
 *    发给外面 —— 所以这里直接拒绝，不做「配置写了就照办」的顺从。
 * 2. **服务不可达绝不降级到远程 embedding API**。降级路径不存在，比存在但关掉安全。
 * 3. **异常不许逃出本模块**。抛出去就会变成 QQ 里的 `❌ 工具 … 执行失败`（§5 失败语义），
 *    所以一切失败都收敛成 `{ok:false, code}`，正文与原因只打 code。
 *
 * 本模块不起进程、不做守护、不自愈：常驻服务的启停归用户。
 */
/** 与 embed-service/server.mjs 对齐的默认端点（只绑 127.0.0.1） */
export const DEFAULT_EMBED_BASE = 'http://127.0.0.1:8765';
/**
 * 回环判定：127.0.0.0/8、`::1`、`localhost` 放行，其余主机一律拒绝。
 * 只看 URL 里写出来的主机名，不做 DNS 解析 —— 检查本身不该变成一次外联。
 */
export function isLoopbackHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === '::1' || host === 'localhost')
        return true;
    const parts = host.split('.');
    return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p));
}
function endpoints(config) {
    let url;
    try {
        url = new URL(config.baseUrl);
    }
    catch {
        return { ok: false, code: 'ENDPOINT_INVALID' };
    }
    if (url.protocol !== 'http:')
        return { ok: false, code: 'ENDPOINT_NOT_LOOPBACK' };
    if (!isLoopbackHost(url.hostname))
        return { ok: false, code: 'ENDPOINT_NOT_LOOPBACK' };
    return { ok: true, base: url };
}
/** 拼路径：base 可以带前缀（如 http://127.0.0.1:8765/x），子路径跟着走 */
function joinUrl(base, suffix) {
    const path = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    return `${base.origin}${path}${suffix}`;
}
/**
 * 读回 JSON。解析失败算 BAD_RESPONSE 而不是 UNREACHABLE ——
 * 「连不上」和「连着但答得怪」是两种运维处置，混了就只能靠猜。
 */
async function readJson(res) {
    try {
        const body = (await res.json());
        return body && typeof body === 'object' ? { ok: true, body: body } : { ok: false };
    }
    catch {
        return { ok: false };
    }
}
/** 启动探测用：服务在不在、维度对不对。日志与 capabilities 只据这里的结果写 */
export async function probeEmbedHealth(config) {
    const target = endpoints(config);
    if (!target.ok)
        return target;
    try {
        const res = await fetch(joinUrl(target.base, 'health'), { signal: AbortSignal.timeout(config.timeoutMs) });
        if (!res.ok)
            return { ok: false, code: 'UNREACHABLE' };
        const parsed = await readJson(res);
        if (!parsed.ok)
            return { ok: false, code: 'BAD_RESPONSE' };
        const { dims, model } = parsed.body;
        if (typeof dims !== 'number' || typeof model !== 'string')
            return { ok: false, code: 'BAD_RESPONSE' };
        if (dims !== config.dims)
            return { ok: false, code: 'DIM_MISMATCH' };
        return { ok: true, dims, model };
    }
    catch (err) {
        return { ok: false, code: nameOf(err) === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE' };
    }
}
/**
 * 批量嵌入。返回向量与入参同序 —— 索引侧靠这个顺序写 `vectors.f32.bin`。
 *
 * 单批失败即整批失败（回填会整批重试），不做「部分成功」：半份向量落进定长文件
 * 比整批不落更难查。
 */
export async function embedTexts(texts, config) {
    if (texts.length === 0)
        return { ok: false, code: 'EMPTY_BATCH' };
    const target = endpoints(config);
    if (!target.ok)
        return target;
    try {
        const res = await fetch(joinUrl(target.base, 'embed'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ texts: [...texts] }),
            signal: AbortSignal.timeout(config.timeoutMs),
        });
        if (!res.ok)
            return { ok: false, code: 'UNREACHABLE' };
        const parsed = await readJson(res);
        if (!parsed.ok)
            return { ok: false, code: 'BAD_RESPONSE' };
        const body = parsed.body;
        if (!Array.isArray(body.vectors) || body.vectors.length !== texts.length)
            return { ok: false, code: 'BAD_RESPONSE' };
        for (const vector of body.vectors) {
            if (!Array.isArray(vector) || vector.length !== config.dims)
                return { ok: false, code: 'DIM_MISMATCH' };
        }
        return {
            ok: true,
            vectors: body.vectors,
            dims: config.dims,
            model: typeof body.model === 'string' ? body.model : '',
        };
    }
    catch (err) {
        return { ok: false, code: nameOf(err) === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE' };
    }
}
function nameOf(err) {
    return err?.name === 'TimeoutError' ? 'TimeoutError' : '';
}
//# sourceMappingURL=embed-client.js.map