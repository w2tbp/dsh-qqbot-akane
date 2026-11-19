/**
 * 空闲静默窗口 —— 门控之前的分片折叠
 *
 * 为什么不能顺着第 9 步的 concurrencyGuard 改：那条策略只在"她正忙"时才攒消息
 * （SDK `concurrency-guard.ts:166-171`「No active processing — proceed immediately」），
 * 空闲期一条消息进来立刻放行，一秒都不等 —— 而"一个人连发三条"最常见的时候她正是空闲的。
 *
 * 为什么必须挂在 mentionGate **之前**：门控会把没 @ 到她的消息直接 ctx.stop()，
 * 那条后续分片根本走不到第 9 步。所以窗口开在门控前面，让整段话一起到达。
 * 但门控看不见"开桶那片曾点过名"——@marker 在这里就必须洗掉，幸存者又是不带 @ 的
 * 续句 —— 所以折叠时要往幸存者 state 上写 AKANE_WINDOW_ADDRESSED，门控读它。
 * 少了这一路，整批会被判成没人喊的闲聊，她一个字都不回（11-19 现网实测）。
 *
 * 三条不可上线的纪律（spec §2）：
 * - 只有有资格开桶的人才能开桶：私聊每条都有资格（本来就是说给她听的），
 *   群里必须是显式 @ 或唤醒词命中。别人的闲聊绝不被拽进她这一轮。
 * - 窗口必须被外部事件强制闭合：斜杠命令、待答问题的答案、片数上限、等待硬顶。
 *   少一条就会出现"她憋着不回"这种最难查的故障。
 * - 早期分片永远不会经过第 6 步 contentSanitizer（它们的链在这里就停了），
 *   所以折叠前必须自己洗 @marker 与表情标签，否则原始标签会进她的 prompt。
 *
 * 桶表在模块级：热重载不重建插件模块实例，进程内单例跨重载存活（同群历史缓冲、媒体账本）。
 */
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { Logger, RawAttachment } from '../types.ts';
import { mergeFragments } from './fragment-merge.ts';
import { sanitizeHistoryContent } from './history-buffer.ts';

export interface QuietWindowDeps {
  /** 静默多久算"说完了"。0 = 关闭（此时本中间件不该被挂载） */
  quietMs: number;
  /** 整批无正文也无附件（空壳，只 @ 不办事）时改用的长窗口；0 = 沿用 quietMs */
  emptyShellMs: number;
  /** 从首片起的最长等待硬顶，到点必放行 */
  maxWaitMs: number;
  /** 单桶最多攒几条，达到即立即放行 */
  maxFragments: number;
  /** 这条消息有没有资格**开**桶（私聊 / 显式 @ / 唤醒词命中） */
  canOpen: (ctx: MiddlewareContext) => boolean;
  /** 直穿件：语义上要求"立刻"，不许进桶（斜杠命令、待答问题的答案） */
  isPassthrough: (ctx: MiddlewareContext) => boolean;
  logger: Logger;
}

interface Held {
  ctx: MiddlewareContext;
  /** 由 flush 调用：true 表示本 ctx 是幸存者，由它继续走完整条链 */
  resolve: (isSurvivor: boolean) => void;
}

interface Bucket {
  key: string;
  held: Held[];
  quietTimer?: ReturnType<typeof setTimeout>;
  /** 只在开桶时挂一次 —— 顺延不许突破硬顶（US-9） */
  capTimer?: ReturnType<typeof setTimeout>;
  maxWaitMs: number;
  maxFragments: number;
  emptyShellMs: number;
  quietMs: number;
  logger: Logger;
}

const buckets = new Map<string, Bucket>();

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

export function akaneQuietWindow(deps: QuietWindowDeps): Middleware {
  const { quietMs, maxWaitMs } = deps;

  if (quietMs <= 0) {
    // 关闭态：不起定时器、不建桶、不产生任何日志 —— 链序与改动前逐字节一致
    return async (_ctx, next) => {
      await next();
    };
  }
  if (maxWaitMs <= 0) {
    throw new Error(
      'quietWindowMaxWaitMs must be > 0 when quietWindowMs is enabled: ' +
        'without a hard cap an endless stream of fragments would never be released',
    );
  }

  return async (ctx, next) => {
    const key = bucketKey(ctx);
    const existing = buckets.get(key);

    if (deps.isPassthrough(ctx)) {
      // 直穿件同时强制放行已开的桶：不许有消息看不见地攒着
      if (existing) flush(key);
      await next();
      return;
    }

    // 桶没开着、这条又没资格喊她 —— 原样交给门控（零延迟、零行为变化）
    if (!existing && !deps.canOpen(ctx)) {
      await next();
      return;
    }

    const isSurvivor = await new Promise<boolean>((resolve) => {
      const bucket = existing ?? openBucket(key, deps);
      bucket.held.push({ ctx, resolve });

      if (bucket.held.length >= bucket.maxFragments) {
        if (bucket.quietTimer) clearTimeout(bucket.quietTimer);
        flush(key);
        return;
      }
      armQuietTimer(bucket);
    });

    if (!isSurvivor) return;
    await next();
  };
}

