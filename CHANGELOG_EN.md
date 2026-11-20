# Changelog

> [简体中文](./CHANGELOG.md)

This file records significant dsh-qqbot-akane updates from a product perspective, focusing on user-visible changes.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

(Empty.)

## [0.5.5__0.3.1] - 2026-11-20

One addition, and it is **maintainer-side**: an offline harness that collects the before/after hit ranks any recall-threshold change has to come with. The previous release got the recall chain running live, but those four thresholds (similarity floor, candidate pool width, RRF k, fragment limit) are still guessed, and the numbers needed to move them can never come from production - every candidate she returns to a user is one that **already passed** the floor.

**Nothing about her own behaviour changed in this release**: the `memory.*` defaults, the actual values of all four thresholds, the payload shape, the persona, the wake-word tables and the window parameters are untouched. The change is "make the knobs injectable, defaults equal to current values" plus one new script. There is also **no recall-quality conclusion in here** - tooling in place does not mean data in hand; those ≥20 real questions are still on the user's side.

### Added

- **Offline recall harness `scripts/akane-recall-eval.mjs`** (the prerequisite for P2 tuning; **nothing about her live behaviour changed**). It exists to make one rule collectable: any threshold change must come with before/after hit ranks. That data is structurally unavailable online - the payload she returns only contains candidates that **already passed** the similarity floor, so everything below it is invisible, and the below-floor band is exactly what decides which way to move the floor. The harness reads the on-disk index and computes the full board. Four subcommands: `inspect` (index size and per-peer board lengths, counts and aliases only), `questions` (short peer utterances pulled off the board as question candidates for labeling), `check` (question-bank health: does an ordinal still resolve, has the quoted text drifted, do the query tokens tokenize at all), `run` (one embedding per query swept across parameter arms, per-query rank table plus a markdown report). It is **read-only by design**: it deliberately never calls the production `loadIndex`, which wipes the whole index directory when it deems the files dirty while the background sync is appending to them.
- **The four tuning knobs (similarity floor / vector pool width / RRF k / fragment limit) are now injectable**, defaulting to their current values, so behaviour is unchanged when nothing is injected. Besides the hand-replicated chain, `run` re-checks the returned payload against the **real `recallOnce`** with the same knobs injected, and errors out when the two disagree - the whole table rests on that comparison.

### Fixed

- **Peer aliases are now allocated append-only, in arrival order.** They used to be re-derived from "which peers are on the board this run, sorted", so one new group joining would shift A/B/C wholesale - and since the question bank is keyed by alias, **questions the user had already labeled would silently point at a different group while the table kept producing numbers**. They now follow the same never-reuse rule as ordinals, and a missing alias table alongside a non-empty ordinal table is called out on stdout (a lost alias table cannot be recovered: the ordinal table can self-locate via sha, the alias table cannot).
- **The question bank path moved back to `~/.akane-eval/work/questions.jsonl`**: the docs and the script's own header always said `work/`, while the code looked at the root, so `check`/`run` reported "no bank yet" next to a file the user had already written.

### Notes

- **The privacy boundary is a mechanism, not a practice**: the human and her exchange only **append-only ordinals** and **local aliases**; chat text and raw peer values stay in `~/.akane-eval/` (0700/0600, outside the repo, never committed). Printing text requires a real TTY **and** an explicit `--i-am-the-user`, so that gate is physically unreachable from a non-interactive environment; `leakgate` self-checks both gates and the output scanner using neutral synthetic sentinels. A `chunk.key` embeds a 44-character sessionId, so printing a key is printing a session identifier - the abstraction is not cosmetic.
- **The self-chunk trap is now measured**: quoting one's own earlier message as the question means the question *is* an indexed chunk (cosine ≈1, rank 1), which inflates ranks systematically. Measured during the 11-20 plumbing self-test (a chunk's own text as its own query): without excluding self **2/2 hits, median rank 1**; excluding it **0/2**. So the primary metric excludes self, on timing rather than preference - T2 is appended by a `syncIntervalMs` timer, so the current turn usually is not indexed yet.
- **It has not produced any real rank data yet**: those ≥20 real questions and the expected ordinals are still on the user's side (measured: only 12 chunks on the board are "said by the other party and ≤40 chars", so 20 cannot be extracted - the gap has to be written by hand). No threshold moved, and the schema default is still `memory.enabled: false`.
- Tests **711 passed / 48 files** (+10 this round: 7 retrieval, 3 recall tool), `pnpm build` clean.

## [0.5.5__0.3] - 2026-11-19

Two things landed: the window knob is now in the user's hands, and **the other half of cross-turn memory is built** - recall. Window length is a cost added directly to every single reply she makes, so this knob should not live only in YAML; the memory stack ships **off by default** and needs a local embedding service the user starts before it does anything at all.

What this release actually stands on: the schema default is still `memory.enabled: false`, but her live profile has it switched on by the user's decision, backfill has genuinely written the three index files, and recall went through 23 real calls from QQ. The Notes section below states check by check which acceptance items are proven and which are not.

### Added

