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
/** 包根目录：src/persona.ts 与 lib/persona.js 都指向项目根 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cache = new Map();
/** 展开 `~`，相对路径落到包根目录 */
export function resolvePersonaPath(raw) {
    const value = (raw ?? '').trim();
    if (!value)
        return '';
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
function readCached(path) {
    let stat;
    try {
        stat = statSync(path);
    }
    catch {
        cache.delete(path);
        return '';
    }
    if (!stat.isFile())
        return '';
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size)
        return hit.text;
    let text = '';
    try {
        text = readFileSync(path, 'utf8').trim();
    }
    catch {
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
export function readLessons(dirRaw) {
    const dir = resolvePersonaPath(dirRaw);
    if (!dir || !existsSync(dir))
        return '';
    let names;
    try {
        names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
    }
    catch {
        return '';
    }
    const blocks = [];
    for (const name of names) {
        const text = readCached(resolve(dir, name));
        if (!text)
            continue;
        blocks.push(`### ${name.replace(/\.md$/, '')}\n${text}`);
    }
    return blocks.join('\n\n');
}
/** 组装当前会话的 persona 文本；全未配置时返回空串 = 行为与 0.5.5 一致 */
export function buildPersona(scope, config) {
    // 人格总开关：=== false 时三个 persona 文件、lessons、legacy prompt 全都不进 system prompt
    // —— 她变成宿主的通用助手。用 === false 而非 !，避免缺省键意外关闭人格。
    if (config.personaEnabled === false)
        return '';
    const primary = readCached(resolvePersonaPath(scope === 'group' ? config.personaGroupFile : config.personaDirectFile));
    const lessons = readLessons(config.personaLessonsDir);
    const legacy = scope === 'group' ? config.groupPrompt : config.directPrompt;
    const text = [primary, lessons, legacy]
        .map((part) => (part ?? '').trim())
        .filter((part) => part.length > 0)
        .join('\n\n');
    // 梗图软关：stickersEnabled === false 时按行剥掉含 `akane-sticker` 的行（persona 文件
    // 里那句「手里有梗图库」的提示）。不改 persona 文件本身（红线：措辞一改即改现网说话方式）。
    if (config.stickersEnabled === false && text.includes('akane-sticker')) {
        return text.split('\n').filter((line) => !line.includes('akane-sticker')).join('\n').trim();
    }
    return text;
}
/** 供测试与排障：清空 mtime 缓存 */
export function resetPersonaCache() {
    cache.clear();
}
//# sourceMappingURL=persona.js.map