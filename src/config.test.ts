import { describe, it, expect } from 'vitest';
import { ConfigSchema } from './config.ts';
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
