# Agent Fleet Product Specification

Status: approved for implementation on 2026-07-12.

The private wtmux repository contains the corresponding bridge/runtime
specification in `SPEC_agent_fleet_bridge.md`; this document remains the
canonical public product and protocol contract.

## Goal

Agent Fleet is a Windows tray application and dashboard for one trusted user's
Codex, Claude Code, Copilot, shell, tmux, and usage-limit workflows across a
small fleet of Windows/WSL hosts and Termux clients. It evolves AI Limits
Widget into one product while preserving the optional transparent limits
overlay.

The private beta must make it simple to see sessions on every machine, launch
or open them, manage scheduled messages, respond to hard-limit and health
events, repair version drift, and pair a new device without copying a private
key or service credential.

## Users, Platforms, And Distribution

- The beta is optimized for one trusted owner and the existing personal fleet.
- Supported UI: Windows 10/11 x64.
- Supported hosts: Linux or WSL with tmux and wtmux.
- Supported client: Termux as a full outbound client; it is not an inbound host.
- Product/version for the embedded-workspace release: `Agent Fleet 0.11.0-beta.1`.
- The public source repository is `yaakovch/agent-fleet`.
- The wtmux runtime, host bridge, and personal fleet registry remain private.
- Private beta artifacts use an authenticated private GitHub release feed.
- A public unsigned build may be offered only as a clearly labeled manual
  download. Automatic public updates require trusted signed artifacts.

## User Experience

### Tray And Windows

- Single-clicking the tray icon opens or raises a resizable dashboard.
- The context menu shows recent sessions, favorite launchers, pending
  schedules, notification pause, settings, and quit.
- Green, amber, red, and gray icon variants communicate healthy, attention,
  failure, and disconnected state.
- Launch on login is recommended but requires explicit onboarding consent.
- The existing transparent, click-through limits widget remains an optional
  companion view.

### Dashboard

The dashboard has Overview, Sessions, Launcher, Schedules, Fleet, and Settings
areas.

- Overview combines actionable attention, host health, local usage limits,
  favorites, and recent sessions.
- Sessions are searchable and grouped by host. Safe actions include open,
  create, rename, kill with contextual confirmation, copy attach command, and
  save favorite.
- Launcher selects host, Linux/Windows backend, project, Codex/Claude/Copilot/
  shell, and an explicit safe target-host Codex profile alias.
- Schedules support create, edit while pending, cancel, and 30-day outcome
  history.
- Fleet shows connectivity, versions, pairing requests, registry sync age,
  diagnostics, and confirmed repair/update actions.
- Settings choose the controller WSL distro and whether session clicks open in
  Agent Fleet, Windows Terminal, or a terminal in the current VS Code window.

### Notifications And Attention

- Notify on genuine hard limits, scheduled delivery success/failure,
  interruption, host offline/recovery, version drift, and pairing requests.
- Every running Agent Fleet installation may notify for the entire fleet.
- Host-backed actionable states resolve fleet-wide. PC-specific offline/update
  observations are acknowledged locally.
- A host becomes offline after three missed 10-second heartbeats and produces
  one recovery notice when it returns.

## Privacy And Security

- The fleet dashboard bridge displays and stores metadata only: host, project,
  session/title, tool, backend, activity, attached state, limit event, and
  schedule state.
- Explicitly opening an embedded session creates a separate ephemeral content
  channel over the existing WSL/Tailscale/SSH path. Prompts, responses,
  transcript excerpts, terminal screens, drafts, and attachment previews may
  exist in process memory only and never enter settings, caches, logs,
  diagnostics, notifications, analytics, or crash reports.
- Agent Fleet never reads, copies, exports, logs, or transfers Codex, Claude,
  GitHub, Tailscale, or SSH credentials.
- There is no listening HTTP, WebSocket, or custom network service. Electron
  talks to a local WSL bridge over stdio; bridges reach hosts through existing
  Tailscale/SSH policy.
- Renderer sandboxing, context isolation, restrictive CSP, blocked navigation,
  validated IPC senders/payloads, ASAR integrity, and production fuses remain
  mandatory.
- There is no telemetry, analytics, or automatic crash upload. Diagnostics are
  local, sanitized, bounded, explicitly generated, and previewable.
- Destructive actions show host, project, session, activity, and affected
  schedules. Killing a session atomically cancels its pending schedules first.

## Fleet Registry And Sync

- Git-provided fleet records are versioned, data-only JSON with strict schemas,
  field/size limits, and unknown-field rejection.
