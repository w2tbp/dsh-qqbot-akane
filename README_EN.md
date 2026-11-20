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

This repo is a local fork of `@tencent-connect/dsh-qqbot@0.5.5`. Changes concentrate in three behaviours — **triggering**, **persona**, and **media visibility in group history** — plus an **opt-in** memory stack (see "Memory stack") that changes nothing until you enable it; every identity slot is renamed, so **the fork and the original can be installed in the same profile without interference** (flip which one runs with `disabled: true`).

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
| memory recall tool | none | `akane_recall` (behind `memory.enabled`, off by default) |

New capabilities: group wake words (three tables, editable right on the settings page), history carried on implicit wake-up, images in group history are visible to her (see "Group history images"), persona as hot-reloaded files, blacklist enforced in code, meme-image replies, a quiet window that folds one thought split across several QQ messages into a single turn (see "Fragment quiet window"), and an opt-in memory stack (see "Memory stack") that needs a local embedding service you start yourself.

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
| `quietWindowMs` | number | `0` | Idle quiet window (ms): while she is idle, fragments from the same sender are folded into one answer. `0` = off (the middleware chain is byte-identical to the version without this feature). **Needs production arrival samples before turning on** — see spec §5 D2 |
| `quietWindowEmptyShellMs` | number | `0` | Longer window (ms) for empty-shell fragments (@ or a name only, no body), `0` = fall back to `quietWindowMs` |
| `quietWindowMaxWaitMs` | number | `0` | Hard ceiling per window, measured from the first fragment (ms); must be > 0 whenever the window is on, otherwise loading the plugin throws |
| `quietWindowMaxFragments` | number | `4` | Max fragments per window; the batch is released as soon as it is reached (safety valve) |
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

### Fragment quiet window (quietWindow)

