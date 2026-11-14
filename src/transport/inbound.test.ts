import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleAgentBody,
  type MiddlewareState,
  type ProcessedMessage,
} from './inbound.ts';
import type { ChatScope, Logger } from '../types.ts';
import type { HistoryAttachment, HistoryEntry } from '../features/history-store.ts';
import { getMediaLedger, mediaDedupKey } from '../features/media-ledger.ts';

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

// ══ 历史里的图片：渲染现问账本，路径给最新的几张，其余只留标签 ══

const MEDIA_DIR = mkdtempSync(join(tmpdir(), 'akane-inbound-'));

afterAll(() => rmSync(MEDIA_DIR, { recursive: true, force: true }));

/** 32 位十六进制 = QQ 下发图片文件名的真实形状，正好走去重键的 MD5 分支 */
const md5 = (n: number): string => n.toString(16).padStart(32, '0').toUpperCase();

/** 在临时目录造一张"已落盘"的图并登记进账本，返回其路径 */
function seedImage(n: number): string {
  const path = join(MEDIA_DIR, `${md5(n)}.jpg`);
  writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  getMediaLedger().remember(mediaDedupKey({ filename: `${md5(n)}.jpg` }), path);
  return path;
}

/** 签名 URL：无论落盘与否都不该出现在她眼里 */
const imageAtt = (n: number): HistoryAttachment => ({
  contentType: 'image/jpeg',
  filename: `${md5(n)}.jpg`,
  size: 1234,
  url: `https://api.bot.qq.com/files/${md5(n)}.jpg?sig=SECRET`,
});

function entry(attachments: HistoryAttachment[], content = '看这个', senderId = 'OTHER-1'): HistoryEntry {
  return {
    senderId,
    senderName: '路人',
    content,
    timestamp: 1,
    messageId: `M-${senderId}-${attachments.length}`,
    attachments,
  };
}

const awakened: MiddlewareState = { mention: { wasMentioned: true, implicit: false } };

describe('历史里的图片与附件渲染', () => {
  it('已落盘的历史图片挂出本地路径，URL 一个字符都不进上下文', () => {
    const path = seedImage(1);
    const body = assemble({ ...awakened, history: [entry([imageAtt(1)])] });
    expect(body).toContain('[路人 (OTHER-1)] 看这个');
    expect(body).toContain(`        └ Image: ${path}`);
    expect(body).not.toContain('api.bot.qq.com');
    expect(body).not.toContain('sig=SECRET');
  });

  it('没落盘（下载失败或配额挡下）只剩 [图片] 标签，不拿 URL 顶数', () => {
    const body = assemble({ ...awakened, history: [entry([imageAtt(2)])] });
    expect(body).toContain('        └ [图片]');
    expect(body).not.toContain('Image:');
    expect(body).not.toContain('api.bot.qq.com');
  });

  it('文件被 TTL 清理后不再挂死路径（挂了就是工具报错直发 QQ）', () => {
    const path = seedImage(3);
    rmSync(path);
    const body = assemble({ ...awakened, history: [entry([imageAtt(3)])] });
    expect(body).toContain('        └ [图片]');
    expect(body).not.toContain(path);
  });

  it('纯图片消息不再留下一条尾巴空白的历史行', () => {
    seedImage(4);
    const body = assemble({ ...awakened, history: [entry([imageAtt(4)], '')] });
    expect(body).toContain('\n[路人 (OTHER-1)]\n');
    expect(body).not.toContain('[路人 (OTHER-1)] \n');
  });

  it('路径额度从最新往回分配，超出的降级成标签', () => {
    const paths = [5, 6, 7, 8, 9].map(seedImage);
    const body = assemble({
      ...awakened,
      history: [5, 6, 7, 8, 9].map(n => entry([imageAtt(n)], `第 ${n} 张`, `S-${n}`)),
    });
    expect(body.match(/Image: /g)).toHaveLength(4);
    for (const path of paths.slice(1)) expect(body).toContain(path);
    expect(body).toContain(`[路人 (S-5)] 第 5 张\n        └ [图片]`);
  });

  it('历史里的视频和文件只标类型，不冒充图片也不给远程地址', () => {
    const body = assemble({
      ...awakened,
      history: [entry([
        { contentType: 'video/mp4', filename: `${md5(10)}.mp4`, size: 99, url: 'https://api.bot.qq.com/v?sig=SECRET' },
        { contentType: 'application/pdf', filename: '报告.pdf', size: 2048, url: 'https://api.bot.qq.com/f?sig=SECRET' },
      ])],
    });
    expect(body).toContain('        └ [视频]');
    expect(body).toContain('        └ [文件: 报告.pdf');
    expect(body).not.toContain('api.bot.qq.com');
  });

  it('同一条消息里的多张图各占一行，顺序与下发一致', () => {
    const a = seedImage(11);
    const b = seedImage(12);
    const body = assemble({ ...awakened, history: [entry([imageAtt(11), imageAtt(12)])] });
    expect(body).toMatch(new RegExp(`└ Image: ${a}\\n {8}└ Image: ${b}`));
  });

  it('未唤醒时不拼历史，落盘的图片也不泄露进上下文', () => {
    const path = seedImage(13);
    const body = assemble({ mention: { wasMentioned: false, implicit: false }, history: [entry([imageAtt(13)])] });
    expect(body).not.toContain('[Chat history begins]');
    expect(body).not.toContain(path);
  });
});
