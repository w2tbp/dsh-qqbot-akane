/**
 * 每轮配图统计 —— 「stickerLevel 到底有没有改变她的行为」的唯一数据来源
 *
 * 观测只落计数（见 `src/middleware/sticker-probe.ts`），把计数变成占比这一步单独放在这里，
 * 是为了让口径可被单元测试钉住：同一个旋钮每次重算换一个数字，那份数据就等于没有。
 *
 * 只算 `k`（落在梗图库下的张数），不拿 `i` 当分子 —— present 声明的图里混着 `ark-images/`
 * 那类非梗图产物，拿 `i` 会把占比虚高（现网 20 张 present 里 6 张不是梗图）。
 *
 * 私聊那一栏是**对照组**：档位只改写群 persona，c2c 的占比本该不随档位动。
 * 若 c2c 也跟着涨，说明涨的不是档位，是别的（她换了话题、或群里那批人换了）。
 */

/** 档位键：与 `src/config.ts` 的 STICKER_LEVELS 同集合。这里重述是为了让本模块不依赖 Schema 运行时 */
export type StickerTier = 'off' | 'quiet' | 'normal' | 'active';

/** 报告里固定按这个顺序出，不按数据出现顺序（否则同一份盘每次排出来的表不一样） */
export const TIER_ORDER: readonly StickerTier[] = ['off', 'quiet', 'normal', 'active'];

/** 一条每轮配图观测（与落盘的 JSONL 同形） */
export interface StickerTurnRecord {
  /** 轮末本地毫秒 */
  t: number;
  /** g = group，c = c2c */
  s: 'g' | 'c';
  /** 本轮 present 声明的图片张数（含非梗图） */
  i: number;
  /** 其中落在 workspace/stickers/ 下的张数 */
  k: number;
  /** 当时生效的档位 */
  l: StickerTier;
}

export interface StickerTierRow {
  level: StickerTier;
  /** 该档的轮次数 —— 分母 */
  turns: number;
  /** 其中配了梗图的轮次 —— 分子 */
  withGallery: number;
  /** withGallery / turns，turns 为 0 时给 0 */
  ratio: number;
  /** 该档累计发出的梗图张数（占比不动但绝对数会动，两个都得看） */
  galleryImages: number;
  /** 样本量够不够拿去比较档位，见 MIN_TURNS_FOR_DECISION */
  enough: boolean;
}

/**
 * 低于这个轮数不许拿占比比较档位：30 轮里多一张或少一张就挪 3.3 个百分点，
 * 比四档之间预期的差距还大。数字是算术不是观测 —— 攒到的量没到，就照实说「继续攒」。
 */
export const MIN_TURNS_FOR_DECISION = 30;

function row(level: StickerTier, records: StickerTurnRecord[]): StickerTierRow {
  const turns = records.length;
  const withGallery = records.filter((r) => r.k > 0).length;
  return {
    level,
    turns,
    withGallery,
    ratio: turns === 0 ? 0 : withGallery / turns,
    galleryImages: records.reduce((sum, r) => sum + r.k, 0),
    enough: turns >= MIN_TURNS_FOR_DECISION,
  };
}

/** 按档位分组出表；该档一条记录都没有就不占一行（不凭空造一个 0%） */
export function rowsByTier(records: StickerTurnRecord[]): StickerTierRow[] {
  return TIER_ORDER.map((level) => row(level, records.filter((r) => r.l === level))).filter((r) => r.turns > 0);
}

/** 群/私聊分开：档位只作用于群 persona，混在一张表里会被私聊那批轮次稀释 */
export function summarizeStickerTurns(records: StickerTurnRecord[]): { group: StickerTierRow[]; c2c: StickerTierRow[] } {
  return {
    group: rowsByTier(records.filter((r) => r.s === 'g')),
    c2c: rowsByTier(records.filter((r) => r.s === 'c')),
  };
}
