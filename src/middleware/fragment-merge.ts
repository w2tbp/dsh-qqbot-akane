/**
 * 分片合并 —— concurrencyGuard({ strategy: 'merge' }) 的 onMerge
 *
 * 不传 onMerge 时吃 SDK 的 defaultMerge，它有三处语义缺陷（取证见
 * docs/specs/2026-11-18-akane-fragment-merge-and-recall.md §1 F2）：
 *
 * 1. 幸存者取 `buffered[0]`（最早一片）。幸存者决定本轮被动回复锚在哪个
 *    msg_id 上，取最早 = 把回复押在离过期最近的凭据上。
 * 2. 正文 `contents.join('\n')` 拼成一份，出站只渲染一个发送人 —— 两个人
 *    同时各说三段时，她看到一个人说了三句话。
 * 3. 附件只从 `content !== ''` 的分片里 flatMap。**只有图没有字的分片整张丢**
 *    —— 而 contentSanitizer 会抹掉 `@akane` marker，"@她 + 单发一张图"正好落进这条。
 *
 * 这里逐条反过来：幸存者取最后一片，附件不分文字与否全部汇总，归属交给
 * `src/transport/inbound.ts` 按分片视图渲染。
 *
 * 注意 `/stop` 不需要 urgentPredicate：它是注册命令（`commands/misc.ts`），
 * 在第 8 步 slashCommand 就被匹配并 reply+stop，永远走不到这里。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { RawAttachment } from '../types.ts';

/**
 * 单个分片的文字视图。
 *
 * 附件不进视图：下载与语音转录都发生在合并**之后**的第 11.5 步，
 * 全部汇总到幸存者消息上，因此媒体只有一个归属点（最后一行）。
 */
export interface FragmentView {
  senderId: string;
  senderName?: string;
  content: string;
}

/** ctx.state 键名 —— 带 akane 前缀，避免与上游/宿主同名字段相撞 */
export const AKANE_MERGED_FRAGMENTS = 'akaneMergedFragments';

/**
 * 把同目标缓冲的分片合并为一条。返回值必须是入参之一（SDK 契约）。
 */
export function mergeFragments(buffered: MiddlewareContext[]): MiddlewareContext {
  const survivor = buffered[buffered.length - 1]!;
  if (buffered.length === 1) return survivor;

  (survivor.state as Record<string, unknown>)[AKANE_MERGED_FRAGMENTS] =
    buffered.map(toFragmentView);

  const attachments = buffered.flatMap(
    (ctx) => (ctx.message.attachments ?? []) as RawAttachment[],
  );
  if (attachments.length > 0) {
    survivor.message.attachments = attachments as never;
  }

  return survivor;
}

function toFragmentView(ctx: MiddlewareContext): FragmentView {
  const msg = ctx.message as unknown as {
    senderId: string;
    senderName?: string;
    content?: string;
  };
  return {
    senderId: msg.senderId,
    ...(msg.senderName !== undefined ? { senderName: msg.senderName } : {}),
    content: (msg.content ?? '').trim(),
  };
}

/** 缓冲溢出（达到 maxQueue）时的处置：只留痕，不替她编一句解释 */
export function onMergeBufferFull(logger: { warn(msg: string): void }) {
  return (ctx: MiddlewareContext): void => {
    const msg = ctx.message as unknown as { messageId?: string; kind?: string };
    logger.warn(
      `merge buffer full, fragment dropped: ${msg.kind ?? 'unknown'} msgId=${msg.messageId ?? '?'}`,
    );
  };
}
