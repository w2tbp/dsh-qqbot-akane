/**
 * T1 转录 → chunk 边界（MEMORY.md §1「一个想法一条」的落地处）
 *
 * 两件事必须在这里做对，否则整条索引建在污染文本上：
 *
 * 1. **只取 `[Current message]` 之后那段**。现网渲染形状（transport/inbound.ts:457-468）
 *    是 `[Chat history begins] …群历史… [Chat history ends]\n[Current message] <真正那一句>`。
 *    实测她那 4 份转录里 61/136 条 user 正文带这层脚手架、其中 18 条还嵌着
 *    `└ Image: <绝对路径>`。整段嵌进向量 = 每个 chunk 都含着同一份群历史样板，
 *    top-k 全是样板的近似重复；而主机绝对路径进索引直接撞 §5 红线。
 *
 * 2. **阈值与 `quietWindowMs` 同源同值**（§1.4）。chunk 边界就是折叠边界，
 *    两头各定一套 = 折叠说一条、chunk 说两条。窗口值今天仍是临时量
 *    （46 条样本 / 门槛 300 对），所以这里继承「临时」标记，不另定数字。
 *    `quietWindowMs <= 0`（窗口关）时一条事件就是一个 chunk —— 与关窗时的现网一致。
 *
 * 能力上限（§1，必须写进 README）：没点她名、也没被她那一轮拼进上下文的话，
 * **转录里就没有**。回填只能在盘上的东西之间划边界，划不出没存的东西。
 */
const HISTORY_HEADER = '[Chat history begins]';
const HISTORY_FOOTER = '[Chat history ends]';
const CURRENT_MARKER = '[Current message]';
/** 图片痕迹：现网两种降级/挂图标记（inbound.ts:405-411） */
const MEDIA_MARKS = ['└ Image:', '[图片]'];
/** `└ Image: <绝对路径>` 整行：布尔留痕，路径一行都不进 T2 */
const MEDIA_LINE = /^[ \t]*└[ \t]*Image:[^\n]*$/gm;
/**
 * 剥掉脚手架，只留「那一轮真正收到的那句话」。
 *
 * 有历史头却没有当前标记 → 返回空串（判不出正文从哪开始，宁可丢弃也不许把
 * 样板当她的话入库）。丢弃由 chunkEvents 计数上报。
 */
export function extractCurrentMessage(rawText) {
    const at = rawText.indexOf(CURRENT_MARKER);
    if (at >= 0)
        return rawText.slice(at + CURRENT_MARKER.length).replace(/^\s*\n/, '').trim();
    if (rawText.includes(HISTORY_HEADER) || rawText.includes(HISTORY_FOOTER))
        return '';
    return rawText.trim();
}
/**
 * 按「同角色 + 间隔 ≤ quietWindowMs」把事件串成 chunk。
 *
 * 不同角色绝不合并：她的回答和对方的追问合成一条会让「你说过 X」这类出处失真。
 *
 * `strictGap: true`（增量同步必须）：只允许「严格小于窗口」相连。等于窗界的续句
 * 已经被静默窗口放行了，而增量作业只喂游标之后的新事件 —— 允许相等会把一段话
 * 拆到两轮作业里。回填首轮喂的是整个会话，关着无所谓。
 *
 * `hasMedia` 在回填路径上**天生不可靠**：实测她那 4 份转录的 user 事件 content
 * 只有 `text` 块（136/136），带图的轮次在盘上没有独立附件记录，所以历史 chunk
 * 大多会记成 false。只有正文里真出现图片痕迹才填 true —— 别把这个字段当事实来源。
 */
export function chunkEvents(events, quietWindowMs, options = {}) {
    const chunks = [];
    const dropped = [];
    let run = [];
    const flush = () => {
        if (run.length === 0)
            return;
        const texts = run.map((e) => e.text).filter((t) => t !== '');
        if (texts.length > 0) {
            chunks.push({
                seqStart: run[0].seq,
                seqEnd: run[run.length - 1].seq,
                time: run[0].time,
                role: run[0].role,
                hasMedia: run.some((e) => e.media),
                textLen: texts.join('\n').length,
                text: texts.join('\n'),
            });
        }
        run = [];
    };
    for (const event of events) {
        const extracted = extractCurrentMessage(event.rawText);
        if (extracted === '') {
            const scaffolding = event.rawText.includes(HISTORY_HEADER) || event.rawText.includes(HISTORY_FOOTER);
            dropped.push({ seq: event.seq, reason: scaffolding ? 'no-current-message' : 'empty' });
            continue;
        }
        // 死路径进索引 = 将来发出去一个工具报错（§4 淘汰条 + §5），所以布尔留痕、路径删净
        const media = MEDIA_MARKS.some((mark) => extracted.includes(mark));
        const text = extracted.replace(MEDIA_LINE, '').trim();
        if (text === '') {
            dropped.push({ seq: event.seq, reason: 'empty' });
            continue;
        }
        const last = run[run.length - 1];
        const gap = last === undefined ? -1 : event.time - last.time;
        const connected = options.strictGap === true ? gap < quietWindowMs : gap <= quietWindowMs;
        const mergeable = last !== undefined && last.role === event.role && quietWindowMs > 0 && connected;
        if (!mergeable)
            flush();
        run.push({ seq: event.seq, time: event.time, role: event.role, text, media });
    }
    flush();
    return { chunks, dropped };
}
//# sourceMappingURL=chunking.js.map