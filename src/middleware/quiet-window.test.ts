import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { akaneQuietWindow, AKANE_WINDOW_ADDRESSED, type QuietWindowDeps } from './quiet-window.ts';
import { AKANE_MERGED_FRAGMENTS, type FragmentView } from './fragment-merge.ts';
import type { Logger, RawAttachment } from '../types.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let seq = 0;
/** 桶表是模块级单例，跨用例共享 —— 每条用例用唯一 id 隔开 */
function fresh(prefix: string): { targetId: string; senderId: string } {
  seq += 1;
  return { targetId: `TARGET-${prefix}-${seq}`, senderId: `SENDER-${prefix}-${seq}` };
}

type CtxSpec = {
  scope?: 'c2c' | 'group';
  targetId?: string;
  senderId?: string;
  senderName?: string;
  content?: string;
  attachments?: RawAttachment[];
  messageId?: string;
  /** 第 4 步历史缓冲已经写进来的那份快照 */
  history?: Array<{ messageId?: string; content: string }>;
};

function makeCtx(spec: CtxSpec): MiddlewareContext {
  const scope = spec.scope ?? 'group';
  return {
    message: {
      kind: scope,
      senderId: spec.senderId ?? 'SENDER-1',
      ...(spec.senderName !== undefined ? { senderName: spec.senderName } : {}),
      content: spec.content ?? '',
      messageId: spec.messageId ?? `MSG-${Math.random().toString(36).slice(2)}`,
      ...(spec.attachments ? { attachments: spec.attachments } : {}),
    },
    replyTarget: { scope, targetId: spec.targetId ?? 'TARGET-1', msgId: 'MSG-1' },
    state: spec.history ? { history: spec.history } : {},
  } as unknown as MiddlewareContext;
}

/**
 * 每条消息独立跑一次中间件：被攒住的分支不会立即 resolve，
 * 所以要并发发起、到点再一起 await。返回值 = 该 ctx 是「放行」还是「被折叠掉」。
 */
