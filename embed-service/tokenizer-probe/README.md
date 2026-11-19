# tokenizer-probe —— 349 条分词基准的生成器与对拍脚本

`embed-service/tokenizer-golden.json` 是**产物**（349 行，2250 个 token，`ref` 记的是
python `tokenizers` 的 Rust 参考实现），由这里的 `gen_golden.py` 生成。守卫是上一层的
`verify-tokenizer.mjs`——换模型、升级依赖、动权重之后必须先跑它，0 错才允许重建索引。

**为什么这些脚本要进仓库**：此前它们只在 `/tmp/akane-token-check/` 里，路径还写死成
`/tmp/bge-node-probe/models/...`，一重启就没了。AGENTS.md 要求「换模型/升级依赖后必须
重跑对拍」，而没有生成器就只剩一份无法复现的基准 —— 那等于把地基交给运气。

11-19 21:30 本机实跑，三个数都对得上（这也是这批脚本仍可用的证明）：

| 跑法 | 结果 |
| --- | --- |
| `python3 gen_golden.py` | 349 行 / 2250 token，逐行逐 id 与仓库里那份一致 |
| `node hfjs_check.mjs` | `mismatch: 0` —— 现网通路（官方纯 JS `@huggingface/tokenizers@0.2.0`） |
| `node js_check.mjs` | `mismatch: 202` —— 历史对照（`bge-node-probe.mjs` 那套手写 WordPiece） |
| `node ../verify-tokenizer.mjs` | `mismatch: 0` —— 守卫本身 |

## 各文件是什么

- `gen_golden.py` —— 生成语料 + HF 参考基准（确定性，`random.seed(20261119)`，不依赖网络）。
  覆盖类：纯中文、中英混排、ASCII 标点粘连、全角、控制字符、变音符、大写、emoji/星平面、
  零宽、超长词（>100 字符）、纯标点、空串、空白串、QQ 形状文本（`<@!123>`、`【表情: 开心】`、
  时间戳、URL）。**输出默认写到本目录 `golden.json`（已 gitignore）**，确认无误才手工覆盖
  上一层那份正本 —— 别让它直接写进去。
- `corpus.json` —— 早期那 42 行清单（`sentences`），`gen_golden.py` 的 BASE 部分同源。
- `ref_dump.py` —— 早期 42 行清单的 python 侧 dump，**历史证据**。它写的 schema 与正本不同
  （`ref` 是 python 版本号、多带 `truncation`、`indent=1`），所以输出单独落
  `golden-ref-dump.json`；用它覆盖正本会把 349 行基准换成 42 行。
- `hfjs_check.mjs` —— **现网通路的对拍**：官方纯 JS `Tokenizer(tokenizer.json,
  tokenizer_config.json)` 逐条比 id。`verify-tokenizer.mjs` 是它的仓库化版本。
- `js_check.mjs` —— 手写 WordPiece 的复刻比对，用来复现「202 条错」这个结论。留着是因为
  将来有人想再手写一遍分词时，这里就是反例的第一手依据。
- `official_check.cjs` —— 探「同一个包名的原生（Rust 绑定）构建能不能直接吃
  `tokenizer.json`」，用的是 `Tokenizer.fromFile` 这套 API，与现网装的纯 JS 那份不是同一个
  实现。**要单独指目录**：`AKANE_TK_OFFICIAL_DIR=<装了原生构建的目录> node official_check.cjs`，
  没给就直接退出 2 —— 它不是任何一条通路的守卫，别把它当守卫跑。

## 路径与变量

三个脚本都不再写死绝对路径，一律相对本文件定位：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `AKANE_EMBED_MODEL_DIR` | `../model` | `tokenizer.json` / `tokenizer_config.json` 所在处（与 `install.mjs`、`server.mjs` 同一个变量） |
| `AKANE_TOKENIZER_GOLDEN` | `../tokenizer-golden.json` | 比对基准 |
| `AKANE_TOKENIZER_GOLDEN_OUT` | `./golden.json` | `gen_golden.py` 的候选输出 |
| `AKANE_TK_OFFICIAL_DIR` | 无（`official_check.cjs` 必需） | 原生构建的安装目录 |

`python3` 侧需要 `tokenizers`（本机实测 0.23.3）；这一份只用于生成基准，不进运行时 —— 现网
推理路径碰不到 python。
