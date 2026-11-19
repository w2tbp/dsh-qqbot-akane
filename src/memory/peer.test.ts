/**
 * 归属键：隐私边界的唯一正本（§9 测试 1 的另一半）
 *
 * 这里最重要的不是「能算出键」，而是**算不出时必须 fail-closed**。
 * 一旦哪天有人把 unknown 当成相等，两份解析不出的转录就会互相召回。
 */
import { describe, expect, it } from 'vitest';
import { parseSessionKey, peerKeyOf, peerKeyOfSessionRecord, samePeer, UNKNOWN_PEER, UNKNOWN_PEER_KEY } from './peer.ts';

describe('parseSessionKey', () => {
  it('认现网形状 qqbot:${appId}:${kind}:${peerId}', () => {
    expect(parseSessionKey('qqbot:100001:c2c:o6R-yAbCdEf')).toEqual({ scope: 'c2c', peerId: 'o6R-yAbCdEf' });
    expect(parseSessionKey('qqbot:100001:group:g6X-Zy')).toEqual({ scope: 'group', peerId: 'g6X-Zy' });
  });

  it('形状不对一律 undefined（调用方落 unknown，不许猜）', () => {
    expect(parseSessionKey(undefined)).toBeUndefined();
    expect(parseSessionKey('')).toBeUndefined();
    expect(parseSessionKey('other-plugin:1:c2c:oX')).toBeUndefined(); // 原版那一类前缀（见 fork-guard 的身份残留表）
    expect(parseSessionKey('qqbot:1:c2c')).toBeUndefined();
    expect(parseSessionKey('qqbot:1:thread:oX')).toBeUndefined();
    expect(parseSessionKey('qqbot:1:c2c:')).toBeUndefined();
  });
});

describe('peerKeyOf / peerKeyOfSessionRecord', () => {
  it('两种来源必须算出同一个键', () => {
    const fromKey = peerKeyOf(parseSessionKey('qqbot:100001:group:g6X')!);
    expect(fromKey).toBe('group:g6X');
    expect(peerKeyOfSessionRecord({ scope: 'group', peerId: 'g6X' })).toBe(fromKey);
  });

  it('scope 或 peerId 缺失 → unknown（键里不留半个空串）', () => {
    expect(peerKeyOfSessionRecord({})).toBe(UNKNOWN_PEER);
    expect(peerKeyOfSessionRecord({ scope: 'c2c' })).toBe(UNKNOWN_PEER);
    expect(peerKeyOfSessionRecord({ peerId: '' })).toBe(UNKNOWN_PEER);
    expect(peerKeyOfSessionRecord({ scope: 'c2c', peerId: undefined })).toBe(UNKNOWN_PEER_KEY);
  });
});

describe('samePeer', () => {
  it('同 peer 才相等', () => {
    expect(samePeer('c2c:oA', 'c2c:oA')).toBe(true);
    expect(samePeer('c2c:oA', 'c2c:oB')).toBe(false);
    expect(samePeer('group:gA', 'c2c:gA')).toBe(false); // 同 id 不同 scope 不是同一个人
  });

  it('current 侧 undefined / unknown → false（fail-closed）', () => {
    expect(samePeer('c2c:oA', undefined)).toBe(false);
    expect(samePeer('c2c:oA', UNKNOWN_PEER)).toBe(false);
  });

  it('两侧都 unknown 也不相等 —— 这条是「孤儿转录互相召回」的闸', () => {
    expect(samePeer(UNKNOWN_PEER, UNKNOWN_PEER)).toBe(false);
  });

  it('chunk 侧 unknown 永不等于任何真实 peer', () => {
    expect(samePeer(UNKNOWN_PEER, 'c2c:oA')).toBe(false);
  });
});
