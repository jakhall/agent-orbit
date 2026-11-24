# Orbit contract

The current interfaces between the engine (server, mod, hook) and the page and pane. Shared files change only through this document: `shared/filters.js`, `shared/constants.js`, `types/index.d.ts`.

Every `/api/*` route passes the Host and Origin checks and needs a secret: the page secret (the `orbit` cookie, or `x-orbit-token` from tools) for page routes, the control token from `companion.json` for the control routes listed under "Remote control". Bodies are JSON objects: anything else answers `400 { error }`, a body over the size limit `413 { error }`.

## Files on disk (`%USERPROFILE%\.claude\orbit`)

| File | Writer | Readers |
|---|---|---|
| `sessions/<cli id>.json` | each session's mod (its own record) | the server's aggregator |
| `snapshot-v2.json` | the server, on every change (schema 2, below) | panes; the page gets the same object from `/api/state` |
| `prefs.json` | the server (`POST /api/prefs`) and the mod (`savePrefs`), both through `sanitizePrefs` | server, mod, page |
| `companion.json` | the server's heartbeat (port, pid, control token, version, windows, `attentiveAt`) | launcher, mods, hook |
| `arm.json`, `arm.key` | the server only | the server at start |
| `audit.jsonl`, `notify.json`, `hook.json`, `companion.log` | the server | the server (and people) |
| `inbox/<cli id>/seen.json` | that session's mod (consumed reply ids) | that mod |
| `snapshot.json`, `leader.json`, `approvals/enabled.json` | only pre-daemon sessions and the old Approve from Orbit switch | the server reads `enabled.json` once, for the arm migration |

### Session record (`sessions/<cli id>.json`, schema 1, all additions optional)

- `idleBeatMs?: number` (120000): the record is rewritten at least this often while idle. A record that declares it, has no `endedAt` and a `heartbeatAt` older than `2 × idleBeatMs + 30 s` counts as ended. A `waiting` record whose `heartbeatAt` is more than 90 s old reads as `disconnected` ("was waiting for permission|an answer, then stopped reporting").
- `tools[].pending?: true` while a call runs; "Maybe stuck" ignores pending calls.
- `replyProtocol?: 2`: the mod takes replies from the server over HTTP (Remote control, below).
- `errors?: { count, lastAt, where, kind }` (E-29): this session's mod failures, never cleared on success; `where` is one of `tick`, `publish`, `inbox`, `notice`, `hook`, `render`, `daemon`; `kind` is the error's name or code (a plain identifier, else `Error`), never its message. It reaches the snapshot as `publisher.errors` and the pane as `diag.errors`. B: Diagnostics shows "N errors, last <ago> in <where> (<kind>)" for this session (`diag.errors`), and the page's session detail the same from `publisher.errors`.
- A record without a `turn` object reads as idle. Records are re-redacted on read (`cleanRecord`): command targets reduced to their program, credentials out of the remote, free text capped.

### Preferences (`prefs.json`)

- `sanitizePrefs(raw)` in `shared/prefs.js` gives every field its type and drops unknown keys; the server runs it before every write and the page and pane after every read. `POST /api/prefs` answers `{ ok: true, prefs }`.
- Map fields set and cleared per key (`{ key: value | null }`): `positions`, `hidden`, `projectOverrides` (G-17), `done` and `snoozed` (C6), `titles` and `tints` (2.2.16), `projectTints` (2.2.18). Lists: `collapsed`, `pinned`. One-shot flags: `resetLayout` clears `positions` and `collapsed`; `resetPositions` (2.2.22) clears `positions` alone. Settings: `refreshSec`, `maxSessions`, `staleMin`, `paused` (the server stops aggregating while set) and the rest of `Settings`.
- A file that does not parse keeps the reader's current prefs; once it has been broken for 10 s it is copied to `prefs.json.bad` and rewritten.

## Removed and renamed

- Notes (`POST /api/send`, `GET /api/send/<id>`, `actions/`): gone; replies are the one message route. Trust from Orbit: gone; Orbit never writes `~/.claude.json`, `GET /api/folder` answers `{ folder, real, launchable, digest }`, `POST /api/launch` ignores `trust`.
- The leader: no lease, no `leader.json`, no mod-written `snapshot.json`, no `leader` stamp, no `snapshot` state atom, no `Diag` lease phase; `agents[].isOwnSession` is no longer written.
- Schema 1 in `/api/state` and `SNAPSHOT_SCHEMAS = [1]`: replaced by schema 2. The snapshot has no `graph`, `modVersion` or `timings.layoutMs`; readers lay out the graph (`withGraph` in `shared/view.js`, `layoutGraph` in `shared/layout.js`).
- Inbox request and ack files, approval request, answer and done files: no longer written or read (the server deletes such files and raises an alert). `approvals/enabled.json` became the `approvals` and `questions` arm switches.
- The page token in the URL (`?t=`) and on disk: replaced by a one-time launch code and the `orbit` cookie; `companion.json` `token` is the control token.
- Agent Constellation (1.0): no legacy folder reads, no prefs migration, no `/sessions` alias, no `publishers.legacy` count.
- Version gates in `shared/approvals.js` (`isOrbitReady`, `canAnswerQuestions`, `isVersionAtLeast`): gone; the server decides engagement. `supportsReplies(modVersion)` gave way to `publisher.replyProtocol === 2`.
- `POST /api/stats` no longer reads `autoSimplified`.

