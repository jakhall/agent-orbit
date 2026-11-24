# Orbit: architecture

Orbit shows every local Claude session and sub-agent in one place: a pane inside each desktop session and a pop-out window in Edge (the page). Two kinds of process do the work:

- **The mod**, one copy per Claude session. It observes its own session through engine hooks, publishes a redacted record, and draws the pane from a snapshot it reads.
- **The server** (`companion/server.mjs`, a short entry over `companion/lib/`: `serve.mjs`, `router.mjs` and `routes/`), one Node process per data folder. It is the one aggregator: it builds the snapshot every reader uses, serves the page, and holds every remote action (approvals, questions, replies) in memory.

`docs/CONTRACT.md` is the interface contract between engine and interface. Where the two documents disagree, the contract wins.

## Shape

```
every Claude session (one mod copy each)
┌──────────────────────────────────────┐
│ hooks: session / turn / tool / agent │── publisher ──▶ sessions/<cli id>.json ────────┐
│ measure / permission / notification  │                (redacted, debounced)           │
└──────────────────────────────────────┘                                                ▼
%APPDATA%\Claude\claude-code-sessions\…\local_*.json (+ waiting-input\) ──▶ ┌──────────────────────────┐
~\.claude\projects\<slug>\<cli id>.jsonl (open turns, edit index) ────────▶ │ server: watch → aggregate│
~\.claude\projects\<slug>\<cli id>\subagents\*.meta.json ─────────────────▶ │ → status → budget → write│
checkout .git/HEAD (branch, no git process), prefs.json ──────────────────▶ └────────────┬─────────────┘
                     snapshot-v2.json (schema 2, seq, bootId) ◀──────────────────────────┤
                       └──▶ every shown pane (one stat a second; layout with shared/layout.js)
                     GET /api/state + SSE /api/events ──▶ page (same object, same layout) ◀┘

hooks/approve.mjs (settings PermissionRequest hook) ── POST /api/hook/requests ──▶ server memory ◀── page answers
page reply ── POST /api/reply ──▶ server memory ◀── GET /api/mod/replies/<cli id> ── that session's mod
server notices ◀── GET /api/mod/notices ── any session's mod ──▶ $.ui.notify
```

There is no leader, lease, `leader.json` or mod-written `snapshot.json` (pre-daemon sessions still write them; see Mixed versions).

### Files

