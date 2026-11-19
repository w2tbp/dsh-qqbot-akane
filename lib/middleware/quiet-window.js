import { mergeFragments } from "./fragment-merge.js";
import { sanitizeHistoryContent } from "./history-buffer.js";
const buckets = new Map();
/**
 * ctx.state 键：这批分片是**被点名那一片开起来的桶**折出来的，门控据此放行整批。
 *
 * 为什么必须有：门控（第 5 步）判「有没有被点名」只看三条 —— rawEventType、
 * mentions[].is_you、正文里的 `<@!appId>`（SDK mention-gate.js:78-81）。而幸存者
 * 是最后一片（续句，通常不带 @），早期那片的 @marker 又必须在这里洗掉（它的链
 * 到这儿就断了，等不到第 6 步）。两条一叠加，整批在门控眼里成了没人喊的闲聊，
 * **一条都不回** —— 11-19 现网就是这么哑掉的。标记走 state，不往正文里塞假 @marker。
 */
export const AKANE_WINDOW_ADDRESSED = 'akaneWindowAddressed';
export function akaneQuietWindow(deps) {
    const { quietMs, maxWaitMs } = deps;
    if (quietMs <= 0) {
        // 关闭态：不起定时器、不建桶、不产生任何日志 —— 链序与改动前逐字节一致
        return async (_ctx, next) => {
            await next();
        };
    }
    if (maxWaitMs <= 0) {
        throw new Error('quietWindowMaxWaitMs must be > 0 when quietWindowMs is enabled: ' +
            'without a hard cap an endless stream of fragments would never be released');
    }
    return async (ctx, next) => {
        const key = bucketKey(ctx);
        const existing = buckets.get(key);
        if (deps.isPassthrough(ctx)) {
            // 直穿件同时强制放行已开的桶：不许有消息看不见地攒着
            if (existing)
                flush(key);
            await next();
            return;
        }
        // 桶没开着、这条又没资格喊她 —— 原样交给门控（零延迟、零行为变化）
        if (!existing && !deps.canOpen(ctx)) {
            await next();
            return;
        }
        const isSurvivor = await new Promise((resolve) => {
            const bucket = existing ?? openBucket(key, deps);
            bucket.held.push({ ctx, resolve });
            if (bucket.held.length >= bucket.maxFragments) {
                if (bucket.quietTimer)
                    clearTimeout(bucket.quietTimer);
                flush(key);
                return;
            }
            armQuietTimer(bucket);
        });
        if (!isSurvivor)
            return;
        await next();
    };
}
// ── 内部 ─────────────────────────────────────────────
function openBucket(key, deps) {
    const bucket = {
        key,
        held: [],
        quietMs: deps.quietMs,
        emptyShellMs: deps.emptyShellMs,
        maxWaitMs: deps.maxWaitMs,
        maxFragments: deps.maxFragments,
        logger: deps.logger,
    };
    buckets.set(key, bucket);
    bucket.capTimer = setTimeout(() => flush(key), deps.maxWaitMs);
    return bucket;
}
/** 每来一片就用整批内容重置静默计时；整批没字也没图时空壳长窗口 */
function armQuietTimer(bucket) {
    if (bucket.quietTimer)
        clearTimeout(bucket.quietTimer);
    const windowMs = hasAnswerableContent(bucket) ? bucket.quietMs : bucket.emptyShellMs || bucket.quietMs;
    bucket.quietTimer = setTimeout(() => flush(bucket.key), windowMs);
}
/**
 * 整批到底有没有可答内容 —— 判"空壳"必须用洗过 @marker 的文字：
 * 群里单独一条 `<@!appid>`（后面才是正事）清洗后就是空的，那才是长窗口该救的形状。
 * 已知不足：只喊称呼不带 @（"akane" 单独一条）仍算有内容，走短窗口。
 * 认出"整句只是在叫她"要吃唤醒扫描那套边界判定，本期不扩。
 */
function hasAnswerableContent(bucket) {
    return bucket.held.some(({ ctx }) => {
        const msg = ctx.message;
        if (cleanFragmentText(msg.content ?? '') !== '')
            return true;
        return (msg.attachments?.length ?? 0) > 0;
    });
}
/**
 * 到点（或被强制闭合）放行整批。
 * 非幸存者的链在此自然终止 —— 与 SDK merge 的契约同一形状。
 */
function flush(key) {
    const bucket = buckets.get(key);
    if (!bucket)
        return;
    buckets.delete(key);
    if (bucket.quietTimer)
        clearTimeout(bucket.quietTimer);
    if (bucket.capTimer)
        clearTimeout(bucket.capTimer);
    const { held } = bucket;
    if (held.length === 0)
        return;
    if (held.length > 1) {
        // 早期分片自己洗：它们的 ctx 不会再经过第 6 步
        for (const { ctx } of held.slice(0, -1)) {
            const msg = ctx.message;
            msg.content = cleanFragmentText(msg.content ?? '');
        }
        const survivor = mergeFragments(held.map(({ ctx }) => ctx));
        // 整批是被点名的那片开起来的 → 告诉门控这批该答
        survivor.state[AKANE_WINDOW_ADDRESSED] = true;
        // 早期分片在第 4 步已经各自进过历史了，合并后别再于同一轮里出现第二遍
        const absorbed = new Set(held.slice(0, -1)
            .map(({ ctx }) => ctx.message.messageId)
            .filter((id) => typeof id === 'string' && id !== ''));
        const history = survivor.state.history;
        if (absorbed.size > 0 && Array.isArray(history)) {
            survivor.state.history =
                history.filter((e) => !absorbed.has(e.messageId ?? ''));
        }
        bucket.logger.info(`quiet window flushed: key=${key} fragments=${held.length}`);
    }
    const last = held.length - 1;
    held.forEach((h, i) => h.resolve(i === last));
}
/** 桶键：同群同人同桶（D1）。私聊时 scope=c2c、targetId 就是这个人，天然同键 */
function bucketKey(ctx) {
    const target = ctx.replyTarget;
    const senderId = ctx.message.senderId ?? '';
    return `${target.scope}:${target.targetId}:${senderId}`;
}
/** @marker 与表情标签 —— 与 wake.ts 扫描用的掩码不同，这里是真删（要给她的正文） */
function cleanFragmentText(content) {
    return sanitizeHistoryContent(content.replace(/<@!?\d+>/g, ''));
}
//# sourceMappingURL=quiet-window.js.map