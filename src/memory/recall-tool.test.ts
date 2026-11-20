/**
 * `akane_recall` 的取链与红线（§9 测试 1/3/4/5/6/10/11）
 *
 * 这个文件里最要紧的是三条「不许」：不许跨 peer、不许把主机路径/别人身份发出去、
 * 不许把异常抛成 QQ 里的 ❌。向量全用 one-hot —— 余弦只取 0 或 1，
 * 于是「判没判得住」与阈值本身的校准无关（阈值数字在 retrieval.test.ts 里钉）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import type { SessionManager } from '../session/index.ts';
import { EMBED_DIMS, appendRows, emptyMeta, readChunkRows, readVectors, type ChunkRow } from './index-store.ts';
import { samePeer, UNKNOWN_PEER } from './peer.ts';
import { RECALL_TOOL_NAME, recallOnce, registerRecallTool, type RecallDeps } from './recall-tool.ts';
import {
  buildLists,
  matchesLiteral,
  queryTokens,
  selectCandidates,
  vectorRanked,
  RRF_K,
  VECTOR_POOL_FACTOR,
  VECTOR_SIM_FLOOR,
} from './retrieval.ts';
import type { TranscriptEvent } from './chunking.ts';

const PEER_A = 'c2c:oA';
const PEER_B = 'c2c:oB';
/** 与查询向量同位 → 余弦 1；换一位 → 余弦 0（低于阈值，连榜位都没有） */
const HOT = 7;
const COLD = 91;

let dir = '';
const logs: string[] = [];
const logger = {
  info: (m: string) => logs.push(m),
  warn: (m: string) => logs.push(m),
  debug: (m: string) => logs.push(m),
} as unknown as Logger;

function oneHot(at: number): number[] {
  const v = new Array<number>(EMBED_DIMS).fill(0);
  v[at] = 1;
  return v;
}

interface Seed {
  key: string;
  text: string;
  peer?: string;
  role?: 'peer' | 'akane';
  time?: number;
  /** 语义档位：HOT=像，COLD=不像 */
  hot?: number;
}

function toRow(item: Seed): ChunkRow {
  const [sessionId, range] = item.key.split(':');
  const [seqStart, seqEnd] = range!.split('-').map(Number);
  return {
    key: item.key,
    sessionId: sessionId!,
    peer: item.peer ?? PEER_A,
    seqStart: seqStart!,
    seqEnd: seqEnd!,
    time: item.time ?? 1_700_000_000_000,
    role: item.role ?? 'akane',
    hasMedia: false,
    textLen: item.text.length,
    text: item.text,
  };
}

async function seed(items: Seed[]): Promise<void> {
  const rows = items.map(toRow);
  await appendRows(dir, rows, rows.map((_, i) => oneHot(items[i]!.hot ?? HOT)), { ...emptyMeta(), chunks: rows.length });
}

/** 查询向量：默认与 HOT 同位（稳过阈值） */
function serveQuery(hot = HOT): void {
  vi.mocked(fetch).mockImplementation(async (_url: unknown, init?: { body?: string }) => {
    const texts = (JSON.parse(String(init?.body ?? '{"texts":[]}')) as { texts: string[] }).texts;
    return Response.json({ ok: true, model: 'Xenova/bge-small-zh-v1.5', dims: EMBED_DIMS, vectors: texts.map(() => oneHot(hot)) });
  });
}

