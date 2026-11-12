# Spec：梗图配图能力（文字 + 图，akane）

日期：2026-11-12　分支：`fork/akane`　基线：`pnpm test` 393 passed / 31 files

## 1. 问题陈述

她现在只会用文字回答。真人在群里聊天是**顺手甩一张图**的：一句接不住的话配个"翻白眼"，比三段解释更像活人。缺了这块，语气词再多也还是助手腔——因为**节奏**不对：真人不会每件事都认真讲完。

已经验证过的事实（不必重新调研）：

- 发图能力**早就有**：`sendImage` 走素材上传 + `msg_type=7` 被动回复（`src/media/send-media.ts:114`、SDK `protocol/api/media.ts:176-187`）。
- 顺序也是对的：`present` 声明的文件在**本轮文字送达之后**才投递（`src/transport/outbound.ts:253` 等 flush 完再 `deliver`；`CHANGELOG.md:81` 同述）。
- 额度够用：被动回复上限 4 次/条消息（`bootstrap.ts:91`），文字 1 + 图 1 = 2，群 5 分钟窗口不受影响。
- 路径不用配：`sendFile` 白名单根包含 agent cwd（`send-media.ts:76-80`），图库放 `workspace/stickers/` 天然合法。
- **她能直接看懂图**：宿主自带 `read_image`，与插件的 `vision`/`akane_describe_image` 无关（`vision.enabled` 关着也照样能看）。21:29 实测：一张带字幕的梗图进来，她自己调 `read_image`，随后准确复述了画面与字幕「从来没觉得上班开心过」。
- **入库链路已端到端跑通**：同一次实测里，"保存这个表情包" → 两次 `bash`（`ls` 找文件、`mkdir -p workspace/stickers && cp`）→ 落地 `workspace/stickers/从来没觉得上班开心过.jpg`。沙箱策略 `workspace-write`（见 runtime-context 快照），写 workspace 不触发 approval，回复也没带任何宿主路径。

所以**缺的不是发送能力，也不是读写能力，是"图从哪来"和"什么时候不发"**。前者现在全靠她临场发挥（目录名 `stickers/`、文件名、是否建索引，都是当场即兴决定的——这次运气好，下次未必）；后者尤其不能指望 prompt：本项目的既有教训（`REQUIREMENTS.md` §1.4——黑名单条款在 AGENTS.md 里改了三版措辞仍然守不住，最后进代码）表明，频率这类硬约束写在人格里就是许愿。

## 2. 方案概述

三块，**本期零代码改动**（发送、下载、读写、看图的能力现网已全部具备，21:29 实测跑通）：

1. **本地图库 `workspace/stickers/` + `INDEX.md`**：每张图一行「文件名｜什么时候用｜别在什么时候用」。目录名沿用她 21:29 实测时的即兴选择（`stickers/`），避免再造第二套。图由人工囤 + 她从对话里沉淀，不靠现生成。
2. **一个独立 skill 承载全部操作流程与频次自律**（`akane-sticker`）：入库怎么命名查重、选图看哪个索引、投递走 `present`、多久配一次图靠自己节制。**不写进 `AGENTS.workspace.md`**——理由见 §4。
3. **persona 只留社交倾向**：什么时候想配图，进 `persona/akane-group.md`，按 R3 原则写第一人称倾向 + few-shot。

配图频率本期靠软约束，硬闸门降级为阶段 2 观测项（见 §3「配图频率」与 §4）。回滚同样不需要开关：删掉 skill 目录，她就不按这套规范配图。

## 3. 用户故事

### 图库与索引

- **US-1**：`workspace/stickers/` 下放若干 `.png/.jpg/.webp`，`INDEX.md` 每行登记一个文件名与适用情境；改库、改索引都不需要 `pnpm build`，也不需要重启 `dsh web`。
- **US-2**：索引里只写**文件名**，不写绝对路径。她对外说话时不得出现 `stickers/`、`workspace`、`~/.dsh-qqbot-akane` 一类宿主路径（沿用红线；21:29 实测她只说了"表情包夹"，合格）。
- **US-3**：`INDEX.md` 缺某张图的登记时，她仍可按文件名语义猜到用途，但下次配图前应先补登记（约定，不强制）。
- **US-4**：索引控制在约 200 行内；超出后按主题分片（`INDEX-*.md`），本轮只读需要的那片——读索引是有 token 成本的。
- **US-5**：图库目录本期固定在 `workspace/stickers/`（她实测自己建的就是这个名字）；换目录、指向别处属于阶段 2 的 `meme.dir`，本期不做。库里放一张 `README.md` 说明用途，误删后重新生成即可。

