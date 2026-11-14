/**
 * 群历史缓冲中间件（插件自建，替代 SDK 的 historyBuffer）
 *
 * SDK 那份把附件信息整个丢掉，群里发的图片进历史后只剩一个空行；这里把附件元数据
 * 留在条目里，并在**记录的那一刻**发起落盘 —— 那一刻图片 URL 是刚下发的，
 * 任何时效都能撑住，所以不用去赌「等她需要时链接还在不在」。
 *
 * 挂在 mentionGate 之前：未 @ 她的消息同样要进历史（这正是历史缓冲的意义）。
 * 访问控制在第 3 层就 stop 且不再往下走，被屏蔽的人根本进不了历史。
 */
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { MediaConfig } from '../config.ts';
import type { Logger, RawAttachment } from '../types.ts';
import { classifyContentType, downloadMediaAttachments, type MediaKind } from '../transport/attachment.ts';
import type { GroupHistoryStore, HistoryAttachment, HistoryEntry } from '../features/history-store.ts';
import type { MediaLedger } from '../features/media-ledger.ts';

export interface HistoryBufferOptions {
  /** 每群保留多少条 */
  limit: number;
  store: GroupHistoryStore;
  media: MediaConfig;
  logger: Logger;
  ledger: MediaLedger;
  /** 群键推导：返回 undefined 表示这条消息不进历史（非群消息） */
  groupKey: (ctx: MiddlewareContext) => string | undefined;
}

/** 会进历史的附件类型（语音有 ASR 文本，本来就走 content，不需要落盘） */
const RECORDABLE_KINDS: ReadonlySet<MediaKind> = new Set(['image', 'video', 'file']);

/** 只有图片会主动落盘：视频/文件只记「有过这么个东西」 */
const HARVESTABLE_KINDS: ReadonlySet<MediaKind> = new Set(['image']);

function toRawAttachment(att: HistoryAttachment): RawAttachment {
  return {
    content_type: att.contentType,
    filename: att.filename,
    size: att.size ?? 0,
    url: att.url ?? '',
  };
}

/**
 * 历史条目里的正文是**未经 contentSanitizer 清洗**的副本（中间件顺序决定的，
 * 为了不动已验收的唤醒链路，这里不把它下移），所以要自己洗掉表情标签噪声。
 *
 * 新格式 `<faceType=..,faceId="..",ext="base64">` 的文本就在 ext 里，解出来保留；
 * 老格式 `[<face,id=N/>]` 需要一张 face-id→emoji 表才能翻译，不抄 SDK 的表，直接去掉。
 * 只处理存进历史的这份副本，`ctx.message.content` 原样不动。
 */
export function sanitizeHistoryContent(content: string): string {
  return content
    .replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_m, ext: string) => {
      try {
        const text = (JSON.parse(Buffer.from(ext, 'base64').toString('utf-8')) as { text?: string }).text;
        return text ? `【表情: ${text}】` : '';
      } catch {
        return '';
      }
    })
    .replace(/\[<face,id=\d+\/?>]/g, '')
    .trim();
}

/** 从原始附件里提取要进历史条目元数据；语音跳过（有 ASR 文本，落盘也没用） */
export function extractHistoryAttachments(
  attachments: RawAttachment[] | undefined,
): HistoryAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const kept: HistoryAttachment[] = [];
  for (const att of attachments) {
    const kind = classifyContentType(att.content_type);
    if (!RECORDABLE_KINDS.has(kind)) continue;
    kept.push({
      contentType: att.content_type,
      filename: att.filename ?? '',
      size: typeof att.size === 'number' ? att.size : undefined,
      url: att.url,
    });
  }
  return kept.length > 0 ? kept : undefined;
}

export function akaneHistoryBuffer(options: HistoryBufferOptions): Middleware {
  const { limit, store, media, logger, ledger } = options;

  // 落盘串行链：一条链跑完才跑下一条。刷图的人因此只能排队，不能把进程变成下载器。
  let tail: Promise<void> = Promise.resolve();

  async function harvest(groupKey: string, atts: HistoryAttachment[]): Promise<void> {
    for (const att of atts) {
      if (!HARVESTABLE_KINDS.has(classifyContentType(att.contentType))) continue;
      if (ledger.resolve(att)) continue; // 同一张图已经在本地了，重复发不重复拉
      if (!ledger.tryConsumeQuota(groupKey)) {
        logger.debug(`im-qqbot-akane: history image quota reached: group=${groupKey.slice(-8)} file=${att.filename}`);
        continue;
      }
      // 配额按「尝试」计，失败不退：过期/坏链接不该换来重试额度
      await downloadMediaAttachments([toRawAttachment(att)], media, logger, ledger);
    }
  }

  return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    const key = options.groupKey(ctx);
    if (!key) {
      await next();
      return;
    }

    const msg = ctx.message as {
      kind?: string;
      senderId: string;
      senderName?: string;
      senderIsBot?: boolean;
      content?: string;
      timestamp?: string;
      messageId?: string;
      attachments?: RawAttachment[];
    };

    // 1. 先取旧缓冲（不含当前消息），再记录当前消息 —— 与 SDK 版顺序一致
    ctx.state.history = store.list(key, limit);

    const attachments = extractHistoryAttachments(msg.attachments);
    const entry: HistoryEntry = {
      senderId: msg.senderId,
      senderName: msg.senderName,
      content: sanitizeHistoryContent(msg.content ?? ''),
      timestamp: Date.parse(msg.timestamp ?? '') || Date.now(),
      messageId: msg.messageId ?? '',
      ...(attachments ? { attachments } : {}),
    };
    store.append(key, entry, limit);

    // 2. 机器人自己发的图不回灌（她刚发出去的东西没必要再下载一次给她看）
    if (attachments && !msg.senderIsBot && media.enabled) {
      tail = tail
        .then(() => harvest(key, attachments))
        .catch((err: unknown) => {
          logger.warn(`im-qqbot-akane: history harvest failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    await next();
  };
}
