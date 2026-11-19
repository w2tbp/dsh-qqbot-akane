# embed-service —— 本机常驻 embedding 服务

akane 记忆库的语义档依赖它。它**是一个独立进程**，不是 `dsh web` 的一部分：ONNX 推理
塞进插件进程会把她的回复拖慢，而这条通路一旦不可用，召回只是降级成字面档，不该连插件
一起下线。（设计正本在项目根 `MEMORY.md`，那份在 git 库之外，所以这里只给结论不给锚点。）

模型：`Xenova/bge-small-zh-v1.5`，ONNX **q8** 单精度量化版，输出 512 维、L2 归一化。
fp32（94.9MB）不进项目资产，只保 q8（24,010,842B）。

## 运行前提：只有 Node

唯一需要预装的是 **Node ≥ 22**（`package.json` 的 `engines`；本机实测 v22.20.0），
以及 PATH 里能敲到 `npm`。**不需要 python、不需要 torch、不需要 CUDA，也没有任何原生
编译依赖**：`onnxruntime-web` 在 Node 里走 WASM，`@huggingface/tokenizers` 是纯 JS，
两个包三平台共用同一份产物 —— 所以 Windows 装它不会因为 node-gyp / VS Build Tools 卡住。
推理代码本身是平台无关的，Windows 那一边只多两件事：安装脚本（`install.mjs` 是纯 Node，
不调 `curl` / `sha256sum` / `find`）和启停脚本（`start.ps1` / `stop.ps1`）。

> Windows 上装 Node 用官方 .msi 或 `winget install OpenJS.NodeJS.LTS` 都行，装完重开
> 一个终端确认 `node -v`。这一步归你，脚本不代劳。

## 安装

```bash
# Linux / macOS
cd embed-service && ./install.sh

# Windows（PowerShell）—— install.sh 只是 install.mjs 的薄壳，直接敲 mjs 完全等价
cd embed-service; node install.mjs
```

`install.sh` 内部就是 `exec node install.mjs "$@"`，两个文件都收同一套参数。装两件东西：
依赖（`onnxruntime-web@1.17.3` + `@huggingface/tokenizers@0.2.0`，版本锁死）和权重
（下到 `./model/`，按 size + sha256 校验）。**可重入**：已校验过的文件直接跳过，重复跑
没有副作用。权重来源按「`./model/` 已就位 → 本地 HF 缓存 → 镜像下载」三处轮询，每处都
用同一份 sha256 判定，所以 `huggingface-cli` 以前下过的话不会重复下载。

参数与环境变量：

| 项 | 作用 |
| --- | --- |
| `--model-dir <路径>` / `AKANE_EMBED_MODEL_DIR` | 权重目录（默认 `./model`）。Windows 上放别处就用它 |
| `--mirror <url>` / `AKANE_EMBED_MIRROR` | 权重镜像，默认 `https://hf-mirror.com` |
| `--registry <url>` / `AKANE_EMBED_NPM_REGISTRY` | npm 镜像源（npm 自己认的 `npm_config_registry` 也照常生效） |
| `--revision <sha>` / `AKANE_EMBED_REVISION` | 权重 revision；改它等于换文件身份，务必同时核对 sha256 |
| `--skip-deps` | 只补权重，不跑 `npm install` |
| `--skip-selftest` | 跳过自检（排障用；正常装机别跳） |

国内网络的两条既定事实（不是抖动，别反复重试）：

- `huggingface.co` 不可达 → 默认走 `https://hf-mirror.com`。
- 代理：**Node 的全局 `fetch` 不读 `HTTPS_PROXY`**（curl 读），所以脚本里自己写了
  CONNECT 隧道，只认 `HTTPS_PROXY` / `https_proxy`，并按 `NO_PROXY` 的主机规则直连
  （全局代理 + 内网镜像源这台机器上真有人这么配）。`HTTP_PROXY` 不参与 —— 权重全走
  https，用不上它。npm 那一跳是 npm 自己发请求，代理配在 npm 里。
- 镜像对连续拉取会回 **429**（本机实测），所以下载带重试：408/429/5xx 与超时/断连退避
  5s、10s 各重一次；404 这类明确失败**不重试**（revision 写错要立刻看见）。

装完脚本会自动跑下面两个自检，任一失败即非零退出。

## 启动与停止（归用户）

插件**不 spawn、不自愈、不 kill** 这个进程。启停由你负责：

```bash
# Linux / macOS
cd embed-service
./start.sh          # 起（后台、pid 文件、轮询 /health 最多 30s）
./stop.sh           # 停
./start.sh -p 9000  # 换端口，stop 用同一个 -p
```

```powershell
# Windows：后台起 + pid 文件 + 轮询 /health 最多 30s
cd embed-service
powershell -ExecutionPolicy Bypass -File .\start.ps1 -Port 8765
powershell -ExecutionPolicy Bypass -File .\stop.ps1  -Port 8765
```

`start.sh` / `stop.sh` 与 `start.ps1` / `stop.ps1` 是同语义的一对，不是两套习惯：
`~/.akane-embed.pid`、`/health` 轮询、独立错误日志、**按命令行特征（`server.mjs --port <端口>`）
认进程**。`stop.sh` 拿到候选后还会逐个重读 `ps -o args=` 再核对一次特征才动手，匹配不到就只打
「不动任何进程」——**绝不做全局 node 匹配**，那会顺手端掉 `dsh web`。`/health` 有响应时
`start.sh` 拒绝起第二个。手工等价写法（脚本就是这几步）：

```bash
setsid nohup node server.mjs > ~/.akane-embed.log 2>&1 < /dev/null &   # 起
kill "$(cat ~/.akane-embed.pid)"                                        # 停
```

