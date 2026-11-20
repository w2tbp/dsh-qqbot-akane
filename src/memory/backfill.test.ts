/**
 * 回填与增量同步（§9 测试 8 的正本：同一批转录跑两次，条数不许增长）
 *
 * 三条纪律都在这组用例里钉住：游标只在成功落盘后推进、归属解析不出写 unknown
 * 且不做「按 cwd 兜底」、任何失败都不许把异常抛给调用方（那是 QQ 里的 ❌）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import { EMBED_DIMS } from './index-store.ts';
import { UNKNOWN_PEER } from './peer.ts';
import { runBackfillOnce, type BackfillDeps } from './backfill.ts';

const CWD = '/home/anon/.dsh-qqbot-akane/workspace';
const UNIT_DIMS = EMBED_DIMS;

let dir = '';
const logs: string[] = [];
const logger = {
  info: (m: string) => logs.push(m),
  warn: (m: string) => logs.push(m),
  debug: (m: string) => logs.push(m),
} as unknown as Logger;

function jsonl(): string[] {
  try {
    return readFileSync(join(dir, 'chunks.jsonl'), 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function userEvent(seq: number, time: number, text: string): unknown {
  return { type: 'user/message', seq, time, data: { role: 'user', content: [{ type: 'text', text }] } };
}

function assistantEvent(seq: number, time: number, text: string): unknown {
  return { type: 'assistant/message', seq, time, data: { message: { content: [{ type: 'text', text }] } } };
}

/** 宿主服务面 stub：两份转录，第二份里塞一条脚手架错位的事件 */
function hostCtx(sessions: Record<string, unknown[]>): Context {
  return {
    get: (name: string) =>
      name === 'sessionQuery'
        ? {
            filterSessions: async () => Object.keys(sessions).sort().map((id) => ({ header: { id } })),
            readSession: async (id: string) => ({ session: { id }, events: sessions[id] ?? [] }),
          }
        : undefined,
  } as unknown as Context;
}

function embeddingFetch() {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const texts = (JSON.parse(String(init?.body ?? '{"texts":[]}')) as { texts: string[] }).texts;
    const vectors = texts.map((_, i) => {
      const v = new Array<number>(UNIT_DIMS).fill(0);
      v[i % UNIT_DIMS] = 1;
      return v;
    });
    return Response.json({ ok: true, model: 'Xenova/bge-small-zh-v1.5', dims: UNIT_DIMS, vectors });
  });
}

function deps(over: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    ctx: hostCtx({ 's-a': [userEvent(1, 1_700_000_000_000, '猫粮太贵了'), assistantEvent(2, 1_700_000_002_000, '两千多一包')] }),
    logger,
    dir,
    cwd: CWD,
    quietWindowMs: 12000,
    embed: { baseUrl: 'http://127.0.0.1:8765', timeoutMs: 2000, dims: UNIT_DIMS },
    resolvePeer: () => 'c2c:oA',
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'akane-backfill-'));
  logs.length = 0;
  vi.stubGlobal('fetch', embeddingFetch());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('首轮全量回填', () => {
  it('写进三文件并把游标推到最大 seq', async () => {
    const summary = await runBackfillOnce(deps());
    expect(summary.failed).toBe(false);
    expect(summary.indexed).toBe(2); // 一条对方的 + 一条她的（角色不同绝不合并）
    expect(jsonl()).toHaveLength(2);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { cursors: Record<string, number> };
    expect(meta.cursors).toEqual({ 's-a': 2 });
  });

  it('窗口内的续句合成一条 chunk —— 折叠说一条，chunk 就说一条（§1.4 同源同值）', async () => {
    const backfill = deps({
      ctx: hostCtx({
        's-a': [
          userEvent(1, 1_000, '猫粮太贵了'),
          userEvent(2, 6_000, '一包要两百多'),
          userEvent(3, 20_000, '今天加班到十点'),
        ],
      }),
    });
    const summary = await runBackfillOnce(backfill);
    expect(summary.indexed).toBe(2);
    const rows = jsonl().map((line) => JSON.parse(line) as { text: string; seqStart: number; seqEnd: number });
    expect(rows.find((r) => r.seqStart === 1)).toEqual({
      text: '猫粮太贵了\n一包要两百多',
      seqStart: 1,
      seqEnd: 2,
      time: 1_000,
      role: 'peer',
      hasMedia: false,
      textLen: '猫粮太贵了\n一包要两百多'.length,
      key: 's-a:1-2',
      sessionId: 's-a',
      peer: 'c2c:oA',
    });
  });

  it('恰好等于窗口的续句不再合并（strictGap：一段话不许拆到两轮作业里）', async () => {
    const backfill = deps({
      ctx: hostCtx({ 's-a': [userEvent(1, 0, '甲'), userEvent(2, 12_000, '乙')] }),
    });
    expect((await runBackfillOnce(backfill)).indexed).toBe(2);
  });

  it('取不到正文的事件计数上报，不静默少一半（渲染形状变了要能发现）', async () => {
    const polluted = ['[Chat history begins]', '  小明 (o777abc): 这猫粮多少钱', '[Chat history ends]'].join('\n');
    const backfill = deps({
      ctx: hostCtx({ 's-a': [userEvent(1, 0, '甲'), userEvent(2, 1_000, polluted)] }),
    });
    const summary = await runBackfillOnce(backfill);
    expect(summary.indexed).toBe(1);
    expect(summary.dropped).toBe(1);
    expect(summary.droppedScaffold).toBe(1);
    expect(jsonl().join('\n')).not.toContain('Chat history');
    expect(jsonl().join('\n')).not.toContain('/home/');
  });
});

