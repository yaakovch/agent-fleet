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
