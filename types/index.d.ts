export type Lifecycle =
  | 'running'
  | 'waiting-user'
  | 'waiting-permission'
  | 'idle'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'disconnected'
  | 'stale'
  | 'unknown'

export type Phase =
  | 'planning'
  | 'researching'
  | 'implementing'
  | 'testing'
  | 'reviewing'
  | 'debugging'
  | 'merging'
  | 'awaiting-response'
  | 'blocked'
  | 'general'
  | 'unknown'

export type Confidence = 'observed' | 'inferred' | 'unknown'

export type SourceName =
  | 'mod-events'
  | 'desktop-metadata'
  | 'desktop-summary'
  | 'subagent-meta'
  | 'github'
  | 'orbit-hook'
  | 'none'

export type Evidence = {
  source: SourceName
  confidence: Confidence
  observedAt: number | null
  detail: string | null
}

export type Environment = 'desktop' | 'terminal' | 'ide' | 'unknown'

/** Why Orbit cannot message a session (`messageBlockOf`): no CLI id, or its process stopped (`asleep`: a desktop session the desktop stopped while idle; `ended`: any other). */
export type MessageBlock = 'no-id' | 'asleep' | 'ended'

export type AttentionKind = 'question' | 'permission' | 'needs-you' | 'blocked' | 'failed' | 'review' | 'pr'

export type TimelineKind = 'state' | 'tool' | 'agent' | 'turn' | 'note'

export type TimelineEntry = {
  at: number
  kind: TimelineKind
  text: string
}

export type ToolCategory =
  | 'read'
  | 'search'
  | 'edit'
  | 'test'
  | 'git-write'
  | 'merge'
  | 'shell'
  | 'web'
  | 'agent'
  | 'question'
  | 'plan'
  | 'review'
  | 'skill'
  | 'mcp'
  | 'other'

export type ToolRecord = {
  at: number
  tool: string
  category: ToolCategory
  target: string
  isError: boolean
  agentId: string | null
  /** True while the call runs (since 1.16); absent once it ended and on older records. */
  pending?: true
}

export type PublishedAgent = {
  id: string
  parentId: string | null
  type: string
  description: string
  name: string | null
  model: string | null
  status: string
  startedAt: number | null
  lastActivityAt: number | null
  finishedAt: number | null
}

export type PublishedWaiting = {
  kind: 'question' | 'permission'
  since: number
  tool: string | null
}

export type PublishedSession = {
  schema: 1
  cliSessionId: string
  modVersion: string
  engineVersion: string | null
  entrypoint: string | null
  cwd: string
  repoRoot: string | null
  repoRemote: string | null
  repoName: string | null
  model: string | null
  startedAt: number
  updatedAt: number
  heartbeatAt: number
  endedAt: number | null
  endReason: string | null
  turn: {
    isRunning: boolean
    startedAt: number | null
    endedAt: number | null
    lastReason: string | null
  }
  waiting: PublishedWaiting | null
  context: { percent: number | null; tokens: number | null; window: number | null; measuredAt: number } | null
  /** What the session has cost so far (US dollars), from `session.measure`; absent on 1.0 records. */
  cost?: number | null
  /** The account's rate-limit windows as this session last measured them; absent on 1.0 records. */
  rateLimits?: RateLimitView[] | null
  usageAt?: number | null
  /** This session's pane render cost (counts and milliseconds only); absent before the first render or on older records. */
  pane?: PaneStats | null
  /** Replies from the Orbit pop-out this session delivered or refused (counts, times, a reason; never text); absent before 1.9. */
  inbox?: InboxStats | null
  /** The idle heartbeat period this publisher keeps (since 1.16): with it, a heartbeat older than two periods plus a grace means the process is gone. Absent on older records. */
  idleBeatMs?: number
  /** 2 since A5: the mod takes replies only from the server over HTTP, never from inbox files. Absent on older records. */
  replyProtocol?: number
  /** 1 when the mod takes stop requests from the server and aborts its own running turn. Absent on older records. */
  stopProtocol?: number
  /** 1 when the mod takes replies and stops addressed to one of its sub-agents (`agentId`). Absent on older records. */
  agentProtocol?: number
  /** This session's mod failures (E-29): how many, the last time, where, and the error's kind; never its message. Never cleared on success. */
  errors?: ErrorTrace
  tools: ToolRecord[]
  timeline: TimelineEntry[]
  agents: PublishedAgent[]
}