function deps(over: Partial<RecallDeps> = {}): RecallDeps {
  return {
    dir,
    embed: { baseUrl: 'http://127.0.0.1:8765', timeoutMs: 2000, dims: EMBED_DIMS },
    logger,
    currentPeer: PEER_A,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'akane-recall-'));
  logs.length = 0;
  vi.stubGlobal('fetch', vi.fn());
  serveQuery();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('隐私边界（§9 测试 1）', () => {
  it('关键词只存在于别的 peer → 没查到，措辞里不带对方的内容', async () => {
    await seed([
      { key: 's-b:1-1', text: '猫粮两百多，我买了三包', peer: PEER_B },
      { key: 's-a:1-1', text: '今天加班到十点', hot: COLD },
    ]);
    const out = await recallOnce('猫粮', deps());
    expect(out.hits).toBe(0);
    expect(out.text).toContain('没查到');
    expect(out.text).not.toContain('三包');
  });

  it('语义档也算跨：主题再像，别人的 chunk 也不进榜', async () => {
    await seed([{ key: 's-b:9-9', text: '猫粮价格很划算', peer: PEER_B }]);
    expect((await recallOnce('猫粮划算吗', deps())).text).toContain('没查到');
  });

  it('当前会话定位不到归属 → 固定措辞，一条都不回（fail-closed）', async () => {
    await seed([{ key: 's-a:1-1', text: '猫粮两百多' }]);
    for (const currentPeer of [undefined, UNKNOWN_PEER]) {
      const out = await recallOnce('猫粮', deps({ currentPeer }));
      expect(out.text).toContain('没查到');
      expect(out.text).toContain('不能确定该看谁的历史');
      expect(out.hits).toBe(0);
    }
  });

  it('unknown 归属的 chunk 谁都召不回（B4 那个已知缺口的处置）', async () => {
    await seed([{ key: 's-x:1-1', text: '猫粮两百多', peer: UNKNOWN_PEER }]);
    expect((await recallOnce('猫粮', deps())).text).toContain('没查到');
  });

  it('源码里没有「按 cwd 兜底捞全根」的入口', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./recall-tool.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/\bfilterSessions\b|\blistSessionIdsByCwd\b|\bcwd\s*:/);
    expect(source).toContain('samePeer');
  });
});

describe('两档取链', () => {
  it('字面档是逐词 AND（§9 测试 2）：两条只命中一半的词都不算', async () => {
    await seed([
      { key: 's1:1-1', text: '今天加班到十点', hot: COLD },
      { key: 's1:2-2', text: '家里的猫把杯子碰掉了', hot: COLD },
      { key: 's1:3-3', text: '加班时我家猫在桌上' },
    ]);
    const out = await recallOnce('猫 加班', deps({ readWindow: async () => undefined }));
    expect(out.hits).toBe(1);
    expect(out.text).toContain('加班时我家猫在桌上');
    expect(out.text).not.toContain('杯子');
  });

  it('低于阈值不算命中（§9 测试 11）：只有弱相似时必须回「没查到」', async () => {
    await seed([{ key: 's1:1-1', text: '那个价格还不划算', hot: COLD }]);
    const out = await recallOnce('猫粮贵不贵', deps());
    expect(out.hits).toBe(0);
    expect(out.text).not.toContain('价格');
    expect(out.text).toContain('不要把相近的说法当成事实复述');
  });

  it('两档都命中时来源写「字面+语义」并带相似度（答错了能定位是哪档捞错）', async () => {
    await seed([{ key: 's1:1-1', text: '猫粮两百多一包' }]);
    const out = await recallOnce('猫粮', deps());
    expect(out.text).toContain('来源：字面+语义');
    expect(out.text).toContain('相似度 1.000');
  });

  it('写的是「她说过」还是「对方说过」由 chunk 角色决定', async () => {
    await seed([
      { key: 's1:1-1', text: '猫粮她报的价', role: 'akane' },
      { key: 's1:2-2', text: '猫粮对方报的价', role: 'peer' },
    ]);
    const out = await recallOnce('猫粮', deps());
    expect(out.text).toContain('她说过');
    expect(out.text).toContain('对方说过');
  });

  it('索引为空 → 「还没有可检索的内容」而不是报错', async () => {
    expect((await recallOnce('猫粮', deps())).text).toContain('还没有可检索的内容');
  });

  it('查询里没有可用词元 → 换一种说法的措辞', async () => {
    await seed([{ key: 's1:1-1', text: '猫粮两百多' }]);
    expect((await recallOnce(' ！？ ', deps())).text).toContain('换一种说法');
  });
});

