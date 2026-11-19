/** sessionKey 里认不出 scope/peerId 时写进 chunk 的哨兵 */
export const UNKNOWN_PEER = 'unknown';
/**
 * sessionKey 形状 `qqbot:${appId}:${kind}:${peerId}`（session-manager.ts:4）。
 * 解析失败返回 undefined —— 调用方负责落 UNKNOWN_PEER，不许猜。
 */
export function parseSessionKey(key) {
    if (!key)
        return undefined;
    const parts = key.split(':');
    if (parts.length !== 4 || parts[0] !== 'qqbot')
        return undefined;
    const [, , kind, peerId] = parts;
    if ((kind !== 'c2c' && kind !== 'group') || peerId === '')
        return undefined;
    return { scope: kind, peerId };
}
/** chunk 里存的形态：scope 与 peerId 合成一个键，过滤只做一次相等比较 */
export function peerKeyOf(ref) {
    return `${ref.scope}:${ref.peerId}`;
}
/**
 * 活跃会话的归属键 —— 直接吃 `SessionRecord.scope/peerId`，不走 sessionKey 反解。
 *
 * 现会话必有 replyTarget 语义，所以这里拿到的键与写入时 chunk 里那个同源；
 * `peerId` 缺失（形状变了）时回 UNKNOWN，让 `samePeer` 把它 fail-closed 掉。
 */
export function peerKeyOfSessionRecord(record) {
    if (!record?.scope || !record.peerId)
        return UNKNOWN_PEER;
    return peerKeyOf({ scope: record.scope, peerId: record.peerId });
}
/** 归属未知时的 chunk 键（与任何真实 peer 都不相等） */
export const UNKNOWN_PEER_KEY = UNKNOWN_PEER;
/**
 * 相等判定：UNKNOWN 侧永远是 false，包括两侧都 unknown。
 * 少这一条，两份解析不出的转录之间就会互相召回 —— 那正是本模块要防的事。
 */
export function samePeer(chunkPeer, currentPeer) {
    if (currentPeer === undefined || currentPeer === UNKNOWN_PEER)
        return false;
    return chunkPeer === currentPeer;
}
//# sourceMappingURL=peer.js.map