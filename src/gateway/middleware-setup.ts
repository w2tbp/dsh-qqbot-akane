/**
 * SDK 中间件编排
 *
 * 根据插件配置组装 SDK 内置中间件链（洋葱模型）。
 * 中间件负责过滤与上下文富化；最终消息统一由 bot.on('message') 处理转发。
 */
import type { QQBot, MiddlewareContext, AccessPolicy } from '@tencent-connect/qqbot-nodejs';
import {
  errorHandler,
  messageFilter,
  accessPolicy,
  mentionGate,
  contentSanitizer,
  rateLimiter,
  slashCommand,
  concurrencyGuard,
  typingIndicator,
  quoteRef,
  envelopeFormatter,
} from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { buildCommandList } from '../commands/index.ts';
import { attachmentProcessor } from '../middleware/attachment.ts';
import { akaneHistoryBuffer } from '../middleware/history-buffer.ts';
import { akaneArrivalProbe } from '../middleware/arrival-probe.ts';
import { akaneQuietWindow, AKANE_WINDOW_ADDRESSED } from '../middleware/quiet-window.ts';
import { mergeFragments, onMergeBufferFull } from '../middleware/fragment-merge.ts';
import { questionAnswer } from '../middleware/question-answer.ts';
import { getHistoryStore, historyGroupKey } from '../features/history-store.ts';
import { getMediaLedger } from '../features/media-ledger.ts';
import { createWaker, isExplicitMention, type WakeMessageLike, type Waker } from '../wake.ts';

/**
 * 访问控制策略（R4：黑名单进代码）
 *
 * SDK 的 deny 在 mode 之前判定，命中即 ctx.stop() —— 零输出、不唤起 agent、
 * 不发任何占位解释。「连解释也不要发」这种 prompt 层守不住的硬规则，
 * 只有落在这一层才站得住。
 *
 * group scope 的字符串匹配对象是 groupOpenid，所以「按人屏蔽」必须走函数 matcher。
 */
export function buildAccessPolicy(config: ImQQBotConfig, logger: Logger): AccessPolicy {
  const { access } = config;
  const groupDeny = access.groupDeny ?? [];
  return {
    c2c: {
      mode: access.c2cMode,
      allow: access.c2cAllow,
      deny: access.c2cDeny ?? [],
    },
    group: {
      mode: access.groupMode,
      allow: access.groupAllow,
      ...(groupDeny.length > 0
        ? { deny: [(ctx: MiddlewareContext) => groupDeny.includes(ctx.message.senderId)] }
        : {}),
    },
    onBlock: (_mCtx, reason) => {
      if (config.debug) {
        logger.debug(`Access blocked: ${reason}`);
      }
    },
  };
}

/**
 * 门控的「隐性点名」判定（注入 SDK mentionGate 的 isImplicitMention）
 *
 * 两个来源，缺一不可：
 * - 唤醒词命中（R1/R2）。
 * - 静默窗口折叠过的**整批**：幸存者往往是后面那条不带 @ 的续句，而早期那片的
 *   @marker 在窗口里就必须洗掉（它的链到第 4.6 步就断了，等不到第 6 步），
 *   于是 SDK 那三条显式 @ 判据全灭。不认这个标记就会出现「一段话说三句、
 *   她一句都不回」—— 11-19 现网实测。
 *
 * 标记只在 state 上，不往正文里塞假 @marker（她的 prompt 不该出现 `<@!...>`）。
 */
export function createImplicitMention(waker: Waker | null): (ctx: MiddlewareContext) => boolean {
  return (ctx: MiddlewareContext): boolean => {
    if ((ctx.state as Record<string, unknown> | undefined)?.[AKANE_WINDOW_ADDRESSED] === true) return true;
    return waker ? waker(ctx.message) : false;
  };
}