describe('返回体清洗（§9 测试 3）', () => {
  const SCAFFOLD_WITH_IMAGE = [
    '[Chat history begins]',
    '  小明 (o777abc): 这猫粮多少钱',
    '[Chat history ends]',
    '[Current message] 那张图里的猫粮',
    '  └ Image: /home/anon/.dsh-qqbot-akane/media/a_1_x.png',
  ].join('\n');

  it('T1 窗口里的图片行、群历史、openid 一个字符都不出门', async () => {
    await seed([{ key: 's1:1-1', text: '那张图里的猫粮' }]);
    const readWindow = async (): Promise<TranscriptEvent[]> => [
      { seq: 1, time: 1_700_000_000_000, role: 'akane', rawText: SCAFFOLD_WITH_IMAGE },
    ];
    const out = await recallOnce('猫粮', deps({ readWindow }));
    expect(out.text).toContain('那张图里的猫粮');
    expect(out.text).toContain('[图片]');
    expect(out.text).not.toContain('/home/');
    expect(out.text).not.toContain('Image:');
    expect(out.text).not.toContain('Chat history');
    expect(out.text).not.toContain('o777abc');
    expect(out.text).not.toContain('这猫粮多少钱');
  });

  it('清洗规则漏了时走整条丢弃，而不是发半句带路径的（LEAK_DROPPED）', async () => {
    // 图片标记嵌在一行中间 —— MEDIA_LINE 的整行规则按设计匹配不到，兜底闸必须接住
    await seed([{ key: 's1:1-1', text: '她说 └ Image: /home/anon/.dsh-qqbot-akane/media/a_1_x.png 那句关于猫粮' }]);
    const out = await recallOnce('猫粮', deps({ readWindow: async () => undefined }));
    expect(out.text).not.toContain('/home/');
    expect(out.text).not.toContain('└ Image:');
    expect(logs.some((line) => line.includes('LEAK_DROPPED'))).toBe(true);
  });

  it('回读窗口失败 → 回落索引文本，不抛也不吭出宿主原文（§9 测试 4）', async () => {
    await seed([{ key: 's1:1-1', text: '猫粮两百多一包' }]);
    const readWindow = async (): Promise<TranscriptEvent[]> => {
      throw Object.assign(new Error("scandir '/home/anon/.dsh/sessions SENTINEL'"), { code: 'EACCES' });
    };
    const out = await recallOnce('猫粮', deps({ readWindow }));
    expect(out.text).toContain('猫粮两百多一包');
    expect(out.text + logs.join('\n')).not.toContain('SENTINEL');
    expect(out.text + logs.join('\n')).not.toContain('/home/');
  });

  it('session id 不进返回体', async () => {
    await seed([{ key: 's-secret-id:1-1', text: '猫粮两百多' }]);
    expect((await recallOnce('猫粮', deps())).text).not.toContain('s-secret-id');
  });
});

describe('限额（§9 测试 5 / 6）', () => {
  it('够 limit 就停：T1 回读只对最终那几条发起', async () => {
    await seed(
      Array.from({ length: 10 }, (_, i) => ({
        key: `s1:${i + 1}-${i + 1}`,
        text: `猫粮第 ${i} 次提到`,
        time: 1_700_000_000_000 + i * 60_000,
      })),
    );
    const readWindow = vi.fn(async (): Promise<TranscriptEvent[]> => [
      { seq: 1, time: 1_700_000_000_000, role: 'akane', rawText: '窗口原文' },
    ]);
    const out = await recallOnce('猫粮', deps({ readWindow }));
    expect(out.hits).toBe(6);
    expect(readWindow).toHaveBeenCalledTimes(6);
    expect(out.text).toContain('窗口原文');
  });

  it('返回体硬顶 3000 字符：超限那条整条不见并留可见标记', async () => {
    const long = '猫' + '粮'.repeat(599);
    await seed(
      Array.from({ length: 8 }, (_, i) => ({
        key: `s1:${i + 1}-${i + 1}`,
        text: long,
        time: 1_700_000_000_000 + i * 60_000,
      })),
    );
    const out = await recallOnce('猫粮', deps({ readWindow: async () => undefined }));
    expect(out.text.length).toBeLessThanOrEqual(3000);
    expect(out.text).toContain('已达返回体上限');
    const listed = (out.text.match(/她说过/g) ?? []).length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(out.hits); // 被丢的是整条，不是半句
  });

  it('单片段硬顶 600 字符', async () => {
    await seed([{ key: 's1:1-1', text: '猫' + '粮'.repeat(1200) }]);
    const out = await recallOnce('猫粮', deps());
    expect(out.text).not.toContain('粮'.repeat(601));
  });
});

