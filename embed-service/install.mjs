/**
 * embed-service 装机脚本 —— 依赖 + 权重 + 自检，一次跑完。**纯 Node，三平台同一份。**
 *
 * 为什么不再是 bash：先前那份依赖 `curl` / `sha256sum` / `find -type l` / `${VAR//\//--}`，
 * 在 Windows 上要么没有要么语义不同。这里一条外部命令都不调（除了装依赖要用 npm 自己）。
 *
 * 代理这条要留意：**Node 的全局 fetch 不读 `HTTPS_PROXY`**（curl 读）。所以专用
 * `fetch` 就等于悄悄丢掉国内那条加速通路 —— 下面 `tunnelAgent()` 手工做 CONNECT 隧道，
 * 只认 `HTTPS_PROXY` / `https_proxy` 与 `NO_PROXY`（权重全走 https，`HTTP_PROXY` 用不上，
 * 别照抄 curl 那四条变量名）。`NO_PROXY` 的语义与 curl 对齐：命中目标主机就直连。
 *
 * 用法：
 *   node install.mjs                                   # 装到 ./model
 *   node install.mjs --model-dir D:\akane\model        # 权重放别处
 *   node install.mjs --skip-deps                       # 依赖已装好，只补权重
 *   $env:HTTPS_PROXY='http://127.0.0.1:7890'; node install.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import tls from 'node:tls';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const REPO_ID = 'Xenova/bge-small-zh-v1.5';
const DEFAULT_REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781';
const DEFAULT_MIRROR = 'https://hf-mirror.com';

/**
 * 权重表：`name|size|sha256`。
 * 校验值就是文件身份（blobs 按内容寻址），11-19 实测抓的。只保 q8：fp32 94.9MB
 * 不进项目资产（用户 11-19 拍板）。
 */
const FILES = [
  { name: 'tokenizer.json', size: 439_125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
  { name: 'tokenizer_config.json', size: 367, sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' },
  { name: 'config.json', size: 716, sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f' },
  { name: 'special_tokens_map.json', size: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3' },
  { name: 'model_quantized.onnx', size: 24_010_842, sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc' },
];

/** 仓库里的路径与 HF 上的路径不同：权重在 onnx/ 子目录下 */
const remotePathOf = (name) => (name === 'model_quantized.onnx' ? 'onnx/model_quantized.onnx' : name);

function log(message) {
  console.log(`[akane-embed-install] ${message}`);
}

function parseArgs(argv) {
  const options = { skipDeps: false, skipSelftest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--skip-deps') options.skipDeps = true;
    else if (flag === '--skip-selftest') options.skipSelftest = true;
    else if (flag === '--model-dir') options.modelDir = argv[++i];
    else if (flag === '--mirror') options.mirror = argv[++i];
    else if (flag === '--registry') options.registry = argv[++i];
    else if (flag === '--revision') options.revision = argv[++i];
    else {
      log(`未知参数：${flag}（可用：--model-dir / --mirror / --registry / --revision / --skip-deps / --skip-selftest）`);
      process.exit(2);
    }
  }
  return options;
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function isGood(file, expect) {
  if (!fs.existsSync(file)) return false;
  if (fs.statSync(file).size !== expect.size) return false;
  return (await sha256Of(file)) === expect.sha256;
}

/**
 * 代理 URL：只在目标是 https 时取 HTTPS_PROXY，与 curl 同一优先级。
 * `NO_PROXY` 命中目标主机就直连 —— 全局代理 + 内网镜像源这台机器上真有人这么配。
 */
function proxyFor(target) {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!raw) return undefined;
  let proxy;
  try {
    proxy = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  const host = target.hostname.toLowerCase();
  const bypass = noProxy.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (bypass.some((rule) => rule === '*' || host === rule || host.endsWith(`.${rule.replace(/^\./, '')}`))) {
    return undefined;
  }
  return proxy;
}

/**
 * CONNECT 隧道的 https.Agent：先跟代理要一条到目标 443 的裸通道，再把这条 socket
 * 升级成 TLS。`https.Agent.createConnection` 换掉默认连接方式是被支持的写法。
 */
function tunnelAgent(proxy) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, done) => {
    const port = options.port || 443;
    const authority = `${options.hostname ?? options.host}:${port}`;
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 80 });
    const fail = (err) => {
      socket.destroy();
      done(err instanceof Error ? err : new Error(String(err)));
    };
    socket.setTimeout(20000, () => fail(new Error(`代理连接超时：${proxy.hostname}:${proxy.port}`)));
    socket.on('error', (err) => fail(new Error(`代理不可达：${err.message}`)));
    socket.on('connect', () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password ?? '')}`).toString('base64')}\r\n`
        : '';
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
    });
    socket.once('data', (chunk) => {
      const head = chunk.toString('latin1').split('\r\n\r\n')[0];
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        // 隧道被拒最常见的原因是代理只放行 http 而 CONNECT 被关
        socket.removeAllListeners('error');
        return fail(new Error(`代理拒绝 CONNECT（${head.split('\r\n')[0] || '无响应'}）`));
      }
      socket.setTimeout(0);
      const secure = tls.connect({ socket, servername: options.hostname ?? options.host, ALPNProtocols: ['http/1.1'] });
      secure.on('secureConnect', () => done(null, secure));
      secure.on('error', (err) => fail(err));
    });
  };
  return agent;
}