export type RateLimitView = {
  kind: string
  percentUsed: number
  resetsAt: string | null
}

export type UsageView = {
  rateLimits: RateLimitView[]
  evidence: Evidence
}

export type ContextView = {
  percent: number | null
  tokens: number | null
  window: number | null
  evidence: Evidence
}

export type PullRequestView = {
  url: string
  number: number
  repo: string
  branch: string | null
  state: string
}

export type ProjectView = {
  id: string
  name: string
  root: string
  remote: string | null
  sessionKeys: string[]
  worktreeIds: string[]
  lastActivityAt: number
  activeAgents: number
  /** The default icon colour the person chose for its sessions; absent means blue. */
  tint?: SessionTint
}

export type SessionTint = 'blue' | 'violet' | 'pink' | 'red' | 'teal' | 'lime' | 'sand' | 'slate'

export type WorktreeView = {
  id: string
  projectId: string
  path: string
  isMain: boolean
  branch: string | null
  sessionKeys: string[]
}

export type PaneStats = {
  renders: number
  lastMs: number
  avgMs: number
  maxMs: number
  svgChars: number
}

export type PublisherInfo = {
  modVersion: string
  engineVersion: string | null
  heartbeatAt: number
  endedAt: number | null
  pane?: PaneStats | null
  inbox?: InboxStats | null
  /** 2 when the session's mod takes replies from the server (A5). */
  replyProtocol?: number
  /** 1 when the session's mod can be stopped from Orbit. */
  stopProtocol?: number
  /** 1 when the session's mod can message and stop its sub-agents from Orbit. */
  agentProtocol?: number
  errors?: ErrorTrace
}

/** Where a mod failure happened (E-29). */
export type ErrorWhere = 'tick' | 'publish' | 'inbox' | 'notice' | 'hook' | 'render' | 'daemon'

/** A durable, text-free trace of a session's mod failures (E-29). */
export type ErrorTrace = { count: number; lastAt: number; where: ErrorWhere; kind: string }

/** Why a session's mod refused a reply request from the pop-out (`REFUSAL_TEXT` in `shared/inbox.js` words them). */
export type ReplyRefusal = 'empty' | 'long' | 'command' | 'stale' | 'future' | 'replay' | 'wrong' | 'malformed' | 'withdrawn' | 'dropped'

/** `inbox/<cliSessionId>/<id>.json` as the pop-out server writes it. */
export type ReplyRequest = {
  schema: 1
  id: string
  to: string
  text: string
  createdAt: number
}

/** The same file once the target's mod claimed or refused it: the text is gone. */
export type ReplyRequestDone = {
  id: string
  to: string
  createdAt: number | null
  done: true
}

/** `inbox/<cliSessionId>/<id>.ack.json`, written by the target's mod. */
export type ReplyAck = {
  id: string
  status: 'sent' | 'queued' | 'refused' | 'failed'
  reason: ReplyRefusal | null
  at: number
}

export type InboxStats = {
  delivered: number
  lastDeliveredAt: number | null
  refused: number
  lastRefusal: ReplyRefusal | null
  lastRefusedAt: number | null
}

/** A running session that looks stuck, inferred from its main agent's tool calls (`stuckOf`). */
export type StuckView = {
  kind: 'repeat' | 'errors'
  text: string
  since: number
}

