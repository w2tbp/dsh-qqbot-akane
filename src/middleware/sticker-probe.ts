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
import type { Context } from '@deepseek-ai/cordis';
import { PLUGIN_HOME, resolveAgentCwd } from '../shared/dirs.ts';
import { IMAGE_EXTS } from '../media/send-media.ts';
import type { ImQQBotConfig, StickerLevel } from '../config.ts';
import type { ChatScope, Logger } from '../types.ts';
import type { PresentedFileRef } from '../transport/events.ts';
import { ProbeSink, startProbeCleanup } from './arrival-probe.ts';

/** 观测落盘根目录（按天一个 jsonl） */
export const STICKER_PROBE_ROOT = resolve(PLUGIN_HOME, 'sticker-turns');

/**
 * 一条 = 一个轮次结束。
 * `s` 群/私聊，`i` 本轮 present 声明的图片张数，`k` 其中落在图库目录下的张数，
 * `l` 当时生效的档位（分档对比就靠它）。
 */
export interface StickerTurnRecord {
  /** 本地接收毫秒 */
  t: number;
  /** g = group，c = c2c */
  s: 'g' | 'c';
  /** 本轮 present 声明的图片张数（含非梗图） */
  i: number;
  /** 其中落在 workspace/stickers/ 下的张数 —— 这个才是旋钮的量 */
  k: number;
  /** 生效的梗图积极度档位 */
  l: StickerLevel;
}

export interface StickerProbe {
  /** 轮末写一条（fire-and-forget，磁盘故障只 warn 一次，不碰她的回复） */
  writeTurn(scope: ChatScope, files: readonly PresentedFileRef[]): void;
  /** 等所有在飞写入落盘（测试与关停路径用） */
  flush(): Promise<void>;
}

/** 按扩展名认图片（与出站判定共用 IMAGE_EXTS，别在这里另起一张表） */
function isImage(path: string): boolean {
  return IMAGE_EXTS.has(extname(path).toLowerCase());
}

/**
 * 创建观测写入器。关闭态返回 `undefined` —— 调用方据此一个字都不写。
 * @param root 测试注入临时目录用
 */
export function createStickerProbe(
  config: ImQQBotConfig,
  logger: Logger,
  root: string = STICKER_PROBE_ROOT,
): StickerProbe | undefined {
  if (config.stickerProbe?.enabled !== true) return undefined;
  const sink = new ProbeSink<StickerTurnRecord>(root, logger, 'sticker');
  // 图库目录按她的 cwd 现算，只用来判「这张图是不是从梗图库来的」，绝不落进记录。
  // join(dir, '') 是为了拿到平台正确的尾分隔符（Windows 上不是 '/'）
  const galleryPrefix = join(resolveAgentCwd(config.cwd), 'stickers', '');
  const level: StickerLevel = config.stickerLevel ?? 'normal';
  return {
    writeTurn(scope, files) {
      let images = 0;
      let gallery = 0;
      for (const file of files) {
        const path = resolve(file.path);
        if (!isImage(path)) continue;
        images += 1;
        if (path.startsWith(galleryPrefix)) gallery += 1;
      }
      sink.write({ t: Date.now(), s: scope === 'group' ? 'g' : 'c', i: images, k: gallery, l: level });
    },
    flush: () => sink.flush(),
  };
}

/** 启动观测文件清理：与 arrivalProbe 同档，插件卸载时自动 clearInterval */
export function startStickerProbeCleanup(ctx: Context, config: ImQQBotConfig, logger: Logger): void {
  if (config.stickerProbe?.enabled !== true) return;
  startProbeCleanup(ctx, config.stickerProbe.keepDays ?? 30, logger, STICKER_PROBE_ROOT, 'sticker');
}