### skill 承载的操作规范

- **US-6**：`akane-sticker` skill 存在且被宿主发现（下一轮 `<available_skills>` 里能看到它），`description`/`whenToUse` 命中"保存表情包""配张图""发个梗图"这类说法。
- **US-7**：skill 里写死这些操作规范，AGENTS.md 与 persona 都不重复：入库目录 `stickers/`、命名取图上字幕或一句语义短语、`cp` 不 `mv`、入库前按内容 `md5sum` 查重、选图先读 `INDEX.md`、投递走 `present`、频次靠自律（同图不重复、连着两轮配图即过量、一轮最多一张）、回复不提路径。
- **US-8**：`AGENTS.workspace.md` 只留一行指针（表情包相关看 `akane-sticker` skill），不铺流程——AGENTS.md 每轮常驻 context，流程写进去就是长期 token 税 + 对人格的污染。
- **US-9**：skill 源文件进 fork 仓库（`skills/akane-sticker/SKILL.md`）随版本走，部署时安装到 `~/.dsh/skills/`（与 `ark-seedream` 同级，该位置已证实可用）。

### 出站投递与顺序

- **US-10**：一条"文字 + 梗图"回复在群里表现为**先文字后图**，两个气泡，中间无占位符、无提示语。
- **US-11**：主路径是 `present`（轮末投递）。`akane_send_file` 保留为逃生口（用户点名要图、或轮中必须立刻出图），但它**当刻即发**，顺序会先图后文——skill 里写清默认走 present。
- **US-12**：单轮最多 1 张梗图（skill 自律 + `sendFile.maxFiles` 上限共同约束），不出现连发两图的刷屏。
- **US-13**：图片上传成功但文字发送失败（或反之）时不重试、不补发占位说明；失败只进日志。
- **US-14**：msgId 已过期时 SDK 静默降级为主动消息（`reply-target.ts:31-55`）——低频配图把这种情况的概率压下去，但降级本身不在本期修。

### 配图频率（本期只做软约束 + 观测）

> **修正（2026-11-12）**：本节原本是 per-peer 冷却闸门的设计。评审时把类比用过头了——黑名单是**二元规则**，漏一次就是事故，所以必须进代码；配图频率是**容忍带**，发 3 张和发 5 张都不是事故。更关键的是 `cooldownMs=10min` / `dailyMax=6` 这两个数字当时给不出任何依据，而项目当初推迟"概率沉默门控"写的理由（"要先看真实分布再定规则，否则等于在猜"）对这两个参数完全适用。本期改为：软约束进 skill + 观测口径进代码日志，闸门待数据。

- **US-15**：skill 的「频次」一节只写自我节制，**不得出现"系统会拦截/吞掉"这类对不存在机制的承诺**。
- **US-16**：闸门设计（判定落点、peerKey 维度、滚动窗口、落盘、静默语义、`meme.enabled` 默认 false）作为阶段 2 的既定形状保留在 §4 决策表和 §5 的留档段落，届时直接取用、不重复设计。
- **US-17**：日志能数出三件事——她一天主动配图几次、其中几次是"文字已说清还硬配图"（多余）、有没有同一张图连着两轮重发。缺哪个补哪个日志，不为观测引入新配置项。
- **US-18**：观测窗口 ≥ 库内 10 张图之后的一周。库里只有 1 张时过度使用会自我抑制（同图发第二次就很蠢），此时的数据没有代表性。
- **US-19**：触发重提闸门的条件写死在本文档：出现"每句必配"、同图连发、或一轮里两张以上导致被动回复顶到 4 次上限（`bootstrap.ts:91`）而降级为主动消息。

### 表情包入库

