#!/usr/bin/env node
/**
 * 召回离线评测口 —— 给 `MEMORY.md` §6 第 1 条供血：改任何阈值/限额必须附**同一批查询**的改前/改后位次。
 *
 * 为什么要单独一个口：现网 `akane_recall` 的返回体只含「过了 floor 且进了前 limit」的片段，
 * **榜下行结构性看不见** ⇒ floor 往下调没有任何依据（现网 23 次真实调用只给出 74 条已过线片段，
 * 最低 0.451 —— 正好压在下限上，说明线下还有东西）。`below_floor` / `beyond_pool` 两列只能从磁盘
 * 索引 + 完整榜算出来。这就是 US-35 要的那组数。
 *
 * **只读不写现网**：本脚本绝不调 `loadIndex()` —— 它在维度不符 / 半行 JSON / 字节数对不上三处会
 * `wipeIndex` 整库清零，而后台同步每 `syncIntervalMs`（现网 600000ms）正在往同一目录 `appendRows`，
 * 读到撕裂现场只能降级不能重建。这里只用 `readChunkRows` + `readVectors`，自己对齐、自己截尾。
 * 不打开任何 session 文件：候选问法全部来自 `chunks.jsonl` 里 `role='peer'` 的行（T1 取不到才退化）。
 *
 * **隐私（§5）**：用户的题库只写中文问法 + 整数序号，永不手写 chunk key / sessionId。序号↔key 的
 * 对照表只存 `~/.akane-eval/state/`（0600）。凡走 stdout 的行都过 `say()`：命中绝对路径 / 长十六进制 /
 * `c2c:` `group:` 原值 / URL / IP / 凭据字样 / sessionId ⇒ 退出码 2 且不写报告。想看 chunk 正文只有
 * 两条路：自己开 `~/.akane-eval/` 下的文件，或加 `--show-text --i-am-the-user` 且 stdout 是 TTY
 * （助手侧管道 `isTTY` 恒为 undefined ⇒ 这条路物理上走不通）。
 *
 * 子命令：
 *   inspect                     规模账：每 peer 榜长（别名）+ chunk 字数直方图 + 可当问法的短 chunk 条数
 *   questions [--peer A] [--maxlen 40]
 *                               抽候选问法写 work/candidates-*.jsonl（含正文，0600），stdout 只报条数
 *   check                       题库体检：序号解析阶梯 / 词元非空 / 自块歧义 / 字面档命中数
 *   run [--arm k=v,...]... [--no-e2e] [--keep-self]
 *                               阶段 A 每题嵌一次 + 阶段 B 纯筛切扫参，出位次表（reports/*.md）
 *   leakgate                    闸门自身的守卫：脏样本全拦、净样本全放行（哨兵是中性的，不含本机真值）
 *
 * 臂 = `{floor, poolFactor, rrfK, limit}` 四个值（`--arm floor=0.3,pool=2,k=20,limit=4`；`pool=inf` = 不限）。
 * 现网默认 floor=0.45 / pool=3 / k=60 / limit=6，**四个都是临时值**（§6 第 2 条），有效样本 <20 时
 * 本表只能当观察，不许据此改任何一个数。
 *
 * 端到端口径：`--no-e2e` 关的那条是**真 `recallOnce`**（注入四个旋钮）跑出来的 `hits`，与手工链的
 * `returned` 并排列 —— 不用手工链冒充端到端。默认只对第一臂（现网臂）跑，每题多一次嵌入；
 * 跨臂等价性由 `src/memory/recall-tool.test.ts`「评测口的手工链 = recallOnce 的链」那组断言钉，
 * 不在脚本里重复烧算力（`--e2e-all` 才逐臂跑）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_FRAGMENT_LIMIT,
  MAX_FRAGMENT_CHARS,
  MAX_RETURN_CHARS,
  RRF_K,
  VECTOR_POOL_FACTOR,
  VECTOR_SIM_FLOOR,
  buildLists,
  matchesLiteral,
  queryTokens,
  selectCandidates,
  vectorRanked,
} from '../lib/memory/retrieval.js';
import { EMBED_DIMS, readChunkRows, readVectors } from '../lib/memory/index-store.js';
import { DEFAULT_EMBED_BASE, embedTexts, probeEmbedHealth } from '../lib/memory/embed-client.js';
import { UNKNOWN_PEER, samePeer } from '../lib/memory/peer.js';
import { recallOnce } from '../lib/memory/recall-tool.js';

const VECTOR_BYTES = EMBED_DIMS * 4;
const INDEX_DIR = join(homedir(), '.dsh-qqbot-akane', 'index');
const EVAL_ROOT = join(homedir(), '.akane-eval');
const STATE_DIR = join(EVAL_ROOT, 'state');
const WORK_DIR = join(EVAL_ROOT, 'work');
const REPORT_DIR = join(EVAL_ROOT, 'reports');
const QUESTIONS_FILE = join(WORK_DIR, 'questions.jsonl');
const ORDINAL_FILE = join(STATE_DIR, 'ordinals.json');
const PEER_FILE = join(STATE_DIR, 'peers.json');

/** 与 `src/memory/index.ts` 的现网形状一致；`AKANE_EVAL_EMBED_BASE` 只换 host:port，默认永远回环 */
const EMBED = {
  baseUrl: process.env.AKANE_EVAL_EMBED_BASE ?? DEFAULT_EMBED_BASE,
  timeoutMs: Number(process.env.AKANE_EVAL_EMBED_TIMEOUT ?? 8000),
  dims: EMBED_DIMS,
};

/** 现网那四个临时值 = 默认臂。不给 `--arm` 时只跑它，等于「按现状把榜打一遍」 */
const PRODUCTION = { floor: VECTOR_SIM_FLOOR, poolFactor: VECTOR_POOL_FACTOR, rrfK: RRF_K, limit: DEFAULT_FRAGMENT_LIMIT };

// ---------------------------------------------------------------- 参数 / 出口闸门