QQ splits one thought into several messages. While she is idle each fragment triggers its own turn, so the same sentence gets answered twice. The window lets her collect a short batch before speaking: one bucket per group-and-sender, and only a fragment that actually names her may open it (other people's chatter is not pulled in).

Four rules that interact, easy to trip over:

- **The empty-shell window replaces, it does not add**: when the whole batch is only an @ — no text, no image — the length switches to `quietWindowEmptyShellMs`, so it is only meaningful when it is **larger** than `quietWindowMs`; a smaller value just speeds that shape up.
- **The hard cap counts from the first fragment** and is not pushed back by later arrivals; `quietWindowMs > 0` with `quietWindowMaxWaitMs = 0` is an illegal combination (an endless stream would never be released) and throws at load time.
- **Fragment valve**: once `quietWindowMaxFragments` are collected the batch is released immediately.
- **Window length is latency**: it is added to every reply she makes. Setting it to 0 goes back to "one fragment, one answer"; setting it to tens of seconds makes her wait that long for every sentence. Only measurements can size it (`node scripts/arrival-report.mjs`), not intuition.

All four fields are editable in the "Fragment quiet window" group on the settings page, each showing its value converted to seconds. Saving writes this plugin's entry in the profile and hot-reloads — no manual YAML, no process restart (in-flight bot sessions do reset). Design evidence and the decisions taken are in `docs/specs/2026-11-18-akane-fragment-merge-and-recall.md`.

### Persona files

Who she is and how she talks moved out of the workspace `AGENTS.md` into Markdown files shipped with the plugin, cached by mtime+size — an edit takes effect on the next message, no restart:

```yaml
config:
  personaGroupFile: persona/akane-group.md   # relative to the package root, ~ expands
  personaDirectFile: persona/akane-direct.md
  personaLessonsDir: persona/lessons         # *.md in filename order, each with its own heading
```

Composition order is `persona file → lessons → legacy groupPrompt/directPrompt`, and the section is spliced in after the host's `deployment:persona-prefix` rather than appended to the end of the prompt. `persona/README.md` records the writing discipline: behaviour rules and few-shot dialogue, never a list of forbidden words.

### Arrival probe (arrivalProbe)

| Config | Type | Default | Description |
|------|------|--------|------|
| `arrivalProbe.enabled` | boolean | `false` | Record the arrival time of every inbound message (used to size the `quietWindowMs` default) |
| `arrivalProbe.keepDays` | number | `30` | Days to keep probe files, 0 = never expire |

Quiet-window length is latency added to **every** reply she makes, so its default has to come from measured production traffic rather than a guessed number. With the probe on, each inbound message appends one line to `~/.dsh-qqbot-akane/arrival/YYYY-MM-DD.jsonl` holding only `messageId` + local receive millis + a hash of the bucket key + whether her name was in it — **no message text, no openid**, which is why this file needs no redaction pass. To get numbers:

```bash
node scripts/arrival-report.mjs        # p50/p90/p95 plus sample size
```

The measurement rule lives in `src/features/arrival-stats.ts` (adjacent messages in the same bucket, gaps under 120s, and below 300 pairs it only reports "keep collecting"). In the off state nothing is mounted, no cleanup timer runs, and the directory is not even created. Until 300 pairs exist `quietWindowMs` can only be a provisional value (currently 12s in production, taken from the p50 = 10.2s dense band); once there are enough samples it gets re-derived from p90 — one field on the settings page, no restart.

### Rich media (media)

| Config | Type | Default | Description |
|------|------|--------|------|
| `media.enabled` | boolean | `true` | Enable rich media understanding (image/video download + tool analysis) |
| `media.maxMB` | number | `200` | Max download size (MB) |
| `media.ttlHours` | number | `24` | Media lifetime (hours), 0 = never expire |

### Group history images

SDK history entries have a text slot only, so an image posted in a group collapses into a blank line once it is in history — she can see it when she is @-ed, but "what was that picture earlier" shows her nothing. This fork replaces the buffer with its own `akaneHistoryBuffer` (still mounted before `mentionGate`, so messages that don't mention her still enter history), keeps attachment metadata on each entry, and starts the download **at the moment of recording**.

- **Why not download on demand**: QQ never documents how long its delivery links stay valid and there is no re-signing endpoint. Gambling on the link gives a dead path in context; she opens it, the tool errors, and that error text is what reaches QQ. Downloading at record time is correct under any expiry.
- **When it downloads** (all six must hold): a group message (direct chats don't feed history) · not hard-blocked by `access` · the attachment is an image (video and files keep only a label) · not sent by the bot herself · not already on disk (dedup) · that group still has quota for the day. With `media.enabled=false` nothing on this path is written at all.
- **Dedup**: the filename QQ hands out is the content MD5, and equality is decided on it; the current-message, quote and history paths share one ledger (`src/features/media-ledger.ts`), so the same meme is stored once and appears in context once.
- **Limits**: 20 downloads per group per day (counted per attempt, failures do not refund; cache hits do not consume), anything beyond is labelled `[图片]` in history. Downloads sit at the tail of the queue, fire-and-forget, so flooding pictures only fills a queue — it never blocks her replying.
- **Presentation**: an `        └ Image: <local path>` line hangs under the history entry, at most 4 paths per turn, allocated newest-first; entries without a path degrade to `[图片]` / `[视频]` / `[文件: name (size)]`. Signed URLs never enter context at all. If TTL cleanup removed the file, rendering checks on the spot — a dead path is never handed over.
- **Lifetime**: unchanged, still `media.ttlHours` (default 24h, by file mtime; cleanup runs at startup and hourly).
- **Quota and frequency are different things**: this caps **inbound** writes; how often she attaches a meme on the **outbound** side is a soft constraint in the `akane-sticker` skill, with no hard gate this cycle.

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

### Memory stack (memory)

Lets her find back things **she herself said** across turns and across restarts, by meaning rather than by keyword. This is layer T2 of the five-layer design: a disposable derived index plus one recall tool. The source of truth stays the host's transcripts (T1) — the plugin only ever reads them.

| Config | Type | Default | Description |
|------|------|--------|------|
| `memory.enabled` | boolean | `false` | Master switch. When off: no `index/` directory, no background job, no registered tool, no log line |
| `memory.embedBaseUrl` | string | `http://127.0.0.1:8765` | Local embedding service base URL — **loopback only**, the client refuses anything else outright |
| `memory.timeoutMs` | number | `8000` | Per-request embedding timeout (ms) |
| `memory.dims` | number | `512` | Vector dimensions, bound to the model; a mismatch with `meta.json` triggers a full rebuild |
| `memory.syncIntervalMs` | number | `600000` | Background sync interval (ms); the first pass backfills everything |

- **Its ceiling is set by T1, not by retrieval**: a group message that neither mentioned her nor got folded into the context of a turn she answered simply isn't in the transcript, and no search can conjure it. The memory stack fixes "it's there but I can't find it / can't find the right thing", **not** "it was never stored".
- **Needs a resident service the user starts**: `embed-service/` (a separate Node process, ONNX q8 build of `bge-small-zh-v1.5`, bound to `127.0.0.1` only; **requires nothing but Node ≥22 — no Python, no CUDA, same code on Linux / macOS / Windows**). The plugin **never spawns, self-heals, or kills** it; install and start/stop instructions live in [`embed-service/README.md`](./embed-service/README.md). When the service is unreachable, recall degrades to the literal lane — there is **no** fallback path to a remote embedding API.
- **Three files under `~/.dsh-qqbot-akane/index/`**: `chunks.jsonl` (text + metadata), `vectors.f32.bin` (same order, fixed width), `meta.json` (schema / model / dims / sync cursor). Delete the whole directory and it rebuilds; the plugin starts fine either way.
- **The privacy boundary is the `peer` written at index time.** Recall only ever matches the same peer, there is no cross-peer switch, and it never widens by working directory (other people's transcripts — including the user's own development sessions — live under the same sessions root). Transcripts whose owner can't be resolved are indexed but permanently unrecallable.
- **Return bodies never contain** host paths, `└ Image:` lines, session ids, openids or appIds. Every failure answers with the "not found (…)" family of fixed strings (one per cause, none carrying the underlying error), and no exception is allowed to escape `execute` — that would surface in QQ as `❌ tool akane_recall failed`.
- **Chunk boundaries share one value with `quietWindowMs`** — if folding says one message and chunking says two, the two halves can never be reconciled. That window value is itself still provisional (see above) and chunking inherits the same marker.
- **Every limit and the similarity floor are provisional**: 6 fragments / 600 chars per fragment / 3000 chars per response / 0.45 semantic floor. **No offline retrieval-quality numbers exist** - what the live system produced is runtime observation only: across real calls the returned similarities ran min 0.451 / median 0.51 / p90 0.599, with 33 of 74 fragments landing in 0.45-0.50, i.e. the floor barely filters anything. Note this is the distribution **of what reached the response body**; candidates dropped below the floor are invisible. Retuning still requires before/after hit rankings over ≥20 real user queries, which only the user can supply. The default stays `memory.enabled: false`; switching it on is the operator's call.
- **The offline harness for threshold tuning landed in `0.5.5__0.3.1`**: `scripts/akane-recall-eval.mjs` (a maintainer tool that **takes part in none of her conversations**). It reads the on-disk index and computes the **full board** - the live payload only ever retains candidates above the floor, and the below-floor band is exactly what decides which way to move it, so those numbers can only be collected offline. Four subcommands (`inspect` / `questions` / `check` / `run`), one embedding per query swept across several arms, per-query hit ranks plus a report. The question bank and ordinal table live in `~/.akane-eval/` (outside the repo, 0700/0600); the interface side only ever sees append-only ordinals and local aliases. **As of this release it has not been run on a single real question**: those ≥20 questions have to come from the user (only 12 indexed chunks are "said by the other party and ≤40 chars", so 20 cannot be extracted), and none of the four thresholds has moved.
- **Status of the six manual QQ-side acceptance checks** (at the `0.5.5__0.3` release): 1, 2 and 3 were run and are evidenced from the transcripts - cross-session, cross-restart recall genuinely returned a fragment from 168 hours earlier, fragment counts stayed within 0-6 and response bodies within 37-1719 chars (never past the 3000 cap), 23 calls produced zero `isError`, and paths / usernames / `└ Image:` lines / openids / session ids / signed URLs / `❌ tool` appeared nowhere in the response bodies or in what was actually sent out. Check 4 (asking in another group must come back empty) rests on **indirect evidence only**; checks 5 and 6 (degraded wording with the service stopped, and the `embedding(...)` startup line) **were not run**. The original wording of check 3 - "look for the truncation marker" - is void: the 6-fragment cap always binds before the 3000-char budget does, so that marker cannot be reached.

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
├── setup/                      # Credential binding (QR)
│   ├── index.ts                # Binding orchestration (ensureCredentials)
│   ├── binding-service.ts      # QR polling state machine (single source of truth)
│   ├── bind-routes.ts          # In-app bind page routes + config editing API
│   ├── presenters.ts           # Presentation strategies (terminal / browser fallback)
│   ├── qr-svg.ts               # QR SVG rendering (host side)
│   └── persist.ts              # Writing credentials to cordis.patch.yml
├── client/                     # Browser half (dsh.client Web Bundle)
│   ├── index.ts                # Sidebar tab registration + bind guidance
│   ├── bind-page.ts            # In-app bind page (QR + status polling)
│   └── config-panel.ts         # Settings panel (wake tables / four window fields / access)
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
│   ├── history-store.ts        # Group history ring buffer (with attachment metadata)
│   ├── media-ledger.ts         # Media ledger (dedup / single-flight / daily quota)
│   ├── arrival-stats.ts        # Arrival-gap measurement rule (adjacent pairs per bucket)
│   └── answer-parser.ts        # Answer parsing
├── media/                      # Media
│   ├── vision-tool.ts          # Image vision understanding
│   ├── send-file-tool.ts       # Send local files
│   └── media-cleaner.ts        # Media TTL cleanup
├── middleware/                 # Middleware
│   ├── question-answer.ts      # Q&A answer handling
│   ├── history-buffer.ts       # Group history buffer + download at record time (replaces the SDK one)
│   ├── arrival-probe.ts        # Arrival-interval probe (step 3.5)
│   ├── quiet-window.ts         # Idle quiet window (step 4.6, before the gate)
│   ├── fragment-merge.ts       # Fragment merge (attribution / attachments / msg_id anchor)
│   └── attachment.ts           # Attachment handling
├── memory/                     # Memory stack (T2 index + recall, off by default)
│   ├── index.ts                # The single mount point and master switch (off = does nothing at all)
│   ├── chunking.ts             # Transcript events → chunks (boundary shared with quietWindowMs)
│   ├── index-store.ts          # The three index files + rebuild decisions
│   ├── transcript-source.ts    # Host service-surface allowlist, original text, scrubbing
│   ├── backfill.ts             # Background incremental sync (not in the middleware chain)
│   ├── embed-client.ts         # /embed client (non-loopback endpoints refused outright)
│   ├── peer.ts                 # The single source of the privacy boundary (fail-closed)
│   ├── retrieval.ts            # Hybrid: per-token AND + cosine → RRF fusion → limits
│   └── recall-tool.ts          # `akane_recall` definition and failure wording
├── shared/                     # Shared utilities
│   ├── utils.ts                # Common helpers
│   ├── scope.ts                # scope/peer extraction
│   └── send-helper.ts          # Chunked send
└── commands/                   # Slash commands
```

At the top level there is also `embed-service/`: the local resident embedding micro-service (its own Node process plus an `install.mjs` that fetches the weights). It is not part of the plugin process and does not start or stop with it. Provisioning only needs Node — `install.sh` is a thin bash wrapper around it; on Windows run `node install.mjs` and manage the process with `start.ps1` / `stop.ps1` (see that directory's README).

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
- **No gambling on external expiry** — QQ never promised a link lifetime, so media is downloaded at record time instead; every path handed to her is checked to exist right then, degrading to a label rather than passing a dead path she would turn into a QQ-visible tool error
- **Vocabulary is configuration** — wake words and persona paths live in `cordis.patch.yml`; changing them changes neither code nor the build
- **Off really means off** — the memory switch is tested in exactly one place, the first line of its mount function: no directory, no background job, no registered tool, and the set of tool names reaching `tools.register` is byte-for-byte what it was before the feature existed
- **The privacy boundary is written at index time** — every chunk carries its `peer`, recall matches that peer only and never widens by working directory; transcripts whose owner can't be resolved stay unrecallable
- **No inference inside the plugin process** — the ~300MB resident model and its tens-of-milliseconds batches belong to the separate `embed-service/` process, which the user starts and stops; the plugin only probes, only calls, and degrades to the literal lane when the service is down
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
