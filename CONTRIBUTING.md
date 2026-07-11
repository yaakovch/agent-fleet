# Contributing

## Local Checks

Run `npm ci`, `npm run lint`, `npm test`, `npm run build`, `npm run package:dir`, and `npm run smoke:packaged` before opening a pull request.

Keep provider authentication outside this repository. Tests and documentation must use generic users and paths such as `/home/testuser`.

## Releases

1. Update `package.json` and `CHANGELOG.md`.
2. Merge the release commit to `main` after CI passes.
3. Create a matching `vX.Y.Z` or prerelease tag.
4. The release workflow must sign the unpacked application and final artifacts through the configured SignPath project.
5. Verify Authenticode signatures, updater metadata, checksums, SBOM, provenance, install/portable behavior, and the second-machine checklist.
6. Publish the generated draft. `1.0.0` is first published as a prerelease, validated as an update from `0.9`, then promoted unchanged to stable.

SignPath project identifiers and API tokens belong in GitHub Actions secrets. Stable releases must not bypass the signing job.

Private beta releases are built in the private beta-feed repository from an exact public Agent Fleet commit. Public unsigned prereleases remain manual downloads and are never eligible for automatic updates.