/** `approvals/<id>.json`, written by `hooks/approve.mjs` for one permission request. */
export type ApprovalRequest = {
  schema: 1
  id: string
  /** `question` for `AskUserQuestion` (follows `toolName`); absent in requests from hooks before 1.15. */
  kind?: 'tool' | 'question'
  createdAt: number
  expiresAt: number
  cliSessionId: string
  cwd: string | null
  toolName: string
  /** The tool input as Claude sent it, or its canonical JSON cut to 16 KiB when `truncated`. */
  toolInput: unknown
  truncated: boolean
  /** SHA-256 (hex) of the canonical JSON of `{ toolName, toolInput }` before any cut. */
  inputHash: string
  permissionMode: string | null
  agentId: string | null
  /** The waiting hook's process id: a request whose hook is gone is never shown or answered; 0 for a held question. */
  hookPid: number
  /** A question the session's own mod holds while Claude's dialog asks it too (2.1.6); it waits while the mod polls. */
  held?: boolean
}

/** `approvals/<id>.answer.json`, written once by the pop-out server. */
export type ApprovalAnswer = {
  schema: 1
  id: string
  inputHash: string
  /** `answer` only for question requests; `allow`/`deny` only for tool requests. */
  behavior: 'allow' | 'deny' | 'ask' | 'answer'
  at: number
  /** With `answer`: the checked, normalised choice per question text. */
  answers?: Record<string, QuestionChoice>
  /** With `answer`: non-blank notes per question text. */
  notes?: Record<string, string>
}

/** One option of an `AskUserQuestion` question as Orbit validated it (`readQuestions`). */
export type QuestionOption = {
  label: string
  description: string
  preview?: string
}

/** One `AskUserQuestion` question as Orbit validated it. */
export type QuestionSpec = {
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}

/** The answer to one question: offered labels, or free "Other" text. */
export type QuestionChoice = { labels: string[] } | { other: string }

/** What the hook does once an answer file decides a request: the done-file outcome and its stdout (null = none). */
export type HookDecision = {
  outcome: 'allow' | 'deny' | 'ask' | 'answered' | 'declined'
  output: string | null
}

/** A pending request as the pop-out page shows it (`approvalView`): every input part as text, hidden characters made visible. */
export type ApprovalView = {
  id: string
  /** `question`: an `AskUserQuestion` to answer (`questions` set, `fields` empty). Absent only in views built before 1.15. */
  kind?: 'tool' | 'question'
  cliSessionId: string
  toolName: string
  fields: { label: string; text: string }[]
  lines: number
  chars: number
  /** Control, format, bidi or zero-width characters replaced by visible codes. */
  hidden: number
  truncated: boolean
  cwd: string | null
  createdAt: number
  expiresAt: number
  inputHash: string
  answered: 'allow' | 'deny' | 'ask' | 'answer' | null
  /** Question requests only: the questions, descriptions and previews with hidden characters made visible. */
  questions?: QuestionSpec[]
  /** A question also open in Claude's dialog: no countdown, and whichever side answers first wins. */
  held?: boolean
}

/** How a request this window showed ended. */
export type ApprovalOutcome = {
  id: string
  outcome: 'allow' | 'deny' | 'ask' | 'answer' | 'dismiss' | 'expired' | 'gone'
  cliSessionId: string
  toolName: string
  at: number
}

/** A linked pull request's state as the pop-out server last read it with `gh` (`prSummary`). */
export type PrStatus = {
  state: 'open' | 'draft' | 'merged' | 'closed'
  checks: 'passing' | 'failing' | 'pending' | 'none'
  failing: string[]
  review: 'approved' | 'changes' | 'required' | null
  checkedAt: number
  /** When the server first saw the current problem (failing checks or changes requested); null without one. */
  since?: number | null
}