- Git-provided files are never sourced or evaluated as Bash.
- Bash consumers use a locally generated, shell-escaped cache created only
  after successful validation.
- Local fallback SSH identity paths and other machine-local settings remain in
  untracked local configuration.
- Synced launch presets contain only host, backend, project, tool, and safe
  profile alias metadata.
- GitHub is the initial controller-side registry and proposal provider, hidden
  behind provider-neutral interfaces. Runtime control continues from the last
  verified cache when GitHub is unavailable; registry mutations are blocked.
- Dirty checkouts are reported and never automatically stashed, reset, merged,
  or committed.

## Pairing And Installation

- An existing controller creates a single-use 128-bit invitation valid for 10
  minutes.
- Phones use QR. Desktops may discover a nearby bootstrap host over Tailscale
  and enter a six-word code, paste a link/command, or open an `.afpair` file.
- A code is rate-limited, tailnet-restricted, and can only create a proposal;
  it cannot approve or grant access.
- The new device sends validated metadata over outbound Tailscale SSH. The
  existing controller displays the live peer and exact proposal, then creates
  and merges the private registry PR only after confirmation.
- Clients receive a versioned, checksummed wtmux runtime bundle and verified
  cached registry from the bootstrap host. They do not require a private Git
  checkout or GitHub authentication.
- Controller GitHub authentication is delegated to the official `gh` browser
  flow; Agent Fleet never requests or inspects its token.
- Plain SSH fallback remains supported and diagnosed, but its key lifecycle is
  manual during beta.
- A first-ever fleet has one manual controller bootstrap; later devices use
  invitations.

## Runtime And Protocol

- Electron starts one selected WSL controller bridge using argument arrays.
- The controller keeps one authenticated persistent stream per host, with
  bounded exponential reconnect and cached fallback.
- The JSONL protocol is versioned, framed, size-bounded, paginated, and uses
  request IDs, revisions, timestamps, and idempotency keys.
- Incompatible hosts are visible read-only with a confirmed update/repair path.
- Mutations reject stale revisions, offline hosts, unsafe state, invalid data,
  and protocol mismatches with stable error codes.
- Scheduled messages retain literal single-line/4096-byte validation,
  process-identity guards, and at-most-once delivery.
- Schedule and attention metadata is retained for 30 days.
- Schedule instants are transmitted as UTC and displayed in the viewer's local
  time with the destination host time zone beside them.
- Host/agent reboot continues to interrupt guarded schedules rather than
  delivering them late into a different process.

## Open And Launch Behavior

- Agent Fleet is the default session target after migration. It opens sessions
  as reconnecting tabs in a dashboard workspace while retaining quick external
  actions for Windows Terminal and the current VS Code window.
- Windows Terminal starts WSL/wtmux with direct argv, never evaluated shell
  text.
- The existing wtmux VS Code extension gains a validated URI handler that
  creates an integrated WSL attach terminal in the current window without
  changing the workspace.
- Local quota collection remains limited to profiles configured on that PC.
  Fleet views consume genuine host hard-limit events without remote quota
  polling or cross-host account deduplication.

## Migration

- Preserve the legacy AI Limits Widget internal app ID for installer/update
  continuity while changing all user-facing branding.
- Migrate supported settings and data to `%APPDATA%\Agent Fleet` with an atomic
  backup and rollback path.
- Preserve Codex profile labels, Claude integration, limits-widget preferences,
  window state, startup consent, and update preference.
- Migrate fleet fragments in stages: deploy a dual reader, generate and compare
  JSON, verify all current devices, then delete executable `.conf` fragments in
  one reviewed PR.

## Success Criteria

- Cached dashboard appears within one second; live reachable host state appears
  within five seconds.
- All selected session, launcher, schedule, open, notification, health, and
  repair workflows work on both Windows/WSL systems.
- Termux pairs and operates as a full outbound client without GitHub credentials
  or an inbound SSH server.
- Pairing never requires manual config editing, key copying, or credential
  transfer.
- No genuine schedule submits more than once, and a killed session leaves no
  pending schedule behind.
- GitHub outage, host outage, protocol mismatch, dirty checkout, update failure,
  app restart, and bridge restart produce bounded recoverable states.
- Automated/security/package checks pass and a 14-day soak across two Windows
  PCs, two WSL hosts, and Termux completes without a critical security issue,
  duplicate delivery, registry corruption, lost confirmed schedule, or
  unrecoverable migration.

## Deferred

- Team accounts, shared roles, or multi-owner permissions.
- Automatic Tailscale policy edits or Tailscale API credentials.
- Automated plain-OpenSSH key lifecycle.
- Remote quota polling and usage-aware profile recommendations.
- Inbound Termux hosting.

