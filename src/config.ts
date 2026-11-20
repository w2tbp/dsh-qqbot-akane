/**
 * dsh-im-qqbot-akane 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';

export interface AccessControlConfig {
  /** C2C 访问模式 */
  c2cMode: 'open' | 'allowlist' | 'disabled';
  /** C2C 白名单（user openid） */
  c2cAllow: string[];
  /** C2C 黑名单（user openid），优先于 mode 判定 */
  c2cDeny: string[];
  /** 群聊访问模式 */
  groupMode: 'open' | 'allowlist' | 'disabled';
  /** 群聊白名单（group openid） */
  groupAllow: string[];
  /** 群聊成员黑名单（sender openid），按人屏蔽，优先于 mode 判定 */
  groupDeny: string[];
}

export interface MediaConfig {
  /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
  enabled: boolean;
  /** 富媒体下载大小上限（MB），默认 200 */
  maxMB: number;
  /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
  ttlHours: number;
}

export interface VisionConfig {
  /** 是否启用视觉理解（akane_describe_image 工具） */
  enabled: boolean;
  /** 视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai） */
  provider: string;
  /** 视觉模型 id（如 qwen-vl-max） */
  model: string;
  /** 默认描述 prompt（调用未显式指定时使用） */
  defaultPrompt: string;
  /** 图片字节上限，默认 10MB */
  maxBytes: number;
  /** 输出 token 上限 */
  maxTokens: number;
  /** 视觉调用超时(ms) */
  timeoutMs: number;
}

/** 到达间隔插桩配置 — spec §5 D2：先量数据，再定 quietWindowMs 的默认值 */
export interface ArrivalProbeConfig {
  /** 是否开启插桩（默认关；关闭时不挂载中间件、不起定时器、目录都不创建） */
  enabled: boolean;
  /** 插桩文件保留天数，0 = 永不过期 */
  keepDays: number;
}

/** 附件发送配置（akane_send_file 工具与 present 交付物投递共用） */
export interface SendFileConfig {
  /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
  restrictPaths: boolean;
  /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
  extraRoots: string[];
  /** 是否把 present 声明的交付文件在轮末发送到当前会话 */
  sendPresentedFiles: boolean;
  /** 单轮最多投递的交付文件数 */
  maxFiles: number;
}

/**
 * 记忆库（T2 语义索引 + 回填）。**默认关闭**：`enabled=false` 时不建 `index/` 目录、
 * 不起后台作业、不注册任何工具 —— 关闭态零行为变化是 §7 P0 的验收项，不是愿望。
 *
 * 限额类参数一期不进设置页（§7），走 Schema 默认 + 注释标「临时」。
 */
export interface MemoryConfig {
  /** 总开关 */
  enabled: boolean;
  /**
   * 本机常驻 embedding 服务基址。只准回环地址：送进 `/embed` 的就是 chunk 正文，
   * 非回环等于把聊天内容发出去（客户端直接拒绝，见 memory/embed-client.ts）。
   */
  embedBaseUrl: string;
  /** 单次 HTTP 往返超时(ms) */
  timeoutMs: number;
  /** 向量维度：与模型绑定，与 meta.json 不符即整体重建（§4「不许新旧混存」） */
  dims: number;
  /** 后台同步间隔(ms)：首轮跑完即全量回填，之后按此增量 */
  syncIntervalMs: number;
}

