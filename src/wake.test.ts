import { describe, expect, it } from 'vitest';
import { compileWordlist, createWaker, hasWakeWords, prepareText, scanWake } from './wake.ts';

/** 词表按 REQUIREMENTS.md R1 的验收配置 */
const TABLES = {
  strong: ['akane', '茜', '茜茜', '猫娘'],
  weak: ['猫'],
  excludes: ['熊猫', '猫粮', '猫砂', '猫咪', '摸猫', '养猫', '猫爪', '猫meme', '表情包'],
};
const compiled = compileWordlist(TABLES);

const hit = (text: string): boolean => scanWake(prepareText(text), compiled) !== null;
const tierOf = (text: string): string | undefined => scanWake(prepareText(text), compiled)?.tier;

describe('R1 唤醒词：文档验收用例', () => {
  it.each([
    ['akane 你觉得呢', true],
    ['我家熊猫好胖', false],
    ['猫，你怎么看', true],
    ['这猫粮多少钱', false],
  ])('%s → %s', (text, expected) => {
    expect(hit(text)).toBe(expected);
  });
});

describe('R1 唤醒词：命中', () => {
  it.each([
    'akane 你觉得呢',
    'AKANE 在吗',
    'akane，你看这个',
    '**akane**',
    'akane',
    '茜，在吗',
    '茜你在吗',
    '茜茜你在吗',
    '茜茜，今天怎么样',
    '茜',
    '猫娘是什么物种',
    '喂，猫娘',
    '猫，你怎么看',
    '猫 你能帮我吗',
    '猫!在吗',
    '这件事，猫你觉得呢',
  ])('%s → 回', (text) => {
    expect(hit(text)).toBe(true);
  });
});

describe('R1 唤醒词：不命中', () => {
  it.each([
    '我家熊猫好胖',
    '这猫粮多少钱',
    '猫砂该换了',
    '她养猫很多年',
    '别摸猫',
    '猫咪真可爱',
    '这个猫meme好笑',
    '发个表情包',
    '看到茜发的那个图了吗',
    '她叫茜茜，不是我',
    '小猫猫',
    '龙猫好看吗',
    '我的猫想你了',
    '猫 这个字怎么写',
    'akane 这个词怎么翻译',
    'user_akane_id 怎么用',
    '我叫akane',
    '分享 https://akane.dev 这个站',
    'www.akane.dev 打不开',
    '用 `akane` 当变量名',
    '```javascript\nconst akane = 1;\n```',
  ])('%s → 不回', (text) => {
    expect(hit(text)).toBe(false);
  });
});

describe('R1 唤醒词：拉丁词两道守卫不对称', () => {
  // 右界放宽：名字后面直接粘汉字，是中文群里喊人最正常的写法（现网实测漏过的就是这一类）
  it.each([
    'akane说话',
    'akane你还知道不断地洗澡啊',
    'akane生成一张图片',
    'akane真可爱',
    '真的吗akane',
    '冲啊akane',
    '行吧akane',
    '对吗？akane',
  ])('%s → 回', (text) => {
    expect(hit(text)).toBe(true);
  });

  // 左界仍然保守：实义汉字挨着名字就当成在说她，不挡就会见名字就插嘴
  it.each([
    '对不对akane',
    '我喜欢akane',
    '她的akane怎么办',
    '我觉得akane说得对',
    'akaneakane',
    'akane123',
  ])('%s → 不回', (text) => {
    expect(hit(text)).toBe(false);
  });
});

describe('R1 唤醒词：强弱分级', () => {
  it('强词独立成词即命中，不需要呼格信号', () => {
    expect(tierOf('猫娘 今天天气不错')).toBe('strong');
  });

  it('弱词靠称呼标点命中', () => {
    expect(tierOf('猫，你怎么看')).toBe('weak');
  });

  it('强词优先于弱词', () => {
    expect(tierOf('猫 茜 在吗')).toBe('strong');
  });
});