## The snapshot (schema 2)

The server is the one aggregator. Each session's mod publishes its record; a session whose pane is shown (or that runs `/orbit`) starts the server with no window when none is live (`server.mjs --version` first, then `--launch --no-window`, at most once a minute, never an on-disk server older than itself). The server stays up while a window is connected or the snapshot changed in the last 30 minutes. Panes read `snapshot-v2.json`; the render hook lays out the graph for the reader's positions.

### `snapshot-v2.json` (`schema: 2`)

```ts
type SnapshotV2 = {
  schema: 2
  generator: 'orbit-server'
  serverVersion: string            // Orbit version of the server that wrote it
  generatedAt: number              // ms epoch
  seq: number                      // +1 per written snapshot; resets when the server restarts (with a new `bootId`)
  bootId: string                   // 16 hex chars, new per server process
  projects: ProjectView[]          // as schema 1
  worktrees: WorktreeView[]        // as schema 1
  sessions: SessionViewV2[]
  agents: AgentViewV2[]
  usage: UsageView | null          // as schema 1
  sources: SourceHealth            // as schema 1, plus `watch: { isWatching: boolean, lastEventAt: number | null }`
  timings: { aggregateMs: number; phases?: Record<string, number>; sessions: number; agents: number }
}
```

- `generator` is a constant. `sources.desktop.skipped` counts desktop records past the sessions-kept cap (E-18). Timelines carry the 12 newest entries (E-119). The server keeps the file under 3.5 MiB (`sources.budget` when it cut finished sub-agents or the oldest quiet sessions; sessions that need you are never cut).
- `SessionViewV2` keeps `lifecycle`, `phase`, `attention`, their evidence, `stuck` and `messageBlock` for Diagnostics; interface code reads `status`, the desktop-record fields, `projectSource` and `publisher` (with `replyProtocol`).
- `AgentViewV2` = schema 1's `AgentView` without `isOwnSession`, plus `status` (same shape as a session's).
- Readers tolerate unknown fields and unknown enum values (`normalizeSnapshot` maps an unknown `status.bucket` to `idle`, as A1 did for lifecycles).

### `status` (D-4): one of five buckets, with one reason line

```ts
type Status = {
  bucket: 'needs-you' | 'working' | 'review' | 'idle' | 'failed'
  reason: string          // one line, ≤ 120 chars, plain text (no markdown), e.g. "Asked you a question", "Running tests", "Finished 4m ago"
  since: number | null    // when this bucket began, ms epoch
  isObserved: boolean     // true only when the bucket comes from an observed event (mod events, desktop waiting-input); false when inferred
}
```