export interface ImQQBotConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** dsh LLM 提供商名称 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** Agent preset id */
  preset?: string;
  /** Agent 工作目录（缺省 ~/.dsh-qqbot-akane/workspace，不随宿主进程 cwd） */
  cwd?: string;
  /** 是否启用群消息 @mention 门控 */
  requireMention: boolean;
  /** 群聊额外 system prompt（persona 文件的尾注，向后兼容保留） */
  groupPrompt?: string;
  /** 私聊额外 system prompt（persona 文件的尾注，向后兼容保留） */
  directPrompt?: string;
  /** 群聊人格文件路径（相对路径按插件包根解析；空 = 不注入） */
  personaGroupFile: string;
  /** 私聊人格文件路径 */
  personaDirectFile: string;
  /** 课程记忆目录（*.md 按文件名排序拼接） */
  personaLessonsDir: string;
  /**
   * 人格注入总开关。`false` 时 `buildPersona` 直接返空：三个 persona 文件、lessons
   * 目录、groupPrompt/directPrompt 全都不进 system prompt —— 她变成宿主的通用助手。
   * 默认 `true`，现网行为零变化。
   */
  personaEnabled: boolean;
  /**
   * 梗图功能开关（**软关**）。`false` 时只剥掉 persona 里那句「手里有梗图库（akane-sticker）」
   * 的提示行；图库文件与 skill 不动，她仍可能主动调用 `akane-sticker`。默认 `true`。
   */
  stickersEnabled: boolean;
  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 是否启用流式输出（群聊始终不启用） */
  streaming: boolean;
  /** 每会话最大闲置时长(ms)，超时自动回收 */
  sessionIdleTimeout: number;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** 处理超时(ms)，超时中断当前 LLM 调用 */
  processingTimeoutMs: number;
  /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
  askTimeoutMs: number;
  /**
   * 空闲静默窗口(ms)：门控之前攒同一个人的连续分片。**0 = 关闭**（默认），
   * 关闭态链序与改动前逐字节一致。数值待现网到达间隔样本定，见
   * docs/specs/2026-11-18-akane-fragment-merge-and-recall.md §5 D2。
   */
  quietWindowMs: number;
  /** 空壳分片（只有 @/称呼、没正文）的长窗口(ms)：此刻无话可答，等待成本为零 */
  quietWindowEmptyShellMs: number;
  /** 单个静默窗口从首片起的最长等待硬顶(ms)，到点必放行 */
  quietWindowMaxWaitMs: number;
  /** 单个静默窗口最多攒几条分片，达到即立即放行 */
  quietWindowMaxFragments: number;
  /** 到达间隔插桩（给 quietWindowMs 定默认值用，不参与任何判定） */
  arrivalProbe: ArrivalProbeConfig;
  /** 群历史缓冲条数 */
  historyLimit: number;
  /** 隐式唤醒强词表（空 = 关闭隐式唤醒，行为与不配一致） */
  wakeWords: string[];
  /** 隐式唤醒弱词表（需呼格信号） */
  wakeWordsWeak: string[];
  /** 隐式唤醒排除片段 */
  wakeWordExcludes: string[];
  /** 访问控制 */
  access: AccessControlConfig;
  /** 是否展示工具调用成功结果（工具错误始终展示） */
  showToolResults: boolean;
  /** 调试模式 */
  debug: boolean;
  /** 富媒体理解（图片/视频） */
  media: MediaConfig;
  /** 视觉理解（akane_describe_image 工具，走 dsh llm + attachments） */
  vision: VisionConfig;
  /** 附件发送（akane_send_file 工具与交付物投递共用） */
  sendFile: SendFileConfig;
  /** 记忆库 T2 索引与回填（默认关，关闭态零行为变化） */
  memory: MemoryConfig;
}

/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema: Schema<AccessControlConfig> = Schema.object({
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
export const MemoryConfigSchema: Schema<MemoryConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('记忆库总开关：关闭时不建 index/、不起后台作业、不注册工具（零行为变化）'),
  embedBaseUrl: Schema.string().default('http://127.0.0.1:8765').description('本机常驻 embedding 服务基址（只接受回环地址，其他一律拒绝）'),
  timeoutMs: Schema.number().default(8000).description('单次嵌入往返超时(ms)'),
  dims: Schema.number().default(512).description('向量维度（与模型绑定，不符即整体重建）'),
  syncIntervalMs: Schema.number().default(600000).description('后台同步间隔(ms)，首轮跑完即全量回填'),
});

export const ConfigSchema: Schema<ImQQBotConfig> = Schema.object({
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
