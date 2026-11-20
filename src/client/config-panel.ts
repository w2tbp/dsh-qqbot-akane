/**
 * QQ 机器人配置面板 — 必要配置的 UI 编辑
 *
 * UI 复刻 DSW 通用设置（settings-form 原语）的视觉风格：
 * 左对齐设置列、0.5px 行分隔、label 13px/500、控件右置；
 * Switch 为 36×20 aria-checked 结构（thumb translateX 动画）；
 * 三值选择用分段控件（滑动指示器按段数/索引的 CSS 变量定位）；
 * 保存按钮为 DSW 反色主按钮（label-primary 底 + bg-layer-3 字）。
 *
 * 数据流：GET /qqbot/im-qqbot-akane/config 回显当前生效配置（appSecret
 * 已由宿主剔除）→ 表单编辑 → dirty diff → POST 仅提交变更键 →
 * 宿主白名单 + Schema 校验 → 最小写入 profile patch → HMR 重载生效。
 *
 * 字段策略：只开放用户必要的配置；cwd 只读展示；除「碎片静默窗口」四栏外，
 * 超时与性能调优类字段仍走 profile patch / 环境变量。
 */
import { createElement, useCallback, useEffect, useState, type CSSProperties, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { BIND_CONFIG_PATH } from '../shared/bind-protocol.ts';

/** 访问控制配置（与 src/config.ts 的 AccessControlConfig 对应的局部投影） */
interface AccessControlWire {
  c2cMode: 'open' | 'allowlist' | 'disabled';
  c2cAllow: string[];
  c2cDeny: string[];
  groupMode: 'open' | 'allowlist' | 'disabled';
  groupAllow: string[];
  groupDeny: string[];
}

/** 记忆库配置（与 src/config.ts 的 MemoryConfig 对应的局部投影） */
interface MemoryWire {
  enabled?: boolean;
  embedBaseUrl?: string;
  timeoutMs?: number;
  dims?: number;
  syncIntervalMs?: number;
}

/** GET 回显的生效配置（appSecret 已剔除） */
type ConfigWire = {
  requireMention?: boolean;
  streaming?: boolean;
  showToolResults?: boolean;
  debug?: boolean;
  provider?: string;
  model?: string;
  preset?: string;
  groupPrompt?: string;
  directPrompt?: string;
  wakeWords?: string[];
  wakeWordsWeak?: string[];
  wakeWordExcludes?: string[];
  quietWindowMs?: number;
  quietWindowEmptyShellMs?: number;
  quietWindowMaxWaitMs?: number;
  quietWindowMaxFragments?: number;
  access?: AccessControlWire;
  cwd?: string;
  personaGroupFile?: string;
  personaDirectFile?: string;
  personaLessonsDir?: string;
  personaEnabled?: boolean;
  stickerLevel?: StickerLevelWire;
  memory?: MemoryWire;
};

/** 样式注入标记（幂等） */
const STYLE_ID = 'im-qqbot-akane-config-panel-styles';

/** 界面身份标识：席位 id 已随 fork 改名，标题也要能一眼认出是哪个插件 */
const PLUGIN_LABEL = 'QQ 机器人 · Akane';
const PLUGIN_ID = 'im-qqbot-akane';
const PLUGIN_PACKAGE = 'dsh-qqbot-akane';
const PLUGIN_DATA_DIR = '~/.dsh-qqbot-akane';

/** DSW 通用设置风格（settings-form / Switch / SegmentedControl 原语复刻） */
function useConfigPanelStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.imqb2-form { display: flex; flex-direction: column; width: 100%; }
.imqb2-group-title {
  padding: 14px 0 2px; font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: .04em;
}
.imqb2-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.imqb2-field + .imqb2-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.imqb2-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.imqb2-label {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.imqb2-help { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.imqb2-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
/* Switch（aria-checked 驱动，视觉态与无障碍态同源） */
.imqb2-switch {
  box-sizing: border-box; position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3); cursor: pointer; font: inherit;
}
.imqb2-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.imqb2-switch:disabled { cursor: default; opacity: 0.5; }
.imqb2-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.imqb2-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #ffffff);
  transition: transform 120ms ease;
}
.imqb2-switch[aria-checked='true'] .imqb2-switch-thumb {
  background: var(--dsw-alias-label-primary-foreground, #ffffff);
  transform: translateX(16px);
}
/* 输入（官方 fields.input 复刻） */
.imqb2-input {
  box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary); outline: none;
}
.imqb2-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.imqb2-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.imqb2-textarea { height: auto; min-height: 68px; padding: 8px 12px; resize: vertical; line-height: 1.5; }
/* 分段控件（官方 SegmentedControl 复刻：指示器按段数/索引定位） */
.imqb2-seg {
  position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover);
}
.imqb2-seg-indicator {
  position: absolute; top: 4px; left: 4px;
  width: calc((100% - 8px - 2px * (var(--imqb2-seg-count) - 1)) / var(--imqb2-seg-count));
  height: calc(100% - 8px);
  border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-soft, 0 1px 3px rgba(0,0,0,.08));
  transform: translateX(calc(var(--imqb2-seg-index) * (100% + 2px)));
  transition: transform 160ms ease;
  pointer-events: none;
}
.imqb2-seg-tab {
  box-sizing: border-box; position: relative; z-index: 1; height: 28px; padding: 0 16px;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px;
  font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 120ms ease;
}
.imqb2-seg-tab:hover, .imqb2-seg-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); }
.imqb2-seg-tab:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
/* 底栏（官方 SettingsForm.footer 复刻） */
.imqb2-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.imqb2-note { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.imqb2-note--error { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error)); }
.imqb2-note--ok { color: var(--dsw-alias-label-secondary); }
.imqb2-save {
  appearance: none; flex: none; border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px); padding: 5px 14px;
  font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3);
}
.imqb2-save:disabled { opacity: 0.4; cursor: default; }
.imqb2-save:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
/* cwd 只读行 */
.imqb2-readonly { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; margin: 0; }
/* 身份抬头：本面板属于哪个插件（官方原版的 id 是 im-qqbot，容易混淆） */
.imqb2-identity { display: flex; flex-direction: column; gap: 4px; padding: 0 0 14px; }
.imqb2-identity-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.imqb2-identity-meta { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
/* Tab 栏（6 个功能标签，flex wrap 适应窄屏） */
.imqb2-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-interactive-bg-hover); margin-bottom: 12px; }
.imqb2-tab { box-sizing: border-box; position: relative; z-index: 1; height: 32px; padding: 0 16px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 24px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: all 120ms ease; }
.imqb2-tab:hover { color: var(--dsw-alias-label-primary); }
.imqb2-tab[aria-selected='true'] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-soft, 0 1px 3px rgba(0,0,0,.08)); }
.imqb2-tab:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
.imqb2-panel { padding-top: 4px; }
    `;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);
}

/** 开关（官方 Switch 原语结构：aria-checked 驱动视觉态） */
function Switch({ checked, label, onChange }: {
  checked: boolean; label: string; onChange: (next: boolean) => void;
}): ReactNode {
  return createElement('button', {
    type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
    className: 'imqb2-switch',
    onClick: () => { onChange(!checked); },
  }, createElement('span', { className: 'imqb2-switch-thumb' }));
}

/**
 * 分段选择（官方 SegmentedControl 结构：CSS 变量定位滑动指示器）。
 *
 * `value` 用 string 而不是泛型：宿主带的 React 类型在 `createElement` 处推不出
 * 泛型组件的实例化签名（试过的结果是 4 处 TS2769）。合法性由各选项数组自己的
 * 标注守住（`MODE_OPTIONS` / `STICKER_LEVEL_OPTIONS` 都写死了枚举类型）。
 */
function Segmented({ value, options, onChange, label }: {
  value: string; options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (next: string) => void; label: string;
}): ReactNode {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const trackStyle = {
    '--imqb2-seg-count': options.length,
    '--imqb2-seg-index': index,
  } as CSSProperties;
  return createElement('div', { className: 'imqb2-seg', role: 'tablist', 'aria-label': label, style: trackStyle },
    createElement('span', { className: 'imqb2-seg-indicator' }),
    options.map((o) => createElement('button', {
      key: o.value, type: 'button', role: 'tab', 'aria-selected': o.value === value,
      className: 'imqb2-seg-tab', onClick: () => { onChange(o.value); },
    }, o.label)),
  );
}

/** 开关行（label 左 + Switch 右 + 可选 help） */
function SwitchRow({ label, help, checked, onChange }: {
  label: string; help?: string; checked: boolean; onChange: (next: boolean) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('div', { className: 'imqb2-head' },
      createElement('span', { className: 'imqb2-label' }, label),
      createElement(Switch, { checked, label, onChange }),
    ),
    help === undefined ? null : createElement('p', { className: 'imqb2-help' }, help),
  );
}

/** 文本行（label 上 + 输入下，与官方 fields 布局一致） */
function FieldRow({ label, help, value, placeholder, inputMode, onChange }: {
  label: string; help?: string; value: string; placeholder?: string;
  inputMode?: 'text' | 'numeric'; onChange: (next: string) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('span', { className: 'imqb2-label' }, label),
    createElement('input', {
      className: 'imqb2-input', value, placeholder, spellCheck: false, inputMode,
      onChange: (event: ChangeEvent<HTMLInputElement>) => { onChange(event.currentTarget.value); },
    }),
    help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
  );
}

/** 多行文本行 */
function AreaRow({ label, help, value, rows, onChange }: {
  label: string; help?: string; value: string; rows?: number; onChange: (next: string) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('span', { className: 'imqb2-label' }, label),
    createElement('textarea', {
      className: 'imqb2-input imqb2-textarea', value, rows: rows ?? 3,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { onChange(event.currentTarget.value); },
    }),
    help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
  );
}

/** 分段选择行（访问模式、梗图档位共用；value 用 string 的原因见 `Segmented`） */
function SegmentedRow({ label, help, value, options, onChange }: {
  label: string; help?: string; value: string;
  options: ReadonlyArray<{ value: string; label: string }>; onChange: (next: string) => void;
}): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('div', { className: 'imqb2-head' },
      createElement('span', { className: 'imqb2-label' }, label),
      createElement(Segmented, { value, options, onChange, label }),
    ),
    help === undefined ? null : createElement('p', { className: 'imqb2-hint' }, help),
  );
}

/** 只读行（label 左 + 等宽值右，用于文件路径这类不可编辑信息） */
function ReadonlyRow({ label, value }: { label: string; value: string }): ReactNode {
  return createElement('div', { className: 'imqb2-field' },
    createElement('div', { className: 'imqb2-head' },
      createElement('span', { className: 'imqb2-label' }, label),
      createElement('p', { className: 'imqb2-readonly' }, value === '' ? '未配置（不注入）' : value),
    ),
  );
}

type AccessMode = AccessControlWire['c2cMode'];

const MODE_OPTIONS: ReadonlyArray<{ value: AccessMode; label: string }> = [
  { value: 'open', label: '所有人' },
  { value: 'allowlist', label: '白名单' },
  { value: 'disabled', label: '禁用' },
];

/**
 * 梗图积极度四档。合法值正本在 `src/config.ts` 的 `STICKER_LEVELS`（服务端校验用它），
 * 这里另写一份字面量是因为客户端包不许依赖 schemastery —— 两边由 fork-guard 钉住不许分叉。
 */
type StickerLevelWire = 'off' | 'quiet' | 'normal' | 'active';

const STICKER_LEVEL_OPTIONS: ReadonlyArray<{ value: StickerLevelWire; label: string }> = [
  { value: 'off', label: '不发' },
  { value: 'quiet', label: '克制' },
  { value: 'normal', label: '正常' },
  { value: 'active', label: '积极' },
];

/** 每档到底改了什么（界面下方逐档说明，避免用户靠猜） */
const STICKER_LEVEL_HELP = '这一档改写的是她 system prompt 里那句常驻的梗图提示（只作用于群聊 —— 私聊人格里没有这句话，'
  + '所以四档对私聊都没效果）：「不发」删掉那句；「克制」换成只在被点名、或对方说的正好是某张图的字幕时才配；'
  + '「正常」= persona 原文，也就是她现在的行为；'
  + '「积极」除了换措辞还追加一条动作——想到图、或连着两轮只回了纯文字，就先读一遍索引再开口。'
  + '四档都不动图库文件与 skill，也不设任何硬闸门：档位只改倾向，不保证发或不发。'
  + '文案正本在 persona/sticker-levels.md，改完下一条消息生效。';

/** 6 个功能 tab（设置页按语义归组，不再平铺在一个长表单里） */
const FEATURE_TABS = [
  { key: 'basic', label: '基础' },
  { key: 'wake', label: '唤醒' },
  { key: 'window', label: '窗口' },
  { key: 'stickers', label: '梗图' },
  { key: 'persona', label: '人格' },
  { key: 'memory', label: '记忆库' },
] as const;
type FeatureTabKey = (typeof FEATURE_TABS)[number]['key'];

/** 三张唤醒词表（提交时统一规范化） */
const WAKE_LIST_KEYS = ['wakeWords', 'wakeWordsWeak', 'wakeWordExcludes'] as const;

/**
 * 碎片静默窗口四栏。
 *
 * 界面顺序、取值范围、说明文案都在这一张表里，校验与渲染共用，免得两处 drift。
 * 范围与服务端（setup/bind-routes.ts）那份是手抄的两份：客户端不 import 那个模块，
 * 免得把 node 侧依赖拖进浏览器包。服务端才是边界。
 */
const QUIET_WINDOW_FIELDS = [
  {
    key: 'quietWindowMs', label: '静默窗口（毫秒）', min: 0, max: 120000, unit: 'ms',
    help: '同一个人连发时，她等这么久没有新片就开口。这是加在她每次回话上的纯延迟，宁可小不可大。填 0 = 整个攒片功能关闭。',
  },
  {
    key: 'quietWindowEmptyShellMs', label: '空壳长窗口（毫秒）', min: 0, max: 120000, unit: 'ms',
    help: '只有「单独 @ 她一句、后面既没字也没图」时才改用这个更长的窗口。必须大于上面的静默窗口才有意义（它是替换不是叠加）；填 0 = 不设特殊窗口。',
  },
  {
    key: 'quietWindowMaxWaitMs', label: '等待硬顶（毫秒）', min: 0, max: 120000, unit: 'ms',
    help: '从第一条算起最多攒多久，到点无论后面还有没有分片都放行。静默窗口开着时这栏必须大于 0，否则保存会被拒绝。',
  },
  {
    key: 'quietWindowMaxFragments', label: '每批最多攒几条', min: 1, max: 20, unit: '条',
    help: '一个人一次连发超过这个条数就立即放行，不再往下攒。',
  },
] as const;

type QuietWindowKey = (typeof QUIET_WINDOW_FIELDS)[number]['key'];

/** 表单侧形状：四栏在输入框里是文本，提交时才转数字（数字输入框一改就掉零，不可编辑） */
type FormWire = Omit<ConfigWire, QuietWindowKey> & Partial<Record<QuietWindowKey, string>>;

function isQuietWindowKey(key: string): key is QuietWindowKey {
  return QUIET_WINDOW_FIELDS.some((field) => field.key === key);
}

/** 回显的数字转成输入框文本；服务端没给这栏时留空 */
function toFormWire(config: ConfigWire): FormWire {
  const next: Record<string, unknown> = { ...config };
  for (const field of QUIET_WINDOW_FIELDS) {
    const value = next[field.key];
    next[field.key] = typeof value === 'number' ? String(value) : '';
  }
  return next as unknown as FormWire;
}

/** 输入框文本 → 整数；不是纯数字一律 NaN（非法文本绝不会被当成 0 悄悄提交） */
function parseWindowValue(text: string): number {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/**
 * 四栏的当场校验（服务端还有一份权威的，这里只为省一次往返）。
 *
 * 返回首个错误文案，全绿则 null。这四栏总是被 GET 预填（Schema 全都有默认值，绑定前后走的都是
 * 全量回显），所以**清空某一栏只可能是误删 —— 判成错误**：悄悄丢掉一栏比拦下来难查得多。
 * 只留一道防御：万一某条路径压根没回显这栏（现值未知），留空按「不改这栏」处理，
 * 否则整页的保存按钮会被一个无从修的校验焊死。提交侧那道 `raw === ''` 的跳过是防 NaN
 * 出门的最后一道闩，不是另一种语义。
 */
function windowFormError(form: FormWire, initial: ConfigWire): string | null {
  for (const field of QUIET_WINDOW_FIELDS) {
    const raw = (form[field.key] ?? '').trim();
    if (raw === '') {
      if (initial[field.key] !== undefined) return `${field.label}：不能留空，填 0 表示关闭`;
      continue;
    }
    const value = parseWindowValue(raw);
    if (Number.isNaN(value)) return `${field.label}：只能填整数`;
    if (value < field.min || value > field.max) return `${field.label}：只能在 ${field.min} 到 ${field.max} 之间`;
  }
  // 跨键：两栏都填了才判得出来（只填一边时另一边的现值由服务端合并后把关）
  const quiet = parseWindowValue((form.quietWindowMs ?? '').trim());
  const cap = parseWindowValue((form.quietWindowMaxWaitMs ?? '').trim());
  if (quiet > 0 && cap <= 0) return '静默窗口开着时「等待硬顶」必须大于 0，否则插件挂载会失败';
  return null;
}

/** 毫秒栏把当前填写值翻成秒，省得在心里换算（四栏由 GET 预填，未填/非法就不多说话） */
function windowValueHint(field: (typeof QUIET_WINDOW_FIELDS)[number], raw: string | undefined): string {
  if (field.unit !== 'ms') return '';
  const value = parseWindowValue(raw ?? '');
  if (Number.isNaN(value)) return '';
  if (value === 0) return field.key === 'quietWindowMs' ? '（当前：整个功能关闭）' : '（当前：不启用）';
  return `（当前 ${value % 1000 === 0 ? value / 1000 : (value / 1000).toFixed(1)} 秒）`;
}

/** 这栏相对初始回显算不算被改动（判据与 windowFormError 同源：空栏要么是误删、要么无现值可谈） */
function windowFieldChanged(key: QuietWindowKey, form: FormWire, initial: ConfigWire): boolean {
  const raw = (form[key] ?? '').trim();
  const baseline = initial[key];
  if (raw === '') return baseline !== undefined;
  const value = parseWindowValue(raw);
  if (Number.isNaN(value)) return true;
  return value !== (baseline ?? 0);
}

/** dirty 判断：窗口四栏比数字，其余比结构 */
function formChanged(form: FormWire, initial: ConfigWire): boolean {
  const current = form as Record<string, unknown>;
  const baseline = initial as Record<string, unknown>;
  for (const key of Object.keys(current)) {
    if (isQuietWindowKey(key)) {
      if (windowFieldChanged(key, form, initial)) return true;
    } else if (!shallowEqual(current[key], baseline[key])) {
      return true;
    }
  }
  return false;
}

/** 深比较（表单值与初始回显值的 dirty 判断） */
function shallowEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 身份抬头：与官方原版 im-qqbot 的界面区分开（设置栏目与主面板共用） */
export function PluginIdentityHeader(): ReactNode {
  return createElement('div', { className: 'imqb2-identity' },
    createElement('p', { className: 'imqb2-identity-title' }, PLUGIN_LABEL),
    createElement('p', { className: 'imqb2-identity-meta' },
      `插件 id ${PLUGIN_ID} · 包 ${PLUGIN_PACKAGE} · 数据目录 ${PLUGIN_DATA_DIR}`),
    createElement('p', { className: 'imqb2-identity-meta' },
      '这是 @tencent-connect/dsh-qqbot（插件 id im-qqbot）的本地 fork：两者可共存，同一条凭据只应有一方启用。'),
  );
}

/**
 * 配置面板主体。
 *
 * 保存仅提交变更键（服务端按白名单合并），保存成功后提示
 * HMR 重载语义（进行中的机器人会话将重置）。
 */
export function ConfigPanel(props?: { bindPhase?: string }): ReactNode {
  useConfigPanelStyles();
  const [initial, setInitial] = useState<ConfigWire | null>(null);
  const [form, setForm] = useState<FormWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FeatureTabKey>('basic');
  // 绑定相位变化时重拉配置（扫码落库的白名单等新值）
  const bindPhase = props?.bindPhase;

  useEffect(() => {
    let stopped = false;
    void fetch(BIND_CONFIG_PATH, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { config: ConfigWire };
        if (stopped) return;
        setInitial(body.config);
        setForm(toFormWire(body.config));
      })
      .catch((err: unknown) => {
        if (!stopped) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => { stopped = true; };
  }, [bindPhase]);

  const patch = useCallback(<K extends keyof FormWire>(key: K, value: FormWire[K]): void => {
    setForm((current) => current === null ? current : { ...current, [key]: value });
    setResult(null);
  }, []);

  const submit = useCallback((event: FormEvent): void => {
    event.preventDefault();
    if (busy || initial === null || form === null) return;
    const windowError = windowFormError(form, initial);
    if (windowError !== null) {
      setResult({ ok: false, message: windowError });
      return;
    }
    const current = form as Record<string, unknown>;
    const baseline = initial as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(current)) {
      if (isQuietWindowKey(key)) {
        // 能走到这里说明空栏只可能是「这栏压根没回显过」，绝不把 NaN 提交出去
        const raw = ((current[key] as string | undefined) ?? '').trim();
        if (raw === '') continue;
        const value = parseWindowValue(raw);
        if (value !== (baseline[key] ?? 0)) changed[key] = value;
        continue;
      }
      if (!shallowEqual(current[key], baseline[key])) {
        changed[key] = current[key];
      }
    }
    if (Object.keys(changed).length === 0) return;

    // 白名单编辑期间保留原始换行/空行（textarea 可正常回车），提交时才规范化
    if (changed.access !== undefined) {
      const a = changed.access as AccessControlWire;
      changed.access = {
        ...a,
        c2cAllow: a.c2cAllow.map((s) => s.trim()).filter(Boolean),
        groupAllow: a.groupAllow.map((s) => s.trim()).filter(Boolean),
        c2cDeny: (a.c2cDeny ?? []).map((s) => s.trim()).filter(Boolean),
        groupDeny: (a.groupDeny ?? []).map((s) => s.trim()).filter(Boolean),
      };
    }
    // 唤醒词表同理：编辑期允许空行，提交时丢空（服务端还会再去一次重）
    for (const key of WAKE_LIST_KEYS) {
      const list = changed[key] as string[] | undefined;
      if (list !== undefined) changed[key] = list.map((s) => s.trim()).filter(Boolean);
    }

    setBusy(true);
    void fetch(BIND_CONFIG_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changed),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
        if (res.ok && body.ok === true) {
          setResult({ ok: true, message: body.message ?? '配置已保存，插件将自动重载' });
          // 重新落基准：窗口四栏存数字（changed 里已是数字），其余取提交时的表单值
          setInitial({ ...initial, ...(changed as ConfigWire) });
          return;
        }
        setResult({ ok: false, message: body.error ?? `保存失败（HTTP ${res.status}）` });
      })
      .catch((err: unknown) => {
        setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { setBusy(false); });
  }, [busy, form, initial]);

  if (loadError !== null) {
    return createElement('p', { className: 'imqb2-hint', style: { padding: '12px 0' } },
      `配置加载失败：${loadError}`);
  }
  if (initial === null || form === null) {
    return createElement('p', { className: 'imqb2-hint', style: { padding: '12px 0' } }, '正在加载配置…');
  }

  const dirty = formChanged(form, initial);
  const windowError = windowFormError(form, initial);
  const access: AccessControlWire = form.access ?? { c2cMode: 'open', c2cAllow: [], c2cDeny: [], groupMode: 'open', groupAllow: [], groupDeny: [] };

  // Tab bar
  const tabBar = createElement('div', { className: 'imqb2-tabs', role: 'tablist' },
    FEATURE_TABS.map((tab) => createElement('button', {
      key: tab.key,
      type: 'button',
      role: 'tab',
      'aria-selected': activeTab === tab.key,
      className: 'imqb2-tab',
      onClick: () => { setActiveTab(tab.key); },
    }, tab.label)),
  );

  // Panel renderers
  const renderBasicPanel = (): ReactNode[] => [
    createElement('div', { className: 'imqb2-group-title', key: 'access-title' }, '服务范围'),
    createElement(SegmentedRow, {
      key: 'c2c-mode',
      label: '私聊', value: access.c2cMode, options: MODE_OPTIONS,
      onChange: (v: string) => { patch('access', { ...access, c2cMode: v as AccessMode }); },
    }),
    access.c2cMode === 'allowlist'
      ? createElement(AreaRow, {
          key: 'c2c-allow',
          label: '私聊白名单', help: '请输入用户 openid，多个请换行输入', rows: 3,
          value: access.c2cAllow.join('\n'),
          onChange: (v: string) => { patch('access', { ...access, c2cAllow: v.split('\n').map((s) => s.trim()) }); },
        })
      : null,
    createElement(SegmentedRow, {
      key: 'group-mode',
      label: '群聊', value: access.groupMode, options: MODE_OPTIONS,
      onChange: (v: string) => { patch('access', { ...access, groupMode: v as AccessMode }); },
    }),
    access.groupMode === 'allowlist'
      ? createElement(AreaRow, {
          key: 'group-allow',
          label: '群聊白名单', help: '请输入群 openid，多个请换行输入', rows: 3,
          value: access.groupAllow.join('\n'),
          onChange: (v: string) => { patch('access', { ...access, groupAllow: v.split('\n').map((s) => s.trim()) }); },
        })
      : null,
    createElement(AreaRow, {
      key: 'c2c-deny',
      label: '私聊黑名单', help: '命中的用户 openid 一律零输出：不回复、不解释，即使被 @', rows: 2,
      value: (access.c2cDeny ?? []).join('\n'),
      onChange: (v: string) => { patch('access', { ...access, c2cDeny: v.split('\n').map((s) => s.trim()) }); },
    }),
    createElement(AreaRow, {
      key: 'group-deny',
      label: '群成员黑名单', help: '按发送者 openid 屏蔽某个人，同群其他群友照常；同样零输出、不解释', rows: 2,
      value: (access.groupDeny ?? []).join('\n'),
      onChange: (v: string) => { patch('access', { ...access, groupDeny: v.split('\n').map((s) => s.trim()) }); },
    }),

    createElement('div', { className: 'imqb2-group-title', key: 'basic-title' }, '基础设置'),
    createElement(SwitchRow, {
      key: 'require-mention',
      label: '群聊仅回复 @机器人的消息', checked: form.requireMention ?? true,
      help: '开启后，机器人仅可回复 @机器人的群聊消息',
      onChange: (v: boolean) => { patch('requireMention', v); },
    }),
    createElement(SwitchRow, {
      key: 'streaming',
      label: '流式输出', checked: form.streaming ?? true,
      help: '回复内容分段实时推送到聊天',
      onChange: (v: boolean) => { patch('streaming', v); },
    }),
    createElement(SwitchRow, {
      key: 'show-tool-results',
      label: '显示工具调用结果', checked: form.showToolResults ?? false,
      help: '在聊天中展示 agent 工具调用的结构化结果',
      onChange: (v: boolean) => { patch('showToolResults', v); },
    }),

    createElement('div', { className: 'imqb2-group-title', key: 'model-title' }, '模型'),
    createElement(FieldRow, {
      key: 'provider',
      label: 'Provider', value: form.provider ?? '', placeholder: '留空继承宿主默认',
      onChange: (v: string) => { patch('provider', v); },
    }),
    createElement(FieldRow, {
      key: 'model',
      label: 'Model', value: form.model ?? '', placeholder: '留空继承宿主默认',
      onChange: (v: string) => { patch('model', v); },
    }),
    createElement(FieldRow, {
      key: 'preset',
      label: 'Preset', value: form.preset ?? '', placeholder: 'Agent preset id',
      onChange: (v: string) => { patch('preset', v); },
    }),

    createElement('div', { className: 'imqb2-group-title', key: 'prompt-title' }, '个性化提示词'),
    createElement(AreaRow, {
      key: 'group-prompt',
      label: '群聊额外 system prompt', value: form.groupPrompt ?? '',
      onChange: (v: string) => { patch('groupPrompt', v); },
    }),
    createElement(AreaRow, {
      key: 'direct-prompt',
      label: '私聊额外 system prompt', value: form.directPrompt ?? '',
      onChange: (v: string) => { patch('directPrompt', v); },
    }),

    form.cwd !== undefined
      ? createElement('div', { className: 'imqb2-field', key: 'cwd' },
          createElement('div', { className: 'imqb2-head' },
            createElement('span', { className: 'imqb2-label' }, 'Agent 工作目录'),
            createElement('span', { className: 'imqb2-hint' }, '只读'),
          ),
          createElement('p', { className: 'imqb2-readonly' }, form.cwd),
        )
      : null,
  ];

  const renderWakePanel = (): ReactNode[] => [
    createElement('p', { className: 'imqb2-help', key: 'wake-help' },
      '不用 @ 也能喊住她。三张表共同判断「这句话是在喊她」还是「这句话只是提到了这个名字」：'
      + '只在上面的「群聊仅回复 @机器人的消息」打开时才有意义（关掉时群消息本来就全回）；'
      + '三张表都留空表示隐式唤醒完全关闭。保存写入 profile 里本插件的条目，之后以本页为准。'),
    createElement(AreaRow, {
      key: 'wake-words',
      label: '强唤醒词', help: '一行一个。独立成词就触发，例：akane、茜茜', rows: 3,
      value: (form.wakeWords ?? []).join('\n'),
      onChange: (v: string) => { patch('wakeWords', v.split('\n').map((s) => s.trim())); },
    }),
    createElement(AreaRow, {
      key: 'wake-words-weak',
      label: '弱唤醒词', help: '一行一个。容易撞车的短词放这里，需要呼格信号才算喊人：句首、后接标点，或紧跟「你/能/帮/在吗」一类。例：猫 → 「猫，你怎么看」触发，「我家猫好胖」不触发', rows: 3,
      value: (form.wakeWordsWeak ?? []).join('\n'),
      onChange: (v: string) => { patch('wakeWordsWeak', v.split('\n').map((s) => s.trim())); },
    }),
    createElement(AreaRow, {
      key: 'wake-excludes',
      label: '唤醒排除片段', help: '一行一个。含名字的复合词在这一处不计：填「熊猫」，「我家熊猫好胖」里的名字就不算喊她。例：熊猫、猫粮、表情包', rows: 3,
      value: (form.wakeWordExcludes ?? []).join('\n'),
      onChange: (v: string) => { patch('wakeWordExcludes', v.split('\n').map((s) => s.trim())); },
    }),
  ];

  const renderWindowPanel = (): ReactNode[] => [
    createElement('p', { className: 'imqb2-help', key: 'window-help' },
      '一句话被拆成几条发时，她先把这几条攒成一批再开口。攒的这段时间是直接加在她每一次回话上的延迟：'
      + '嫌慢就把「静默窗口」调小，填 0 则整个攒片功能关闭；攒得太短又会把一句话说成两次回答。'
      + '按同群同人分桶，只有点到她名的那句才开桶，别人的闲聊不会被拽进这一轮。'
      + '四栏都要有值（关就填 0）。保存即热重载，不用重启进程。'),
    ...QUIET_WINDOW_FIELDS.map((field) => createElement(FieldRow, {
      key: field.key,
      label: field.label,
      help: field.help + windowValueHint(field, form[field.key]),
      value: form[field.key] ?? '',
      inputMode: 'numeric' as const,
      onChange: (v: string) => { patch(field.key, v); },
    })),
    windowError === null
      ? null
      : createElement('p', { className: 'imqb2-help imqb2-note--error', key: 'window-error' }, `⚠️ ${windowError}`),
  ];

  const renderStickersPanel = (): ReactNode[] => [
    createElement(SegmentedRow, {
      key: 'sticker-level',
      label: '梗图积极度',
      value: form.stickerLevel ?? 'normal',
      options: STICKER_LEVEL_OPTIONS,
      help: STICKER_LEVEL_HELP,
      onChange: (v: string) => { patch('stickerLevel', v as StickerLevelWire); },
    }),
    createElement('p', { className: 'imqb2-help', key: 'sticker-readonly-help' },
      '想知道档位到底有没有用：在 YAML 里把 stickerProbe.enabled 写 true，她每次回话后会在数据目录落一条计数'
      + '（只有时间、群/私聊、图片张数、梗图张数、当时生效的档位，不含路径与聊天内容）。'
      + '攒几天再用 scripts/sticker-turn-report.mjs 出按档位分段的主动配图占比。本页不管这个开关。'),
  ];

  const renderPersonaPanel = (): ReactNode[] => [
    createElement(SwitchRow, {
      key: 'persona-enabled',
      label: '人格注入', checked: form.personaEnabled ?? true,
      help: '关闭后 persona 文件、lessons、legacy prompt 全都不进 system prompt，她变成宿主的通用助手',
      onChange: (v: boolean) => { patch('personaEnabled', v); },
    }),
    createElement('div', { className: 'imqb2-group-title', key: 'persona-files-title' }, '人格文件（在本页之外编辑）'),
    createElement(ReadonlyRow, { key: 'persona-group', label: '群聊人格', value: form.personaGroupFile ?? '' }),
    createElement(ReadonlyRow, { key: 'persona-direct', label: '私聊人格', value: form.personaDirectFile ?? '' }),
    createElement(ReadonlyRow, { key: 'persona-lessons', label: '课程目录', value: form.personaLessonsDir ?? '' }),
    createElement('p', { className: 'imqb2-help', key: 'persona-files-help' },
      '这些是「她是谁、怎么说话」的正本，不在这里改：用编辑器直接改插件目录下的 Markdown 文件即可。'
      + '相对路径按插件包根解析（也支持绝对路径与 ~/ 开头），按文件修改时间热加载——存盘后下一条消息生效，'
      + '不用重启、也不用点保存。上面的路径为空表示该份人格未启用。'),
  ];

  const renderMemoryPanel = (): ReactNode[] => {
    const memory = form.memory ?? {};
    return [
      createElement(SwitchRow, {
        key: 'memory-enabled',
        label: '记忆库', checked: memory.enabled ?? false,
        help: '关闭时不建 index/、不起后台作业、不注册工具（零行为变化）；开启后当场生效，不用重启',
        onChange: (v: boolean) => { patch('memory', { ...memory, enabled: v }); },
      }),
      createElement('div', { className: 'imqb2-group-title', key: 'memory-readonly-title' }, '高级参数（临时，一期不进设置页）'),
      createElement(ReadonlyRow, { key: 'memory-base-url', label: 'embedding 服务基址', value: memory.embedBaseUrl ?? 'http://127.0.0.1:8765' }),
      createElement(ReadonlyRow, { key: 'memory-timeout', label: '单次嵌入超时(ms)', value: String(memory.timeoutMs ?? 8000) }),
      createElement(ReadonlyRow, { key: 'memory-dims', label: '向量维度', value: String(memory.dims ?? 512) }),
      createElement(ReadonlyRow, { key: 'memory-sync-interval', label: '后台同步间隔(ms)', value: String(memory.syncIntervalMs ?? 600000) }),
      createElement('p', { className: 'imqb2-help', key: 'memory-readonly-help' },
        '这些参数走 Schema 默认 + YAML 手写，不在本页改。改完要重启常驻服务或 dsh web 才生效。'),
    ];
  };

  const panelRenderers: Record<FeatureTabKey, () => ReactNode[]> = {
    basic: renderBasicPanel,
    wake: renderWakePanel,
    window: renderWindowPanel,
    stickers: renderStickersPanel,
    persona: renderPersonaPanel,
    memory: renderMemoryPanel,
  };

  return createElement('form', { className: 'imqb2-form', onSubmit: submit },
    tabBar,
    createElement('div', { className: 'imqb2-panel' }, panelRenderers[activeTab]()),
    createElement('div', { className: 'imqb2-footer' },
      result !== null
        ? createElement('p', { className: `imqb2-note${result.ok ? ' imqb2-note--ok' : ' imqb2-note--error'}` },
            (result.ok ? '' : '⚠️ ') + result.message)
        : dirty
          ? createElement('p', { className: 'imqb2-note' }, '保存后插件将重载，进行中的机器人会话将重置')
          : createElement('p', { className: 'imqb2-note' }),
      createElement('button', { className: 'imqb2-save', type: 'submit', disabled: busy || !dirty },
        busy ? '正在保存…' : '保存'),
    ),
  );
}
