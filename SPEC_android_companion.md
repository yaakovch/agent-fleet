# Agent Fleet Android Companion Specification

Status: approved for implementation on 2026-07-12.

## Goal

Build an Android daily-driver for the S23FE that combines a complete,
customizable Termux-compatible terminal with Agent Fleet session management,
host-sourced AI limits, scheduling, and image attachments.

The app is a GPLv3 fork of Termux 0.118.3. It keeps the internal `com.termux`
identity and package paths, but all user-facing branding, navigation, terminal
controls, and settings become Agent Fleet. The first alpha is distributed as a
privately signed APK through the existing fleet and targets Android 16/arm64.

## Experience

- Open to a mobile-native Sessions screen with large type and touch targets.
- Use bottom navigation for Sessions, Terminal, Limits, and More.
- Group/search sessions by host and support open, create, rename, favorite,
  copy attach command, schedule, and confirmed kill.
- Opening a session creates or focuses a persistent in-app terminal tab.
- Remote tabs use bounded reconnect while visible and expose Retry and Close.
- Preserve Termux shell, package, PTY, storage, SSH, tmux, file-provider, and
  `RUN_COMMAND` compatibility.
- Keep terminal tabs alive through the Termux foreground service. Persist tab
  descriptors but never terminal output; reattach after reboot with a fresh
  screen.
- Retain a Classic Termux screen/preset as a recovery path.
- Provide System, Light, Dark, OLED, Classic Termux, Nord, Dracula, and
  Solarized themes plus font size, spacing, padding, cursor, extra-key, gesture,
  and per-tab controls. Honor compatible `termux.properties` and font files.

Two input modes are available from a one-tap per-tab toggle:

- Android Compose defaults for Codex and Claude. It provides a native
  multiline editor, normal Android IME/voice behavior, attachment chips, and
  explicit Send using literal bracketed paste.
- Classic Terminal defaults for shells and preserves direct PTY input, editable
  extra keys, modifier locking, gestures, selection, clipboard, hardware
  keyboard, and mouse behavior.

## Limits, Schedules, and Health

- Android remains client-only and does not collect phone-local quotas.
- Show Codex and Claude quota metadata from designated trusted host/profile
  aliases, with freshness, reset time, and failure state.
- Show genuine hard-limit events observed by wtmux sessions.
- Recommend an eligible profile with available quota and launch using its safe
  alias.
- Offer guarded `continue` for reset plus one minute, with edit/dismiss.
- More contains schedules, host health/version, pairing, diagnostics, and
  refresh. Host repair/update and registry administration remain desktop-only.
- Poll fleet state only while visible. Active terminals retain their foreground
  notification; there is no background fleet monitor or cloud relay.

## Images

- Accept Share/multi-share, gallery/files, and camera input.
- Normalize PNG, JPEG, WebP, and HEIC and optimize unusually large photos.
- Send through wtmux into the active project under `.wtmux/images/`.
- Add returned host-readable paths to the composer without submitting.
- Retain failed in-memory drafts for explicit retry, delete successful local
  temporary files, and expire host images after seven days.

## Architecture and Security

- Base the public fork on upstream Termux 0.118.3 under GPLv3.
- Retain `com.termux`, min SDK 24, target SDK 28, bootstrap paths, terminal
  emulator/view, and `TermuxService` behavior required by Termux packages.
- Add a Kotlin/Material 3 shell embedding the existing Java `TerminalView`.
- Run the verified repo-less wtmux runtime inside Termux and supervise its JSONL
  bridge only while the app is visible.
- Reuse strict validation, revisions, idempotency keys, safe aliases, and typed
  mutations; add no arbitrary remote command endpoint.
- Quota records contain metadata only. Credentials, auth files, prompts,
  responses, transcripts, and terminal screen contents never enter bridge
  frames, caches, logs, or diagnostics.
- Host-local alias paths remain untracked and private.
- Public CI builds unsigned artifacts. A controller signs with an offline key
  and serves releases through gaming-desktop, with work-m as fallback.
- Updates verify manifest, checksum, version, and signing certificate before
  opening Android's confirmed installer.

Official Termux plugins will not remain signature-compatible. The alpha
integrates styling, storage/share, launcher shortcuts, and Agent Fleet actions;
separate plugin forks are deferred.

## Pairing and Provisioning

- Restored installations validate and reuse existing wtmux client state.
- Clean installations scan/paste the existing invitation, wait for controller
  approval, install required Termux packages and a checksummed repo-less wtmux
  runtime, and require a passing doctor result.
- The app never requests or copies GitHub, Tailscale, SSH, Codex, or Claude
  credentials.

## Migration and Rollback

The current S23FE Termux installation is F-Droid-signed, so the fork cannot
update it in place. Before uninstalling Termux or Termux:Widget:

1. Archive the complete Termux files tree and a second portable home/config
   archive; record packages, permissions, properties, manifests, and checksums.
2. Pull the installed F-Droid APKs and record their signing certificates.
3. Keep verified copies on the controller PC and Android Downloads.
4. Restore a sanitized copy in an emulator, migrate to Agent Fleet, roll back
   to captured F-Droid Termux, and compare state.

Only after those gates may the phone install the privately signed fork.
Rollback uninstalls it, reinstalls captured F-Droid APKs, and restores the
verified archive.

## Success Criteria

- The S23FE replaces its current Termux workflow for seven consecutive days.
- Local shells, packages, SSH/tmux, storage, shortcuts, Classic Termux,
  customization, and Android Compose input work.
- All safe session actions, reconnect, limits, profile launch, guarded reset
  scheduling, and multiple-image attachment work end to end.
- A signed fleet-host update installs after verification.
- Backup, emulator rollback rehearsal, and phone rollback instructions verify
  before cutover.
- Critical soak defects receive an in-place hotfix and restart the seven-day
  clock; rollback is used for corruption, security exposure, unusable terminal
  behavior, or inability to hotfix promptly.

