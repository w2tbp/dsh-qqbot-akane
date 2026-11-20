/**
 * 挂载点：关闭态零行为变化是验收项，不是愿望（§9 测试 7）
 *
 * 这一组用例把「enabled=false 时一个副作用都不许发生」钉成断言 —— 不建目录、
 * 不起作业、不注册工具、不打日志。其余用例只管拼线是否正确（窗口值同源同值、
 * 归属解析走 manager、能力日志那两串的措辞）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import type { MemoryConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';

const doubles = vi.hoisted(() => ({
  stop: vi.fn(),
  startMemorySync: vi.fn(() => doubles.stop),
  registerRecallTool: vi.fn(),
  probeEmbedHealth: vi.fn(async () => ({ ok: true as const, dims: 512, model: 'Xenova/bge-small-zh-v1.5' })),
  embedTexts: vi.fn(),
}));

vi.mock('./backfill.ts', () => ({ startMemorySync: doubles.startMemorySync }));
vi.mock('./recall-tool.ts', () => ({ registerRecallTool: doubles.registerRecallTool, RECALL_TOOL_NAME: 'akane_recall' }));
vi.mock('./embed-client.ts', () => ({ probeEmbedHealth: doubles.probeEmbedHealth, embedTexts: doubles.embedTexts }));

const { startMemoryFeature, embedConfigOf, EMBED_CAPABILITY_UP, EMBED_CAPABILITY_DOWN } = await import('./index.ts');

const CWD = '/home/anon/.dsh-qqbot-akane/workspace';

function memoryConfig(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    enabled: false,
    embedBaseUrl: 'http://127.0.0.1:8765',
    timeoutMs: 8000,
    dims: 512,
    syncIntervalMs: 600000,
    ...over,
  };
}

let lines: string[] = [];
const logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), debug: () => {} } as unknown as Logger;

function fakeCtx(): { ctx: Context; effects: (() => unknown)[] } {
  const effects: (() => unknown)[] = [];
  const ctx = {
    get: () => undefined,
    effect: (fn: () => unknown) => effects.push(fn),
  } as unknown as Context;
  return { ctx, effects };
}

function fakeManager(): SessionManager {
  return {
    peerOfSessionId: (id: string) => (id === 's-known' ? { scope: 'c2c', peerId: 'oA' } : undefined),
    findByAgent: () => undefined,
  } as unknown as SessionManager;
}

/** 探活日志是 `void promise.then` 发出去的，宏任务边界才是它落盘的时机 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  lines = [];
  doubles.stop.mockClear();
  doubles.startMemorySync.mockClear();
  doubles.registerRecallTool.mockClear();
  doubles.probeEmbedHealth.mockClear();
  doubles.probeEmbedHealth.mockResolvedValue({ ok: true, dims: 512, model: 'Xenova/bge-small-zh-v1.5' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('关闭态（默认）', () => {
  it('三个副作用一个都不发生，也不打日志', () => {
    const { ctx, effects } = fakeCtx();
    startMemoryFeature({ ctx, config: { memory: memoryConfig(), quietWindowMs: 12000 }, manager: fakeManager(), logger, agentCwd: CWD });
    expect(doubles.registerRecallTool).not.toHaveBeenCalled();
    expect(doubles.startMemorySync).not.toHaveBeenCalled();
    expect(doubles.probeEmbedHealth).not.toHaveBeenCalled();
    expect(effects).toHaveLength(0);
    expect(lines).toEqual([]);
  });

  it('enabled 缺省（配置没写这一段）也算关闭', () => {
    const { ctx } = fakeCtx();
    const config = { memory: { ...memoryConfig(), enabled: undefined as unknown as boolean }, quietWindowMs: 0 };
    startMemoryFeature({ ctx, config, manager: fakeManager(), logger, agentCwd: CWD });
    expect(doubles.startMemorySync).not.toHaveBeenCalled();
  });
});

describe('开启态：接线', () => {
  function start(over: Partial<MemoryConfig> = {}, quietWindowMs = 12000) {
    const { ctx, effects } = fakeCtx();
    startMemoryFeature({
      ctx,
      config: { memory: memoryConfig({ enabled: true, ...over }), quietWindowMs },
      manager: fakeManager(),
      logger,
      agentCwd: CWD,
    });
    return { ctx, effects };
  }

  it('工具与后台作业都挂上，窗口值与中间件同一个配置键（§1.4 同源同值）', () => {
    const { ctx } = start();
    expect(doubles.registerRecallTool).toHaveBeenCalledWith(ctx, expect.anything(), expect.objectContaining({ logger }));
    const deps = doubles.startMemorySync.mock.calls[0]![0] as { quietWindowMs: number; cwd: string };
    expect(deps.quietWindowMs).toBe(12000);
    expect(deps.cwd).toBe(CWD);
    expect(doubles.startMemorySync.mock.calls[0]![1]).toBe(600000);
  });

  it('窗口关着（0）时也照旧传 0 —— chunk 边界必须跟着折叠走，不许偷偷换个默认值', () => {
    start({}, 0);
    expect((doubles.startMemorySync.mock.calls[0]![0] as { quietWindowMs: number }).quietWindowMs).toBe(0);
  });

  it('归属解析走 manager：认得出的给真键，认不出的落 unknown（不做目录兜底）', () => {
    start();
    const resolvePeer = (doubles.startMemorySync.mock.calls[0]![0] as { resolvePeer: (id: string) => string }).resolvePeer;
    expect(resolvePeer('s-known')).toBe('c2c:oA');
    expect(resolvePeer('s-orphan')).toBe('unknown');
  });

  it('embed 客户端吃的是配置里那三个值', () => {
    start({ embedBaseUrl: 'http://127.0.0.1:9000', timeoutMs: 1234, dims: 384 });
    expect(embedConfigOf(memoryConfig({ embedBaseUrl: 'http://127.0.0.1:9000', timeoutMs: 1234, dims: 384 }))).toEqual({
      baseUrl: 'http://127.0.0.1:9000',
      timeoutMs: 1234,
      dims: 384,
    });
    expect((doubles.startMemorySync.mock.calls[0]![0] as { embed: { baseUrl: string } }).embed.baseUrl).toBe('http://127.0.0.1:9000');
  });

  it('能力日志只有那两串措辞，探活不阻塞挂载', async () => {
    start();
    expect(lines).toEqual([]); // 同步路径上一行都不打
    await tick();
    expect(lines).toEqual([`im-qqbot-akane: ${EMBED_CAPABILITY_UP}`]);

    lines = [];
    doubles.probeEmbedHealth.mockResolvedValue({ ok: false, code: 'UNREACHABLE' });
    start();
    await tick();
    expect(lines).toEqual([`im-qqbot-akane: ${EMBED_CAPABILITY_DOWN}`]);
  });

  it('插件卸载时停掉后台作业', () => {
    const { effects } = start();
    expect(effects).toHaveLength(1);
    const cleanup = effects[0]!() as () => void;
    cleanup();
    expect(doubles.stop).toHaveBeenCalledTimes(1);
  });

  it('probe 抛也当不可达（启停归用户，作业不去自愈）', async () => {
    doubles.probeEmbedHealth.mockRejectedValue(new Error('socket hang up'));
    start();
    const probe = (doubles.startMemorySync.mock.calls[0]![0] as { probe: () => Promise<boolean> }).probe;
    expect(await probe()).toBe(false);
  });
});

describe('memorySwitch 运行时开关', () => {
  it('startMemoryFeature 同步 memorySwitch.on 与 config.memory.enabled', async () => {
    const { memorySwitch } = await import('./switch.ts');
    const { ctx } = fakeCtx();
    
    // 开启时同步为 true
    startMemoryFeature({
      ctx,
      config: { memory: memoryConfig({ enabled: true }), quietWindowMs: 12000 },
      manager: fakeManager(),
      logger,
      agentCwd: CWD,
    });
    expect(memorySwitch.on).toBe(true);
    
    // 关闭时同步为 false
    startMemoryFeature({
      ctx,
      config: { memory: memoryConfig({ enabled: false }), quietWindowMs: 12000 },
      manager: fakeManager(),
      logger,
      agentCwd: CWD,
    });
    expect(memorySwitch.on).toBe(false);
  });
});
