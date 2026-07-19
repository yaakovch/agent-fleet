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

## 18. Repository Download Finalization Hotfix

- Consume the corrected shared wtmux receiver on Windows hosts; keep the
  repository protocol and beta.8 client unchanged because browsing, Retry, and
  transfer management are already client-complete.
- Validate the full Windows suite and production build against the shared
  no-hard-link regression, then activate the matched host runtime while
  retaining the previous runtime for rollback.

## 19. Legacy Repository Recovery And Retry Clarity

- Consume the host's typed `repository_unavailable` failure and preserve its
  bounded actionable message instead of replacing it with a generic action
  failure.
- Add `retryable` to repository results. Show Retry only for offline,
  disconnect, and timeout failures; keep permanent session/path errors visible
  without an ineffective action.
- Retain the cold-controller readiness wait, cover permanent error correlation
  and retry classification, run lint plus the full Windows suite, and release
  `0.11.0-beta.9` with beta.8 available for rollback.

## 20. Four-Pane Session Workspace

- Consume the shared workspace-layout-v1 fixture and introduce a pure validated
  split-tree state manager plus atomic version-2 migration and window/rail
  persistence.
- Replace selected-tab-only binding with up to four assigned PTYs and
  differential visible Terminal/Native synchronization. Detach on close or
  replacement, keep assigned PTYs across tray/page transitions, and retain
  bounded output for later renderer binding.
- Build one Session Workspace with the vertical live-session rail, filters,
  launcher drawer, placement actions, split controls and presets, dividers,
  pane swapping, independent view modes, draft guards, explicit Kill, and
  foreground-only keyboard shortcuts.
- Refactor dashboard updates to preserve keyed terminal and composer DOM nodes.
  Add download-only suspension leasing, restored window bounds, and diagnostics
  proving no DISPLAY power request.
- Gate `0.11.0-beta.10` on layout/migration/manager/renderer tests, four
  disposable live sessions, typing through repeated updates, below-2-percent
  idle CPU, packaged smoke, and the elevated power matrix. Validate and install
  on gaming-desktop before promoting the identical artifact to work-m.

Acceptance record (2026-07-15): beta.10 passed 99 Windows tests, production
build/package, packaged ConPTY/WSL smoke, four disposable live PTY restores,
and a 60-sample hidden idle CPU gate at 0.000% average. Elevated
`powercfg /requests` showed no DISPLAY or SYSTEM request in any phase, one
download-only EXECUTION request, and complete release afterward. The shared
wtmux suite passed 146 Python tests, smoke, and 73 Bats cases; the Android API
36 full emulator suite passed. The same unsigned installer (SHA-256
`94593de03e9d03a1ea47bd59acce152548d2bfc7b0646f0f81cdd7f32a60ee94`)
was installed on gaming-desktop and work-m.

## 21. Stale-Session Safety Parity

- Derive session availability from the owning host, render non-healthy records
  as unavailable, disable their remote actions, and add a bounded persisted
  Hide list that clears when a healthy authoritative snapshot arrives.
- Keep assigned panes reconnecting while a host is unavailable and convert
  them to ended placeholders if the recovered snapshot omits the session.
  Report host-offline races plainly and retry one stale-revision Kill with the
  same idempotency key, treating an absent session as already stopped.
- Cover offline rail rendering, Hide/reappearance, assigned-pane recovery, and
  mutation races in the full suite. Package `0.11.0-beta.11`, validate gaming
  first, then install the identical artifact on work-m.

Acceptance record (2026-07-15): beta.11 passed lint, 103 tests, production
build/package, release validation, and packaged smoke. The checksum-verified
unsigned installer
(`23bee4d75a23a8ecc1778228ac20051a8f92983e7ed2724a0c6af3e095ef537f`)
was installed on gaming-desktop first and then reconstructed byte-identically,
installed, and launched on work-m. Host-offline availability, bounded local
Hide, restored-pane recovery, and one-retry stale Kill behavior are covered by
the shared and manager tests.

## 22. Windows Single-Pane Rendering Hotfix

- Include assigned-tab presence and structural descriptor state in the
  renderer signature. Show Opening session while the descriptor is pending,
  remount on descriptor identity/view/failure transitions, and retain keyed
  patching for ordinary status and heartbeat changes.
