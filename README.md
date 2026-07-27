# Bodhilander

<div align="center">

[![Release](https://img.shields.io/github/v/release/Software-Development-LLC/Bodhilander?style=for-the-badge&color=gold)](https://github.com/Software-Development-LLC/Bodhilander/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=for-the-badge)]()

---

## Unified Session Management

*A cross-platform Claude Code session manager*

</div>

---

## Overview

Managing multiple Claude Code terminal sessions across different projects can be challenging. **Bodhilander** provides a unified interface to organize, monitor, and manage all your Claude Code sessions in one place.

## Features

### Session Management
All your Claude Code sessions in one application. No more hunting through terminal windows.

### Real-Time Status Detection
See at a glance which sessions are:
- **Waiting** - Claude awaits your command
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

### Mobile Companion
Connect to your sessions from a mobile device:
- **Local API server** on the same LAN — HTTPS/TLS, bound to all interfaces
- **Pairing codes** with QR code generation
- **Device management** with per-device permissions
- **Network discovery** via mDNS/Bonjour
- **Remote access** via [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) — no Bodhilander-hosted infrastructure required. See **Settings → Mobile App → Remote Access** for the two-command setup.

### Microsoft Teams Integration
Receive session event notifications in Microsoft Teams:
- Configurable notification types (waiting, error, complete)
- Per-event toggles
- OAuth authentication via Microsoft Graph API

### Auto-Update
New versions download and install automatically via GitHub Releases. Two channels are available:

- **Stable** (default) — tested releases only.
- **Beta** (opt-in) — earlier access to new features while they're being validated. Enable from **Settings → Updates**. You'll see a small **BETA** pill in the sidebar while running a beta build. Switch back to Stable any time; the next stable release ≥ your current beta will auto-install.

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

> **macOS Note:** The app is currently unsigned. Run this before opening:
> ```bash
> xattr -cr /Applications/Bodhilander.app
> ```

### Build from Source

```bash
# Clone the repository
git clone https://github.com/Software-Development-LLC/Bodhilander.git
cd bodhilander

# Install dependencies
npm install

# Run in development
npm run start

# Build for your platform
npm run dist:linux   # Linux
npm run dist:mac     # macOS
npm run dist:win     # Windows
```

---

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| New Session | `Ctrl/Cmd + N` |
| Close Session | `Ctrl/Cmd + W` |
| Next Session | `Ctrl/Cmd + Tab` |
| Previous Session | `Ctrl/Cmd + Shift + Tab` |
| Next Waiting | `Ctrl/Cmd + Shift + W` |
| New Group | `Ctrl/Cmd + G` |
| New Sub-group | `Ctrl/Cmd + Shift + G` |
| Focus Sidebar | `Ctrl/Cmd + Q` |
| Settings | `Ctrl/Cmd + ,` |

---

## Settings

Bodhilander offers extensive configuration across multiple tabs:

- **General** - Auto-launch Claude, custom shell path, preferred editor, close-to-tray
- **Terminal** - Font size, WebGL renderer acceleration
- **Sound** - Master toggle, per-event sounds, volume, debounce frequency, custom audio files
- **Mobile** - API server, pairing, device management, Tailscale Funnel guidance for remote access
- **Integrations** - Microsoft Teams notifications
- **Updates** - Release channel (Stable / Beta opt-in)

---

## Tech Stack

- **Electron** - Cross-platform desktop framework
- **TypeScript** - Type-safe development
- **React** - UI rendering
- **xterm.js** - Terminal emulation
- **node-pty** - Pseudo-terminal management
- **better-sqlite3** - Persistent storage
- **sqlite-vec** - Vector similarity search
- **tree-sitter** - Code parsing and symbol extraction
- **onnxruntime-node** - Local embedding inference
- **electron-updater** - Auto-updates

---

## Roadmap

| Phase | Status | Features |
|-------|--------|----------|
| **1 (MVP)** | Complete | Multi-session management, state detection, groups, persistence, auto-update |
| **2** | Complete | Notifications & sound, settings |
| **3** | Complete | Teams integration, mobile companion, editor integration |
| **4** | Future | AI session summaries, advanced analytics |

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
