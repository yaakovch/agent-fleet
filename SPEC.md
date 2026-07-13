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
- Product/version: `Agent Fleet 0.10.0-beta.1`.
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
  Windows Terminal or a terminal in the current VS Code window.

### Notifications And Attention

- Notify on genuine hard limits, scheduled delivery success/failure,
  interruption, host offline/recovery, version drift, and pairing requests.
- Every running Agent Fleet installation may notify for the entire fleet.
- Host-backed actionable states resolve fleet-wide. PC-specific offline/update
  observations are acknowledged locally.
- A host becomes offline after three missed 10-second heartbeats and produces
  one recovery notice when it returns.

## Privacy And Security

- Agent Fleet displays and stores metadata only: host, project, session/title,
  tool, backend, activity, attached state, limit event, and schedule state.
- Prompts, responses, transcript excerpts, authentication files, and terminal
  screen contents never cross the desktop bridge or enter caches/diagnostics.
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

- Embedded terminal or terminal-output previews.
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