describe('幂等与增量（§9 测试 8）', () => {
  it('同一批转录回填两次，条数不增长', async () => {
    const backfill = deps();
    await runBackfillOnce(backfill);
    const first = jsonl().length;
    const second = await runBackfillOnce(backfill);
    expect(second.indexed).toBe(0);
    expect(jsonl()).toHaveLength(first);
  });

  it('第二轮只吃游标之后的新事件', async () => {
    const events: unknown[] = [userEvent(1, 0, '甲')];
    const backfill = deps({ ctx: hostCtx({ 's-a': events }) });
    await runBackfillOnce(backfill);
    events.push(userEvent(2, 3_000, '乙'), assistantEvent(3, 4_000, '丙'));
    const summary = await runBackfillOnce(backfill);
    expect(summary.indexed).toBe(2); // seq2 是对方的、seq3 是她的；游标前那条不重复合并
    expect(jsonl()).toHaveLength(3);
    expect((await loadCursors())['s-a']).toBe(3);
  });

  it('服务不可达时这一轮直接跳过：一个 /embed 请求都不发，游标不动', async () => {
    const backfill = deps({ probe: async () => false });
    const summary = await runBackfillOnce(backfill);
    expect(summary).toMatchObject({ failed: true, failureCode: 'EMBED_UNREACHABLE', indexed: 0 });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(jsonl()).toHaveLength(0);
  });

  it('probe 自己抛也当不可达（不许把异常抛给作业循环）', async () => {
    const summary = await runBackfillOnce(deps({ probe: async () => { throw new Error('socket hang up'); } }));
    expect(summary.failureCode).toBe('EMBED_UNREACHABLE');
  });

  it('嵌入反复失败 → 游标不动，下一轮还会试同一批', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED /home/anon'));
    const backfill = deps();
    const first = await runBackfillOnce(backfill);
    expect(first).toMatchObject({ failed: true, failureCode: 'EMBED_UNAVAILABLE' });
    expect((await loadCursors())['s-a'] ?? 0).toBe(0);
    expect(jsonl()).toHaveLength(0);
    expect(logs.filter((line) => line.includes('嵌入失败')).length).toBeLessThanOrEqual(3); // 重试上限 3
  });
});

describe('归属与降级', () => {
  it('解析不出归属写 unknown：照样进索引，但键不是任何真人（fail-closed）', async () => {
    const backfill = deps({ resolvePeer: () => UNKNOWN_PEER });
    const summary = await runBackfillOnce(backfill);
    expect(summary.peerUnknown).toBe(2);
    const rows = jsonl().map((line) => JSON.parse(line) as { peer: string });
    expect(rows.every((r) => r.peer === UNKNOWN_PEER)).toBe(true);
  });

  it('单份读抛只影响这一份，另一份照常', async () => {
    const backfill = deps({
      ctx: {
        get: (name: string) =>
          name === 'sessionQuery'
            ? {
                filterSessions: async () => [{ header: { id: 's-bad' } }, { header: { id: 's-good' } }],
                readSession: async (id: string) => {
                  if (id === 's-bad') throw Object.assign(new Error("scandir '/home/anon/.dsh/sessions' SENTINEL"), { code: 'EACCES' });
                  return { session: { id }, events: [userEvent(1, 0, '甲')] };
                },
              }
            : undefined,
      } as unknown as Context,
    });
    const summary = await runBackfillOnce(backfill);
    expect(summary.unreadable).toBe(1);
    expect(summary.failed).toBe(false);
    expect(summary.indexed).toBe(1);
    expect(logs.join('\n')).not.toContain('SENTINEL');
    expect(logs.join('\n')).not.toContain('/home/');
  });

  it('列举整体抛 → 整轮判失败且不抛（宿主一个不可读目录就会让整体失败）', async () => {
    const backfill = deps({
      ctx: {
        get: () => ({
          filterSessions: async () => { throw Object.assign(new Error('boom'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' }); },
          readSession: async () => ({ events: [] }),
        }),
      } as unknown as Context,
    });
    expect(await runBackfillOnce(backfill)).toMatchObject({ failed: true, failureCode: 'QUERY_FAILED' });
  });

  it('服务面根本没就绪 → SERVICE_ABSENT，插件照常起', async () => {
    const summary = await runBackfillOnce(deps({ ctx: { get: () => undefined } as unknown as Context }));
    expect(summary).toMatchObject({ failed: true, failureCode: 'SERVICE_ABSENT' });
    expect(logs.some((line) => line.includes('code=SERVICE_ABSENT'))).toBe(true);
  });

  it('单轮落库有上限，首轮回填不许把机器吃满', async () => {
    const events = Array.from({ length: 400 }, (_, i) => assistantEvent(i + 1, i * 60_000, `第 ${i} 句`));
    const summary = await runBackfillOnce(deps({ ctx: hostCtx({ 's-a': events }) }));
    expect(summary.indexed).toBe(240);
    expect(jsonl()).toHaveLength(240);
  });
});

async function loadCursors(): Promise<Record<string, number>> {
  const { readFile } = await import('node:fs/promises');
  try {
    return (JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as { cursors: Record<string, number> }).cursors;
  } catch {
    return {};
  }
}

describe('memorySwitch 运行时开关', () => {
  it('memorySwitch.on === false 时 startMemorySync 的 tick 不写索引', async () => {
    const { memorySwitch } = await import('./switch.ts');
    const { startMemorySync } = await import('./backfill.ts');
    
    // 关掉开关
    memorySwitch.on = false;
    
    const stop = startMemorySync(deps(), 600000);
    
    // 等待一个宏任务边界，让 tick 跑完
    await new Promise((resolve) => setTimeout(resolve, 10));
    
    // 索引应该没写
    expect(jsonl()).toHaveLength(0);
    
    // 停掉后台作业
    stop();
    
    // 恢复开关状态
    memorySwitch.on = true;
  });
});