- **Memory stack T2: semantic index plus backfill from transcripts** (`memory.*`, **`enabled: false` by default**). The index is three files under `~/.dsh-qqbot-akane/index/` (`chunks.jsonl` / `vectors.f32.bin` / `meta.json`) and is a disposable derived cache - delete the directory and it rebuilds, the plugin starts either way. Chunk boundaries are exactly the folded fragments, sharing **one and the same threshold with `quietWindowMs`** rather than a second opinion. Incremental sync runs on a timer, outside the middleware chain, so it never costs her reply latency.
- **The `akane_recall` tool** (same switch): a literal lane doing per-token AND plus a semantic lane doing cosine, fused by RRF rank (no fake score additivity); a hit goes back to the host transcript for the original text, and each returned line carries "time + turn + role + original text + which lane matched". Limits: 6 fragments / 600 characters each / 3000 characters per response.
- **`embed-service/`: a local resident embedding micro-service** - its own Node process running `bge-small-zh-v1.5` ONNX q8 under WASM, 512 dimensions. Comes with `install.mjs` (pinned dependency versions, weights verified by size + sha256, hf-mirror by default and honouring `HTTPS_PROXY`, so a fresh machine can be provisioned). **Bound to `127.0.0.1` only, with the address not even read from configuration**; logs carry counts, dimensions and milliseconds - never message text. **The user starts and stops it**: the plugin does not spawn, self-heal, or kill.
- **embed-service is now cross-platform**: weight provisioning moved from a bash script to `install.mjs` in pure Node - the old one leaned on `curl`, `sha256sum`, `find -type l` and `${VAR//\//--}`, all of which are missing or mean something different on Windows. The proxy handling is deliberate: **Node's global `fetch` ignores `HTTPS_PROXY`** (curl does not), so the script implements its own CONNECT tunnel and honours `NO_PROXY`, otherwise "install, then use a proxy" would silently lose the only lane that reaches Hugging Face from mainland networks. Repeat pulls get HTTP 429 from the mirror, so downloads retry with backoff (while clear failures like 404 do not retry). `install.sh` stays as a thin wrapper (`exec node install.mjs "$@"`) so every documented command still works. Windows gets `start.ps1` / `stop.ps1` for the background process and log rotation. **The only runtime prerequisite is Node ≥22**: inference is WASM plus a pure-JS tokenizer, so there is no Python, torch, CUDA or node-gyp build step.
- **`embed-service/start.sh` and `stop.sh` — POSIX now has its own start/stop pair**, semantically identical to `start.ps1` / `stop.ps1`: `~/.akane-embed.pid`, up to 30s of `/health` polling, a separate error log, and process lookup by command-line signature (`server.mjs --port <port>`) rather than a global node match — which would also take down `dsh web`. Before this, Linux/macOS meant typing `setsid nohup …` and `pgrep` by hand, with neither idempotence nor guardrails. `stop.sh` re-reads `ps -o args=` for every candidate and re-checks the signature before touching it, and prints a "nothing touched" line without touching anything when no process matches; `start.sh` refuses a second instance while `/health` answers. All three branches (real start, dry run hitting nothing, real stop) were executed here on Linux.
- **Tokenization switched to the official pure-JS implementation and verified against the HF reference**: the hand-written WordPiece got 202 of the same 349 cases wrong (ASCII punctuation, English casing, whitespace, code points above 64k). `embed-service/verify-tokenizer.mjs` is the ground guard for the whole semantic lane - rerun it after any model swap or dependency upgrade.
- **A fragment quiet-window group on the settings page**: `quietWindowMs`, `quietWindowEmptyShellMs`, `quietWindowMaxWaitMs` and `quietWindowMaxFragments` are now editable in the UI, each field showing its current value converted to seconds. Saving writes the fork entry in the profile and hot-reloads, so no manual YAML and no process restart. All four come pre-filled from the config defaults, and **clearing one is refused on the spot** - switch a window off by typing 0, because a silently dropped field is far harder to diagnose than a blocked save.

### Fixes

- **A single long message could stall the whole backfill round.** The memory stack hit this on its very first live round: a chunk over 512 tokens blows past BERT's positional embeddings, and `onnxruntime-web`'s WASM backend throws a **native exception** — the log only got `embed FAILED 56751936`, a numeric pointer with no message at all. The service answered 500, the plugin left its cursor where it was, and the same batch was retried every 10 minutes forever. The real cause: the inference kernel never truncated. The official pure-JS tokenizer's `EncodeOptions` only accepts `text_pair` / `add_special_tokens` / `return_token_type_ids` — there is no `max_length` or `truncation` flag to pass. `embed()` now right-truncates to `model_max_length` from `tokenizer_config.json` (512 for this model) while keeping `[CLS] … [SEP]`; the tokenizer-parity path is untouched and `verify-tokenizer.mjs` still reports 0 mismatches over 349 rows. This was no corner case: 35 of the 616 messages across her five transcripts (5.7%) exceed 512 tokens, the longest being 10,697 characters. **Requires restarting the embedding service to take effect** — the process does not reload itself.
- **Batch size came down with it, or the failure would only have become a timeout.** After truncation, a full-width 512-token row measures about **625ms each** (1 row 759ms, 4 rows 2,525ms, 8 rows 4,996ms, 16 rows 9,989ms on single-threaded q8). Rows are right-padded to the **longest member of the batch**, so a single ≥512-token chunk makes the entire batch full-width — one long message is enough to push a 16-row batch to 10 seconds, past `memory.timeoutMs` (default 8000), which the client enforces with `AbortSignal.timeout`. `EMBED_BATCH` is now **8**, capping the worst case near 5 seconds; compute is dominated by per-row inference, so halving the batch barely changes total time. **Requires `pnpm build` plus a `dsh web` restart** - and the process that has not restarted was caught doing exactly this: three consecutive log lines of `embed batch=16 ms≈10300`, i.e. the same batch retried three times after timing out each time.