> **前提修正（2026-11-12 实测代码）**：群里发的图**不会自动下载**。中间件链上 `mentionGate` 在第 5 层且未传 `passthrough`（`middleware-setup.ts:105-108` → SDK `mention-gate.ts:219` `ctx.stop()`），而下载发生在第 11.5 层 `attachmentProcessor`（`middleware-setup.ts:147`）。**只有触发她的那条消息**（@ / 唤醒词）图才会落到 media。私聊不受此限，必下载。引用消息里被引用的图也会下载（`middleware/attachment.ts:24-37`）。
>
> 附带影响：现网 `wakeWordExcludes` 含「表情包」，所以群里只说"保存这个表情包"而不喊她，**不会触发**——这是 R1 词表的正确行为，但要让人知道入库动作在群里必须带上唤醒。

- **US-20**：她**回应过的**图已经在本地（`~/.dsh-qqbot-akane/media/`，扩展名按 magic bytes 校正），**绝对路径原样写在 envelope 里**（`inbound.ts:334-335` → `Image: /home/…/media/<hash>_…_.jpg`），且她能靠宿主 `read_image` 直接看懂内容。入库 = `cp` 进 `stickers/` + 补 `INDEX.md` 一行，**零新代码**（21:29 私聊实测已跑通）。
- **US-21**：入库命名取**图上的字幕或一句语义短语**（实测她取的名「从来没觉得上班开心过」正是字幕原文，可直接当检索 key）；不许凭空起名——名字是她唯一可靠的检索面。
- **US-22**：入库前按内容查重（`md5sum`）：media 里的落地名每次不同哈希，同一张图重发会生成两份，库里必须只留一份。
- **US-23**：`cp` 而非 `mv`——media 原件留给本轮后续可能的再次引用，24h 后由清理器回收（`media.ttlHours` 默认 24，`config.ts:164`）。用户说"保存"时她必须**当轮就复制**，不能指望文件还在。
- **US-24**：硬约束（写进 skill，且人工兜底）：带真人头像、聊天截图、昵称、二维码或任何可识别个人信息的图**不收库**。跨群复用同一张图，等于把 A 群的内容发给 B 群。
- **US-25**：用户可随时删 `stickers/` 里的文件或改 `INDEX.md`，下一轮即生效；库的终审权在人。
- **US-26**：全量收群图（不经触发就下载所有群图）**不在本期**：要把 `mentionGate` 改成 `passthrough: true` 并自建门控（`REQUIREMENTS.md` 决定 B 的原形状），代价是每张群图一次下载 + 磁盘 + 隐私面。先靠"回应过的图"沉淀，观测库生长速度再定。

### 可观测与回滚

- **US-27**：`debug: true` 时日志能还原每轮的配图事实：走了哪个入口（`present` 投递 vs `akane_send_file` 工具）、文件 basename、发送结果。这是 US-17 统计口径的数据来源。
- **US-28**：回滚不需要开关——删 `~/.dsh/skills/akane-sticker/` 她就不再按这套规范配图，`stickers/` 目录留着不影响任何行为。

## 4. 已定决策

| 决策 | 取舍 |
|---|---|
| **囤图 + 群图沉淀，不用 `ark-seedream` 现生成** | 生成图慢（十秒级）、每张花钱、AI 味重，接梗的时效性直接死。`AGENTS.workspace.md` 现有的"每图先问再花钱"纪律也和梗图冲突。生成图只留给定制需求。 |
| **主路径 `present`，`akane_send_file` 作逃生口** | present 免费给正确顺序（轮末、文字之后）；工具当刻即发会图在文前。 |
| **本期不做冷却闸门，改软约束 + 观测**（2026-11-12 评审修正） | 见 US-15 上方说明。阈值没有数据支撑就不写死；先让 skill 的自律约束跑出一个真实分布。 |
| **闸门设计保留为阶段 2 既定形状** | 届时落点在两条出站路径的共同上游 `sendMediaFile`（`send-media.ts:94`，该文件自己声明的"单一事实源"）；只堵工具不堵 present 等于没堵。判定共享、处置分流：工具要返回成功形态的 `suppressed`（抛错会渲染成 `❌ 工具执行失败`，`tool-presenter.ts` 错误优先 + `outbound.ts:217` 错误始终展示），present 要静默丢弃且**不进 `missed`**（否则会冒出 `📎 已生成文件` 那句机器签名）。 |
| **闸门维度 = peer（`scope:targetId`），不区分场景/情绪** | 群按群算、私聊按人算，参数少、能从日志直接调。具体阈值等观测数据。 |
| **二元硬规则进代码，容忍带类偏好进 skill** | 修正后的分界：黑名单漏一次就是事故，所以进代码；配图频率是"发 3 张和发 5 张都不算事故"的偏好，进 skill 靠自我节制，配观测兜底。 |
| **操作流程进 skill，不进 `AGENTS.workspace.md`**（用户主张，2026-11-12） | 三条理由：① AGENTS.md 每轮常驻 context，流程写进去是长期 token 税，而且她"干活模式"和"聊天模式"共用一份约定文件——正是决定 A 当初要拆掉的污染；② skill 按需加载，宿主已把 `<available_skills>` 注入会话（实测可见 `ark-seedream`），命中说法才展开；③ 本次实测她即兴造了 `stickers/` 目录、即兴起名、没建索引——没有可复用规范载体时，库的形状每次由模型心情决定，skill 就是那个载体。 |
| **目录名沿用 `stickers/`** | 她已经这么用了，现网也有第一张图落在里面；`memes/` 是 spec 初稿的一厢情愿，改文档比改现场便宜。 |
| **本期零配置字段** | 不新增 `meme.*`。图库、索引、命名、查重、投递入口全部由 skill 文本承载；阶段 2 真做闸门时再引入 `enabled` / `dir` / `cooldownMs` / `dailyMax` 四个字段，不多做。 |