## Arbitrary Session Locations

- New Session follows Host, Backend, Projects/Other location, Folder, editable
  label, and Tool. Projects come from a real host directory listing and include
  folders with no active session.
- Other location browses only accessible directories from home/profile with
  project, filesystem, mount, and Windows drive shortcuts. Hidden entries and
  manual path entry are excluded; UNC browsing is deferred.
- Users may safely create one child folder, enter it, and explicitly select Use
  this folder. Ten recent locations are stored locally per host/backend and are
  clearable; missing entries disappear when used.
- Full paths are retained locally and shown in Session Details only. Session
  titles and routine lists show the editable label, and duplicate labels use
  collision-free internal session identifiers.
- Directory listings are transient and never written to fleet snapshots, logs,
  diagnostics, or persistent caches.

## Embedded Windows Session Workspace

- The Windows app embeds a full ConPTY-backed terminal for every managed local
  or remote Linux/WSL or Windows-backend session. Each tab owns one validated
  direct-argv WSL/wtmux attach process; renderer code never receives Node.js
  access or process handles.
- Tabs remain attached while the app is hidden to the tray. Closing a tab only
  detaches. Unexpected exits retry with bounded backoff, while confirmed session
  removal, app quit, and explicit tab close stop retries.
- Tab descriptors and view preferences survive restart, but terminal output,
  conversations, drafts, and thumbnails do not. Restored tabs reconnect to
  surviving tmux sessions and show a recoverable ended state otherwise.
- Codex, Claude, and Copilot open Native-first. Native view provides newest-page
  loading, upward history pagination, safe Markdown, semantic grouped tools,
  approvals, multi-question forms, plan-mode indication, a multiline composer,
  and Terminal fallback. Basic shell sessions expose directory navigation,
  command entry, and command/result cards; unsupported or alternate-screen
  programs use the full terminal.
- Native single and boolean questions advance on tap and submit immediately
  when final. Multi-select uses Done and text uses Send. Answers remain editable
  through failures. Success is shown only after the provider transcript
  confirms delivery; stale or ambiguous terminal state fails safely with Retry
  and Terminal actions.
- Native view accepts PNG, JPEG, and WebP images from clipboard, drag/drop, and
  picker, with at most eight 20 MiB items. Images are staged through
  `wtmux image send --json`, shown as thumbnail chips, and their host paths are
  submitted only when Send is pressed. Raw Terminal view has no attachment UI.
- Native messages use safe Markdown with raw HTML, scripts, unsafe links, and
  remote image loads disabled. Enter sends and Shift+Enter inserts a newline.
- Inactive tabs show ordinary unread activity and stronger attention for
  questions, approvals, limits, and disconnects. Terminal settings cover theme,
  font family/size, line height, cursor, padding, scrollback, and copy/paste.

## Embedded Workspace Success Criteria

- An installed build opens local and remote Linux and Windows-backend sessions
  in-app, preserves full terminal behavior, restores tab descriptors, reconnects
  safely, and leaves tmux sessions alive after tab close or app restart.
- Real disposable Codex, Claude, and Copilot sessions pass Native messages,
  tools, approvals, planning state, and questions. Android Native questions pass
  real Codex and Claude flows on the S23FE before the Windows build is promoted.
- Image paste, drop, picker, retry, removal, multiple-image submission, target
  selection, and cleanup work without automatic submission.
- Settings, app data, logs, diagnostics, and notifications contain no terminal,
  transcript, draft, or image-preview content after normal use and restart.

## Native Workspace Reliability And Actions

- Each Native tab opens on the newest conversation content and owns independent
  scroll state. Prepending history preserves the visible anchor; new content
  follows only near the bottom and otherwise exposes a New messages action.
- Incremental feed updates preserve focus, drafts, expanded tools, questions,
  and approvals. Consecutive tools are grouped, but every collapsed row names
  its action, target, state, duration, and useful counts; expansion shows
  ordered semantic input/output before optional raw data.
- Pending questions and approvals replace the composer with a compact pinned
  action bar and viewport-bounded sheet. Single/boolean taps advance or submit,
  multi-select uses Done, text uses Send, and prior answers remain editable
  until transcript confirmation.
- A matching host-detected hard limit appears both in Native view and global
  attention surfaces within five seconds. Schedule Continue defaults to reset
  plus one minute, supports time editing, and resolves the originating event;
  Dismiss resolves it fleet-wide.
