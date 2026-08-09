# Contributing

## Local Checks

Run `npm ci` and `npm run quality` before opening a pull request. This is the
same source-quality gate CI runs. On Windows, also run
`npm run package:dir:built` and `npm run smoke:packaged` for changes that can
affect packaging, startup, the embedded runtime, or terminal behavior. The
`:built` command reuses the quality gate's production build; use
`npm run package:dir` when packaging without running that gate first.

The quality gate blocks high or critical vulnerabilities in shipped
dependencies and critical vulnerabilities anywhere in the complete dependency
graph. `npm run audit:release` raises that complete-graph gate to high severity
for releases. Findings in build-only tooling require the same reviewed,
time-bounded exception process as runtime findings.

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
