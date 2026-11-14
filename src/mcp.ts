// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Spitfire-Commercial
// Copyright (c) 2025-2026 Spitfire Products. See LICENSE and LICENSE-COMMERCIAL.md.
// createDesktopMCP (0.9.0): the `desktop` tool on its OWN MCP server, so a harness can offer host-computer control without the browser package
// (nexus-cortex registry entry "nexus-desktop", connected in-process). Off unless NEXUS_DESKTOP (or legacy NEXUS_BROWSER_DESKTOP) = virtual|real.
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDesktopTool } from './desktop.js';

export interface DesktopMCPOptions {
  /** One persistent home per machine: the failsafe stop file, audit log, macros, app profiles live here. Default ~/.nexus-cortex/browser
   *  (unchanged from the browser-package era so an existing stop file / audit history keeps working). */
  home?: string;
}

export async function createDesktopMCP(opts: DesktopMCPOptions = {}) {
  const home = opts.home ?? process.env.NEXUS_BROWSER_HOME ?? path.join(os.homedir(), '.nexus-cortex', 'browser');
  const server = new McpServer({ name: 'nexus-desktop', version: '0.10.5' });
  const desktop = registerDesktopTool(server, home);
  if (!desktop) throw new Error('nexus-desktop: NEXUS_DESKTOP is not set to virtual|real — run `cortex desktop enable`');
  return { server, desktop, async close() { try { await (desktop as any).close?.(); } catch { /* best effort */ } } };
}
