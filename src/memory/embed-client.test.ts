/**
 * 客户端的两条红线：非回环一个字节都不发出去，失败一律收敛成 code
 *
 * 断言里最重要的是 `fetch` **没被调用** —— 配置写错时「先发再判」就已经泄了。
 * 另一条是错误原文不许出现在返回值里：宿主/网络的 message 常带绝对路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EMBED_BASE,
  embedTexts,
  isLoopbackHost,
  probeEmbedHealth,
  type EmbedConfigLike,
} from './embed-client.ts';

const config: EmbedConfigLike = { baseUrl: DEFAULT_EMBED_BASE, timeoutMs: 1000, dims: 4 };

function reply(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function vectors(count: number, dims = 4): number[][] {
  return Array.from({ length: count }, (_, i) => Array.from({ length: dims }, (_, h) => (i + h) / 100));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isLoopbackHost', () => {
  it('127.0.0.0/8、::1、localhost 放行', () => {
    for (const host of ['127.0.0.1', '127.0.0.53', '127.255.255.254', '::1', '[::1]', 'localhost', 'LOCALHOST']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('其余一律拒绝（含局域网与公网，配置写错也不放行）', () => {
    for (const host of ['192.168.1.100', '10.0.0.1', '0.0.0.0', '128.0.0.1', 'embedding.internal', 'evil.example.com']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('端点守卫', () => {
  it('非回环 → ENDPOINT_NOT_LOOPBACK，且一次请求都不发', async () => {
    const fetchMock = vi.mocked(fetch);
    const bad = { ...config, baseUrl: 'http://192.168.1.100:8765' };
    expect(await embedTexts(['猫粮多少钱'], bad)).toEqual({ ok: false, code: 'ENDPOINT_NOT_LOOPBACK' });
    expect(await probeEmbedHealth(bad)).toEqual({ ok: false, code: 'ENDPOINT_NOT_LOOPBACK' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('https 也拒绝：一期只认明文回环，不给「看起来更安全」的口子', async () => {
    expect(await embedTexts(['文'], { ...config, baseUrl: 'https://127.0.0.1:8765' }))
      .toEqual({ ok: false, code: 'ENDPOINT_NOT_LOOPBACK' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('URL 解析不了 → ENDPOINT_INVALID', async () => {
    expect(await embedTexts(['文'], { ...config, baseUrl: 'not a url' })).toEqual({ ok: false, code: 'ENDPOINT_INVALID' });
  });

  it('空批次不发请求', async () => {
    expect(await embedTexts([], config)).toEqual({ ok: false, code: 'EMPTY_BATCH' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('embedTexts 正常路径', () => {
  it('打到 /embed、带全部正文、返回向量与入参同序', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(reply({ ok: true, model: 'bge', dims: 4, vectors: vectors(2) }));
    const out = await embedTexts(['甲', '乙'], config);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.vectors).toEqual(vectors(2));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:8765/embed');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(String(init!.body))).toEqual({ texts: ['甲', '乙'] });
  });

  it('base 带前缀路径时子路径跟着走', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(reply({ ok: true, model: 'bge', dims: 4, vectors: vectors(1) }));
    await embedTexts(['甲'], { ...config, baseUrl: 'http://127.0.0.1:8765/akane/' });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://127.0.0.1:8765/akane/embed');
  });
});

describe('失败收敛（永不抛）', () => {
  it('条数与入参不符 → BAD_RESPONSE', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ ok: true, model: 'bge', dims: 4, vectors: vectors(1) }));
    expect(await embedTexts(['甲', '乙'], config)).toEqual({ ok: false, code: 'BAD_RESPONSE' });
  });

  it('维度不符 → DIM_MISMATCH（不许把 8 维向量塞进 4 维文件）', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ ok: true, model: 'bge', dims: 8, vectors: vectors(1, 8) }));
    expect(await embedTexts(['甲'], config)).toEqual({ ok: false, code: 'DIM_MISMATCH' });
  });

  it('非 2xx → UNREACHABLE', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ error: 'boom' }, { ok: false, status: 503 }));
    expect(await embedTexts(['甲'], config)).toEqual({ ok: false, code: 'UNREACHABLE' });
  });

  it('超时 → TIMEOUT，其他异常 → UNREACHABLE；两者都不带原文', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    vi.mocked(fetch).mockRejectedValue(timeout);
    expect(await embedTexts(['甲'], config)).toEqual({ ok: false, code: 'TIMEOUT' });

    vi.mocked(fetch).mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8765 /home/huwp'));
    const out = await embedTexts(['甲'], config);
    expect(out).toEqual({ ok: false, code: 'UNREACHABLE' });
    expect(JSON.stringify(out)).not.toContain('/home/');
  });

  it('正文里的哨兵串不会回显在任何返回值里', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ ok: true, model: 'bge', dims: 4, vectors: vectors(1) }));
    expect(JSON.stringify(await embedTexts(['SENTINEL-不得回显'], config))).not.toContain('SENTINEL');
  });
});

describe('probeEmbedHealth', () => {
  it('健康时回 dims 与 model', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ ok: true, model: 'bge-small-zh-v1.5', dims: 4 }));
    expect(await probeEmbedHealth(config)).toEqual({ ok: true, dims: 4, model: 'bge-small-zh-v1.5' });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('http://127.0.0.1:8765/health');
  });

  it('维度不对 → DIM_MISMATCH；形状不对 → BAD_RESPONSE', async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ ok: true, model: 'bge', dims: 512 }));
    expect(await probeEmbedHealth(config)).toEqual({ ok: false, code: 'DIM_MISMATCH' });
    vi.mocked(fetch).mockResolvedValue(reply({ ok: true }));
    expect(await probeEmbedHealth(config)).toEqual({ ok: false, code: 'BAD_RESPONSE' });
  });

  it('JSON 解析失败也不抛', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } } as unknown as Response);
    expect(await probeEmbedHealth(config)).toEqual({ ok: false, code: 'BAD_RESPONSE' });
  });
});