- Stretch a direct pane root and split root to the complete pane-tree area and
  refit visible xterm instances after structural or container resizing.
- Add pure renderer-state coverage for empty-to-Native, empty-to-Terminal,
  descriptor waiting/arrival/removal, status-only updates, mode changes, and
  terminal failure transitions, plus a stylesheet sizing contract.
- Gate `0.11.0-beta.12` on lint, the full Windows suite, production build and
  package, packaged ConPTY/WSL smoke, and live single/split-pane checks on
  gaming-desktop. Retain beta.11 and promote the identical checksum-verified
  installer to work-m only after the gaming gate.

Acceptance record (2026-07-16): beta.12 passed lint, 114 Windows tests,
production build/package, release validation, and packaged ConPTY/WSL smoke.
An isolated live gaming workspace verified full-size single Native and Terminal
roots, xterm refit across two window sizes and rail resizing, renderer reload/reconnect, two
columns, two rows, and 2x2; the original four-pane workspace was restored
unchanged. The beta.11 artifacts remain available for rollback. Installer
SHA-256 `a6b797ff8485475ee7ee18ea577f6b97732b058d76e805465730d2086c5fc750`
was verified before installation on gaming-desktop and again after transfer to
work-m; both installed binaries report `0.11.0-beta.12` and run in the logged-in
desktop session.

## 23. Windows Full-Viewport Workspace Follow-up

- Remove the dashboard overlay host from CSS Grid sizing so it cannot create an
  empty implicit row below the workspace.
- Extend the stylesheet contract and live packaged renderer check beyond the
  pane tree: the dashboard workspace column must equal the viewport height, the
  workspace mount must equal the padded content box, and the Native or Terminal
  panel must still equal its pane stage after real window resizing.
- Release as `0.11.0-beta.13`, retaining beta.11 and beta.12 for rollback. Gate
  promotion on lint, the complete Windows suite, production packaging,
  packaged ConPTY/WSL smoke, and live gaming verification before installing the
  identical checksum-verified artifact on work-m.

Acceptance record (2026-07-16): beta.13 passed lint, all 114 Windows tests,
production build/package, release validation, packaged sandbox and ConPTY/WSL
smoke, and the strengthened live gaming renderer gate. The packaged and
installed builds verified the dashboard workspace against the full viewport in
single Native, single Terminal, compact and expanded sizes, collapsed rail,
reload/reconnect, two columns, two rows, and 2x2 layouts. A real outer-window
resize from 1877x970 to 1600x900 and restoration also passed. Installer SHA-256
`8daf3bf6ef0b20019135d66107624df2ecc8ccfd78ff1ce84bb03cb66e4f20be`
was verified before gaming installation and again after transfer to work-m.
Both installations contain byte-identical beta.13 app archives (SHA-256
`ef869712003ecd5bc1ac7b972b1c1876c104624cc85db4c9d80e06a48c169671`);
work-m is running in interactive Session 1, and beta.11/beta.12 remain available
for rollback.

## 24. Focused-Pane Chrome And Compact Titles

- Replace every full pane header with a compact draggable number/status/title/
  mode chip and keep the focused border as the primary active-pane cue.
- Move Native/Terminal, conditional Retry, and More to one shared toolbar group.
  Resolve actions from the current focused pane and put Detach/Close in More.
- Patch focus and status chrome without remounting Native or Terminal content;
  retain minimal terminal chip clearance and reuse Native's existing top row.
- Cover empty, opening, ready, failed, unavailable, shell, focus, and drag-swap
  states. Gate `0.11.0-beta.14` on lint, the complete Windows suite, production
  packaging, packaged ConPTY/WSL smoke, and gaming live layout/resize checks
  before promoting the identical checksum-verified installer to work-m.