export function setupMiddlewares(
  bot: QQBot,
  config: ImQQBotConfig,
  manager: SessionManager,
  logger: Logger,
): void {
  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 2. 消息过滤：bot 回声 + 消息去重
  bot.use(messageFilter({ skipSelfEcho: false }));

  // 3. 访问控制（空名单 = 拒绝所有人，fail-closed）
  bot.use(accessPolicy(buildAccessPolicy(config, logger)));

  // 3.5 到达间隔插桩（默认关闭）—— 挂在门控与历史之前，但要**在 accessPolicy 之后**：
  //     黑名单里的人不该在她磁盘上留下任何记录。未唤醒的群聊闲聊要记，
  //     因为「一个人连发几条之间隔多久」正是靠这些续句量出来的。
  //     只观测：不改 ctx、不停链、写盘 fire-and-forget，关掉时整块不挂载（零目录）。
  const opener = createWaker({
    strong: config.wakeWords,
    weak: config.wakeWordsWeak,
    excludes: config.wakeWordExcludes,
    appId: config.appId,
  });
  /** 这条消息自身是否点名了她（显式 @ 或唤醒词）—— 静默窗口与插桩共用同一个判定 */
  const namesHer = (ctx: MiddlewareContext): boolean => {
    const msg = ctx.message as unknown as WakeMessageLike & { kind?: string };
    // 私聊每一条都是说给她听的，天然有资格；群里必须点名
    if (msg.kind !== 'group') return true;
    return isExplicitMention(msg, config.appId) || (opener?.(msg) ?? false);
  };
  if (config.arrivalProbe.enabled) {
    bot.use(akaneArrivalProbe({ logger, woke: namesHer }));
  }

  // 4. 群历史缓冲 + 记录时落盘 — 放在门控之前，确保所有消息（含未 @bot）都计入上下文
  //    自建而不用 SDK 的 historyBuffer：它的条目只有文本位，群里的图片进历史就只剩空行。
  //    store/ledger 都走共享单例（回复后清历史、跨链路复用同一张图的落盘结果）
  bot.use(akaneHistoryBuffer({
    limit: config.historyLimit,
    store: getHistoryStore(),
    media: config.media,
    ledger: getMediaLedger(),
    logger,
    groupKey: (ctx) => {
      const gid = ctx.message.groupOpenid;
      if (ctx.message.kind !== 'group' || !gid) return undefined;
      return historyGroupKey(config.appId, gid);
    },
  }));

  // 4.6 空闲静默窗口 —— 必须开在门控之前（未唤醒的后续分片会被第 5 步掐掉，
  //     挂在第 9 步旁边等于没挂）。quietWindowMs = 0 时整块不挂载，链序与改动前一致。
  if (config.quietWindowMs > 0) {
    // 开桶资格用上面那个不带 onHit 的判定（opener）：
    // 这里只问"要不要等他的续句"，不该在日志里冒充一次唤醒命中（那归第 5 步那个 waker 判）
    bot.use(akaneQuietWindow({
      quietMs: config.quietWindowMs,
      emptyShellMs: config.quietWindowEmptyShellMs,
      maxWaitMs: config.quietWindowMaxWaitMs,
      maxFragments: config.quietWindowMaxFragments,
      canOpen: namesHer,
      isPassthrough: (ctx: MiddlewareContext) => {
        const text = (ctx.message.content ?? '').trim();
        // 斜杠命令要求"立刻"；待答问题的答案要求"立刻"（第 8.5 步的存在理由）
        if (text.startsWith('/')) return true;
        const { scope, targetId } = ctx.replyTarget;
        return text !== '' && (manager.questionChannel?.hasPending(scope, targetId) ?? false);
      },
      logger,
    }));
  }

  // 5. 群聊 @bot 门控
  //    词表全空**且窗口也关着**时才连 isImplicitMention 都不注入 —— 关闭态零开销，行为与上游 0.5.5 一致
  const waker = createWaker({
    strong: config.wakeWords,
    weak: config.wakeWordsWeak,
    excludes: config.wakeWordExcludes,
    appId: config.appId,
    onHit: (hit) => {
      if (config.debug) {
        logger.debug(`[im-qqbot-akane] wake hit: tier=${hit.tier} word=${hit.word} index=${hit.index}`);
      }
    },
  });
  bot.use(mentionGate({
    requireMentionInGroup: config.requireMention,
    ...(waker || config.quietWindowMs > 0 ? { isImplicitMention: createImplicitMention(waker) } : {}),
  }));

  // 6. 内容清洗（去 @marker、表情标签、多余空白）
  bot.use(contentSanitizer({
    parseFaceTags: true,
  }));

  // 7. 三层限流（sender / group / global）
  bot.use(rateLimiter());

  // 8. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
  const slash = slashCommand({
    // 关闭 autoHelp：help 命令由 qqbot 注册为 /bot-help，
    // 避免 SDK 再自动注册一个无前缀的 /help 造成重复
    autoHelp: false,
    commands: buildCommandList({ manager, config, logger }),
  });
  bot.use(slash.middleware);

  // 8.5. 待答问题截获（在 concurrencyGuard 之前，答案消息不排队直接作答）
  bot.use(questionAnswer(manager));

  // 9. 并发串行 + 消息合并（同 peer 排队，避免 session 冲突）
  //    onMerge 必须显式给：缺省吃 SDK 的 defaultMerge，它会
  //    ① 把被动回复锚在最老的 msg_id 上（离过期最近）、② 拼接丢跨人归属、
  //    ③ 丢掉「只有图没有字」那种分片的附件。三条各对应一个现网故障形状。
  //    不传 urgentPredicate：/stop 是注册命令，在第 8 步就被匹配并 reply+stop，
  //    走不到这里 —— 上游 OpenClaw 需要它是因为那边的 /stop 是框架级的。
  bot.use(concurrencyGuard({
    strategy: 'merge',
    maxQueue: config.maxQueue,
    maxProcessingMs: config.processingTimeoutMs,
    onMerge: mergeFragments,
    onDrop: onMergeBufferFull(logger),
  }));

  // 10. C2C 输入状态指示
  bot.use(typingIndicator());

  // 11. 引用消息解析（记录 + 解析被引用原文）
  bot.use(quoteRef({
    maxSize: 500,
    preferMsgElements: true,
  }));

  // 11.5. 附件下载（file 附件下载到本地，供 @提及 / 工具访问）
  bot.use(attachmentProcessor(config, logger));

  // 12. 上下文组装（将 history + quote + sender 组成 envelope）
  bot.use(envelopeFormatter({
    historyLimit: config.historyLimit,
    includeQuote: true,
    includeSender: true,
  }));
}
