import { describe, expect, it } from 'vitest';
import {
  assembleAgentBody,
  type MiddlewareState,
  type ProcessedMessage,
} from './inbound.ts';
import type { ChatScope, Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function msg(overrides: Partial<ProcessedMessage> = {}): ProcessedMessage {
  return {
    rawEventType: 'GROUP_MESSAGE_CREATE',
    kind: 'group',
    senderId: 'SENDER-OPENID',
    senderName: '阿肥',
    content: 'akane 你觉得呢',
    messageId: 'MSG-1',
    timestamp: '1700000000',
    groupOpenid: 'GROUP-OPENID',
    ...overrides,
  };
}

const history = [
  { senderId: 'OTHER-1', senderName: '路人', content: '今天去爬山吗', timestamp: 1, messageId: 'M0' },
  { senderId: 'SENDER-OPENID', senderName: '阿肥', content: '走', timestamp: 2, messageId: 'M1' },
];

function assemble(state: MiddlewareState, scope: ChatScope = 'group', overrides: Partial<ProcessedMessage> = {}): string | null {
  return assembleAgentBody(msg(overrides), state, scope, logger);
}

describe('R2 隐式唤醒也要带上下文', () => {
  it('显式 @：拼群历史 + (@you) 标记', () => {
    const body = assemble({ mention: { wasMentioned: true, implicit: false }, history });
    expect(body).toContain('[Chat history begins]');
    expect(body).toContain('[Chat history ends]');
    expect(body).toContain('(@you)');
    expect(body).not.toContain('（有人喊你）');
  });

  it('仅隐式唤醒：同样拼群历史，标记换成「有人喊你」', () => {
    const body = assemble({ mention: { wasMentioned: false, implicit: true }, history });
    expect(body).toContain('[Chat history begins]');
    expect(body).toContain('[路人 (OTHER-1)] 今天去爬山吗');
    expect(body).toContain('（有人喊你）');
    expect(body).not.toContain('(@you)');
  });

  it('既没被 @ 也没被喊：不拼历史（上游 0.5.5 行为保持）', () => {
    const body = assemble({ mention: { wasMentioned: false, implicit: false }, history });
    expect(body).not.toContain('[Chat history begins]');
    expect(body).not.toContain('（有人喊你）');
  });

  it('隐式唤醒的空文本仍是有效触发（只喊名字没别的话）', () => {
    expect(assemble({ mention: { implicit: true } }, 'group', { content: '' })).not.toBeNull();
    expect(assemble({ mention: { wasMentioned: false, implicit: false } }, 'group', { content: '' })).toBeNull();
  });

  it('无历史缓冲时隐式唤醒只加标记', () => {
    const body = assemble({ mention: { implicit: true } });
    expect(body).toContain('（有人喊你）');
    expect(body).not.toContain('[Chat history');
  });

  it('私聊不受唤醒标记影响', () => {
    const body = assemble({ mention: { wasMentioned: true, implicit: true }, history }, 'c2c');
    expect(body).not.toContain('[Chat history begins]');
    expect(body).toBe('akane 你觉得呢');
  });
});