Acceptance record (2026-07-16): beta.14 passed lint, all 118 Windows tests,
production build/package, release validation, packaged sandbox and ConPTY/WSL
smoke, and an isolated live packaged renderer gate on gaming. Single Native,
single Terminal, compact/expanded window sizes, rail collapse, reload/reconnect,
two columns, two rows, and 2x2 layouts each retained one shared control group,
one compact chip per pane, full-height pane content, and xterm refitting. The
installer SHA-256 is
`deb5f3073495dff081a4c95d7f2f1dbd25ca5468e97e9a21f5aaf02782abcab3`;
it was verified before installation on gaming and again after transfer to
work-m. Both installations contain the byte-identical app archive (SHA-256
`14609043e81bc856bff100c7d07a01496dcdf086d10e1fe61f26a263fa1bd2ed`)
and are running beta.14 in their logged-in desktop sessions. Prior beta.11-
beta.13 artifacts remain available for rollback.

## 25. Instant Local Terminal History

- Add a bounded one-shot history action over the existing conversation stream
  contract and expose it only to renderer-owned Codex, Claude, and Copilot
  terminal tabs. Keep all cached items renderer-memory-only.
- Prefetch after two quiet seconds, serialize requests with focused-pane
  priority, load 100-item pages near the top up to 2,000 items, and require an
  explicit Retry after errors or cursor expiry.
- Intercept alternate-buffer wheel and Shift+PageUp only in History mode. Render
  a terminal-styled structured overlay without replacing xterm; leave keyboard
  input live, provide an explicit Remote mode, and return to current output only
  after the reader moves back to the bottom or selects Live.
- Cover capture policy, snapshot transitions, status-only output, paging, and
  failure states. Run lint, the full Windows suite, production package, release
  validation, and packaged ConPTY/WSL smoke for `0.11.0-beta.15`.
- Retain beta.14 for rollback. Verify single and split layouts on gaming first,
  then install the identical checksum-verified artifact on work-m.

Acceptance record (2026-07-17): beta.15 passed TypeScript lint, all 124 Windows
tests, production NSIS/portable packaging, release validation, and packaged
ConPTY/WSL smoke. The live gaming renderer gate covered single Native and
Terminal, History/Remote/Live with the same xterm instance, compact/expanded
resize, rail resize, reload/reconnect, two columns, two rows, and 2x2; the
pre-test four-pane workspace was restored byte-for-byte. Installer SHA-256
`67d7c05641ca2999dac4e455fbda5babf03264c1bd3f3003106e750da3638d90`
was verified before gaming installation and again after resumable transfer to
work-m. Both interactive Session 1 installations report beta.15 and contain
the identical app archive SHA-256
`ceda34f53a4919011ae104876fc47ac8426f74c9e76e66664281b230a206fa62`.
Beta.14 remains available for rollback.

## 26. Seamless Prefetched Tmux Scrollback Correction

- Replace beta.15's structured History overlay and History/Remote/Live controls
  with the shared bounded `wtmux pane scrollback` contract.
- Prefetch 2,000 ANSI rows after 900 quiet milliseconds, validate the frame in
  the main process, and render it through an in-pane xterm sidecar only when its
  dimensions match the live terminal.
- Intercept upward wheel and Shift+PageUp only for a ready eligible alternate-
  screen cache. Keep live PTY/xterm input and output attached, return to Live on
  typing or cached-bottom reach, and invalidate on resize or structural change.
- Cover cache eligibility, state transitions, dimension matching, integrity
  rejection, and the no-overlay stylesheet contract. Gate on TypeScript lint,
  all Windows tests, and a production Electron build; packaging and deployment
  remain a separate release decision.

Implementation record (2026-07-17): TypeScript lint, all 124 Windows tests,
the stylesheet contract, integrity-rejection coverage, and the production
Electron main/preload/renderer build passed. No Windows package was published
or installed as part of the Android `.52` correction.

## 27. Local Reply Suggestions

1. Add pure shared eligibility, 12-message/12-KiB context, prompt, parser,
   deduplication, and stale-revision contracts with deterministic unit tests.
2. Add a machine-local configuration/secret store and main-process manager for
   app-owned llama.cpp and loopback OpenAI-compatible servers. Enforce loopback
   URLs, fixed managed arguments, health/model checks, timeouts, cancellation,
   one active request, idle unload, and process cleanup.
3. Expose narrow typed IPC and integrate Suggest/results into Native composers
   and free-text questions without reconstructing sessions or disturbing draft,
   focus, scrolling, tools, terminal panes, approvals, or choice controls.
4. Exercise fake HTTP and fake managed-process paths, renderer contracts, and
   disable/quit cleanup. Run lint, all Windows tests, production build/package,
   release validation, and packaged smoke.
