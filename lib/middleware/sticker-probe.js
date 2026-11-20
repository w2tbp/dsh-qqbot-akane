/**
 * 每轮配图观测 —— 只观测，不参与任何判定
 *
 * `stickerLevel` 四档到底有没有改变她的行为，靠翻录像是量不出来的：present 声明的图里
 * 混着 `ark-images/` 那类非梗图产物，而「这一轮她到底配没配图」在转录里要人肉解析。
 * 所以在轮末落一条只有计数的记录，让档位对比能用 `scripts/sticker-turn-report.mjs` 出数。
 *
 * 红线形状：一条记录只有 接收毫秒 + scope + 图片计数 + 生效档位。
 * **路径、正文、openid 一个都不写**，所以这份落盘不需要脱敏环节。
 *
 * 关闭态（`stickerProbe.enabled` 不为 true）`createStickerProbe` 返回 `undefined`：
 * 不写一行、不起清理定时器、目录都不会被创建。
 */
import { extname, join, resolve } from 'node:path';
import { PLUGIN_HOME, resolveAgentCwd } from "../shared/dirs.js";
import { IMAGE_EXTS } from "../media/send-media.js";
import { ProbeSink, startProbeCleanup } from "./arrival-probe.js";
/** 观测落盘根目录（按天一个 jsonl） */
export const STICKER_PROBE_ROOT = resolve(PLUGIN_HOME, 'sticker-turns');
/** 按扩展名认图片（与出站判定共用 IMAGE_EXTS，别在这里另起一张表） */
function isImage(path) {
    return IMAGE_EXTS.has(extname(path).toLowerCase());
}
/**
 * 创建观测写入器。关闭态返回 `undefined` —— 调用方据此一个字都不写。
 * @param root 测试注入临时目录用
 */
export function createStickerProbe(config, logger, root = STICKER_PROBE_ROOT) {
    if (config.stickerProbe?.enabled !== true)
        return undefined;
    const sink = new ProbeSink(root, logger, 'sticker');
    // 图库目录按她的 cwd 现算，只用来判「这张图是不是从梗图库来的」，绝不落进记录。
    // join(dir, '') 是为了拿到平台正确的尾分隔符（Windows 上不是 '/'）
    const galleryPrefix = join(resolveAgentCwd(config.cwd), 'stickers', '');
    const level = config.stickerLevel ?? 'normal';
    return {
        writeTurn(scope, files) {
            let images = 0;
            let gallery = 0;
            for (const file of files) {
                const path = resolve(file.path);
                if (!isImage(path))
                    continue;
                images += 1;
                if (path.startsWith(galleryPrefix))
                    gallery += 1;
            }
            sink.write({ t: Date.now(), s: scope === 'group' ? 'g' : 'c', i: images, k: gallery, l: level });
        },
        flush: () => sink.flush(),
    };
}
/** 启动观测文件清理：与 arrivalProbe 同档，插件卸载时自动 clearInterval */
export function startStickerProbeCleanup(ctx, config, logger) {
    if (config.stickerProbe?.enabled !== true)
        return;
    startProbeCleanup(ctx, config.stickerProbe.keepDays ?? 30, logger, STICKER_PROBE_ROOT, 'sticker');
}
//# sourceMappingURL=sticker-probe.js.map