describe('R1 prepareText：等长掩码', () => {
  it('掩码不改变长度，坐标体系保持一致', () => {
    const raw = '茜 https://akane.dev 看这个 [<face,id=1/>] ```\nakane\n``` 完';
    expect(prepareText(raw)).toHaveLength(raw.length);
  });

  it('掩码掉的名字不会复活', () => {
    const prepared = prepareText('看 www.akane.dev 吧');
    expect(prepared).not.toContain('akane');
  });

  it('超长子句被截断到 2000 字符以内', () => {
    expect(prepareText('猫'.repeat(50_000)).length).toBeLessThanOrEqual(2000);
  });

  it('未闭合的行内标记只掩到行尾，不吃掉后面的呼喊', () => {
    expect(hit('这里有个反引号 ` 没闭合\n茜 你在吗')).toBe(true);
  });
});

describe('R1 @ 别人昵称掩码', () => {
  it('mentions 里的昵称不参与唤醒', () => {
    const mentions = [{ nickname: '小茜茜', is_you: false }];
    expect(scanWake(prepareText('我讨厌小茜茜', mentions), compiled)).toBeNull();
  });

  it('昵称与唤醒词同形时，@ 本 bot 走显式判定不靠文本', () => {
    const mentions = [{ nickname: 'akane', is_you: true }];
    expect(scanWake(prepareText('akane 在吗', mentions), compiled)).toBeNull();
  });
});

describe('R1 createWaker', () => {
  it('词表全空 → 返回 null（关闭态连回调都不注入）', () => {
    expect(createWaker({ strong: [], weak: [], excludes: [] })).toBeNull();
    expect(hasWakeWords({ strong: [], weak: [] })).toBe(false);
  });

  it('配置了词表 → hasWakeWords 为真', () => {
    expect(createWaker(TABLES)).toBeTypeOf('function');
    expect(hasWakeWords({ strong: ['akane'], weak: [] })).toBe(true);
  });

  it('显式 @ 让位给 wasMentioned，implicit 不重复成立', () => {
    const waker = createWaker({ ...TABLES, appId: '1903697171' })!;
    expect(waker({ rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: '随便说点什么' })).toBe(false);
    expect(waker({ rawEventType: 'GROUP_MESSAGE_CREATE', content: 'akane', mentions: [{ is_you: true }] })).toBe(false);
    expect(waker({ rawEventType: 'GROUP_MESSAGE_CREATE', content: '<@!1903697171> akane' })).toBe(false);
    expect(waker({ rawEventType: 'GROUP_MESSAGE_CREATE', content: 'akane 在吗' })).toBe(true);
  });

  it('匹配器异常一律吞掉，不能冒到 mentionGate', () => {
    const waker = createWaker(TABLES)!;
    const boom = {
      rawEventType: 'GROUP_MESSAGE_CREATE',
      get content(): string {
        throw new Error('boom');
      },
    };
    expect(waker(boom)).toBe(false);
  });

  it('命中回调拿到词与层级', () => {
    const seen: Array<{ word: string; tier: string }> = [];
    const waker = createWaker({ ...TABLES, onHit: (h) => seen.push({ word: h.word, tier: h.tier }) })!;
    expect(waker({ rawEventType: 'GROUP_MESSAGE_CREATE', content: '茜茜 在吗' })).toBe(true);
    expect(seen).toEqual([{ word: '茜茜', tier: 'strong' }]);
  });
});

describe('R1 病态输入性能', () => {
  it('5 万字符输入 < 30ms', () => {
    const raw = ('猫 http://akane.dev/x `akane` 茜 '.repeat(2_500)) + 'akane';
    expect(raw.length).toBeGreaterThan(50_000);
    const started = performance.now();
    expect(hit(raw)).toBe(true);
    expect(performance.now() - started).toBeLessThan(30);
  });

  it('未闭合围栏不触发回溯', () => {
    const raw = '```'.repeat(5_000) + '茜';
    const started = performance.now();
    expect(hit(raw)).toBe(false);
    expect(performance.now() - started).toBeLessThan(30);
  });
});
