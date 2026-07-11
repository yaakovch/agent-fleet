# Privacy

Agent Fleet operates locally on the Windows computer where it is installed.

- No telemetry, analytics, crash reports, settings, or usage-limit data are sent to the project maintainer.
- The app invokes the locally installed Codex app-server inside WSL, reads a local Claude Code status-line cache, and exchanges metadata with configured wtmux hosts through the user's existing SSH access.
- Authentication tokens are owned by Codex, Claude Code, GitHub CLI, Tailscale, and SSH. Agent Fleet does not read, copy, log, export, or upload them.
- Fleet caches contain session, schedule, host-health, and attention metadata only. Prompts, responses, transcripts, and terminal screen contents are excluded.
- Settings exports include provider labels and configured WSL paths. They exclude authentication, usage caches, logs, window position, and Claude settings.
- Diagnostics archives are created only after an explicit user action and remain on the local filesystem until the user chooses to share them.
- Installed builds contact GitHub Releases to check for application updates. Portable and development builds do not install updates automatically.

Uninstall removes the app-owned Claude status-line hook when it is still unchanged. App data is retained unless the user explicitly chooses removal.