// ── 内部 ─────────────────────────────────────────────

function openBucket(key: string, deps: QuietWindowDeps): Bucket {
  const bucket: Bucket = {
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
function armQuietTimer(bucket: Bucket): void {
  if (bucket.quietTimer) clearTimeout(bucket.quietTimer);
  const windowMs = hasAnswerableContent(bucket) ? bucket.quietMs : bucket.emptyShellMs || bucket.quietMs;
  bucket.quietTimer = setTimeout(() => flush(bucket.key), windowMs);
}

/**
 * 整批到底有没有可答内容 —— 判"空壳"必须用洗过 @marker 的文字：
 * 群里单独一条 `<@!appid>`（后面才是正事）清洗后就是空的，那才是长窗口该救的形状。
 * 已知不足：只喊称呼不带 @（"akane" 单独一条）仍算有内容，走短窗口。
 * 认出"整句只是在叫她"要吃唤醒扫描那套边界判定，本期不扩。
 */
function hasAnswerableContent(bucket: Bucket): boolean {
  return bucket.held.some(({ ctx }) => {
    const msg = ctx.message as unknown as { content?: string; attachments?: RawAttachment[] };
    if (cleanFragmentText(msg.content ?? '') !== '') return true;
    return (msg.attachments?.length ?? 0) > 0;
  });
}

/**
 * 到点（或被强制闭合）放行整批。
 * 非幸存者的链在此自然终止 —— 与 SDK merge 的契约同一形状。
 */
function flush(key: string): void {
  const bucket = buckets.get(key);
  if (!bucket) return;
  buckets.delete(key);
  if (bucket.quietTimer) clearTimeout(bucket.quietTimer);
  if (bucket.capTimer) clearTimeout(bucket.capTimer);

  const { held } = bucket;
  if (held.length === 0) return;

  if (held.length > 1) {
    // 早期分片自己洗：它们的 ctx 不会再经过第 6 步
    for (const { ctx } of held.slice(0, -1)) {
      const msg = ctx.message as unknown as { content?: string };
      msg.content = cleanFragmentText(msg.content ?? '');
    }
    const survivor = mergeFragments(held.map(({ ctx }) => ctx));

    // 整批是被点名的那片开起来的 → 告诉门控这批该答
    (survivor.state as Record<string, unknown>)[AKANE_WINDOW_ADDRESSED] = true;

    // 早期分片在第 4 步已经各自进过历史了，合并后别再于同一轮里出现第二遍
    const absorbed = new Set(
      held.slice(0, -1)
        .map(({ ctx }) => (ctx.message as unknown as { messageId?: string }).messageId)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    );
    const history = (survivor.state as unknown as { history?: Array<{ messageId?: string }> }).history;
    if (absorbed.size > 0 && Array.isArray(history)) {
      (survivor.state as unknown as { history: unknown }).history =
        history.filter((e) => !absorbed.has(e.messageId ?? ''));
    }

    bucket.logger.info(`quiet window flushed: key=${key} fragments=${held.length}`);
  }

  const last = held.length - 1;
  held.forEach((h, i) => h.resolve(i === last));
}

/** 桶键：同群同人同桶（D1）。私聊时 scope=c2c、targetId 就是这个人，天然同键 */
function bucketKey(ctx: MiddlewareContext): string {
  const target = ctx.replyTarget as unknown as { scope: string; targetId: string };
  const senderId = (ctx.message as unknown as { senderId?: string }).senderId ?? '';
  return `${target.scope}:${target.targetId}:${senderId}`;
}

/** @marker 与表情标签 —— 与 wake.ts 扫描用的掩码不同，这里是真删（要给她的正文） */
function cleanFragmentText(content: string): string {
  return sanitizeHistoryContent(content.replace(/<@!?\d+>/g, ''));
}
