/**
 * dsh-im-qqbot-akane 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';
/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema = Schema.object({
    c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式（默认开放）'),
    c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单（QQ OpenID）'),
    c2cDeny: Schema.array(Schema.string()).default([]).description('C2C黑名单（QQ OpenID）：命中直接零输出，连解释也不发'),
    groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式（默认开放：群自带进群门槛 + @bot 触发）'),
    groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单（群 OpenID）'),
    groupDeny: Schema.array(Schema.string()).default([]).description('群成员黑名单（发送者 QQ OpenID）：按人屏蔽，即使 @ 了本 bot 也不回'),
});
/**
 * 记忆库子 Schema（独立导出：config 路由的 `memory` 局部合并校验复用）。
 * 设置页只允许改 `enabled`，其余四键靠合并现值保留，不刷回默认。
 */
export const MemoryConfigSchema = Schema.object({
    enabled: Schema.boolean().default(false).description('记忆库总开关：关闭时不建 index/、不起后台作业、不注册工具（零行为变化）'),
    embedBaseUrl: Schema.string().default('http://127.0.0.1:8765').description('本机常驻 embedding 服务基址（只接受回环地址，其他一律拒绝）'),
    timeoutMs: Schema.number().default(8000).description('单次嵌入往返超时(ms)'),
    dims: Schema.number().default(512).description('向量维度（与模型绑定，不符即整体重建）'),
    syncIntervalMs: Schema.number().default(600000).description('后台同步间隔(ms)，首轮跑完即全量回填'),
});
export const ConfigSchema = Schema.object({
    appId: Schema.string().default('').description('QQ 机器人 AppID'),
    appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
    provider: Schema.string().description('LLM provider name'),
    model: Schema.string().description('Model name'),
    preset: Schema.string().description('Agent preset id'),
    cwd: Schema.string().description('Agent working directory (default ~/.dsh-qqbot-akane/workspace)'),
    requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
    groupPrompt: Schema.string().description('群聊额外system prompt'),
    directPrompt: Schema.string().description('私聊额外system prompt'),
    personaGroupFile: Schema.string().default('').description('群聊人格文件路径（空=不注入；相对路径按插件包根解析）'),
    personaDirectFile: Schema.string().default('').description('私聊人格文件路径'),
    personaLessonsDir: Schema.string().default('').description('课程记忆目录（*.md 按文件名排序拼接）'),
    personaEnabled: Schema.boolean().default(true).description('人格注入总开关：关掉时 persona 文件、lessons、legacy prompt 全都不进 system prompt'),
    stickersEnabled: Schema.boolean().default(true).description('梗图功能开关（软关）：关掉时只剥 persona 里那句梗图库提示；图库与 skill 不动'),
    textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
    streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
    sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
    maxQueue: Schema.number().default(20).description('并发队列最大长度'),
    processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
    askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
    quietWindowMs: Schema.number().default(0).description('空闲静默窗口(ms)，攒同一个人的连续分片；0=关闭。开启前须有现网到达间隔样本（spec §5 D2）'),
    quietWindowEmptyShellMs: Schema.number().default(0).description('空壳分片（只有@/称呼）的长窗口(ms)，0=沿用 quietWindowMs'),
    quietWindowMaxWaitMs: Schema.number().default(0).description('静默窗口从首片起的最长等待硬顶(ms)，开启时必须 > 0'),
    quietWindowMaxFragments: Schema.number().default(4).description('静默窗口最多攒几条分片，达到即放行（安全阀，与 maxQueue 不同层）'),
    arrivalProbe: Schema.object({
        enabled: Schema.boolean().default(false).description('到达间隔插桩：只记 messageId+接收毫秒+桶散列，用来定 quietWindowMs 默认值；关闭时零写入'),
        keepDays: Schema.number().default(30).description('插桩文件保留天数，0=永不过期'),
    }).default({ enabled: false, keepDays: 30 }).description('到达间隔插桩（观测用）'),
    historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
    wakeWords: Schema.array(Schema.string()).default([]).description('群聊隐式唤醒词（强词：独立成词即触发，命中即回）'),
    wakeWordsWeak: Schema.array(Schema.string()).default([]).description('群聊隐式唤醒词（弱词：需句首/称呼标点/后接疑问等呼格信号）'),
    wakeWordExcludes: Schema.array(Schema.string()).default([]).description('唤醒排除片段（熊猫/猫粮一类复合词，命中处不计）'),
    access: AccessControlSchema.default({
        c2cMode: 'open',
        c2cAllow: [],
        c2cDeny: [],
        groupMode: 'open',
        groupAllow: [],
        groupDeny: [],
    }).description('访问控制'),
    showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（错误始终展示）'),
    debug: Schema.boolean().default(false),
    media: Schema.object({
        enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
        maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
        ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
    }).default({
        enabled: true,
        maxMB: 200,
        ttlHours: 24,
    }).description('富媒体理解配置'),
    vision: Schema.object({
        enabled: Schema.boolean().default(false).description('是否启用视觉理解（akane_describe_image 工具）'),
        provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
        model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
        defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
        maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
        maxTokens: Schema.number().default(1024).description('输出 token 上限'),
        timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
    }).default({
        enabled: false,
        provider: '',
        model: '',
        defaultPrompt: 'Describe this image in detail.',
        maxBytes: 10 * 1024 * 1024,
        maxTokens: 1024,
        timeoutMs: 120000,
    }).description('视觉理解配置'),
    sendFile: Schema.object({
        restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
        extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
        sendPresentedFiles: Schema.boolean().default(true).description('是否将 present 声明的交付文件发送到当前会话'),
        maxFiles: Schema.number().default(4).description('单轮最多投递的交付文件数'),
    }).default({
        restrictPaths: true,
        extraRoots: [],
        sendPresentedFiles: true,
        maxFiles: 4,
    }).description('附件发送配置'),
    memory: MemoryConfigSchema.default({
        enabled: false,
        embedBaseUrl: 'http://127.0.0.1:8765',
        timeoutMs: 8000,
        dims: 512,
        syncIntervalMs: 600000,
    }).description('记忆库 T2 索引与回填（默认关）'),
});
//# sourceMappingURL=config.js.map