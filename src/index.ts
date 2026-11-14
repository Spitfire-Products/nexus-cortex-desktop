// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Spitfire-Commercial
// Copyright (c) 2025-2026 Spitfire Products. See LICENSE and LICENSE-COMMERCIAL.md.
// @nexus-cortex/desktop — split out of @nexus-cortex/browser in 0.9.0 (2026-11-12, operator: browser and desktop are separate surfaces).
export * from './desktop.js';
export { createDesktopMCP } from './mcp.js';
export type { DesktopMCPOptions } from './mcp.js';
export { parseOsaError, osaHint, stripShortcutsNoise, runOsa, runShortcuts } from './native-mac.js';
