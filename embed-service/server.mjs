/**
 * 本机常驻 embedding 微服务（§14 的落地：MEMORY.md §5 的执行点）
 *
 * - **只绑 `127.0.0.1`，没有开关**。这台机器在 `192.168.1.100` 局域网可达，
 *   绑 `0.0.0.0` 等于把「送进来的都是聊天正文」这个接口开放给全楼。想改端口可以，
 *   想改监听地址不行 —— 所以这里连 host 都不读配置。
 * - **日志里绝不出正文**：只打条数、维度、毫秒。正文一旦进日志就进了别人的可读面。
 * - **启停归用户**（红线）：本服务由用户起、用户停；插件端只探测、只调用，
 *   既不 spawn 也不 kill，也没有远程 embedding 兜底通路 —— 不可达就降级字面档。
 * - 权重与分词只在启动时加载一次（`embed.mjs` 的 `loadModel`）。11-19 本机两次冷启动
 *   的 RSS 实测 229–435MB（q8、单线程），别当恒定值规划容量。
 *
 * 用法：`node server.mjs [--port 8765] [--model-dir <目录>]`
 */
import { createServer } from 'node:http';
import { loadModel } from './embed.mjs';

/** 监听地址写死，不接受配置：见文件头第一条 */
const HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;

/** 单批上限：插件侧回填按 16 条一批，留足余量同时挡住异常大的请求把内存顶爆 */
const MAX_BATCH = 64;

/** 请求体硬顶（字节）：64 条 × 单条上限远小于这个数，超出即视为滥用 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 单条最长字符数：超过就截，避免一条异常长的正文把整批的推理时间顶起来 */
const MAX_TEXT_CHARS = 4000;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function log(line) {
  console.log(`[akane-embed ${new Date().toISOString()}] ${line}`);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const port = Number(argValue('--port') ?? process.env.AKANE_EMBED_PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  log(`端口非法：${argValue('--port') ?? process.env.AKANE_EMBED_PORT}（--port 需要 1-65535 的整数）`);
  process.exit(2);
}

const model = await loadModel(argValue('--model-dir'));
log(`loaded model=${model.model} dims=${model.dims} loadMs=${model.loadMs} rssMB=${Math.round(process.memoryUsage().rss / 1048576)}`);

const server = createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0];

  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    json(res, 200, { ok: true, model: model.model, dims: model.dims });
    return;
  }

  if (req.method === 'POST' && url === '/embed') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      // 只打错误类别与长度，绝不打正文
      json(res, 400, { ok: false, error: String(err.message ?? 'BAD_JSON').slice(0, 40) });
      return;
    }
    const texts = body?.texts;
    if (!Array.isArray(texts) || texts.length === 0) {
      json(res, 400, { ok: false, error: 'texts must be a non-empty array' });
      return;
    }
    if (texts.length > MAX_BATCH) {
      json(res, 400, { ok: false, error: `batch too large (max ${MAX_BATCH})` });
      return;
    }
    if (!texts.every((item) => typeof item === 'string')) {
      json(res, 400, { ok: false, error: 'texts must all be strings' });
      return;
    }

    const started = Date.now();
    try {
      const clipped = texts.map((text) => (text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text));
      const vectors = await model.embed(clipped);
      log(`embed batch=${vectors.length} ms=${Date.now() - started} rssMB=${Math.round(process.memoryUsage().rss / 1048576)}`);
      json(res, 200, { ok: true, model: model.model, dims: model.dims, vectors: vectors.map((v) => Array.from(v)) });
    } catch (err) {
      log(`embed FAILED ${String(err.message ?? err).slice(0, 120)}`);
      json(res, 500, { ok: false, error: 'INFERENCE_FAILED' });
    }
    return;
  }

  json(res, 404, { ok: false, error: 'NOT_FOUND' });
});

server.listen(port, HOST, () => {
  log(`listening http://${HOST}:${port} （只绑回环；停机：Ctrl-C 或 kill 本进程）`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`收到 ${signal}，退出`);
    server.close(() => process.exit(0));
  });
}
