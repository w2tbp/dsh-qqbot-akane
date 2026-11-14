/**
 * 媒体落盘账本 — 「这张图已经在本地了吗」的唯一答案
 *
 * 一张群图片会走两条链路：被 @ 的那一轮按「当前消息」下载，之后的每一轮按「群历史」出现。
 * 没有这本账，同样的字节会被拉两次、存成两个文件，她还会在上下文里看到同一张图的两个路径。
 *
 * 只存进程内状态：文件被 TTL 清理掉之后 resolve() 会查存在性并把它从账本里踢出去，
 * 不会把死路径递给她（那条路径会变成工具报错，直接发到 QQ 上）。
 */
import { existsSync } from 'node:fs';

/** 去重键的取材：优先 QQ 下发的文件名（本身就是内容 MD5），退化到去掉查询串的 URL */
export interface MediaKeyParts {
  filename?: string;
  size?: number;
  url?: string;
}

/** 去重缓存条目上限（FIFO 淘汰），防长跑进程内存无上限增长 */
const DEDUP_MAX_ENTRIES = 512;
/** 每个群每日主动落盘的图片数上限（历史链路专用） */
const HISTORY_IMAGES_PER_GROUP_DAY = 20;

/**
 * 同一张图的稳定标识。
 *
 * QQ 群/单聊推下来的图片文件名本身就是内容的 MD5（形如 32 位十六进制），这种名字
 * 单独就足以判等内容，**不带 size**：引用消息那条链路从 SDK 的 parseAttachments 拿不到
 * size（只能拿到 contentType/url/filename/size 里的三个），键里掺了 size 就永远对不上，
 * 同一张梗图会被下载两次。
 *
 * 名字不像 MD5 时（例如某些端给的 `微信图片.jpg`）不敢假定内容与名字绑定，退回到
 * 名字+size+去 query 的 URL 路径 —— 此时引用链路可能少并一次，是漏优化不是错优化。
 */
export function mediaDedupKey(att: MediaKeyParts): string {
  const name = att.filename ?? '';
  // QQ 下发的是「<内容MD5>.<扩展名>」，扩展名不可信但 MD5 主体可信，判主体就够
  if (/^[0-9a-f]{32}(\.[0-9a-z]+)?$/i.test(name)) return `h:${name.toLowerCase().split('.')[0]}`;
  const size = att.size ?? 0;
  if (name) return `n:${name}|${size}`;
  if (att.url) return `u:${att.url.split('?')[0]}|${size}`;
  return '';
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

export class MediaLedger {
  private readonly paths = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  private readonly quota = new Map<string, { day: string; used: number }>();

  constructor(private readonly maxEntries: number = DEDUP_MAX_ENTRIES) {}

  /**
   * 已落盘且文件仍在 → 绝对路径；否则 undefined。
   * 命中时顺手把失效条目清掉，避免每次渲染都撞一次 existsSync。
   */
  resolve(att: MediaKeyParts): string | undefined {
    const key = mediaDedupKey(att);
    if (!key) return undefined;
    const path = this.paths.get(key);
    if (!path) return undefined;
    if (!existsSync(path)) {
      this.paths.delete(key);
      return undefined;
    }
    return path;
  }

  /**
   * 单飞下载：同一个键只允许一个下载在飞，后来者等同一个 Promise。
   * work 返回 undefined（下载失败）时不记入路径账本，也不缓存失败结果——
   * 失败通常是网络抖动，下一条消息再来一次比记住失败更有用。
   */
  async fetch(att: MediaKeyParts, work: () => Promise<string | undefined>): Promise<string | undefined> {
    const key = mediaDedupKey(att);
    if (!key) return work();

    const cached = this.resolve(att);
    if (cached) return cached;

    const running = this.inflight.get(key);
    if (running) return running;

    const task = work()
      .then(path => {
        if (path) this.remember(key, path);
        return path;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, task);
    return task;
  }

  /** 手工登记（不经 fetch 的路径，例如测试里造好的文件） */
  remember(key: string, localPath: string): void {
    if (!key) return;
    this.paths.set(key, localPath);
    if (this.paths.size > this.maxEntries) {
      const oldest = this.paths.keys().next().value;
      if (oldest !== undefined) this.paths.delete(oldest);
    }
  }

  /**
   * 取一格群维度当日配额。
   * 跨天即重置计数；上限是给「主动落盘」设的，被 @ 的消息本来就会下载，不该吃这份配额。
   */
  tryConsumeQuota(groupKey: string, cap: number = HISTORY_IMAGES_PER_GROUP_DAY): boolean {
    if (cap <= 0) return false;
    const day = today();
    const slot = this.quota.get(groupKey);
    if (!slot || slot.day !== day) {
      this.quota.set(groupKey, { day, used: 1 });
      return true;
    }
    if (slot.used >= cap) return false;
    slot.used += 1;
    return true;
  }

  /** 当日已用配额（测试与 debug 用） */
  quotaUsed(groupKey: string): number {
    const slot = this.quota.get(groupKey);
    return slot && slot.day === today() ? slot.used : 0;
  }
}

let _ledger: MediaLedger | null = null;

/** 共享账本单例：历史链路和当前消息链路必须看同一本账 */
export function getMediaLedger(): MediaLedger {
  if (!_ledger) _ledger = new MediaLedger();
  return _ledger;
}
