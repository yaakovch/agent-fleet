# Agent Fleet

Agent Fleet is a local-first Windows tray application for managing personal AI
coding sessions across Windows, WSL, Linux, and Termux. It is growing from AI
Limits Widget into one dashboard for wtmux sessions, launchers, scheduled
messages, host health, attention events, and Codex/Claude usage limits.

The existing transparent, click-through limits overlay remains available as an
optional companion view. Agent Fleet exchanges metadata only: it never moves
prompts, responses, transcripts, terminal output, or authentication material.
See [PRIVACY.md](PRIVACY.md) and [SPEC.md](SPEC.md).

## Status

`0.10.0-beta.3` is under active development for a private multi-machine beta.
The existing unsigned `0.9.0-beta.1` release is retained as a legacy
prerelease. Unsigned public builds are manual downloads only; automatic public
updates require trusted signed artifacts.

The source repository is public. The wtmux bridge, personal fleet registry, and
private beta release feed are intentionally separate and private.

## Requirements

- Windows 10 or 11, x64
- WSL with at least one Linux distribution
- Codex inside WSL for local limit collection
- wtmux and SSH/Tailscale access for fleet features as they land
- Claude Code for the optional Claude status-line integration

## Development

```powershell
npm ci
npm run dev
```

Verification and packaging:

```powershell
npm run lint
npm test
npm run build
npm run package:dir
npm run smoke:packaged
npm run package
npm run sbom
npm run finalize:release
```

Artifacts are written to `dist/`. Local and private-beta builds may be
unsigned. Stable public releases require Authenticode signing.

## Settings Transfer

Settings → Import/Export transfers provider and widget configuration in a
versioned JSON envelope. Imports are validated and previewed before replacement.
The previous configuration is backed up and can be restored with Rollback.
Usage caches, logs, window position, Claude settings, and authentication data
are excluded.

## Release Process

Version tags must match `package.json`. The signed public workflow packages and
verifies Authenticode artifacts, updater metadata, checksums, an SBOM, and build
provenance. Private beta builds are manually dispatched from a separate private
feed and always record the exact public source commit. See
[CONTRIBUTING.md](CONTRIBUTING.md) and
[implementation_plan.md](implementation_plan.md).
