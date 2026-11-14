# @nexus-cortex/desktop — the `desktop` tool

Lets an AI agent see a screen and use the mouse and keyboard, for things the browser tools can't reach: native apps, system dialogs,
file pickers, installers, apps inside a virtual machine. It works on a private virtual display (Linux) or on **your own screen** (macOS or
Linux X11). It is **off** until you turn it on, and the real-screen mode needs a typed confirmation at a terminal.

Part of [nexus-cortex](https://www.npmjs.com/package/nexus-cortex). Dual-licensed AGPL-3.0-only or commercial (see License).

## Install

With nexus-cortex (recommended):

```bash
cortex desktop install          # installs this package and asks to turn it on
# or, together with everything else:
cortex update --desktop
```

After that, a plain `cortex update` keeps it up to date along with nexus-cortex.

Manual install (any MCP host): `npm install -g @nexus-cortex/desktop` (Node 20 or newer).

## Turn it on and off

```bash
cortex desktop enable --real      # YOUR screen, mouse and keyboard (macOS, or Linux with an X session). You type "enable real desktop".
cortex desktop enable --virtual   # Linux only: a private virtual display the agent can't escape to your screen
cortex desktop status             # mode, and what this machine still needs
cortex desktop disable            # off for new sessions
```

When it's on, nexus-cortex serves the tool as the `nexus-desktop` MCP server (tool name `desktop`) in every session. The shipped
`desktop` skill teaches the agent how to use it.

### One-time setup

**macOS:** System Settings › Privacy & Security, then give the app that runs the agent (Terminal, iTerm, your IDE) both:
- **Screen Recording**, otherwise screenshots show only the wallpaper;
- **Accessibility**, otherwise clicks and keys are ignored.

Restart that app afterwards. `cliclick` is optional on macOS 12 and later, where the tool posts CoreGraphics events itself. It's
**required on macOS 11**: get the universal binary from https://github.com/BlueM/cliclick/releases and put it on your PATH.

**Linux:** `xdotool` and ImageMagick (`import`); `Xvfb` for `--virtual`. For example: `sudo apt-get install -y xdotool imagemagick xvfb`.
`cortex desktop status` lists anything still missing.

## Stopping it

- **Failsafe:** park the mouse cursor on the failsafe spot to stop the agent at once. On macOS that's the **middle of the top edge**
  of the screen; on Linux, the top-left corner. Change it with `NEXUS_BROWSER_DESKTOP_FAILSAFE=top|bottom|tl|tr|bl|br|off`.
- **What happens:** the tool writes a stop file (`~/.nexus-cortex/browser/DESKTOP_STOP`) and refuses every further action **for the
  rest of that process**, even if the file disappears.
- **To resume:** delete the stop file, move the cursor away from the spot, and restart the agent.
- `cortex desktop disable` turns it off for new sessions.

## What the agent can do

| Group | Actions |
|---|---|
| Look | `info` (screen, scale, permissions, failsafe spot, allowed apps) · `screenshot` · `zoom` (read small text) · `windows` · `cursor_position` · `stats` |
| Read without pixels | `scan` (accessibility elements with refs) · `grab` (text of an element or region) |
| Act on elements | `press` a scanned ref · `set_value` · `fill_field` (click, select all, type, commit, verify) |
| Keyboard first | `hotkey` (catalog of native shortcuts) · `menu` (choose a menu item by name) · `key` · `type` · `shortcut` |
| Mouse | `left_click` · `right_click` · `middle_click` · `double_click` · `triple_click` · `mouse_move` · `left_click_drag` · `scroll` |
| Apps | `launch` (allowed apps only) · `focus_window` |
| Many steps in one call | `run` (a short script of actions; `validate:true` checks it before anything moves) · `macro` (save and replay a validated sequence) |
| Windows VM guests | `guest_*` actions through the in-guest UI Automation helper in `guest/` (Parallels and similar) |

Coordinates are pixels in the screenshot the tool returned. Screenshots are scaled to `NEXUS_BROWSER_DESKTOP_MAX_WIDTH` (default 1280),
and the tool maps clicks back to the screen, including on Retina displays.

## Safety rules the tool enforces

- **Off by default.** Real-screen mode is enabled only by you, at a terminal, with a typed confirmation, and never from a container or script.
- **App allow-list.** `launch` opens only the apps in `NEXUS_BROWSER_DESKTOP_APPS`. The macOS default is Disk Utility, Terminal, Finder,
  System Settings, System Information, Activity Monitor, Console, TextEdit and Safari.
- **Audit log.** Every action goes to `~/.nexus-cortex/browser/desktop-actions.log`; typed text is logged by length only.
- **Permissions:** without Screen Recording and Accessibility, mutating actions refuse and `info` says what to grant.
- **No bypass through the shell** (nexus-cortex 4.134.4 and later). Bash commands that capture the screen, inject input or script apps
  always ask you while the desktop tool is off. Enabling the desktop is what grants that power.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `NEXUS_DESKTOP` | off | `virtual` or `real`, set by `cortex desktop enable` |
| `NEXUS_BROWSER_DESKTOP_APPS` | see above | Comma-separated app names `launch` may open |
| `NEXUS_BROWSER_DESKTOP_FAILSAFE` | `top` (macOS), `tl` (Linux) | The stop spot, or `off` |
| `NEXUS_BROWSER_DESKTOP_MAX_WIDTH` | `1280` | Screenshot width the model sees |
| `NEXUS_BROWSER_DESKTOP_DISPLAY` | `:99` | The X display for `virtual` mode |
| `NEXUS_BROWSER_DESKTOP_PROFILES` | built in | Folder of per-app profiles (verified shortcuts and menus) |
| `NEXUS_BROWSER_HOME` | `~/.nexus-cortex/browser` | Where the stop file, audit log and macros live |

## Using it outside nexus-cortex

The package ships a stdio MCP server, `nexus-desktop`. It refuses to start unless desktop control is enabled (`cortex desktop enable`,
or `NEXUS_DESKTOP=real|virtual` in its environment):

```bash
claude mcp add nexus-desktop -e NEXUS_DESKTOP=real -- nexus-desktop     # Claude Code
```

In code:

```js
// NEXUS_DESKTOP=real (or virtual) must be set in the environment; the tool refuses to act while it is off.
import { createDesktopMCP } from '@nexus-cortex/desktop';
const { server } = await createDesktopMCP();   // optional { home }; connect `server` to any MCP transport
```

Peer dependencies: `@modelcontextprotocol/sdk` and `zod`.

## License

Dual-licensed: **GNU AGPL-3.0-only** ([LICENSE](LICENSE)) **or** a **commercial license** from Spitfire Products
([LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md)). Running it unmodified on your own machines, including at work, is free under the AGPL.
Offering a modified version to others over a network requires publishing that version's source under the AGPL, or a commercial license.
Third-party notices: [NOTICE](NOTICE).
