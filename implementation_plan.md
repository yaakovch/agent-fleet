# Agent Fleet Private Beta Implementation Plan

Status: approved for execution on 2026-07-12.

The canonical behavior is defined in `SPEC.md`. Changes land as backward-
compatible milestone pull requests. Implementation pauses at the dashboard
prototype, registry removal, pairing dry run, and first private beta release.
The private bridge/runtime companion plan is maintained in
[`yaakovch/wtmux`](https://github.com/yaakovch/wtmux) as
`implementation_plan_agent_fleet_bridge.md`.

## 1. Repository And Release Foundation

- Preserve the legacy private `limits` tree unchanged and develop from a fresh
  `C:\projects\agent-fleet` clone.
- Rename the public repository, mark the unsigned 0.9 release prerelease, adopt
  version `0.10.0-beta.1`, and update project/release metadata.
- Create the private beta-feed repository and a manually dispatched Windows
  build/release workflow tied to an exact public source commit.
- Add the canonical product spec/protocol fixtures here and cross-link the
  private wtmux bridge companion spec.
- Protect release secrets and keep unsigned public updates manual-only.

## 2. Dashboard Prototype — Gate 1

- Build the complete tray/dashboard information architecture against typed
  fixture data while preserving the optional limits overlay.
- Cover overview, sessions, launcher, schedules, fleet/pairing, settings,
  attention states, host health, tray variants, empty/error/offline states, and
  destructive confirmations.
- Approve visual density, navigation, terminology, and interaction behavior
  before real mutations are wired.

## 3. Data-Only Registry — Gate 2

- Add strict versioned JSON schemas, validators, normalized models, safe cache
  generation, and legacy equivalence tooling in wtmux.
- Deploy a compatibility reader to the existing Windows/WSL and Termux fleet.
- Generate JSON records/presets, compare every field, confirm capability, then
  remove executable fragments in one reviewed migration PR.

## 4. Live Read-Only Vertical Slice

- Implement JSONL protocol v1, host snapshots/events, the local WSL controller,
  persistent per-host SSH streams, heartbeat/reconnect, pagination, and typed
  stable errors.
- Add Electron bridge supervision, IPC/preload types, strict validation,
  verified cache, stale/offline state, and the read-only live dashboard.
- Add cross-repository protocol fixtures and version-negotiation tests.

## 5. Session Control And Launching

- Add revisioned/idempotent create, rename, kill, unified launcher, safe profile
  discovery, favorite preset, doctor, and confirmed backend-update operations.
- Atomically cancel pending schedules during session kill.
- Implement direct-argv Windows Terminal opening and the VS Code URI/terminal
  extension path.
- Keep incompatible hosts read-only until a successful repair.

## 6. Schedules, Attention, And Notifications

- Add pending schedule edit, cancel, paginated 30-day history, UTC/time-zone
  handling, worker reconciliation, and delivery-race tests.
- Stream hard-limit, delivery, host, version, and pairing attention events.
- Add fleet-wide actionable resolution, local PC acknowledgements, notification
  deduplication, pause controls, and tray severity state.

## 7. Repo-Less Pairing And Runtime Bundles — Gate 3

- Package versioned checksummed wtmux user runtimes with atomic activation and
  rollback.
- Implement expiring/replay-safe invitations, desktop discovery/short code,
  copy link, file, QR, proposal review, approval/rejection, revocation, and
  provider-neutral registry publication.
- Implement the GitHub provider on trusted controllers and cached registry/
  runtime serving to repo-less clients.
- Add `wtmux pair` and complete the real outbound-only Termux checkpoint.

## 8. Hardening, Migration, And Private Beta — Gate 4

- Complete Agent Fleet branding, settings v3, legacy data/startup/shortcut/
  updater migration, backup, rollback, and uninstall behavior.
- Remove localhost CSP access; retain Electron sandbox/isolation, validated IPC,
  navigation blocking, permission denial, fuses, bounded sanitized logs, and
  explicit diagnostics export.
- Add private beta update checks/downloads through authenticated controller
  `gh`, checksum verification, controller caching, install, and rollback.
- Run typecheck, unit/integration/Bats/contract/security/package/installer smoke,
  dependency audit, secret scan, SBOM, and real-machine acceptance.
- Install on both Windows PCs, verify update/rollback, then begin the 14-day
  two-PC/two-host/Termux soak.

## Definition Of Done

- All SPEC success criteria pass.
- The four product gates are approved.
- Both repositories are clean, reviewed, and synchronized.
- The beta feed identifies exact source commits and publishes checksums.
- The soak completes with no critical security, delivery, registry, migration,
  or recovery defect.

## 9. Arbitrary Location Session Launcher

- Extend protocol parsing and capability negotiation for transient directory
  listing/creation and optional path-based session creation before enabling host
  emission of additive fields.
- Build the staged Host, Backend, location, folder, label, and tool launcher with
  Projects, Other location, shortcuts, recents, New Folder, and explicit Use
  this folder actions.
- Store at most ten recents per host/backend in local app settings, purge missing
  entries on use, and keep directory responses out of snapshots and diagnostics.
- Show full paths only in Session Details, preserve clean labels throughout the
  dashboard, and test Linux/WSL plus Windows drive-backed sessions.
- Package Windows beta.3, deploy clients before host capabilities, run contract,
  renderer, IPC, security, package, and two-machine acceptance checks, then keep
  beta.2 available for rollback.

## 10. Embedded Terminal And Native Workspace

- First reproduce and repair Native question delivery with disposable Codex,
  Claude, and Copilot sessions. Extend the wtmux terminal state machines for
  sequential questions, multi-select, Other/text input, final review/Submit,
  stale revisions, idempotency, and transcript-confirmed delivery. Ship the
  compatible runtime to both hosts and the phone, then release and validate
  Android `0.118.4-agentfleet.17` (`1019`).
- Add stable xterm.js rendering and a main-process node-pty/ConPTY manager. Spawn
  only validated direct-argv `wsl.exe` attach processes, expose bounded
  sender-validated lifecycle/input/output IPC, and prove the native dependency
  in an installed package before building the larger workspace.
- Add reconnecting dashboard tabs, descriptor-only restoration, unread and
  attention badges, Native/Terminal switching, external-open actions, terminal
  preferences, settings migration to the `agentFleet` default target, and
  rollback-safe settings backup.
- Add strict conversation-v2 types and fixtures, newest-page history loading,
  safe Markdown, grouped semantic tools, approvals, plan indication, reliable
  questions, Codex/Claude/Copilot adapters, and basic shell navigation and
  command cards. Keep an underlying PTY authoritative and fail to Terminal for
  unsupported or alternate-screen states.
- Add Native-only clipboard, drag/drop, and picker image staging with bounded
  PNG/JPEG/WebP validation, thumbnail chips, retry/remove, `wtmux image send
  --json`, submission-time path insertion, and temporary-file cleanup.
- Run unit, protocol, Python/Bats, security, packaged-ConPTY, installer, and live
  acceptance checks. Install `0.11.0-beta.1` on gaming-desktop first, require the
  full same-day matrix, then promote the identical artifact to work-m. Retain
  beta.3, the prior runtime, and a forward-code Android rollback build.