describe('降级与失败语义（§9 测试 10）', () => {
  it('服务不可达 → 字面档照常可用，措辞写明只按字面找了，且不产生 ❌', async () => {
    await seed([{ key: 's1:1-1', text: '猫粮两百多一包' }]);
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED /home/anon'));
    const out = await recallOnce('猫粮', deps());
    expect(out.hits).toBe(1);
    expect(out.degraded).toBe(true);
    expect(out.text).toContain('只按字面匹配');
    expect(out.text).not.toContain('❌');
    expect(logs.join('\n')).not.toContain('ECONNREFUSED');
  });

  it('向量与文本条数对不上 → 语义档跳过，而不是拿错位向量算假分数', async () => {
    const row = toRow({ key: 's1:1-1', text: '猫粮两百多一包' });
    await appendRows(dir, [row], [oneHot(HOT)], { ...emptyMeta(), chunks: 1 });
    // 手写一行没有 key 的记录：loadIndex 的键集合认它不算数，文本行数却多一条 → 正是错位的形状
    writeFileSync(join(dir, 'chunks.jsonl'), `${JSON.stringify(row)}\n${JSON.stringify({ text: '没有键的一行' })}\n`);
    const out = await recallOnce('猫粮', deps());
    expect(out.degraded).toBe(true);
    expect(out.hits).toBe(1);
    expect(logs.some((line) => line.includes('code=VECTOR_MISMATCH'))).toBe(true);
  });

  it('deps 形状畸形也不把异常抛出去（那是 QQ 里的 ❌）', async () => {
    await seed([{ key: 's1:1-1', text: '猫粮两百多' }]);
    const out = await recallOnce('猫粮', deps({ limit: Number.NaN as unknown as number }));
    expect(typeof out.text).toBe('string');
    expect(out.text).toContain('没查到');
    expect(out.hits).toBe(0);
  });
});

describe('memorySwitch 运行时开关', () => {
  it('memorySwitch.on === false 时 execute 直接返固定措辞，不进索引', async () => {
    const { memorySwitch } = await import('./switch.ts');
    await seed([{ key: 's1:1-1', text: '猫粮两百多' }]);
    
    function ctxWithTools(): { ctx: Context; registered: Record<string, unknown>[] } {
      const registered: Record<string, unknown>[] = [];
      const ctx = {
        get: (name: string) =>
          name === 'tools' ? { register: (definition: unknown) => registered.push(definition as Record<string, unknown>) } : undefined,
      } as unknown as Context;
      return { ctx, registered };
    }
    
    const embed = { baseUrl: 'http://127.0.0.1:8765', timeoutMs: 2000, dims: EMBED_DIMS };
    const { ctx, registered } = ctxWithTools();
    const manager = {
      findByAgent: () => ({ scope: 'c2c', peerId: 'oA' }),
    } as unknown as SessionManager;
    
    registerRecallTool(ctx, manager, { dir, embed, logger });
    const execute = (registered[0]! as unknown as {
      execute: (args: unknown, exec: { signal: AbortSignal; agent?: unknown }) => Promise<{ text: string; hits: number }>;
    }).execute;
    const signal = new AbortController().signal;
    
    // 先确认开关是开的
    memorySwitch.on = true;
    const outOn = await execute({ query: '猫粮' }, { signal, agent: 'A' });
    expect(outOn.hits).toBe(1);
    
    // 关掉开关
    memorySwitch.on = false;
    const outOff = await execute({ query: '猫粮' }, { signal, agent: 'A' });
    expect(outOff.hits).toBe(0);
    expect(outOff.text).toContain('记忆库当前是关闭的');
    
    // 恢复开关状态
    memorySwitch.on = true;
  });
});

