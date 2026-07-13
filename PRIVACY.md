# Privacy

Agent Fleet operates locally on the Windows computer where it is installed.

- No telemetry, analytics, crash reports, settings, or usage-limit data are sent to the project maintainer.
- The app invokes the locally installed Codex app-server inside WSL, reads a local Claude Code status-line cache, and exchanges metadata with configured wtmux hosts through the user's existing SSH access.
- Authentication tokens are owned by Codex, Claude Code, GitHub CLI, Tailscale, and SSH. Agent Fleet does not read, copy, log, export, or upload them.
- Fleet caches contain session, schedule, host-health, attention, and embedded-tab descriptor metadata only. Prompts, responses, transcripts, terminal bytes, question answers, and staged image bytes are excluded.
- Opening an embedded session is an explicit content action. The app streams that session's terminal and bounded conversation frames through the user's local WSL and configured SSH transport, retains them only in process memory, and stops the conversation stream when its tab/app closes.
- Images selected, dropped, or pasted in Native view are held in memory until Send. Send transfers them to the selected host/session through wtmux; cancel/removal discards the local staged bytes. Remote image retention follows the wtmux image policy.
- Terminal/conversation content and image bytes are excluded from logs, notifications, diagnostics, settings exports, fleet snapshots, and updater traffic.
- Settings exports include provider labels and configured WSL paths. They exclude authentication, usage caches, logs, window position, and Claude settings.
- Diagnostics archives are created only after an explicit user action and remain on the local filesystem until the user chooses to share them.
- Installed builds contact GitHub Releases to check for application updates. Portable and development builds do not install updates automatically.

Uninstall removes the app-owned Claude status-line hook when it is still unchanged. App data is retained unless the user explicitly chooses removal.