## 5. 测试决策

本期零代码改动，因此**没有新接缝、不新增单测**。回归门槛照旧：`pnpm test` 393 passed / 31 files，`pnpm build` 干净，改完必须仍然满足——它证明"我们确实没碰代码"。

验证靠三条腿：

- **装载确认**：`<available_skills>` 里出现 `akane-sticker`（目视 session 日志），这是 US-6 的唯一判据。
- **行为确认**：下面的真机验收清单，逐条对会话记录。skill 是文本规范，只能这样验。
- **观测确认**：US-18 的统计口径，人工从 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 里数（解包看后**必须删掉明文**）。

**阶段 2 的测试设计（留档，本期不写）**：若冷却闸门最终落地，接缝仍是 `sendMediaFile`（`src/media/send-media.ts:94`，两条发送路径都经过它，`send-media.test.ts` 已存在）——纯函数核 `decideMemeSend({nowMs, peerKey, path, ext}, state, config) → 'allow'|'cooldown'|'quota'|'bypass'` 表驱动覆盖门控本身；另外必须单独钉住两条易错语义：**压制分支不得进 `deliverables` 的 `missed`**（否则渲染出 `📎 已生成文件`），**不得抛错或返回不符合 output schema 的值**（现有 schema 把 `fileName/fileSize/target/fileUuid` 都设 required，`send-file-tool.ts:90-96`；先定形态再写实现，别用 `as any` 糊）。状态复用 `PrefsStore` 的原子写模式（`prefs-store.ts:14`）。

**真机验收**：

1. 群里喊她玩梗 → 文字先到、图后到，两个气泡。
2. 同一个人连着两轮都配图时，肉眼判断是否显得过量（本期只记录，不拦截）。
3. ~~私聊发一张图 → 她收下并入库~~ **已实测通过**（21:29，`workspace/stickers/从来没觉得上班开心过.jpg`）。待补的是**群场景**：@ 她 + "保存这个表情包"，验证显式 @ 不被 `mentionGate` 挡在她自己处理之前。
4. 让她生成一份 md 报告 → 照常送达，说明 skill 的存在没有干扰其他文件投递。
5. 删掉 `~/.dsh/skills/akane-sticker` → 表现回到基线，确认没有代码侧残留依赖。

## 6. 明确不做