- The workspace action menu offers Close and Kill. Close only detaches the app
  tab and prompts only for a draft or staged attachments. Kill confirms the
  named session, destroys its tmux session, cancels schedules, and closes the
  local tab after host confirmation.
- Commands, output, diffs, paths, tool blocks, and fenced Markdown expose an
  explicit Copy action and local confirmation without logging clipboard text.

## Packaged Terminal Reliability And Performance

- Every session explicitly opened in Agent Fleet owns one attached PTY and can
  switch between Native and the exact live terminal. Sessions merely attached
  in VS Code or Windows Terminal remain discoverable but are not opened as app
  tabs automatically.
- Packaged ConPTY launch resolves the selected WSL executable to an absolute,
  validated Windows system path. A deterministic WSL, ConPTY, or native-module
  failure stops retrying and shows Retry plus VS Code and Windows Terminal
  fallbacks; only a previously live PTY may reconnect automatically.
- The renderer binds before terminal output is released, shows the current tmux
  screen, and retains subsequent output in memory only. It does not import tmux
  scrollback from before Agent Fleet attached.
- Open PTYs remain attached while tabs are inactive or the window is hidden,
  but inactive terminal rendering and Native content streams pause. At most one
  Native stream is active, for the selected visible Native tab.
- Heartbeats and unchanged status frames never reconstruct the workspace DOM.
  Terminal elements remain stable across Native updates and keyed feed changes
  preserve scroll, focus, drafts, questions, and expanded details.
- With the current three-tab Codex, Copilot, and Shell mix idle for 30 seconds,
  total Agent Fleet process-tree CPU averages below 2% while visible and below
  1% while hidden over a 60-second sample. Ordinary tab and view changes respond
  within 250 ms.
- Diagnostics may contain sanitized WSL/ConPTY availability, stable failure
  codes, and PTY counts, but never command arguments, terminal output,
  transcripts, drafts, or attachment content.

## Native Structured Work And Interaction Reliability

- Consume stable additive `task_list` and `plan` records from wtmux. A task
  board updates in place, highlights active work, bounds large lists around it,
  and collapses when complete; Markdown plans open in a dedicated viewer.
- Tool feed cards remain small and semantic. Full ordered input/output moves to
  a dedicated viewport-bounded viewer with terminal output wrapping,
  horizontal code/path scrolling, per-block Copy, and optional Raw data.
- Pending question/approval sheets scroll independently with their navigation
  and delivery actions fixed. Exact wtmux-verified Plan gates are tappable;
  unknown terminal screens fail closed and retain the Terminal escape hatch.
- Large task, plan, tool, and question bodies never replace the whole workspace
  DOM. Selected-tab updates coalesce to one animation frame, preserve bottom
  follow and history anchors, and do not jump the conversation to the top.

## Stale Hard-Limit Attention

- Consume only `detected`, `offering`, and `offered` hard-limit attention from
  the bridge. Resolved, expired, dismissed, scheduled, and unknown future states
  never produce cards in the dashboard or Native workspace.
- Dismiss removes the Native card before the host round trip. The exact event
  operation is resource-idempotent across unrelated fleet revision changes;
  genuine failures restore the card and explain the failure.
- Recovery authority remains on the wtmux host. Windows never infers recovery
  from rendered terminal text or conversation UI state.

## Four-Pane Session Workspace

- One Sessions navigation entry opens Session Workspace, replacing the separate
  Sessions, Workspace, and Launcher pages while preserving their search,
  favorite, details, rename, attach-command, repository, external-open, session
  creation, and guarded Kill capabilities.
- A 180-360 px resizable vertical rail lists every live or reconnectable fleet
  session. Favorites appear first; local focus MRU orders each section and
  remote update time orders sessions never focused locally. Rail-only sessions
  do not own a local connection.
- Sessions whose host is connecting or offline remain visible as last-known,
  unavailable records. Remote actions are disabled and Hide removes only the
  local cached record. A hidden session returns only when a healthy
  authoritative snapshot confirms it; an assigned pane remains reconnecting
  and becomes ended if the host returns without the session.
- The workspace starts as one pane and supports Split Right, Split Down, Single,
  Two Columns, Two Rows, and 2x2 layouts up to four panes. Dividers resize by
  pointer or keyboard, compact pane title chips swap assignments by drag, and
  each pane independently displays Native or Terminal.
- Closing or replacing a pane detaches Agent Fleet without ending tmux. Kill is
  always explicit and guarded. Replacements warn only for a Native draft or
  staged attachment; ended remote sessions retain their pane and an ended banner.
