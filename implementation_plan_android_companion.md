# Agent Fleet Android Companion Implementation Plan

Status: approved for execution on 2026-07-12.

## 1. Repository and Toolchain

- Create public `yaakovch/agent-fleet-android` as a GPLv3 fork of Termux 0.118.3
  with upstream history; copy the approved SPEC and this plan into it.
- Add provenance, privacy, security, migration, release, and contribution docs.
- Install JDK 17, current Android SDK/build tools, and an accelerated Android 16
  S23FE-sized Windows emulator.
- Add public CI for unsigned builds, tests, lint, license checks, and dependency
  scanning. Keep signing material outside GitHub.

Gate: unmodified upstream builds and bootstrap, shell, `pkg`, storage, PTY, and
terminal tests pass on the emulator.

## 2. Mobile Shell and Terminal

- Upgrade the build for Kotlin/Material 3 without changing app ID, executable
  paths, or Termux target-SDK behavior.
- Build the fixture-backed mobile prototype and validate typography, density,
  touch targets, and navigation at S23FE dimensions.
- Bind the new shell to `TermuxService`, embed `TerminalView`, and implement tab
  descriptors, local sessions, memory-only scrollback, Classic recovery,
  themes, terminal controls, extra keys, gestures, and hardware input.
- Implement per-tab Android Compose and Classic Terminal input modes.

## 3. Fleet Sessions

- Add guided dependency/runtime provisioning, restore-or-QR pairing, progress,
  doctor gating, and sanitized diagnostics.
- Supervise the JSONL bridge while visible with strict parsing, capability
  negotiation, bounded reconnect, and validated cache fallback.
- Implement grouped/searchable sessions and the complete safe action set.
- Open remote sessions in terminal tabs using argument arrays and existing
  wtmux attach behavior; add visible-only Retry/Close reconnect UX.

## 4. Composer and Images

- Add in-memory drafts, literal multiline send, attachment chips, and explicit
  target presentation.
- Add Share/multi-share, picker, and camera ingestion; normalize/optimize images
  and retain failures for manual retry.
- Add `wtmux image send --json`, seven-day host cleanup, successful local-temp
  deletion, and path insertion without submission.

## 5. Limits, Schedules, and Health

- Add strict designated quota-source schema and verified bundle sync.
- Add metadata-only Codex/Claude host collectors with explicit failover.
- Add desktop-managed source mutations/settings and capability-negotiated
  `profileAlias` session creation with host-local safe resolution.
- Implement Limits, hard-limit actions, recommendations, schedules, health,
  versions, pairing, and diagnostics on Android.

## 6. Release, Migration, and Rollout

- Generate an offline private signing key with two encrypted backups.
- Script local signing and publication of APK/manifest/checksum to
  gaming-desktop; document work-m fallback.
- Implement visible/manual update checks and signature/checksum verification.
- Build backup/restore tooling; complete sanitized emulator migration/rollback.
- After both real backups verify, perform the S23FE cutover and validate every
  success criterion.
- Run a seven-day daily-driver soak; hotfix and restart the clock for critical
  defects, rolling back for corruption, security, unusable terminal behavior,
  or inability to hotfix promptly.

## Verification

- Preserve upstream terminal/service/file-provider/package tests.
- Add Compose navigation/screenshot/accessibility/lifecycle tests.
- Add protocol, schema, frame, revision, idempotency, and injection tests.
- Add provisioning, pairing, reconnect, alias, quota, schedule, image, update,
  migration-manifest, and rollback tests.
- Exercise clean/restored onboarding, process death, reboot, offline cache,
  Tailscale loss, multi-image share, quota failure, and incompatible hosts on
  Android 16 before the phone cutover.

