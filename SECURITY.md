# Security Policy

## Supported Versions

Security fixes target the latest stable release. Prereleases receive fixes until the corresponding stable release is published.

## Reporting

Do not open a public issue for a vulnerability. Use GitHub private vulnerability reporting for `yaakovch/agent-fleet` and include the affected version, reproduction steps, and impact. Do not include authentication tokens or private settings.

## Release Trust

Stable Windows executables must have a valid Authenticode signature and be attached to the matching GitHub tag. `SHA256SUMS.txt`, an SBOM, and GitHub build provenance are published with each release. Unsigned CI artifacts are for development only.