export type SessionView = {
  key: string
  localId: string | null
  cliSessionId: string | null
  title: string
  projectId: string
  worktreeId: string | null
  environment: Environment
  canOpen: boolean
  canMessage: boolean
  /** Why `canMessage` is false, or null; absent from snapshots written before 1.13.1. */
  messageBlock?: MessageBlock | null
  cwd: string | null
  branch: string | null
  model: string | null
  effort: string | null
  createdAt: number | null
  lastActivityAt: number
  lifecycle: Lifecycle
  lifecycleEvidence: Evidence
  /** When the current lifecycle began, as well as the sources tell (see `lifecycleOf`). */
  stateSince: number | null
  /** When the last turn ended, or null while one runs. */
  finishedAt: number | null
  phase: Phase
  phaseEvidence: Evidence
  summary: string
  activity: string | null
  attention: AttentionKind | null
  attentionText: string | null
  isPlanMode: boolean
  context: ContextView
  /** US dollars so far, observed through `session.measure`; null when the session does not run this mod. */
  cost: number | null
  turns: number | null
  prs: PullRequestView[]
  agentKeys: string[]
  timeline: TimelineEntry[]
  publisher: PublisherInfo | null
  /** When the current attention began, when it is not the lifecycle's (a PR problem, pop-out only). */
  attentionSince?: number | null
  /** Where the current attention comes from, when it is not the lifecycle's evidence (a PR problem: GitHub through `gh`). */
  attentionEvidence?: Evidence | null
  /** Inferred "Maybe stuck" hint while running; absent from snapshots written before 1.10 (read as null). */
  stuck?: StuckView | null
  /** From the desktop record (A4); null for terminal sessions or when the record lacks it. */
  lastFocusedAt?: number | null
  /** Whether Remote Control is on, from the desktop record; null for terminal sessions or when the record does not say. */
  remoteControl?: boolean | null
  /** The desktop's own title when the person renamed the session in Orbit (`title` then holds their name). */
  renamedFrom?: string
  /** The icon colour: the person's choice for the session, else its project's; absent means blue. */
  tint?: SessionTint
  /** The desktop holds a suggested next prompt for this idle session; the text itself only comes from `/api/suggestion`. */
  hasSuggestion?: boolean
  /** The session this one was started from (side session, fork, hand-off, spawn). */
  parent?: { key: string; kind: 'side-session' | 'fork' | 'hand-off' | 'spawn' } | null
  /** The last turn's report (≤ 400 chars, plain) and what it asks of the person (≤ 200). */
  lastReport?: { text: string; needsUser: boolean; ask: string | null; at: number | null } | null
  /** The newest failure mark from the desktop record, by category only. */
  failure?: { category: string; at: number; source: 'error' | 'crash' | 'mark'; isCurrent: boolean } | null
  /** One of five buckets with one reason line (docs/CONTRACT.md, D-4); `normalizeSnapshot` fills it when missing. */
  status?: Status
  /** How `projectId` was decided (G-17): the person's override, the repository most edits land in, or the start folder. */
  projectSource?: 'edits' | 'folder' | 'override'
  /** Set by `visibleOf` on a session in `options.pinned`; absent otherwise. */
  isPinned?: boolean
}

export type StatusBucket = 'needs-you' | 'working' | 'review' | 'idle' | 'failed'

export type Status = {
  bucket: StatusBucket
  /** One line, ≤ 120 characters, plain text. */
  reason: string
  since: number | null
  isObserved: boolean
  /** The person marked the session Done and it has not changed since (C6). */
  isDone?: boolean
  /** The person snoozed the session until then (C6); null when not snoozed. */
  snoozedUntil?: number | null
}

export type AgentView = {
  key: string
  id: string
  sessionKey: string
  parentKey: string | null
  type: string
  description: string
  name: string | null
  model: string | null
  lifecycle: Lifecycle
  evidence: Evidence
  phase: Phase
  activity: string | null
  startedAt: number | null
  lastActivityAt: number | null
  finishedAt: number | null
  recent: TimelineEntry[]
  /** Written by pre-daemon leaders only (relative to the leader, so wrong for other viewers); dropped one release after the daemon release. */
  isOwnSession?: boolean
  status?: Status
}

export type NodeKind = 'project' | 'worktree' | 'session' | 'agent' | 'pr'

export type GraphNode = {
  id: string
  kind: NodeKind
  ref: string
  parent: string | null
  x: number
  y: number
  r: number
  label: string
  side: 1 | -1
}

export type GraphEdge = {
  from: string
  to: string
  /** `lineage`: parent session to the session it spawned, forked or handed off to (G-16); readers that do not draw it skip it. */
  kind: 'hierarchy' | 'resource' | 'lineage'
}