### Notes

- **The ceiling on recall sits in the transcripts, not in the retrieval**: a group message that neither mentioned her nor got folded into a turn she answered was never written down, and no search can conjure it. The memory stack fixes "it is there but I cannot find it / cannot find the right thing", not "it was never stored".
- **The privacy boundary is the `peer` recorded when a chunk is written. There is no cross-peer switch, and nothing widens by working directory.** Her transcripts and other people's - including the user's own development sessions - share one sessions root, and transcript headers carry no peer field, so falling back to cwd once would pull other conversations into her context. A transcript whose owner cannot be resolved is indexed but **permanently unrecallable** (not even unknown-to-unknown matching).
- **Unreachable means unreachable, with no remote fallback**: when the embedding service is down the backfill skips that pass (no retry storm) and recall runs the literal lane only, saying so in the response body. The client refuses a non-loopback endpoint before sending anything.
- **A client timeout does not cancel the server's inference**: `AbortSignal.timeout` only drops the connection, while that ONNX batch runs to completion anyway — so "timeout plus three retries" is three times the work on the service side (that is where the observed RSS climb from 764MB to 782MB came from). Untouched this phase: the recall path is a one-at-a-time round trip (10-19ms measured) and only backfill batches hit this, which the smaller batch now sidesteps. **Do not read this as the service having backpressure.**
- **Every threshold and limit is provisional, and no offline retrieval-quality numbers exist.** The semantic floor of 0.45 and RRF k=60 were picked by hand. Changing them requires before/after hit rankings over ≥20 real user queries, and only the user can supply those. **Of the six manual QQ-side acceptance checks, 1, 2 and 3 were run and are evidenced** (cross-session recall genuinely returned a fragment from 168 hours earlier, the caps were never crossed, 23 calls produced zero `isError`, and nothing leaked into the response bodies or into what reached QQ); **check 4 rests on indirect evidence only, and checks 5 and 6 (degraded wording with the service stopped, the `embedding(...)` startup line) were not run.**
- **q8 cosine drifts by ±0.01 with batch shape** (the same text at batch=1 vs batch=8 self-scores 0.995), so thresholds must not be set hugging a particular score and cos≈0.99 is not evidence of duplication. Measured locally: load 644-691ms, cold-start RSS 229-435MB, 19-120ms per batch.
- **The Windows lane is proven only at script level**: the three weight sources in `install.mjs` (already present / local HF cache / mirror download), the proxy tunnel, the backoff retries and the failure branches were all executed here - on Linux, which is the same pure-Node code, and the POSIX `start.sh` / `stop.sh` ran all three branches here (real start, a dry run that touches nothing, real stop). **`start.ps1` and `stop.ps1` have never run**, because there is no Windows machine in reach, and `onnxruntime-web`'s WASM behaviour on Windows is equally unverified. When a Windows install misbehaves, those two are the first suspects.
- **"Off means off" is an acceptance item**: with `memory.enabled=false` there is no directory, no background job, no registered tool and no log line, and the tool-name set reaching `tools.register` is byte-for-byte what it was before this feature existed. Note that changes under `src/` **require restarting `dsh web`** - hot reload does not pick up in-process implementations.
- **The server rejects the combination window-on plus hard-cap-zero before writing anything**: that shape makes the quiet-window middleware throw while mounting and takes the whole plugin down, and the settings page is the only place where both fields can be edited together. An empty-shell value that is not larger than the short window only wastes itself (it replaces the short window instead of adding to it) rather than breaking anything, so it stays allowed and the UI copy says so.
- The bounds (0-120000 ms, 1-20 fragments) exist once on the server and once in the client; the server is the boundary, the client copy only saves a round trip.
- Production now runs an empty-shell window of 20000 instead of 0 (11-19 afternoon); still unverified on a real device.

### Documentation

- **`embed-service/README.md`**: why it is a separate process, the runtime prerequisite (Node ≥22 and nothing else) plus the install path for all three platforms (the flag table, and what the proxy and 429-retry handling actually do), the Linux/macOS and Windows start/stop commands, the HTTP contract and its four limits, the two self-check scripts, and the measured numbers above (including the batch-shape drift as a known limitation).
- Both READMEs gained a "Memory stack" section and the `src/memory/` module tree, plus three new design principles: off really means off, the privacy boundary is written at index time, and inference does not belong in the plugin process.
- **README_EN brought up to parity with the Chinese README**: it was a whole release behind - the four `quietWindow` config rows, the fragment quiet-window section, the arrival-probe section, the group-history-images section and the `setup/` directory in the module tree were all missing. They are filled in from the Chinese text now, together with the "no gambling on external expiry" design principle, and both module trees list the files this fork adds (`config-panel.ts` / `arrival-probe.ts` / `quiet-window.ts` / `fragment-merge.ts` / `arrival-stats.ts`). The English tree remains a curated view, not a complete file listing.

## [0.5.5__0.2] - 2026-11-19

One thought often arrives from QQ as several separate messages. This round handles the ingestion half of that problem; the recall half is sequenced later in the spec.

### Fixes

