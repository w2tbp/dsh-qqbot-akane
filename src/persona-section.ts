/**
 * persona 段的落位（R3 / 偏离 D3）
 *
 * 宿主在 waterfall **之前**就按 order 排好序，并把 sections 收敛成
 * `{name,text,interpolate?}`（dsh-system-prompt/lib/index.js:382-394），
 * 所以 waterfall 里再给 `order` 是无效的 —— append 只会落到整篇 prompt 末尾，
 * 人格读起来像最后一句补充说明。这里按 name 定位，splice 到
 * `deployment:persona-prefix` 之后，让 persona 紧跟部署人格。
 */

/** waterfall 产物里的一个 section：宿主已经丢掉了 order */
export interface AssembledSection {
  name: string;
  text: string;
  interpolate?: boolean;
  [key: string]: unknown;
}

/** system-prompt/assemble 的组装产物最小结构 */
export interface AssembledPrompt {
  sections?: AssembledSection[];
  [key: string]: unknown;
}

/** 宿主部署人格槽位名，persona 插在它后面 */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix';

/** 本插件的 persona section 名 */
export const PERSONA_SECTION_NAME = 'im-qqbot-akane:persona';

/**
 * 破坏 `{{` 的相邻性：宿主 renderPrompt 见到 `{{…}}` 按变量解析，
 * 未注册的变量名直接抛错、炸掉整次 prompt 构建。零宽空格对模型不可见。
 */
export function escapeInterpolation(text: string): string {
  return text.includes('{{') ? text.replace(/\{\{/g, '{\u200B{') : text;
}

/**
 * 把 persona 文本插到部署人格之后；锚点不存在（preset 换了槽位命名）时退回尾部追加。
 */
export function insertPersonaSection(assembled: AssembledPrompt, text: string): AssembledPrompt {
  const sections = [...(assembled.sections ?? [])];
  const section: AssembledSection = {
    name: PERSONA_SECTION_NAME,
    text: escapeInterpolation(text),
    // 宿主 rc.6+ 认这个开关（保留原文不插值）；老宿主忽略它，靠上面的转义兜底
    interpolate: false,
  };
  const anchor = sections.findIndex((item) => item.name === PERSONA_PREFIX_SECTION);
  sections.splice(anchor < 0 ? sections.length : anchor + 1, 0, section);
  return { ...assembled, sections };
}