function get(url, agent) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, headers: { 'user-agent': 'akane-embed-install' }, timeout: 30000 }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`超时：${url}`)));
  });
}

/**
 * 一次文件的下载：失败重试 3 次并退避。
 *
 * 为什么要重试：`hf-mirror` 在连续拉同一批文件时真会回 429（本机实测），而旧那份
 * bash 脚本靠 `curl --retry 3` 挡这件事；换成手写下载之后不重试就等于把网络抖动
 * 报成装机失败。4xx 里只有 408/429 算抖动，其余（404 = revision 写错）重试也没用。
 */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const httpStatusOf = (message) => Number(/^HTTP (\d{3})/.exec(message)?.[1] ?? 0);

async function downloadWithRetry(url, part) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await download(url, part);
      return;
    } catch (err) {
      lastError = err;
      const transient = TRANSIENT.has(httpStatusOf(err.message)) || /超时|代理|ECONN|ETIMEDOUT|ENOTFOUND/.test(err.message);
      if (!transient) break;
      if (attempt < 3) {
        const wait = attempt * 5_000;
        log(`  第 ${attempt} 次失败（${err.message}）→ ${wait / 1000}s 后重试`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  if (fs.existsSync(part)) fs.rmSync(part);
  throw lastError;
}

/** 下到 dest.part：跟重定向（镜像 302 到 CDN），每 4MB 打一行进度 */
async function download(url, dest) {
  const proxy = proxyFor(new URL(url));
  const agent = proxy ? tunnelAgent(proxy) : undefined;
  if (proxy) log(`走代理 ${proxy.hostname}:${proxy.port}`);
  let target = url;
  for (let hop = 0; hop <= 5; hop += 1) {
    const res = await get(target, agent);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      target = new URL(res.headers.location, target).href;
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`HTTP ${res.statusCode}：${target}`);
    }
    const total = Number(res.headers['content-length'] ?? 0);
    let received = 0;
    let lastReport = 0;
    res.on('data', (chunk) => {
      received += chunk.length;
      if (received - lastReport >= 4 * 1024 * 1024) {
        lastReport = received;
        log(`  … ${(received / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`);
      }
    });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      res.on('error', reject);
      out.on('error', reject);
      out.on('close', resolve);
      res.pipe(out);
    });
    return;
  }
  throw new Error(`重定向超过 5 跳：${url}`);
}

/**
 * 本地 HF 缓存优先：`$HF_HOME/hub/models--Xenova--bge-small-zh-v1.5/snapshots/*`。
 * 缓存里的权重是指向 `blobs/<hash>` 的符号链接，`copyFileSync` 天然解成实文件
 * （等价 `cp -L`）—— Windows 上通常是普通文件，同一段代码两边都对。
 */
