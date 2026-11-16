/**
 * fork 挂载点守卫
 *
 * fork 的能力全部靠「改动上游文件里的某几行」挂上去，而这些改动所在的文件上游也在改。
 * 合并时最坏的故障不是冲突解不完，而是**顺手取了上游那半边**：fork 模块自己的单测照样绿，
 * 但线上钩子已经没了。这里逐个断言钩子仍在位、顺序仍正确，让这类丢失在 `pnpm test` 就红。
 *
 * 断言写在源码文本上（不是行为上），所以它是「结构是否还在」的 tripwire：
 * 真要重构掉某个落点，就同时改这张表和落点代码，别只改一边。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 包根目录：src/fork-guard.test.ts 与 lib/fork-guard.js 都指向项目根 */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8');

interface ForkPoint {
  file: string;
  /** 这个落点为什么存在（丢了会坏在哪） */
  why: string;
  /** 必须出现的片段 */
  must: RegExp[];
  /** 必须不出现的片段（上游把它改回来 / 被合并吃掉 的常见形状） */
  mustNot?: RegExp[];
  /** 顺序断言：前者的位置必须早于后者 */
  before?: [RegExp, RegExp];
}

const POINTS: ForkPoint[] = [
  {
    file: 'src/gateway/middleware-setup.ts',
    why: '群历史带附件：SDK 的 historyBuffer 条目只有文本位，换掉它才装得下图片',
    must: [/import \{ akaneHistoryBuffer \} from '\.\.\/middleware\/history-buffer\.ts'/, /bot\.use\(akaneHistoryBuffer\(\{/, /ledger: getMediaLedger\(\)/],
    mustNot: [/^\s*historyBuffer,\s*$/m],
    before: [/bot\.use\(akaneHistoryBuffer/, /bot\.use\(mentionGate/],
  },
  {
    file: 'src/gateway/middleware-setup.ts',
    why: 'R1/R2 隐式唤醒：靠往 mentionGate 注 isImplicitMention 实现，词表全空时不注入',
    must: [/import \{ createWaker \} from '\.\.\/wake\.ts'/, /const waker = createWaker\(\{/, /isImplicitMention: \(ctx: MiddlewareContext\) => waker\(ctx\.message\)/],
  },
  {
    file: 'src/gateway/middleware-setup.ts',
    why: 'R4 黑名单：group scope 的字符串对象是 groupOpenid，必须函数 matcher 才按人屏蔽',
    must: [/bot\.use\(accessPolicy\(buildAccessPolicy\(config, logger\)\)\)/, /groupDeny\.includes\(ctx\.message\.senderId\)/, /deny: access\.c2cDeny \?\? \[\]/],
  },
  {
    file: 'src/session/session-manager.ts',
    why: 'R3 persona：人格文本注入 prompt 的唯一入口',
    must: [/import \{ buildPersona \} from '\.\.\/persona\.ts'/, /insertPersonaSection\(assembled, text\)/],
  },
  {
    file: 'src/transport/inbound.ts',
    why: 'R2：隐式唤醒（非显式 @）也算被唤起，三处判断都得换成 awakened',
    must: [/const awakened = wasMentioned \|\| \(state\.mention\?\.implicit \?\? false\)/, /buildAgentBody\(base, state\.history, isGroup, awakened\)/],
  },
  {
    file: 'src/client/config-panel.ts',
    why: '三张唤醒词表进设置页，词表以界面为正本',
    must: [/WAKE_LIST_KEYS = \['wakeWords', 'wakeWordsWeak', 'wakeWordExcludes'\]/, /群聊唤醒词/],
  },
  {
    file: 'src/index.ts',
    why: '插件身份与官方隔离，同 id 会互相顶掉',
    must: [/export const name = 'im-qqbot-akane'/],
  },
];

/** fork 配置字段：类型声明与 Schema 各一次，少一边就是合并吃掉了一边 */
const CONFIG_FIELDS = [
  'wakeWords', 'wakeWordsWeak', 'wakeWordExcludes',
  'c2cDeny', 'groupDeny',
  'personaGroupFile', 'personaDirectFile', 'personaLessonsDir',
];

/** 构建产物入库是刻意的（GitHub 安装开箱即用），这几条防「改了 src 忘了 build」 */
const BUILT: Array<[string, RegExp]> = [
  ['lib/wake.js', /createWaker/],
  ['lib/persona.js', /buildPersona/],
  ['lib/persona-section.js', /insertPersonaSection/],
  ['lib/middleware/history-buffer.js', /akaneHistoryBuffer/],
  ['lib/features/media-ledger.js', /getMediaLedger/],
  ['lib/gateway/middleware-setup.js', /akaneHistoryBuffer/],
  ['lib/session/session-manager.js', /insertPersonaSection/],
  ['lib/client.js', /wakeWords/],
];

/** 身份残留：漏一处就与原版同名顶掉，历史上真坏过（回滚文件后缀那次） */
const IDENTITY_RESIDUE: Array<{ re: RegExp; why: string; skipTests?: boolean }> = [
  { re: /["'`]im-qqbot(?!-akane)/, why: 'im-qqbot 未带 -akane 后缀' },
  { re: /["'`]qqbot_/, why: 'qqbot_ 前缀（fork 应统一 akane_）' },
  { re: /["'`]\.dsh-qqbot["'`]/, why: '原版数据目录 .dsh-qqbot' },
  // 原版包名只在看生产代码时才是残留；测试里的同名临时目录是 fixture
  { re: /["'`]dsh-qqbot["'`]/, why: '原版包名 dsh-qqbot', skipTests: true },
  { re: /from ['"`][^'"`]*@tencent-connect\/dsh-qqbot/, why: '不应 import 官方插件包' },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 只看代码行：注释里提到原版名字是正当的 */
function codeLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

describe('fork 挂载点守卫', () => {
  for (const point of POINTS) {
    it(`${point.file} :: ${point.why}`, () => {
      const text = read(point.file);
      for (const re of point.must) expect(text, `缺少 ${re}`).toMatch(re);
      for (const re of point.mustNot ?? []) expect(text, `不该出现 ${re}`).not.toMatch(re);
      if (point.before) {
        const [a, b] = point.before.map((re) => text.search(re));
        expect(a, '前者未找到').toBeGreaterThanOrEqual(0);
        expect(b, '后者未找到').toBeGreaterThanOrEqual(0);
        expect(a, '落点顺序被改动了').toBeLessThan(b);
      }
    });
  }

  it('src/config.ts 声明了全部 fork 字段（类型 + Schema 各一次）', () => {
    const text = read('src/config.ts');
    for (const field of CONFIG_FIELDS) {
      const declared = [...text.matchAll(new RegExp(`^\\s*${field}[?:]`, 'gm'))].length;
      expect(declared, `${field} 声明次数`).toBeGreaterThanOrEqual(2);
    }
  });

  it('lib/ 构建产物与 fork 源码同步', () => {
    for (const [file, signal] of BUILT) {
      expect(existsSync(resolve(ROOT, file)), `缺产物 ${file}（跑 pnpm build）`).toBe(true);
      expect(read(file), `${file} 落后于 src（跑 pnpm build）`).toMatch(signal);
    }
  });

  it('src 里没有原版身份残留', () => {
    for (const { re, why, skipTests } of IDENTITY_RESIDUE) {
      const hits: string[] = [];
      const files = listSourceFiles(resolve(ROOT, 'src'))
        // 本文件是这些 pattern 的正本，扫自己必然命中
        .filter((f) => !f.endsWith('fork-guard.test.ts') && !(skipTests && f.endsWith('.test.ts')));
      for (const file of files) {
        const matches = codeLines(readFileSync(file, 'utf8')).match(re);
        if (matches) hits.push(`${file.replace(ROOT + '/', '')}: ${matches.length}`);
      }
      expect(hits, `身份残留（${why}）`).toEqual([]);
    }
  });

  it('唤醒词表没有写死进代码', () => {
    const text = codeLines(read('src/wake.ts'));
    expect(text).not.toMatch(/['"`](猫娘|茜茜|茜|akane)['"`]/);
  });
});