- A host-offline race reports that no change was made, with diagnostic metadata
  secondary. Kill refreshes and retries one stale fleet revision with the same
  idempotency key, and an absent session is reported as already stopped.
- Layout tree, ratios, assignments, focused pane, per-pane mode, rail state,
  MRU, and window bounds persist atomically. Version-1 state migrates its
  selected tab to one pane; content, drafts, attachments, and transcripts remain
  memory-only.
- Assigned PTYs remain attached while the app is hidden or another page is
  shown. Only visible Terminal panes bind output and only visible Native panes
  stream conversation data. Snapshot and heartbeat updates patch keyed metadata
  without remounting xterm, replacing composer elements, or stealing focus.
- Agent Fleet never owns a display/screen-saver power request. An explicit
  repository download may temporarily prevent system suspension while allowing
  display sleep, and releases that lease on every terminal state.

## Windows Single-Pane Renderer Reliability

- An assigned pane without its terminal descriptor renders an explicit
  Opening session state. Descriptor arrival, disappearance, identity changes,
  Native/Terminal switches, and terminal failure transitions remount the pane
  structure; ordinary status and heartbeat text remains a keyed patch.
- The pane-tree root stretches either a direct pane or a split root across the
  complete workspace area beneath the existing app header and workspace
  toolbar. Visible xterm instances refit after structural rendering, split
  resizing, rail resizing, and window resizing.
- The dashboard overlay host does not participate in the dashboard grid, so the
  workspace column, mount, pane tree, and Native or Terminal surface extend to
  the bottom of the viewport at every supported window size.
- This is a Windows renderer-only beta.12/beta.13 correction. It changes no wtmux
  protocol, persisted workspace schema, IPC contract, or Android behavior; the
  Android wide-workspace implementation already owns independent Compose
  sizing and renderer lifecycles.

## Focused-Pane Workspace Chrome

- Every pane has a compact overlay chip containing pane number, connection
  status, truncated title, and an N/T mode badge. The focused border and chip
  identify the active pane; clicking pane content focuses it and dragging the
  chip swaps assignments.
- The workspace toolbar owns exactly one Native/Terminal switch, conditional
  Retry, and More menu. These controls resolve the focused pane at action time;
  Detach and Close are no longer repeated in pane headers.
- Empty, opening, unavailable, and ended panes keep the same toolbar positions,
  disable invalid actions, and retain Close in More. Assigned panes without a
  descriptor show Opening session rather than blank content.
- Focus, status, and heartbeat changes patch only chips and toolbar chrome.
  Native scroll and drafts, terminal focus, and xterm instances stay mounted.

## Instant Local Terminal History

- In alternate-screen Codex, Claude, and Copilot terminals, a History/Remote
  control makes ordinary scrolling open a terminal-styled structured history
  overlay. Shells, normal-screen programs, and unsupported adapters retain
  their existing terminal scrolling and mouse behavior.
- After two quiet seconds, each visible eligible terminal may prefetch one
  bounded 100-item snapshot through the existing no-follow conversation API.
  Requests are serialized and the focused pane is prioritized. Older pages load
  near the top up to 2,000 items; errors never auto-retry.
- History is memory-only. It is cleared with the tab/app lifecycle and never
  written to workspace state, logs, diagnostics, or terminal scrollback.
- Keyboard input continues to target the hidden live PTY while History is open.
  Remote mode explicitly returns wheel input to the remote application. Closing
  at the bottom returns to Live; new terminal output marks a cached view Updated
  and refreshes only after returning Live.
- Paging, status, and overlay changes do not reconstruct the xterm instance,
  Native view, draft, focus, or workspace tree. Copy is explicit and clipboard
  contents remain local and unlogged.

## Seamless Prefetched Tmux Scrollback Correction

- Retire the structured History/Remote/Live overlay and controls. Upward
  scrolling in an eligible alternate-screen terminal must continue to look and
  behave like xterm, with no conversation cards or separate history mode.
- After 900 quiet milliseconds, fetch up to 2,000 rows of bounded
  `pane.scrollback` ANSI through wtmux, validate its session, dimensions,
  base64 payload, size, and SHA-256 revision, and retain it in renderer memory
  only.
- Render cached ANSI in a read-only xterm sidecar with the live terminal's
  theme, font, geometry, and pane bounds. The live xterm and PTY remain mounted;
  typing or scrolling to the cached bottom removes the sidecar and focuses Live.
- Resize, detach, failure, view changes, and dimension mismatches invalidate the
  cache. A failed prefetch retries only after later terminal activity; there is
  no background retry loop or visible history error surface.

