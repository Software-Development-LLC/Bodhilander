# Bodhilander

<div align="center">

[![Release](https://img.shields.io/github/v/release/Software-Development-LLC/Bodhilander?style=for-the-badge&color=gold)](https://github.com/Software-Development-LLC/Bodhilander/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=for-the-badge)]()

---

## Unified Session Management

*A cross-platform session manager for AI coding CLIs — with Claude Code as the flagship*

</div>

---

## Overview

Bodhilander is a desktop app for running, organizing, and monitoring AI coding-agent
CLI sessions. It manages seven providers — **Claude Code**, **Codex (OpenAI)**,
**Grok Build (xAI)**, **opencode**, **Kimi Code**, **Cursor Agent**, and
**Antigravity** — with automatic detection of installed CLIs, one-click install for
missing ones, and a vault for provider API keys. Claude Code gets the deepest
integration: multiple accounts and CLI lifecycle hooks for precise session-state
reporting.

Your sessions are also reachable off the desktop: from a phone on the same LAN via
a paired mobile web app, or from anywhere through an end-to-end-encrypted cloud
relay — including sharing a live session with an invited guest.

## Features

### Multi-Provider Sessions
Run sessions against any of the seven supported agent CLIs. **Settings → Providers**
detects what's installed, offers "Install for me" for what isn't, and stores
provider API keys in an encrypted key vault. Claude Code additionally supports
multiple accounts (per-session or per-group) and state-reporting hooks.

### Arena
Run the same prompt against several provider CLIs — plus a local
[Ollama](https://ollama.com) model — side by side and compare the responses,
with follow-up rounds that resume each contestant's conversation.

### Real-Time Status Detection
See at a glance which sessions are:
- **Waiting** - The agent awaits your command
- **Working** - Processing your request
- **Idle** - Shell ready
- **Error** - Something went wrong
- **Stopped** - Session ended

### Session Groups
Organize sessions into groups and subgroups by project, client, or workflow. Color-code for quick identification.

### Persistent Sessions
Sessions survive app restarts. Your context is preserved.

### Notifications & Sound
Stay informed without watching the window:
- **Desktop notifications** - Alerts when sessions need attention
- **Configurable sounds** - Per-event audio for waiting, error, start, and complete states
- **Volume & debounce controls** - Master volume, per-event toggles, debounce presets
- **Custom sounds** - Use your own audio files for each event type

### System Tray
- Minimize to tray with close-to-tray option
- Badge showing count of waiting sessions
- Quick access to waiting sessions from the tray context menu

### Mobile Companion (same LAN)
A mobile web app served by the desktop app itself:
- **Pairing codes** with QR code generation — scan from your phone to connect
- **Device management** with per-device permissions (view / control / modify) and unpairing
- **Push notifications** to the paired device for session events
- The local API server speaks **plain HTTP** (default port 8443, all interfaces)
  with access restricted to private-network addresses. Traffic on the LAN is not
  encrypted — for access from outside your network, use Remote Hosting below.

### Remote Hosting & Session Sharing
Reach your desktop from anywhere through a cloud relay ([self-hostable](relay/README.md)):
- **End-to-end encrypted** — traffic between your browser and your desktop is
  sealed with X25519 + HKDF + AES-256-GCM and a fingerprint you can verify; the
  relay blindly routes ciphertext it cannot read
- **GitHub sign-in** on the relay, with machine linking via short link codes
  (**Settings → Remote Hosting**)
- **Web client** — mobile-first: session list with live state, a full terminal,
  and session/group creation from the browser
- **Session sharing** — invite a guest to watch a live session: invites are
  single-use, addressed to a GitHub account (or an open link), and every join
  needs your explicit approval. Shared sessions show who's watching, and access
  is time-boxed or lasts until you revoke it — or until the shared session
  restarts. Guests are watch-only.

### Microsoft Teams Integration
Receive session event notifications in Microsoft Teams:
- Configurable notification types (waiting, error, complete)
- Per-event toggles
- OAuth authentication via Microsoft Graph API

### Auto-Update
New versions download and install automatically via GitHub Releases. Two channels are available:

- **Stable** (default) — tested releases only.
- **Beta** (opt-in) — earlier access to new features while they're being validated. Enable from **Settings → Updates**. You'll see a small **BETA** pill in the sidebar while running a beta build. Switch back to Stable any time; the app will move you back to the latest stable release (a downgrade if no stable ≥ your beta exists yet).

### Cross-Platform Support
- Windows (native + WSL)
- macOS (Intel + Apple Silicon)
- Linux (AppImage + .deb)

---

## Installation

Grab the latest release for your platform from [Releases](https://github.com/Software-Development-LLC/Bodhilander/releases).

| Platform | File |
|----------|------|
| Windows | `Bodhilander-Setup-x.x.x.exe` |
| macOS | `Bodhilander-x.x.x.dmg` |
| Linux | `Bodhilander-x.x.x.AppImage` or `.deb` |

> **macOS Note:** Releases are signed with a Developer ID certificate and
> notarized by Apple, so the app opens like any other. If Gatekeeper complains,
> you are running an old unsigned build — download the current DMG instead.

### Build from Source

Prerequisites: [Bun](https://bun.sh) (the npm scripts delegate to `bun run`),
Node.js, Python 3, and a C/C++ toolchain — Xcode Command Line Tools on macOS,
Visual Studio 2022 Build Tools on Windows, `build-essential` on Linux. The
install step rebuilds the native modules (`better-sqlite3`, `node-pty`) for
Electron via node-gyp, which is what needs Node and Python.

```bash
# Clone the repository
git clone https://github.com/Software-Development-LLC/Bodhilander.git
cd Bodhilander

# Install dependencies (rebuilds native modules for Electron)
bun install

# Build and run
bun run start

# Run the tests
bun test

# Build installers for your platform
bun run dist:linux   # Linux
bun run dist:mac     # macOS
bun run dist:win     # Windows
```

---

## Keyboard Shortcuts

Bare `Ctrl` chords are left to the terminal (SIGINT, readline, tmux) wherever
possible, so app actions use `Cmd` on macOS and `Ctrl+Shift` on Windows/Linux —
`Ctrl+Tab` session switching is the deliberate exception.

| Action | macOS | Windows / Linux |
|--------|-------|-----------------|
| New Session | `Cmd + N` | `Ctrl + Shift + N` |
| Close Session | `Cmd + W` | `Ctrl + Shift + W` |
| Next Session | `Ctrl + Tab` | `Ctrl + Tab` |
| Previous Session | `Ctrl + Shift + Tab` | `Ctrl + Shift + Tab` |
| Next Waiting | `Cmd + Shift + J` | `Ctrl + Shift + J` |
| Terminal / Analytics / Arena view | `Cmd + 1 / 2 / 3` | `Ctrl + Shift + 1 / 2 / 3` |
| Focus Sidebar | `Cmd + B` | `Ctrl + Shift + B` |
| Copy / Paste | `Cmd + C` / `Cmd + V` | `Ctrl + Shift + C` / `Ctrl + Shift + V` |
| Clear Terminal | `Cmd + K` | `Ctrl + Shift + K` |
| Settings | `Cmd + ,` | `Ctrl + ,` |

---

## Settings

Nine tabs of configuration:

- **General** - Auto-launch Claude, custom shell path, preferred editor, close-to-tray, data import/export, diagnostics
- **Terminal** - Font size, WebGL renderer acceleration
- **Mobile App** - Local API server, QR pairing, device management
- **Remote Hosting** - Relay connection: machine name, link code, relay URL, machine fingerprint, keep-awake
- **Sound** - Master toggle, per-event sounds, volume, debounce frequency, custom audio files
- **Integrations** - Microsoft Teams notifications
- **Providers** - Detect installed agent CLIs, one-click install, API key vault
- **Claude Accounts** - Manage multiple Claude accounts
- **Updates** - Release channel (Stable / Beta opt-in)

---

## Tech Stack

- **Electron** - Cross-platform desktop framework
- **TypeScript** - Type-safe development
- **React** - UI rendering (desktop renderer and the mobile PWA)
- **xterm.js** - Terminal emulation
- **node-pty** - Pseudo-terminal management
- **better-sqlite3** - Persistent storage
- **Express** - Local API server for the mobile companion
- **electron-updater** - Auto-updates
- **Bun** - Build/test toolchain, and the runtime of the [cloud relay](relay/README.md)

---

## Status & Direction

Recent releases shipped multi-provider sessions with arena mode, the LAN mobile
companion, and relay-based remote hosting with end-to-end encryption and session
sharing. Active work is tracked in the
[GitHub issues](https://github.com/Software-Development-LLC/Bodhilander/issues).

---

## Contributing

Contributions are welcome! Feel free to open issues or submit PRs.

---

## Credits

Created by **Will Long II** and **Claude** (Anthropic)

---

<div align="center">

**[Download Now](https://github.com/Software-Development-LLC/Bodhilander/releases)**

</div>

---

## License

MIT License - See [LICENSE](LICENSE) for details.
