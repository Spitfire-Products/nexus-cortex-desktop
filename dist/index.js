import {
  AX_INTERACTIVE,
  GUEST_INTERACTIVE_CLASS,
  GUEST_INTERACTIVE_ROLES,
  asLiteral,
  createDesktop,
  desktopMode,
  diffState,
  fixMojibake,
  fmtEvent,
  guestInteractive,
  guestRole,
  isDialogWin,
  macBackend,
  macKeyScript,
  mergeLight,
  normRegion,
  parseCombo,
  registerDesktopTool,
  x11Backend,
  xdoKey
} from "./chunk-6VJ63UC7.js";
import "./chunk-ZQPMRQT4.js";

// src/mcp.ts
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
async function createDesktopMCP(opts = {}) {
  const home = opts.home ?? process.env.NEXUS_BROWSER_HOME ?? path.join(os.homedir(), ".nexus-cortex", "browser");
  const server = new McpServer({ name: "nexus-desktop", version: "0.10.3" });
  const desktop = registerDesktopTool(server, home);
  if (!desktop) throw new Error("nexus-desktop: NEXUS_DESKTOP is not set to virtual|real \u2014 run `cortex desktop enable`");
  return { server, desktop, async close() {
    try {
      await desktop.close?.();
    } catch {
    }
  } };
}
export {
  AX_INTERACTIVE,
  GUEST_INTERACTIVE_CLASS,
  GUEST_INTERACTIVE_ROLES,
  asLiteral,
  createDesktop,
  createDesktopMCP,
  desktopMode,
  diffState,
  fixMojibake,
  fmtEvent,
  guestInteractive,
  guestRole,
  isDialogWin,
  macBackend,
  macKeyScript,
  mergeLight,
  normRegion,
  parseCombo,
  registerDesktopTool,
  x11Backend,
  xdoKey
};
//# sourceMappingURL=index.js.map