## Local Reply Suggestions

- Native conversations expose an app-local Off, Manual, or Automatic mode.
  Manual retains the opt-in Suggest action after completed assistant messages
  and in structured free-text answer fields. Automatic prepares one to three
  selectable replies for each newly completed eligible response or active text
  question in the focused Native pane. Selecting fills the draft and never
  submits; no mode writes into or sends from the composer by itself.
- Automatic mode baselines initial snapshots, reconnects, session opening, and
  focus changes so historical replies never start inference. Stable target and
  conversation revisions prevent duplicate requests. Typing, attachments,
  newer context, pane changes, backgrounding, and mode changes cancel stale
  work; ordinary tool/status frames and history paging do not.
- Each request contains only the newest 12 visible user/assistant text messages,
  newest-first bounded to 12 KiB UTF-8. Tool activity, terminal output,
  attachments, hidden content, approvals, and choices are excluded. The prompt
  treats that transcript as quoted context and ends with an explicit task to
  produce one to three concise messages the human user can send verbatim.
- Suggestions must respond to the latest assistant message or structured text
  question rather than explain, interpret, summarize, or restate it. They match
  the user's recent language, fall back to the assistant's language, and return
  fewer options instead of padding an irrelevant set.
- Managed mode launches a user-selected `llama-server.exe` and GGUF with fixed
  safe arguments: loopback ephemeral port, random API key, 4,096 context,
  automatic fitting GPU layers, and 60-second idle sleep. Agent Fleet owns and
  terminates the process on disable, replacement, and quit.
- External mode accepts only a loopback OpenAI-compatible server implementing
  `/v1/models` and `/v1/chat/completions`. An optional bearer token is
  encrypted locally. Backend settings are machine-local and excluded from
  exported settings, diagnostics, logs, and workspace data.
- The feature is off by default. One request may run at a time, cancellation and
  stale results are safe, and setup/test/failure states are actionable. External
  processes own their RAM; the UI states this explicitly.


## Native questions and conversation refresh (2026-09-21)

Approved scope: reliable automatic submission of the final answer in supported
question groups (1, 2, 3, 4 and 8), explicit Sending state, provider-confirmed
completion, and retained answers with Retry on failed or unconfirmed delivery.
Async Codex follow-up questions remain available while work and the composer
continue. A persistent bar opens them without stealing focus; multiple requests
are selectable and dismissing the form preserves drafts. Defaults never submit
automatically. Blocking requests take priority over async requests.

Both clients use neutral user bubbles, plain assistant text, compact tool rows,
rounded composers and theme-aware neutral question surfaces. Navigation stays
unchanged. Existing source fields identify async questions; no protocol schema
change or intentional user-visible platform divergence is introduced.


## Native Conversation and Detailed views (2026-09-22)

The approved wtmux SPEC and implementation plan govern this shared workflow.
Conversation is the device default and Actions remembers Conversation/Detailed
across sessions. Conversation keeps user/final/unknown prose, review plans and
artifacts, with the latest identified progress while running and one expandable
Activity per turn. Detailed retains the event timeline. Existing pinned question
and approval sheets remain actionable. Preserve drafts, attachments, text sizing,
manual expansion and the visible message when changing views.

Negotiate conversation.turns.v1 only with capable hosts; older hosts retain
conservative per-event disclosures and an update hint. Load Activity read-only in
25-entry pages, at most eight cached turns, 200 entries per turn and 4 MiB, with
obsolete requests cancelled. No extra AI calls, idle polling or transcript files.
Windows delivers source parity without an installer publication; Android uses
the signed in-app updater after emulator and release gates. Physical phone smoke
is user-operated. This is the only intentional delivery difference.

## Native loading and earlier questions (2026-09-22)

Before the first provider result, Native shows Connecting/loading and disables
actions without declaring the provider unsupported. An explicit unsupported
result remains visible. Snapshot refreshes, view changes and history paging
preserve provider-confirmed question completion for the same request and session,
with bounded local receipt memory and conservative identity matching.

Unanswered async questions older than a later user message remain available in
an expandable Earlier questions section, outside the current waiting count.
Moving a question there never marks it answered or expires it. Compare valid
timestamps across all loaded messages, using transcript order only to break
equal timestamps; unknown timestamps remain current. Preserve drafts and the
composer. Blocking questions and approvals retain the current action surface.
Windows and Android share this behavior; Windows source delivery only remains
the intentional release difference.


### Host file links and previews — approved review scope (2026-10-06)

