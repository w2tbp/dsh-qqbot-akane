import { describe, expect, it } from 'vitest';
import { accessPolicy } from '@tencent-connect/qqbot-nodejs';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { buildAccessPolicy } from './middleware-setup.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function config(overrides: Partial<ImQQBotConfig> = {}): ImQQBotConfig {
  return {
    debug: false,
    access: {
      c2cMode: 'open',
      c2cAllow: [],
      c2cDeny: [],
      groupMode: 'open',
      groupAllow: [],
      groupDeny: [],
    },
    ...overrides,
  } as unknown as ImQQBotConfig;
}

/** 用真 SDK accessPolicy 跑一遍，验证 deny 语义而不是我们自己的想象 */
async function run(policy: ReturnType<typeof buildAccessPolicy>, message: Record<string, unknown>) {
  let passed = false;
  let stopReason: string | undefined;
  const ctx = {
    message,
    log: { debug: () => {} },
    stop: (reason?: string) => { stopReason = reason; },
  } as unknown as MiddlewareContext;
  await accessPolicy(policy)(ctx, async () => { passed = true; });
  return { passed, stopReason };
}

const groupMsg = (senderId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'group',
  senderId,
  groupOpenid: 'GROUP-1',
  content: 'akane 在吗',
  rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  ...extra,
});

describe('R4 黑名单进代码', () => {
  it('群成员黑名单命中：链路直接停住，零输出', async () => {
    const policy = buildAccessPolicy(config({ access: { ...config().access, groupDeny: ['BAD-GUY'] } }), logger);
    const result = await run(policy, groupMsg('BAD-GUY'));
    expect(result.passed).toBe(false);
    expect(result.stopReason).toContain('denied by deny-list');
  });

  it('即使被 @ 也不回：deny 在第 3 层，门控根本看不到这条消息', async () => {
    const policy = buildAccessPolicy(config({ access: { ...config().access, groupDeny: ['BAD-GUY'] } }), logger);
    expect((await run(policy, groupMsg('BAD-GUY'))).passed).toBe(false);
    expect((await run(policy, groupMsg('NICE-GUY'))).passed).toBe(true);
  });

  it('deny 优先于 allowlist：在白名单里也照样屏蔽', async () => {
    const policy = buildAccessPolicy(config({
      access: {
        ...config().access,
        groupMode: 'allowlist',
        groupAllow: ['GROUP-1'],
        groupDeny: ['BAD-GUY'],
      },
    }), logger);
    expect((await run(policy, groupMsg('BAD-GUY'))).passed).toBe(false);
    expect((await run(policy, groupMsg('OTHER'))).passed).toBe(true);
  });

  it('私聊黑名单按 openid 屏蔽，其他私聊照常放行', async () => {
    const policy = buildAccessPolicy(config({
      access: { ...config().access, c2cDeny: ['BAD-GUY'] },
    }), logger);
    expect((await run(policy, { kind: 'c2c', senderId: 'BAD-GUY', content: 'hi' })).passed).toBe(false);
    expect((await run(policy, { kind: 'c2c', senderId: 'OTHER', content: 'hi' })).passed).toBe(true);
  });

  it('黑名单为空时不注入 group.deny，行为与上游 0.5.5 一致', () => {
    const policy = buildAccessPolicy(config(), logger);
    expect(policy.group?.deny).toBeUndefined();
    expect(policy.c2c?.deny).toEqual([]);
    expect(policy.group?.mode).toBe('open');
  });

  it('群成员黑名单不会被当成群 openid 匹配（字符串 matcher 匹配的是群）', async () => {
    // 若把 groupDeny 直接当字符串塞进 group.deny，屏蔽的是群而不是人；函数 matcher 才是按人屏蔽
    const policy = buildAccessPolicy(config({
      access: { ...config().access, groupDeny: ['GROUP-1'] },
    }), logger);
    expect((await run(policy, groupMsg('SOMEONE'))).passed).toBe(true);
  });
});