All in `%USERPROFILE%\.claude\orbit\`. The mod honours `ORBIT_DATA_DIR` when it is an absolute local path; the server and hook take `--data`.

| File | Written by | Purpose |
|---|---|---|
| `sessions/<cliSessionId>.json` | that session's publisher | What its hooks observed; pruned after 7 days. |
| `snapshot-v2.json` | server, only on change | Schema 2 snapshot for panes. |
| `prefs.json` | panes and server | Filters, settings, positions, pinned, `hidden`, `done`, `snoozed`, `projectOverrides`, `titles`, `tints`, `clearedAt`; unknown keys kept; a file broken for 10 s goes to `prefs.json.bad` and is rewritten. |
| `companion.json` | server, every 10 s | Port, pid, control token, version, `lastSeenAt`, `clients`, `attentiveAt`, PR-check state. |
| `server.lock` | server | One server per data folder. |
| `arm.json`, `arm.key` | server | Arm switches with an HMAC, and its key. |
| `audit.jsonl` | server | Decisions record; rotated once past 1 MB. |
| `notify.json`, `hook.json` | server | Notification mode; when the hook last called in. |
| `inbox/<cliSessionId>/seen.json` | that session's mod | The last 200 reply ids it consumed. |
| `approvals/enabled.json` | old releases | Read once, for the arm migration. |
| `companion.log` | server | Capped at 200 KB; never prompt, reply, question or tool-input text, never paths. |
| `edge-profile/` | Edge | The window's browser profile. |
| `snapshot.json`, `leader.json`, `actions/` | pre-daemon sessions | Ignored by the server; removed by Clear (`actions/` pruned after 1 h). |

Any other file in `inbox/` or `approvals/` that looks like a request, answer or done file is forged: the server deletes it and raises an alert.

## Why it is built this way

Constraints from the mod API (verified on the desktop's bundled CLI 2.1.317; questions on 2.1.321):

- **A pane cannot pop out** (`dock` or `inline` only), so the pop-out is a local page in an Edge `--app` window.
- **The pane's `Svg` is a picture**: no script, no clicks per node, only hover tooltips and SMIL. The pane graph has zoom, focus and an Inspect picker instead.
- **`$.agent.list()` sees only its own session**, so each session publishes its own record; sub-agents of sessions without the mod come from `.meta.json` sidecars.
- **`$.store` is one file per plugin with no cross-process merge**, so it is not used.
- **`$.fs.read` refuses files over 4 MiB.** The mod never reads transcripts; the snapshot is kept under 3.5 MiB.
- **State atoms are per session.** Sessions share data only through files and the server.
- **Mod permission events are pre-empted** by the built-in security plugin in desktop sessions. A settings-level `PermissionRequest` command hook does fire, and Claude honours its allow or deny.
- **Validator rules:** `$` goes only to plain `function` declarations; every atom is declared in the file that uses it (`SHAPES` in `src/state.ts` holds the shape tags).

Why one server aggregates: earlier releases aggregated in an elected session (the leader, with a 90 s lease), which needed a shown pane, could run two aggregators across versions, and gave the page a second-hand copy. The server watches the folders itself and gives panes and the page the same object.

## The mod

### Hooks and the publisher

`hooks/register.tsx` observes `session.start/end`, `turn.start/complete` (main loop and sub-agents), `agent.spawn`, `tool.call`, `session.measure`, `classic.PermissionRequest` and `classic.Notification` (`permission_prompt`). Every observer calls `next(e)`, returns its result unchanged, fails open, and awaits no host call before `next`.

`src/telemetry/publisher.ts` keeps one redacted record in `sessions/<cliSessionId>.json`. It writes at once for a main-loop turn start or end and for a question; tool calls, spawns, measurements and reply counts are debounced to one write per 5 s; a heartbeat goes every 30 s during a turn or while a sub-agent runs, and about every 2 minutes when idle (`idleBeatMs: 120000`). The record carries `replyProtocol: 2`, `tools[].pending` while a call runs, the pane's render counts and the reply counts.

**Redaction** (`shared/redact.js`, `shared/aggregate/redact.js`). A command publishes only its program (plus the subcommand for `git`, `gh`, `npm` and a few others), never arguments, assignments, variables or quoted strings; anything path- or token-shaped becomes `shell`. Grep and Glob publish the folder's basename, never the pattern; remote URLs lose credentials. The server re-redacts every record it reads (`cleanRecord`).

### The tick

`src/app.ts` runs one loop per session:

- **Pane hidden:** every 30 s, no dashboard work; it checks whether a server is live (`companion.json` rewritten in the last 30 s), which turns reply and notice polling on or off.
- **Pane shown, or `/orbit`:** every 10 s `ensureDaemon` (below) and the armed list for the pane's indicator (`diag.armed`); then `snapshot-v2.json` is read when its mtime moved. While the pane drew in the last minute the loop runs every second (one stat), otherwise every 30 s.
- A `schema` other than 2 keeps the last good snapshot; a newer one sets `diag.notice`, which also says why no server runs.
- The snapshot stays in module memory; the `snapshotVersion` atom (`{ at, n }`) makes panes redraw.
- `paneSnapshot` lays out the graph with `withGraph` (`shared/view.js` over `shared/layout.js`) for this reader's positions, again only when `bootId`, `seq`, `generatedAt` or positions change. The render hook reuses its last tree while snapshot time, prefs, pane state, size and a 15 s time step are unchanged.

`/orbit [list|graph|new|popout|diag]` opens the pane (desktop sessions open it at start) and runs a manual tick; `/orbit popout` runs `server.mjs --launch` with a window. While a server is live, every session's mod also polls it every 2 s for replies and notices (below).

## The server

### Modes and the daemon

Modes: `--launch [--no-window]`, `--serve [--open|--daemon]`, `--prune`, `--clear`, `--version`. `--dry-run` needs its own `--data`, spawns nothing real and records what it would run (`GET /api/dry-run`); `--projects` and `--desktop` are test-only. No mode: usage line, exit 2. Importing the module starts nothing.

**Who starts it.** `ensureDaemon` (`src/companion.ts`) runs when a pane is shown or on `/orbit`:

1. A live server of this mod's version or newer: nothing to do.
2. Otherwise, at most once a minute, `server.mjs --version`. An on-disk server older than the mod (or one that only prints its usage line) is never started: an older launcher ignores `--no-window` and would open a window. The pane says so.
3. Else `server.mjs --launch --no-window`. A failure shows on the pane's Diagnostics.

**What `--launch` does** (`launchDecision`):

| Running server | Action |
|---|---|
| none | start `--serve` (`--daemon` without a window, `--open` with one) |
| older than the launcher | shut it down and start; a window opens when asked or when the old one had one connected |
| same or newer | reuse; ask it for a window (`POST /api/window`) when asked |

Every launch runs the on-disk launcher (each session's plugin root is the live folder), and a newer server is never replaced, so versions do not flip-flop.

**Running.** It listens on 127.0.0.1:47821 (a random port when taken, always for `--dry-run`) so the page keeps one origin, and rewrites `companion.json` every 10 s.

**Idle exit** (`shouldIdleExit`): no window connected, none for 30 minutes, and no snapshot change (`seq`) for 30 minutes, counted from start when it has seen neither. A live session's idle heartbeat changes its record's `heartbeatAt`, which is in the snapshot, so in practice a daemon stays up while any session publishes (read from the code, not measured).

**Children.** Every process the server starts (a server, Edge, `Claude.exe`, git, gh, Windows Terminal) gets only the launch allow-list environment (`launchEnv`): system and profile paths, temp, processor facts, `CLAUDE_CODE_PLUGIN_DIRS`; no `CLAUDE_*` host variables, `ANTHROPIC_*`, `NODE_OPTIONS` or git variables.

**Pruning.** 60 s after start, then every 6 h: records older than 7 days, `actions/` older than 1 h. Every minute: inbox leftovers and approval files. **Clearing.** `POST /api/clear` (window required) empties `sessions/`, `inbox/`, `approvals/`, `actions/`, removes both snapshot files and `leader.json`, resets prefs with `clearedAt`, and keeps running. `--clear` stops the server first and also removes `companion.json`, the log and the Edge profile. Pruning and clearing remove only plain files and folders inside the data folder: a symlink or junction is left in place and logged once.

### Aggregation

`companion/lib/aggregator.mjs` runs `shared/aggregate/aggregate.js` (plain JS with JSDoc) through a Node `$.fs` adapter (`companion/lib/host.mjs`, which also refuses files over 4 MiB).

| Input | How it is read |
|---|---|
| Publisher records | Newest `2 × sessions kept`, up to 7 days old; re-read only when changed. |
| Desktop records | Newest first; the newest `sessions kept` plus pinned ones parsed, only when the mtime moved (cache: E-118). `waiting-input\` marks sessions waiting on the person. |
| Transcripts | Only to see whether a desktop-only session wrote past its last turn edge (a turn its record cannot show). Listings kept 45 s (E-108). |
| Sub-agent metadata | `.meta.json` (type, description, model, `finished`), at most every 20 s per session. A sub-agent transcript is read once for its last entry, then only growth counts, because a resume rewrites them all. |
| Git branch | `HEAD`, no git process; kept 60 s (E-109). |
| Prefs, markers, edit roots | Settings, pinned, overrides and marks; wait markers from the request store; edit counts for projects. |

**When it runs.** `fs.watch` on `sessions/` and (recursively) the desktop records folder; a change runs it 300 ms later. Also every 15 s, on a prefs change, on a request-store change and when edit roots move. Runs never overlap; one asked for during a run follows it. With `settings.paused` a run stops after reading prefs.

**What it writes.** `toV2` adds a `status` per session and agent; `budgetSnapshot` keeps the result under 3.5 MiB (finished sub-agents oldest first, then the oldest sessions that do not need the person; `sources.budget` says what went). The snapshot is written only when its signature changed (all but `generatedAt`, `seq`, `timings`, `sources.watch`); each write increments `seq`. `checkedAt` moves on every run. Errors are short fixed phrases, never paths or text.

**Schema 2** (type in the contract) adds `generator: 'orbit-server'`, `serverVersion`, `seq`, `bootId`, a `status` on every session and agent (interface code reads it; `lifecycle`, `phase`, `attention` stay for Diagnostics), the desktop facts and `projectSource`, and `sources.watch`, `budget` and `desktop.skipped`. It has no `graph`: readers lay it out. Timelines keep 12 entries.

### Lifecycle

`lifecycleOf` (`shared/aggregate/infer.js`), first match wins:

| Lifecycle | Evidence |
|---|---|
| waiting for permission / for you; disconnected | the publisher's live wait (observed); its heartbeat over 90 s old (inferred) |
| waiting for you | the desktop's `waiting-input` marker or "interrupted, awaiting person" (observed); a marker written no later than 5 s after the open turn's typed prompt is the start-up marker of a new or woken session, as is any marker on a session with no recorded prompt and no finished turn (a brand-new session's marker lands before its prompt time); so is a marker while the live mod has not yet seen the typed turn, or one written no later than 5 s after the mod's running turn began (a slow start or wake writes it late); a start-up marker reads as running |
| running; stale or disconnected | live turn with a heartbeat under 90 s (observed); silent past 90 s or the stale threshold (inferred) |
| disconnected | the session ended mid-turn (observed) |
| running; stale | desktop open turn inside the stale threshold (observed; inferred from transcript writes); silent past it (inferred) |
| failed / interrupted | last turn ended with `error` or `refusal` / `aborted` (observed) |
| idle with needs you, blocked or ready for review; completed | the app's post-turn summary (inferred) |
| idle; unknown | no open turn; no source |

A sub-agent the engine lists as `waiting` (its turn ended while background work it owns is still out, so it will be woken again) counts as running; the mod keeps re-reading the engine's agent list while any agent is pending, running or waiting, and for a minute after one ends, so a turn end that looks final at that instant is corrected. Then `withRunningAgents` turns an idle, completed, unknown or stale session with a running sub-agent into running ("N sub-agents running"). A record that declares `idleBeatMs` and is silent for `2 × idleBeatMs + 30 s` counts as ended. Silence never becomes "completed". Phase comes from the tool calls of the last 10 minutes, always inferred, and is kept for Diagnostics only.

**Maybe stuck** (`stuckOf`): only while running and only when the latest main-agent call failed, ignoring polling tools. `repeat`: the same tool and target 3 times in a row within 10 minutes, 2 failed. `errors`: 4 of the last 6 calls failed. A hint, never a status; tuned with `tools/stuck-replay.mjs` to flag under 1% of turns.

### Status: five buckets

`statusOf` (`shared/aggregate/status.js`), first match wins:

| Bucket | When | Reason (examples) |
|---|---|---|
| `needs-you` | a wait marker from the approval hook; or attention `question`, `permission`, `needs-you`, `blocked` | "Approve Bash?", "Asked you a question", the attention text |
| `failed` | lifecycle `failed`; or the desktop's failure mark is newer than the last turn edge | `failureText(category)`, e.g. "Claude could not start: disk full" |
| `working` | lifecycle `running`, or `stale` | the activity line; "No activity for 12m · may be stuck" |
| `review` | the app's summary says ready for review, or the last turn finished after `lastFocusedAt` | "Finished, not opened since" |
| `idle` | everything else, including `disconnected` and `interrupted` | "Stopped reporting", "Interrupted", "Idle" |

Reasons are one plain line of at most 120 characters; `isObserved` is true only for observed events. Agents: running → working, failed → failed, else idle. `normalizeSnapshot` fills a missing `status` with the same rules and reads an unknown bucket as idle.

**Desktop-record facts** (`null` for terminal sessions and records without the key; the key names are the desktop app's and undocumented):

| Field | Source | Notes |
|---|---|---|
| `lastFocusedAt` | `lastFocusedAt` | Drives `review` and unread. |
| `parent` | `spawnedFrom.sessionId` (`hand-off`, `fork`, `side-session`, `spawn`), else `forkedFromSessionId` | Another `local_` key; may be absent from the snapshot. |
| `lastReport` | `lastTurnReport`, else `turnWrapUp.description`; `turnWrapUp.needsUser` becomes `ask` | Invisible characters stripped; `text` ≤ 400, `ask` ≤ 200; never logged. |
| `failure` | newest of `errorCategory`/`errorAt`, the last `queryCrashes` entry, `priorErrorMark` | Category only, never the message; `isCurrent` when newer than the last turn edge. |

**Done and Snooze** (`withPersonMarks`). Prefs hold `done: { key: atMs }` and `snoozed: { key: { until, at } }`, at most 500 each, set or cleared per key through `POST /api/prefs`.

- Done: while the session has not changed since the mark (its `stateSince`, `finishedAt` and any need's `since` are at or before it; heartbeats do not count), the status is idle "Done", `isDone: true`.
- Snooze: until `until`, a needs-you, review or failed session reads idle "Snoozed"; a working or idle one keeps its bucket with `snoozedUntil`. A need that began after the snooze was set comes through at once.
- A prefs change re-runs the aggregator, so a mark shows within a second.

### Projects

`attributeProject` (G-17), first match wins:

1. `prefs.projectOverrides[sessionKey]` (`override`).
2. The checkout most of the session's edited files land in (nearest folder with `.git`, from the transcript edit index Changes uses), unless it is the start repository or a weak place: the profile itself, `~\.claude`, `AppData\Local\Programs`, `AppData\Roaming\Claude`, Program Files, ProgramData, Windows, a drive root (`edits`). Ties go to the start folder, then by name.
3. The start folder (`folder`): the desktop's `gitAnchors.commonDir`, else the repository root, else the folder, with `.claude\worktrees\<name>` folded in.

Edit counts are refreshed 1.5 s after start and every 30 s, within 400 ms a pass; a change re-aggregates. No path is logged. Remotes come from the session's own `origin` without credentials; PR links come from the desktop record and must pass `isPrUrl`.

## Sync and latency

- **Pane:** stats `snapshot-v2.json` every second while drawn (30 s otherwise) and reads it only when the mtime moved.
- **Page:** `GET /api/events` sends `hello` (stamps and a `windowId`), then `changed` (stamps) when one moves, and `: ping` every 25 s. Stamps are compared every 5 s and after each aggregator run; `checkedAt` moves every run, so `changed` arrives about every 15 s even without new content.
- **Stamps:** `{ snapshot: seq, seq, bootId, checkedAt, prefs: <mtime>, prs, approvals, arm, alerts }`, taken before the read, so never newer than the content. A new `bootId` means the server restarted. Stale is `now − checkedAt > 2 min`; "not live" comes from `/api/health` (`isWatching === false`, `isPaused`, `errors`).
- **Followed transcript (E-110):** `POST /api/attention { windowId, selected }` names the session a window has open. The server watches that one transcript (one watch per window) and sends that window `event: conversation { key }` about 150 ms after a write.
- **Latency (G-34):** `health.latency.eventToSnapshotMs` times a watch event to the `seq` it produced; `eventToPaintMs` to the first paint report of that `seq` or later (`POST /api/stats { painted: { seq, bootId, at } }`). Last 50 samples, `{ samples, last, p50, p95, max }`; changes found only by the 15 s timer are not timed. The smoke test measured about 0.3 s and 0.35 s.
- **Preferences:** panes write read-modify-write, never over a file they cannot parse; the server merges `POST /api/prefs` patches through `sanitizePrefs`, writes atomically, and re-aggregates about 200 ms after any change.

## HTTP surface

127.0.0.1 only. Every request passes the Host check (421) and the Origin check (403). Bodies are JSON objects (400; 413 over 256 KiB). Answers carry `no-store`, `nosniff` and `no-referrer`; the two entry pages (`/`, `/inbox`) carry a `'self'`-only CSP with `base-uri 'none'`, `form-action 'none'` and `frame-ancestors 'none'` (`PAGE_CSP` in `companion/lib/secrets.mjs`), and static files come only from allow-lists. The route list is in the contract. The control token reaches only `GET /api/ping`, `POST /api/window`, `POST /api/shutdown`, `GET /api/arm`, `/api/hook/*` and `/api/mod/*`; every other `/api/*` route needs the page secret.

**No window, no acting.** While no window's stream is open, and none closed in the last 30 s, `POST` to `/api/reply`, `/api/reply/<id>/withdraw`, `/api/launch`, `/api/open`, `/api/new`, `/api/approvals/<id>`, `/api/approvals/enabled`, `/api/arm` and `/api/clear` answers `409 { reason: 'no-window' }`. It guards against acting with nobody looking; it is not access control (a token holder can open a stream).

## Remote control

Off unless armed (D-6). Three capabilities: `approvals`, `questions`, `replies`.

### Two secrets

The **control token** lives in `companion.json` and reaches only the control routes. The **page secret** lives in server memory and the window's cookie, never on disk (`--dry-run` alone also writes `pageToken`, for tests). `POST /api/window` issues a one-time launch code (60 s). Edge opens `/inbox?launch=<code>` (`/` redirects there with its query, so an older link still works); the server answers `303` to `/inbox` with `Set-Cookie: orbit=<page secret>; HttpOnly; SameSite=Strict; Path=/`, so a reload keeps the window. A code redeemed twice means something read Edge's command line first: the page secret rotates, every stream ends and a `link-reused` alert is raised. Page routes take the first valid of the `x-orbit-token` header, the `t` query (event stream and entry pages, read only by a `--dry-run` server, for tools and tests) and the cookie, compared in constant time. The secret is per process, so a restarted server locks old windows out.

### Arm switches

- All off by default; held in server memory and written by the server to `arm.json` with an HMAC keyed by `arm.key`.
- A file that fails the check, or `arm.json` missing beside an existing `arm.key`, arms nothing and raises a `tampered` alert.
- Migration, first start only (no `arm.key` yet): `approvals/enabled.json` with `enabled: true` arms approvals and questions (`source: 'migrated'`). A migration never turns anything off. Capabilities restored at a restart get an audit line.
- `GET /api/arm` → `{ approvals | questions | replies: { armed, at, source }, tampered, setup: { hookSeenAt, replySessions, olderSessions } }`. `POST /api/arm { capability, armed }` needs the page secret and a window. `POST /api/approvals/enabled { enabled }` is the old switch for approvals and questions together. The mod shows the armed list in the pane (`diag.armed`).

### Approvals and questions

```
Claude ── PermissionRequest ──▶ hooks/approve.mjs
  no live server ──▶ no output (Claude's own dialog)
  POST /api/hook/requests { request, nonce } ──▶ marker always; engaged? no ──▶ no output
     yes ──▶ hook long-polls GET /api/hook/requests/<id>?nonce=&waitMs= ◀── page answers via POST /api/approvals/<id>
          ──▶ allow / deny / question answers, or no output
```

**The hook** trusts no file but `companion.json` (port and token). With no live server it drains stdin within 100 ms and prints nothing. A person-only tool (ExitPlanMode, EnterPlanMode, `mcp__ccd_*`) or input Orbit cannot show goes only as a marker; anything else as a request (input cut at 16 KiB with `truncated: true`, questions whole up to 192 KiB; SHA-256 input hash; its pid; 60 s life) with a nonce only the hook keeps. The server refuses a request that is malformed, altered, not made within 5 s of now, longer than 60 s, from a dead process or already known, and answers 429 past 20 open per session or 100 in all.

**Engage rule:** the capability is armed (`questions` for `AskUserQuestion`, `approvals` otherwise); a window with an open stream posted `attentive` within 60 s while focused, 8 s when not focused, 25 s when it did not say (`POST /api/attention { attentive, focused, windowId }`); and the session is in the server's snapshot.

**Markers (E-06).** Every accepted registration, engaged or not, leaves a text-free marker (session, tool, time). The session is `needs-you` until its activity moves more than 2 s past it; markers expire after 30 minutes. So a prompt shows as Needs you even when Orbit does not engage, as long as a server runs.

**Answers.** `GET /api/approvals` lists open, engaged requests from memory. `POST /api/approvals/<id>` is checked by `checkAnswerPost` (tools: `allow`, `deny`, `ask` with the input hash; questions: offered labels or a clean Other text, notes, or `ask`); one answer per request, never from the control token. The hook re-checks the answer against its own request (`hookDecision`) and prints `{"behavior":"allow"}` (never `updatedInput` or `updatedPermissions`; an allow of cut input becomes ask), `{"behavior":"deny","message":"Denied from Orbit."}`, or for a question allow with `updatedInput` = the input plus `answers` (and `annotations` for notes). Ask, expiry, window gone, a signal or any error: no output, so Claude's own dialog or card answers.

**Lifetime.** A request ends when the hook takes the answer, at expiry (60 s), when no window stream has been open for 5 s (`window-gone`), or when the hook ends it. Long polls answer in chunks of at most 20 s. `POST /api/approvals/<id>/typing` keeps a question open another minute, never past 110 s after it was asked (E-23; below the hook's 120 s timeout); the hook adopts the new deadline.

**Install.** A user-level `PermissionRequest` command hook, matcher `*`, running `node <live copy>\hooks\approve.mjs`, set up by hand outside this repository; Orbit never writes settings. A missing or failing script is a non-blocking hook error. The hook timeout in settings must outlast the longest wait; the earlier install used 120 s (not re-checked).

### Replies

A reply from the page reaches a session as the person's own words, through that session's own mod (`$.prompt.submit({ text, asUser: true })`: at once when idle, as the next turn when busy).

```
page ── POST /api/reply { sessionKey, text } ──▶ server memory queue
mod ── GET /api/mod/replies/<cli id> (every 2 s) ──▶ { armed, replies }
    judgeReply ── remember id ── POST …/<id>/claim ── submit ── POST …/<id>/ack
page ◀── GET /api/reply/<id>: pending, then sent | queued | refused | failed
```

- **Refused before queueing:** bad text (`checkReplyText`: 1 to 4,000 characters; no leading `/`, `!`, `#` or slash look-alike), a key not in the snapshot, no plain CLI id, a record without `replyProtocol: 2` (`409 { older: true }`), not armed (`409 { reason: 'not-armed' }`), no window.
- **Queue:** at most 200 entries, each handed out for 60 s; nothing touches `inbox/` but the mod's `seen.json`.
- **Mod:** delivers only what the server hands it, and nothing while `armed` is false (a launch's first prompt included). `judgeReply` checks schema, its own CLI id, age (≤ 60 s, ≤ 5 s ahead), an unseen id and the text; then it remembers the id, claims (first claim wins: `withdrawn`, `replay`, `unknown` otherwise), submits, waits at most 1 s, and acknowledges `sent`, `queued` or `failed`. Refusals are acknowledged too; only counts reach the record.
- **Withdraw:** unclaimed → `withdrawn`; claimed → the server waits up to 5 s for the acknowledgement (delivery reported as such, refusal as `withdrawn`, nothing as `unknown`).
- `GET /api/reply/<id>` returns the final answer once. The server logs ids and outcomes, never text.

### Forged files, alerts and audit

- Every 2 s, and at once on an `inbox/` change, the server deletes approval request, answer and done files and inbox reply requests (it writes none) and raises an alert; a tampered `arm.json` and a reused launch code raise alerts too.
- `GET /api/alerts`: newest first, `{ kind: 'forged-file' | 'tampered', where, what, at }`, last 50; folder and kind only. `health.alerts`, `stamps.alerts`.
- `audit.jsonl`: `arm`, `approval`, `question` (id, session, tool, input hash, outcome), `reply`, `alert`; allow-listed short fields, never text. `GET /api/audit?limit=` (≤ 500, newest first).

### Residual risks

Accepted, because the attacker is the same Windows user, who could already start `claude`:

- A reader of `companion.json` holds the control token: it can read pending reply text for any session, claim and acknowledge replies to suppress them, register hook requests (they show as cards; the person decides) and read the arm state.
- With code execution it can stand up its own listener and rewrite `companion.json`, which the hook, mods and launcher trust for the port and token; a version claimed newer also stops mods from starting a server.
- The page cookie is sent to every port on 127.0.0.1 within Orbit's own Edge profile.
- `arm.key` sits beside `arm.json`.
- Mods from before replies moved to the server still read inbox files until their sessions end; the server deletes forged ones within 2 s, so a race remains.
- Recommended, not applied: deny rules for Claude's file tools on `~/.claude/orbit/**` and `~/.claude/mods/**`.

## Notifications

The server raises notices from its own snapshot (`companion/lib/notices.mjs`):

- **Raised:** a session entering `needs-you` or `failed` (mode `needs-you`, the default), plus `review` (mode `all`); once per need (session, bucket, status `since`). Done and snoozed sessions are already out of those buckets.
- **Not raised:** on the first look after a start; for a need that began over 5 minutes before the server saw it; in mode `off`. At most one per session a minute; a need inside that minute is dropped, not delayed. A need raised while a window is attentive is *quiet*: only a window may show it, as a banner.
- **Text:** `Needs you · <title>` (or `Failed`, `Ready for review`), body the status reason; never logged.
- **Window first:** the server pushes each notice to every open window (`event: notice` on `/api/events`). The first window to claim it (`POST /api/notices/<id>/claim { windowId }`) shows it (`companion/inbox/notify.js`): a silent Windows notification (the Web Notification API, once allowed in Settings) while nobody is looking at that window, otherwise a banner at the stage's top-right; a soft two-note chime plays for Needs you unless that window's chime is off. It then acks with `{ windowId, shownAs: 'system' | 'banner' }`.
- **Mod fallback:** held 2 minutes (at most 50). With no window open, or after a window has left a notice unclaimed for 5 s (`WINDOW_FIRST_MS`), each mod's 2 s poll takes up to 3 (`GET /api/mod/notices`; quiet ones never), claims each (first claim wins), raises it with `$.ui.notify(body, { title, key: id })` on the person's own channel, and reports `POST /api/mod/notices/<id>/ack { cli, isSent, reason }`. Desktop sessions answer `no-surface`, so in practice the window is what shows them.
- **Mute and health:** `GET`/`POST /api/notify { mode: 'all' | 'needs-you' | 'off' }` (page secret, kept in `notify.json`); `health.notices { mode, raised, claimed, quiet, lastDelivery }`, `lastDelivery.shownAs` naming a window's surface, with a failure reason of `disabled`, `no-channel`, `no-surface`, `refused` or `threw`.

The server cannot show a notification itself (no PowerShell toasts or new Edge processes, on purpose); an open Orbit window can.

## Session manager

**Conversation** (`GET /api/conversation?key=`). The server finds the session in its in-memory snapshot and its CLI id (`transcriptName`; unknown key or a non-plain id → 404), then looks for exactly `<cliSessionId>.jsonl` in each folder of `~\.claude\projects`; no path comes from the request. Misses are cached 5 s (`retry=1` skips that). It opens the file and reads byte ranges (`readConversation`): the tail (512 KiB, doubling to 4 MiB while there are under 12 turns and 30 rows), `before=<offset>&fid=` (older rows, read backwards the same way) or `from=<offset>&fid=` (every row to the end; over 4 MiB back answers the tail with `reset: true`). Rows are ≤ 8,000 characters; a cursor for another file or past the end answers 409 `{ reset: true }`. `conversationRows` keeps only `user` and `assistant` lines, drops sidechain and meta lines and known wrapper tags, folds tool calls into one redacted `tools` row, and drops results, thinking and images.

**Privacy.** This is the only place Orbit shows prompt and reply text: locally, on request, behind the page secret. The server stores and logs none of it. The page's chat (live window, paging, drafts, composer) is the interface's; it fetches `from=` when a `conversation` event names its open session.

The engine also provides `prefs.hidden` (≤ 200, cleaned by the server), `pinned` (≤ 200; kept past the sessions-kept cap), `lastFocusedAt` for unread, and the shared rules in `shared/filters.js` and `shared/popout.js` (`visibleOf`, `rankSessions`, `isHiddenNow`, `checkoutPeers`). How the page lays these out is the interface's.

## Review

All read-only. Maybe stuck is under Lifecycle.

**Changes** (`GET /api/changes?key=`) uses the session's `cwd` from the snapshot, which must pass `normalizeFolder` (absolute, local, no UNC) and exist.

- Cache 45 s while the session has not been active since; `fresh=1` skips it; a timed-out repository is left alone 2 minutes.
- Git (`%ProgramFiles%\Git\cmd\git.exe`, else `where.exe` outside every session folder): argv array, no shell, 2 at a time, tree killed after 4 s, optional locks, fsmonitor, prompts, pager and lazy fetch off. The `.git` pointer, `commondir` and `alternates` are read as files first; a non-local path gives `network` and no git process.
- Four git processes per refresh: `rev-parse`, `config --get-regexp ^filter\.` (repository-local filter drivers are then disabled), `status --porcelain=v2 -z --branch`, `diff --numstat` against `HEAD` or the empty tree.
- Guaranteed: no network command, index or ref write, hook, external diff, text conversion or local filter driver. Not guaranteed: an `include.path` or `core.worktree` on a network share is opened by git itself; global filter drivers (LFS) run as for any `git status`.
- Session edits: Edit, Write, MultiEdit and NotebookEdit calls from the transcript and its sub-agents, read incrementally (the last 64 MiB, 1.5 s per request); the answer says when the read is behind or cut. `state` is `ok`, `not-repo`, `unsafe`, `network`, `no-git`, `missing`, `timeout` or `error`.

**PR checks.**

- `gh` runs only while a window was attentive in the last minute and either `settings.showPRs` is on or a page asked `GET /api/prs?want=1` in the last 5 minutes.
- URLs from sessions active in the last 7 days, at most 30, each passing `isPrUrl`. Due: unknown now, open every 2 minutes, merged or closed hourly, unreadable every 10 minutes; two at a time; 10 s timeout. `gh` missing, signed out or rate limited: no calls for 10 minutes (`companion.json` `prChecks`).
- `GET /api/prs` → `{ statuses, unreadable, checks, version }` (`prSummary` with re-runs folded, plus `since`); `version` rides in the stamps. Readers apply marks and the per-viewer "PR problems need you" merge; PR problems never set a bucket in the snapshot. `--dry-run` reads `pr-fixtures.json` instead.

## Starting sessions

**Orbit's terminal launch.** The `claude://code/new` link cannot carry a model, effort or permission mode, so the server can start a session itself in Windows Terminal with the desktop-bundled CLI.

```
GET /api/folder?path= ──▶ { folder, real, launchable, digest }
POST /api/launch { folder, prompt, model, effort, mode, confirmBypass, digest } ──▶ re-check; digest differs → 409
  ──▶ wt.exe -w new --title "Orbit · <folder>" -d <real folder> -- <signed claude.exe> --session-id <uuid> [--model] [--effort] [--permission-mode]
  ──▶ first prompt in memory ── record with replyProtocol 2 appears ──▶ reply queue (firstPrompt) ──▶ GET /api/launch/<uuid>
```

- Models: Default, `LAUNCH_MODELS`, then ids seen in the snapshot matching `^claude-[a-z]+(-[0-9]+){1,3}$` (`GET /api/launch/options`); they reach only the `--model` value.
- One launch in flight and one per 3 s. `checkLaunch` checks the allow-lists (Bypass only with `confirmBypass`; `default` refused), the folder (`launchFolder`), the prompt (≤ 4,000 characters, no leading `/`, `!`, `#`) and the digest.
- `wt.exe` is the App Execution Alias in `WindowsApps`; `claude.exe` is the newest bundled version with a valid Authenticode signature from `O="Anthropic, PBC"`, else 502. Argv array, no shell, allow-list environment, the prompt never on a command line.
- The first prompt waits in memory until the new session's record reports `replyProtocol: 2`, then enters the reply queue as a first prompt (delivered only while replies are armed; a launch with a first prompt or Bypass permissions is refused while they are off). Not reported within 3 minutes, or an older mod: dropped. A restart loses it.
- Orbit never trusts a folder and never writes `~/.claude.json`.

Launching is a local-execution route: the page secret can start a session, Bypass included, in a folder Orbit accepts; the CLI still drops bypass unless consented to before, and Claude's trust prompt still applies.

**The desktop's link.** `claude://code/new?folder=<path>&q=<prompt>` (built by `shared/links.js`) opens Claude's new-session page with the composer prefilled; nothing is sent. The pane runs `Claude.exe <link>`; the page asks `POST /api/new`, which does the same.

## Navigation

`claude://claude.ai/epitaxy/<local id>` switches the desktop app to that session. The pane runs it directly; the page asks `POST /api/open { localId }`, and repeats within 2 s start one `Claude.exe`. When the server cannot find the handler, it hands the link back and the window opens it (Edge may ask once to allow Claude). Terminal and IDE sessions have no such link and are view-only. Sub-agents of the current session open with `$.ui.view({ agentId })`; others go through their parent.

## Look

- One colour source: `PALETTE` in `shared/constants.js`, injected into both entry pages as CSS variables and read directly by the SVG renderer; the pane uses desktop theme names so it follows a light or dark app theme.
- Positions depend on identity and age, never on status; there is no physics.
- The pane's graph never animates and is capped at 131,072 SVG characters, past which it points to the pop-out.
- How the page draws the map and lists is the interface's (`companion/inbox/`); it lays out the same graph through `withLayout` (`shared/popout.js`), as the pane does through `withGraph`.

## Performance

- **Size budget:** the server keeps the snapshot under 3.5 MiB; sessions that need the person are never cut.
- **Staggered caches:** one stale transcript listing and 3 stale branches per run (E-108, E-109); sub-agents at most every 20 s; attribution 400 ms per 30 s pass.
- **Desktop cache:** records average about 70 KB; only the fields Orbit reads and the last crash are kept (E-118).
- **On demand only:** git for Changes (45 s cache, 4 processes), `gh` for an attentive window.
- **Mods:** no aggregation; a drawn pane stats one file a second; no polling without a live server.
- **Disk:** records pruned after 7 days (every 6 h); inbox and approval leftovers every minute.

Measured before the switch on real data: 0.3 to 1.4 s per aggregation; the server at rest about 0.2% of one core and 55 MB. `health.aggregator.lastMs` shows the current cost.

## Diagnosing

- `GET /api/health` (shape in the contract): aggregator state and phases, sources, windows, `daemon`, latency, arm, alerts, notices; no paths or text.
- `companion.log`: starts, stops, watch failures ("polling only"), ids and outcomes; errors as name plus first own frame (`errorWhere`), never the message.
- `audit.jsonl` and `GET /api/alerts` for remote-control decisions and refused files.
- The pane's Diagnostics: role (`reader` or `idle`), tick phases (`prefs`, `server`, `read`), `diag.notice`, the armed list, reply counts.

## Mixed versions and releases

Desktop sessions do not hot-reload a mod; each keeps its loaded code until it ends. But every session's plugin root is the live folder, so any server a session starts runs the on-disk code.

- **Pre-daemon sessions** elect a leader among themselves and write `snapshot.json` and `leader.json` while one has its pane shown; their panes read only that. The server never reads those files and reads their records as usual.
- **Mods without `replyProtocol: 2`** cannot take replies (`409 { older: true }`); a first prompt for one is dropped. They poll inbox files, which the server no longer writes.
- **Records without `idleBeatMs`** keep the old liveness rule (never ended by idle silence).
- **A running server older than the mod** counts as none: `--launch --no-window` replaces it. **A newer one** is left alone; a schema the mod does not know keeps its last snapshot with a notice.
- **A page** is always served by the server it talks to. A new `bootId` or a 403 means "Orbit restarted"; an unknown schema shows the page's reload banner.

**Release** (`tools/refresh-live.ps1`): runs the gate, keeps the previous live copy, mirrors `git archive HEAD` (never untracked files or `.git`) into the live folder and validates it. New sessions load it; the next launch replaces an older running server once.

**Rollback** (`refresh-live.ps1 -Rollback`) restores the previous copy. Sessions on the newer mod find an older server on disk, never start it, say so in the pane, and keep their last snapshot until they end. New sessions start on the old code; an older launcher replaces any server of a different version, so the daemon stops at the next Pop out from old code. `snapshot-v2.json` stays on disk, unused, until Clear.

## Version requirements

- Claude Code: mod API facts verified on the bundled CLI 2.1.317; older CLIs load the mod and skip hooks they lack.
- Node.js 22 or later for the server and hook (they import the shared ES modules).
- Undocumented inputs that can change with app updates: the desktop session JSON and its key names, `waiting-input`, the sub-agent `.meta.json` sidecars, the `claude://…/epitaxy/` link. Each is parsed defensively; `sources` reports whether it is readable.

## Known limitations

- **Notifications need an Orbit window or a terminal session:** the server cannot show one itself, and desktop sessions' `$.ui.notify` has no surface; with no window open, only a terminal session's mod can raise them.
- **Approvals and questions need a running server.** With none, the hook prints nothing and Orbit sees no permission prompt (the mod's own observer is pre-empted), so the session can show as running or idle. What `waiting-input` holds during a real permission prompt is unrecorded.
- **Long questions versus the hook timeout:** typing keeps a question open at most 110 s from when it was asked (`QUESTION_WAIT_MAX_MS` in `shared/approvals.js`), below the installed hook's 120 s timeout. Longer drafts need a higher hook timeout in your Claude settings and a matching constant.
- **The daemon rarely idles out while sessions run,** because idle heartbeats change the snapshot.
- **Control-token residuals and the cookie scope** (see Residual risks).
- **Pre-daemon sessions' panes** show their own leader's snapshot (no status, desktop facts or marks) until they end.
- The pane's graph takes no clicks or drags; pick with Inspect, or use the pop-out.
- Sessions not running the mod show no live phase, context or tool activity.
- The new-session prompt travels on Claude.exe's command line (inherent to the link).
- Positions are computed for every session, so a narrow time window can leave gaps.
- Cloud, SSH and Cowork sessions are not shown. Windows only (paths, `Claude.exe` lookup, Windows Terminal, Edge).

## Tests

The gate is `tools/refresh-live.ps1` (`-CheckOnly` runs it without mirroring; a dirty tree is refused unless `-AllowDirty`). It stops at the first failing step, prints its output and mirrors nothing:

| Step | Command | Size now |
|---|---|---|
| Validate | `claude plugin validate .` (newest bundled CLI) | |
| Kit | `claude plugin test .` | 292 tests in 32 files |
| Server unit tests | `node --test "tests/server/*.test.mjs"` | 61 tests |
| Smoke | `node companion/smoke-test.mjs` | one end-to-end run |
| Hook check | `node tools/approve-hook-check.mjs` | the hook against a dry-run server |
| Type-check | `node tools/typecheck.mjs` | 0 errors |
| Syntax | `node --check` on every page, shared, server, hook and tool module | |

- **Kit:** aggregation, lifecycle and status rules, desktop facts, redaction, publisher timing, the hot path, daemon start rules, the pane reading `snapshot-v2.json`, replies and notices through a mocked server, filters, layout, launch, approvals, Changes, PRs, chat parsing, a render bench.
- **Server unit tests:** the `companion/lib` modules (all but `host.mjs`), Done and Snooze, attribution, argument parsing, atom shapes, the hook's data folder, and a guard against raw invisible characters in source.
- **Smoke:** a dry-run server with seeded records, end to end: secrets, schema 2 and stamps, a change reaching a window, latency, no-window 409s, daemon version rules, arming, hook long poll, forged files, audit, replies, notices, marks, attribution, Clear, conversation, Changes (hostile filter driver, git process count), PRs, launches, and a log free of text and paths.
- **Hook check:** no server, nothing armed (2 MB of stdin drained), a written `enabled.json` arming nothing, not attentive, bad input, unknown session, allow, deny, ask, wrong hash, a forged answer file never read, expiry, cut input, window gone, and questions including the typing extension. Timing is reported, not checked.
- Outside the gate: `tools/e2e-replies.mjs` (starts a real `claude.exe -p`) and `tools/stuck-replay.mjs`.

Not verified by any automated test: the installed hook in a real desktop session, real Edge cookies and reloads, replies into a real session, a real rollback, real desktop records in the server, recursive `fs.watch` on the real desktop folder, and the 6 h prune timer.