export type SourceHealth = {
  /** `skipped`: records past the sessions-kept cap, not read; the page can say "50 of 327" (E-18). Absent from older snapshots. */
  desktop: { ok: boolean; files: number; parsed: number; failed: number; skipped?: number; error: string | null }
  /** `legacy`: sessions whose newest record is in the 1.0 folder and not ended (within the 7-day read window); absent from older leaders' snapshots. */
  publishers: { files: number; live: number; failed: number; legacy?: number }
  subagents: { metas: number; failed: number }
  /** What the writer cut to keep the snapshot under its byte budget (since 1.16); absent when nothing was cut. */
  budget?: { maxBytes: number; droppedAgents: number; droppedSessions: number }
  errors: string[]
}

/** `snapshot-v2.json` and `/api/state`, written by the server, the one aggregator (docs/CONTRACT.md "Snapshot v2"). */
export type SnapshotV2 = {
  schema: 2
  generatedAt: number
  generator: string
  serverVersion: string
  /** +1 per written snapshot; restarts with a new `bootId`. */
  seq: number
  bootId: string
  projects: ProjectView[]
  worktrees: WorktreeView[]
  sessions: SessionView[]
  agents: AgentView[]
  /** The account's rate limits, from the most recent measurement any session published. */
  usage: UsageView | null
  sources: SourceHealth & { watch?: { isWatching: boolean; lastEventAt: number | null } }
  /** `phases`: the server run's milliseconds per phase (`prefs`, `aggregate`, `status`, `write`). */
  timings: { aggregateMs: number; sessions: number; agents: number; phases?: Record<string, number> }
}

/** What a pane or page draws: a schema 2 snapshot plus the graph the reader laid out with `shared/layout.js`, and how long that took. */
export type Snapshot = Omit<SnapshotV2, 'timings'> & {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  timings: SnapshotV2['timings'] & { layoutMs: number }
}

export type TimePreset = 'active' | '15m' | '1h' | '4h' | '24h' | '7d' | 'all'

export type Filters = {
  time: TimePreset
  showCompleted: boolean
  showStale: boolean
  attentionOnly: boolean
  project: string
  model: string
  lifecycle: string
  phase: string
  search: string
}

export type Settings = {
  animation: 'off' | 'low' | 'normal'
  refreshSec: number
  maxSessions: number
  maxSubagents: number
  simplified: boolean
  paused: boolean
  staleMinutes: number
  showPRs: boolean
  /** "PR problems need you" (after C9): the server checks linked PRs with `gh` and a quiet session linking a failing one needs you. Absent in prefs written before it. */
  prProblemsNeedYou?: boolean
}

/** What `visibleOf` takes besides the filters and settings. */
export type VisibleOptions = {
  /** Pinned session keys: kept past the time window and every filter (Hide still applies), and marked `isPinned`. */
  pinned?: readonly string[]
  /** Session keys whose sub-agents are all shown past the cap (still within the time window and completed filter). */
  expanded?: readonly string[]
  /** Session keys whose every sub-agent is shown: past the cap, the time window and the completed filter. */
  showAll?: readonly string[]
  /** Sessions hidden until active (see `isHiddenNow`). */
  hidden?: Readonly<Record<string, number>>
  /** A project filter never hides a session whose `status.bucket` is `needs-you`. */
  keepNeedsYouInProject?: boolean
  /** The reader's layout (`layoutGraph`); defaults to `snapshot.graph`. */
  graph?: { nodes: GraphNode[]; edges: GraphEdge[] }
}

export type Offset = { dx: number; dy: number }

