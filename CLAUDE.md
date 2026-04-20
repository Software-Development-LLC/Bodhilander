# Bodhilander - Project Notes for Claude

## Branching Strategy

- **`production`** - Release branch. Merging to `production` triggers a release build.
- **`development`** - Staging branch. Accumulate features/fixes here before releasing.
- **`fix/*` or `feature/*`** - Feature/fix branches. Create PRs targeting `development`.

**Workflow:**
1. Create feature branch from `development`
2. PR to `development` for code review
3. When ready to release, PR from `development` → `production`
4. Bump version on `production` and push to trigger release

## Release Workflow

**IMPORTANT:** When bumping versions for release (on `production` branch):

```bash
npm version patch   # or minor/major
git push            # DO NOT use --tags
```

The GitHub Actions workflow (`release.yml`) checks if the tag exists:
- If tag exists → skips build (assumes already released)
- If tag doesn't exist → builds and creates the tag itself

`npm version` creates the tag locally, so pushing it with `--tags` causes the workflow to skip the build.

**If you accidentally push tags:**
1. Delete the tag: `git tag -d v1.x.x && git push origin :refs/tags/v1.x.x`
2. Re-trigger: `gh workflow run "Build and Release"`

## Beta Release Workflow (BDHLNDR-32)

Bodhilander ships two auto-update channels: **stable** (default) and **beta** (opt-in via Settings → Updates).

**To cut a beta (on the `development` branch):**

```bash
npm version prerelease --preid=beta   # e.g. 3.3.0 → 3.3.0-beta.1
git push                              # DO NOT use --tags
```

The same `release.yml` workflow handles it — it sees the `-beta.N` suffix on the package.json version and:
- marks the GitHub Release as a **pre-release**,
- sets `make_latest: false` so stable users don't pick it up,
- uploads `beta.yml` (produced automatically by electron-builder because the semver contains a pre-release segment) alongside the installers.

Users who flipped "Beta (opt-in)" in Settings → Updates get the new build on their next auto-update check; everyone else stays on the last stable release.

**Channel gating by branch** (enforced in `release.yml`'s `check-version` job):
- `production` accepts stable versions only (no `-beta.` suffix).
- `development` accepts beta versions only (must carry `-beta.` suffix).
- Mismatched pushes short-circuit with a log message; no partial release is produced.

**Bumping a subsequent beta:** `npm version prerelease` (without `--preid`) bumps the suffix (`3.3.0-beta.1` → `3.3.0-beta.2`).

**Promoting a beta to stable:** merge `development` → `production`, then on `production` run `npm version minor` (or patch/major) to drop the pre-release suffix and bump to the final version. Push.

## Project Structure

- Electron app for managing Claude Code sessions
- Uses `electron-updater` for auto-updates from GitHub Releases
- Native modules: `better-sqlite3`, `node-pty`, `sodium-native`

## Known Issues

- Auto-update SSL errors (`ERR_SSL_PROTOCOL_ERROR`) are usually caused by:
  - Antivirus SSL inspection
  - Corporate firewalls/proxies
  - VPNs interfering with TLS
  - Not a bug in the app - it's GitHub's CDN (`release-assets.githubusercontent.com`)

## Claude Code Workarounds

- **File modification bug**: Always use complete absolute Windows paths with drive letters and backslashes for ALL file operations (Read, Edit, Write tools). Example: `D:\Projects\bodhilander\src\file.ts` not `D:/Projects/bodhilander/src/file.ts`
