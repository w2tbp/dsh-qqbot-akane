import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyStickerLevel,
  buildPersona,
  parseStickerLevels,
  readLessons,
  readStickerLevels,
  resetPersonaCache,
  resolvePersonaPath,
  STICKER_ANCHOR,
} from './persona.ts';
import {
  PERSONA_PREFIX_SECTION,
  PERSONA_SECTION_NAME,
  escapeInterpolation,
  insertPersonaSection,
  type AssembledPrompt,
} from './persona-section.ts';
import type { ImQQBotConfig } from './config.ts';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'akane-persona-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  resetPersonaCache();
});

function config(overrides: Partial<ImQQBotConfig> = {}): ImQQBotConfig {
  return {
    personaGroupFile: '',
    personaDirectFile: '',
    personaLessonsDir: '',
    groupPrompt: undefined,
    directPrompt: undefined,
    ...overrides,
  } as unknown as ImQQBotConfig;
}

describe('persona 路径解析', () => {
  it('空配置 → 空串（功能关闭）', () => {
    expect(resolvePersonaPath('')).toBe('');
    expect(resolvePersonaPath(undefined)).toBe('');
    expect(resolvePersonaPath('   ')).toBe('');
  });

  it('~ 展开到宿主目录', () => {
    expect(resolvePersonaPath('~/persona/x.md')).toMatch(/\/persona\/x\.md$/);
    expect(resolvePersonaPath('~/persona/x.md').startsWith('~')).toBe(false);
  });

  it('相对路径按插件包根解析，而不是宿主 cwd', () => {
    const resolved = resolvePersonaPath('persona/akane-group.md');
    expect(resolved).toBe(resolve(process.cwd(), 'persona/akane-group.md'));
  });

  it('随包发布的 persona 文件真实存在', () => {
    expect(resolvePersonaPath('persona/akane-group.md')).toContain('akane-group.md');
  });
});

describe('persona 文件读取与热加载', () => {
  it('缺失文件 → 空串，不抛错', () => {
    expect(buildPersona('group', config({ personaGroupFile: join(root, 'nope.md') }))).toBe('');
  });

  it('空文件 → 空串', () => {
    const path = join(root, 'empty.md');
    writeFileSync(path, '   \n', 'utf8');
    expect(buildPersona('group', config({ personaGroupFile: path }))).toBe('');
  });

  it('改文件不重启进程就生效（mtime 变化即重读）', () => {
    const path = join(root, 'hot.md');
    writeFileSync(path, '第一版', 'utf8');
    const cfg = config({ personaGroupFile: path });
    expect(buildPersona('group', cfg)).toBe('第一版');
    writeFileSync(path, '第二版，长了不少', 'utf8');
    expect(buildPersona('group', cfg)).toBe('第二版，长了不少');
  });

  it('群聊与私聊各取各的文件', () => {
    const group = join(root, 'g.md');
    const direct = join(root, 'd.md');
    writeFileSync(group, '群聊版', 'utf8');
    writeFileSync(direct, '私聊版', 'utf8');
    const cfg = config({ personaGroupFile: group, personaDirectFile: direct });
    expect(buildPersona('group', cfg)).toBe('群聊版');
    expect(buildPersona('c2c', cfg)).toBe('私聊版');
  });
});

describe('lessons 目录', () => {
  const dir = () => join(root, 'lessons');

  beforeEach(() => {
    // 每条用例一个干净的目录，避免上一条写的 .md 混进这一条的拼接结果
    rmSync(dir(), { recursive: true, force: true });
    mkdirSync(dir(), { recursive: true });
  });

  it('按文件名排序拼接，带上小标题', () => {
    writeFileSync(join(dir(), '02-乙.md'), '第二条', 'utf8');
    writeFileSync(join(dir(), '01-甲.md'), '第一条', 'utf8');
    const text = readLessons(dir());
    expect(text.indexOf('### 01-甲')).toBeLessThan(text.indexOf('### 02-乙'));
    expect(text).toContain('第一条');
  });

  it('忽略非 .md 文件与空文件', () => {
    writeFileSync(join(dir(), 'a.md'), '内容', 'utf8');
    writeFileSync(join(dir(), 'skip.txt'), '忽略', 'utf8');
    writeFileSync(join(dir(), 'blank.md'), '  ', 'utf8');
    const text = readLessons(dir());
    expect(text).toContain('### a');
    expect(text).not.toContain('忽略');
    expect(text).not.toContain('blank');
  });

  it('目录不存在 → 空串', () => {
    expect(readLessons(join(root, 'missing-dir'))).toBe('');
    expect(readLessons('')).toBe('');
  });

  it('lessons 排在 persona 之后、遗留 prompt 之前', () => {
    const persona = join(root, 'p.md');
    writeFileSync(persona, '人格', 'utf8');
    writeFileSync(join(dir(), '01-l.md'), '课程', 'utf8');
    const text = buildPersona('group', config({ personaGroupFile: persona, personaLessonsDir: dir(), groupPrompt: '遗留' }));
    expect(text).toBe('人格\n\n### 01-l\n课程\n\n遗留');
  });

  it('遗留 groupPrompt 单独配置时仍然生效（后向兼容）', () => {
    expect(buildPersona('group', config({ groupPrompt: '老配置' }))).toBe('老配置');
    expect(buildPersona('c2c', config({ groupPrompt: '老配置' }))).toBe('');
  });
});