describe('工具注册形状', () => {
  function ctxWithTools(): { ctx: Context; registered: Record<string, unknown>[] } {
    const registered: Record<string, unknown>[] = [];
    const ctx = {
      get: (name: string) =>
        name === 'tools' ? { register: (definition: unknown) => registered.push(definition as Record<string, unknown>) } : undefined,
    } as unknown as Context;
    return { ctx, registered };
  }

  const embed = { baseUrl: 'http://127.0.0.1:8765', timeoutMs: 2000, dims: EMBED_DIMS };

  it('名字带 akane 前缀、参数只有 query 且必填、render 只出 text', () => {
    const { ctx, registered } = ctxWithTools();
    registerRecallTool(ctx, {} as SessionManager, { dir, embed, logger });
    expect(registered).toHaveLength(1);
    const def = registered[0]! as unknown as {
      name: string;
      parameters: { required: string[]; properties: Record<string, unknown> };
      output: { render: (a: unknown, v: unknown) => unknown };
    };
    expect(def.name).toBe(RECALL_TOOL_NAME);
    expect(def.parameters.required).toEqual(['query']);
    expect(Object.keys(def.parameters.properties)).toEqual(['query']);
    expect(def.output.render({}, { text: '甲', hits: 1, degraded: false })).toEqual([{ type: 'text', text: '甲' }]);
  });

  it('description 里写清「弱相似不算命中」和「不跨人共享」——她只看这一行', () => {
    const { ctx, registered } = ctxWithTools();
    registerRecallTool(ctx, {} as SessionManager, { dir, embed, logger });
    const description = String(registered[0]!.description);
    expect(description).toMatch(/weak similarity is NOT a hit/i);
    expect(description).toMatch(/Never shares memories of one person/i);
  });

  it('execute 按当前会话定归属；换个人就召不回；空 query 走固定措辞', async () => {
    await seed([{ key: 's1:1-1', text: '猫粮两百多' }]);
    const { ctx, registered } = ctxWithTools();
    const manager = {
      findByAgent: (agent: unknown) => (agent === 'A' ? { scope: 'c2c', peerId: 'oA' } : { scope: 'c2c', peerId: 'oB' }),
    } as unknown as SessionManager;
    registerRecallTool(ctx, manager, { dir, embed, logger });
    const execute = (registered[0]! as unknown as {
      execute: (args: unknown, exec: { signal: AbortSignal; agent?: unknown }) => Promise<{ text: string; hits: number }>;
    }).execute;
    const signal = new AbortController().signal;
    expect((await execute({ query: '猫粮' }, { signal, agent: 'A' })).hits).toBe(1);
    expect((await execute({ query: '猫粮' }, { signal, agent: 'B' })).hits).toBe(0);
    expect((await execute({ query: '   ' }, { signal, agent: 'A' })).text).toContain('换一种说法');
    expect((await execute({}, { signal, agent: 'A' })).text).toContain('换一种说法');
  });

  it('tools 服务不可用 → 只 warn，不影响插件启动', () => {
    expect(() => registerRecallTool({ get: () => undefined } as unknown as Context, {} as SessionManager, { dir, embed, logger })).not.toThrow();
    expect(logs.some((line) => line.includes('未注册'))).toBe(true);
  });
});

/**
 * 离线评测口那条手工组合链必须与 `recallOnce` 那条**是同一条链**。
 *
 * `scripts/akane-recall-eval.mjs` 不走 recallOnce（它要的是被 floor 滤掉的榜下行，
 * recallOnce 结构上看不见），而是自己串 `vectorRanked → buildLists → selectCandidates`。
 * 那条串法一旦和现网分叉，采出来的「改前/改后位次」就全是假的 —— 这组断言是唯一的防线。
 */
