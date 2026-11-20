/**
 * 记忆库挂载点 —— 五层里 T2 的全部对外接口都从这里开（§7 P0/P1）
 *
 * `memory.enabled=false`（默认）时本函数**第一件事都不做**：不建 `index/`、不起探测、
 * 不注册工具、不挂后台作业、不打日志。这是 §7 P0 验收第 3 条与 §9 测试 7 的正本，
 * 所有「关闭态零行为变化」都由这一行 `if (!enabled) return` 保证 —— 开启分支别在别处
 * 再判一次。
 *
 * **但运行时判必须有一道在 `execute()` 与 `tick()` 里读共享状态**（`switch.ts` 的
 * `memorySwitch`）：热重载只让新 fiber 不挂载，撤不掉旧 fiber 已注册的工具与后台作业，
 * 所以关掉必须当场生效（不依赖重启）。挂载判与运行时判是两回事：前者守「开启分支
 * 一处」，后者守「关闭态跨 fiber 立即停写停查」。
 *
 * 三条纪律落在各模块里，这里只负责拼：
 * - 常驻 embedding 服务的**启停归用户**（§5）：本模块不 spawn、不管道、不自愈、不 kill，
 *   只探活 + 打那一行能力日志。
 * - 后台作业不占回复延迟（§4）：它是 `setInterval`，不在中间件链里。
 * - 隐私边界 = 写入时落地的 `chunk.peer`（§5）：回填的 `resolvePeer` 只走
 *   `manager.peerOfSessionId`，解析不出就 `unknown`（永不可召回）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import type { MemoryConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import { probeEmbedHealth, type EmbedConfigLike } from './embed-client.ts';
import { startMemorySync } from './backfill.ts';
import { INDEX_ROOT } from './index-store.ts';
import { peerKeyOfSessionRecord, UNKNOWN_PEER_KEY } from './peer.ts';
import { registerRecallTool } from './recall-tool.ts';
import { memorySwitch } from './switch.ts';

/** 本模块需要的配置切片（整份 ImQQBotConfig 也满足这个形状） */
export interface MemoryFeatureConfig {
  memory: MemoryConfig;
  /** chunk 边界与静默窗口同源同值（§1.4） */
  quietWindowMs: number;
}

export interface MemoryFeatureOptions {
  ctx: Context;
  config: MemoryFeatureConfig;
  manager: SessionManager;
  logger: Logger;
  /**
   * 已解析的 agent cwd —— 只用于「哪些转录算她的」（回填遍历的索引选择），
   * **绝不参与召回过滤**：同 sessions 根下另有 11 份别人的转录（含用户本人开发对话）。
   */
  agentCwd: string;
}

/** 能力日志的唯一措辞（§7 P0 验收第 2 条与 P1 验收第 6 条都核这两串） */
export const EMBED_CAPABILITY_UP = 'embedding(可用)';
export const EMBED_CAPABILITY_DOWN = 'embedding(不可达，已降级字面档)';

export function startMemoryFeature(opts: MemoryFeatureOptions): void {
  const { ctx, config, manager, logger, agentCwd } = opts;
  memorySwitch.on = config.memory.enabled;   // 每次挂载都写，跨 fiber 生效（运行时判读这个共享状态）
  if (!config.memory.enabled) return;

  const embed = embedConfigOf(config.memory);
  const dir = INDEX_ROOT;

  // 探测只影响日志与「这一轮要不要跑回填」，不阻塞启动，也不阻塞她的回复
  const probe = () =>
    probeEmbedHealth(embed).then(
      (outcome) => outcome.ok,
      () => false,
    );
  void probe().then((up) => {
    logger.info(`im-qqbot-akane: ${up ? EMBED_CAPABILITY_UP : EMBED_CAPABILITY_DOWN}`);
  });

  registerRecallTool(ctx, manager, {
    dir,
    embed,
    logger,
  });

  const stop = startMemorySync(
    {
      ctx,
      logger,
      dir,
      cwd: agentCwd,
      quietWindowMs: config.quietWindowMs,
      embed,
      probe,
      resolvePeer: (sessionId) => {
        const ref = manager.peerOfSessionId(sessionId);
        return ref === undefined ? UNKNOWN_PEER_KEY : peerKeyOfSessionRecord(ref);
      },
    },
    config.memory.syncIntervalMs,
  );

  (ctx as unknown as { effect(fn: () => (() => void) | void, name?: string): void })
    .effect(() => stop);
}

/** 配置 → 客户端形状；维度以配置为准（与 meta.json 不符时由索引侧判脏重建） */
export function embedConfigOf(memory: MemoryConfig): EmbedConfigLike {
  return {
    baseUrl: memory.embedBaseUrl,
    timeoutMs: memory.timeoutMs,
    dims: memory.dims,
  };
}