5. If no intervening bump exists, release `0.11.0-beta.16`, retain beta.15,
   and record installer/app checksums before Android parity begins.

Implementation record (2026-07-17): TypeScript lint and all 135 tests passed,
including bounded-context, stale-result, encrypted-store, fake managed process,
and real loopback HTTP coverage. The production Windows package and packaged
ConPTY/WSL smoke passed. The final installer SHA-256 is
`e4016480aa95c654109bbd812a2768e3eb140643973d952870e7c5ea743c67a9`;
the portable SHA-256 is
`c8ae8f55f78b5c2e013dc71507a74bf916eacb247caadb62745878d2ae45e421`.
No local llama.cpp installation was available, so managed-backend validation
uses its exact fixed arguments/lifecycle fake while the external adapter uses
a real loopback server.

## 28. Direct-Reply Suggestion Prompt

1. Put quoted conversation context before a final direct-reply task on every
   backend. Require verbatim human-user messages, prohibit explanation or
   paraphrase, match the recent user language, and prefer a contextual mix
   without forcing three results.
2. Add the reported `It means...` failure as a prompt-contract regression for
   composer and structured-text targets while retaining existing conservative
   claims, JSON parsing, privacy, cancellation, and fill-without-send behavior.
3. Run lint, all tests, production Windows packaging, and packaged ConPTY/WSL
   smoke. Release `0.11.0-beta.17` through the existing updater and retain
   beta.16 for rollback.

Implementation record (2026-07-18): commit `87419e0` passed TypeScript lint,
all 136 tests, production NSIS/portable packaging, and packaged ConPTY/WSL
smoke. The byte-verified beta.17 prerelease is published; setup SHA-256 is
`a3fb4e48103abcf42b361fc7899a05f329de57a6539d3435c910986bd75d63ab`
and portable SHA-256 is
`b9bedc49a386012ee8232e580b46e25487a00c7a0e3ceed4b5b554adcf3fa6e9`.
The repository's SignPath workflow cannot sign because its organization and
project secrets are not configured, and the controller has no code-signing
certificate. As with beta.16, these private-beta files are unsigned; beta.16's
configured signature check therefore requires a manual beta.17 install rather
than an automatic update. Beta.16 remains available for rollback.

## 29. Automatic Local Reply Drafts

1. Replace the local enabled flag with Off, Manual, and Automatic modes;
   migrate enabled version-1 settings to Manual and disabled settings to Off.
2. Baseline focused Native sessions on open, focus, snapshot, reconnect, and
   mode change. Trigger once only when a later live assistant reply completes
   or the active structured free-text question changes.
3. Show cancelable preparation, selectable drafts, Regenerate, and quiet inline
   Retry states. Typing, attachments, navigation, backgrounding, newer context,
   and Off cancel work; choices continue to fill without submitting.
4. Cover migration, live-versus-historical revisions, inactive panes,
   cancellation, stale results, questions, and renderer contracts. Run lint,
   all tests, production packaging, and packaged ConPTY/WSL smoke.
5. Release `0.11.0-beta.19` through the updater, retain beta.18 for rollback,
   and record installer and portable checksums before Android parity rollout.

Implementation record (2026-07-19): commit `57dc21e` adds Off, Manual, and
Automatic modes, migrates version-1 settings to Manual/Off, and baselines each
focused Native session so only later live assistant completions and structured
free-text questions start a local draft. Typing, attachments, focus or
visibility changes, newer context, and Off cancel pending work; choosing a
result still fills without sending. TypeScript lint and all 142 Windows tests
passed, followed by the production NSIS/portable package and packaged WSL
smoke. The published beta.19 prerelease and GitHub asset digests match the
validated files: setup SHA-256
`6dec6d33584c8c4eae492bb8325088391c43ab6fc7dc110c094d1e31d461bb2f`
and portable SHA-256
`1074b35f0ddb0559a529813f4467102ba3e50bfd701ce235b3d6f668dab1b6ef`.
Beta.18 remains available locally for rollback. The repository still has no
SignPath secrets, so beta.19 is unsigned and an installed build enforcing the
configured publisher may require a one-time manual installation; signature
verification was not weakened.
