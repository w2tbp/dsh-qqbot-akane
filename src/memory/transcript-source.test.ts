/**
 * T1 只读取数通路（§8 服务面白名单 + §5 失败语义 + §9 测试 3 的清洗层）
 *
 * 三件必须钉住的事：
 * 1. 只调白名单里的方法，`search*` 一个都不碰（本机只会抛 SESSION_QUERY_SEARCH_DISABLED）。
 * 2. 两种 payload 形状不对称 —— 写错一条路径会静默产出 0 条对方发言，整条索引只剩她自己的话。
 * 3. 宿主错误的 `message` 常带 scandir 绝对路径，所以日志只打 code，原文一个字符都不许出现。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import {
  ALLOWED_METHODS,
  containsHostLeak,
  eventToTranscript,
  listSessionIdsByCwd,
  readEventWindow,
  readSessionDigest,
  scrubForReturn,
} from './transcript-source.ts';

const LEAKY = "scandir '/home/anon/.dsh/sessions/--home-anon-dev--' SENTINEL";

function hostError(code: string): Error {
  return Object.assign(new Error(`boom ${LEAKY}`), { code });
}

/** 只声明用到的方法，其余缺失就是本模块要处理的降级分支 */
function ctxOf(service: Record<string, unknown> | undefined): Context {
  return { get: (name: string) => (name === 'sessionQuery' ? service : undefined) } as unknown as Context;
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => lines.push(m);
  return { logger: { info: push, warn: push, debug: push } as unknown as Logger, lines };
}

function userEvent(seq: number, time: number, text: string): unknown {
  // 实测形状：user/message 的 data 直接就是消息本身
  return { type: 'user/message', seq, time, data: { role: 'user', id: `u${seq}`, content: [{ type: 'text', text }] } };
}

function assistantEvent(seq: number, time: number, text: string): unknown {
  // 实测形状：assistant/message 的 data 包一层 {turn, step, message}
  return { type: 'assistant/message', seq, time, data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text }] } } };
}

