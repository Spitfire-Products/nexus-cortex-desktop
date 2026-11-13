// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Spitfire-Commercial
// Copyright (c) 2025-2026 Spitfire Products. See LICENSE and LICENSE-COMMERCIAL.md.
// Bundle @nexus-cortex/desktop. zod stays EXTERNAL (peer): the MCP server that registers the tool must share one zod instance with it.
import * as esbuild from 'esbuild';
await esbuild.build({
  entryPoints: { index: 'src/index.ts', desktop: 'src/desktop.ts', 'desktop-script': 'src/desktop-script.ts', 'desktop-bus-daemon': 'src/desktop-bus-daemon.ts' },
  outdir: 'dist', bundle: true, platform: 'node', format: 'esm', target: 'node20', splitting: true, sourcemap: true,
  external: ['zod', '@modelcontextprotocol/sdk', 'node:*'], logLevel: 'warning',
});
console.log('[build] @nexus-cortex/desktop → dist/');
