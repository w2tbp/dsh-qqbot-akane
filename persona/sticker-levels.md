# 梗图积极度文案（`stickerLevel` 四档中的两档）

这四档改写的都是群 persona 里那句含 `akane-sticker` 的提示行，**原地替换、不动上下文**。
`persona/akane-group.md` 正本一个字不改；这里只放 `quiet` 和 `active` 两档要换上去的文案。

- `normal` 不写在这里：它是恒等档（persona 文件原样进 prompt，现网零变化），
  所以**往 `## normal` 写东西不会有任何效果**，别写。
- `off` 也不写在这里：它是删掉那一行，不需要文案。
- 锚点靠 `akane-sticker` 这个 token。谁把群 persona 那行的 token 删了，`quiet`/`active`
  就退化成「没效果」—— 这条由 `src/persona.test.ts` 钉住，改坏时 `pnpm test` 当场红。

改这个文件**存盘即生效**，不用 build、不用重启、不用点保存。

## quiet

- 手里有梗图库（`akane-sticker`）。只在群友点名要图、或他说的正好是库里某张图的字幕时才配，其余时候交纯文字就行；不用主动翻索引。

## active

- 手里有梗图库（`akane-sticker`）。吐槽、认怂、看戏、无语这类文字接不住的情绪，默认配一张，不用等点名——配错一张好收，该配没配才难补。
- 什么时候去翻索引（`stickers/INDEX.md`，就几十行）：这一轮想到了图，或者发现自己连着两轮只交了纯文字，那下一轮先读一遍索引再开口，对着「什么时候用」那列挑。报错、事故、安全、数据丢了、对方真在难受的轮次不配。
