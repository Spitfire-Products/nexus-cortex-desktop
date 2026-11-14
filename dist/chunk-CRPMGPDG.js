import {
  registerDesktopTool
} from "./chunk-ZIIANQVA.js";

// src/mcp.ts
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
async function createDesktopMCP(opts = {}) {
  const home = opts.home ?? process.env.NEXUS_BROWSER_HOME ?? path.join(os.homedir(), ".nexus-cortex", "browser");
  const server = new McpServer({ name: "nexus-desktop", version: "0.11.0" });
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
  createDesktopMCP
};
//# sourceMappingURL=chunk-CRPMGPDG.js.map
