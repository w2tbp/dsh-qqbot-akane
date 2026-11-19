/**
 * chunk 的归属坐标 —— 隐私边界的唯一正本
 *
 * 召回的过滤规则只有一条：`chunk.peer === 当前会话的 peer`（MEMORY.md §5）。
 * 归属在**写入时**落地，不靠任何事后反查 —— 转录 header 里没有 peer 字段，
 * 而她那 4 份转录与另外 11 份别人的转录躺在同一个 sessions 根目录下，
 * 其中还有用户本人的开发对话。**按 cwd 放宽 = 把开发对话捞进她的上下文**，
 * 所以本模块没有「按目录兜底」的函数，也不许将来加。
 *
 * 解析不出归属的转录落 `UNKNOWN_PEER`：它永远不等于任何真实 peer，
 * 因此**只进索引、永不可召回**（fail-closed）。这与 B4 的结论一致
 * （孤儿转录无法从 model-prefs 反查），是已知缺口而非 bug。
 */
import type { ChatScope } from '../types.ts';

/** sessionKey 里认不出 scope/peerId 时写进 chunk 的哨兵 */
export const UNKNOWN_PEER = 'unknown';

/** 归属：私聊认发送人、群聊认群 openid（与 sessionKey 同一口径） */
export interface PeerRef {
  scope: ChatScope;
  peerId: string;
}

/**
 * sessionKey 形状 `qqbot:${appId}:${kind}:${peerId}`（session-manager.ts:4）。
 * 解析失败返回 undefined —— 调用方负责落 UNKNOWN_PEER，不许猜。
 */
export function parseSessionKey(key: string | undefined): PeerRef | undefined {
  if (!key) return undefined;
  const parts = key.split(':');
  if (parts.length !== 4 || parts[0] !== 'qqbot') return undefined;
  const [, , kind, peerId] = parts as [string, string, string, string];
  if ((kind !== 'c2c' && kind !== 'group') || peerId === '') return undefined;
  return { scope: kind, peerId };
}

/** chunk 里存的形态：scope 与 peerId 合成一个键，过滤只做一次相等比较 */
export function peerKeyOf(ref: PeerRef): string {
  return `${ref.scope}:${ref.peerId}`;
}

/**
 * 活跃会话的归属键 —— 直接吃 `SessionRecord.scope/peerId`，不走 sessionKey 反解。
 *
 * 现会话必有 replyTarget 语义，所以这里拿到的键与写入时 chunk 里那个同源；
 * `peerId` 缺失（形状变了）时回 UNKNOWN，让 `samePeer` 把它 fail-closed 掉。
 */
export function peerKeyOfSessionRecord(record: {
  scope?: ChatScope;
  peerId?: string;
}): string {
  if (!record?.scope || !record.peerId) return UNKNOWN_PEER;
  return peerKeyOf({ scope: record.scope, peerId: record.peerId });
}

/** 归属未知时的 chunk 键（与任何真实 peer 都不相等） */
export const UNKNOWN_PEER_KEY = UNKNOWN_PEER;

/**
 * 相等判定：UNKNOWN 侧永远是 false，包括两侧都 unknown。
 * 少这一条，两份解析不出的转录之间就会互相召回 —— 那正是本模块要防的事。
 */
export function samePeer(chunkPeer: string, currentPeer: string | undefined): boolean {
  if (currentPeer === undefined || currentPeer === UNKNOWN_PEER) return false;
  return chunkPeer === currentPeer;
}