function findInCache(name) {
  const root = path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub');
  const dir = path.join(root, `models--${REPO_ID.replace(/\//g, '--')}`, 'snapshots');
  if (!fs.existsSync(dir)) return undefined;
  const wanted = remotePathOf(name);
  const hits = [];
  const walk = (at, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() || entry.isSymbolicLink()) hits.push(full);
    }
  };
  walk(dir, 0);
  const byRemote = hits.filter((file) => file.endsWith(wanted.replace(/\//g, path.sep)));
  return byRemote.sort().pop() ?? hits.find((file) => path.basename(file) === name);
}

function runNode(script, modelDir) {
  const result = spawnSync(process.execPath, [path.join(HERE, script)], {
    stdio: 'inherit',
    env: { ...process.env, AKANE_EMBED_MODEL_DIR: modelDir },
  });
  if (result.status !== 0) throw new Error(`${script} 失败（退出码 ${result.status}）`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const modelDir = path.resolve(options.modelDir ?? process.env.AKANE_EMBED_MODEL_DIR ?? path.join(HERE, 'model'));
  const mirror = (options.mirror ?? process.env.AKANE_EMBED_MIRROR ?? DEFAULT_MIRROR).replace(/\/+$/, '');
  const registry = options.registry ?? process.env.AKANE_EMBED_NPM_REGISTRY;
  const revision = options.revision ?? process.env.AKANE_EMBED_REVISION ?? DEFAULT_REVISION;

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 0)) {
    log(`Node ${process.versions.node} 偏旧（实测跑通的是 v22.20.0，onnxruntime-web 的 WASM 走 node_modules 通路）`);
  }

  // ── 1. 依赖：两个都锁死到实测过的那两个版本 ──────────────────────────
  // onnxruntime-web@1.17.3：1.26 的 postinstall 取预编译 build list 会 302 后失败
  // @huggingface/tokenizers@0.2.0：分词对拍 0/349 就是在这个版本上过的，换版必重跑对拍
  if (options.skipDeps) {
    log('npm install 跳过（--skip-deps）');
  } else {
    log('npm install（onnxruntime-web@1.17.3 + @huggingface/tokenizers@0.2.0）');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = ['install', '--no-audit', '--no-fund'];
    if (registry) args.push('--registry', registry);
    const result = spawnSync(npm, args, { stdio: 'inherit', cwd: HERE, shell: process.platform === 'win32' });
    if (result.error) throw new Error(`调不到 npm：${result.error.message}（Windows 上先确认 Node 已装且在 PATH）`);
    if (result.status !== 0) throw new Error(`npm install 失败（退出码 ${result.status}）`);
  }

  // ── 2. 权重：已就位 → 本地 HF 缓存 → 镜像下载，三处都按 sha256 判 ──────
  fs.mkdirSync(modelDir, { recursive: true });
  for (const file of FILES) {
    const target = path.join(modelDir, file.name);
    if (await isGood(target, file)) {
      log(`${file.name} 已就位且校验通过`);
      continue;
    }

    const cached = findInCache(file.name);
    if (cached && (await isGood(cached, file))) {
      fs.copyFileSync(cached, target);
      if (!(await isGood(target, file))) throw new Error(`${file.name} 从缓存拷贝后校验不过：${cached}`);
      log(`${file.name} 取自本地 HF 缓存 ${cached}`);
      continue;
    }

    const url = `${mirror}/${REPO_ID}/resolve/${revision}/${remotePathOf(file.name)}`;
    log(`${file.name} 本地没有 → 从镜像取 ${url}`);
    const part = `${target}.part`;
    try {
      await downloadWithRetry(url, part);
      const got = fs.statSync(part).size;
      if (got !== file.size) throw new Error(`大小不符（期望 ${file.size}，得到 ${got}）—— 检查代理/镜像`);
      const hash = await sha256Of(part);
      if (hash !== file.sha256) throw new Error(`sha256 不符（得到 ${hash.slice(0, 12)}…）—— 镜像内容被改过？先别用`);
      fs.renameSync(part, target);
      log(`${file.name} 校验通过`);
    } finally {
      if (fs.existsSync(part)) fs.rmSync(part);
    }
  }

  // ── 3. 自检：分词对拍 + 运行时冒烟，都不起端口 ───────────────────────
  if (options.skipSelftest) {
    log('自检跳过（--skip-selftest）');
  } else {
    log('verify-tokenizer.mjs');
    runNode('verify-tokenizer.mjs', modelDir);
    log('selftest.mjs');
    runNode('selftest.mjs', modelDir);
  }

  log(`完成。启动常驻服务（由你负责启停，插件不 spawn 也不 kill）：`);
  log(`  node "${path.join(HERE, 'server.mjs')}" --port 8765 --model-dir "${modelDir}"`);
  log('只绑 127.0.0.1；内存预算按 RSS 229–435MB 记（本机实测区间）。');
}

main().catch((err) => {
  log(`失败：${err.message}`);
  process.exit(1);
});
