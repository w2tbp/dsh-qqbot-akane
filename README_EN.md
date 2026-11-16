<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

**A QQ Bot plugin for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), connecting DeepSeek AI assistants to QQ private and group chats.**

![fork of @tencent-connect/dsh-qqbot 0.5.5](https://img.shields.io/badge/fork-dsh--qqbot%200.5.5-orange)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)

<br/>

**[简体中文](./README.md) | English**

Scan to join the QQ group / channel

<table>
<tr>
<td align="center" width="50%"><img src="./assets/docs/qqgroup.jpg" height="360" alt="QQ Group QR Code" /><br /><b>QQ Developer Group</b><br /><sub>Group 1: 1032635674 · Group 2: 1056948758</sub></td>
<td align="center" width="50%"><img src="./assets/docs/qqchannel.jpg" height="360" alt="QQ Channel QR Code" /><br /><b>QQ Developer Channel</b><br /><sub>Channel ID: 20dnumts4z</sub></td>
</tr>
</table>

</div>

## About this fork

This repo is a local fork of `@tencent-connect/dsh-qqbot@0.5.5`. Only triggering and persona behaviour changed; every identity slot is renamed, so **the fork and the original can be installed in the same profile without interference** (flip which one runs with `disabled: true`).

| Identity slot | Original | This fork |
|---|---|---|
| npm package | `@tencent-connect/dsh-qqbot` | `dsh-qqbot-akane` |
| plugin id | `im-qqbot` | `im-qqbot-akane` |
| plugins page title | `QQ Bot (dsh-qqbot)` | `QQ Bot · Akane` |
| settings section | "QQ Bot" | "QQ Bot · Akane" |
| icon | `assets/icons/qq_logo.svg` | `assets/icons/akane_qqbot.svg` |
| data dir | `~/.dsh-qqbot` | `~/.dsh-qqbot-akane` |
| bind routes | `/qqbot/im-qqbot/*` | `/qqbot/im-qqbot-akane/*` |
| vision / send-file tools | `qqbot_describe_image` / `qqbot_send_file` | `akane_describe_image` / `akane_send_file` |

New capabilities: group wake words, history carried on implicit wake-up, persona as hot-reloaded files, blacklist enforced in code.

```bash
pnpm install && pnpm build
npx @deepseek-ai/dsh plugin --profile <name> add /path/to/dsh-qqbot-akane
```

`dsh plugin add` uses a pnpm link (absolute path), so after editing sources only `pnpm build` is needed — no reinstall.

> **Install gotcha**: this package ships its wake tables and persona paths through `- insert:` in `cordis.patch.yml`, but as soon as the profile layer contains an entry with the same id, `--dump-config` shows only the keys that layer lists — the tables disappear from the view. Rather than gamble on merge semantics, **write the profile entry in full** (copy the credentials from the original entry, and include `access`, otherwise it falls back to `c2cMode: open`). Editing the profile patch needs no restart: the host reloads the plugin over HMR and logs another `Bot ready!`.

## Architecture

```
QQ User → QQ WebSocket → dsh-qqbot-akane → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)
```

## Installation

### Method 1: Desktop install (original package only)

No command line needed — everything happens inside the app:

1. **Install**: click "Plugins" in the left sidebar → "Add plugin" → enter `@tencent-connect/dsh-qqbot@latest` → install and start now

<img src="./assets/docs/install.png" alt="In-app plugin install" width="560" />

2. **Connect**: avatar at the bottom-left → Settings → "QQ Bots" → scan the QR code with mobile QQ

<img src="./assets/docs/setting.png" alt="Settings QR binding" width="560" />

Credentials are saved automatically after the scan; later launches need no re-scan.

### Method 2: Manual

```bash
# Add to a profile
npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot

# Start
npx @deepseek-ai/dsh --profile qqbot
```

On first launch, the plugin detects missing credentials and automatically starts the QR flow: a QR code is printed in the terminal → scan it with the QQ mobile app → credentials are saved to the profile, so subsequent launches require no re-scan.

In environments without the in-app binding page (pure CLI), set `QQBOT_BIND_OPEN_BROWSER=1` to additionally open a browser QR page as a fallback.

<img src="./assets/docs/qrcode.png" alt="QR code scan example" width="280" />

> **Note**: Upgrade to `0.4.0` or later for browser-link scanning, which avoids QR code misalignment in some terminals.

### Method 3: Local path (the only way to install this fork)

```bash
# Build
cd /path/to/dsh-qqbot-akane
pnpm install && pnpm build

# Add to a profile (local path)
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-qqbot-akane

# Start
export QQBOT_APPID="yourAppID" QQBOT_SECRET="yourAppSecret"
npx @deepseek-ai/dsh --profile qqbot
```

### Method 4: --patch dev mode

```bash
export QQBOT_APPID="yourAppID" QQBOT_SECRET="yourAppSecret"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot-akane/cordis.dev.yml
```

## Configuration

| Config | Type | Default | Description |
|------|------|--------|------|
| `appId` | string | **required** | QQ Bot AppID (or via `QQBOT_APPID` env var) |
| `appSecret` | string | **required** | QQ Bot AppSecret (or via `QQBOT_SECRET` env var) |
| `provider` | string | `deepseek-official` | LLM provider name |
| `model` | string | `deepseek-chat` | Model name |
| `preset` | string | - | Agent preset id |
| `cwd` | string | `process.cwd()` | Agent working directory |
| `requireMention` | boolean | `true` | Whether group messages require @bot or a wake word to trigger |
| `wakeWords` | string[] | `[]` | Strong group wake words, see "Wake words" |
| `wakeWordsWeak` | string[] | `[]` | Weak wake words (need a vocative signal) |
| `wakeWordExcludes` | string[] | `[]` | Blocked substrings such as compound words |
| `personaGroupFile` | string | `''` | Group persona file (empty = not injected), see "Persona files" |
| `personaDirectFile` | string | `''` | Direct-chat persona file |
| `personaLessonsDir` | string | `''` | Lessons directory (`*.md` joined in filename order) |
| `groupPrompt` | string | - | Extra system prompt for group chats (legacy, coexists with persona files) |
| `directPrompt` | string | - | Extra system prompt for direct chats |
| `textChunkLimit` | number | `4500` | Max chars per message |
| `streaming` | boolean | `true` | Enable streaming output (always disabled in groups) |
| `sessionIdleTimeout` | number | `1800000` | Session idle timeout (ms), default 30 min |
| `processingTimeoutMs` | number | `1800000` | Processing timeout (ms), aborts the current LLM call |
| `maxQueue` | number | `20` | Max concurrent queue length |
| `historyLimit` | number | `10` | Group history buffer size |
| `askTimeoutMs` | number | `300000` | Question timeout (ms), default 5 min (ask_user_question) |
| `showToolResults` | boolean | `false` | Show successful tool-call results (errors always shown) |
| `debug` | boolean | `false` | Debug mode |

### Access control (access)

| Config | Type | Default | Description |
|------|------|--------|------|
| `access.c2cMode` | `open`/`allowlist`/`disabled` | `open` | Direct-chat access mode |
| `access.c2cAllow` | string[] | `[]` | Direct-chat allowlist (user openid) |
| `access.c2cDeny` | string[] | `[]` | Direct-chat blocklist (user openid) |
| `access.groupMode` | `open`/`allowlist`/`disabled` | `open` | Group access mode |
| `access.groupAllow` | string[] | `[]` | Group allowlist (group openid) |
| `access.groupDeny` | string[] | `[]` | Group-member blocklist (sender openid — blocks a person, not the group) |

Deny is evaluated before `mode`: a hit calls `ctx.stop()`, which means no reply, no explanation, and the message never enters group history — even when she is @-ed. This belongs in middleware because a prompt-level rule of this kind gets violated probabilistically.

### Wake words

All three tables default to empty, which keeps behaviour identical to 0.5.5 (explicit @ only). Once filled, calling her name in a group triggers her — and the group history comes along:

```yaml
config:
  wakeWords:       # strong: fires whenever it stands as a word
    - akane
    - 茜茜
  wakeWordsWeak:   # weak: needs a vocative cue (clause start, "cat, what do you think")
    - 猫
  wakeWordExcludes: # masked out, so "panda" / "cat food" cannot fire
    - 熊猫
    - 猫粮
```

Matching is lexical — CJK ideographs and alphanumerics are not boundaries, so "did you see the picture 茜 posted" does not trigger. URLs, code fences, inline code, QQ face tags and `@other-nickname` are masked at equal length before matching, and only the first 2000 characters of a long message are scanned. Editing the tables only touches `cordis.patch.yml`; the host picks the change up over HMR, no rebuild needed.

### Persona files

Who she is and how she talks moved out of the workspace `AGENTS.md` into Markdown files shipped with the plugin, cached by mtime+size — an edit takes effect on the next message, no restart:

```yaml
config:
  personaGroupFile: persona/akane-group.md   # relative to the package root, ~ expands
  personaDirectFile: persona/akane-direct.md
  personaLessonsDir: persona/lessons         # *.md in filename order, each with its own heading
```

Composition order is `persona file → lessons → legacy groupPrompt/directPrompt`, and the section is spliced in after the host's `deployment:persona-prefix` rather than appended to the end of the prompt. `persona/README.md` records the writing discipline: behaviour rules and few-shot dialogue, never a list of forbidden words.

### Rich media (media)

| Config | Type | Default | Description |
|------|------|--------|------|
| `media.enabled` | boolean | `true` | Enable rich media understanding (image/video download + tool analysis) |
| `media.maxMB` | number | `200` | Max download size (MB) |
| `media.ttlHours` | number | `24` | Media lifetime (hours), 0 = never expire |

### Vision (vision)

| Config | Type | Default | Description |
|------|------|--------|------|
| `vision.enabled` | boolean | `false` | Enable vision (akane_describe_image tool) |
| `vision.provider` | string | - | Vision model provider (e.g. pi-ai) |
| `vision.model` | string | - | Vision model id (e.g. qwen-vl-max) |
| `vision.maxBytes` | number | `10MB` | Max image bytes |
| `vision.maxTokens` | number | `1024` | Max output tokens |
| `vision.timeoutMs` | number | `120000` | Vision call timeout (ms) |

### File sending (sendFile)

| Config | Type | Default | Description |
|------|------|--------|------|
| `sendFile.restrictPaths` | boolean | `true` | Enable path allowlist (media + cwd + extraRoots only) |
| `sendFile.extraRoots` | string[] | `[]` | Extra allowed root directories |

## Built-in Commands

| Command | Description |
|------|------|
| `/new` (aliases `/reset` `/clear`) | Start a new session (clear context) |
| `/compact` | Compact session history (replace old records with a summary) |
| `/model` | View or switch model |
| `/preset` | View or switch agent preset (applies to new sessions) |
| `/stop` | Abort the current generation |
| `/bot-ping` | Network latency test (transport & processing time) |
| `/bot-version` | View version info |
| `/bot-status` | View current session status |
| `/bot-help` | View all commands |

## Core Modules

```
src/
├── index.ts                    # Cordis plugin entry (async apply)
├── config.ts                   # Config schema
├── wake.ts                     # Wake-word core (masking + two-tier tables + vocative check)
├── persona.ts                  # Persona file reader (mtime+size cache, lessons join)
├── persona-section.ts          # Persona section injection (splice after persona-prefix)
├── types.ts                    # Global types
├── setup.ts                    # Credential binding (QR)
├── gateway/                    # Gateway assembly
│   ├── bootstrap.ts            # Startup wiring (session/event listeners, etc.)
│   └── middleware-setup.ts     # Middleware chain config
├── transport/                  # Transport layer
│   ├── inbound.ts              # QQ inbound message → agent.followup()
│   ├── outbound.ts             # session/event → QQ sendMarkdown
│   ├── outbound-buffer.ts      # Streaming buffer
│   ├── streaming-writer.ts     # Streaming writer
│   ├── reply-target.ts         # Reply target resolution
│   ├── msgid-cache.ts          # Passive reply msgid cache
│   ├── reply-limiter.ts        # Passive reply rate limiter
│   ├── tool-presenter.ts       # Tool-call presentation
│   └── chunker.ts              # Markdown chunking
├── session/                    # Session management
│   ├── session-manager.ts      # QQ peer → Agent mapping
│   └── idle-evictor.ts         # Idle eviction
├── model/                      # Model routing
│   ├── model-resolver.ts       # Route resolution
│   ├── prefs-store.ts          # Per-peer preference persistence
│   └── settings-reader.ts      # settings.yaml read-only
├── features/                   # Interaction features
│   ├── question-channel.ts     # ask_user_question Q&A channel
│   ├── approval-channel.ts     # approval confirmation channel
│   └── answer-parser.ts        # Answer parsing
├── media/                      # Media
│   ├── vision-tool.ts          # Image vision understanding
│   ├── send-file-tool.ts       # Send local files
│   └── media-cleaner.ts        # Media TTL cleanup
├── middleware/                 # Middleware
│   ├── question-answer.ts      # Q&A answer handling
│   └── attachment.ts           # Attachment handling
├── shared/                     # Shared utilities
│   ├── utils.ts                # Common helpers
│   ├── scope.ts                # scope/peer extraction
│   └── send-helper.ts          # Chunked send
└── commands/                   # Slash commands
```

## Session Routing

sessionKey: `qqbot:${appId}:${scope}:${peerId}`; a UUID session id is minted for new sessions and persisted to `model-prefs.json`, resuming by the persisted id after restarts; pre-0.6 sessions keep their originally derived ids.

Resolution strategy: in-process reuse → persisted resume → fresh create.

## Design Principles

- **Pure Cordis plugin** — follows the dsh "Plugins, not loop changes" principle
- **Declarative dependencies** — `inject = ['agents']`, no direct coupling to other plugins
- **Session isolation** — one independent Agent per QQ direct user / group
- **Preset support** — mount presets (toolkits, prompts, etc.) via the `agent-presets` service
- **Idle eviction** — auto-dispose Agents on timeout to prevent memory leaks
- **Persona vs code** — tone and identity live in hot-reloaded `persona/*.md`; hard rules (blocklist = zero output) live in middleware, because self-restraint in a prompt is only probabilistic
- **Vocabulary is configuration** — wake words and persona paths live in `cordis.patch.yml`; changing them changes neither code nor the build
- **Markdown output** — replies sent as Markdown with code-block/table-aware chunking
- **Image understanding** — supports `akane_describe_image` vision to analyze images sent by users
- **File sending** — supports `akane_send_file` to send local files to users (path allowlist enabled by default)
- **Question interaction** — supports `ask_user_question` with inline keyboard buttons (mutually exclusive) or numbered replies, one question at a time with timeout
- **Approval confirmation** — supports `approval/request` to ask for user confirmation on critical actions via allow/deny buttons

## Local Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Dev mode (watch)
pnpm dev

# Debug via --patch
export QQBOT_APPID="xxx" QQBOT_SECRET="xxx"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot-akane/cordis.dev.yml
```

## License

[MIT](./LICENSE)
