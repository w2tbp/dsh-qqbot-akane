<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

**基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 QQ Bot 插件，将 DeepSeek AI 助手接入 QQ 私聊与群聊。**

![fork of @tencent-connect/dsh-qqbot 0.5.5](https://img.shields.io/badge/fork-dsh--qqbot%200.5.5-orange)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)

<br/>

**[English](./README_EN.md) | 简体中文**

扫码加入 QQ 群 / 频道

<table>
<tr>
<td align="center" width="50%"><img src="./assets/docs/qqgroup.jpg" height="360" alt="QQ 群二维码" /><br /><b>QQ 开发者交流群</b><br /><sub>1群: 1032635674 · 2群: 1056948758</sub></td>
<td align="center" width="50%"><img src="./assets/docs/qqchannel.jpg" height="360" alt="QQ 频道二维码" /><br /><b>QQ 开发者社区频道</b><br /><sub>频道号: 20dnumts4z</sub></td>
</tr>
</table>

</div>

## 关于本 fork

本仓库是 `@tencent-connect/dsh-qqbot@0.5.5` 的本地 fork，改动集中在**触发**、**人格**和**群历史的媒体可见性**三处行为，另有一层**默认关闭**的记忆库（§记忆库）；身份全部重命名，**可与原版同时安装在同一个 profile 里互不干扰**（用 `disabled: true` 切换谁在跑）。

| 身份位 | 原版 | 本 fork |
|---|---|---|
| npm 包名 | `@tencent-connect/dsh-qqbot` | `dsh-qqbot-akane` |
| 插件 id | `im-qqbot` | `im-qqbot-akane` |
| 插件管理页标题 | `QQ 机器人 (dsh-qqbot)` | `QQ 机器人 · Akane` |
| 设置页栏目 | 「QQ 机器人」 | 「QQ 机器人 · Akane」 |
| 图标 | `assets/icons/qq_logo.svg` | `assets/icons/akane_qqbot.svg` |
| 数据目录 | `~/.dsh-qqbot` | `~/.dsh-qqbot-akane` |
| 绑定路由 | `/qqbot/im-qqbot/*` | `/qqbot/im-qqbot-akane/*` |
| 视觉 / 发文件工具 | `qqbot_describe_image` / `qqbot_send_file` | `akane_describe_image` / `akane_send_file` |
| 记忆召回工具 | 无 | `akane_recall`（`memory.enabled`，默认关） |

新增能力：群聊唤醒词（§群聊唤醒词，三张表可在设置页直接编辑）、隐式唤醒也带群历史、群历史里的图片可被她看到（§群历史图片）、一句话被拆成几条发时的碎片静默窗口（§碎片静默窗口，四栏可在设置页直接改）、人格文件化热加载（§人格文件）、黑名单硬拦截（§访问控制）、表情包（梗图）回复能力，以及默认关闭的记忆库（§记忆库，需自备本机常驻 embedding 服务）。

```bash
pnpm install && pnpm build
npx @deepseek-ai/dsh plugin --profile <name> add /path/to/dsh-qqbot-akane
```

`dsh plugin add` 走 pnpm link（记录绝对路径），改完源码只需 `pnpm build`，不需要重装。

> **安装坑**：本包的 `cordis.patch.yml` 用 `- insert:` 给出词表与 persona 路径，但 profile 层一旦出现同 id 的 `- id: im-qqbot-akane` 条目，`--dump-config` 里这条就只剩 profile 层列出的键——词表/persona 会看不到。为了不赌合并语义，**profile 条目请把需要的键写全**（凭据可从原版条目复制，`access` 也要带上，否则回落到 `c2cMode: open`）。改完 profile patch 不需要重启，宿主会 HMR 重载插件（日志里会再打一条 `Bot ready!`）。

## 架构

```
QQ 用户 → QQ WebSocket → dsh-qqbot-akane → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)
```

## 安装

### 方式一：桌面版安装（上游原版）

无需命令行，全程在应用内完成：

1. **安装**：左侧栏点击「插件」→「添加插件」→ 输入 `@tencent-connect/dsh-qqbot@latest` → 安装并立即启动

<img src="./assets/docs/install.png" alt="端内添加插件" width="560" />

2. **连接**：左下角头像 → 设置 →「QQ 机器人」→ 手机 QQ 扫码连接

<img src="./assets/docs/setting.png" alt="设置页扫码连接" width="560" />

扫码成功后凭据自动保存，后续启动无需再次扫码。

### 方式二：手动执行

```bash
# 安装到 profile
npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot

# 启动
npx @deepseek-ai/dsh --profile qqbot
```

首次启动时，插件检测到凭据未配置会自动进入扫码引导：终端输出二维码 → 手机 QQ 扫码绑定 → 凭据自动保存到 profile，后续启动无需再次扫码。

无端内绑定页的环境（如纯 CLI）可设置 `QQBOT_BIND_OPEN_BROWSER=1`，额外拉起系统浏览器扫码页作为降级通道。

<img src="./assets/docs/qrcode.png" alt="二维码扫码示意图" width="280" />

> **提示**：建议升级至 `0.4.0` 以上版本扫码，支持点击链接在浏览器打开，避免部分终端二维码渲染错位的问题。

### 方式三：本地路径安装（本 fork 的唯一方式）

```bash
# 构建
cd /path/to/dsh-qqbot-akane
pnpm install && pnpm build

# 安装到 profile（本地路径 → pnpm link）
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-qqbot-akane

# 启动
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh --profile qqbot
```

### 方式四：--patch 开发模式

```bash
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot-akane/cordis.dev.yml
```

## 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appId` | string | **必填** | QQ Bot AppID（或通过 `QQBOT_APPID` 环境变量） |
| `appSecret` | string | **必填** | QQ Bot AppSecret（或通过 `QQBOT_SECRET` 环境变量） |
| `provider` | string | `deepseek-official` | LLM 提供商名称 |
| `model` | string | `deepseek-chat` | 模型名称 |
| `preset` | string | - | Agent preset id |
| `cwd` | string | `process.cwd()` | Agent 工作目录 |
| `requireMention` | boolean | `true` | 群聊是否需要 @bot 或唤醒词才触发 |
| `wakeWords` | string[] | `[]` | 群聊隐式唤醒词（强词），见「群聊唤醒词」 |
| `wakeWordsWeak` | string[] | `[]` | 群聊隐式唤醒词（弱词，需呼格信号） |
| `wakeWordExcludes` | string[] | `[]` | 唤醒排除片段（熊猫/猫粮一类复合词） |
| `personaGroupFile` | string | `''` | 群聊人格文件（空=不注入），见「人格文件」 |
| `personaDirectFile` | string | `''` | 私聊人格文件 |
| `personaLessonsDir` | string | `''` | 课程记忆目录（`*.md` 按文件名排序拼接） |
| `groupPrompt` | string | - | 群聊额外 system prompt（遗留通道，与 persona 文件并存） |
| `directPrompt` | string | - | 私聊额外 system prompt |
| `textChunkLimit` | number | `4500` | 单条消息最大字符数 |
| `streaming` | boolean | `true` | 是否启用流式输出（群聊始终不启用） |
| `sessionIdleTimeout` | number | `1800000` | 会话闲置超时(ms)，默认 30 分钟 |
| `processingTimeoutMs` | number | `1800000` | 处理超时(ms)，超时中断当前 LLM 调用 |
| `maxQueue` | number | `20` | 并发队列最大长度 |
| `historyLimit` | number | `10` | 群历史缓冲条数 |
| `askTimeoutMs` | number | `300000` | 待答问题超时(ms)，默认 5 分钟（ask_user_question） |
| `quietWindowMs` | number | `0` | 空闲静默窗口(ms)：她空闲时攒同一个人的连续分片，只答一次。`0` = 关闭（链序与无此功能时逐字节一致）。**开启前须有现网到达间隔样本**，见 spec §5 D2 |
| `quietWindowEmptyShellMs` | number | `0` | 空壳分片（只有 @/称呼、没正文）的长窗口(ms)，`0` = 沿用 `quietWindowMs` |
| `quietWindowMaxWaitMs` | number | `0` | 单个窗口从首片起的最长等待硬顶(ms)；开启窗口时必须 > 0，否则装载即报错 |
| `quietWindowMaxFragments` | number | `4` | 单个窗口最多攒几条分片，达到即立即放行（安全阀） |
| `showToolResults` | boolean | `false` | 是否展示工具调用成功结果（错误始终展示） |
| `debug` | boolean | `false` | 调试模式 |

### 访问控制（access）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `access.c2cMode` | `open`/`allowlist`/`disabled` | `open` | 私聊访问模式 |
| `access.c2cAllow` | string[] | `[]` | 私聊白名单（user openid） |
| `access.c2cDeny` | string[] | `[]` | 私聊黑名单（user openid） |
| `access.groupMode` | `open`/`allowlist`/`disabled` | `open` | 群聊访问模式 |
| `access.groupAllow` | string[] | `[]` | 群聊白名单（group openid） |
| `access.groupDeny` | string[] | `[]` | 群成员黑名单（发送者 openid，按人屏蔽同群其他人照常） |

黑名单在 `mode` 之前判定：命中即 `ctx.stop()`——不回复、不解释、不进群历史，即使被 @ 也一样。这条规则只落在中间件层才守得住，写进 prompt 会被概率性违反。

### 群聊唤醒词

默认三张表全空 = 行为与上游 0.5.5 完全一致（只有显式 @ 才回）。填了词表后，群里喊名字也回，且**同样带上这段群历史**：

```yaml
config:
  wakeWords:      # 强词：独立成词即触发
    - akane
    - 茜茜
  wakeWordsWeak:  # 弱词：需要呼格信号（句首、后接「，你/你怎么」一类）
    - 猫
  wakeWordExcludes: # 命中处不计，防「熊猫/猫粮」误触发
    - 熊猫
    - 猫粮
```

判定是词法的：汉字/字母/数字不算边界，所以「看到茜发的那个图了吗」不触发；URL、代码块、行内代码、`@别人昵称`、QQ 表情标签在匹配前等长掩码；单条超过 2000 字符只扫前 2000。改词表只需改 `cordis.patch.yml`，profile 的 patch 变更会被宿主 HMR 拾取，不用重新构建。

### 碎片静默窗口（quietWindow）

QQ 会把一句话拆成几条发。她空闲时这些分片本来各自触发一轮，于是同一句话得到两次回答。窗口让她先攒一小段再开口：同群同人一个桶，只有点到她名的那句才有资格开桶（别人的闲聊不会被拽进来）。

四条彼此配合的规则，改的时候容易踩：

- **空壳长窗口是替换不是叠加**：整批只有 @、没字也没图时改用 `quietWindowEmptyShellMs`，所以它必须**大于** `quietWindowMs` 才有意义，填得更小等于给这种形状提速。
- **硬顶从首片算起**，不随后到的分片顺延；`quietWindowMs > 0` 而 `quietWindowMaxWaitMs = 0` 是非法组合（没有顶的连发永不放行），装载即报错。
- **片数安全阀**：攒到 `quietWindowMaxFragments` 条立即放行。
- **窗口长度就是延迟**：它加在她每一次回话上，调小到 0 会退回「一条一分片各答一次」，调大到几十秒就是每句话都等那么久。定值只能靠插桩实测（`node scripts/arrival-report.mjs`），别凭手感。

四栏都能在设置页「碎片静默窗口」分组直接改，保存写入 profile 的本插件条目、热重载生效（不用重启进程，进行中的机器人会话会重置）。设计取证与拍板记录见 `docs/specs/2026-11-18-akane-fragment-merge-and-recall.md`。

### 人格文件

人格（她是谁、怎么说话）从 workspace 的 `AGENTS.md` 迁到插件内的 Markdown 文件，按 mtime+size 缓存热加载——改完下一条消息生效，不重启进程：

```yaml
config:
  personaGroupFile: persona/akane-group.md   # 相对路径按插件包根解析，~ 可展开
  personaDirectFile: persona/akane-direct.md
  personaLessonsDir: persona/lessons         # *.md 按文件名排序，各自带小标题
```

拼合顺序为 `persona 文件 → 课程 → 遗留 groupPrompt/directPrompt`，注入位置在宿主的 `deployment:persona-prefix` 之后（不是整篇 prompt 末尾）。`persona/README.md` 写了文案纪律：行为约束 + few-shot 为主，绝不列禁词清单。

### 到达间隔插桩（arrivalProbe）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `arrivalProbe.enabled` | boolean | `false` | 是否记录每条消息的到达时刻（给 `quietWindowMs` 定默认值用） |
| `arrivalProbe.keepDays` | number | `30` | 插桩文件保留天数，0=永不过期 |

静默窗口的长度加在她**每一次**回复的延迟上，所以默认值必须由现网实测数据决定，而不是拍一个数。开启插桩后，每条入站消息落一行到 `~/.dsh-qqbot-akane/arrival/YYYY-MM-DD.jsonl`，字段只有 `messageId` + 本地接收毫秒 + 桶键散列 + 有没有点名她——**正文与 openid 都不写**，所以这份落盘不需要脱敏环节。出数：

```bash
node scripts/arrival-report.mjs        # 报 p50/p90/p95 与样本量
```

口径固定在 `src/features/arrival-stats.ts`（同桶相邻两条、间隔 < 120s、样本 < 300 对只出「继续攒」）。关闭态不挂载中间件、不起清理定时器，目录都不会被创建。300 对之前 `quietWindowMs` 只能用临时值（现网 12s，取自 p50=10.2s 的密集带），攒够后按 p90 校准——设置页改一栏即可，不用重启。

### 富媒体理解（media）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `media.enabled` | boolean | `true` | 是否启用富媒体理解（图片/视频下载 + 工具分析） |
| `media.maxMB` | number | `200` | 富媒体下载大小上限(MB) |
| `media.ttlHours` | number | `24` | 富媒体存活时长(小时)，0=永不过期 |

### 群历史图片

SDK 的历史条目只有文本位，所以群里发的图片一旦进历史就只剩一个空行——她被 @ 时能看图，隔天问"刚才那张"就看不见。本 fork 自建 `akaneHistoryBuffer` 替代（仍挂在 `mentionGate` 之前，未 @ 的消息照旧进历史），条目里保留附件元数据，并在**记录的那一刻**发起落盘。

- **为什么不等她用到的时候再下载**：QQ 下发链接的有效期官方没写，也没有重新换签名的接口。赌时效的结果是一条死路径进上下文，她一打开就是工具报错，而报错会原样发到 QQ 上。记录时下载在任何时效下都对。
- **落盘条件**（六个都满足才下）：群消息（私聊不进历史）· 没被 `access` 硬拦截 · 附件是图片（视频/文件只留标签）· 不是机器人自己发的 · 本地还没有（去重）· 这个群当天还没用完配额。`media.enabled=false` 时整条链路不落盘。
- **去重**：QQ 下发的图片文件名本身就是内容 MD5，据此判等内容；当前消息、引用消息、群历史三条链路共用同一本账（`src/features/media-ledger.ts`），同一张梗图只存一份、只出现在上下文里一次。
- **限量**：每群每天主动落盘 20 张（按尝试计，失败不退额度；命中缓存不占额度），超出只在历史里标 `[图片]`。下载挂在串行尾、fire-and-forget，刷图的人只能排队，不会阻塞她回话。
- **呈现**：历史消息行下面挂 `        └ Image: <本地路径>`，每轮最多 4 个路径、从最新往回分配；没有路径的降级为 `[图片]`／`[视频]`／`[文件: 名字 (大小)]`。签名 URL 一律不进上下文。文件被 TTL 清掉后渲染时当场查出、绝不给死路径。
- **保留时长**：仍是 `media.ttlHours`（默认 24 小时，按文件 mtime，清理启动时跑一次 + 每小时一次）。
- **配额与频率是两件事**：这里限的是**入站**落盘量；她**出站**配图多久一张是 `akane-sticker` 技能里的软约束，本期没有硬闸门。

### 视觉理解（vision）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `vision.enabled` | boolean | `false` | 是否启用视觉理解（akane_describe_image 工具） |
| `vision.provider` | string | - | 视觉模型 provider（如 pi-ai） |
| `vision.model` | string | - | 视觉模型 id（如 qwen-vl-max） |
| `vision.maxBytes` | number | `10MB` | 图片字节上限 |
| `vision.maxTokens` | number | `1024` | 输出 token 上限 |
| `vision.timeoutMs` | number | `120000` | 视觉调用超时(ms) |

### 附件发送（sendFile）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sendFile.restrictPaths` | boolean | `true` | 是否启用路径白名单（仅 media + cwd + extraRoots） |
| `sendFile.extraRoots` | string[] | `[]` | 额外允许访问的根目录 |

### 记忆库（memory）

跨轮、跨重启把她**自己说过的话**按语义找回来。五层里这一层是 T2：一个可丢弃的派生索引 + 一个召回工具，正本始终是宿主的转录（T1），插件只读不写。

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `memory.enabled` | boolean | `false` | 总开关。关闭时不建 `index/`、不起后台作业、不注册工具、不打日志 |
| `memory.embedBaseUrl` | string | `http://127.0.0.1:8765` | 本机 embedding 服务基址，**只接受回环**，其他地址客户端直接拒绝 |
| `memory.timeoutMs` | number | `8000` | 单次嵌入往返超时(ms) |
| `memory.dims` | number | `512` | 向量维度，与模型绑定；与 `meta.json` 不符即整体重建 |
| `memory.syncIntervalMs` | number | `600000` | 后台同步间隔(ms)，首轮即全量回填 |

- **它的能力上限由 T1 决定，不由检索决定**：没点她名、也没被她那一轮拼进上下文的话，转录里就没有——任何检索都变不出来。记忆库解决的是「有，但搜不到 / 搜不准」，**不解决**「根本没存」。
- **需要用户自己起的常驻服务**：`embed-service/`（独立进程，模型 `bge-small-zh-v1.5` 的 ONNX q8，只绑 `127.0.0.1`；**只要 Node ≥22，不需要 python / CUDA，Linux / macOS / Windows 同一份代码**）。插件**不 spawn、不自愈、不 kill**，装法与启停见 [`embed-service/README.md`](./embed-service/README.md)。服务不可达时召回降级成只走字面档，**不存在**降级到远程 embedding API 的路径。
- **索引三文件在 `~/.dsh-qqbot-akane/index/`**：`chunks.jsonl`（文本 + 元数据）、`vectors.f32.bin`（同序定长）、`meta.json`（schema / 模型 / 维度 / 同步游标）。整目录删掉可全量重建，插件照常启动。
- **隐私边界 = chunk 写入时落地的 `peer`**，召回只认同 peer，**没有跨 peer 开关也不按会话目录放宽**（同一 sessions 根目录下另有别人的转录，含用户本人的开发对话）；解析不出归属的转录只进索引、永不可召回。
- **返回体不含主机路径 / `└ Image:` 行 / session id / openid / appId**，任何失败都回「没查到（…）」这一族固定措辞（按成因分四条，都不带错误原文），异常绝不逃出 `execute`（否则会变成 QQ 里的 `❌ 工具 akane_recall 执行失败`）。
- **chunk 边界与 `quietWindowMs` 同源同值**——折叠说一条、chunk 就说一条，两头各定一套阈值必然对不上。窗口那个值本身还是临时值（见上），这里继承同一个标记。
- **限额与相似度阈值全是临时值**：6 片段 / 单片段 600 字符 / 返回体 3000 字符 / 语义档下限 0.45。**离线召回质量数值不存在**——现网只有运行时观测（真实调用打出的相似度：min 0.451 / 中位 0.51 / p90 0.599，74 个片段里 33 个落在 0.45–0.50，即那个下限几乎不筛东西 —— 但注意这**只是进了返回体的那批**的分布，榜下被滤掉的候选看不见），改阈值需要的是 ≥20 条真实问法的**改前/改后命中位次**，那批问法只能由用户提供。
- **QQ 端六条手动验收的进度**（`0.5.5__0.3` 发布时点）：第 1、2、3 条已跑并取证 —— 跨会话/跨重启召回真起到了 168 小时前的片段，单次返回片段数 0–6 从未越界、返回体 37–1719 字从未超 3000，23 次调用 `isError` 0 次，返回体与出站文本里路径 / 用户名 / `└ Image:` / openid / session id / 签名 URL / `❌ 工具` 全为 0。第 4 条（换个群问必须答不上来）**只有间接证据**；第 5、6 条（停服务后的降级措辞、启动日志那行 `embedding(...)`）**未跑**。「第 3 条要看到截断标记」这一判据本身已作废：6 片段上限总比 3000 字符先绑住，截断标记够不到。

## 内置命令

| 命令 | 说明 |
|------|------|
| `/new`（别名 `/reset` `/clear`） | 开始新会话（清空上下文） |
| `/compact` | 压缩会话历史（摘要替换旧记录，保留上下文） |
| `/model` | 查看或切换模型 |
| `/preset` | 查看或切换 agent preset（新会话生效） |
| `/stop` | 中止当前生成 |
| `/bot-ping` | 网络延迟检测（返回传输与处理耗时） |
| `/bot-version` | 查看版本信息 |
| `/bot-status` | 查看当前会话状态 |
| `/bot-help` | 查看所有指令 |

## 核心模块

```
src/
├── index.ts                    # Cordis 插件入口（async apply）
├── config.ts                   # 配置 Schema
├── wake.ts                     # 唤醒词内核（掩码 + 两级词表 + 呼格判定）
├── persona.ts                  # 人格文件读取（mtime+size 缓存、lessons 拼接）
├── persona-section.ts          # 人格 section 注入（splice 到 persona-prefix 之后）
├── types.ts                    # 全局类型定义
├── setup/                      # 凭据绑定（扫码）
│   ├── index.ts                # 绑定编排（ensureCredentials）
│   ├── binding-service.ts      # 扫码状态机（宿主内唯一事实源）
│   ├── bind-routes.ts          # 端内绑定页路由（/qqbot/im-qqbot-akane/bind）
│   ├── presenters.ts           # 呈现策略（终端/浏览器降级）
│   ├── qr-svg.ts               # 二维码 SVG 渲染（宿主侧）
│   └── persist.ts              # 凭据写入 cordis.patch.yml
├── client/                     # 浏览器半边（dsh.client Web Bundle）
│   ├── index.ts                # 侧栏 Tab 注册 + 待绑定自动引导
│   ├── bind-page.ts            # 端内绑定页（二维码 + 状态轮询）
│   └── config-panel.ts         # 设置页面板（唤醒词三表 / 窗口四栏 / 访问控制）
├── gateway/                    # 网关装配
│   ├── bootstrap.ts            # 启动装配（监听 session/event 等）
│   └── middleware-setup.ts     # 中间件链配置
├── transport/                  # 传输层
│   ├── inbound.ts              # QQ 入站消息 → agent.followup()
│   ├── outbound.ts             # session/event → QQ sendMarkdown
│   ├── outbound-buffer.ts      # 流式缓冲
│   ├── streaming-writer.ts     # 流式写入
│   ├── reply-target.ts         # 回复目标解析
│   ├── msgid-cache.ts          # 被动回复 msgid 缓存
│   ├── reply-limiter.ts        # 被动回复限流
│   ├── tool-presenter.ts       # 工具调用展示
│   └── chunker.ts              # Markdown 文本切分
├── session/                    # 会话管理层
│   ├── session-manager.ts      # QQ peer → Agent 映射
│   └── idle-evictor.ts         # 闲置回收
├── model/                      # 模型路由层
│   ├── model-resolver.ts       # 路由解析
│   ├── prefs-store.ts          # per-peer 偏好持久化
│   └── settings-reader.ts      # settings.yaml 只读
├── features/                   # 交互特性
│   ├── question-channel.ts     # ask_user_question 问答通道
│   ├── approval-channel.ts     # approval 审批确认通道
│   ├── history-store.ts        # 群历史环形缓冲（带附件元数据）
│   ├── media-ledger.ts         # 媒体落盘账本（去重 / 单飞 / 每日配额）
│   ├── arrival-stats.ts        # 到达间隔口径（同桶相邻两条，定窗口用）
│   └── answer-parser.ts        # 答案解析
├── media/                      # 多媒体
│   ├── vision-tool.ts          # 图片视觉理解
│   ├── send-file-tool.ts       # 发送本地文件
│   └── media-cleaner.ts        # 媒体 TTL 清理
├── middleware/                 # 中间件
│   ├── question-answer.ts      # 问答答案处理
│   ├── history-buffer.ts       # 群历史缓冲 + 记录时落盘（替代 SDK 版）
│   ├── arrival-probe.ts        # 到达间隔插桩（第 3.5 步）
│   ├── quiet-window.ts         # 空闲静默窗口（第 4.6 步，门控之前）
│   ├── fragment-merge.ts       # 分片合并（归属 / 附件 / msg_id 锚点）
│   └── attachment.ts           # 附件处理
├── memory/                     # 记忆库（T2 索引 + 召回，默认关）
│   ├── index.ts                # 唯一挂点与总开关（关闭时第一件事都不做）
│   ├── chunking.ts             # 转录事件 → chunk（边界与 quietWindowMs 同源）
│   ├── index-store.ts          # index/ 三文件的读写与整体重建判定
│   ├── transcript-source.ts    # 宿主服务面白名单 + 取原文 + 返回前脱敏
│   ├── backfill.ts             # 后台增量同步（不在中间件链里，不占回复延迟）
│   ├── embed-client.ts         # /embed 客户端（非回环直接拒绝）
│   ├── peer.ts                 # 隐私边界的唯一正本（解析不出即 fail-closed）
│   ├── retrieval.ts            # hybrid：逐词 AND + 余弦 → RRF 融合 → 限额
│   └── recall-tool.ts          # `akane_recall` 工具定义与失败措辞
├── shared/                     # 共享工具
│   ├── utils.ts                # 通用函数
│   ├── scope.ts                # scope/peer 提取
│   └── send-helper.ts          # 分块发送
└── commands/                   # 斜杠命令
```

顶层还有一目录 `embed-service/`：本机常驻 embedding 微服务（独立 node 进程 + `install.mjs` 拉权重），不在插件进程内，也不随插件启停。装权重只需要 Node，`install.sh` 是它的 bash 薄壳；Windows 用 `node install.mjs` 加 `start.ps1` / `stop.ps1`（详见该目录 README）。

## 会话路由

sessionKey: `qqbot:${appId}:${scope}:${peerId}`，新会话铸造 UUID 会话 id 并持久化到 `model-prefs.json`，重启后按持久化 id 恢复；0.5.x 老会话按原派生 id 沿用。

解析策略：进程内复用 → 持久化恢复 → 全新创建。

## 设计原则

- **纯 Cordis 插件** — 遵循 dsh "Plugins, not loop changes" 原则
- **声明式依赖** — `inject = ['agents']`，不直接耦合其他插件
- **会话隔离** — 每个 QQ 私聊用户/群聊各一个独立 Agent
- **Preset 支持** — 可通过 `agent-presets` 服务挂载预设（工具集、prompt 等）
- **闲置回收** — 超时自动 dispose Agent，防止内存泄漏
- **人格与代码分工** — 语气/身份是可热加载的 `persona/*.md`，硬规则（黑名单零输出）写在中间件里，不指望 prompt 自律
- **不赌外部时效** — 官方没承诺的下发链接有效期不去猜，改成记录时下载；给她的路径必须当场查得到文件，宁可降级成标签也不给死路径
- **词表即配置** — 唤醒词、persona 路径全在 `cordis.patch.yml`，改配置不改代码、不重新构建
- **默认关的能力必须真的关** — 记忆库的开关只在挂载函数第一行判一次：关闭时不建目录、不起作业、不注册工具，`tools.register` 收到的工具名集合与没有这个功能时逐字节一致
- **隐私边界写在写入时** — chunk 落地就带 `peer`，召回只认同 peer 且不按会话目录放宽；解析不出归属的转录只进索引、永不可召回
- **推理不进插件进程** — ONNX 那 300MB 量级常驻内存与几十毫秒的批量推理归 `embed-service/` 那个独立进程，启停归用户；插件只探测、只调用，不可达就降级字面档
- **Markdown 输出** — 回复以 Markdown 格式发送，支持代码块/表格感知切分
- **图片理解** — 支持 `akane_describe_image` 视觉理解，可分析用户发送的图片
- **附件发送** — 支持 `akane_send_file` 将本地文件发送给用户（默认启用路径白名单）
- **问答互动** — 支持 `ask_user_question`，单选生成内联按钮（点一个其余变灰）、多选回复编号，逐题推进 + 问题级超时
- **操作确认** — 支持 `approval/request`，关键操作通过「允许/拒绝」按钮请求用户确认

## 本地开发

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 开发模式（watch）
pnpm dev

# 用 --patch 方式调试
export QQBOT_APPID="xxx" QQBOT_SECRET="xxx"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot-akane/cordis.dev.yml
```

## License

[MIT](./LICENSE)