describe('persona section 落位（D3）', () => {
  const base: AssembledPrompt = {
    sections: [
      { name: 'harness:identity', text: 'A' },
      { name: PERSONA_PREFIX_SECTION, text: '部署人格' },
      { name: 'deployment:tools', text: 'B' },
      { name: 'app:web-surface', text: 'C' },
    ],
  };

  it('插到 deployment:persona-prefix 之后，而不是数组末尾', () => {
    const names = insertPersonaSection(base, '我是茜').sections!.map((s) => s.name);
    expect(names).toEqual([
      'harness:identity',
      PERSONA_PREFIX_SECTION,
      PERSONA_SECTION_NAME,
      'deployment:tools',
      'app:web-surface',
    ]);
  });

  it('锚点不存在时退回尾部追加，且不丢原有 sections', () => {
    const noAnchor: AssembledPrompt = { sections: [{ name: 'x', text: 'X' }] };
    const result = insertPersonaSection(noAnchor, '我是茜');
    expect(result.sections!.map((s) => s.name)).toEqual(['x', PERSONA_SECTION_NAME]);
  });

  it('不改动入参（waterfall 产物可能被复用）', () => {
    const snapshot = JSON.stringify(base);
    insertPersonaSection(base, '我是茜');
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('带上 interpolate:false，老宿主不认也不影响文本', () => {
    const section = insertPersonaSection(base, '原文').sections!.find((s) => s.name === PERSONA_SECTION_NAME);
    expect(section).toMatchObject({ interpolate: false, text: '原文' });
  });
});

describe('插值安全（{{var}} 会炸掉整次 prompt 构建）', () => {
  it('破坏 {{ 的相邻性', () => {
    expect(escapeInterpolation('')).toBe('');
    expect(escapeInterpolation('普通文本 { 花括号 } 原样')).toBe('普通文本 { 花括号 } 原样');
    expect(escapeInterpolation('{{char}}')).not.toMatch(/\{\{/);
  });

  it('转义后宿主不会再把它当变量解析', () => {
    const text = escapeInterpolation('示例 {{user}} 与 {{ unknown }}');
    expect(text).not.toContain('{{');
    expect(text.replace(/\u200B/g, '')).toBe('示例 {{user}} 与 {{ unknown }}');
  });

  it('注入路径上自动转义', () => {
    const section = insertPersonaSection({ sections: [] }, '模板写作 {{char}}').sections![0];
    expect(section.text).not.toContain('{{');
  });
});

describe('personaEnabled 总开关', () => {
  it('personaEnabled === false 时 buildPersona 返回空串', () => {
    const persona = join(root, 'p.md');
    writeFileSync(persona, '人格内容', 'utf8');
    const cfg = config({ personaGroupFile: persona, personaEnabled: false });
    expect(buildPersona('group', cfg)).toBe('');
  });

  it('personaEnabled === true 时正常注入', () => {
    const persona = join(root, 'p2.md');
    writeFileSync(persona, '人格内容', 'utf8');
    const cfg = config({ personaGroupFile: persona, personaEnabled: true });
    expect(buildPersona('group', cfg)).toBe('人格内容');
  });

  it('personaEnabled 未定义时默认开启（向后兼容）', () => {
    const persona = join(root, 'p3.md');
    writeFileSync(persona, '人格内容', 'utf8');
    const cfg = config({ personaGroupFile: persona });
    expect(buildPersona('group', cfg)).toBe('人格内容');
  });
});

describe('stickerLevel 四档改写', () => {
  const blocks = {
    quiet: '- 只在点名要图时才配（akane-sticker）',
    active: '- 默认配一张（akane-sticker）\n- 想到图或连着两轮纯文字，先读一遍索引再开口',
  };

  it('applyStickerLevel：normal 恒等，连锚点都不碰', () => {
    const text = '第一行\n你可以用 akane-sticker 发梗图\n第三行';
    expect(applyStickerLevel(text, 'normal', blocks)).toBe(text);
  });

  it('applyStickerLevel：off 删掉锚点行', () => {
    const text = '第一行\n你可以用 akane-sticker 发梗图\n第三行';
    expect(applyStickerLevel(text, 'off', blocks)).toBe('第一行\n第三行');
  });

  it('applyStickerLevel：quiet 原地替换锚点行，前后行与顺序不动', () => {
    const text = '第一行\n你可以用 akane-sticker 发梗图\n第三行';
    expect(applyStickerLevel(text, 'quiet', blocks)).toBe(`第一行\n${blocks.quiet}\n第三行`);
  });

  it('applyStickerLevel：active 一条锚点行换成两条，不重复', () => {
    const text = '第一行\n你可以用 akane-sticker 发梗图\n第三行';
    const out = applyStickerLevel(text, 'active', blocks);
    expect(out).toBe(`第一行\n${blocks.active}\n第三行`);
    expect(out.match(/akane-sticker/g)).toHaveLength(1);
  });

  it('applyStickerLevel：锚点行不存在 ⇒ 恒等，绝不凭空造一句人格', () => {
    const text = '第一行\n第二行';
    expect(applyStickerLevel(text, 'active', blocks)).toBe(text);
    expect(applyStickerLevel(text, 'quiet', blocks)).toBe(text);
    expect(applyStickerLevel(text, 'off', blocks)).toBe(text);
  });

  it('applyStickerLevel：该档没文案（sticker-levels.md 被写坏）⇒ 退化成恒等', () => {
    const text = '你可以用 akane-sticker 发梗图';
    expect(applyStickerLevel(text, 'quiet', {})).toBe(text);
    expect(applyStickerLevel(text, 'active', { quiet: '别的档' })).toBe(text);
    // off 不需要文案，照旧删行
    expect(applyStickerLevel(text, 'off', {})).toBe('');
  });

  it('parseStickerLevels：只收四档名的小节，小节外的前言不进文案', () => {
    const parsed = parseStickerLevels([
      '前言里也提到 akane-sticker，不该被收进来',
      '## quiet',
      '- 克制句',
      '## normal',
      '- 写了也没用的句',
      '## nonsense',
      '- 非法档名',
    ].join('\n'));
    expect(parsed.quiet).toBe('- 克制句');
    // normal 是恒等档，档位改写函数根本不读它；解析层允许它存在但没人用
    expect(parsed.normal).toBe('- 写了也没用的句');
    expect(Object.keys(parsed)).toEqual(['quiet', 'normal']);
  });

  it('真实 persona/akane-group.md 恰好一行含锚点 —— 谁改丢了 token，quiet/active 就静默失效', () => {
    const group = readFileSync(new URL('../persona/akane-group.md', import.meta.url), 'utf8');
    expect(group.split('\n').filter((line) => line.includes(STICKER_ANCHOR))).toHaveLength(1);
  });

  it('真实 persona/akane-direct.md 不含锚点 ⇒ 四档对私聊全是恒等（normal 零变化的前提）', () => {
    const direct = readFileSync(new URL('../persona/akane-direct.md', import.meta.url), 'utf8');
    expect(direct).not.toContain(STICKER_ANCHOR);
  });

  it('真实 sticker-levels.md 的 quiet / active 都写到了，且 active 是两条', () => {
    const parsed = readStickerLevels();
    expect(parsed.quiet).toBeTruthy();
    expect(parsed.active).toBeTruthy();
    expect((parsed.active as string).split('\n')).toHaveLength(2);
  });

  it('buildPersona：档位缺省 = normal = 与不传档位逐字节相同', () => {
    const persona = join(root, 'level-default.md');
    writeFileSync(persona, '第一行\n你可以用 akane-sticker 发梗图\n第三行', 'utf8');
    const asUndefined = buildPersona('group', config({ personaGroupFile: persona }));
    const asNormal = buildPersona('group', config({ personaGroupFile: persona, stickerLevel: 'normal' }));
    expect(asUndefined).toBe('第一行\n你可以用 akane-sticker 发梗图\n第三行');
    expect(asNormal).toBe(asUndefined);
  });

  it('buildPersona：active 用上了正本里的两档文案，原文那句不再出现', () => {
    const persona = join(root, 'level-active.md');
    writeFileSync(persona, '第一行\n你可以用 akane-sticker 发梗图\n第三行', 'utf8');
    const out = buildPersona('group', config({ personaGroupFile: persona, stickerLevel: 'active' }));
    expect(out).toContain('第一行');
    expect(out).toContain('第三行');
    expect(out).not.toContain('你可以用 akane-sticker 发梗图');
    expect(out).toContain(readStickerLevels().active as string);
  });

  it('buildPersona：off 与早期布尔软关等价 —— 锚点行整行消失，其余原样', () => {
    const persona = join(root, 'level-off.md');
    writeFileSync(persona, '第一行\n你可以用 akane-sticker 发梗图\n第三行', 'utf8');
    expect(buildPersona('group', config({ personaGroupFile: persona, stickerLevel: 'off' })))
      .toBe('第一行\n第三行');
  });

  it('buildPersona：私聊四档全恒等（direct persona 没有锚点行）', () => {
    const persona = join(root, 'level-c2c.md');
    writeFileSync(persona, '私聊人格内容', 'utf8');
    for (const level of ['off', 'quiet', 'normal', 'active'] as const) {
      const cfg = config({ personaDirectFile: persona, personaGroupFile: persona, stickerLevel: level });
      expect(buildPersona('c2c', cfg)).toBe('私聊人格内容');
    }
  });

  it('buildPersona：personaEnabled === false 时档位不参与（总开关先返空）', () => {
    const persona = join(root, 'level-disabled.md');
    writeFileSync(persona, '你可以用 akane-sticker 发梗图', 'utf8');
    const cfg = config({ personaGroupFile: persona, personaEnabled: false, stickerLevel: 'active' });
    expect(buildPersona('group', cfg)).toBe('');
  });
});