- **A batch folded by the quiet window is no longer dropped by the mention gate.** Production evidence on 11-19 caught the worst shape: `@her + one line` followed by two more lines produced **zero reply at all**. The window must strip the `<@!appId>` marker from the naming fragment (that fragment's chain ends inside the window), while the survivor is an un-@'d continuation — so all three of the gate's explicit-mention tests failed and the whole batch was treated as chatter nobody addressed. Flushing now leaves a "this batch was addressed" marker and the gate consults it before falling back to the wake-word tables. The marker lives on `state` only; no fake @-marker is injected into her prompt. Single-fragment batches are untouched, so the disabled state stays byte-identical.
- **Fragments folded into a turn no longer appear twice in that same turn.** Step 4 appends each message to the group history independently, so after a merge the same sentence rendered once under `[Chat history begins]` and once in the batch. Folded fragments are now removed from the survivor's history snapshot by `messageId`.
- **Fragments buffered while she is busy now anchor the passive reply to the `msg_id` of the newest message.** The SDK default merge kept the oldest one, i.e. the credential closest to expiry.
- **Merging no longer loses cross-speaker attribution.** Fragments used to be concatenated into a single body rendered under one sender, so "three from Zhang San + three from Li Si" read as "one person said six things". Same-sender fragments still join plainly; different senders are split into segments, each labelled `nickname (openid)`.
- **Merging no longer drops attachments.** Only text-bearing fragments contributed their attachments, so an image-only message disappeared entirely. All fragments are now collected. **This is a code-level correctness fix**: production evidence on 11-19 shows the reported "she ignored my image" has a different cause (see Notes).

### Added

- **Idle quiet window** (new middleware step 4.6, before the mention gate): consecutive fragments from the same sender while she is idle are folded into one turn and answered once. Bucketed per chat + sender; only a fragment that itself names her may open a bucket. **Off by default** (`quietWindowMs = 0` skips mounting entirely, keeping the chain byte-identical to before) — the window is added to *every* reply latency, so the default value waits for real arrival-interval samples instead of a guess. Empty-shell fragments (a bare @) use a longer window, bounded by `quietWindowMaxWaitMs` and `quietWindowMaxFragments`; slash commands and pending-question answers pass through immediately.
- Config keys: `quietWindowMs` / `quietWindowEmptyShellMs` / `quietWindowMaxWaitMs` / `quietWindowMaxFragments`.
- **Arrival-interval probe** (`arrivalProbe`, off by default): every inbound message appends one line with `messageId` + local receive ms + bucket-key hash + whether it named her. **No text, no openid** — the file needs no redaction. `node scripts/arrival-report.mjs` prints p50/p90/p95 with the sample size; that is the only input allowed to set the window default above. When disabled the middleware is not mounted, no timer runs and the directory is never created.

### Notes

- **Production evidence (11-19, old-code baseline):** an image sent *separately* right after `@her` formed no turn at all — it carries no mention, so the gate drops it at step 5. An image sent *in the same message as the @* was always fine (queued to the end of the busy turn, path intact, she read it). So the cure is the quiet window above — not the merge fix. The merge fix still has not been exercised in production: it needs ≥2 fragments buffered while she is busy.
- Same run: real fragment gaps reached **6–9 seconds** (bare @ followed by an image), so the empty-shell window needs its own value (~10s) rather than the short window's percentile.
- Also first production sighting of the history `[图片]` **degradation** branch: a TTL-expired image rendered as a placeholder instead of a dead path.
- **The window length finally has real data**: the probe accumulated 26 same-bucket adjacent inbound pairs (one sender, deliberately burst-typed on the morning of 11-19) — **p50 = 10.2s**, dense band 2–17s. The same metric reverse-engineered from chat transcripts over the same period reads p50 = 36.2s / p90 = 92.6s, because transcripts only contain messages that formed a *turn* — un-named continuations are invisible there. That measurement is systematically inflated and **must not be used to size the window**; it is precisely why the probe exists.
- Production now runs **`quietWindowMs = 12000`** as a **provisional** value (`quietWindowMaxWaitMs = 30000`, `quietWindowMaxFragments = 4`, `quietWindowEmptyShellMs = 0` inheriting the short window). Provisional, not settled: 26 pairs is far below the 300-pair gate, and the "how long after naming her" segment is contaminated — the window was off during sampling, so she answered instantly and the observed gaps are reactions to her answer rather than the rhythm of one thought split apart. Hence no separate empty-shell value this time. The profile says so in place.
- **Re-verified in production after the restart (11-19 12:18:57)**: lining the probe's per-bucket sequence up against turn start times in the transcript — a `w=1` + `w=0` pair (12:19:26 / 12:19:37) folded into **one complete turn at 12:19:49** and got a normal reply, which is exactly the shape that used to fall silent. The folded batch carrying 2 images came out with 4 lines in the current segment, 4 in history and **zero overlap**, so the double rendering is gone too. All five turns released at the last fragment + precisely 12s. Still unverified: the empty-shell window (currently `0` = off).
- Design, the three decisions taken, and open evidence items: `docs/specs/2026-11-18-akane-fragment-merge-and-recall.md`. Merge-replay landing point: `../upstream-merge.md` §4 item 6 (kept outside the repo).

## [0.5.5__0.1] - 2026-11-16

Identity is now fully separate from the official `@tencent-connect/dsh-qqbot`. Previously only the plugin id, routes and tool names diverged; the package name and display metadata were still copied verbatim, so the plugins page showed two entries with the same title, same icon and same description — indistinguishable from one plugin.

### Changed

- **npm package**: `@akane/dsh-qqbot` → `dsh-qqbot-akane` (follows the GitHub repo name). The host sorts by short name (scope and `dsh-` prefix stripped), so the old name collapsed to `qqbot` just like the official one and they sat adjacent; the new one sorts as `qqbot-akane`.
- **Plugins page title and blurb**: `meta.title` in `locale/zh.json` / `locale/en.json` is now "QQ 机器人 · Akane" / "QQ Bot · Akane", and the description lists this fork's four behaviours. Both were byte-identical to upstream, and `meta.title` outranks the package name when rendering.
- **Icon**: new `assets/icons/akane_qqbot.svg` (cyan, cat ears) instead of the official `qq_logo.svg` — the two files used to share an md5.
- **package.json points at the fork**: `description` / `repository` / `homepage` / `bugs` now reference `github.com/w2tbp/dsh-qqbot-akane` rather than the upstream repo.
- **In-QQ footer**: `/bot-version` and `/bot-help` report `dsh-qqbot-akane v…` instead of `dsh-qqbot v…`.

### Migration

- Renaming the package means renaming it in the profile too: the `dependencies` key, the `dsh.profile.bundles` entry and the `node_modules` link. Restart the process afterwards — title and icon are read into plugin meta at boot, hot reload will not refresh them.
- **Plugin id `im-qqbot-akane`, data dir `~/.dsh-qqbot-akane` and routes `/qqbot/im-qqbot-akane/*` are untouched**: credentials, the three wake-word tables, persona files, group history and the media ledger all carry over without reconfiguration.
- Verified on the real host 2026-11-16: after restart the plugins page shows "QQ Bot · Akane" with the new cyan icon, the load self-check reports `- id: im-qqbot-akane / name: dsh-qqbot-akane`, and the profile reverse-lookup that receives persisted credentials still resolves.

### Version scheme

From this release the fork ordinal is separated with `__`: `<upstream>__<fork ordinal>` (this one is `0.5.5__0.1`), replacing the previous `0.5.5+akane.N` form.

## [0.5.5+akane.3] - 2026-11-14

Everything added since `0.5.5+akane.2`: images that pass through group history are finally visible to her.

### Added

- **Group history now carries attachments**: fixes "she can see an image when she is @-mentioned or quoted, but the same image disappears once it goes into group history". The root cause was on the rendering side — the SDK's history entries have a text slot and nothing else, so an image-only message became an empty line behind a sender label. The plugin now ships its own `akaneHistoryBuffer` (still mounted before the mention gate, so non-@ messages keep being recorded), keeps attachment metadata in the entry, and strips `<face>` tag noise out of the historical copy of the text.
- **Download at record time**: an image appearing in a group is fetched **the moment it enters history** rather than gambling on how long QQ's signed URL stays valid (the official docs state no expiry, and there is no endpoint to re-sign it). Downloads run fire-and-forget on a serial chain, so nobody can turn the process into a downloader and she never waits for it. Nothing is fetched for hard-blocked senders, for her own messages, or for video/file attachments; turning `media.enabled` off disables the whole path.
- **Dedup and a daily cap**: one in-process ledger is the only answer to "is this image already on disk" (QQ hands down filenames that are themselves content MD5s, which is what equality is judged on). The same meme reposted is stored once; each group gets 20 proactive downloads per day, beyond which only a label is kept. Her current message, quoted message and group history share the same ledger, so a single image no longer shows up under two paths.
- **How history attachments read**: a history line is followed by `└ Image: <local path>`, at most 4 paths per turn, allocated newest-first (the freshest image is the one she is most likely to be asked about); anything without a path degrades to `[图片]` / `[视频]` / `[file: name (size)]`. Signed URLs never enter the context at all, and a file already reclaimed by the TTL is detected at render time instead of being handed out as a live path — a dead path would surface as a tool error delivered straight to QQ.

### Changed

- **Wider inbound download scope**: group images went from "only messages that trigger her" to "every image in the group, with dedup and a per-group daily cap". Retention is still 24 hours, measured by file mtime with cleanup running hourly, so files disappear somewhere between 24 and 25 hours. Worst case is roughly 20 new images per group per day.

### Documentation

- README brought in line: the fork capability list, a new "群历史图片" subsection under rich media, and the module tree now includes the history store and the media ledger.

## [0.5.5+akane.2] - 2026-11-13

Everything added since `0.5.5+akane.1`: wake words in the settings page, the meme/sticker capability, a group-form fix, and one wake-word boundary fix.

### Added

- **Wake words are now editable in the settings page**: `wakeWords` / `wakeWordsWeak` / `wakeWordExcludes` used to require hand-editing YAML. They now live in a "群聊唤醒词" group, one word per line. Each entry is trimmed, empties dropped, duplicates removed in original order; max 20 characters per word and 100 entries per table (word lists get compiled into regular expressions, so the UI must not expose an arbitrarily large matching surface). A non-array value or a non-text entry returns a Chinese `TypeError` instead of silently persisting. Saves land in the fork entry of the profile, so from then on the UI is the source of truth for the word lists.
- **Meme/sticker replies, with zero new code**: inbound images already land in the data directory (extension corrected by magic bytes), absolute paths already reach the envelope, she can look at images, and both outbound paths (`akane_send_file` and `present`) deliver them. The workflow is documented as the `akane-sticker` skill: a `workspace/stickers/` library plus `INDEX.md` with one line per image, and "when to attach a meme" written into the skill description and body. Attachment frequency stays a soft constraint enforced by her own judgement — no cooldown or quota gate this round.
- **The settings page now says which plugin a panel belongs to**, and the persona path is shown read-only.

### Changed

- **No more one-to-one address in groups**: she no longer uses a form of address that only holds for a single person when speaking in a group.

### Fixed

- **A Latin wake word followed directly by Chinese no longer misses**: both adjacency guards used to treat a Han character as "part of a longer token", so the most natural way of calling her in the wild — `akane说话`, `akane你还知道…` — was silently dropped while `akane 说话` and `akane，说话` worked. The two guards are now deliberately asymmetric: the right guard only forbids ASCII letters/digits/underscore, while the left guard stays conservative so statements *about* her (`我叫akane`, `喜欢akane的人`, `她的akane怎么办`) still do not fire, with a single exception for sentence-final particles (`真的吗akane`, `冲啊akane` now hit). The price is that `akane真可爱` — talking about her at the start of a sentence — now fires too. `对不对akane`, where a content word is glued straight onto the name, intentionally stays unmatched: lexical boundaries cannot separate it. CJK words, the weak-word vocative rule, the exclusion table and the masking logic are untouched.
- **Builds no longer dirty `lib/client.js.map`**: the artifact was meant to be gitignored but was tracked, so every build showed one change. It is now untracked (the file stays on disk).

### Documentation

- Two installation traps recorded: a same-id entry in the profile shadows the bundle patch's `insert`, so a fork entry must spell everything out (word lists / persona / `access`) rather than relying on a merge; and skill backup directories must live outside `$DSH_HOME/skills`, otherwise the host reads a backup as a second skill with the same name.

## [0.5.5+akane.1] - 2026-11-12

This fork is based on `@tencent-connect/dsh-qqbot@0.5.5`. Four behavioral changes plus a full identity rename, so it can coexist with the original in the same profile.

### Added

- **Wake-word triggering in groups**: three tables — `wakeWords` (strong), `wakeWordsWeak` (weak), `wakeWordExcludes` (blocked substrings). Mentioning her name now works without an @. Matching is lexical: CJK and alphanumeric characters are not boundaries, so "did you see the picture 茜 posted" does not fire; weak words need a vocative signal ("cat, what do you think?" fires; "how much is this cat food", "totoro", "kitty-cat" do not). URLs, code fences, inline code, QQ face tags and `@other-nickname` are masked at equal length before matching; only the first 2000 characters of long messages are scanned; any exception inside the matcher is swallowed so a message is never dropped. With all three tables empty the callback is not even injected — behavior is byte-identical to 0.5.5.
- **Persona as hot-reloaded files**: new `personaGroupFile` / `personaDirectFile` / `personaLessonsDir`. The persona moves out of the workspace `AGENTS.md` into `persona/*.md` shipped with the plugin, cached by mtime+size, so an edit takes effect on the next message without restarting. Composition order: persona file → lessons → legacy groupPrompt/directPrompt (backward compatible).
- **Hard blacklist**: `access.c2cDeny` / `access.groupDeny`. Deny is evaluated before `mode` and calls `ctx.stop()` — no reply, no explanation, and the message never enters group history, even when she is @-ed. `groupDeny` matches the sender openid, so blocking one member leaves the rest of the group untouched. The config panel edits both allow and deny lists (it can no longer silently wipe a blacklist).

### Changed

- **Implicit wake-up is no longer amnesia**: fixed an upstream defect where `isImplicitMention` only affected `shouldAnswer`, while history assembly and the mention flag still looked at the explicit @ — so a wake-up by name gave her neither the conversation nor any hint she had been called. Implicit wake-ups now include `[Chat history begins]` and label the message "（有人喊你）" to distinguish it from the explicit `(@you)`.
- **Persona section placement fixed**: the host sorts sections and drops the `order` field before the waterfall runs, so the plugin's `order: 90` was a no-op and the persona landed at the very end of the prompt. Sections are now located by name and spliced in after `deployment:persona-prefix`. Persona text is injected with `interpolate: false` and with `{{` escaped, so template-like wording in a persona cannot break prompt construction.

### Identity rename (prerequisite for coexistence)

Package `@akane/dsh-qqbot`, plugin id `im-qqbot-akane`, data dir `~/.dsh-qqbot-akane`, routes `/qqbot/im-qqbot-akane/*`, tools `akane_describe_image` / `akane_send_file`, plus UI seats, style ids, temp/rollback file names, the `ask_user_question` re-entrancy flag and the QR `source`. Leaving the re-entrancy flag or the profile-locating path unchanged would cause silent failures when both versions are loaded: the fork's question channel gets skipped, or credentials are written into the original's profile.

### Fixed

- Flaky mtime assertions in the inherited test suite: `utimesSync` can round to `-1µs` on ext4, so the equality checks now allow a ±1ms tolerance.

## [0.5.5] - 2026-10-30

### Fixed

- **Fixed the broken QR code in the in-app binding flow**: qrcode is now loaded via `createRequire`, bypassing the missing-API issue caused by the host's ESM interop. When the QR cannot be produced, the page falls back to a notice offering to restart the app, open the link in a browser, or enter credentials manually.

## [0.5.4] - 2026-10-28

### New Features

- **New `/bot-me` command**: shows the sender's OpenIDs (user openid in DMs; group-member openid and group openid in groups) as a self-service entry for allowlist onboarding — users hand the IDs to an admin to be added to the lists.
- **Admin command authorization**: `/preset` and `/model` work in both DMs and groups, but only allowlisted users may switch the preset or model (a group switch affects that group's session); each command's DM/group availability is shown in `/bot-help`. (#5)

### ⚠️ Behavior Changes (secure defaults)

- **Access control tightened by default**: DMs default to allowlist with an empty list rejecting everyone (previously empty lists silently allowed everyone); groups default to open (guarded by group membership and the @-mention gate). On QR binding, DMs switch to allowlist with the list reset to the scanning user (rebinding swaps the owner) — binding grants access.
- **Isolated default workspace**: the agent working directory now defaults to `~/.dsh-qqbot/workspace` instead of following the DSH process directory; set `cwd` explicitly to override.
- **Approval buttons check permissions**: in allowlist mode, approval buttons only take effect for allowlisted users — clicks by non-authorized members and forwarded DM cards clicked by others are ignored.

### Fixed

- **Saving configuration no longer clobbers other plugins**: binding, saving settings, and unbinding only touch this plugin's own entry; other plugins' content and comments are preserved. (#53)
- **Long prompts can be saved**: the settings-save request body limit is raised from 4KB to 512KB. (#69)
- **Vision-path hazard fixed**: the `qqbot_describe_image` message source now uses the current session format, so future image injection into the main conversation will not fail. (#77)
- **Hardened session ids**: unified `session-` prefix (#81) — community plugins no longer misjudge QQ sessions, multi-process concurrency produces no duplicate ids, and existing sessions keep their original ids.
- **Fixed model switching**: both the `/model` crash and the "history failed to load" error after restarting post-switch are fixed, with conversation history fully preserved.
- **Fixed session-event reads**: `/tokens` showing 0, `/export` producing empty output, and approval buttons not echoing the gated command — all fixed.
- **Fixed compaction**: `/compact` wrongly reporting the service as unavailable or "no active session" — fixed; in the latter case the session is revived from disk before compacting.
- **Fixed config save failure with link installs**: saving from the settings UI kept reporting "profile directory not found" when installed via `dsh plugin add link:` — fixed. With multiple profiles sharing the same source, writes target the profile of the current process. Remaining failures point at manually editing `cordis.patch.yml`. (#78)
- **Fixed allowlist default bypass**: omitting `access` entirely still fell back to open DMs (the outer schema default was not updated with the field defaults) — now aligned to allowlist and pinned by tests. (#94)
- **Approval cards bound to their request and hardened**: buttons now carry the pending approval's unique nonce, so stale cards no longer settle; in allowlist mode a missing clicker identity is rejected too. (#94)
- **File-send path allowlist resolves symlinks**: paths are judged by their real locations; a symlink inside an allowed root pointing outside is rejected. (#94)
- **Image attachments named by their real format**: the QQ gateway labels all images `image/png` (most are actually GIF/JPEG), so saved files carried wrong extensions and extension-based image decoding failed; extensions are now corrected from the file header (magic bytes) — bytes unchanged, no transcoding, unknown formats keep the original behavior. (#76)
- **Unified workspace path resolution**: introduced a single source of truth for the plugin data directory (`~/.dsh-qqbot`), from which the workspace, media, and model-preference paths are uniformly derived; without an explicit `cwd` the host process directory is no longer wrongly used (previously causing workspace file sends to be denied). Missing files now report "file not found" instead of a misleading path denial.
- **Vision config auto-patch no longer clobbers settings.yaml**: the startup fix-up that declares `input` for the vision model now uses fidelity-preserving document editing (comments, anchors, and other settings kept as-is) with atomic writes and conflict-aware retry; the previous full re-serialization wiped all comments and formatting from the file.
- **Concurrent-safe preference file**: `model-prefs.json` (the session-id mapping shared by multi-bot and multi-profile setups) now writes atomically and merges other writers' entries before overwriting, so coexisting bots/profiles no longer clobber each other's mappings; deletions carry tombstones so concurrent writes cannot resurrect them; load/write failures surface as visible warnings (previously debug-only or silent — a lost mapping showed up as "lost context in QQ" with nothing to trace).
- **Fixed an unopenable session list**: when resuming a session fails, a new one is created only after confirming the session is genuinely absent on disk; corrupt logs and backend failures no longer recreate the same session id (which used to write one id into several directories, after which the host refused to load the whole session list). Such failures now fail loudly with a log entry, and the original history is still there once the fault clears.
- **Fixed concurrent messages landing on the wrong session**: the legacy session id derived from the user identity is now only used to migrate existing sessions, never to create new ones; concurrent requests for the same session (a slash command arriving alongside a normal message) are coalesced into one resume/create, so two mutually overwriting, never-reclaimed session instances are no longer produced.
- **Vision config patch keeps numeric precision**: integers are preserved verbatim when the `input` declaration is added, so large integers in the user's `settings.yaml` (install ids, timestamps) are no longer truncated.

### Internal

- Added a host-API adapter layer that uniformly supports both old and new host interface shapes.

## [0.5.3] - 2026-10-27

### Added

- **Streaming replies**: replies stream to QQ in segments while the model generates, and an automatic LLM retry rewrites the same streamed message instead of appending a duplicate. Streaming had never actually worked; it does now.
- **Delivered files reach the chat**: files the model declares as deliverables are automatically sent to the current QQ conversation right after the turn's reply, with a text notice when a file cannot be sent; can be disabled or capped in configuration.

### Fixed

- **Action confirmation restored**: confirmation requests never arrived — sensitive operations kept failing with "no approval channel is available". Fixed. (#51, thanks to [@IrisuM](https://github.com/IrisuM))
- **Settings panel input and copy**: allowlist textareas accept newlines, normalized on save; option labels such as open/disabled read more plainly.

### Metadata

- **Plugin metadata completed**: ships a plugin icon and a bilingual description; the plugin list shows “QQ 机器人 (dsh-qqbot)” / “QQ Bot (dsh-qqbot)” by interface language.
- **Entries and icon**: the sidebar and the plugin detail page gain management-panel entries; the settings panel icon becomes a vector logo.

### Documentation

- README: Desktop installation instructions — add from the Plugins page, connect by scanning in Settings, no command line involved.

## [0.5.2] - 2026-10-12

### Fixed

- **Fixed clean installs failing to activate**: 0.5.1 shipped with the old SDK range (`^1.0.4`), so clean installs resolved 1.0.4 and the disconnect logging feature crashed at startup (`TypeError`), failing plugin activation. The range is now `^1.0.5`.
- **Graceful degradation on stale SDKs**: environments that still carry an older SDK now skip the disconnect listener with an upgrade hint instead of failing activation.

## [0.5.1] - 2026-10-12

### Added

- **In-app QR binding**: bind your bot entirely from the DSH Desktop / Web settings page — scan with your phone's QQ or enter the AppID / AppSecret manually, with live binding status; the sidebar opens a guided page automatically while unbound. Credential rotation and unbinding are one click away.
- **In-app config panel**: no more hand-editing files — c2c/group access control (open, allowlist, disabled), mention-required in groups, streaming, tool-result display, model overrides and extra prompts, all applied automatically on save.

### Improved

- **Upgraded the QQ Bot SDK to 1.0.5**: disconnects are now logged with the reason and whether the bot will recover on its own, and a connection that can never be established fails fast with a clear reason instead of waiting forever.

## [0.5.0] - 2026-09-08

### Added

- **Image understanding**: send images to the bot and it will automatically understand their content (screenshots, photos, charts, etc.), and can analyze them together with text instructions.
- **File sending**: the bot can send local files (documents, images, etc.) directly to you, no longer limited to plain-text replies.
- **Proactive questions**: when the bot encounters uncertain information, it proactively asks you questions, letting you pick an answer with a single tap for smoother interaction.
- **Action confirmation**: before performing sensitive or critical operations, the bot requests confirmation, which you approve or block via "Allow/Deny" buttons.
- **Session compaction**: new `/compact` command to compress the current session history in one step, preserving context while freeing space — ideal for very long conversations.
- **Preset switching**: new `/preset` command to view or switch the bot's persona/behavior preset.
- **Network latency test**: upgraded `/bot-ping` to return network transport time and plugin processing time, making it easier to diagnose connection latency.

### Improved

- Long-task execution timeout extended to 30 minutes, so complex tasks are no longer interrupted mid-way.
- Direct and group chats now receive more context-appropriate system prompts.
- Failed proactive message pushes automatically fall back to passive replies, reducing "the bot didn't respond" situations.
- Media files such as images are automatically cleaned up after use, avoiding long-term disk usage.

### Fixed

- Fixed the `/stop` command not actually aborting in-progress generation (it was previously a no-op).
- Fixed the registration order of the approval channel, ensuring confirmation requests are captured and handled correctly.

### Documentation

- README updated with the new `/preset` and `/compact` commands, plus QR-code upgrade guidance.

## [0.4.0] - 2026-08-16

### Added

- **QR link**: when the QR code renders incorrectly, you can click the link printed in the terminal to complete scanning in a browser.

### Improved

- Supports auto-saving QR credentials on Windows (previously failed due to path issues).
- When auto-saving credentials fails, it now clearly guides manual configuration instead of silently dropping existing config.

### Documentation

- Added QR-code screenshots and upgrade guidance.

## [0.3.0] - 2026-08-15

### Added

- **File understanding**: send a file to the bot and it will automatically download and understand its contents, supporting extract, read, analyze, and more.
- **Streaming replies**: replies are displayed incrementally in real time, no need to wait for full generation — a smoother, more natural experience.
- **Visible progress**: when the bot runs tasks (running commands, reading/writing files), you can see what it is doing — no longer a "black box".
- **Error feedback**: when a task ends abnormally, the bot clearly explains the reason, no more "half replies" or "no response at all".

### Improved

- Correctly displays the speaker's nickname in group chats instead of an unreadable string.
- Automatically clears group chat history after replying to avoid cross-conversation interference.
- Voice messages are recognized and kept as text only, without extra invalid links.
- The bot now "actually gets things done": for requests like "download, extract, install", it executes real tool actions instead of just restating the steps.

### Fixed

- Fixed the bot being unable to read/write files (the working directory was misconfigured).
- Fixed duplicate content and too-few chunks in streaming replies.

## [0.1.0] - 2026-08-14

### Added

- **First release**: QQ bot integrated with an AI assistant, supporting direct and group chats.
- **Model switching**: supports switching between different AI models.
- **Common commands**: built-in help, status query, session management, and more.
- **QR binding**: bind the bot by scanning a QR code on first use, with simple setup.

### Fixed

- Fixed config parsing issues.
