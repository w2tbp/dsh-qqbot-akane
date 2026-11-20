# persona 目录

这里的 Markdown 是「她是谁」的单一事实源；`~/.dsh-qqbot-akane/workspace/AGENTS.md` 只留技术约定（隐私、生图成本、小说检索、防剧透）。两者都按 mtime 热加载，改完下一条消息生效，不用重启进程。

配置项在 `cordis.patch.yml` 里：

| 字段 | 作用 |
|---|---|
| `personaGroupFile` | 群聊人格文件 |
| `personaDirectFile` | 私聊人格文件 |
| `personaLessonsDir` | 课程记忆目录，`*.md` 按文件名排序拼接 |
| `stickerLevel` | 梗图积极度四档（`off` / `quiet` / `normal` / `active`），默认 `normal` = 本目录一个字都不动 |

路径可以是绝对路径、`~/` 开头的路径，或相对本包根目录的路径（默认写相对路径）。留空 = 不注入，行为与上游 0.5.5 一致。

拼合顺序：persona 文件 → lessons → 遗留的 `groupPrompt`/`directPrompt`。

## 写作纪律

1. 写**行为约束 + few-shot 对白**，不写形容词堆砌的人设说明书。
2. 绝不列「禁词清单」——把某个词写进「不许说 X」，等于把它放到她眼前反复提醒（大象效应）。禁令一律改写成第一人称信念：「我有杆秤」「我开口之前先过一道自家筛子」。
3. 课程记忆（`lessons/`）用自省句式，2～4 句一条；太长会被摘要稀释。
4. 语气词写「按情境出现」，不写「每句都要带」。
5. `lessons/` 里只放真正会影响所有回复的内容；本 README 不参与注入。

## `sticker-levels.md`：梗图积极度的文案正本

`stickerLevel` 的 `quiet` / `active` 两档要说的那几句话，不在代码里，就在这个文件（`## quiet` / `## active` 分节，同样按 mtime 热加载，改完存盘即生效）。措辞进代码是本仓库的红线之外的另一件事：**人格一律进 Markdown**。

- 改写靠锚点：`akane-group.md` 里含 `akane-sticker` 的那一行会被**原地替换**成对应档位的文案（`active` 是 1 行换 2 行）。所以那一行的 token 不能丢——丢了 `quiet` / `active` 就静默失效，`off` 也剥不掉任何东西。`pnpm test` 钉住「恰好一行含该 token」，改坏当场红，不用等现网发现。
- `normal` 是恒等档：本目录所有文件一个字都不动，这是「升级零行为变化」的前提。`off` 不需要文案，只做剥行。
- 只有**群** persona 有这一行，私聊 persona 没有 ⇒ 四档对私聊全是恒等（这是设计，不是漏配）。
- `## normal` 写了也没人读，`## ` 后面的名字不是这四档之一也会被忽略。
