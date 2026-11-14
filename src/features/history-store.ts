/**
 * 群历史存储（插件自建）
 *
 * 为什么要自建：SDK 的 HistoryEntry 只有文本位，群里一张图片进历史，
 * 落到她眼里就只剩发送者标签后面一个空行 —— 图既没记录也没下载。
 *
 * 缓冲语义照抄 SDK（每群环形缓冲 + messageId 去重 + oldest→newest 且不含当前消息），
 * 只把附件元数据带上。落盘路径不存在条目里：渲染时向 media-ledger 要，
 * 这样 TTL 清理掉的文件不会被当成有效路径递出去。
 */
/**
 * 历史条目里的一个附件（只有元数据；localPath 一律现问账本）。
 * contentType 存 QQ 下发的原始 MIME，类型判定交给 classifyContentType，避免存两份真相。
 */
export interface HistoryAttachment {
  contentType: string;
  filename: string;
  size?: number;
  url?: string;
}

/** 一条群历史 */
export interface HistoryEntry {
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  messageId: string;
  attachments?: HistoryAttachment[];
}

export class GroupHistoryStore {
  private readonly buffers = new Map<string, HistoryEntry[]>();

  /** 追加一条，按 messageId 去重，超出 limit 从头淘汰 */
  append(groupKey: string, entry: HistoryEntry, limit: number): void {
    let buf = this.buffers.get(groupKey);
    if (!buf) {
      buf = [];
      this.buffers.set(groupKey, buf);
    }
    if (buf.some(e => e.messageId === entry.messageId)) return;
    buf.push(entry);
    if (buf.length > limit) buf.splice(0, buf.length - limit);
  }

  /** 取最近 limit 条（oldest → newest） */
  list(groupKey: string, limit: number): HistoryEntry[] {
    const buf = this.buffers.get(groupKey);
    if (!buf) return [];
    return buf.slice(-limit);
  }

  clear(groupKey: string): void {
    this.buffers.delete(groupKey);
  }

  /** 诊断：有多少个群有缓冲 */
  size(): number {
    return this.buffers.size;
  }
}

let _store: GroupHistoryStore | null = null;

/** 获取共享历史存储（单例），供中间件写入、inbound 回复后清空 */
export function getHistoryStore(): GroupHistoryStore {
  if (!_store) _store = new GroupHistoryStore();
  return _store;
}

/** 用 appId 前缀隔离群历史（单账号下等价于 groupOpenid，保留多账号扩展） */
export function historyGroupKey(appId: string, groupId: string): string {
  return `${appId}:${groupId}`;
}

/** 清空群历史（回复后调用，避免下次 @ 时重复组包） */
export function clearGroupHistory(appId: string, groupId: string): void {
  _store?.clear(historyGroupKey(appId, groupId));
}
