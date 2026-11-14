#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Spitfire-Commercial
// Copyright (c) 2025-2026 Spitfire Products. See LICENSE and LICENSE-COMMERCIAL.md.
// `nexus-desktop` (0.10.4): the desktop tool as a stdio MCP server, for any MCP host (Claude Code: `claude mcp add nexus-desktop -- nexus-desktop`).
// Refuses to start unless NEXUS_DESKTOP (or the legacy NEXUS_BROWSER_DESKTOP) is virtual|real — `cortex desktop enable` sets it.
import './stdio-guard.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDesktopMCP } from './mcp.js';

let made: Awaited<ReturnType<typeof createDesktopMCP>>;
try { made = await createDesktopMCP(); }
catch (e) { process.stderr.write(`${(e as Error).message}\n`); process.exit(2); }
const { server, close } = made;
await server.connect(new StdioServerTransport());
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void close().finally(() => process.exit(0)); });