const argv = process.argv.slice(2);
const sub = argv.find((item) => !item.startsWith('-')) ?? 'inspect';
const has = (name) => argv.includes(`--${name}`) || argv.some((item) => item.startsWith(`--${name}=`));
/** `--peer=C` 与 `--peer C` 都收 —— 只认 `=` 那一种时，漏写的调用会静悄悄用默认值跑完一整轮 */
const opt = (name, fallback) => {
  const hit = argv.find((item) => item.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const next = argv[at + 1];
  if (next === undefined || next.startsWith('--')) {
    fail(`--${name} 需要带一个值（写 ${name}=值 或 ${name} 值，别只留个开关）`);
  }
  return next;
};
/** 可重复：`--arm=floor=0.3,pool=2 --arm floor=0.5` 两种写法都行，多个 --arm 就是多臂对比 */
const multi = (name) => {
  const eq = argv.filter((item) => item.startsWith(`--${name}=`)).map((item) => item.slice(name.length + 3));
  const spaced = argv.map((item, i) => (item === `--${name}` ? argv[i + 1] : undefined))
    .filter((item) => item !== undefined && !item.startsWith('--'));
  return [...eq, ...spaced];
};

/** 判据与 `transcript-source.ts` 的脱敏同族，宁多勿少：宁可拒印一行数字，也不放一段正文出去 */
const LEAK_PATTERNS = [
  [/\/home\/|\/root\/|\/Users\//, '绝对路径'],
  [/\b[0-9a-f]{32,}\b/i, '长十六进制'],
  [/\b(?:c2c|group):[A-Za-z0-9_-]/, 'peer 原值'],
  [/(?:appSecret|appId|token|secret|passwd)\s*[:=]/i, '凭据赋值'],
  [/https?:\/\//i, 'URL'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'IP'],
  [/session[-_][0-9a-f]{8}/i, 'session id'],
];

/** 自检模式（只给 leakgate 用）：把退出换成抛错，好在同一进程里逐条验完再汇总 */
let probeMode = false;

function fail(message) {
  if (probeMode) throw new Error('LEAK_BLOCKED');
  process.stderr.write(`akane-recall-eval: ${message}\n`);
  process.exit(2);
}

/** 唯一允许的 stdout 出口。含正文的行物理上到不了这里（含正文的文件只写 work/，不打印） */
function say(line = '') {
  const text = String(line);
  for (const [pattern, why] of LEAK_PATTERNS) {
    if (pattern.test(text)) fail(`拒绝输出：命中「${why}」。stdout 不许含正文或主机标识（本行已丢弃）。`);
  }
  process.stdout.write(`${text}\n`);
}

/**
 * `node scripts/akane-recall-eval.mjs leakgate` —— 闸门自身的守卫。
 *
 * 哨兵用的是**中性形状**（RFC 5737 的 `192.0.2.100`、测试里通用的 `/home/anon`、全零十六进制），
 * 不是本机真值：这条命令的输出会进会话记录，拿真路径当样本就等于自己先漏一次。
 * 判据 = 每条脏样本都被拦（抛错、零输出），每条干净样本都放行。
 */
const DIRTY_SENTINELS = [
  '/home/anon/.dsh-qqbot-akane/index/chunks.jsonl',
  'peer=c2c:A1B2C3D4E5F6 榜长 12',
  'key=session-49fd063f-0000-0000-0000-000000000000:12-15',
  'hash 0123456789abcdef0123456789abcdef0123456789abcdef',
  'media https://example.invalid/sig/abc123',
  '出口 192.0.2.100:3080',
  'appSecret=REDACTED-IN-FIXTURE',
  '正文：她说 └ Image: /home/anon/x.png',
];
const CLEAN_SENTINELS = [
  '索引：338 条 chunk（对齐向量 338 条 / 尾部截掉 0 条）',
  '| floor=0.45 | 是 | 6 | 6（100%） | 1 | 1 | 1.000 | 0 | 0 | 0 | 0 | 6 | 6.00 vs 6 |',
  '报告：~/.akane-eval/reports/2026-11-20-01-27.md　（不含正文；含序号与 sha8）',
  '  #158 peer=C 词元=6 字面命中=1 自块=one 榜下=0',
];

function ensureDirs() {
  for (const dir of [EVAL_ROOT, STATE_DIR, WORK_DIR, REPORT_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** 私有文件（含 key 或正文）：0600 + tmp/rename 原子写。不过泄漏闸门 —— 它本来就该含 key */
function writePrivate(path, text) {
  ensureDirs();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

const sha8 = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
const short = (path) => path.replace(homedir(), '~');

// ---------------------------------------------------------------- 只读加载索引

/**
 * 读磁盘索引，不判脏、不重建。两道错位守卫：
 *
 * ① `readChunkRows` 对坏行是 **静默跳过**（`index-store.ts:144-146`），坏行在中间就会让
 *    「第 i 行文本」与「第 i 条向量」整体平移 —— 所以要求原始非空行数 == 解析出的行数，不等直接退出。
 * ② 向量字节数不等于 `2048 × 行数` 时，多出来的尾巴按「同步刚 append 完向量、那行文本还没落盘」
 *    处理 = 截到 `floor(bytes / 2048)` 并报出被截掉的行数（与生产码 `readVectors` 返 `undefined`
 *    ⇒ 语义档整体跳过同向，只是本脚本粒度更细）。
 */
async function loadReadOnly() {
  const paths = {
    chunks: join(INDEX_DIR, 'chunks.jsonl'),
    vectors: join(INDEX_DIR, 'vectors.f32.bin'),
    meta: join(INDEX_DIR, 'meta.json'),
  };
  for (const [name, file] of Object.entries(paths)) {
    if (!existsSync(file)) {
      fail(`索引缺 ${name}（${short(join(INDEX_DIR, name))} 不存在）。`
        + '记忆库要 `memory.enabled: true`、常驻 embedding 服务在跑、且回填至少走完一跳。');
    }
  }
  const meta = readJson(paths.meta, undefined);
  if (meta === undefined) fail('meta.json 解析不出来。');
  const parsed = await readChunkRows(INDEX_DIR);
  const rawLines = readFileSync(paths.chunks, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  if (rawLines !== parsed.length) {
    fail(`chunks.jsonl 有 ${rawLines} 行但只解析出 ${parsed.length} 条 —— 有行坏了。`
      + '此时文本与向量会整体错位，任何位次都是假的。等下一跳同步或按 MEMORY.md §4 手工清 index/ 重建。');
  }
  const vectorBytes = statSync(paths.vectors).size;
  const aligned = Math.min(parsed.length, Math.floor(vectorBytes / VECTOR_BYTES));
  const vectors = await readVectors(INDEX_DIR, aligned);
  if (vectors === undefined) fail('向量文件读不出对齐部分（比文本还短）。');
  if (aligned !== parsed.length) {
    say(`提示：尾部 ${parsed.length - aligned} 行文本没有对应向量（同步正在写），已按 ${aligned} 行对齐。`);
  }
  return { meta, rows: parsed.slice(0, aligned), vectors, aligned, total: parsed.length, vectorBytes };
}

/** 别名按 peer 原值排序分配（A/B/C…），原值只进 state/peers.json，永不出 stdout */
function peerAliases(rows) {
  const distinct = [...new Set(rows.map((row) => row.peer))].sort();
  const map = {};
  const aliasOf = {};
  distinct.forEach((peer, index) => {
    const alias = index < 26 ? String.fromCharCode(65 + index) : `P${index}`;
    map[alias] = peer;
    aliasOf[peer] = alias;
  });
  const next = JSON.stringify(map);
  if (JSON.stringify(readJson(PEER_FILE, null)) !== next) writePrivate(PEER_FILE, next);
  return { map, aliasOf };
}

/**
 * 序号 ↔ key 对照表，存 `state/ordinals.json`（0600）。
 *
 * 分配规矩：**已发出的序号永不变含义**。新 key 一律追加到尾部（按 key 升序排自己那批），
 * 所以按读盘顺序或追加顺序编号都不行 —— 只有「首次见到时占一个永不复用的号」稳。
 * 每条同时存首见时的 `{sha, role, time}`，这是失效阶梯能区分「重编号」与「内容变了」的唯一依据。
 */
function syncOrdinals(rows) {
  const state = readJson(ORDINAL_FILE, { entries: [] });
  const stored = JSON.stringify(state.entries ?? []);
  const entries = Array.isArray(state.entries) ? [...state.entries] : [];
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const fresh = [...new Set(rows.map((row) => row.key))].filter((key) => !byKey.has(key)).sort();
  for (const key of fresh) {
    const row = rows.find((item) => item.key === key);
    const entry = { ordinal: entries.length + 1, key, sha: sha8(row.text), role: row.role, time: row.time };
    entries.push(entry);
    byKey.set(key, entry);
  }
  // 比对必须在 push 之前抓的那份串 —— 早先写成 `JSON.stringify(state.entries)`，而 entries 就是
  // state.entries 同一个数组，push 完两边永远相等 ⇒ 文件从不落盘，「序号只增不复用」这条保证是死的
  // （现象：inspect 一切正常，因为每次都在内存里按 key 升序重算；只有跨进程才露馅）。
  if (stored !== JSON.stringify(entries)) {
    writePrivate(ORDINAL_FILE, JSON.stringify({ entries }));
  }
  return {
    entries,
    byKey,
    ordinalOf: (key) => byKey.get(key)?.ordinal,
    keyOf: (ordinal) => entries.find((entry) => entry.ordinal === ordinal)?.key,
    count: entries.length,
  };
}

/**
 * 失效阶梯 —— 「她确实说过 X」变无效有五种原因，静默剔除会让分母变小而无人知晓，所以每种都要报。
 *
 * - `ok`          序号在、key 在、内容哈希一致
 * - `renumbered`  key 没了，但同哈希同 role 同 time 的 chunk 还在别处（清库重建/边界平移）→ **自动改绑**并报新旧序号
 * - `moved`       同哈希还在，但 role 或 time 变了（合并形状变了）→ 不猜，要用户确认
 * - `stale_text`  key 还在但内容哈希变了（同 key 被改写）→ 不猜
 * - `vanished`    这份文本整条不在索引里了 → 不猜
 * - `unknown`     这个序号从没分配过（题库写错或越界）
 */
function resolveOrdinal(ordinal, ordinals, rowsByKey, rows) {
  const entry = ordinals.entries.find((item) => item.ordinal === ordinal);
  if (entry === undefined) return { status: 'unknown', ordinal };
  const live = rowsByKey.get(entry.key);
  if (live !== undefined) {
    if (sha8(live.text) === entry.sha) return { status: 'ok', ordinal, row: live, key: entry.key };
    return { status: 'stale_text', ordinal, key: entry.key };
  }
  const matches = rows.filter((row) => sha8(row.text) === entry.sha);
  if (matches.length === 0) return { status: 'vanished', ordinal, key: entry.key };
  const exact = matches.filter((row) => row.role === entry.role && row.time === entry.time);
  if (exact.length === 1) {
    return { status: 'renumbered', ordinal, row: exact[0], key: exact[0].key, to: ordinals.ordinalOf(exact[0].key) };
  }
  return { status: 'moved', ordinal, key: entry.key, candidates: matches.length };
}

// ---------------------------------------------------------------- 榜单 / 臂 / 指标

const rankOf = (keys, key) => {
  const at = keys.indexOf(key);
  return at === -1 ? undefined : at + 1;
};

const median = (values) => {
  const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (nums.length === 0) return undefined;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
};

/** `--arm floor=0.3,pool=2,k=20,limit=4`；`pool=inf` = 不限（`slice(0, Infinity)` 就是全取） */
function parseArm(spec) {
  const arm = { ...PRODUCTION, label: spec };
  for (const part of spec.split(',').filter(Boolean)) {
    const [rawKey, rawValue] = part.split('=');
    const key = rawKey.trim();
    const value = rawValue === 'inf' ? Infinity : Number(rawValue);
    if (Number.isNaN(value)) fail(`--arm 的 ${key}=${rawValue} 不是数`);
    if (key === 'floor') arm.floor = value;
    else if (key === 'pool' || key === 'poolFactor') arm.poolFactor = value;
    else if (key === 'k' || key === 'rrfK') arm.rrfK = value;
    else if (key === 'limit') arm.limit = value;
    else fail(`--arm 不认的键 ${key}（可用 floor / pool / k / limit）`);
  }
  if (!(arm.limit > 0)) fail('--arm 的 limit 必须 > 0');
  return arm;
}

/** 完整榜：同 peer 全量按余弦降序，不筛不切。floor/pool/limit 都是它的纯筛切（`retrieval.test.ts` 钉住） */
function fullBoard(scoped, vectors, queryVector) {
  return vectorRanked(scoped, vectors, queryVector, Infinity, -Infinity);
}

/** 字面档榜：与 `recall-tool.ts` 同一条（逐词 AND → 时间降序）；摘自块要在筛之前就摘（否则首位被占） */
function literalLane(scoped, tokens, excludeKey) {
  return scoped
    .filter((row) => row.key !== excludeKey && matchesLiteral(row.text, tokens))
    .sort((a, b) => b.time - a.time)
    .map((row) => row.key);
}

/** 某一臂的最终榜单键序 = 手工链（与 recallInner 同三步） */
function armLane(board, scoped, tokens, arm, excludeKey) {
  const pool = excludeKey === undefined ? board : board.filter((item) => item.key !== excludeKey);
  const lane = pool.filter((item) => item.score >= arm.floor).slice(0, arm.limit * arm.poolFactor);
  const candidates = selectCandidates(
    scoped,
    buildLists({ literalKeys: literalLane(scoped, tokens, excludeKey), vectorKeys: lane }),
    arm.limit,
    { rrfK: arm.rrfK },
  );
  return { keys: candidates.map((candidate) => candidate.key), laneLength: lane.length };
}

/**
 * 自块：问法正文自己就是一条已入库 chunk ⇒ 余弦≈1 稳占榜首。
 *
 * **主口径 = 摘自块**，依据是时序而不是偏好：T2 由后台定时器每 `syncIntervalMs` 追加，
 * 当前这轮通常还没进索引，所以现网根本不会把对方刚说的话召回回去当「上次说的」。
 * `--keep-self` 并列一条不摘的，用来量这个虚高有多少 —— 只许当自检，不许当质量分。
 */
function selfMatch(scoped, query) {
  const hits = scoped.filter((row) => row.text === query);
  if (hits.length === 0) return { state: 'none', key: undefined };
  if (hits.length > 1) return { state: 'ambiguous', key: undefined, count: hits.length };
  return { state: 'one', key: hits[0].key };
}

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

/** 真端到端：走 `recallOnce`（注入四个旋钮），拿它的 `hits` 与手工链的 `returned` 对表 */
async function endToEnd(query, peer, arm) {
  return recallOnce(query, {
    dir: INDEX_DIR,
    embed: EMBED,
    logger: silentLogger,
    currentPeer: peer,
    limit: arm.limit,
    floor: arm.floor,
    poolFactor: arm.poolFactor,
    rrfK: arm.rrfK,
  });
}

// ---------------------------------------------------------------- 题库

const QUESTIONS_SHAPE = '{"peer":"A","query":"她上次说那个多少钱","expected":[7,12],"rejects":[40],"note":"随便写"}';

/** 报告头部要写清题源：`--questions=` 跑出来的是自检，不是调参依据（§6 第 1 条） */
let questionsSource = '题库（用户标注）';

function readQuestions() {
  // `--questions=` 只给脚本自检用（拿几条fixture 验 below_floor/renumbered 的算法本身）。
  // 用它跑出来的表**不能当调参依据** —— §6 第 1 条要的是用户给的真实问法，报告头部会写明来源。
  const file = opt('questions', QUESTIONS_FILE);
  questionsSource = file === QUESTIONS_FILE ? '题库（用户标注）' : `外部题库 ${short(file)}（自检用，不是真实问法）`;
  if (!existsSync(file)) {
    fail(`还没有 ${short(file)}。先跑 questions 抽候选，再照这个形状逐行写：${QUESTIONS_SHAPE}`);
  }
  const questions = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, position) => {
    if (line.trim() === '') return;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      say(`  行 ${position + 1}：不是 JSON，跳过`);
      return;
    }
    if (typeof item.query !== 'string' || item.query.trim() === '') {
      say(`  行 ${position + 1}：缺 query，跳过`);
      return;
    }
    const expected = Array.isArray(item.expected) ? item.expected.map(Number).filter(Number.isInteger) : [];
    if (expected.length === 0) {
      say(`  行 ${position + 1}：缺 expected（整数序号数组），跳过`);
      return;
    }
    questions.push({
      no: position + 1,
      peer: typeof item.peer === 'string' ? item.peer : 'A',
      query: item.query,
      expected,
      rejects: Array.isArray(item.rejects) ? item.rejects.map(Number).filter(Number.isInteger) : [],
    });
  });
  if (questions.length === 0) fail('题库里没有一条可用记录。');
  return questions;
}

// ---------------------------------------------------------------- 子命令

async function cmdInspect() {
  const ctx = await context();
  say(`索引：${ctx.rows.length} 条 chunk（对齐向量 ${ctx.vectors.length} 条 / 尾部截掉 ${ctx.total - ctx.rows.length} 条）`);
  say(`meta：schema=${ctx.meta.schema} dims=${ctx.meta.dims} chunks=${ctx.meta.chunks} 游标=${Object.keys(ctx.meta.cursors ?? {}).length} 个`);
  say(`序号表：已发出 ${ctx.ordinals.count} 个（只增不复用；清库重建后旧序号按 renumbered 改绑）`);
  say('');
  say('每 peer 榜长（别名只在本机有意义）：');
  // 这里按**原值直接相等**计数，不走 samePeer：后者对 unknown 恒 false（fail-closed 的正确行为），
  // 拿它分组会把那批整块吞掉、总数对不上还看不出来。取数路径（check/run/questions）照旧走 samePeer。
  let listed = 0;
  for (const [alias, peer] of Object.entries(ctx.peerMap)) {
    const scoped = ctx.rows.filter((row) => row.peer === peer);
    listed += scoped.length;
    const hers = scoped.filter((row) => row.role === 'akane').length;
    say(`  ${alias}  榜长=${String(scoped.length).padStart(5)}　她说的=${String(hers).padStart(5)}　对方说的=${String(scoped.length - hers).padStart(5)}`
      + (peer === UNKNOWN_PEER ? '　← unknown：写入侧已知缺口，读侧永不可召回（这些榜长召不回来，别当素材）' : ''));
  }
  say(`  合计 ${listed} / 索引 ${ctx.rows.length} 条${listed === ctx.rows.length ? '（对得上）' : '　⚠ 对不上：分组口径有漏'}`);
  const lengths = ctx.rows.map((row) => row.textLen).sort((a, b) => a - b);
  const at = (fraction) => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * fraction))] ?? 0;
  say('');
  say(`chunk 字数：min=${lengths[0] ?? 0} p50=${at(0.5)} p90=${at(0.9)} max=${lengths[lengths.length - 1] ?? 0}`);
  for (const edge of [20, 40, 80, 160, 320, 640]) {
    const n = lengths.filter((value) => value <= edge).length;
    say(`  ≤${String(edge).padStart(3)} 字：${String(n).padStart(4)} 条（${((100 * n) / lengths.length).toFixed(1)}%）`);
  }
  // unknown 归属的行永不可召回 —— 拿它出题只能得出一条恒「没查到」的假题，所以候选池先剔掉
  const recallable = (row) => row.peer !== UNKNOWN_PEER;
  const pool = ctx.rows.filter((row) => row.role === 'peer' && row.textLen <= 40 && recallable(row));
  say('');
  say(`可直接当问法候选（对方说的、≤40 字、归属可召回）：${pool.length} 条`);
  if (pool.length < 20) say(`  ⚠ 距 §6 的「≥20 条真实问法」还差 ${20 - pool.length} 条 —— 缺口只能你手写（真实说法，不是 chunk 原文）。`);
  say(`下一步：node scripts/akane-recall-eval.mjs questions --peer A`);
}

async function cmdQuestions() {
  const wantAlias = opt('peer', undefined);
  const maxlen = Number(opt('maxlen', 80));
  const cap = Number(opt('cap', 200));
  // 默认两种角色都给：问「她上次说过啥」时期望命中是她那条（role=akane），只列对方说的话会漏掉一半素材
  const wantRole = String(opt('role', 'both'));
  const roleOk = (row) => wantRole === 'both' ? true : (wantRole === 'peer' || wantRole === 'akane') && row.role === wantRole;
  if (!['both', 'peer', 'akane'].includes(wantRole)) fail(`--role 只认 both / peer / akane，收到 ${wantRole}`);
  const ctx = await context();
  const target = wantAlias === undefined ? undefined : ctx.peerMap[wantAlias];
  if (wantAlias !== undefined && target === undefined) fail(`没有别名 ${wantAlias}（先跑 inspect 看有哪些）`);
  if (target === UNKNOWN_PEER) fail('别名指向 unknown：那批永不可召回，抽出来的题只能得出一条恒「没查到」的假题。');
  const pool = ctx.rows
    .filter((row) => roleOk(row) && row.peer !== UNKNOWN_PEER
      && row.textLen <= maxlen && (target === undefined || samePeer(row.peer, target)))
    .sort((a, b) => b.time - a.time)
    .slice(0, cap);
  // 同一 session 的邻居序号：标「期望命中」时最常连带选上，省得用户自己翻
  const neighbors = new Map();
  for (const row of ctx.rows) {
    const list = neighbors.get(row.sessionId) ?? [];
    list.push(row);
    neighbors.set(row.sessionId, list);
  }
  const file = join(WORK_DIR, `candidates-${new Date().toISOString().slice(0, 10)}.jsonl`);
  writePrivate(file, `${pool.map((row) => JSON.stringify({
    ordinal: ctx.ordinals.ordinalOf(row.key),
    role: row.role,
    peer: ctx.aliasOf[row.peer],
    time: new Date(row.time).toISOString(),
    sha: sha8(row.text),
    seqRange: [row.seqStart, row.seqEnd],
    neighbors: (neighbors.get(row.sessionId) ?? [])
      .filter((item) => item.key !== row.key && Math.abs(item.seqStart - row.seqStart) <= 2)
      .map((item) => ({ ordinal: ctx.ordinals.ordinalOf(item.key), role: item.role, seq: item.seqStart }))
      .sort((a, b) => a.seq - b.seq),
    text: row.text,
  })).join('\n')}\n`);
  const hers = pool.filter((row) => row.role === 'akane').length;
  say(`候选 ${pool.length} 条（她说的 ${hers} / 对方说的 ${pool.length - hers}，≤${maxlen} 字）→ ${short(file)}`);
  say('  该文件含正文，0600，只落 ~/.akane-eval/work/，不入库、不进 git。');
  say(`照它把「问法 + 期望命中的序号」抄进 ${short(QUESTIONS_FILE)}，然后 check、再 run。`);
  say('要边看边挑就自己重跑一次并加：--show-text --i-am-the-user（必须你本人在终端里）。');
  if (has('show-text')) {
    if (!process.stdout.isTTY || !has('i-am-the-user')) {
      fail('--show-text 需要 stdout 是 TTY 且同时给 --i-am-the-user（正文不许进会话记录）');
    }
    for (const row of pool) {
      process.stdout.write(`  #${ctx.ordinals.ordinalOf(row.key)} [${ctx.aliasOf[row.peer]}/${row.role}] ${row.text.slice(0, 60)}\n`);
    }
  }
}

async function cmdCheck() {
  const questions = readQuestions();
  const ctx = await context();
  let problems = 0;
  say(`题库 ${questions.length} 条：`);
  for (const question of questions) {
    const peer = ctx.peerMap[question.peer];
    const scoped = peer === undefined ? [] : ctx.rows.filter((row) => samePeer(row.peer, peer));
    const tokens = queryTokens(question.query);
    const bad = [];
    if (peer === undefined) bad.push(`未知别名 ${question.peer}`);
    if (peer === UNKNOWN_PEER) bad.push('别名指向 unknown');
    if (tokens.length === 0) bad.push('切不出词元');
    for (const ordinal of [...question.expected, ...question.rejects]) {
      const verdict = resolveOrdinal(ordinal, ctx.ordinals, ctx.rowsByKey, ctx.rows);
      if (verdict.status !== 'ok' && verdict.status !== 'renumbered') bad.push(`${ordinal}=${verdict.status}`);
      else if (verdict.status === 'renumbered') bad.push(`${ordinal}→重编号为 ${verdict.to}`);
      else if (!scoped.some((row) => row.key === verdict.key)) bad.push(`${ordinal} 跨 peer`);
    }
    const self = peer === undefined ? { state: 'none' } : selfMatch(scoped, question.query);
    if (self.state === 'ambiguous') bad.push(`自块歧义(${self.count} 条同文)`);
    const literal = tokens.length === 0 ? 0 : scoped.filter((row) => matchesLiteral(row.text, tokens)).length;
    if (bad.length === 0 && literal === 0) bad.push('字面档 0 命中（这题只考语义档）');
    if (bad.length > 0) problems += 1;
    say(`  #${String(question.no).padStart(3)} peer=${question.peer} 词元=${tokens.length} 字面命中=${String(literal).padStart(3)}`
      + ` 自块=${self.state.padEnd(9)} ${bad.length === 0 ? 'ok' : bad.join(' / ')}`);
  }
  say('');
  if (questions.length < 20) say(`⚠ 只有 ${questions.length} 条：§6 的门槛是 20 条真实问法，不足时任何扫参结论都不成立。`);
  say(problems === 0 ? '全部可跑。' : `${problems} 条需要注意 —— 先修题库再 run（否则分母与口径都不对）。`);
}

async function cmdRun() {
  const questions = readQuestions();
  const specs = multi('arm');
  const base = specs.length === 0 ? [{ ...PRODUCTION, label: '现网' }] : specs.map(parseArm);
  const plans = has('keep-self')
    ? base.flatMap((arm) => [{ ...arm, excludeSelf: false }, { ...arm, excludeSelf: true, label: `${arm.label}·摘` }])
    : base.map((arm) => ({ ...arm, excludeSelf: true }));
  const e2eAll = has('e2e-all');
  // e2e 至少跑一臂：找不到与现网同形的臂就退到第一臂，不然「手工链 vs 真 recallOnce」这条对照会静默消失，
  // 而它是这张表唯一的口径守卫。
  const matchedArm = plans.findIndex((arm) => arm.limit === PRODUCTION.limit
    && arm.floor === PRODUCTION.floor && arm.rrfK === PRODUCTION.rrfK && arm.poolFactor === PRODUCTION.poolFactor);
  const e2eArm = has('no-e2e') ? -1 : (matchedArm >= 0 ? matchedArm : 0);
  if (!has('no-e2e')) {
    const health = await probeEmbedHealth(EMBED);
    if (!health.ok) fail(`embedding 服务不可达（code=${health.code}）：查询向量算不出来，整张表作废。起停归用户。`);
  }
  const ctx = await context();
  const started = Date.now();
  const results = [];
  const dropped = [];
  let embeds = 0;

  for (const question of questions) {
    const peer = ctx.peerMap[question.peer];
    if (peer === undefined) { dropped.push({ no: question.no, why: `未知别名 ${question.peer}` }); continue; }
    if (peer === UNKNOWN_PEER) { dropped.push({ no: question.no, why: '别名指向 unknown（结构上召不回）' }); continue; }
    const tokens = queryTokens(question.query);
    if (tokens.length === 0) { dropped.push({ no: question.no, why: '问法切不出词元' }); continue; }

    const notes = [];
    const expectedKeys = [];
    let dead = false;
    for (const ordinal of question.expected) {
      const verdict = resolveOrdinal(ordinal, ctx.ordinals, ctx.rowsByKey, ctx.rows);
      if (verdict.status === 'ok') expectedKeys.push(verdict.key);
      else if (verdict.status === 'renumbered') {
        expectedKeys.push(verdict.key);
        notes.push(`#${ordinal}→#${verdict.to}`);
      } else { dead = true; dropped.push({ no: question.no, why: `期望序号 ${ordinal} ${verdict.status}` }); break; }
    }
    if (dead) continue;

    const scoped = [];
    const scopedVectors = [];
    ctx.rows.forEach((row, position) => {
      if (samePeer(row.peer, peer)) { scoped.push(row); scopedVectors.push(ctx.vectors[position]); }
    });

    const inject = await embedTexts([question.query], EMBED);
    embeds += 1;
    if (!inject.ok) { dropped.push({ no: question.no, why: `嵌入失败 code=${inject.code}` }); continue; }
    const vector = inject.vectors[0];
    if (vector === undefined) { dropped.push({ no: question.no, why: '嵌入返回空向量' }); continue; }

    const board = fullBoard(scoped, scopedVectors, Float32Array.from(vector));
    const self = selfMatch(scoped, question.query);
    if (self.state === 'ambiguous') { dropped.push({ no: question.no, why: `自块歧义 ${self.count} 条` }); continue; }

    const row = {
      no: question.no,
      peer: question.peer,
      scoped: scoped.length,
      board: board.length,
      tokens: tokens.length,
      self: self.state,
      expected: expectedKeys.length,
      notes,
      arms: [],
    };
    for (const [index, plan] of plans.entries()) {
      const exclude = plan.excludeSelf ? self.key : undefined;
      const lane = armLane(board, scoped, tokens, plan, exclude);
      const raw = plan.excludeSelf ? armLane(board, scoped, tokens, plan, undefined) : lane;
      const ranks = expectedKeys.map((key) => rankOf(lane.keys, key)).filter((value) => value !== undefined);
      const rawRanks = expectedKeys.map((key) => rankOf(raw.keys, key)).filter((value) => value !== undefined);
      const rejectKeys = question.rejects
        .map((ordinal) => resolveOrdinal(ordinal, ctx.ordinals, ctx.rowsByKey, ctx.rows))
        .filter((verdict) => verdict.status === 'ok' || verdict.status === 'renumbered')
        .map((verdict) => verdict.key);
      // 榜下 = floor 以下那批里期望块的条数。这是现网返回体结构性看不见、只有整榜能算的一栏。
      const belowFloor = board.filter((item) => item.score < plan.floor && expectedKeys.includes(item.key)).length;
      // 池外 = 过了 floor 但排在 limit×pool 之外。必须拿「过线序列的切片」比，
      // 早先用 laneLength（切片长度）当分母去减 inPool，条数一少就恒为 0，等于这栏白写。
      const passed = board.filter((item) => item.score >= plan.floor);
      const inPool = new Set(passed.slice(0, plan.limit * plan.poolFactor).map((item) => item.key));
      const beyondPool = expectedKeys.filter((key) => passed.some((item) => item.key === key) && !inPool.has(key)).length;
      row.arms.push({
        label: plan.label,
        best: ranks.length === 0 ? undefined : Math.min(...ranks),
        median: median(ranks),
        hit: ranks.length > 0,
        rawBest: rawRanks.length === 0 ? undefined : Math.min(...rawRanks),
        belowFloor,
        beyondPool,
        returned: lane.keys.length,
        // 误召 = 用户标了「这条不算」的 chunk 真进了返回体。§6 第 2 条要的就是这个数：
        // 「命中率上去了、误召也上去了」不是改进。
        badHit: rejectKeys.filter((key) => lane.keys.includes(key)).length,
        e2eHits: index === e2eArm ? undefined : 'skip',
      });
    }
    if (e2eArm >= 0) {
      const live = await endToEnd(question.query, peer, plans[e2eArm]);
      embeds += 1;
      row.arms[e2eArm].e2eHits = live.hits;
      row.arms[e2eArm].degraded = live.degraded;
    }
    if (e2eAll) {
      for (const [index, plan] of plans.entries()) {
        if (index === e2eArm) continue;
        const live = await endToEnd(question.query, peer, plan);
        embeds += 1;
        row.arms[index].e2eHits = live.hits;
      }
    }
    results.push(row);
    say(`  #${String(row.no).padStart(3)} 榜长=${String(row.board).padStart(4)} 自块=${row.self.padEnd(9)}`
      + ` ${row.arms.map((arm) => `${arm.label}:${arm.best ?? 'X'}${arm.e2eHits === 'skip' ? '' : `/e2e${arm.e2eHits}`}`).join(' ')}`
      + (row.notes.length === 0 ? '' : `  (${row.notes.join(' ')})`));
  }

  if (dropped.length > 0) {
    say('');
    say(`剔除 ${dropped.length} 条（不计入分母，原因都在这）：`);
    for (const item of dropped) say(`  #${String(item.no).padStart(3)} ${item.why}`);
  }
  if (results.length === 0) fail('没有一条题可跑，表是空的 —— 先 check。');

  const summary = plans.map((plan, index) => {
    const list = results.map((item) => item.arms[index]);
    const e2e = list.filter((item) => typeof item.e2eHits === 'number');
    return {
      ...plan,
      n: results.length,
      hits: list.filter((item) => item.hit).length,
      medianBest: median(list.map((item) => item.best)),
      medianRaw: median(list.map((item) => item.rawBest)),
      mrr: list.reduce((sum, item) => sum + (item.best === undefined ? 0 : 1 / item.best), 0) / results.length,
      // 两种「没送到」要分开：榜上有但排在 limit 之外 = 池子太窄；压根没上榜 = 阈值/向量问题
      outOfLimit: list.filter((item) => item.best !== undefined && item.best > plan.limit).length,
      badHit: list.reduce((sum, item) => sum + item.badHit, 0),
      belowFloor: list.reduce((sum, item) => sum + item.belowFloor, 0),
      beyondPool: list.reduce((sum, item) => sum + item.beyondPool, 0),
      returned: median(list.map((item) => item.returned)),
      e2e: e2e.length === 0 ? undefined : { mean: e2e.reduce((sum, item) => sum + item.e2eHits, 0) / e2e.length, returned: median(e2e.map((item) => item.returned)) },
    };
  });

  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const selfTest = questionsSource !== '题库（用户标注）';
  const report = join(REPORT_DIR, `${selfTest ? 'selftest-' : ''}${stamp}.md`);
  const lines = [
    '# 召回扫参表（离线）',
    '',
    `- 题源：${questionsSource}`,
    `- 生成 ${stamp}　耗时 ${((Date.now() - started) / 1000).toFixed(1)}s　嵌入 ${embeds} 次（阶段 A 每题 1 次 + e2e 每题 ${e2eArm >= 0 ? (e2eAll ? plans.length : 1) : 0} 次）`,
    `- 索引快照 ${ctx.rows.length} 条 chunk / schema ${ctx.meta.schema} / dims ${ctx.meta.dims} / 游标 ${Object.keys(ctx.meta.cursors ?? {}).length} 个（本表只读，未改索引一个字节）`,
    `- 题库 ${questions.length} 条 → 参与统计 ${results.length} 条 → 剔除 ${dropped.length} 条（原因见 stdout）`,
    `- 现网默认 floor=${PRODUCTION.floor} pool=limit×${PRODUCTION.poolFactor} k=${PRODUCTION.rrfK} limit=${PRODUCTION.limit}；`
      + `返回体硬顶 ${MAX_RETURN_CHARS} 字、单片段 ${MAX_FRAGMENT_CHARS} 字（§4，单位是字符不是 token）`,
    '- 这四个数**全是临时值**（§6 第 2 条）。**样本 < 20 时本表只能当观察，不许据此改任何一个数。**',
    '',
    '| 臂 | 旋钮 | 摘<br>自块 | 有效<br>n | 命中<br>数 | 中位<br>最佳位次 | 不摘时<br>中位 | MRR | limit<br>外 | 误召 | 榜下<br>期望条数 | 池外<br>期望条数 | 中位<br>返回 | e2e<br>hits |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summary.map((item) => `| ${item.label} | floor ${item.floor} / pool ${Number.isFinite(item.poolFactor) ? item.poolFactor : 'inf'} / k ${item.rrfK} / limit ${item.limit} `
      + `| ${item.excludeSelf ? '是' : '否'} | ${item.n} | ${item.hits}（${((100 * item.hits) / item.n).toFixed(0)}%） `
      + `| ${item.medianBest ?? '-'} | ${item.medianRaw ?? '-'} | ${item.mrr.toFixed(3)} | ${item.outOfLimit} | ${item.badHit} | ${item.belowFloor} | ${item.beyondPool} `
      + `| ${item.returned ?? '-'} | ${item.e2e === undefined ? '未跑' : `${item.e2e.mean.toFixed(2)} vs ${item.e2e.returned}`} |`),
    '',
    '读法：',
    '- **榜下期望条数 > 0** ⇒ floor 往下调确实能多捞回这批（当前太紧）。**= 0 而命中率仍低 ⇒ 调低 floor 只会放进噪声，不许调**（§9 测试 11 的反面）。',
    '- **池外期望条数 > 0** ⇒ `pool` 倍数是瓶颈，先放宽它再谈 floor。两条都为 0 ⇒ 问题在向量/分块，不在阈值。',
    '- **limit 外** = 榜上有、但排在返回条数之外 ⇒ 该动 `limit`；**误召** = 用户标了「这条不算」的 chunk 真进了返回体。',
    '- 「不摘时中位」优于「中位最佳位次」的差额 = 自块虚高幅度；主口径只认摘自块那一列。',
    '- `e2e hits vs 中位返回` 两列不等 ⇒ 手工链与现网链已分叉，本表作废（守卫在 `recall-tool.test.ts`，先修它再重跑）。',
    results.length < 20 ? `⚠ 有效样本 ${results.length} < 20：本表只当观察，§6 的改阈值门槛没达到。` : '',
    '',
    '## 逐题位次',
    '',
    '| 题 | peer | 榜长 | 词元 | 自块 | ' + plans.map((plan) => plan.label).join(' | ') + ' |',
    '| --- | --- | --- | --- | --- |' + plans.map(() => ' ---').join('') + ' |',
    ...results.map((item) => `| #${item.no} | ${item.peer} | ${item.board} | ${item.tokens} | ${item.self} | `
      + item.arms.map((arm) => `${arm.best ?? 'X'}${arm.rawBest !== arm.best ? `(${arm.rawBest ?? 'X'})` : ''}`).join(' | ') + ' |'),
    '',
  ];
  writePrivate(report, `${lines.filter((line) => line !== '').join('\n')}\n`);
  // 报告不过 say()（它含 sha 与序号，都是本机私有的派生标识），但 stdout 逐行要过
  say('');
  say(`报告：${short(report)}　（不含正文；含序号与 sha8）`);
  const headerEnd = lines.findIndex((line) => line.startsWith('## 逐题位次'));
  for (const line of lines.slice(0, headerEnd)) {
    for (const part of line.split('\n')) say(part);
  }
}

/**
 * 闸门自身的守卫：脏样本必须全拦、净样本必须全放行。
 *
 * 这条子命令存在的原因是「最后一道防线没人验过 = 没有防线」。它自己**不经过** `say()` 打印
 * 任何脏样本（只报下标），否则测试本身就是泄漏点。
 */
async function cmdLeakGate() {
  probeMode = true;
  const real = process.stdout.write.bind(process.stdout);
  let sink = '';
  process.stdout.write = (chunk) => { sink += String(chunk); return true; };
  const passedDirty = [];
  DIRTY_SENTINELS.forEach((sample, index) => {
    sink = '';
    try {
      say(sample);
      passedDirty.push(index + 1);
    } catch { /* 期望：拦下 */ }
    if (sink !== '') passedDirty.push(`#${index + 1} 拦了但仍写了 stdout`);
  });
  const wrongClean = [];
  CLEAN_SENTINELS.forEach((sample, index) => {
    sink = '';
    try {
      say(sample);
      if (!sink.includes(sample)) wrongClean.push(`#${index + 1} 没写出`);
    } catch {
      wrongClean.push(`#${index + 1} 被误拦`);
    }
  });
  process.stdout.write = real;
  probeMode = false;
  real(`脏样本 ${DIRTY_SENTINELS.length} 条：拦下 ${DIRTY_SENTINELS.length - passedDirty.length} 条`);
  real(`净样本 ${CLEAN_SENTINELS.length} 条：放行 ${CLEAN_SENTINELS.length - wrongClean.length} 条`);
  if (passedDirty.length > 0) real(`  ⚠ 漏过：${passedDirty.join(' / ')}`);
  if (wrongClean.length > 0) real(`  ⚠ 误伤：${wrongClean.join(' / ')}`);
  if (passedDirty.length > 0 || wrongClean.length > 0) fail('闸门不合格');
  real('闸门自检通过：脏的出不去、净的不会被误杀。');
}

// ---------------------------------------------------------------- 组装

async function context() {
  ensureDirs();
  const index = await loadReadOnly();
  const ordinals = syncOrdinals(index.rows);
  const { map, aliasOf } = peerAliases(index.rows);
  const rowsByKey = new Map(index.rows.map((row) => [row.key, row]));
  return { ...index, ordinals, peerMap: map, aliasOf, rowsByKey };
}

const DISPATCH = { inspect: cmdInspect, questions: cmdQuestions, check: cmdCheck, run: cmdRun, leakgate: cmdLeakGate };

try {
  const handler = DISPATCH[sub];
  if (handler === undefined) fail(`未知子命令 ${sub}（可用 inspect / questions / check / run / leakgate）`);
  await handler();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // 异常文本常带路径或正文（fs 的 ENOENT 会把整条路径打出来）——命中闸门就只报长度
  const dirty = LEAK_PATTERNS.some(([pattern]) => pattern.test(message));
  fail(dirty ? `出错，详情含主机标识不外泄（长度 ${message.length} 字符；本机看 ~/.akane-eval）` : message);
}
