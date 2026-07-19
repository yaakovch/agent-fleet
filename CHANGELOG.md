# Changelog

## 0.11.0-beta.20 - 2026-07-19

- Reused the coding-agent titles already shown by tmux and VS Code throughout
  the Sessions dashboard, workspace rail, embedded tabs, tray, and external
  open targets while retaining the stable `project:N` identity underneath.
- Preserved manual rename overrides and added an explicit reset to automatic
  naming without changing the internal tmux session identity.
- Added a default-on per-device privacy toggle that stops title negotiation and
  purges cached titles, plus a separate presentation revision so title refreshes
  do not invalidate fleet mutations or remount live terminals.

## 0.11.0-beta.19 - 2026-07-19

- Added Off, Manual, and Automatic local-reply modes for Native conversations.
- Automatic mode prepares selectable drafts for each new focused-session reply
  or free-text question without filling or sending anything by itself.
- Added historical-snapshot baselines, exactly-once revision guards, cancel-on-
  input/navigation behavior, Regenerate, and quiet inline Retry handling.

## 0.11.0-beta.18 - 2026-07-19

- Added one compact current-session model and reasoning-effort control to the
  focused Native or Terminal workspace toolbar for Codex, Claude, and Copilot.
- Added provider-discovered catalogs, private custom model IDs, exact-session
  revisions, safe idle queuing, cancellation, expiry, and effective-selection
  reporting without restarting agents or changing project/global defaults.
- Added cache/cost acknowledgement after replies, strict protocol validation,
  and packaged ConPTY smoke coverage for both WSL-equipped desktops and CI.

## 0.11.0-beta.17 - 2026-07-18

- Reworked local suggestions to draft messages the human user can send
  verbatim instead of explaining or paraphrasing the assistant response.
- Put the direct-reply task after quoted conversation context, match the user's
  recent language, and prefer useful acknowledgments, next steps, or questions
  without padding the result set.
- Kept inference user-triggered, local, conservative, and outside the wtmux
  protocol, workspace state, logs, diagnostics, and automatic submission.

## 0.11.0-beta.16 - 2026-07-17

- Added opt-in, user-triggered local reply suggestions to Native composers and
  structured free-text questions; choosing a suggestion fills but never sends.
- Added app-managed llama.cpp and loopback-only OpenAI-compatible backends with
  bounded private context, encrypted optional credentials, cancellation, and
  stale-result protection.
- Kept local inference off by default and outside settings exports, workspace
  state, diagnostics, logs, terminal panes, and the wtmux protocol.

## 0.11.0-beta.15 - 2026-07-17

- Added instant, memory-only structured history over alternate-screen Codex,
  Claude, and Copilot terminals, with quiet prefetch and bounded paging.
- Kept keyboard input attached to the live terminal while History is visible,
  and made Remote mode explicit for applications that consume wheel input.
- Preserved the live xterm instance and returned to fresh terminal output when
  closing history, including slow-link updated and retry states.

## 0.11.0-beta.14 - 2026-07-16

- Replaced full pane headers with compact draggable pane title chips.
- Moved Native/Terminal, Retry, and More into one focused-pane toolbar control set.
- Preserved xterm, Native scroll, drafts, and focus during pane-focus and status-only chrome updates.

## 0.11.0-beta.7 - 2026-07-15

- Hide stale hard-limit cards immediately after Dismiss and keep them hidden
  through unrelated fleet updates; restore only after a genuine host failure.
- Accept idempotent already-resolved dismissals and show only active hard-limit
  attention states in dashboard and Native session views.

## 0.11.0-beta.6 - 2026-07-14

- Added a streamlined session More menu with repository folder browsing,
  recursive file-name search, and explicit hidden-file control.
- Added verified background downloads to Windows Downloads with large-file
  confirmation, progress, cancellation, completion notifications, and Open or
  Show in folder actions.
- Added Download a file to the embedded session workspace while keeping file
  metadata transient and file bytes outside the fleet snapshot bridge.

## 0.11.0-beta.5 - 2026-07-14

- Added live Codex/Claude task boards and dedicated Markdown plan viewers while
  suppressing redundant generic Working/Done activity.
- Moved complete tools into a bounded terminal-style viewer and kept only short
  semantic previews in the conversation feed.
- Replaced oversized pending cards with a pinned, scrollable question sheet;
  final single/boolean answers submit on tap, multi-select uses Done, and text
  uses Send.
- Coalesced Native rendering and preserved bottom-follow, history anchors, and
  drafts across live structured updates.

## 0.11.0-beta.4 - 2026-07-14

- Replaced Codex orchestration wrappers and transport-result JSON in Native
  tool details with concise commands, paths, queries, and clean output.
- Added terminal-like nested action rows for multi-action tools while keeping
  complete technical input and result behind collapsed Raw tool data.
- Matched Windows and Android tool titles, state, duration, bounded previews,
  and per-action Copy behavior.

## 0.11.0-beta.1 - 2026-07-13

- Added persistent in-app session tabs backed by Windows ConPTY and xterm.js,
  with reconnect, search, resizing, appearance settings, and external-terminal
  fallbacks.
- Added the Native conversation view for Codex and Claude: safe Markdown,
  planning-mode indication, grouped semantic tool calls, approvals, multi-part
  questions, and newest-first history paging.
- Added memory-only clipboard, drag/drop, and file-picker image staging; images
  upload to the selected wtmux session only when Send is pressed.
- Made Agent Fleet the default session-open target while preserving Windows
  Terminal and current-window VS Code choices.
- Repaired Android/native structured question errors and verified real
  three-question Codex and Claude delivery through explicit provider submit.

## 0.10.0-beta.3 - 2026-07-13

- Added session creation in arbitrary accessible folders on Linux/WSL and Windows hosts.
- Added a streamlined folder browser with host/backend recents and new-folder creation.
- Added full session paths to the on-demand Session Details view.

## 0.10.0-beta.2 - 2026-07-12

- Accepted the current bounded host quota metadata in fleet bridge snapshots.

## 0.10.0-beta.1 - 2026-07-12

- Renamed the project to Agent Fleet while retaining the legacy application ID for upgrade continuity.
- Added the approved product specification and private-beta implementation plan.
- Added an exact-source private beta build and release pipeline.
- Added the fixture-driven tray dashboard prototype with overview, sessions,
  launcher, schedules, fleet/pairing, settings, attention states, and contextual
  confirmations while preserving the limits overlay.

## 0.9.0-beta.1 - 2026-07-11

- Added Windows installer and portable packaging.
- Added first-run WSL discovery and explicit Claude integration.
- Added versioned settings import/export, preview, backups, and rollback.
- Added signed-update infrastructure, diagnostics export, local logging, and production hardening.
- Replaced usage fills with full green-remaining/red-used bars.
