# ClaudeLander - Project Notes for Claude

## Release Workflow

**IMPORTANT:** When bumping versions for release:

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