The approved specification is in
`/home/sapir_cz/projects/wtmux-host-files-20261006/SPEC.md`, section
“Host File Links And Previews”. A selected file opens in a separate preview
bound to its originating managed session and host. Relative references use the
stored project root. Readable regular files outside the project are supported.
Native message/tool/code links and terminal file links share this routing.
Preview bytes remain private; Save publishes verified bytes to Downloads.
Refresh reads current host bytes. Standalone HTML supports inline scripts with
network, neighboring files, application APIs and external navigation blocked.

Images, PDFs, bounded text/Markdown, standalone HTML and Save/Open recovery have
equivalent Windows and Android behavior. Text is bounded to 1 MiB, HTML to 16 MiB,
confirmation begins above 50 MiB, and transfers stop above 2 GiB. Android cancels
in-flight transfers when the viewer backgrounds and offers Retry on return.
Windows terminals use Ctrl+click; Android uses a tap and tracks OSC 8 targets.
Windows maps filesystem-reserved host filenames to safe local names while showing
the original name. Android SVG previews also use the 16 MiB HTML bound to avoid
unbounded base64 allocation. The VS Code Companion supports visible paths and an
Open Host File command; hidden built-in OSC 8 targets retain the approved caveat.

Delivery ends at local source, validation and review packages. Publication,
physical-device installation and activation on live hosts require a later request.


## Wrapped host-file links — approved correction (2026-10-07)

The supplied execution plan authorizes implementation and review packages; no new interview or rollout is requested. Both reported cases are tmux scrollback displayed in Terminal. The Live badge indicates connectivity, not the age of the displayed output. Fleet History is a separate reconstructed reader.

Recognize complete parentheses, quote and backtick path groups across hard rows, including short rows. Keep filename spaces and Unicode; remove only the origin indentation, list content indentation or the exact hanging column. Reject incomplete groups, ambiguous whitespace, multiple independent paths and over-limit groups. Apply verified OSC 8 targets first; reserve all delimited groups before ordinary extraction. Return one UTF-16 range per visible segment, excluding indentation and delimiters, with the complete target and originating host/session/project binding. Bounds remain 32 rows, 8192 text units and 2048 target units.

History uses tmux capture-pane -e -J and truncates at complete records. Companion uses read-only pane.links.v1 over wtmux pane links; it reads bounded scrollback and the copy-mode screen, rejects duplicate or conflicting rows, and returns a snapshot revision. One pending lookup per terminal, cancellation and a one-second cache keep hover bounded. Activation revalidates snapshot, reference and binding. No file bytes or Native snapshots are loaded during detection.

Delivery is local reviewed sources, runtime/Windows/Android/Companion packages, hashes and evidence. Publication, installation on the three PCs, and the phone updater rollout remain a later decision. No physical-phone automation.


## Native startup, quiet host status, and notification recovery — approved 2026-10-07

The owner approved SPEC, PLAN, and execution, including combined deployment with the completed wrapped-file-link changes. Active app restarts and VS Code reloads require a prepared, separate approval.

- Show the last loaded same-session Native conversation immediately while refreshing. Keep a four-session memory-only newest-page cache, at most 256 KiB per entry and 1 MiB total. Preserve drafts and retained reading position; require fresh authoritative state for mutations. Invalidate changed bindings and removed sessions.
- Retain healthy foreground streams across same-target bindings and Native/Terminal switches. Cancel obsolete/background work. Produce bounded newest content before slow startup enrichment, without extra AI calls or persistent transcript caches.
- Suppress routine offline/recovered alerts on Android and Windows, including existing enabled preferences. Keep status dots, session notifications, and actionable errors.
- Notification launch preserves the intended session and remembered surface. Quiet automatic recovery permits one pending attachment per terminal, backs off at 1/2/5/10/30 seconds while visible, pauses on confirmed offline state, and resumes on availability changes or Retry. Trust, authentication, configuration, missing-session, and explicit-close outcomes do not loop.
- Managed recovery must attach only to the existing exact session; it must never create a replacement or select an adjacent/prefix session. Add explicit existing-only CLI support and negotiate exact remote attachment.
- Acceptance uses actual Windows interactions and protected API 36 Native switches/notification taps, usable recovered SSH terminal input/output, and stale-action/duplicate-work rejection. Measure 20 warm and 20 cold entries: p95 cached content <=500 ms; first fresh content <=5 s on a healthy reachable host with provisioned runtime and RTT <100 ms. Include large histories and the earlier wrapped-link acceptance.
- Deploy verified coordinated packages to gaming-desktop first, then reachable work/work-m; offline targets stay pending. Include Windows Agent Fleet, WSL runtimes, all discovered Companion profiles, and signed Android fleet/latest. Phone updater installation and smoke are owner-operated. Preserve sessions, history, configuration, pairing, and trust. Track prepared/installed/active/verified separately.