`start.ps1` 把 pid 写到 `%USERPROFILE%\.akane-embed.pid`，日志（含轮转）写
`%LOCALAPPDATA%\.dsh-qqbot-akane\embed-service\`；已在跑就拒绝起第二个。`stop.ps1` 先认
pid 文件，文件没了才按命令行特征（`embed-service*server.mjs*--port <端口>`）找进程，
匹配不到就报「没找到」——**不做全局 node 匹配**，否则一条 `Get-Process node` 会把
`dsh web` 一起端掉。`-Threads` 与 `-ModelDir` 两边同名可传。

- 默认 `127.0.0.1:8765`；`--port 9000` 或 `AKANE_EMBED_PORT=9000` 改端口。
- **只绑回环，`HOST` 连配置都不读**。送进 `/embed` 的就是聊天正文，绑 `0.0.0.0`
  等于把这个接口开放给整栋楼。改端口可以，改监听地址不行。
- `AKANE_EMBED_THREADS` 调 WASM 线程数，默认 1（本机单线程已经够用：见下面「实测数字」）。
- 日志只打批次条数、维度、耗时、RSS —— 正文一个字符都不写。

**两条通路的诚实状态**：`install.mjs` 的下载三路线、重试、隧道与拒绝分支，以及
`start.sh` / `stop.sh`（真起、空跑不动进程、真停三条分支）都在本机（Linux）实跑过，
`install.sh` 对参数是原样透传；`start.ps1` / `stop.ps1` **没有 Windows 机器可实跑**，
`onnxruntime-web` 的 WASM 在 Windows 上的表现也没验过。Windows 装机遇到问题时这两条
是第一嫌疑，别当成已验证的通路。

## 接口

```
GET  /health  →  {"ok":true,"model":"Xenova/bge-small-zh-v1.5","dims":512}
POST /embed   →  入参 {"texts":["…","…"]}
                 出参 {"ok":true,"model":"…","dims":512,"vectors":[[…512 个 float…],…]}
```

`vectors` 与 `texts` **同序等长**（索引侧靠这个对齐写 `vectors.f32.bin`）。
守住的几条：单批 ≤64 条（超出 400）、请求体 ≤4MB（超出即断开）、`texts` 必须是非空的
字符串数组（否则 400）；单条超过 4000 字符先按字符裁一刀（**不是报错**），推理前再按
`tokenizer_config.json` 的 `model_max_length`（本模型 512）**做 token 级右侧截断**并保住
`[CLS] … [SEP]` —— 这一刀是 11-19 现网补上的：不截断时超 512 token 的输入会撑爆 Bert 位置
编码，而 WASM 后端抛的是**原生异常**（一个数字指针，`err.message` 都没有），服务只能回
500 `INFERENCE_FAILED`。代价是**长文本只有前 512 token 进向量**（尾部仍能被插件侧字面档命中）。
其他路径一律 404（不提供任何「顺手」的能力），推理抛异常回 500 `INFERENCE_FAILED` 且日志只留错误类别。

## 自检

```bash
node verify-tokenizer.mjs   # 349 条分词与 HF 参考实现对拍，必须 0 错
node selftest.mjs           # 相关句对 vs 无关句对（minRelated > maxUnrelated）+ 长文必须被截断而不是抛异常
```

`verify-tokenizer.mjs` 是整条索引的地基守卫：**分词必须与建索引时同一实现**，
否则余弦没有意义。手写 WordPiece 在同一批对拍里 349 条错 202 条（ASCII 标点、英文
大小写、空白、码点 >64k 全错），所以这里用官方纯 JS `@huggingface/tokenizers`
（同一批 0 错）。升级 onnxruntime / tokenizers、换模型、动权重，都要先跑它。

上面那份 349 行基准是产物，**生成器和两条比对通路在 [`tokenizer-probe/`](./tokenizer-probe/README.md)**
（此前只在 `/tmp` 里且路径写死，重启即失）。重跑法与今天对上的三个数都写在那份 README 里。

## 实测数字（11-19，本机单线程 q8）

| 项 | 实测 |
| --- | --- |
| 载入 | `loadMs` 644–691 |
| 冷启动后 RSS | 229–435 MB（两次冷启动的区间，别当恒定值） |
| 单批嵌入 | batch=1 19ms，batch=2 30–77ms，batch=8 120ms（都是短句） |
| 单批嵌入（长文） | **满 512 token 宽约 625ms/行**：1 行 759ms、4 行 2525ms、8 行 4996ms、16 行 9989ms；RSS 随行数 454→752MB |
| 向量 | 512 维，‖v‖=1 |

**已知限制 1：q8 的余弦随批量形状漂移 ±0.01。** 同一条文本 batch=1 与 batch=8 的向量
自相似 0.995351；同一句对 batch=2 得 0.7457、batch=8 得 0.7562。所以阈值不许贴着
某个分数定。

**已知限制 2：截断让「cos≈1」失去第二种含义。** 两条前 512 token 相同、尾部完全不同的
长文，实测 cos = **1.0000**（截断掉的尾部一个字都不参与）。所以**不许拿余弦当去重判据**——
它现在有两种成因：真重复，或前 512 token 撞车。

## 与插件的契约

插件侧 `config.memory.embedBaseUrl` 必须指回环地址，`src/memory/embed-client.ts`
对非回环直接拒绝（连请求都不发）。服务不可达时：回填跳过这一轮（不重试轰炸），
召回降级成只走字面档并在返回体里写明。**不存在**降级到远程 embedding API 的路径。

`model/` 与 `node_modules/` 都进了 `.gitignore`——权重不进 git，装机靠 `install.mjs`
（`install.sh` 是它的 bash 薄壳，Windows 上用不上 bash 也没关系）。