describe('ALLOWED_METHODS 白名单', () => {
  it('一个 search* 都没有', () => {
    expect(ALLOWED_METHODS.filter((name) => name.startsWith('search'))).toEqual([]);
    expect(ALLOWED_METHODS).toContain('readEvent');
    expect(ALLOWED_METHODS).toContain('filterSessions');
  });

  it('本模块源码里没有任何 search* 调用（注释里提到不算）', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./transcript-source.ts', import.meta.url), 'utf8'),
    );
    expect(ALLOWED_METHODS.join(',')).not.toContain('search');
    expect(source).not.toMatch(/\.search[A-Za-z]*\s*[!.(]/);
    expect(source).not.toMatch(/get\(\s*['"`]search/);
  });
});

describe('eventToTranscript（两种不对称形状）', () => {
  it('user/message 从 data.content 取正文，角色 peer', () => {
    expect(eventToTranscript(userEvent(3, 1700000000000, '猫粮太贵了'))).toEqual({
      seq: 3,
      time: 1700000000000,
      role: 'peer',
      rawText: '猫粮太贵了',
    });
  });

  it('assistant/message 从 data.message.content 取正文，角色 akane', () => {
    expect(eventToTranscript(assistantEvent(4, 1700000001000, '两千多一包'))).toEqual({
      seq: 4,
      time: 1700000001000,
      role: 'akane',
      rawText: '两千多一包',
    });
  });

  it('多个 text 块拼接，非 text 块忽略', () => {
    const event = {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: { content: [{ type: 'image', url: 'x' }, { type: 'text', text: '甲' }, { type: 'text', text: '乙' }] },
    };
    expect(eventToTranscript(event)!.rawText).toBe('甲\n乙');
  });

  it('无关类型 / 缺字段 / 正文不是数组 → undefined（跳过而不是造假）', () => {
    expect(eventToTranscript(undefined)).toBeUndefined();
    expect(eventToTranscript({ type: 'session/created', seq: 1, time: 0, data: {} })).toBeUndefined();
    expect(eventToTranscript({ type: 'user/message', seq: '1', time: 0, data: { content: [] } })).toBeUndefined();
    expect(eventToTranscript({ type: 'user/message', seq: 1, time: 0 })).toBeUndefined();
    expect(eventToTranscript({ type: 'user/message', seq: 1, time: 0, data: { content: '不是数组' } })).toBeUndefined();
  });
});

describe('listSessionIdsByCwd', () => {
  it('用 cwd 过滤器取 id 并排序（顺序稳定是幂等判定的前提）', async () => {
    const filterSessions = vi.fn().mockResolvedValue([
      { header: { id: 's-b' } },
      { header: { id: 's-a' } },
      { header: {} },
      '形状不对',
    ]);
    const { logger } = recordingLogger();
    const out = await listSessionIdsByCwd(ctxOf({ filterSessions, readSession: vi.fn() }), '/cwd/akane', logger);
    expect(out).toEqual({ ok: true, value: ['s-a', 's-b'] });
    expect(filterSessions).toHaveBeenCalledWith([{ kind: 'cwd', values: ['/cwd/akane'] }]);
  });

  it('服务缺失 / 方法缺失 → 降级，不抛', async () => {
    const { logger, lines } = recordingLogger();
    expect(await listSessionIdsByCwd(ctxOf(undefined), '/cwd', logger)).toEqual({ ok: false, code: 'SERVICE_ABSENT' });
    expect(await listSessionIdsByCwd(ctxOf({ filterSessions: vi.fn() }), '/cwd', logger)).toEqual({
      ok: false,
      code: 'SERVICE_ABSENT',
    });
    expect(lines.join('\n')).not.toContain('SENTINEL');
  });

  it('列举抛 EACCES 形错误 → QUERY_FAILED，日志只有 code', async () => {
    const { logger, lines } = recordingLogger();
    const filterSessions = vi.fn().mockRejectedValue(hostError('EACCES'));
    const out = await listSessionIdsByCwd(ctxOf({ filterSessions, readSession: vi.fn() }), '/cwd', logger);
    expect(out).toEqual({ ok: false, code: 'QUERY_FAILED' });
    expect(lines).toEqual(['akane memory: 会话列举失败（code=EACCES）']);
    expect(lines.join('\n')).not.toContain('SENTINEL');
    expect(lines.join('\n')).not.toContain('/home/');
  });

  it('ctx.get 自己抛（宿主服务面没就绪）也算 SERVICE_ABSENT', async () => {
    const { logger } = recordingLogger();
    const ctx = { get: () => { throw new Error('not ready'); } } as unknown as Context;
    expect(await listSessionIdsByCwd(ctx, '/cwd', logger)).toEqual({ ok: false, code: 'SERVICE_ABSENT' });
  });
});

describe('readSessionDigest', () => {
  it('按 seq 排序、跳过无关事件', async () => {
    const readSession = vi.fn().mockResolvedValue({
      session: { id: 's-a' },
      events: [assistantEvent(9, 900, '她'), userEvent(2, 200, '对方'), { type: 'x', seq: 1, time: 1 }],
    });
    const { logger } = recordingLogger();
    const out = await readSessionDigest(ctxOf({ readSession, filterSessions: vi.fn() }), 's-a', logger);
    expect(out.ok).toBe(true);
    expect(out.value!.events.map((e) => e.seq)).toEqual([2, 9]);
    expect(out.value!.events.map((e) => e.role)).toEqual(['peer', 'akane']);
  });

  it('fromTime 是 epoch 毫秒：早于它的整条不看（省掉每轮重解析 8.6MB）', async () => {
    const readSession = vi.fn().mockResolvedValue({
      events: [userEvent(1, 1000, '旧'), userEvent(2, 2000, '新'), userEvent(3, 3000, '更新')],
    });
    const { logger } = recordingLogger();
    const out = await readSessionDigest(ctxOf({ readSession, filterSessions: vi.fn() }), 's', logger, 2000);
    expect(out.value!.events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('单份读抛只影响这一份：SESSION_NOT_FOUND 与 QUERY_FAILED 分得清', async () => {
    const { logger, lines } = recordingLogger();
    const readSession = vi.fn().mockRejectedValue(hostError('SESSION_QUERY_SESSION_NOT_FOUND'));
    expect(await readSessionDigest(ctxOf({ readSession, filterSessions: vi.fn() }), 's', logger)).toEqual({
      ok: false,
      code: 'SESSION_NOT_FOUND',
    });
    expect(lines.join('\n')).not.toContain('SENTINEL');
  });

  it('返回体形状不对（events 不是数组）→ SHAPE_UNEXPECTED，不崩', async () => {
    const { logger } = recordingLogger();
    const readSession = vi.fn().mockResolvedValue({ session: { id: 's' } });
    expect(await readSessionDigest(ctxOf({ readSession, filterSessions: vi.fn() }), 's', logger)).toEqual({
      ok: false,
      code: 'SHAPE_UNEXPECTED',
    });
  });
});

describe('readEventWindow', () => {
  it('窗口自己封顶（宿主超范围是抛而不是截断）', async () => {
    const readEvent = vi.fn().mockResolvedValue({ events: [userEvent(5, 500, '中间')] });
    const { logger } = recordingLogger();
    const out = await readEventWindow(ctxOf({ readEvent, filterSessions: vi.fn(), readSession: vi.fn() }), 's', 5, 999, -1, logger);
    expect(out.value!.map((e) => e.seq)).toEqual([5]);
    expect(readEvent).toHaveBeenCalledWith({ sessionId: 's', seq: 5, before: 8, after: 0 });
  });

  it('宿主缺 readEvent → METHOD_MISSING', async () => {
    const { logger, lines } = recordingLogger();
    const out = await readEventWindow(ctxOf({ filterSessions: vi.fn(), readSession: vi.fn() }), 's', 1, 4, 2, logger);
    expect(out).toEqual({ ok: false, code: 'METHOD_MISSING' });
    expect(lines).toContain('akane memory: 宿主 sessionQuery 缺 readEvent（code=METHOD_MISSING）');
  });

  it('宿主抛（含窗口越界）→ QUERY_FAILED，原文不回显', async () => {
    const { logger, lines } = recordingLogger();
    const readEvent = vi.fn().mockRejectedValue(hostError('SESSION_QUERY_INVALID_WINDOW'));
    const out = await readEventWindow(ctxOf({ readEvent, filterSessions: vi.fn(), readSession: vi.fn() }), 's', 1, 4, 2, logger);
    expect(out).toEqual({ ok: false, code: 'QUERY_FAILED' });
    expect(lines.join('\n')).not.toContain('SENTINEL');
  });
});

describe('scrubForReturn / containsHostLeak（§9 测试 3）', () => {
  const WITH_IMAGE = ['[Chat history begins]', '  小明 (o777abc): 这猫粮多少钱', '[Chat history ends]',
    '[Current message] 那张图', '  └ Image: /home/anon/.dsh-qqbot-akane/media/a_1_x.png'].join('\n');

  it('脚手架整块删（连中间那行别人的话和 openid 一起）、图片行换成占位、@marker 与信封标记删净', () => {
    const out = scrubForReturn(WITH_IMAGE);
    expect(out).not.toContain('Chat history');
    expect(out).not.toContain('Image:');
    expect(out).not.toContain('/home/');
    expect(out).not.toContain('o777abc'); // 群历史中间行是别人的身份，同样不许出门
    expect(out).not.toContain('这猫粮多少钱');
    expect(out).toContain('[图片]');
    expect(out).toContain('那张图');
  });

  it('头尾没配对的历史块整段剪（渲染变了宁可少回）', () => {
    expect(scrubForReturn('[Chat history begins]\n  小明 (o777abc): 悄悄话\n后面的正文')).toBe('');
  });

  it('兜底剪绝对路径：前面漏了也不让 /home/... 出门', () => {
    expect(scrubForReturn('见 /home/anon/projects/qq-bot/README.md')).toBe('见 [路径已隐藏]');
  });

  it('单个 /embed 这类词不误伤', () => {
    expect(scrubForReturn('服务在 /embed 接口上').trim()).toBe('服务在 /embed 接口上');
  });

  it('连续调用不漏检（带 g 的共享正则会因 lastIndex 漂移漏判）', () => {
    const leaky = '那句 /home/anon/.dsh-qqbot-akane/media/a_1_x.png 里是什么';
    for (let i = 0; i < 3; i += 1) {
      expect(containsHostLeak(scrubForReturn(leaky))).toBe(false); // 已洗干净
      expect(containsHostLeak(leaky)).toBe(true);
    }
  });

  it('判泄漏认三种形态：图片行、绝对路径、裸 Image: 痕迹', () => {
    expect(containsHostLeak('└ Image: /tmp/a.png')).toBe(true);
    expect(containsHostLeak('  └ Image: 无路径但仍是标记')).toBe(true);
    expect(containsHostLeak('她说过：猫粮两百多')).toBe(false);
  });

  it('时间信封 <time=...> 与 <@!123> 都删', () => {
    const out = scrubForReturn('<time=2026-11-19T10:00:00+08:00> <@!100001> 猫粮多少钱');
    expect(out).toBe('猫粮多少钱');
  });
});