export type Prefs = {
  schema: 1
  updatedAt: number
  settings: Settings
  filters: Filters
  positions: Record<string, Offset>
  collapsed: string[]
  /** Session keys pinned to the top of the list. */
  pinned: string[]
  /** Sessions hidden until active: session key → its last activity when hidden. Absent in files written before 1.8. */
  hidden?: Record<string, number>
  /** The person's project for a session: session key → project id (G-17); the aggregator applies it. */
  projectOverrides?: Record<string, string>
  /** Sessions the person marked Done: session key → when (C6). Out of Needs you until the session changes after it. */
  done?: Record<string, number>
  /** Sessions the person snoozed: session key → `{ until, at }` (C6). Out of Needs you until `until`, unless a new need begins after `at`. */
  snoozed?: Record<string, { until: number; at: number }>
  /** Names the person gave sessions in Orbit: session key → name (one line, at most 120 characters); the aggregator applies it. */
  titles?: Record<string, string>
  /** Icon colours the person chose: session key → a colour (blue included: it overrides the project's). */
  tints?: Record<string, SessionTint>
  /** Default icon colours of projects: project id → a colour other than blue. */
  projectTints?: Record<string, SessionTint>
  /** When stored data was last cleared: older records from the 1.0 folder are ignored. */
  clearedAt: number
}

/** One step of the desktop's task list. */
export type TaskStep = { content: string; status: 'pending' | 'in_progress' | 'completed' }

/** One change to the desktop's task list: a whole new list, the next step started, steps marked done or started, or every step checked off at the turn's end. */
export type TaskOp = { items?: TaskStep[]; advance?: true; done?: number[]; start?: number; finish?: true }

/** One row of a session's conversation tail: a prompt, a reply, a run of tool calls in redacted words, or a hidden change to the task list (`plan`, 2.2.20). */
export type ConversationRow = {
  who: 'you' | 'claude' | 'tools' | 'question' | 'event' | 'plan'
  at: number | null
  text: string
  /** Byte offset of the first transcript line that made the row (1.13). */
  o?: number
  /** The row's place among the rows starting on that line (1.13). */
  i?: number
  /** The text was cut at `CONVERSATION_ROW_CHARS` (1.13). */
  cut?: boolean
  /** The desktop next-step box's reply buttons, its pick first (2.1.7). */
  choices?: string[]
  /** A `plan` row's change to the task list (2.2.20). */
  plan?: TaskOp
}

export type PaneView = 'list' | 'graph' | 'detail' | 'settings' | 'diag' | 'new'

export type Camera = { zoom: number; panX: number; panY: number }

export type CreateState = {
  status: 'editing' | 'starting' | 'started' | 'failed'
  message: string | null
  revision: number
}

export type PaneUi = {
  view: PaneView
  previousView: PaneView
  selected: string | null
  focus: string | null
  camera: Camera
  filtersOpen: boolean
  confirmClear: boolean
  notice: string | null
  openingKey: string | null
  create: CreateState
  /** Detail views show their secondary rows. Absent in values stored before 1.5. */
  moreOpen?: boolean
  /** Detail sections opened (Subagents, Activity, …). Absent in values stored before 1.7. */
  openSections?: string[]
}

export type Diag = {
  role: 'leader' | 'reader' | 'idle'
  lastTickAt: number
  lastTickMs: number
  lastError: string | null
  snapshotBytes: number
  ticks: number
  publishWrites: number
  companion: string | null
  /** This session's replies from the pop-out; absent in values stored before 1.9. */
  inbox?: InboxStats | null
  /** The last tick's milliseconds per phase (since 1.16). */
  tickPhases?: Record<string, number>  /** Why this pane shows no live snapshot (no server, a rollback, a newer snapshot format); null when live. */
  notice?: string | null
  /** The capabilities armed on the server (D-6), for a persistent indicator; null when unknown. */
  armed?: string[] | null
  /** This session's mod failures (E-29), as in its record. */
  errors?: ErrorTrace | null
}

declare module 'claude-code' {
  interface PluginState {
    orbit: {
      /** No longer written since 1.16 (the snapshot lives in module memory); declared until 1.17. */
      snapshot: Shaped<Snapshot | null>
      /** Bumped whenever this session's snapshot changes, so panes redraw (since 1.16). */
      snapshotVersion: Shaped<{ at: number; n: number }>
      prefs: Shaped<Prefs>
      ui: Shaped<PaneUi>
      diag: Shaped<Diag>
    }
  }
}
