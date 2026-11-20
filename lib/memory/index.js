import { probeEmbedHealth } from "./embed-client.js";
import { startMemorySync } from "./backfill.js";
import { INDEX_ROOT } from "./index-store.js";
import { peerKeyOfSessionRecord, UNKNOWN_PEER_KEY } from "./peer.js";
import { registerRecallTool } from "./recall-tool.js";
import { memorySwitch } from "./switch.js";
/** 能力日志的唯一措辞（§7 P0 验收第 2 条与 P1 验收第 6 条都核这两串） */
export const EMBED_CAPABILITY_UP = 'embedding(可用)';
export const EMBED_CAPABILITY_DOWN = 'embedding(不可达，已降级字面档)';
export function startMemoryFeature(opts) {
    const { ctx, config, manager, logger, agentCwd } = opts;
    memorySwitch.on = config.memory.enabled; // 每次挂载都写，跨 fiber 生效（运行时判读这个共享状态）
    if (!config.memory.enabled)
        return;
    const embed = embedConfigOf(config.memory);
    const dir = INDEX_ROOT;
    // 探测只影响日志与「这一轮要不要跑回填」，不阻塞启动，也不阻塞她的回复
    const probe = () => probeEmbedHealth(embed).then((outcome) => outcome.ok, () => false);
    void probe().then((up) => {
        logger.info(`im-qqbot-akane: ${up ? EMBED_CAPABILITY_UP : EMBED_CAPABILITY_DOWN}`);
    });
    registerRecallTool(ctx, manager, {
        dir,
        embed,
        logger,
    });
    const stop = startMemorySync({
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
    }, config.memory.syncIntervalMs);
    ctx
        .effect(() => stop);
}
/** 配置 → 客户端形状；维度以配置为准（与 meta.json 不符时由索引侧判脏重建） */
export function embedConfigOf(memory) {
    return {
        baseUrl: memory.embedBaseUrl,
        timeoutMs: memory.timeoutMs,
        dims: memory.dims,
    };
}
//# sourceMappingURL=index.js.map