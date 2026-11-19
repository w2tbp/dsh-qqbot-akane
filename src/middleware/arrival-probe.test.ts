import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { akaneArrivalProbe, bucketHash, cleanupExpiredProbeFiles, dayName, ProbeSink } from './arrival-probe.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'akane-probe-'));
  vi.clearAllMocks();
});
afterEach(async () => {
  // 每条用例一个 mkdtemp，不删就是每次 pnpm test 在 /tmp 里多攒一撮空目录
  await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function ctx(spec: {
  kind?: 'c2c' | 'group';
  targetId?: string;
  senderId?: string;
  content?: string;
  messageId?: string;
}): MiddlewareContext {
  const kind = spec.kind ?? 'group';
  return {
    message: {
      kind,
      senderId: spec.senderId ?? 'SENDER-openid-明文',
      ...(kind === 'group' ? { groupOpenid: spec.targetId ?? 'GROUP-openid-明文' } : {}),
      content: spec.content ?? '正文，不该出现在插桩里',
      messageId: spec.messageId ?? 'MSG-1',
    },
    replyTarget: { scope: kind, targetId: spec.targetId ?? (kind === 'c2c' ? 'SENDER-openid-明文' : 'GROUP-openid-明文') },
    state: {},
  } as unknown as MiddlewareContext;
}

async function readLines(): Promise<string[]> {
  const names = await readdir(root);
  const files = names.filter((n) => n.endsWith('.jsonl'));
  const all = await Promise.all(files.map((n) => readFile(join(root, n), 'utf8')));
  return all.join('').split('\n').filter(Boolean);
}

describe('插桩记录形状（US-30）', () => {
  it('一条消息落一行，字段只有 t/k/m —— 正文与 openid 明文一个都不写', async () => {
    const sink = new ProbeSink(root, logger);
    const mw = akaneArrivalProbe({ logger, sink });
    await mw(ctx({ content: '这是不能落盘的聊天内容' }), async () => {});
    await sink.flush();

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['k', 'm', 't']);
    const raw = lines.join('');
    expect(raw).not.toContain('不能落盘');
    expect(raw).not.toContain('openid');
    expect(raw).not.toContain(root);
  });

  it('woke 判定给了才写 w，给了什么就记什么', async () => {
    const sink = new ProbeSink(root, logger);
    const mw = akaneArrivalProbe({ logger, sink, woke: (c) => (c.message.content ?? '').includes('akane') });
    await mw(ctx({ content: 'akane 看下' }), async () => {});
    await mw(ctx({ content: '就这张图', messageId: 'MSG-2' }), async () => {});
    await sink.flush();

    const [a, b] = (await readLines()).map((l) => JSON.parse(l) as { w?: number });
    expect(a!.w).toBe(1);
    expect(b!.w).toBe(0);
  });

  it('桶键 = scope:targetId:senderId，换任何一项都不同桶（与静默窗口同键空间）', async () => {
    expect(bucketHash('group:G1:S1')).toBe(bucketHash('group:G1:S1'));
    const distinct = [
      bucketHash('group:G1:S1'),
      bucketHash('group:G1:S2'), // 换发送人
      bucketHash('group:G2:S1'), // 换群
      bucketHash('c2c:S1:S1'),   // 私聊
    ];
    expect(new Set(distinct).size).toBe(4);
    expect(distinct[0]).toMatch(/^[0-9a-f]{8}$/);
  });

  it('不改动 ctx、不掐链：next 恰好一次，消息对象原样', async () => {
    const sink = new ProbeSink(root, logger);
    const mw = akaneArrivalProbe({ logger, sink });
    const target = ctx({});
    let calls = 0;
    await mw(target, async () => { calls += 1; });
    await sink.flush();
    expect(calls).toBe(1);
    expect(target.message.content).toBe('正文，不该出现在插桩里');
  });

  it('写盘失败也不把异常带给消息链，且只报一次日志', async () => {
    // 拿一个普通文件当父目录用 → mkdir 必失败（ENOTDIR），比赌权限稳定
    const blocker = join(root, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    const sink = new ProbeSink(join(blocker, 'sub'), logger);
    const mw = akaneArrivalProbe({ logger, sink });
    for (let i = 0; i < 5; i++) await mw(ctx({ messageId: `M${i}` }), async () => {});
    await sink.flush();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('过期清理', () => {
  it('按 mtime 删旧文件、留新文件；keepDays<=0 或目录不存在时零动作、零创建', async () => {
    const sink = new ProbeSink(root, logger);
    sink.write({ t: Date.now(), k: 'aaaaaaaa', m: 'M1' });
    await sink.flush();

    const [name] = await readdir(root);
    const path = join(root, name!);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(path, old, old);
    expect((await stat(path)).mtimeMs).toBeLessThan(Date.now() - 30 * 24 * 60 * 60 * 1000);

    expect(await cleanupExpiredProbeFiles(30, logger, root)).toBe(1);
    expect(await readdir(root)).toEqual([]);

    // 关到永久保留：不删
    await sink.flush();
    expect(await cleanupExpiredProbeFiles(0, logger, root)).toBe(0);

    // 目录不存在（关闭态从未写过）：返回 0 且不去创建
    const missing = join(root, 'missing');
    expect(await cleanupExpiredProbeFiles(30, logger, missing)).toBe(0);
    await expect(stat(missing)).rejects.toThrow();
  });

  it('文件名按本地日期分片', () => {
    expect(dayName(new Date(2026, 10, 18, 9, 5).getTime())).toBe('2026-11-18.jsonl');
  });
});
