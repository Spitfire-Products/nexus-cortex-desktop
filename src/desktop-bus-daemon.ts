// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Spitfire-Commercial
// Copyright (c) 2025-2026 Spitfire Products. See LICENSE and LICENSE-COMMERCIAL.md.
// desktop-bus-daemon — the DETACHED process behind `desktop {action:"bus", op:"start"}` (0.8.1). Field 11-07 (macbook): bus state lived in
// the calling process and its timers are unref'd, so a one-shot caller's bus died the moment that process exited. `bus start` now
// spawns THIS file detached; it runs watch + bus with a ref'd keep-alive, writes <home>/bus-status.json every 15 s (no key material),
// removes <home>/bus.pid on exit, and stops cleanly on SIGTERM (bus stop sends it — by PID, never by pattern).
import fs from 'node:fs';
import path from 'node:path';
import { createDesktop, desktopMode } from './desktop.js';

const home = String(process.env.NEXUS_BROWSER_DESKTOP_HOME ?? '');
if (!home) { console.error('desktop-bus-daemon: NEXUS_BROWSER_DESKTOP_HOME is not set'); process.exit(2); }
const pidFile = path.join(home, 'bus.pid'), statusFile = path.join(home, 'bus-status.json');
let args: Record<string, unknown> = {};
try { args = JSON.parse(String(process.env.NEXUS_BUS_ARGS ?? '{}')); } catch { /* defaults */ }

const d = createDesktop({ mode: desktopMode() ?? 'real', home, guestDir: process.env.NEXUS_BROWSER_GUEST_DIR || undefined });
const writeStatus = async (extra: Record<string, unknown> = {}) => {
  try {
    const s = JSON.parse((await d.handle({ action: 'bus', op: 'status' })).content[0].text);
    const w = JSON.parse((await d.handle({ action: 'watch', op: 'status' })).content[0].text);
    fs.writeFileSync(`${statusFile}.tmp`, JSON.stringify({ ...s, daemon: true, pid: process.pid, watch_polls: w.polls, watch_p50_ms: w.poll_p50_ms, updated: new Date().toISOString(), ...extra }, null, 1));
    fs.renameSync(`${statusFile}.tmp`, statusFile);
  } catch { /* best effort */ }
};
const cleanup = () => { try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile); } catch { /* gone */ } };
const shutdown = async (why: string) => { try { await d.handle({ action: 'bus', op: 'stop' }); } catch { /* ignore */ } await writeStatus({ on: false, stopped: why }); cleanup(); process.exit(0); };
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('exit', cleanup);

fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));
const r = await d.handle({ action: 'bus', op: 'start', ...args, detach: false });
await writeStatus({ start_result: String(r.content?.[0]?.text ?? '').slice(0, 400), start_error: r.isError === true });
if (r.isError) { cleanup(); process.exit(1); }
setInterval(() => { void writeStatus(); }, 15_000);   // ref'd on purpose: this interval IS the keep-alive
