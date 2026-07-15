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

## 11. Native Reliability Release

- Replace full workspace rerenders with keyed incremental feed updates and
  per-tab bottom-follow, anchor-preserving pagination, unread, and New messages
  behavior.
- Align tool lifecycle merging with Android, add human-readable grouped details
  and complete code-block copying, and pin transcript-confirmed questions and
  approvals in place of the composer.
- Feed live fleet attention into each workspace, add linked schedule/edit/dismiss
  actions, and add guarded Close/Kill commands to the tab toolbar.
- Cover scroll, reconnect, tools, forms, copying, limits, draft guards, and
  session actions in renderer/IPC tests; then run lint, unit, build, directory
  package, and packaged smoke checks.
- Package `0.11.0-beta.2`, validate and install it on gaming-desktop in the
  same-day gate, then promote the identical artifact to work-m before Android
  parity is released.

## 12. Packaged Terminal And CPU Hotfix

- Resolve and validate an absolute Windows `wsl.exe` path for node-pty, add a
  renderer-ready output handoff, and classify deterministic startup failures as
  non-retryable with in-app Retry, VS Code, and Windows Terminal fallbacks.
- Keep PTYs attached but scope Native streams and rendering to the selected
  visible view. Replace heartbeat-driven workspace reconstruction with keyed,
  no-op-aware updates that never remount xterm unnecessarily.
- Add sanitized terminal health to diagnostics and cover path resolution,
  failure classification, reconnect, initial output, visibility, heartbeat,
  and state preservation in unit and renderer tests.
- Add packaged ConPTY/WSL smoke coverage plus a repeatable three-tab process-
  tree CPU benchmark using 30 seconds of settling and 60 one-second samples.
- Package `0.11.0-beta.3`, run the full Windows suite plus wtmux and Android
  regressions, and install on gaming-desktop. Promote the identical installer
  to work-m after the functional smoke even if CPU still misses its target; in
  that case continue to a performance-only beta.4 before closing the milestone.

Acceptance record (2026-07-14): beta.3 passed 72 Windows tests, the signed
packaged ConPTY/WSL smoke, three restored live PTY attaches, and 60-sample CPU
gates at 0.000% average in both hidden and visible states. The shared wtmux
Python/Bats/smoke suites and Android debug unit suite also passed.

## 13. Terminal-Like Native Tool Details

- Consume ordered semantic action blocks from conversation v2 and render one
  action directly or several actions as individually expandable rows.
- Keep state and duration in the call header, readable output below actions,
  per-block Copy controls, bounded previews, and complete raw data collapsed.
- Release Windows beta.4 first, then the matching signed Android update with
  the same renderer behavior and the current wtmux runtime baseline.

## 14. Structured Work And Interaction Repair

- Consume additive task/plan records and the byte-identical shared golden
  fixture used by wtmux and Android; merge one stable task board in place and
  suppress redundant generic Working/Done activity.
- Bound feed previews and move full semantic tools and Markdown plans into
  dedicated viewers with wrapping, horizontal scrolling, Copy, and Raw data.
- Replace pending cards with a pinned action bar and scrollable sheet. Use
  immediate single/boolean tap delivery, Done for multi-select, and Send for
  text while retaining revision and transcript confirmation.
- Coalesce selected Native updates, preserve scroll/focus/drafts, and cover long
  tools, tasks, plans, questions, and plan gates with renderer and contract
  tests.
- Package `0.11.0-beta.5`, deploy it to gaming-desktop and work-m before the
  matched Android and host runtime updates, and retain beta.4 for rollback.

## 15. Session Repository Downloads

- Consume transient strict repository list/search pages without persisting file
  names in the fleet cache, diagnostics, or logs.
- Stream files through the direct WSL `wtmux file download` argv into Windows
  Downloads with bounded progress parsing, collision-safe verified completion,
  cancellation, and notifications while the tray window is hidden.
- Replace scattered session icon buttons with a clear More menu and add a
  repository browser to both that menu and embedded workspace Actions.
- Confirm files above 50 MiB, expose recursive search and hidden-file control,
  and provide Open and Show in folder completion actions.
- Test strict parsing, cache exclusion, direct argv construction, progress,
  completion, cancellation, renderer compilation, and the production build;
  release as `0.11.0-beta.6` before the matched Android APK.

## 16. Stale Hard-Limit Attention Hotfix

- Defensively allow only active attention states through the Windows fleet
  adapter and suppress a Native card immediately when Dismiss is tapped.
- Preserve suppression while unrelated snapshots arrive, clear it after host
  acknowledgement, and restore the card only on a genuine mutation failure.
- Treat already-resolved host responses as successful idempotent completion,
  validate the full Windows suite, and package `0.11.0-beta.7` before activating
  the matched Android and wtmux runtime releases.

## 17. Repository Browser Readiness Hotfix

- Wait through a starting or cached controller for transient directory and
  repository reads, then let the shared bridge own selected-host readiness.
- Preserve the last folder/search operation and offer Retry without combining
  an error with an empty-folder state or changing repository protocol data.
- Run the full suite, production package, and real text/binary download smoke;
  ship `0.11.0-beta.8` before Android `.30` and retain beta.7 for rollback.
