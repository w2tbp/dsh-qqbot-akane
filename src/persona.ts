/**
 * persona 文件加载（R3）
 *
 * 人格文本随插件走版本控制，配置里只存路径。每次组装 prompt 都按 mtime+size
 * 探一次：文件没动就复用缓存，动了立刻重读 —— 改人格不重启进程。
 *
 * 路径解析规则：`~` 展开；相对路径按插件包根目录解析（pnpm link 安装下宿主 cwd
 * 与包位置无关，只有包根目录是稳定的）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STICKER_LEVELS } from './config.ts';
import type { ImQQBotConfig, StickerLevel } from './config.ts';

/** 包根目录：src/persona.ts 与 lib/persona.js 都指向项目根 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface CachedFile {
  mtimeMs: number;
  size: number;
  text: string;
}

const cache = new Map<string, CachedFile>();

/** 展开 `~`，相对路径落到包根目录 */
export function resolvePersonaPath(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(homedir(), value.slice(1).replace(/^[\\/]/, ''));
  }
  return resolve(PACKAGE_ROOT, value);
}

/**
 * 读单个文件；缺失、目录、空内容一律返回空串。
 *
 * stat 每次调用都做（约几十微秒），换来的是「外部编辑器保存即生效」。
 */
function readCached(path: string): string {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    cache.delete(path);
    return '';
  }
  if (!stat.isFile()) return '';
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;
  let text = '';
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    text = '';
  }
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, text });
  return text;
}

/**
 * 课程记忆目录：按文件名排序拼接，每条带上文件名（不含扩展名）作小标题。
 *
 * 单条读取失败只跳过该条 —— 一个坏文件不该让整个 persona 通道失效。
 */
export function readLessons(dirRaw: string | undefined): string {
  const dir = resolvePersonaPath(dirRaw);
  if (!dir || !existsSync(dir)) return '';
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
  } catch {
    return '';
  }
  const blocks: string[] = [];
  for (const name of names) {
    const text = readCached(resolve(dir, name));
    if (!text) continue;
    blocks.push(`### ${name.replace(/\.md$/, '')}\n${text}`);
  }
  return blocks.join('\n\n');
}

/** persona 里那句梗图提示行的锚点：token 在，档位才替换得动（persona.test 与真实 md 互钉一次） */
export const STICKER_ANCHOR = 'akane-sticker';

/** 档位文案正本：与 persona 文件同一套 mtime 热加载，改文案存盘即生效 */
const STICKER_LEVELS_FILE = resolve(PACKAGE_ROOT, 'persona', 'sticker-levels.md');

type StickerBlocks = Partial<Record<StickerLevel, string>>;

/**
 * 解析 `## <档>` 分节文案。小节名不在四档之内就忽略 ——
 * 文案文件写错不该改变档位结果，最差退化成「该行原样保留」。
 */
export function parseStickerLevels(text: string): StickerBlocks {
  const blocks: StickerBlocks = {};
  const lines: string[] = [];
  let current: StickerLevel | undefined;
  const flush = (): void => {
    if (current !== undefined) blocks[current] = lines.join('\n').trim();
  };
  for (const line of text.split('\n')) {
    const heading = /^##\s+(\S+)\s*$/.exec(line);
    if (heading) {
      flush();
      lines.length = 0;
      const name = heading[1] ?? '';
      current = (STICKER_LEVELS as readonly string[]).includes(name) ? (name as StickerLevel) : undefined;
      continue;
    }
    if (current !== undefined) lines.push(line);
  }
  flush();
  return blocks;
}

export function readStickerLevels(): StickerBlocks {
  return parseStickerLevels(readCached(STICKER_LEVELS_FILE));
}

/**
 * 按档位改写 persona 里含锚点的那一行：
 * - `normal`：**恒等**，连锚点都不扫（默认档，现网行为零变化）
 * - `off`：删掉锚点行（早期 `stickersEnabled` 布尔软关的语义）
 * - `quiet` / `active`：把锚点行原地替换为该档文案（文案可多行，替换后行数照变）
 *
 * 锚点行不存在、或该档没写文案 ⇒ 原样返回：宁可这一档没效果，也不凭空造一句人格。
 * 纯函数，无 IO —— 供表驱动测试直接喂 blocks。
 */
export function applyStickerLevel(text: string, level: StickerLevel, blocks: StickerBlocks): string {
  if (level === 'normal' || !text.includes(STICKER_ANCHOR)) return text;
  if (level === 'off') return text.split('\n').filter((line) => !line.includes(STICKER_ANCHOR)).join('\n').trim();
  const block = blocks[level];
  if (!block) return text;
  const replacement = block.split('\n');
  return text
    .split('\n')
    .flatMap((line) => (line.includes(STICKER_ANCHOR) ? replacement : [line]))
    .join('\n')
    .trim();
}

/** 组装当前会话的 persona 文本；全未配置时返回空串 = 行为与 0.5.5 一致 */
export function buildPersona(scope: 'group' | 'c2c', config: ImQQBotConfig): string {
  // 人格总开关：=== false 时三个 persona 文件、lessons、legacy prompt 全都不进 system prompt
  // —— 她变成宿主的通用助手。用 === false 而非 !，避免缺省键意外关闭人格。
  if (config.personaEnabled === false) return '';

  const primary = readCached(
    resolvePersonaPath(scope === 'group' ? config.personaGroupFile : config.personaDirectFile),
  );
  const lessons = readLessons(config.personaLessonsDir);
  const legacy = scope === 'group' ? config.groupPrompt : config.directPrompt;
  const text = [primary, lessons, legacy]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join('\n\n');

  // 梗图积极度：按档位改写 persona 里那句含 `akane-sticker` 的常驻提示行。
  // 不改 persona 文件本身（红线：措辞一改即改现网说话方式），文案在 sticker-levels.md。
  // 私聊 persona 今天没有这一行 ⇒ 四档对私聊自动全是恒等，不往 c2c 凭空塞梗图指令。
  return applyStickerLevel(text, config.stickerLevel ?? 'normal', readStickerLevels());
}

/** 供测试与排障：清空 mtime 缓存 */
export function resetPersonaCache(): void {
  cache.clear();
}