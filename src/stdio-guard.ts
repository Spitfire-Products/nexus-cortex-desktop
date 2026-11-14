// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Spitfire-Commercial
// Copyright (c) 2025-2026 Spitfire Products. See LICENSE and LICENSE-COMMERCIAL.md.
// Imported FIRST by the stdio server: stdout carries the MCP protocol only, so every console channel goes to stderr.
const toErr = (...a: unknown[]) => { process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); };
console.log = toErr; console.info = toErr; console.warn = toErr; console.debug = toErr;
export {};
