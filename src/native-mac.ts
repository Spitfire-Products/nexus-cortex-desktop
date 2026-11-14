// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Spitfire-Commercial
// Copyright (c) 2025-2026 Spitfire Products. See LICENSE and LICENSE-COMMERCIAL.md.
/**
 * macOS native automation (0.11.0; plan browser-desktop-surfaces-plan-2026-11-12 §5c items 4–5; formats measured on the m2, macOS 15.3.1,
 * agent-home knowledge/m2-native-automation/REPORT.md):
 *  - osa: AppleScript / JXA — compile with osacompile (validate), run with osascript; errors parsed into position + error number + a hint.
 *  - shortcuts: list / run the user's EXISTING Shortcuts through the `shortcuts` CLI (no headless create/import exists; importing needs the
 *    user's "Add Shortcut" click). Exit code is the only reliable signal: `shortcuts` prints Obj-C runtime noise on stderr every time.
 * Pure parsers are exported for tests; the runners take an exec function so tests can stub it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type OsaLang = 'applescript' | 'jxa';
export interface OsaError { message: string; number?: number; line?: number; start?: number; end?: number; hint?: string }
export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<ExecResult>;

// the optional file part must contain a non-digit, so a bare `33:36: execution error` (osascript -e) is read as offsets, not as file 33
const ERR_LINE = /^(?:([^:\n]*[^\d:\n][^:\n]*):)?(?:(\d+):(\d+):|(\d+):) (?:execution )?error: (.*?)(?: \((-?\d+)\))?$/;
const ERR_BARE = /^(?:execution )?error: (.*?)(?: \((-?\d+)\))?$/;

/** What an error number means for the user (permission states from Apple's AE / AX docs, as listed in the m2 report). */
export function osaHint(num?: number): string | undefined {
  switch (num) {
    case -1743: return 'Automation is not allowed for this app: System Settings → Privacy & Security → Automation → allow the terminal to control it.';
    case -1744: return 'macOS will ask the user to allow Automation for this app — the first call shows a prompt; ask the user to accept it.';
    case -1719: case -25211: return 'Accessibility is not granted to the terminal app (System Settings → Privacy & Security → Accessibility).';
    case -600: return 'The target app is not running — launch it first.';
    case -1728: return 'The object does not exist (check the name/index against the app dictionary).';
    case -2741: case -2740: case -2700: return 'Syntax error — fix the script at the reported position and validate again.';
    default: return undefined;
  }
}

/** Parse one osacompile/osascript error (stderr). Compile errors carry a LINE; run errors carry START:END character offsets; JXA run
 *  errors carry neither. Returns the first error line found. */
export function parseOsaError(stderr: string): OsaError | null {
  for (const raw of stderr.split(/\r?\n/)) {
    const l = raw.trim(); if (!l) continue;
    let m = ERR_LINE.exec(l);
    if (m) {
      const num = m[6] !== undefined ? Number(m[6]) : undefined;
      const e: OsaError = { message: m[5]!, ...(num !== undefined ? { number: num } : {}) };
      if (m[2] !== undefined) { e.start = Number(m[2]); e.end = Number(m[3]); } else if (m[4] !== undefined) e.line = Number(m[4]);
      const h = osaHint(num); if (h) e.hint = h;
      return e;
    }
    m = ERR_BARE.exec(l);
    if (m) { const num = m[2] !== undefined ? Number(m[2]) : undefined; const h = osaHint(num); return { message: m[1]!, ...(num !== undefined ? { number: num } : {}), ...(h ? { hint: h } : {}) }; }
  }
  return null;
}

/** `shortcuts` prints this Obj-C runtime noise on EVERY call (m2 report §A.2) — drop it before reading stderr. */
export function stripShortcutsNoise(stderr: string): string {
  return stderr.split(/\r?\n/).filter((l) => l.trim() && !/Unrecognized attribute string flag/.test(l)).join('\n').trim();
}

function tmp(ext: string): string { return path.join(os.tmpdir(), `nexus-desktop-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`); }

/** Validate (compile only) or run an AppleScript / JXA source. Never throws for script errors: returns ok:false with the parsed error. */
export async function runOsa(exec: Exec, source: string, lang: OsaLang, opts: { validate?: boolean; timeoutMs?: number } = {}):
  Promise<{ ok: boolean; output?: string; error?: OsaError; compiled?: boolean }> {
  const ext = lang === 'jxa' ? '.js' : '.applescript';
  const src = tmp(ext); fs.writeFileSync(src, source, 'utf8');
  const l = lang === 'jxa' ? 'JavaScript' : 'AppleScript';
  try {
    const out = tmp('.scpt');
    const c = await exec('osacompile', ['-l', l, '-o', out, src], { timeoutMs: opts.timeoutMs ?? 20000 });
    fs.rmSync(out, { force: true });
    if (c.code !== 0) return { ok: false, compiled: false, error: parseOsaError(c.stderr) ?? { message: c.stderr.trim().slice(0, 400) || `osacompile exit ${c.code}` } };
    if (opts.validate) return { ok: true, compiled: true };
    const r = await exec('osascript', ['-l', l, src], { timeoutMs: opts.timeoutMs ?? 60000 });
    if (r.code !== 0) return { ok: false, compiled: true, error: parseOsaError(r.stderr) ?? { message: r.stderr.trim().slice(0, 400) || `osascript exit ${r.code}` } };
    return { ok: true, compiled: true, output: r.stdout.replace(/\n$/, '') };
  } finally { fs.rmSync(src, { force: true }); }
}

/** List the user's Shortcuts (names only) or run one by name with optional text input; output is read from a temp file. */
export async function runShortcuts(exec: Exec, op: 'list' | 'run', name?: string, input?: string, opts: { outputType?: string; timeoutMs?: number } = {}):
  Promise<{ ok: boolean; output?: string; names?: string[]; error?: string }> {
  if (op === 'list') {
    const r = await exec('shortcuts', ['list'], { timeoutMs: opts.timeoutMs ?? 20000 });
    if (r.code !== 0) return { ok: false, error: stripShortcutsNoise(r.stderr) || `shortcuts list exit ${r.code}` };
    return { ok: true, names: r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };
  }
  if (!name) return { ok: false, error: 'run needs the shortcut name' };
  const args = ['run', name]; const files: string[] = [];
  if (typeof input === 'string') { const f = tmp('.txt'); fs.writeFileSync(f, input, 'utf8'); files.push(f); args.push('-i', f); }
  const outF = tmp('.out'); files.push(outF); args.push('-o', outF);
  if (opts.outputType) args.push('--output-type', opts.outputType);
  try {
    const r = await exec('shortcuts', args, { timeoutMs: opts.timeoutMs ?? 120000 });
    if (r.code !== 0) return { ok: false, error: stripShortcutsNoise(r.stderr) || `shortcuts run exit ${r.code}` };
    let output = ''; try { output = fs.readFileSync(outF, 'utf8'); } catch { output = r.stdout; }
    return { ok: true, output: output.replace(/\n$/, '') };
  } finally { for (const f of files) fs.rmSync(f, { force: true }); }
}