function harness(deps: Partial<QuietWindowDeps> = {}) {
  const mw: Middleware = akaneQuietWindow({
    quietMs: 100,
    emptyShellMs: 0,
    maxWaitMs: 1000,
    maxFragments: 4,
    canOpen: () => true,
    isPassthrough: () => false,
    logger,
    ...deps,
  });
  const proceeded: MiddlewareContext[] = [];
  const next = vi.fn(async () => {
    /* 下游链：谁调了 next 就是被放行出去的那条 */
  });
  const run = (ctx: MiddlewareContext) => mw(ctx, () => {
    proceeded.push(ctx);
    return Promise.resolve();
  });
  return { mw, run, next, proceeded };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('关闭态（US-8 / US-25）', () => {
  it('quietMs=0 时立即放行、不起任何定时器、不建桶', async () => {
    const { run, proceeded } = harness({ quietMs: 0 });
    await run(makeCtx({ content: '一句话' }));
    expect(proceeded).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('quietMs>0 但硬顶没给 → 装载时就抛错（不许静默变成"永远不放行"）', () => {
    expect(() => akaneQuietWindow({
      quietMs: 100, emptyShellMs: 0, maxWaitMs: 0, maxFragments: 4,
      canOpen: () => true, isPassthrough: () => false, logger,
    })).toThrow(/quietWindowMaxWaitMs/);
  });
});

describe('一片一段话（US-7）', () => {
  it('同人三片 → 只有最后一片走完整条链，前两片被折叠', async () => {
    const ids = fresh('merge');
    const { run, proceeded } = harness();
    const a = makeCtx({ ...ids, content: '第一片' });
    const b = makeCtx({ ...ids, content: '第二片' });
    const c = makeCtx({ ...ids, content: '第三片' });

    const results = Promise.all([run(a), run(b), run(c)]);
    await vi.advanceTimersByTimeAsync(100);
    await results;

    expect(proceeded).toEqual([c]);
    const views = (c.state as Record<string, unknown>)[AKANE_MERGED_FRAGMENTS] as FragmentView[];
    expect(views.map((v) => v.content)).toEqual(['第一片', '第二片', '第三片']);
  });

  it('单片不写分片视图，也不打日志（与今天逐字节一致）', async () => {
    const { run, proceeded } = harness();
    const only = makeCtx(fresh('solo'));
    const results = run(only);
    await vi.advanceTimersByTimeAsync(100);
    await results;
    expect(proceeded).toEqual([only]);
    expect((only.state as Record<string, unknown>)[AKANE_MERGED_FRAGMENTS]).toBeUndefined();
  });

  it('附件跨片汇总到幸存者（配合第 11.5 步把每张图都下载）', async () => {
    const ids = fresh('att');
    const { run } = harness();
    const text = makeCtx({ ...ids, content: '看这个', attachments: [{ content_type: 'image/png', filename: 'a.jpg', size: 1, url: 'u1' }] });
    const pictureOnly = makeCtx({ ...ids, content: '', attachments: [{ content_type: 'image/png', filename: 'b.jpg', size: 1, url: 'u2' }] });

    const results = Promise.all([run(text), run(pictureOnly)]);
    await vi.advanceTimersByTimeAsync(100);
    await results;

    expect((pictureOnly.message.attachments ?? []).map((a) => (a as RawAttachment).filename)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('早期分片自己洗 @marker 与表情标签（它们的链在这里就停了，等不到第 6 步）', async () => {
    const ids = fresh('clean');
    const { run } = harness();
    const dirty = makeCtx({ ...ids, content: '<@!10000> 帮我看 [<face,id=5/>] 这张' });
    const last = makeCtx({ ...ids, content: '<@!10000> 就这张' });

    const results = Promise.all([run(dirty), run(last)]);
    await vi.advanceTimersByTimeAsync(100);
    await results;

    const views = (last.state as Record<string, unknown>)[AKANE_MERGED_FRAGMENTS] as FragmentView[];
    expect(views[0]!.content).toBe('帮我看  这张');
    expect(views[0]!.content).not.toContain('<@!');
    expect(views[0]!.content).not.toContain('face,id=5');
    // 幸存者自己不洗：第 6 步 contentSanitizer 负责，动它就等于绕过清洗来源分叉
    expect(last.message.content).toBe('<@!10000> 就这张');
  });
});

describe('计时（US-9 / US-11 / US-16）', () => {
  it('每来一片顺延，但从不突破硬顶', async () => {
    const ids = fresh('cap');
    const { run, proceeded } = harness({ quietMs: 100, maxWaitMs: 250, maxFragments: 10 });
    const ctxs = ['一', '二', '三', '四'].map((content) => makeCtx({ ...ids, content }));

    const results = Promise.all(ctxs.map((c, i) => {
      // 到达时刻 0/80/160/240 —— 每次都重置 100ms 静默，最后一按静默本该 340 放行
      return new Promise<void>((res) => setTimeout(() => void Promise.resolve(run(c)).then(() => res()), i * 80));
    }));

    await vi.advanceTimersByTimeAsync(249);
    expect(proceeded).toEqual([]); // 硬顶未到之前一条都不许放行
    await vi.advanceTimersByTimeAsync(1);
    await results;

    expect(proceeded).toEqual([ctxs[3]]);
  });

  it('空壳批次（只有 @、没字也没图）用长窗口', async () => {
    const ids = fresh('shell');
    const { run, proceeded } = harness({ quietMs: 100, emptyShellMs: 400 });
    const shell = makeCtx({ ...ids, content: '<@!10000>' });

    const results = run(shell);
    await vi.advanceTimersByTimeAsync(100);
    expect(proceeded).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    await results;
    expect(proceeded).toEqual([shell]);
  });

  it('空壳批次中途来了正文 → 换回短窗口', async () => {
    const ids = fresh('shell2');
    const { run, proceeded } = harness({ quietMs: 100, emptyShellMs: 400 });
    const shell = makeCtx({ ...ids, content: '' });
    const real = makeCtx({ ...ids, content: '正事' });

    const results = Promise.all([run(shell), run(real)]);
    await vi.advanceTimersByTimeAsync(100);
    await results;
    expect(proceeded).toEqual([real]);
  });

  it('攒到片数上限立即放行，不再等静默', async () => {
    const ids = fresh('max');
    const { run, proceeded } = harness({ maxFragments: 3 });
    const ctxs = ['一', '二', '三'].map((content) => makeCtx({ ...ids, content }));

    const results = Promise.all(ctxs.map(run));
    await results; // 不推进时间就该全部 resolve

    expect(proceeded).toEqual([ctxs[2]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('强制闭合（US-12）', () => {
  it('斜杠命令不进桶，且把已开的桶立即放行', async () => {
    const ids = fresh('slash');
    const { run, proceeded } = harness({ isPassthrough: (ctx) => (ctx.message.content ?? '').trim().startsWith('/') });
    const holding = makeCtx({ ...ids, content: '帮我' });
    const cmd = makeCtx({ ...ids, content: '/bot-ping' });

    const heldPromise = run(holding);
    await vi.advanceTimersByTimeAsync(10); // 静默没到点
    const cmdPromise = run(cmd);
    await cmdPromise; // 不推进任何时间就能 resolve —— 证明命令确实没等窗口
    expect(proceeded[0]).toBe(cmd);
    await heldPromise;
    expect(proceeded).toHaveLength(2); // 桶被强制放行，不许有消息看不见地攒着
    expect(proceeded).toContain(holding);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('待答问题的答案不进桶（否则「turn 等答案 ↔ 答案被攒住」死锁复发）', async () => {
    const ids = fresh('answer');
    let pending = false;
    const { run, proceeded } = harness({ isPassthrough: () => pending });
    const holding = makeCtx({ ...ids, content: '我要问你个事' });
    const heldPromise = run(holding);

    pending = true;
    const answer = makeCtx({ ...ids, content: '选 A' });
    await run(answer);
    expect(proceeded[0]).toBe(answer);
    await heldPromise;
    expect(proceeded).toHaveLength(2);
  });
});

describe('开桶资格与分桶键（US-29 / US-28）', () => {
  it('群里没唤醒且桶没开 → 立即放行给门控，零延迟', async () => {
    const ids = fresh('gate');
    const { run, proceeded } = harness({ canOpen: () => false });
    await run(makeCtx({ ...ids, content: '别人闲聊' }));
    expect(proceeded).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('桶已开着时，未唤醒的续句照样进桶（它们是同一句话）', async () => {
    const ids = fresh('gate2');
    const { run, proceeded } = harness({ canOpen: (ctx) => (ctx.message.content ?? '').includes('akane') });
    const opener = makeCtx({ ...ids, content: 'akane 帮我看' });
    const followUp = makeCtx({ ...ids, content: '就这张图' });

    const results = Promise.all([run(opener), run(followUp)]);
    await vi.advanceTimersByTimeAsync(100);
    await results;

    expect(proceeded).toEqual([followUp]);
  });

  it('同群两个发送人各开各的桶，互不折叠', async () => {
    const ids = fresh('two');
    const a = { ...ids, senderId: `${ids.senderId}-A` };
    const b = { ...ids, senderId: `${ids.senderId}-B` };
    const { run, proceeded } = harness();

    const results = Promise.all([run(makeCtx(a)), run(makeCtx(b))]);
    await vi.advanceTimersByTimeAsync(100);
    await results;

    expect(proceeded).toHaveLength(2); // 两桶各放行一次，不是一轮
  });

  it('同一个人从私聊和群里各发一片 → 不互串（桶键含 scope 与 targetId）', async () => {
    const ids = fresh('cross');
    const { run, proceeded } = harness();
    const direct = makeCtx({ ...ids, scope: 'c2c', targetId: ids.senderId, content: '私聊那句' });
    const grouped = makeCtx({ ...ids, scope: 'group', content: '群里那句' });

    const results = Promise.all([run(direct), run(grouped)]);
    await vi.advanceTimersByTimeAsync(100);
    await results;

    expect(proceeded).toHaveLength(2);
  });
});

/**
 * 与第 5 步门控的接缝 —— 11-19 现网故障形状：一段话说三句，她一句都不回。
 * 原因不在窗口内部（分片确实合并了），在于合并后门控看不出这批被点过名。
 */
describe('放行整批时把「点过名」交给门控（US-26）', () => {
  it('多片批次：幸存者 state 上留标记，早期分片从本轮历史快照里摘掉', async () => {
    const ids = fresh('seam');
    const { run, proceeded } = harness();
    const a = makeCtx({ ...ids, messageId: 'FRAG-A', content: '@她 今天上班烦死了' });
    const b = makeCtx({ ...ids, messageId: 'FRAG-B', content: '被甲方折磨麻了', history: [{ messageId: 'FRAG-A', content: '今天上班烦死了' }] });
    const c = makeCtx({ ...ids, messageId: 'FRAG-C', content: '晚上不想做饭', history: [
      { messageId: 'FRAG-A', content: '今天上班烦死了' },
      { messageId: 'FRAG-B', content: '被甲方折磨麻了' },
      { messageId: 'OLDER', content: '更早的一句' },
    ] });

    const results = Promise.all([run(a), run(b), run(c)]);
    await vi.advanceTimersByTimeAsync(100);
    await results;

    expect(proceeded).toEqual([c]);
    expect((c.state as Record<string, unknown>)[AKANE_WINDOW_ADDRESSED]).toBe(true);
    const history = (c.state as unknown as { history: Array<{ messageId?: string }> }).history;
    expect(history.map((e) => e.messageId)).toEqual(['OLDER']);
  });

  it('单片批次不写标记 —— 关闭态与只有显式 @ 判据时逐字节一致', async () => {
    const { run, proceeded } = harness();
    const only = makeCtx({ ...fresh('seam-solo'), content: '@她 在吗' });
    const results = run(only);
    await vi.advanceTimersByTimeAsync(100);
    await results;

    expect(proceeded).toEqual([only]);
    expect((only.state as Record<string, unknown>)[AKANE_WINDOW_ADDRESSED]).toBeUndefined();
  });

  it('片数上限强制放行也带标记（这条路径同样会进门控）', async () => {
    const ids = fresh('seam-cap');
    const { run, proceeded } = harness({ maxFragments: 2 });
    const a = makeCtx({ ...ids, content: '第一片' });
    const b = makeCtx({ ...ids, content: '第二片' });

    const results = Promise.all([run(a), run(b)]);
    await vi.advanceTimersByTimeAsync(1000);
    await results;

    expect(proceeded).toEqual([b]);
    expect((b.state as Record<string, unknown>)[AKANE_WINDOW_ADDRESSED]).toBe(true);
  });
});