describe('评测口的手工链 = recallOnce 的链（§6 第 1 条的地基）', () => {
  /** 第 HOT 维放一个值：查询向量是 HOT 位为 1 的 one-hot，点积就等于这个值 */
  function seedGraded(items: Array<{ key: string; text: string; time: number; score: number }>): Promise<void> {
    const rows = items.map((item) => toRow(item));
    const vectors = rows.map((_, i) => {
      const v = new Array<number>(EMBED_DIMS).fill(0);
      v[HOT] = items[i]!.score;
      return v;
    });
    return appendRows(dir, rows, vectors, { ...emptyMeta(), chunks: rows.length });
  }

  const GRADED = [
    { key: 's1:1-1', text: '猫粮太贵了', time: 1_700_000_000_000, score: 0.9 },
    { key: 's1:2-2', text: '猫粮一包两百多', time: 1_700_000_001_000, score: 0.8 },
    { key: 's1:3-3', text: '换个牌子的猫粮试试', time: 1_700_000_002_000, score: 0.7 },
    { key: 's1:4-4', text: '今天加班到十点', time: 1_700_000_003_000, score: 0.6 },
    { key: 's1:5-5', text: '猫粮买过了', time: 1_700_000_004_000, score: 0.5 },
    { key: 's1:6-6', text: '龙猫好看吗', time: 1_700_000_005_000, score: 0.45 },
  ];

  /** 复刻 recallInner 的那三步（改这里必须同时改 recall-tool.ts，否则这条守卫就该红） */
  async function manualChain(query: string, arm: { floor: number; poolFactor: number; rrfK: number; limit: number }) {
    const rows = await readChunkRows(dir);
    const scoped: ChunkRow[] = [];
    const positions: number[] = [];
    rows.forEach((row, index) => {
      if (samePeer(row.peer, PEER_A)) {
        scoped.push(row);
        positions.push(index);
      }
    });
    const vectors = await readVectors(dir, rows.length);
    if (vectors === undefined) throw new Error('向量与文本没对齐');
    const queryVector = Float32Array.from(oneHot(HOT));
    const vectorKeys = vectorRanked(
      scoped,
      positions.map((index) => vectors[index]),
      queryVector,
      arm.limit * arm.poolFactor,
      arm.floor,
    );
    const literalKeys = scoped
      .filter((row) => matchesLiteral(row.text, queryTokens(query)))
      .sort((a, b) => b.time - a.time)
      .map((row) => row.key);
    return selectCandidates(scoped, buildLists({ literalKeys, vectorKeys }), arm.limit, { rrfK: arm.rrfK });
  }

  /** 返回体里带相似度的那几条，顺序即候选顺序 */
  function simsInBody(text: string): string[] {
    return [...text.matchAll(/相似度 ([\d.]+)/g)].map((match) => match[1]!);
  }

  it('默认配置下两条链给出同一批片段、同一顺序', async () => {
    await seedGraded(GRADED);
    const arm = { floor: VECTOR_SIM_FLOOR, poolFactor: VECTOR_POOL_FACTOR, rrfK: RRF_K, limit: 6 };
    const out = await recallOnce('猫粮', deps());
    const manual = await manualChain('猫粮', arm);
    expect(out.hits).toBe(manual.length);
    expect(simsInBody(out.text)).toEqual(
      manual.filter((c) => c.vectorScore !== undefined).map((c) => c.vectorScore!.toFixed(3)),
    );
  });

  it('四个旋钮从 recallOnce 注入的值，与手工链同值传入时结果仍一致', async () => {
    await seedGraded(GRADED);
    for (const arm of [
      { floor: 0.7, poolFactor: VECTOR_POOL_FACTOR, rrfK: RRF_K, limit: 6 },
      { floor: 0.45, poolFactor: Infinity, rrfK: RRF_K, limit: 6 },
      { floor: 0.45, poolFactor: VECTOR_POOL_FACTOR, rrfK: 0, limit: 6 },
      { floor: 0.5, poolFactor: 1, rrfK: 20, limit: 3 },
    ]) {
      const out = await recallOnce('猫粮', deps({ limit: arm.limit, floor: arm.floor, poolFactor: arm.poolFactor, rrfK: arm.rrfK }));
      const manual = await manualChain('猫粮', arm);
      expect(out.hits, `臂 ${JSON.stringify(arm)}`).toBe(manual.length);
      expect(simsInBody(out.text), `臂 ${JSON.stringify(arm)}`).toEqual(
        manual.filter((c) => c.vectorScore !== undefined).map((c) => c.vectorScore!.toFixed(3)),
      );
    }
  });

  it('池宽倍数为 Infinity 就是不限（评测口靠这个值看榜下）', async () => {
    await seedGraded(GRADED);
    const rows = await readChunkRows(dir);
    const vectors = await readVectors(dir, rows.length);
    const ranked = vectorRanked(rows, vectors, Float32Array.from(oneHot(HOT)), 6 * Infinity, -Infinity);
    expect(ranked).toHaveLength(rows.length);
  });
});
