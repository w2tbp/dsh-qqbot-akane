/**
 * 群聊隐式唤醒（R1）
 *
 * 唯一判据是「这句话在喊她」还是「这句话提到了这个名字」，靠词法边界区分：
 * 中文没有词间空格，所以「我叫茜茜」「我家熊猫」里的名字两侧都不是边界字符，不构成呼喊。
 *
 * senderName 与群历史永不进匹配串 —— 昵称里含唤醒词会 100% 误触发，
 * 历史里她自己的「猫娘」自称会自激。
 */
/** 参与匹配的最大字符数，超出截断：病态长文本不该把正则拖死，唤醒词一般也在句首 */
const MAX_SCAN_LENGTH = 2000;
/** 词边界字符：空白 + ASCII 标点 + CJK 标点 + 少量装饰符。汉字、字母、数字都不在内。 */
const BOUNDARY = '\\s\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E' +
    '\\u2010-\\u2027\\u3000-\\u303F\\uFF01-\\uFF20\\uFF5B-\\uFF65\\u2605\\u2606';
/** 称呼标点：边界字符去掉空白。弱词要「紧跟标点」才算被叫住 */
const ADDRESS_PUNCT = '\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E' +
    '\\u2010-\\u2027\\u3000-\\u303F\\uFF01-\\uFF20\\uFF5B-\\uFF65';
/** 呼格信号字：名字后紧跟这些字，说明句子在对她说话，而不是在描述一个东西 */
const VOCATIVE = '你您能帮请在吗呢吧咋啥谁怎想问谢呗';
/** BOUNDARY 的单字符判定版，逐字符扫描用 */
const BOUNDARY_CH_RE = new RegExp(`[${BOUNDARY}]`);
/** 拉丁词的邻接字符：任何字母/数字/下划线（含汉字），出现即说明名字是更长串的一部分 */
const CONTINUATION = '\\p{L}\\p{N}_';
/** 拉丁词右界的邻接字符：只认 ASCII。汉字紧跟在名字后面是中文喊人的正常写法，不是词组接续 */
const ASCII_CONTINUATION = 'A-Za-z0-9_';
/** 句末语气词：这些字后面另起一个名字是在喊人（「真的吗akane」），不构成词组接续 */
const SENTENCE_PARTICLE = '吗呢吧啊呀哦噢哈嘛喽哟嘞啦';
/** 元语言守卫：名字后 4 个实义字符内出现「字/词」，是在讨论这个词本身，不算呼喊 */
const META_TAIL_WINDOW = 4;
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** 等长掩码：填空格保持其余字符下标不变，后续每条正则看到的坐标是同一套 */
function blank(match) {
    return ' '.repeat(match.length);
}
function maskBy(content, source, flags) {
    return content.replace(new RegExp(source, flags), blank);
}
/**
 * 成对标记掩码（代码围栏 / 行内代码）。
 *
 * 用 indexOf 成对切而不是 [\\s\\]*? 一类正则：后者在未闭合标记 + 长文本下会回溯到 O(n^2)。
 * 未闭合的起始标记一律掩到行尾（行内）或文末（围栏）。
 */
function maskPaired(content, marker, lineBounded) {
    let out = content;
    let from = 0;
    for (;;) {
        const open = out.indexOf(marker, from);
        if (open < 0)
            return out;
        const searchFrom = open + marker.length;
        let close = out.indexOf(marker, searchFrom);
        const newline = out.indexOf('\n', searchFrom);
        if (lineBounded) {
            if (newline >= 0 && (close < 0 || close > newline)) {
                // 同一行内没有闭合标记：这不是行内代码，跳过这个起始标记继续找下一处
                from = searchFrom;
                continue;
            }
        }
        const end = close < 0 ? out.length : close + marker.length;
        out = out.slice(0, open) + blank(out.slice(open, end)) + out.slice(end);
        if (close < 0)
            return out;
        from = end;
    }
}
/**
 * 匹配前清洗：按序剥掉「不是人话」的部分，全部等长掩码。
 *
 * mentions 里的昵称也掩掉 —— 有人 @ 别的群友，而那个群友昵称里带「茜」，不算喊她。
 */
export function prepareText(raw, mentions) {
    let text = raw.length > MAX_SCAN_LENGTH ? raw.slice(0, MAX_SCAN_LENGTH) : raw;
    // 表情标签：与 contentSanitizer(parseFaceTags:true) 处理的两种原始格式同构
    text = maskBy(text, '\\[<face,id=\\d+\\/?>]', 'g');
    text = maskBy(text, '<faceType=\\d+,faceId="[^"]*",ext="[^"]*">', 'g');
    // @marker：<@!{id}>，数字 id 本身不是文本；本 bot 与他人一视同仁
    text = maskBy(text, '<@!?\\d+>', 'g');
    // 代码块 → 行内代码 → URL → markdown 结构
    text = maskPaired(text, '```', false);
    text = maskPaired(text, '`', true);
    text = maskBy(text, '(?:https?|ftp|wss?)://\\S+', 'gi');
    text = maskBy(text, '\\bwww\\.\\S+', 'gi');
    // `_` 不掩：它是 \w 的一部分，掩掉会把 user_akane_id 一类标识符切成独立词
    text = maskBy(text, '[*~#|\\[\\]<>]', 'g');
    // @别人昵称：长名优先，避免「阿茜」被「茜」抢先掩掉半截
    const names = new Set();
    for (const mention of mentions ?? []) {
        for (const name of [mention?.nickname, mention?.username]) {
            const value = typeof name === 'string' ? name.trim() : '';
            if (value.length >= 2)
                names.add(value);
        }
    }
    for (const name of [...names].sort((a, b) => b.length - a.length)) {
        text = maskBy(text, escapeRegExp(name), 'gi');
    }
    return text;
}
const ASCII_WORD_RE = /^[0-9A-Za-z]+$/;
/**
 * 单条词 → 带边界的正则。
 *
 * 拉丁词的左右两道守卫故意不对称：
 * 左界保守 —— 用 \p{L}\p{N} 而不是 \w，「我叫akane」「喜欢akane的人」里的汉字算接续，
 * 靠它把「谈论她」的陈述句整体挡掉；唯一例外是句末语气词，「真的吗akane」是新起一次呼喊。
 * 右界放宽 —— 只禁 ASCII 邻接。「akane说话」「akane你觉得呢」是中文群里喊人最正常的写法，
 * 把汉字当接续会连它们一起挡掉（现网实测漏触发）；代价是句首聊她的「akane真可爱」也会命中。
 *
 * 含中文的词走边界字符类，汉字永远不是边界字符 —— 这正是「看到茜发的那个图」不误命中的来源。
 */
