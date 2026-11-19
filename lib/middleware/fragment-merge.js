/** ctx.state 键名 —— 带 akane 前缀，避免与上游/宿主同名字段相撞 */
export const AKANE_MERGED_FRAGMENTS = 'akaneMergedFragments';
/**
 * 把同目标缓冲的分片合并为一条。返回值必须是入参之一（SDK 契约）。
 */
export function mergeFragments(buffered) {
    const survivor = buffered[buffered.length - 1];
    if (buffered.length === 1)
        return survivor;
    survivor.state[AKANE_MERGED_FRAGMENTS] =
        buffered.map(toFragmentView);
    const attachments = buffered.flatMap((ctx) => (ctx.message.attachments ?? []));
    if (attachments.length > 0) {
        survivor.message.attachments = attachments;
    }
    return survivor;
}
function toFragmentView(ctx) {
    const msg = ctx.message;
    return {
        senderId: msg.senderId,
        ...(msg.senderName !== undefined ? { senderName: msg.senderName } : {}),
        content: (msg.content ?? '').trim(),
    };
}
/** 缓冲溢出（达到 maxQueue）时的处置：只留痕，不替她编一句解释 */
export function onMergeBufferFull(logger) {
    return (ctx) => {
        const msg = ctx.message;
        logger.warn(`merge buffer full, fragment dropped: ${msg.kind ?? 'unknown'} msgId=${msg.messageId ?? '?'}`);
    };
}
//# sourceMappingURL=fragment-merge.js.map