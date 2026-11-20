/**
 * 到达间隔插桩 —— 只观测，不参与任何判定
 *
 * QQ 把一句话拆成几条发，碎片之间到底隔多久**没有现成数据**，而静默窗口的默认值
 * 必须从这个数据里长出来（spec §5 D2：先插桩 → 量 p90/p95 → 再定 T）。
 * 在拿到样本之前，`quietWindowMs` 在代码里只以配置项存在，不许写任何猜测数字。
 *
 * 红线形状：一条记录只有 `messageId` + 本地接收毫秒 + 桶键散列 + 有没有被唤醒。
 * **正文、openid 明文、宿主路径一个都不写**，所以这份落盘不需要脱敏环节。
 *
 * 关闭态（`arrivalProbe.enabled = false`）不挂载本中间件、不起清理定时器，
 * 因此目录都不会被创建 —— 零写入、零定时器、零目录。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PLUGIN_HOME } from "../shared/dirs.js";
/** 插桩落盘根目录（按天一个 jsonl） */
export const PROBE_ROOT = resolve(PLUGIN_HOME, 'arrival');
/** 清理间隔，与富媒体清理同档 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** 桶键散列：与静默窗口同一个键空间，只留 8 位十六进制（够分桶，不含 openid） */
export function bucketHash(key) {
    return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
/** 本地日期文件名（与统计口径一致：一天一个文件，清理按文件粒度） */
export function dayName(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
}
/**
 * 单个根目录的写入器（所有插桩通路共用：到达间隔、每轮配图……）。
 * 状态挂在实例上而不是模块级：热重载不重建模块，模块级状态会跨重载存活并串起两份配置。
 */
export class ProbeSink {
    root;
    logger;
    label;
    dirReady = false;
    warned = false;
    queue = Promise.resolve();
    /** `label` 只进日志文案，用来区分是哪一路插桩在报警 */
    constructor(root, logger, label = 'arrival') {
        this.root = root;
        this.logger = logger;
        this.label = label;
    }
    /**
     * 追加一条记录，fire-and-forget —— 观测不许拖慢消息链，
     * 也不许因为磁盘故障把她的回复带下水。串行排队保证一行一条，不出现交错。
     */
    write(record) {
        const line = `${JSON.stringify(record)}\n`;
        this.queue = this.queue.then(async () => {
            if (!this.dirReady) {
                await mkdir(this.root, { recursive: true });
                this.dirReady = true;
            }
            await appendFile(join(this.root, dayName(record.t)), line, 'utf8');
        }).catch((err) => {
            if (!this.warned) {
                this.warned = true;
                this.logger.warn(`im-qqbot-akane: ${this.label} probe write failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
    }
    /** 等所有在飞的写入落盘（测试与关停路径用） */
    flush() {
        return this.queue;
    }
}
export function akaneArrivalProbe(deps) {
    const sink = deps.sink ?? new ProbeSink(PROBE_ROOT, deps.logger);
    return async (ctx, next) => {
        const scope = ctx.replyTarget?.scope ?? ctx.message.kind;
        const targetId = ctx.replyTarget?.targetId ?? ctx.message.groupOpenid ?? ctx.message.senderId;
        sink.write({
            t: Date.now(),
            k: bucketHash(`${scope}:${targetId}:${ctx.message.senderId}`),
            m: ctx.message.messageId ?? '',
            ...(deps.woke ? { w: deps.woke(ctx) ? 1 : 0 } : {}),
        });
        await next();
    };
}
/**
 * 删除过期插桩文件（按 mtime）。keepDays <= 0 = 永不过期（跳过）。
 * @returns 删除的文件数
 */
export async function cleanupExpiredProbeFiles(keepDays, logger, root = PROBE_ROOT, label = 'arrival') {
    if (keepDays <= 0)
        return 0;
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return 0; // 目录还没建（关闭态），不是错误
    }
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name);
    const results = await Promise.all(files.map(async (name) => {
        const path = join(root, name);
        try {
            const info = await stat(path);
            if (info.mtimeMs > cutoff)
                return false;
            await rm(path, { force: true });
            logger?.debug(`im-qqbot-akane: cleaned expired ${label} file: ${name}`);
            return true;
        }
        catch (err) {
            logger?.warn(`im-qqbot-akane: ${label} cleanup failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }));
    return results.filter(Boolean).length;
}
/** 启动插桩清理：挂载点与 startMediaCleanup 并列，插件卸载时自动 clearInterval */
export function startProbeCleanup(ctx, keepDays, logger, root = PROBE_ROOT, label = 'arrival') {
    if (keepDays <= 0)
        return;
    ctx
        .effect(() => {
        const timer = setInterval(() => {
            void cleanupExpiredProbeFiles(keepDays, logger, root, label)
                .then((n) => { if (n > 0)
                logger.info(`im-qqbot-akane: cleaned ${n} expired ${label} files`); })
                .catch((err) => logger.warn(`im-qqbot-akane: ${label} cleanup failed: ${err instanceof Error ? err.message : String(err)}`));
        }, CLEANUP_INTERVAL_MS);
        return async () => { clearInterval(timer); };
    }, `im-qqbot-akane.${label}-cleanup`);
}
//# sourceMappingURL=arrival-probe.js.map