## Stable terminal entry and on-demand WSL — approved 2026-10-08

Owner supplied the execution plan directly. Preserve every ordered terminal byte and parser state; coalesce dimensions, hide intermediate entry/reconnect/resize screens, reveal after a drained queue and 150 ms quiet, offer Show live after two seconds, and reveal failures immediately. Preserve reading position, selection, History and complete file links. Validate Windows first and protected API36 Android; do not operate the physical phone or alter Codex/tmux configuration.

Windows Keep Linux connections active in the background defaults off. Tray-only startup and the quota overlay use cache. Visible dashboard and explicit operations acquire Linux demand; after two idle seconds flush state, detach Fleet terminals, stop streams and quota/retry work. Transfers hold their own demand until complete. Delayed startup must not revive idle work. Reopen verifies fresh host state. Never shut down WSL, stop tmux sessions, or stop other applications' connections. This setting is Windows-specific because Android has no WSL process lifecycle; terminal presentation is shared.

Export and retain standalone keep-alive tasks/configurations, locate recreators, disable only verified entries and stop only verified owned processes. Remote work follows the owner's remote-command gate. Prepare verified review packages before any active app restart; Gaming Desktop is the canary, then reachable Work/Work-m. Publish Android through the canonical signed updater after release gates; installation and phone smoke remain owner-operated.

History remains open on both clients through settled resizing. Windows resizes its pinned xterm History reader and stages a fresh capture without replacing the reader snapshot.
Isolated verification profiles must preserve the installed application's Windows startup registration and shortcut. Packaged smoke compares both before and after its temporary-data run.


## Native Markdown and session creation compatibility — 2026-10-09

Both clients display GFM tables, task checkbox states, strikethrough, explicit and bare safe links, line breaks, headings, lists, quotes and code fences. Raw HTML stays literal and remote images remain explicit placeholders. Android tables expose a horizontally scrollable grid and a Copy table action (tab-separated plain text); Windows uses its existing selectable HTML table. These platform controls differ to retain Android text selection and fit narrow screens.

New-session creation keeps the selected physical host, execution target, folder, label and tool across snapshot refreshes and failures. The form stays open until confirmed success, disables editing/submission while pending, and displays persistent failure details. A definite pre-execution stale-revision rejection permits one fresh-snapshot retry with a new idempotency key. Unknown outcomes never retry automatically and require checking Sessions before another manual attempt. Only successful creation records a recent folder.

This work changes client behavior without changing the shared wire contract. The original phone's two failed Windows Git Bash attempts remain unclassified until its metadata-only diagnostics archive is received. No release rollout is authorized by this implementation task.

Publication approved by the owner on 2026-10-09: commit/push and publish Windows
0.11.0-beta.35 and signed Android .107. Installation, active app restarts, host
runtime changes and physical-phone automation remain outside this authorization.

Release preflight found existing high-severity advisories, including the packaged
Electron runtime. Refresh compatible locked dependencies within existing major
version ranges, retain the complete high-severity release audit, and rerun source
quality plus Windows packaging/smoke before publication. No forced major upgrades.

## Session diagnostics follow-up — continuing approved fixes, 2026-10-09

The owner supplied the .107 phone export after Linux and Windows attempts. Its
ZIP contains only diagnostics-v2.json and discards event codes. Retain the
strict v2 report and add operations-v1.ndjson on both clients. Each record has
schemaVersion=1, occurredAt, operation, status, code and durationMs. Export only
a fixed operation/status/code allowlist, canonical times within seven days,
at most 200 rows and bounded durations. Unknown codes become operation_failed.
Never export messages, identifiers, paths, transcripts, credentials or raw logs.
Android previews the exact metadata; Windows retains its native Save dialog.
Record creation attempts/outcomes and connection-state changes, rather than
every snapshot. Android retains its existing private journal; Windows retains
a bounded process-memory journal. No wire protocol or diagnostics-v2 schema
changes. Diagnostics storage must not interrupt creation feedback.

Reproduce missing metadata before the fix, test privacy canaries and bounds,
run source quality and protected Android release UI checks, then publish the
approved follow-up releases .108/code1122 and private beta.36 through canonical
processes. Do not claim that this instrumentation repairs the phone connection:
the exact creation and runtime error is still required. No remote configuration,
SSH service, host runtime, app restart or physical-phone automation is authorized.
