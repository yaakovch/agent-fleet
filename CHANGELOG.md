# Changelog

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