- **文字 + 图挤进同一条消息**：`sendMediaFile` 的 `MediaSenderLike` 签名不收 caption（`send-media.ts:24-27`），补上要一路加形参——SDK 侧已就绪（`media.ts:184` 有 `opts.content` 就进 `msg_type=7` 请求体），但群/单聊被动回复下 caption 到底展不展示未实测。markdown 内联图 `![#Wpx #Hpx](url)`（SDK `protocol/utils/image-size.ts`，插件无人调用）另需 markdown 特殊权限（SDK `USAGE.md:769`）。两条都更省额度，本期不做，留作参数调好后的优化项。
- **真 QQ 表情 / 贴图 / sticker 的发送**：**已定论不可行**——SDK 出站 `MsgType` 只有 0/2/3/4/6/7，全量 grep 无 `sendFace`/`sticker`/`emoji_id`。`REQUIREMENTS.md` §5 第 3 条可以关闭了。
- **入站表情名的利用**：21:29 实测修正了此前判断——**收藏/自定义表情同时带 face 标签和图片附件**，envelope 长这样：`- Image: <media 绝对路径>` + `【表情: 未知表情】` + `[图片]`。也就是说 QQ 确实给了表情名，但 `parseFaceTags` 从 `ext` 里解不出 `text`（SDK `text-parsing.ts:87-101`，多半撞了 `MAX_FACE_EXT_BYTES` 尺寸守卫），降级成了"未知表情"。**本期不去修这个解析**：她有 `read_image`，看图取字幕比啃表情元数据更准也更通用。纯面板表情（无附件那种）依旧存不了，这是平台限制不是实现缺陷。
- **语义检索工具 `akane_meme_search`**：几十张图靠 `INDEX.md` 让模型自己读足够；上百张、且观测到明显选错图时再上 embedding。
- **GIF 动图**：`.gif` 现在归 `sendImage`（`send-media.ts:114`），是否保留动画未实测。真需要动图可能得走 `sendVideo`，另立 feature。
- **图库管理界面**：直接编辑文件，不做 client 面板。
- **配图频率的硬闸门（冷却 / 配额 / 配置开关）**：本期不做，频次只由 US-15..17 的软约束 + US-18 的观测兜。理由见 §4「频率控制放哪一层」——这是容忍带类偏好，不是二元硬规则；阈值本身还没有数据支撑。真机观测量级失控再按 §5 留档的接缝设计落地。
- **msgId 过期降级为主动消息的治理**、**概率沉默门控**、**长期记忆**：仍属阶段 2。

## 7. 补充说明

- **本期没有配置项可写**：交付物只有 SKILL.md 和文档，落盘靠 `install.sh` 复制（或手工 `cp`），web profile 不用动。**将来**若加 `meme` 块，记住 AGENTS.md 记录的头号坑：profile 层同 id 覆盖会遮蔽 bundle patch 的 `insert`，fork 条目必须写全，只改包内默认值现网不会生效。
- **token 成本**：每次配图至少多一次索引读取（约 3KB）+ 一次上传。索引越短越好，这是 US-4 存在的真实原因。
- **同图发不同人会各自重传**：SDK 上传缓存的 key 含 `scope:targetId:fileType`（`upload-cache.ts:22-29`），只影响一次上传往返，不影响额度。
- **她能看图，和插件 vision 无关**：宿主自带 `read_image`，实测在 `vision.enabled: false` 的情况下她照样准确读出了图上的字幕。所以 `REQUIREMENTS.md` §4 那个"顺手打开 vision"项**不是本 feature 的前提**，可以单独再议（`akane_describe_image` 的剩余价值主要是给非多模态模型兜底和批量描述入库）。
- **已实测的边界**：沙箱策略 `workspace-write`——写 `workspace/stickers/` 不触发 approval，读 `~/.dsh-qqbot-akane/media/`（cwd 之外）也放行。所以"入库靠 cp"这条不需要改代码，也不需要给 `attachmentProcessor` 加目标目录。
- **skill 发现路径已实测**：宿主在消息发送时扫描 `$DSH_HOME/skills/*/SKILL.md`（默认 `~/.dsh/skills`），注入 `<available_skills>` 后由模型调宿主的 `skill` 工具按需加载正文。装完下一轮即生效，**不需要重启进程、不需要 `pnpm build`、不需要 `dsh plugin add`**——`.dsh/skills`、`.agents/skills` 这类工作区级目录和 `ctx.skills.register()` 都不必碰。唯一的坑：备份目录不能留在 `skills/` 里面，否则会被当成第二个同名 skill 读进清单（`install.sh` 已改为备份到 `$DSH_HOME/skills-backup`）。
- **仍未验**：群场景的入库与配图（本轮只验了私聊）、GIF 是否保留动画。
- **persona 落笔遵循 R3 原则**：写"我看到那种话就想甩张图"这类第一人称倾向，不写"禁止频繁发图"（大象效应）；few-shot 各给一条"配图"和"想配但用文字说完"的对照，别只给前者。
- **`~/.dsh-qqbot-akane/` 与原版隔离**：状态文件落 PLUGIN_HOME 下天然隔离；工具名、目录名已带 akane 前缀，与原版共存不互顶。
