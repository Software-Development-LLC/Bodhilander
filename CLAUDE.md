# ClaudeLander - Project Notes for Claude

## Branching Strategy

- **`main`** - Production branch. Merging to main triggers a release build.
- **`develop`** - Staging branch. Accumulate features/fixes here before releasing.
- **`fix/*` or `feature/*`** - Feature/fix branches. Create PRs targeting `develop`.

**Workflow:**
1. Create feature branch from `develop`
2. PR to `develop` for code review
3. When ready to release, PR from `develop` → `main`
4. Bump version on `main` and push to trigger release

## Release Workflow

**IMPORTANT:** When bumping versions for release (on `main` branch):

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

- **File modification bug**: Always use complete absolute Windows paths with drive letters and backslashes for ALL file operations (Read, Edit, Write tools). Example: `D:\Projects\claudelander\src\file.ts` not `D:/Projects/claudelander/src/file.ts`