function buildWordPattern(word, tier) {
    const escaped = escapeRegExp(word);
    if (!escaped)
        return null;
    if (ASCII_WORD_RE.test(word)) {
        const left = `(?:(?<=[${SENTENCE_PARTICLE}])|(?<![${CONTINUATION}]))`;
        return new RegExp(`${left}${escaped}(?![${ASCII_CONTINUATION}])`, 'giu');
    }
    const left = `(?:^|(?<=[${BOUNDARY}]))`;
    // 右界只给「最短最含糊」的词加：单字词（茜）和弱词（猫）。
    // 两字以上的强词本身已经够具体，「猫娘是什么物种」这类句子该回——左界已经挡住了「她是猫娘」。
    if (tier === 'weak' || [...word].length === 1) {
        const right = tier === 'strong'
            ? `(?=$|[${BOUNDARY}${VOCATIVE}])`
            : `(?:(?=[${ADDRESS_PUNCT}])|(?=(?:[${BOUNDARY}])*[${VOCATIVE}]))`;
        return new RegExp(`${left}${escaped}${right}`, 'gi');
    }
    return new RegExp(`${left}${escaped}`, 'gi');
}
export function compileWordlist(tables) {
    const words = [];
    const seen = new Set();
    const push = (list, tier) => {
        for (const raw of list ?? []) {
            const word = typeof raw === 'string' ? raw.trim() : '';
            if (!word)
                continue;
            const key = `${tier}:${word.toLowerCase()}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            const re = buildWordPattern(word, tier);
            if (re)
                words.push({ word, tier, re });
        }
    };
    push(tables.strong, 'strong');
    push(tables.weak, 'weak');
    // 长片段优先：先掩「猫罐头」再掩「猫粮」，短的抢先把长的切碎会漏排除
    const excludes = [...new Set((tables.excludes ?? []).map((w) => (w ?? '').trim()).filter(Boolean))]
        .sort((a, b) => b.length - a.length);
    return { words, excludes };
}
/** 名字之后是否在讨论「这个字/词」本身 */
function isMetaCommentary(text, after) {
    let real = '';
    for (let i = after; i < text.length && real.length < META_TAIL_WINDOW; i++) {
        const ch = text.charAt(i);
        if (BOUNDARY_CH_RE.test(ch))
            continue;
        real += ch;
    }
    return /[字词]/.test(real);
}
/**
 * 匹配主流程：排除片段掩码 → 强词 → 弱词。
 *
 * 输入必须是 prepareText 之后的掩码文本；这里不再做长度裁剪，因为掩码前已经裁过。
 */
export function scanWake(prepared, compiled) {
    let text = prepared;
    for (const fragment of compiled.excludes) {
        text = maskBy(text, escapeRegExp(fragment), 'gi');
    }
    for (const { word, tier, re } of compiled.words) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(text)) !== null) {
            const after = match.index + match[0].length;
            if (!isMetaCommentary(text, after))
                return { word, tier, index: match.index };
            // 零宽防御：万一某个模板匹配了空串，不让它原地打转
            if (match[0].length === 0)
                re.lastIndex++;
        }
    }
    return null;
}
/** 复刻 mentionGate 的显式 @ 判定，命中即让位给 wasMentioned，避免 reason 归类错乱 */
export function isExplicitMention(msg, appId) {
    if (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE')
        return true;
    const mentions = msg.mentions;
    if (Array.isArray(mentions) && mentions.some((m) => m?.is_you === true))
        return true;
    if (appId && msg.content) {
        return new RegExp(`<@!?${escapeRegExp(appId)}>`).test(msg.content);
    }
    return false;
}
/**
 * 构建唤醒探测函数，供 mentionGate 的 isImplicitMention 使用。
 *
 * 词表全空返回 null —— 调用方据此连回调都不注入，关闭态零开销、行为与 0.5.5 逐字节一致。
 */
export function createWaker(options) {
    const compiled = compileWordlist(options);
    if (compiled.words.length === 0)
        return null;
    const appId = options.appId ?? '';
    return (msg) => {
        try {
            if (isExplicitMention(msg, appId))
                return false;
            const hit = scanWake(prepareText(msg.content ?? '', msg.mentions), compiled);
            if (!hit)
                return false;
            options.onHit?.(hit, msg);
            return true;
        }
        catch {
            // mentionGate 裸调这个回调、没有 try/catch，异常会撞最外层 errorHandler 静默丢消息
            return false;
        }
    };
}
/** 是否配置了唤醒词（决定要不要给 mentionGate 注入 isImplicitMention） */
export function hasWakeWords(config) {
    return (config.strong?.length ?? 0) > 0 || (config.weak?.length ?? 0) > 0;
}
//# sourceMappingURL=wake.js.map