import { describe, it, expect } from 'vitest';
import { ConfigSchema, STICKER_LEVELS } from './config.ts';
import { createWaker } from './wake.ts';

describe('ConfigSchema 默认值（内层外层默认必须对齐：#94-1 不变量）', () => {
  it('完全省略 access → c2cMode open（子 schema 默认生效）', () => {
    const cfg = ConfigSchema({});
    expect(cfg.access.c2cMode).toBe('open');
    expect(cfg.access.groupMode).toBe('open');
  });

  it('access: {} → 子字段默认填充 open', () => {
    const cfg = ConfigSchema({ access: {} });
    expect(cfg.access.c2cMode).toBe('open');
  });

  it('access 空值（YAML access: 后无内容）→ open', () => {
    const cfg = ConfigSchema({ access: null });
    expect(cfg.access.c2cMode).toBe('open');
  });

  it('显式配置不受默认影响', () => {
    const cfg = ConfigSchema({ access: { c2cMode: 'allowlist' } });
    expect(cfg.access.c2cMode).toBe('allowlist');
  });

  it('黑名单默认空数组（内层子 schema 与外层 default 必须逐字段对齐：#94-1）', () => {
    const cfg = ConfigSchema({});
    expect(cfg.access.c2cDeny).toEqual([]);
    expect(cfg.access.groupDeny).toEqual([]);
    const empty = ConfigSchema({ access: {} });
    expect(empty.access.c2cDeny).toEqual([]);
    expect(empty.access.groupDeny).toEqual([]);
  });

  it('黑名单可配置', () => {
    const cfg = ConfigSchema({ access: { groupDeny: ['FAE36E'], c2cDeny: ['1D80'] } });
    expect(cfg.access.groupDeny).toEqual(['FAE36E']);
    expect(cfg.access.c2cDeny).toEqual(['1D80']);
  });
});

describe('ConfigSchema 唤醒词表（R1）', () => {
  it('未配置 → 三个数组全空 = 行为与上游 0.5.5 一致', () => {
    const cfg = ConfigSchema({});
    expect(cfg.wakeWords).toEqual([]);
    expect(cfg.wakeWordsWeak).toEqual([]);
    expect(cfg.wakeWordExcludes).toEqual([]);
  });

  it('YAML 块列表形态可读入', () => {
    const cfg = ConfigSchema({
      wakeWords: ['akane', '茜茜'],
      wakeWordsWeak: ['猫'],
      wakeWordExcludes: ['熊猫', '猫粮'],
    });
    expect(cfg.wakeWords).toEqual(['akane', '茜茜']);
    expect(cfg.wakeWordsWeak).toEqual(['猫']);
    expect(cfg.wakeWordExcludes).toEqual(['熊猫', '猫粮']);
  });

  it('空值（YAML 键后无内容）→ 回落空数组而不是 null', () => {
    const cfg = ConfigSchema({ wakeWords: null });
    expect(cfg.wakeWords).toEqual([]);
  });

  it('空表时 createWaker 返回 null，门控不注入回调', () => {
    const cfg = ConfigSchema({});
    expect(createWaker({ strong: cfg.wakeWords, weak: cfg.wakeWordsWeak, excludes: cfg.wakeWordExcludes })).toBeNull();
  });
});

describe('ConfigSchema persona 路径（R3）', () => {
  it('未配置 → 三个路径全空 = 不注入，行为与上游 0.5.5 一致', () => {
    const cfg = ConfigSchema({});
    expect(cfg.personaGroupFile).toBe('');
    expect(cfg.personaDirectFile).toBe('');
    expect(cfg.personaLessonsDir).toBe('');
  });

  it('相对路径原样保留，由加载器按包根解析', () => {
    const cfg = ConfigSchema({ personaGroupFile: 'persona/akane-group.md' });
    expect(cfg.personaGroupFile).toBe('persona/akane-group.md');
  });

  it('遗留 groupPrompt 仍然可读（后向兼容）', () => {
    const cfg = ConfigSchema({ groupPrompt: '老配置' });
    expect(cfg.groupPrompt).toBe('老配置');
  });
});

describe('ConfigSchema 梗图积极度与观测', () => {
  it('缺省 stickerLevel = normal（= 现网行为零变化的那一档）', () => {
    expect(ConfigSchema({}).stickerLevel).toBe('normal');
  });

  it('四档都收，档位之外的值被拒（含早期布尔形态）', () => {
    for (const level of ['off', 'quiet', 'normal', 'active']) {
      expect(ConfigSchema({ stickerLevel: level }).stickerLevel).toBe(level);
    }
    expect(() => ConfigSchema({ stickerLevel: 'max' })).toThrow();
    expect(() => ConfigSchema({ stickerLevel: true })).toThrow();
    expect(() => ConfigSchema({ stickerLevel: 2 })).toThrow();
  });

  it('合法档位正本就是 STICKER_LEVELS：Schema 与设置页校验共用这一份', () => {
    expect(STICKER_LEVELS).toEqual(['off', 'quiet', 'normal', 'active']);
    for (const level of STICKER_LEVELS) {
      expect(ConfigSchema({ stickerLevel: level }).stickerLevel).toBe(level);
    }
  });

  it('stickerProbe 默认关闭且留 30 天：关闭态不建目录、不起定时器', () => {
    const cfg = ConfigSchema({});
    expect(cfg.stickerProbe).toEqual({ enabled: false, keepDays: 30 });
  });

  it('stickerProbe 半写（YAML 只写 enabled）时 keepDays 仍取默认，不落成 undefined', () => {
    expect(ConfigSchema({ stickerProbe: { enabled: true } }).stickerProbe).toEqual({ enabled: true, keepDays: 30 });
  });
});