Rules, first match wins (the aggregator, from lifecycle, attention, Orbit's open requests and wait markers, and the desktop facts; then Done and Snooze):

| Bucket | When |
|---|---|
| `needs-you` | An open Orbit request or a wait marker the approval hook left for the session (reason "Approve Bash?" with the tool name, or "Asked you a question"; "N requests waiting" when more than one is open, `since` from the oldest), or `attention` is `question`, `permission`, `needs-you` or `blocked` (reason = `attentionText`). PR problems stay a per-window choice in the page and never set this bucket in the snapshot. |
| `failed` | `lifecycle` is `failed`, or `failure` (below) is current: a failure mark newer than the last turn edge. Reason names the category in plain words with `failureText(category)` from `shared/failure.js` (so page, pane and server say it the same way), e.g. "The model refused the last turn", "Claude could not start: disk full". |
| `working` | `lifecycle` is `running` (including "N sub-agents running"), or `stale` (reason "No activity for 12m · may be stuck", `isObserved: false`). |
| `review` | The desktop app's own summary says the session is ready for review (`attention: 'review'`), or the last turn finished after the person last looked: `finishedAt` (or the turn edge) is later than `lastFocusedAt`. Terminal sessions (no `lastFocusedAt`) use the page's own unread state instead and come as `idle`. |
| `idle` | Everything else: `idle`, `completed` and seen, `interrupted` ("Interrupted"), `disconnected` ("Stopped reporting"), `unknown`. |

- `since`, per bucket: `needs-you` = when the need began (`attentionSince`, or the pending approval's `createdAt`); `working` = `stateSince`; `review` = `finishedAt` (else the last turn edge); `failed` = `failure.at`, or `stateSince` for a failed lifecycle; `idle` = `stateSince`.
- `disconnected` is `idle` ("Stopped reporting").

### Done and Snooze (C6)

- Prefs: `done: Record<sessionKey, atMs>` and `snoozed: Record<sessionKey, { until, at }>` (both optional, at most 500 each, newest kept; times positive, `until > at`). `snoozed` carries `at` as well as `until`, because "a new need ends the snooze early" needs to know when the snooze was set. `POST /api/prefs { done: { key: atMs | null }, snoozed: { key: { until, at } | null } }` sets or clears one.
- `Status` gains `isDone: boolean` and `snoozedUntil: number | null` (always present from the server; `normalizeSnapshot` fills them for older snapshots).
- Done: while the session has not changed since the mark (its `stateSince`, `finishedAt` and any need's `since` are all at or before `done[key]`; heartbeats do not count), the status is `{ bucket: 'idle', reason: 'Done', since: doneAt, isObserved: false, isDone: true }`. A new turn, a finished turn or a new need brings the real status back.
- Snooze: until `until`, a session whose bucket would be `needs-you`, `review` or `failed` is `{ bucket: 'idle', reason: 'Snoozed', since: at, snoozedUntil: until }`; a working or idle one keeps its bucket and carries `snoozedUntil`. A need that began after `at` (a question, a permission prompt, an Orbit approval) comes through at once with `snoozedUntil: null`.
- The server re-aggregates on a prefs change, so a mark shows within a second.

### PR problems need you (opt-in, after C9)

- Setting: `prefs.settings.prProblemsNeedYou: boolean`, default `false`, shared by every window and the pane.
- While it is on, the server checks the PRs linked from sessions with `gh` at the usual pacing (open PRs every 2 minutes, merged or closed hourly, failed reads every 10 minutes, a signed-out or missing `gh` backs off), with or without a window: turning it on is the opt-in E-114 asks for. Off, `gh` runs as before (an attentive window that shows PRs, or a page's `want=1`).
- Each PR with failing checks or changes requested (open or draft) belongs to the newest session linking it. That session becomes `{ bucket: 'needs-you', reason: 'PR checks failing: <owner/repo>#<n>' | 'PR changes requested: <owner/repo>#<n>', since: <when the problem was first seen>, isObserved: true }` only while it is otherwise quiet: idle or ready for review, active in the last 24 hours, not hidden. A running, waiting, failed or already-needing session keeps its status; Done and Snooze apply as to any need.
- Off, or with no PR read yet, nothing changes.

### Desktop-record fields (D-3), on `SessionViewV2`

All are `null` for terminal sessions and for desktop records that lack the source key. Key names below are the desktop app's (undocumented; `sources.desktop` reports parse failures).

| Field | Type | Source in the desktop record | Notes |
|---|---|---|---|
| `lastFocusedAt` | `number \| null` | `lastFocusedAt` (present in 117 of the newest 120 records) | Drives `review` and unread. |
| `parent` | `{ key: string, kind: 'side-session' \| 'fork' \| 'hand-off' \| 'spawn' } \| null` | `spawnedFrom.sessionId` (kind from its flags: `handOff` → `hand-off`, `userFork` → `fork`, `sideSession` → `side-session`, else `spawn`); else `forkedFromSessionId` → `fork` | `key` is the parent's session key (`local_<id>`); the parent may be absent from the snapshot (archived, out of window). |
| `lastReport` | `{ text: string, needsUser: boolean, ask: string \| null, at: number \| null } \| null` | `lastTurnReport` (text), `turnWrapUp.description` when there is no report; `turnWrapUp.needsUser`, which the desktop writes as text (what the session asks of the person), becomes `ask` (≤ 200 characters) and `needsUser = ask !== null`; `at` is the last turn edge | `text` and `ask` with invisible characters stripped and whitespace folded; `text` ≤ 400 characters. |
| `failure` | `{ category: string, at: number, source: 'error' \| 'crash' \| 'mark', isCurrent: boolean } \| null` | Newest of `errorCategory`/`errorAt`, `queryCrashes[-1]` (`errorCategory`, `at`), `priorErrorMark` (`category`, `at`) | Category only (`disk_full`, `cli_fastfail`, `spawn_failed`, …): never the error message, which can hold paths. `isCurrent` when `at` is later than the last turn edge. |

- `lastReport.text` is in `snapshot-v2.json`, capped at 400 characters, invisible characters stripped, never logged (the same text already sits in the desktop's own record on the same disk).
- `remoteControl` (`boolean | null`): `remoteControlUserEnabled` when it is a boolean; else `false` when the record has `remoteControlAutoEligible` (the desktop writes `UserEnabled` only once it was switched on); else `null`. Drives the panel's Remote Control toggle, which is hidden while `null`.
- `titles` and `tints` (prefs, 2.2.16): `titles[sessionKey]` is a name the person gave the session in Orbit (one line, control characters and runs of spaces folded, at most 120 characters); `tints[sessionKey]` is its robot icon's colour, one of `blue`, `violet`, `pink`, `red`, `teal`, `lime`, `sand`, `slate` (no entry: the project's colour). `projectTints[projectId]` (2.2.18) is the default colour of a project's sessions, the same names except blue (the default, no entry). At most 500 of each. The aggregator applies them: `title` becomes the name and `renamedFrom` keeps the desktop's own title (absent when not renamed); a session's `tint` is its own entry, else its project's, else absent; a project's `tint` is its `projectTints` entry, absent for blue.
- `hasSuggestion` (`boolean`): the desktop record holds a `promptSuggestion` (the desktop's suggested next prompt, which it writes after a turn) while no turn runs (`latestUserFrameAt` ≤ `lastTurnEdgeAt`). The text never enters the aggregator's cache or the snapshot: the page reads it with `GET /api/suggestion?key=<sessionKey>` (page token; `{ text: string | null }`, 404 for a session not in the snapshot), which reads the record on request, and shows it dim in the empty composer, where Tab takes it.

### Project attribution (G-17)

- `SessionViewV2.projectSource: 'edits' | 'folder' | 'override'` says how `projectId` was decided, for the map's tooltip.
- Rules, first match wins: (1) `prefs.projectOverrides[sessionKey]` (a project id; `override`); (2) the repository most of the session's edited files land in (from the transcript edit index Changes uses; the nearest folder with `.git`; since 2.1 a linked worktree, whose `.git` file points into `<repository>\.git\worktrees\`, counts for its repository, so worktrees of one repository share one hub and the busiest checkout is the session's worktree; `projectSource` is unchanged), when it is not the start repository and not a weak place (the profile itself, `~/.claude`, `AppData\Local\Programs`, `AppData\Roaming\Claude`, Program Files, ProgramData, Windows, a drive root) (`edits`); a tie goes to the start folder, then by name; (3) the start folder as before (`folder`).
- The server refreshes the edit counts 1.5 s after start and every 30 s (400 ms budget a pass) and re-aggregates when one moved; it never logs a path.
- `prefs.projectOverrides: Record<sessionKey, projectId>` (optional; at most 500; keys ≤ 600 characters, values 1 to 400, trimmed). `POST /api/prefs { projectOverrides: { key: projectId | null } }` sets or removes one. B builds the override control later.

## HTTP routes

Page routes unless marked control. The remote-control and notification routes are listed in their own sections below.

| Route | Answer |
|---|---|
| `GET /inbox` | The entry page: `?launch=<one-time code>` answers `303` to `/inbox` with the `orbit` cookie; afterwards the cookie. `?t=<page secret>` also sets the cookie, on a `--dry-run` server only (tests and tools; the secret is on disk only there). A used code rotates the page secret (Remote control). Static modules: `/shared/<allow-listed>`, `/inbox/<name>` (`^[a-z0-9-]+\.(js\|css)$`). |
| `GET /` | Since C9 the old page is gone: `303` to `/inbox` with the same query (so an old `/?launch=` link is redeemed there), `no-store`, `no-referrer`. `/app.js`, `/app.css` and `/js/*` are not served. |
| `GET /api/ping` (control) | `{ ok, pid }` |
| `GET /api/health` | `{ ok, version, pid, bootId, startedAt, uptimeMs, aggregator: { seq, checkedAt, lastRunAt, lastMs, phases, isWatching, isPaused, lastEventAt, errors: string[] }, sources: SourceHealth, windows: number, attentiveAt: number, daemon: boolean, latency: { eventToSnapshotMs: Timing, eventToPaintMs: Timing }, arm, alerts: { count, latest }, notices }`. `errors` are short fixed phrases ("desktop records unreadable", "watch failed, polling"), never paths or text. `daemon` is true for a server started by `--launch --no-window`. `Timing = { samples, last, p50, p95, max }` in ms over the last 50 samples (`null`s with no samples): from a watch event to the snapshot `seq` it produced, and from that event to the first window's paint report of that `seq` or a later one (G-34). Changes found by the 15 s timer alone are not timed. |
| `GET /api/state[?parts=prefs]` | `{ snapshot: SnapshotV2 \| null, prefs, stamps }`; `snapshot` is `null` for `parts=prefs`. |
| `GET /api/events` | SSE: `hello` `{ ...stamps, windowId }`, then `changed` `{ ...stamps }` on any change, and at least every 30 s while the aggregator is watching (`checkedAt` moves); `: ping` every 25 s. |
| `POST /api/attention` | `{ attentive, windowId, focused?, selected? }` → `{ ok }`. One value per window, dropped when its stream closes; a body without a live `windowId` counts as one shared window. `focused` (E-116) sets how long the window counts as attentive. `selected` (E-110): the session key the window has open, or `null`; the server then watches that one transcript and sends `event: conversation` `{ key }` to that window when it is written (about 0.2 s). A `selected` that is not a string of 1 to 600 characters or `null` is `400`. |
| `POST /api/clear` (E-20) | Window required (409 `no-window` otherwise). Removes records, inbox, approvals and actions files and both snapshots, resets prefs (`clearedAt`), keeps the server running and its watches; answers `{ ok, removed: string[] }`. The `--clear` command still stops the server first. |
| `GET /api/conversation`, `GET /api/changes` | `retry=1` skips the 5 s transcript miss cache; `fresh=1` skips the 45 s Changes cache. |
| `GET /api/prs[?want=1]` | PR checks; `gh` runs only while a window was attentive in the last minute and `showPRs` is on or a page asked with `want=1` (kept 5 minutes). PR links pass `isPrUrl` (exactly `https://github.com/<owner>/<repo>/pull/<n>`). |
| `POST /api/open-url` | `{ url }`: a chat link, opened in the default browser through `rundll32 url.dll,FileProtocolHandler` (no shell). Only http and https, normalised by `browserUrl` in `shared/links.js`; anything else answers 400. A dry run records it under `browser` in `/api/dry-run`. If the call fails the page opens the link in its own window instead. |
| `POST /api/open`, `POST /api/new`, `GET /api/folder`, `POST /api/launch`, `GET /api/launch/options`, `GET /api/launch/<uuid>` | Opening and starting sessions. `launch/options` answers `{ models, efforts, modes }` (`models` adds ids seen in the snapshot); a launch's first prompt is delivered through the reply queue. A launch with a first prompt or `mode: 'bypassPermissions'` answers `409 { error, reason: 'not-armed' }` while `replies` is not armed (`launchNeedsReplies` in `shared/launch.js`); a plain launch does not need it. When the server cannot find Claude's `claude://` handler, `open` and `new` answer `502 { error, handOff: <link> }` and the window opens the link itself (`handOffLink` in `shared/links.js` accepts only those two link shapes); the failed lookup is logged with its reason and retried on the next request. |
| `POST /api/reply`, `GET /api/reply/<id>`, `POST /api/reply/<id>/withdraw`, `POST /api/reply/<id>/wait` | Replies (Remote control). |
| `GET /api/commands?sessionKey=` | The session's slash commands Orbit may run: `{ known, commands: [{ name, description, source }] }`; `known` is false while its mod has published none in the last 10 min. |
| `GET /api/approvals`, `POST /api/approvals/enabled`, `POST /api/approvals/<id>`, `POST /api/approvals/<id>/typing` | Approvals and questions (Remote control). |
| `POST /api/stats` | The page's render stats, plus an optional `painted: { seq, bootId, at }`: the page sends it after painting the snapshot with that `seq` (`at` = `Date.now()` after the paint). A `bootId` other than the server's is ignored; `at` is clamped to the server's now. |
| `POST /api/prefs` | See Preferences. |
| `POST /api/window`, `POST /api/shutdown` (control) | Open a window (a fresh launch code) in Edge only: without Edge it opens nothing and answers `503 { error, reason: 'no-edge' }` ("Microsoft Edge is required for the pop-out window."), which `--launch` prints with `ok: false`; stop the server. |
| `GET /api/dry-run` | `--dry-run` only. |

**No window, no acting (daemon exposure).** While no window's event stream is open, and none closed in the last 30 s (a page reconnecting keeps acting), these answer `409 { error, reason: 'no-window' }`: `POST /api/reply`, `POST /api/reply/<id>/withdraw`, `POST /api/reply/<id>/wait`, `POST /api/launch`, `POST /api/open`, `POST /api/open-url`, `POST /api/new`, `POST /api/approvals/<id>`, `POST /api/approvals/enabled`, `POST /api/arm`, `POST /api/clear`, `POST /api/stop`. Read routes are unaffected. This guards against acting with nobody looking; it is not an access control (the token is the boundary). Pages must check `reason === 'no-window'` before their other 409 handling (an approval's 409 otherwise reads as answered elsewhere) and say the window is reconnecting. `server.mjs --version` prints `{ ok: true, version }` (older servers answer their usage line with exit 2). `--launch` reuses a server of the same or a newer version and replaces only an older one (opening a new window when the replaced one had a window connected); with `--no-window` it opens no window, and with `--dry-run` the server it starts is a dry run too.

**Stamps (E-92 rule, kept):** `stamps = { snapshot: seq, seq, bootId, checkedAt, prefs: <prefs.json mtime>, prs: <version>, approvals: <stamp>, arm: <count>, alerts: <count> }` (`seq` repeats `snapshot` for B's tracer; there is no `leader` stamp since the switch). `checkedAt` is the time of the last aggregator run that confirmed the snapshot, whether or not it wrote. The page's stale banner is `now − checkedAt > 2 min`; "not live" comes from `/api/health` (`aggregator.isWatching === false`, or `errors`). A stamp is never newer than the content it comes with (the server takes stamps before it reads). The page keeps its previous `snapshot` stamp unless it applied a snapshot from that answer, and treats a different `bootId` as "everything changed". With the server holding the snapshot in memory, `seq` replaces the file mtime.

### Readers

- The window accepts only `schema === 2` (`companion/inbox/live.js`): a window left open across a server update gets a schema it does not know and shows "Reload". The pane checks `schema === 2` and otherwise keeps its last snapshot with `diag.notice` ("Snapshot format N is newer").
- `normalizeSnapshot` (`shared/filters.js`) fills a missing or malformed `status` (unknown buckets read as `idle`), unknown lifecycles as `unknown`, unknown attention as `null`. `failureText(category)` (`shared/failure.js`) is the one wording of a failure. `visibleOf` takes the reader's graph as an option.
- Pins: a session in `options.pinned` is in `sessions` (and on the map) whatever the time window and filters; Hide still applies. `visibleOf` marks it `isPinned: true` wherever it appears in the view (sessions, attention, pinned, peers).
- `options.keepNeedsYouInProject`: a project filter never hides a session whose `status.bucket` is `needs-you` (the other filters and the time window still apply). The pane passes it.
- Types (after C9, additive, A's `types/index.d.ts` turn): `SessionView.isPinned?: boolean`, `Settings.prProblemsNeedYou?: boolean`, and `VisibleOptions` (`pinned`, `expanded`, `showAll`, `hidden`, `keepNeedsYouInProject`, `graph`), which `shared/filters.js` now takes from `types`.

## Remote control: off unless armed (A5, D-6)

### Secrets and the window (E-03, E-16, E-50)

- `companion.json` carries a **control token** (`token`) only. It reaches `GET /api/ping`, `POST /api/window`, `POST /api/shutdown`, `GET /api/arm` and the `/api/hook/*` and `/api/mod/*` routes; every other route answers `403` to it. `--dry-run` alone also writes `pageToken` (tests and tools only).
- **Proof of the token** (optional, no schema change): a control-token request may carry `x-orbit-nonce` (16 to 64 random bytes as hex). The server then answers with `x-orbit-proof` = HMAC-SHA256(control token, nonce) as lower-case hex, on every status after the token check; without a nonce it answers as before. The approval hook (`hooks/approve.mjs`) and the mod (`serverCall` in `src/core/inbox.ts`, `readArmed` in `src/companion.ts`) send a fresh nonce on every call, compare the proof in constant time (`shared/proof.js`) and treat a missing or wrong proof as no server: no decision, nothing delivered, no arm state. A new hook or mod therefore gets nothing from a server older than this change until the daemon replaces it.
- The **page secret** never touches disk. Edge opens `/inbox?launch=<code>` (one use, 60 s); the server answers `303` to `/inbox` with `Set-Cookie: orbit=<page secret>; HttpOnly; SameSite=Strict; Path=/`. Page routes take that cookie (or `x-orbit-token`, for tools). F5 keeps the window; a used or old link answers `403` with a line to open Pop out again.

### Arm switches (D-6, E-25)

- Capabilities `approvals`, `questions`, `replies`; all off by default; held in the server's memory and written by it to `arm.json` with a MAC (`arm.key`). A file that fails the check arms nothing and raises an alert. The old `approvals/enabled.json` with `enabled: true` arms `approvals` and `questions` once (`source: 'migrated'`) when there is no `arm.json`; nothing is ever turned off by a migration.
- `GET /api/arm` → `{ approvals: { armed, at, source }, questions, replies, tampered, setup: { hookSeenAt, replySessions, olderSessions } }` (page or control token). `POST /api/arm { capability, armed }` (page secret, window required: `409 no-window` otherwise) → `{ ok, arm }`. `POST /api/approvals/enabled { enabled }` stays as the old switch and arms or disarms approvals and questions together. `stamps.arm` moves on a change; `health.arm` mirrors the state.
- The mod's `diag.armed` (capability names, or null) feeds the pane's indicator.

### Approvals and questions through the server (E-01, E-06 b, E-116, E-122, E-23)

- The hook trusts no file: it posts every prompt to `POST /api/hook/requests { request, nonce }` (control token), or `{ marker: { cliSessionId, toolName }, nonce }` for one Orbit cannot show. The server answers `{ engaged: false }` unless the capability is armed, a window is attentive (held 60 s while focused, 8 s when not focused, 25 s from a page that does not say), and the session is in its snapshot. Engaged: `{ engaged: true, id }`, then the hook long-polls `GET /api/hook/requests/<id>?nonce=&waitMs=` → `{ status: 'answered', answer }`, `{ status: 'pending', expiresAt }` or `410`. `POST /api/hook/requests/<id>/end { nonce, outcome }` when it stops waiting.
- While a server runs, every prompt leaves a text-free wait marker (session, tool, time): the session is `needs-you` "Approve <tool>?" until its activity moves past it, even when Orbit does not engage.
- `GET /api/approvals` (page secret) lists open, engaged requests from memory; `POST /api/approvals/<id>` answers as before (`checkAnswerPost`); the control token cannot answer. A request ends when its window goes (no event stream for 5 s), at expiry, or when the hook takes the answer. Answer files are never read.
- `POST /api/approvals/<id>/typing` (page secret): someone is typing an answer to a question; it stays open another minute, never past `QUESTION_WAIT_MAX_MS` (110 s) after it was asked, below the installed hook's 120 s timeout (E-23). A longer wait needs a higher hook timeout in the user's settings and a matching constant. Tool approvals answer `400`.
- `POST /api/attention` takes `focused: boolean` (E-116).

### Replies through the server (E-02)

- `POST /api/reply` answers `409 { reason: 'not-armed' }` while replies are not armed, and `409 { older: true }` for a session whose record has no `replyProtocol: 2` (mods from A5 on). Replies and launch first prompts live in server memory; nothing is written to `inbox/`.
- Mods: `GET /api/mod/replies/<cliSessionId>` → `{ armed, replies: [{ schema: 1, id, to, text, createdAt, firstPrompt? }] }`; `POST /api/mod/replies/<id>/claim { cli }` → `{ ok }` or `{ ok: false, reason: 'withdrawn' | 'replay' | 'unknown' }`; `POST /api/mod/replies/<id>/ack { cli, ack }`; `POST /api/mod/replies/<id>/hold { cli }` → `{ ok }` or `{ ok: false, reason: 'withdrawn' | 'replay' | 'unknown' | 'expired' }`. A mod delivers nothing, a first prompt included, while `armed` is false. While its main turn runs a mod holds a reply instead of submitting it: the reply stays unclaimed (withdrawable), is handed out with `held: true` (and `wait: true` once the page asks) for `HOLD_TTL_MS` (30 min), and the mod claims it after the turn's next tool batch to steer it in as `PostToolBatch` `additionalContext` (`STEER_PREFIX` + text, acknowledged `sent`), or, when it waits, submits it as the person once the turn ends. Page: `GET /api/reply/<id>` → `{ status: 'held', wait }` while held; `POST /api/reply/<id>/wait { wait: boolean }` → `{ ok, wait }`, 409 once claimed or withdrawn.
- Slash commands: a mod publishes its session's commands (`$.command.list()` plus the built-ins desktop sessions hide but still run, `HIDDEN_BUILTINS`: `/remote-control`, `/rename`) with `POST /api/mod/commands/<cliSessionId> { commands: [{ name, description, source }] }` (control; at most once a minute, on change; `COMMANDS_MAX` entries) from `$.command.list()`, deny-listed names (`DENIED_COMMANDS` in `shared/inbox.js`: sign-in, settings, permissions, hooks, plugins, MCP, memory, installers, terminal screens) left out. The server keeps them in memory only (`companion/lib/commands.mjs`, 200 sessions, fresh 10 min) and drops denied names again. A reply that is `/name args` is accepted only when `name` is in the session's fresh list (`400 { reason: 'command' }` otherwise); it is queued with `wait: true`, which `/wait` cannot change, `GET /api/reply/<id>` adds `command: true` while held, and the mod checks the name against its own list again, then runs it with `$.command.run({ command, args })` once the session is idle: never steered, never submitted as a prompt. `!` and `#` are always refused. The audit records `kind: 'command'` with the name only. The panel's Remote Control toggle sends `/remote-control` this way and then waits up to 30 s for the record's `remoteControl` to flip. Saving a new name in the panel sends `/rename <name>` this way when the session lists it; otherwise the name stays in Orbit only.
- `PublishedSession.replyProtocol` / `PublisherInfo.replyProtocol`: `2` from A5.

### Stop through the server

- `POST /api/stop { sessionKey }` → `{ ok, id, createdAt }`; the same refusals as a reply (`409 { reason: 'not-armed' }` while Replies as me is off, `409 { older: true }` without `stopProtocol: 1`). One open request per session; unclaimed for 15 s it expires. `GET /api/stop/<id>` → `{ status: 'pending' | 'stopped' | 'idle' | 'failed' | 'expired' }`, a final one read once.
- Mods: `GET /api/mod/replies/<cli>` adds `stops: [{ id, createdAt }]` while armed; `POST /api/mod/stops/<id>/claim { cli }`, `POST /api/mod/stops/<id>/ack { cli, outcome }`. The mod aborts its main turn with `$.turn.abort` only when that turn started before `createdAt` (`idle` otherwise). No interruption marker reaches the model, unlike Esc in Claude.
- `PublishedSession.stopProtocol` / `PublisherInfo.stopProtocol`: `1` from 2.1.6.

### One sub-agent (2.1.7)

- Clicking a sub-agent on the map opens its own panel: status, parent session, its transcript from `GET /api/conversation?key=<sessionKey>&agent=<agentId>` (the sidechain file `<cli>/subagents/agent-<agentId>.jsonl`, read with `isSidechain`; same paging and text rules as a session's chat), a message box and Stop.
- `POST /api/reply { sessionKey, text, agentId }` and `POST /api/stop { sessionKey, agentId }` address one sub-agent: `400` for a malformed id (`isAgentId`), `404` when the snapshot has no agent `<sessionKey>/<agentId>`, `409 { older: true }` without `agentProtocol: 1`; a slash command is refused. Otherwise the usual reply and stop rules (armed, one delivery, audit with `agent`).
- The mod hands `agentId` on: a reply goes to `$.session.send({ to: { agentId }, text })` at once (never held, never waits; acked `sent` when delivered, `failed: dropped` otherwise); a stop runs `TaskStop` on that task (`stopped` or `failed`; a foreground sub-agent may refuse, then the panel points at the session).
- `PublishedSession.agentProtocol` / `PublisherInfo.agentProtocol`: `1` from 2.1.7.

### Forged files, alerts, audit (E-22)

- The server deletes, every 2 s, approval request and answer files and inbox reply requests (it writes none since A5) and raises an alert: `GET /api/alerts` → `{ alerts: [{ kind: 'forged-file' | 'tampered', where: 'approvals' | 'inbox' | 'arm', what, at }] }` (newest first), `health.alerts { count, latest }`, `stamps.alerts`. Folder and kind only, never content or paths.
- `audit.jsonl` (append-only; rotated once to `audit.1.jsonl` past 1 MB): `arm` (capability, armed), `approval` and `question` (id, session, tool, inputHash, outcome), `reply` (id, session, outcome), `alert` (where, what). Short allow-listed fields, never text. `GET /api/audit?limit=` (page secret) → `{ entries }`, newest first.

### Environment and the live copy (E-43, E-49)

- Every child the server starts (a server from `--launch`, Edge, the desktop link, git, gh) gets the launch allow-list environment only.
- `tools/refresh-live.ps1` mirrors the committed tree (`git archive HEAD`), never untracked files or `.git`.

### Hardening after the security review

- A launch code redeemed a second time (something read Edge's command line and used it first) rotates the page secret, ends every event stream and raises an alert (`where: 'window', what: 'link-reused'`); the window's 403 says what happened. Whatever took the code is locked out; the person opens Pop out again.
- `arm.json` missing next to an existing `arm.key` is tampering (all off, alert); the old `enabled.json` migrates only on a first start (no `arm.key` yet). Capabilities re-armed from `arm.json` at a restart get an audit line (`outcome: 'restored at start'`).
- `POST /api/hook/requests` refuses a request not created within 5 s of now, one that waits longer than the hook wait (60 s), one from no live process (`hookPid`), and answers `429` past 20 open requests for a session or 100 in all. Markers are capped at 500. Nonces are compared in constant time.
- Page routes take the first valid of the header, the `t` query (event stream only, `--dry-run` only) and the cookie, so a page that still sends a stale header is carried by its cookie.
- The server also watches `inbox/` and deletes a forged reply request as soon as it appears (plus the 2 s sweep).

Residual risks (accepted: the attacker is the same Windows user, who could already start `claude` itself): a reader of `companion.json` holds the control token, so it can read pending reply text for any session, claim and acknowledge replies to suppress them, register hook requests (they show as cards the person decides), and read the arm state; with code execution it can also stand up a listener and rewrite `companion.json` with a port and token of its own, which the hook, the mods and the launcher trust. A listener that only takes over Orbit's port, without the token, gets no answer through: the hook and the mods require the proof of the token for their nonce. The page cookie is sent to every port on 127.0.0.1 in Orbit's own Edge profile. `arm.key` sits beside `arm.json`. Pre-A5 mods still read inbox files until those sessions end. Recommended to users (not applied by Orbit): deny rules for Claude's file tools on `~/.claude/orbit/**` and `~/.claude/mods/**`.

## Notifications raised by the server (G-20, G-21)

- **What raises one:** a session entering `needs-you` or `failed` (mode `needs-you`, the default), plus `review` (mode `all`). Once per need: session, bucket and the status `since`. Never on the server's first look after a start, for a need that began more than 5 minutes before the server saw it, or while muted (`off`). At most one per session a minute. A need raised while a window is attentive is `isQuiet: true`: only a window may claim it, and it shows as a banner. Done and snoozed sessions are out of those buckets already (C6), so they raise nothing.
- **Text:** title `Needs you · <session title>` (`Failed · …`, `Ready for review · …`; the title cut at 60 characters), body the status reason (≤ 120). Never logged; the log says `notice <id> raised` or `not raised (<reason>)`.
- **Delivery to a window:** each new notice is pushed to every open window as `event: notice`, data `{ id, sessionKey, kind, label, sessionTitle, title, body, at, isQuiet }`. A window claims it with `POST /api/notices/<id>/claim { windowId }` (page secret; 400 unless `windowId` is a live window; first claim wins, mods included) and reports `POST /api/notices/<id>/ack { windowId, shownAs: 'system' | 'banner' }`; the log says `notice <id> shown in a window (<shownAs>)`.
- **Delivery without a window:** the server holds notices for 2 minutes; while a window is open, `GET /api/mod/notices` lists only notices a window has left unclaimed for 5 s, and never quiet ones; every session's mod (it already polls the server every 2 s for replies) asks `GET /api/mod/notices` (control token), claims one with `POST /api/mod/notices/<id>/claim { cli }` (the first claim wins, so it shows once however many sessions run), raises it with the engine's `$.ui.notify(body, { title, key: id })` (the person's own notification channel, `preferredNotifChannel`; the desktop app shows it natively), and reports `POST /api/mod/notices/<id>/ack { cli, isSent, reason }`. Needs at least one live session; with none, nothing is shown (the daemon has no way to raise a Windows notification of its own without a new process, which is left out on purpose: no PowerShell toasts, no Edge).
- **Mute:** `GET /api/notify` → `{ mode, modes }`, `POST /api/notify { mode: 'all' | 'needs-you' | 'off' }` (page secret), kept in `notify.json`.
- **Health:** `health.notices { mode, raised, claimed, quiet, lastDelivery: { isSent, reason, shownAs?, at } | null }`; `reason` is `disabled`, `no-channel`, `no-surface`, `refused` or `threw` when the channel did not show it.
- **No type change needed** (the mod and server use local shapes). If the notice shape is wanted in `types/index.d.ts`, it is `{ id: string, sessionKey: string, kind: 'needs-you' | 'failed' | 'review', title: string, body: string, at: number }`.
