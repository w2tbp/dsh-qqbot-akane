import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { classifyContentType, isVoiceContentType, } from "./attachment.js";
import { clearGroupHistory } from "../features/history-store.js";
import { getMediaLedger } from "../features/media-ledger.js";
// ── 框架协议标记 ──
// 措辞与上游 body-assembler 对齐：她读过的其它 channel 用的是同一批括号标记，换词只会多一层噪音
const QUOTE_END = '[Quoted message ends]';
const CURRENT_MSG = '[Current message]';
const MERGED_BEGIN = '[Merged messages begins]';
const MERGED_END = '[Merged messages ends]';
// ── 主处理函数 ──
/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(ctx, manager, config, logger) {
    const msg = ctx.message;
    const mwState = ctx.state;
    const { bot } = ctx;
    const scope = msg.kind === 'group' ? 'group' : 'c2c';
    const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
    const replyTarget = {
        scope,
        targetId: peerId,
        msgId: msg.messageId,
    };
    // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
    const agentBody = assembleAgentBody(msg, mwState, scope, logger);
    if (!agentBody)
        return;
    logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);
    // ── 获取或创建会话 ──
    let record;
    try {
        record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
    }
    catch (err) {
        logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
        // 兜底回复：会话创建失败时告知用户，避免静默无响应
        try {
            await bot.sendMarkdown(replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。');
        }
        catch (sendErr) {
            logger.error(`fallback reply failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
        }
        return;
    }
    // ── 构建 UserMessage → followup ──
    const content = [{ type: 'text', text: agentBody }];
    const message = createUserMessage({
        content,
        source: { kind: 'user' },
    });
    record.agent.followup(message);
    logger.info(`→ followup sent: key=${scope}:${peerId}`);
    // 群消息回复后清空历史缓存（避免下次 @ 时重复组包）
    if (scope === 'group') {
        clearGroupHistory(config.appId, msg.groupOpenid ?? msg.senderId);
    }
    // 阻塞等待本轮 turn 收敛，避免后续消息在 turn 运行期间被 followup 打断
    try {
        await record.agent.whenIdle();
    }
    catch (err) {
        logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
}
// ══════════════════════════════════════════════════════════════
// Body Assembly（5 层组装）
// ══════════════════════════════════════════════════════════════
/**
 * 组装 agentBody — AI 实际看到的完整上下文
 *
 * awakened = 显式 @ 或隐式唤醒。上游 0.5.5 的三处判断只看 wasMentioned，
 * 导致喊名字那条消息既拿不到群历史、也不知道自己被叫 —— 隐式唤醒等于失忆。
 * 标记仍保持区分：显式 (@you)，隐式（有人喊你）。
 */
export function assembleAgentBody(msg, state, scope, logger) {
    const isGroup = scope === 'group';
    const wasMentioned = state.mention?.wasMentioned ?? false;
    const awakened = wasMentioned || (state.mention?.implicit ?? false);
    const userContent = buildUserContent(msg, state, logger);
    // 合并批次的分片视图（含幸存者，按到达顺序）。单轮未合并时缺席。
    const fragments = state.akaneMergedFragments;
    if (isEmptyMessage(userContent, msg.attachments, isGroup, awakened, fragments))
        return null;
    const quotePart = buildQuotePart(state.quote);
    const userMessage = buildUserMessage(userContent, quotePart, msg.senderId, msg.senderName, isGroup, wasMentioned, awakened, fragments);
    const dynamicCtx = buildDynamicCtx(msg, state);
    const base = dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
    const agentBody = buildAgentBody(base, state.history, isGroup, awakened);
    return agentBody;
}
/**
 * 判断消息是否为空：无文本/语音/附件，且群聊未被唤醒。
 * 群聊被 @ 或被唤醒词喊到都视为有效触发信号，即使内容为空也保留给 agent。
 *
 * 合并批次还要看早期分片：幸存者可能是个空壳（"@她 + 单发一张图" 之后又补一句
 * 没字的），只看这一条会把整批判成空、整批丢掉。
 */
function isEmptyMessage(userContent, attachments, isGroup, awakened, fragments) {
    if (userContent)
        return false;
    if (attachments && attachments.length > 0)
        return false;
    if (fragments?.some((f) => f.content !== ''))
        return false;
    if (isGroup && awakened)
        return false;
    return true;
}
/**
 * Layer 1: 用户文本内容 + 语音转录 + 附件类型标签（媒体路径由 buildDynamicCtx 提供）
 */
function buildUserContent(msg, state, logger) {
    const parts = [];
    const text = (msg.content ?? '').trim();
    if (text) {
        parts.push(text);
    }
    const voiceTexts = extractVoiceTexts(msg.attachments, state.processedAttachments, logger);
    if (voiceTexts.length > 0) {
        for (const vt of voiceTexts) {
            const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
            parts.push(`[Voice message${durationTag}] ${vt.text}`);
        }
    }
    // 附件类型标签（媒体路径由 buildDynamicCtx 提供，这里只提示「带了什么」）
    const attachmentTags = buildAttachmentTags(msg.attachments);
    if (attachmentTags) {
        parts.push(attachmentTags);
    }
    return parts.join('\n');
}
/**
 * Layer 2: 引用消息块
 */
function buildQuotePart(quote) {
    if (!quote?.text && !quote?.entry?.content)
        return '';
    const quoteText = quote.text || quote.entry?.content || 'Original content unavailable';
    return `[Quoted message begins]\n${quoteText}\n${QUOTE_END}\n${CURRENT_MSG}\n`;
}
/**
 * Layer 3: 带发送者标签的用户消息
 *
 * 合并批次（同目标在她忙时攒下的分片）必须保住归属：SDK 的 defaultMerge 把
 * 多片拼成一份正文，而这里只渲染一个发送人，于是"张三三条 + 李四三条"会读成
 * "一个人说了六句话"。规则与上游 body-assembler 同形 —— 同一人裸拼（少一层噪音），
 * 不同人才分段，且触发标记只贴最后一片。
 */
function buildUserMessage(userContent, quotePart, senderId, senderName, isGroup, wasMentioned, awakened, fragments) {
    // 两种触发方式给不同标记：她需要知道是「被 @ 了」还是「有人喊名字」
    const mentionTag = wasMentioned ? ' (@you)' : awakened ? '（有人喊你）' : '';
    const displayName = senderName ?? shortSenderId(senderId);
    const currentLine = isGroup
        ? `[${displayName} (${senderId})] ${userContent}${mentionTag}`
        : userContent;
    if (!fragments || fragments.length <= 1)
        return `${quotePart}${currentLine}`;
    // 早期分片只出文字行：媒体与语音统一归到幸存者那一行（下载与 STT 发生在合并之后）
    const earlier = fragments.slice(0, -1).filter((f) => f.content !== '');
    if (earlier.length === 0)
        return `${quotePart}${currentLine}`;
    const earlierLines = earlier.map((f) => {
        const name = f.senderName ?? shortSenderId(f.senderId);
        return isGroup ? `[${name} (${f.senderId})] ${f.content}` : f.content;
    });
    if (!isGroup || earlier.every((f) => f.senderId === senderId)) {
        return `${quotePart}${[...earlierLines, currentLine].join('\n')}`;
    }
    return [
        `${quotePart}${MERGED_BEGIN}`,
        ...earlierLines,
        MERGED_END,
        CURRENT_MSG,
        currentLine,
    ].join('\n');
}
/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
function buildDynamicCtx(msg, state) {
    const lines = [];
    if (msg.attachments && msg.attachments.length > 0) {
        const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));
        const voices = [];
        // 一次遍历归类 + 生成媒体行
        for (const att of msg.attachments) {
            const kind = classifyContentType(att.content_type);
            if (kind === 'voice') {
                voices.push(att);
                continue;
            }
            const d = downloadedByFilename.get(att.filename);
            lines.push(`- ${renderMediaLine(kind, att.filename, d?.localPath, att.url, att.size)}`);
        }
        // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
        if (voices.length > 0) {
            const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
            if (asrTexts.length > 0) {
                lines.push(`- ASR: ${asrTexts.join(' | ')}`);
            }
            else {
                const urls = voices.map(a => a.url).filter(Boolean);
                if (urls.length > 0)
                    lines.push(`- Voice: ${urls.join(', ')}`);
            }
        }
    }
    // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
    const quoteAttachments = state.quote?.attachments;
    if (quoteAttachments && quoteAttachments.length > 0) {
        const downloadedQuote = new Map((state.downloadedQuoteFiles ?? []).map(d => [d.filename, d]));
        lines.push('[Reference attachments]');
        for (const qa of quoteAttachments) {
            const kind = classifyContentType(qa.contentType);
            const d = downloadedQuote.get(qa.filename ?? '');
            if (kind === 'voice') {
                if (qa.asrText)
                    lines.push(`  - Voice: ${qa.asrText}`);
                continue;
            }
            lines.push(`  - ${renderMediaLine(kind, qa.filename, d?.localPath, qa.url, undefined)}`);
        }
    }
    return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}
/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理（见 buildDynamicCtx）。
 */
function renderMediaLine(kind, filename, localPath, url, size) {
    switch (kind) {
        case 'image':
            return localPath
                ? `Image: ${localPath}`
                : `Image: ${url ?? filename ?? 'image'}`;
        case 'video':
            return localPath
                ? `Video: ${localPath}`
                : `Video: ${filename ?? 'video'} (download failed)`;
        case 'file':
            return localPath
                ? `File: ${localPath}`
                : `File: ${filename ?? 'file'} (${formatFileSize(size ?? 0)})`;
    }
}
/**
 * 每轮组装里最多带几个历史图片路径。
 * 只读图就要花掉一次工具调用，全部给出去既挤占正文也没人看图。
 */
const MAX_HISTORY_IMAGE_PATHS = 4;
/** 历史附件行的缩进（挂在消息行下面，一眼看出这张图属于哪句话） */
const HISTORY_MEDIA_INDENT = '        └ ';
/**
 * 历史里一条附件的渲染。
 * 没有本地路径时**不给 URL**：她打不开远程链接，把签名地址写进上下文只是污染。
 */
function renderHistoryAttachmentLine(att, localPath) {
    const kind = classifyContentType(att.contentType);
    if (kind !== 'voice' && localPath) {
        return `${HISTORY_MEDIA_INDENT}${renderMediaLine(kind, att.filename, localPath, undefined, att.size)}`;
    }
    switch (kind) {
        case 'image': return `${HISTORY_MEDIA_INDENT}[图片]`;
        case 'video': return `${HISTORY_MEDIA_INDENT}[视频]`;
        case 'file':
            return `${HISTORY_MEDIA_INDENT}[文件: ${att.filename || 'file'}${att.size ? ` (${formatFileSize(att.size)})` : ''}]`;
        case 'voice': return `${HISTORY_MEDIA_INDENT}[语音]`; // 进不了历史元数据，只为穷尽 MediaKind
    }
}
/**
 * Layer 5: 最终 agentBody 拼合
 *
 * 历史条目带附件元数据，但落盘路径不在条目里 —— 现问账本，
 * 这样 TTL 清理掉的文件不会被当成有效路径递给她（她点开就是工具报错，报错会原样发上 QQ）。
 */
function buildAgentBody(base, history, isGroup, awakened) {
    if (!isGroup || !awakened || !history || history.length === 0) {
        return base;
    }
    const ledger = getMediaLedger();
    const perEntry = history.map(h => h.attachments ?? []);
    // 从最新往回分配额度：越新的图越可能是她接下来要被问的那张。
    // 键是附件对象本身，一次组装内每个附件只出现一回，不必维护平行下标。
    const withPath = new Map();
    for (let i = perEntry.length - 1; i >= 0; i--) {
        const atts = perEntry[i] ?? [];
        for (let j = atts.length - 1; j >= 0; j--) {
            if (withPath.size >= MAX_HISTORY_IMAGE_PATHS)
                break;
            const att = atts[j];
            if (!att)
                continue;
            const path = ledger.resolve(att);
            if (path)
                withPath.set(att, path);
        }
    }
    const historyLines = [];
    perEntry.forEach((atts, i) => {
        const entry = history[i];
        if (!entry)
            return;
        const name = entry.senderName ?? shortSenderId(entry.senderId);
        // 纯图片消息正文为空，不 trimEnd 会留一条尾巴空白的行 —— 正是这次要修的病灶
        historyLines.push(`[${name} (${entry.senderId})] ${entry.content}`.trimEnd());
        for (const att of atts)
            historyLines.push(renderHistoryAttachmentLine(att, withPath.get(att)));
    });
    return [
        '[Chat history begins]',
        ...historyLines,
        '',
        '[Chat history ends]',
        '[Current message]',
        base,
    ].join('\n');
}
function extractVoiceTexts(attachments, processed, _logger) {
    const results = [];
    if (processed) {
        for (const pa of processed) {
            if (pa.type === 'voice' && pa.voiceText) {
                results.push({
                    text: pa.voiceText,
                    duration: pa.duration,
                    source: pa.voiceSource ?? 'stt',
                });
            }
        }
    }
    if (results.length === 0 && attachments) {
        for (const att of attachments) {
            if (isVoiceContentType(att.content_type) && att.asr_refer_text) {
                results.push({
                    text: att.asr_refer_text.trim(),
                    source: 'asr',
                });
            }
        }
    }
    return results;
}
/**
 * 附件类型标签（Layer 1 用户消息主体里的轻量提示）。
 * 只标注「带了什么类型的附件」，去重；媒体本地路径在 buildDynamicCtx 提供。
 */
function buildAttachmentTags(attachments) {
    if (!attachments || attachments.length === 0)
        return '';
    const labels = {
        image: '[图片]',
        video: '[视频]',
        file: '[文件]',
    };
    const seen = new Set();
    const tags = [];
    for (const att of attachments) {
        const kind = classifyContentType(att.content_type);
        if (kind === 'voice' || seen.has(kind))
            continue;
        seen.add(kind);
        const label = labels[kind];
        if (label)
            tags.push(label);
    }
    return tags.join(' ');
}
function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
/** 发送者短标识长度（openid 前 N 位，无昵称时兜底） */
const SENDER_SHORT_ID_LEN = 8;
/** 无昵称时用 openid 前 N 位作为匿名标识 */
function shortSenderId(senderId) {
    return senderId.slice(0, SENDER_SHORT_ID_LEN);
}
//# sourceMappingURL=inbound.js.map