// desktop.ts — the `desktop` tool: see and drive a WHOLE DISPLAY with mouse + keyboard (DESKTOP_SCOPE_PLAN.md, phases 1 + 3).
// Local package only (never the hosted Worker). OFF unless NEXUS_BROWSER_DESKTOP is set:
//   virtual → a Linux X display that is not the user's (default :99, the sandbox's Xvfb; or NEXUS_BROWSER_DESKTOP_DISPLAY)
//   real    → the user's own screen: macOS (screencapture + CGEvent/cliclick + System Events) or Linux X11 ($DISPLAY)
// Actions use Anthropic computer-use names. Coordinates are in SCREENSHOT pixels (the screenshot is scaled to fit
// NEXUS_BROWSER_DESKTOP_MAX_WIDTH, default 1280); the tool maps them to screen points.
// Safety: a stop file (<home>/DESKTOP_STOP) halts every action; in real mode, parking the cursor on the FAILSAFE SPOT trips it
// (macOS: middle of the top edge — Hot Corners may hold all four corners; Linux: top-left; NEXUS_BROWSER_DESKTOP_FAILSAFE overrides; `info` reports it); `launch` runs allow-listed apps only; every action is appended to desktop-actions.log
// (typed text is logged by LENGTH only — it can hold secrets).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { hotkeyFor, hotkeyCatalog, comboToKeyEquivalent, keyEquivalentTitle, parseKeyEquivalents, parseLine, substitute, MACRO_NAME, type HotkeyPlatform, validateScript, formatValidateReport, parseMenuList } from './desktop-script.js';

type Mode = 'virtual' | 'real';
/** 0.2.6 (field: typing into a Parallels Windows guest dropped/mangled characters): `paste` = clipboard + paste key (clipboard restored);
 *  `charDelayMs` = one character at a time with a pause. */
export type TypeOpts = { via?: 'keys' | 'paste'; charDelayMs?: number; pasteKey?: string };
const VERSION = '0.10.6';
type Pt = { x: number; y: number };
type Shot = { png: Buffer; width: number; height: number };

export interface DesktopBackend {
  name: string;
  size(): Promise<{ w: number; h: number }>;                       // screen size in input points
  capture(w: number, h: number, region?: [number, number, number, number]): Promise<Buffer>;   // PNG at w×h (region in points)
  move(p: Pt): Promise<void>;
  click(p: Pt, button: 'left' | 'right' | 'middle', count: number): Promise<void>;
  drag(a: Pt, b: Pt): Promise<void>;
  scroll(p: Pt, dir: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void>;
  type(text: string, opts?: TypeOpts): Promise<void>;
  key(combo: string): Promise<void>;
  cursor(): Promise<Pt>;
  launch(app: string): Promise<void>;
  windows(): Promise<string>;
  focus(target: string): Promise<void>;
  /** Screen corners the OS has bound to an action (macOS Hot Corners) — the failsafe must not use them. */
  hotCorners?(): Promise<Corner[]>;
  /** Can this process post input / capture other windows? (macOS TCC; undefined = not applicable) */
  permissions?(): Promise<{ accessibility?: boolean; screen_recording?: boolean }>;
  /** Name of the frontmost app (macOS) — lets a caller detect focus theft after a click (0.2.8). */
  frontApp?(): Promise<string>;
  /** 0.3 (macOS): the front (or named) app's menus with their shortcuts, and invoking a menu item by path — via Accessibility. */
  menuList?(app?: string, top?: string, includeRecent?: boolean): Promise<string>;
  menuInvoke?(path: string[], app?: string): Promise<string>;
  /** 0.3 (macOS): App Shortcuts = NSUserKeyEquivalents in the app's defaults domain (what System Preferences → Keyboard → App Shortcuts writes). */
  shortcutSet?(app: string, title: string, equiv: string): Promise<string>;
  shortcutList?(app: string): Promise<Record<string, string>>;
  shortcutRemove?(app: string, title: string): Promise<string>;
  /** 0.4 (macOS): the Accessibility element tree of an app's window — nexus-sense scan/grab parity for native apps. */
  axScan?(o: { app?: string; window?: string; max?: number; depth?: number; budget_ms?: number }): Promise<AxTree>;
  axAct?(o: { app: string; window: string; path: number[]; act: 'press' | 'set' | 'get'; value?: string }): Promise<AxEl & { ok: boolean; note?: string }>;
  /** 0.6: a cheap snapshot for desktop context + the event watcher (front app/window, windows, apps, focused element role/title/value length+hash). */
  state?(o?: { full?: boolean; timeoutMs?: number }): Promise<DeskState>;
}
export type Corner = 'tl' | 'tr' | 'bl' | 'br';
/** One accessibility element: path = child indices from the window; x,y,w,h in SCREEN POINTS. */
export type AxEl = { p: number[]; r: string; sr?: string; t: string; d: string; v: string; x: number; y: number; w: number; h: number; e: boolean; f?: boolean; n?: number; help?: string };
export type AxTree = { app: string; window: string; els: AxEl[]; truncated?: boolean; timed_out?: boolean; ms?: number; events?: number; batched?: number; abatched?: number; batch?: boolean | null; diag?: { children: number; ms: number; attr_ms: Record<string, number> } | null };

// ── 0.6: desktop CONTEXT + EVENTS (the SPA's {{workspaceContext}} + CortexEventBus, for a real desktop). A backend's state() is a cheap
//    snapshot (front app/window, every window, running apps, the focused element's role/title + value LENGTH/HASH — never its text);
//    the watcher diffs consecutive snapshots into typed events. Pure + exported so the X11 fixtures and unit tests drive it directly.
export type DeskWin = { app: string; title: string; sr?: string; cls?: string; id?: string; x?: number; y?: number; w?: number; h?: number };
export type DeskFocus = { r: string; t: string; n: number | null; h: number; cls?: string } | null;
export type DeskState = { app: string; window: string; windows: DeskWin[]; apps: string[]; focus: DeskFocus; fgCls?: string; partial?: boolean; ms?: number };
/** 0.6.1: a LIGHT snapshot (front app only: its windows + focus) folded into the last full one — the other apps keep their last known
 *  windows, so a light tick never reports them as closed; launches/quits/other-app windows surface on the next full tick. */
export function mergeLight(prev: DeskState | null, light: DeskState): DeskState {
  if (!light.partial || !prev) return light;
  const others = prev.windows.filter(w => w.app !== light.app);
  return { ...light, partial: false, windows: [...light.windows, ...others], apps: prev.apps.includes(light.app) || !light.app ? prev.apps : [...prev.apps, light.app] };
}
export type DeskEvent = { type: string; src: string; app?: string; title?: string; from?: string; to?: string; role?: string; chars?: number | null; dialog?: boolean; path?: string; note?: string };
export const isDialogWin = (w: DeskWin) => /AXDialog|AXSystemDialog|AXSheet/.test(w.sr ?? '') || w.cls === '#32770';
const winKey = (w: DeskWin) => w.id ?? `${w.app}\u0000${w.title}`;
export function diffState(prev: DeskState | null, next: DeskState, src: string): DeskEvent[] {
  const ev: DeskEvent[] = [];
  if (!prev) return ev;
  const pa = new Set(prev.apps), na = new Set(next.apps);
  for (const a of next.apps) if (!pa.has(a)) ev.push({ type: 'app_launched', src, app: a });
  for (const a of prev.apps) if (!na.has(a)) ev.push({ type: 'app_quit', src, app: a });
  const pk = new Map(prev.windows.map(w => [winKey(w), w] as const)), nk = new Map(next.windows.map(w => [winKey(w), w] as const));
  // same window id, new title (X11 / Windows guest: windows carry an id)
  for (const w of next.windows) { const p = w.id ? pk.get(winKey(w)) : undefined; if (p && p.title !== w.title) ev.push({ type: 'window_retitled', src, app: w.app, from: p.title, to: w.title }); }
  const closed = prev.windows.filter(w => !nk.has(winKey(w))), opened = next.windows.filter(w => !pk.has(winKey(w)));
  // macOS windows have no id: a close + open in the same app with the same non-zero geometry in one tick = a retitle
  for (const o of [...opened]) {
    const i = closed.findIndex(c => c.app === o.app && (c.w ?? 0) > 0 && c.x === o.x && c.y === o.y && c.w === o.w && c.h === o.h);
    if (i >= 0) { ev.push({ type: 'window_retitled', src, app: o.app, from: closed[i].title, to: o.title }); closed.splice(i, 1); opened.splice(opened.indexOf(o), 1); }
  }
  for (const w of opened) ev.push({ type: 'window_opened', src, app: w.app, title: w.title, ...(isDialogWin(w) ? { dialog: true } : {}) });
  for (const w of closed) ev.push({ type: 'window_closed', src, app: w.app, title: w.title });
  if (prev.app !== next.app) ev.push({ type: 'app_activated', src, app: next.app, from: prev.app, title: next.window });
  else if (prev.window !== next.window && !ev.some(e => e.type === 'window_retitled' && e.from === prev.window && e.to === next.window))
    ev.push({ type: 'window_focused', src, app: next.app, title: next.window, from: prev.window });
  const pf = prev.focus, nf = next.focus;
  if (nf && (!pf || pf.r !== nf.r || pf.t !== nf.t || pf.cls !== nf.cls)) ev.push({ type: 'focus_changed', src, app: next.app, role: nf.r, title: nf.t, chars: nf.n });
  else if (nf && pf && nf.h !== pf.h) ev.push({ type: 'value_changed', src, app: next.app, role: nf.r, title: nf.t, chars: nf.n });
  return ev;
}
const q = (s?: string) => JSON.stringify(String(s ?? '').slice(0, 70));
export function fmtEvent(e: DeskEvent & { seq?: number; ts?: string }): string {
  const t = e.ts ? new Date(e.ts).toTimeString().slice(0, 8) + ' ' : '';
  const s = e.src === 'host' ? '' : `${e.src}:`;
  const body = e.type === 'app_activated' ? `${e.app} (from ${e.from || '-'})${e.title ? ` ${q(e.title)}` : ''}`
    : e.type === 'window_opened' ? `${e.app} ${q(e.title)}${e.dialog ? ' [dialog]' : ''}`
    : e.type === 'window_closed' ? `${e.app} ${q(e.title)}`
    : e.type === 'window_focused' ? `${e.app} ${q(e.title)} (from ${q(e.from)})`
    : e.type === 'window_retitled' ? `${e.app} ${q(e.from)} -> ${q(e.to)}`
    : e.type === 'focus_changed' ? `${e.app} ${e.role} ${q(e.title)}${e.chars != null ? ` (${e.chars} chars)` : ''}`
    : e.type === 'value_changed' ? `${e.app} ${e.role} ${q(e.title)} -> ${e.chars ?? '?'} chars`
    : e.path ? e.path : [e.app, e.note].filter(Boolean).join(' ');
  return `${e.seq != null ? `#${e.seq} ` : ''}${t}${s}${e.type} ${body}`.trim();
}
/** Roles an agent can act on (nexus-sense "isInteractive" parity). */
export const AX_INTERACTIVE = new Set(['AXButton', 'AXCheckBox', 'AXRadioButton', 'AXTextField', 'AXTextArea', 'AXSecureTextField', 'AXSearchField',
  'AXPopUpButton', 'AXComboBox', 'AXMenuButton', 'AXSlider', 'AXIncrementor', 'AXLink', 'AXTab', 'AXDisclosureTriangle', 'AXColorWell', 'AXDateField',
  'AXSegmentedControl', 'AXRow', 'AXCell', 'AXMenuItem']);
/** 0.5.4 (field, Win7 guest): MSAA-bridged Win32 controls report UIA role 'Pane' while ClassName tells the truth — the interactive filter
 *  also matches by window class (plain Win32 + WinForms-wrapped names). */
export const GUEST_INTERACTIVE_CLASS = /^(?:WindowsForms10\.)?(?:Edit|Button|ComboBox|ComboBoxEx32|ComboLBox|ListBox|SysListView32|SysTreeView32|SysDateTimePick32|SysMonthCal32|SysTabControl32|SysLink|RichEdit\w*|msctls_\w+)(?:\.|$)/i;
export const GUEST_INTERACTIVE_ROLES = new Set(['Button', 'CheckBox', 'RadioButton', 'Edit', 'ComboBox', 'List', 'ListItem', 'MenuItem', 'Hyperlink', 'Tab', 'TabItem',
  'Spinner', 'Slider', 'TreeItem', 'DataItem', 'SplitButton', 'Calendar', 'MenuBar', 'Menu']);
export const guestInteractive = (el: { r?: string; cls?: string }) => GUEST_INTERACTIVE_ROLES.has(String(el.r)) || GUEST_INTERACTIVE_CLASS.test(String(el.cls ?? ''));
/** Row role label: a Pane shows its class (Pane[Edit]) — on Win7 that is the only truthful type. */
export const guestRole = (el: { r?: string; cls?: string }) => `${el.r}${el.r === 'Pane' && el.cls ? `[${el.cls}]` : ''}`;
export type FailsafeSpot = Corner | 'top' | 'bottom';

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string, timeoutMs = 30_000) =>
  new Promise<Buffer>((resolve, reject) => {
    const child = execFile(cmd, args, { env: env ?? process.env, encoding: 'buffer', maxBuffer: 64 << 20, timeout: timeoutMs },
      // 0.6.1 (macbook): the message used to embed `-e <the whole JXA script>` BEFORE stderr, so the real error was cut off — args are
      // abbreviated now, stderr comes first-class, and a timeout says so
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const a = args.slice(0, 3).map(x => (x.length > 40 ? `${x.slice(0, 37)}...` : x)).join(' ');
        const why = (err as any).killed || (err as any).signal === 'SIGTERM' ? `timed out after ${Math.round(timeoutMs / 1000)} s` : '';
        reject(new Error(`${cmd} ${a}: ${[why, String(stderr || '').trim() || (why ? '' : err.message)].filter(Boolean).join(' — ').slice(0, 600)}`));
      });
    if (input !== undefined) { child.stdin?.end(input); }
  });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const onPath = (bin: string) => (process.env.PATH ?? '').split(path.delimiter).some(d => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } });

// ── key names → per-platform form ────────────────────────────────────────────────────────────────────────────────────────
// Accepts xdotool/Anthropic style: "Return", "ctrl+a", "cmd+space", "shift+Tab", "Escape", "F5", "Page_Down", "super+l".
const MOD_ALIASES: Record<string, string> = { cmd: 'cmd', command: 'cmd', super: 'cmd', meta: 'cmd', win: 'cmd', ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift', fn: 'fn' };
export function parseCombo(combo: string): { mods: string[]; key: string } {
  const parts = combo.trim().split('+').map(s => s.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const mods = parts.map(m => MOD_ALIASES[m.toLowerCase()] ?? m.toLowerCase());
  return { mods, key };
}
// macOS virtual key codes for named keys (Events.h kVK_*).
const MAC_KEYCODES: Record<string, number> = { return: 36, enter: 36, kp_enter: 76, tab: 48, space: 49, backspace: 51, delete: 51, escape: 53, esc: 53,
  forwarddelete: 117, home: 115, end: 119, page_up: 116, pageup: 116, prior: 116, page_down: 121, pagedown: 121, next: 121,
  left: 123, right: 124, down: 125, up: 126, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
export function macKeyScript(combo: string): string {
  const { mods, key } = parseCombo(combo);
  const using = mods.filter(m => m !== 'fn').map(m => ({ cmd: 'command down', ctrl: 'control down', alt: 'option down', shift: 'shift down' } as any)[m]).filter(Boolean);
  const u = using.length ? ` using {${using.join(', ')}}` : '';
  const code = MAC_KEYCODES[key.toLowerCase().replace(/[\s-]/g, '_')] ?? MAC_KEYCODES[key.toLowerCase().replace(/[\s_-]/g, '')];
  if (code !== undefined) return `tell application "System Events" to key code ${code}${u}`;
  if ([...key].length !== 1) throw new Error(`unknown key "${key}" (use a single character or a named key: Return, Tab, Escape, Up, F5, Page_Down …)`);
  return `tell application "System Events" to keystroke ${asLiteral(key)}${u}`;
}
export function xdoKey(combo: string): string {
  const { mods, key } = parseCombo(combo);
  const xm = mods.map(m => ({ cmd: 'super', ctrl: 'ctrl', alt: 'alt', shift: 'shift' } as any)[m] ?? m);
  const named: Record<string, string> = { enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete',
    pageup: 'Page_Up', page_up: 'Page_Up', pagedown: 'Page_Down', page_down: 'Page_Down', space: 'space', tab: 'Tab', up: 'Up', down: 'Down', left: 'Left', right: 'Right' };
  return [...xm, named[key.toLowerCase()] ?? key].join('+');
}
/** AppleScript string literal (quotes + backslashes escaped; newlines become `return`). */
export function asLiteral(s: string): string {
  return s.split('\n').map(l => `"${l.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' & return & ');
}

/** X11 window titles via `xdotool getwindowname` come back double-encoded (UTF-8 bytes read as cp1252/latin1, then re-encoded): "—" → "â€”".
 *  Reverse that when the result decodes cleanly (0.2.5; found by test/field-desktop.mjs). Plain ASCII / already-correct text is returned as is. */
const CP1252: Record<string, number> = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
/** zoom region: [x1, y1, x2, y2] | {x1, y1, x2, y2} | {x, y, width|w, height|h} → [x1, y1, x2, y2] (0.2.10: callers reach for the object form). */
export function normRegion(r: any): [number, number, number, number] | null {
  if (Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)) return r as [number, number, number, number];
  if (r && typeof r === 'object') {
    if ([r.x1, r.y1, r.x2, r.y2].every(Number.isFinite)) return [r.x1, r.y1, r.x2, r.y2];
    const w = r.width ?? r.w, h = r.height ?? r.h;
    if ([r.x, r.y, w, h].every(Number.isFinite)) return [r.x, r.y, r.x + w, r.y + h];
  }
  return null;
}
export function fixMojibake(t: string): string {
  if (!/[\u00c2-\u00f4][\u0080-\u00bf\u0152-\u0192\u02c6-\u02dc\u2013-\u203a\u20ac\u2122]/.test(t)) return t;
  const bytes: number[] = [];
  for (const ch of t) { const c = ch.codePointAt(0)!; if (c < 0x100) bytes.push(c); else if (CP1252[ch] !== undefined) bytes.push(CP1252[ch]); else return t; }
  const out = Buffer.from(bytes).toString('utf8');
  return out.includes('\ufffd') ? t : out;
}

// ── Linux X11 (virtual Xvfb or the user's DISPLAY): xdotool + ImageMagick ────────────────────────────────────────────────────
export function x11Backend(display: string, apps: string[]): DesktopBackend {
  const env = { ...process.env, DISPLAY: display };
  const xdo = (...a: string[]) => run('xdotool', a, env);
  const btn = (b: string) => (b === 'right' ? '3' : b === 'middle' ? '2' : '1');
  return {
    name: `x11 ${display}`,
    async size() { const [w, h] = String(await xdo('getdisplaygeometry')).trim().split(/\s+/).map(Number); return { w, h }; },
    async capture(w, h, region) {
      const crop = region ? ['-crop', `${region[2] - region[0]}x${region[3] - region[1]}+${region[0]}+${region[1]}`, '+repage'] : [];
      return run('import', ['-silent', '-window', 'root', ...crop, '-resize', `${w}x${h}!`, 'png:-'], env);
    },
    async move(p) { await xdo('mousemove', '--sync', String(p.x), String(p.y)); },
    async click(p, b, n) { await xdo('mousemove', '--sync', String(p.x), String(p.y), 'click', '--repeat', String(n), '--delay', '90', btn(b)); },
    async drag(a, b) {
      await xdo('mousemove', '--sync', String(a.x), String(a.y), 'mousedown', '1');
      await sleep(80); await xdo('mousemove', '--sync', String(b.x), String(b.y)); await sleep(80); await xdo('mouseup', '1');
    },
    async scroll(p, dir, amount) {
      const b = { up: '4', down: '5', left: '6', right: '7' }[dir];
      await xdo('mousemove', '--sync', String(p.x), String(p.y), 'click', '--repeat', String(Math.max(1, amount)), '--delay', '40', b);
    },
    async type(text, opts) {
      if (opts?.via === 'paste') throw new Error('type_via "paste" is not supported on X11 yet (needs xclip); use keys with char_delay_ms');
      await xdo('type', '--delay', String(Math.max(12, Math.min(500, opts?.charDelayMs ?? 12))), '--', text);
    },
    async key(combo) { await xdo('key', '--clearmodifiers', ...combo.trim().split(/\s+/).map(xdoKey)); },
    async cursor() { const o = String(await xdo('getmouselocation', '--shell')); return { x: Number(/X=(\d+)/.exec(o)?.[1]), y: Number(/Y=(\d+)/.exec(o)?.[1]) }; },
    async launch(app) {
      if (!apps.includes(app)) throw new Error(`"${app}" is not in the launch allow-list (${apps.join(', ')}); set NEXUS_BROWSER_DESKTOP_APPS to change it`);
      const c = spawn(app, [], { env, detached: true, stdio: 'ignore' }); c.unref();
    },
    async windows() {
      const ids = String(await xdo('search', '--onlyvisible', '--name', '.').catch(() => Buffer.from(''))).trim().split('\n').filter(Boolean);
      const rows: string[] = [];
      for (const id of ids.slice(0, 60)) {
        const name = fixMojibake(String(await xdo('getwindowname', id).catch(() => Buffer.from('?'))).trim());
        const g = String(await xdo('getwindowgeometry', '--shell', id).catch(() => Buffer.from('')));
        const v = (k: string) => /\d+/.exec(new RegExp(`${k}=(\\d+)`).exec(g)?.[0] ?? '')?.[0] ?? '?';
        rows.push(`${id}\t${name}\t${v('X')},${v('Y')} ${v('WIDTH')}x${v('HEIGHT')}`);
      }
      return rows.join('\n') || '(no visible windows)';
    },
    async state(_o?: { full?: boolean; timeoutMs?: number }) {   // 0.6: window ids as identity (always full: xdotool is cheap); app = the owning process (/proc/<pid>/comm); no focused-element detail (AT-SPI not wired)
      const ids = String(await xdo('search', '--onlyvisible', '--name', '.').catch(() => Buffer.from(''))).trim().split('\n').filter(Boolean).slice(0, 40);
      const comm = (pid: string) => { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return '?'; } };
      const windows: DeskWin[] = [];
      for (const id of ids) {
        const title = fixMojibake(String(await xdo('getwindowname', id).catch(() => Buffer.from(''))).trim());
        const pid = String(await xdo('getwindowpid', id).catch(() => Buffer.from(''))).trim();
        windows.push({ id, app: /^\d+$/.test(pid) ? comm(pid) : '?', title });
      }
      const act = String(await xdo('getactivewindow').catch(() => xdo('getwindowfocus')).catch(() => Buffer.from(''))).trim();
      const fw = windows.find(w => w.id === act);
      return { app: fw?.app ?? '', window: fw?.title ?? '', windows, apps: [...new Set(windows.map(w => w.app))], focus: null };
    },
    async focus(target) {
      const id = /^\d+$/.test(target) ? target : String(await xdo('search', '--onlyvisible', '--name', target)).trim().split('\n')[0];
      if (!id) throw new Error(`no visible window matches "${target}"`);
      await xdo('windowactivate', '--sync', id).catch(() => xdo('windowfocus', '--sync', id));
    },
  };
}

// ── macOS (real desktop): screencapture + sips; mouse via cliclick when installed, else JXA CoreGraphics events; keys/text via
//    System Events. Needs the hosting app (Terminal / iTerm / the agent) granted Screen Recording + Accessibility in System Settings.
const JXA = `ObjC.import('CoreGraphics'); ObjC.import('AppKit');
function post(t, x, y, b, n) { var e = $.CGEventCreateMouseEvent(null, t, $.CGPointMake(x, y), b); if (n) $.CGEventSetIntegerValueField(e, 1, n); $.CGEventPost(0, e); }
function run(argv) {
  var op = argv[0], a = argv.slice(1).map(Number);
  if (op === 'perms') { ObjC.import('ApplicationServices'); var ax = $.AXIsProcessTrusted(); var sr = 2; try { ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]); sr = $.CGPreflightScreenCaptureAccess() ? 1 : 0; } catch (e) { sr = 2; } return (ax ? 1 : 0) + ' ' + sr; }
  if (op === 'size') { var f = $.NSScreen.mainScreen.frame; return f.size.width + ' ' + f.size.height; }
  if (op === 'cursor') { var p = $.CGEventGetLocation($.CGEventCreate(null)); return Math.round(p.x) + ' ' + Math.round(p.y); }
  if (op === 'move') { post(5, a[0], a[1], 0, 0); return 'ok'; }
  if (op === 'click') { var dn = {0: 1, 1: 3, 2: 25}[a[2]], up = {0: 2, 1: 4, 2: 26}[a[2]];
    post(5, a[0], a[1], a[2], 0); for (var i = 1; i <= a[3]; i++) { post(dn, a[0], a[1], a[2], i); post(up, a[0], a[1], a[2], i); delay(0.06); } return 'ok'; }
  if (op === 'drag') { post(5, a[0], a[1], 0, 0); post(1, a[0], a[1], 0, 1); delay(0.08);
    for (var s = 1; s <= 12; s++) { post(6, a[0] + (a[2] - a[0]) * s / 12, a[1] + (a[3] - a[1]) * s / 12, 0, 0); delay(0.015); } post(2, a[2], a[3], 0, 1); return 'ok'; }
  if (op === 'scrollonly') { // no CGPoint: the cursor was already moved by cliclick (Big Sur's bridge cannot marshal CG structs)
    if (typeof $.CGEventCreateScrollWheelEvent2 === 'function') { $.CGEventPost(0, $.CGEventCreateScrollWheelEvent2(null, 1, 2, a[0], a[1], 0)); }
    else { if (a[0]) $.CGEventPost(0, $.CGEventCreateScrollWheelEvent(null, 1, 1, a[0])); if (a[1]) $.CGEventPost(0, $.CGEventCreateScrollWheelEvent(null, 1, 2, 0, a[1])); }
    return 'ok'; }
  if (op === 'scroll') { post(5, a[0], a[1], 0, 0);
    // CGEventCreateScrollWheelEvent2 is macOS 13+; older systems (Big Sur) get the variadic original (one axis per event).
    if (typeof $.CGEventCreateScrollWheelEvent2 === 'function') { $.CGEventPost(0, $.CGEventCreateScrollWheelEvent2(null, 1, 2, a[2], a[3], 0)); }
    else { if (a[2]) $.CGEventPost(0, $.CGEventCreateScrollWheelEvent(null, 1, 1, a[2])); if (a[3]) $.CGEventPost(0, $.CGEventCreateScrollWheelEvent(null, 1, 2, 0, a[3])); }
    return 'ok'; }
  return 'unknown op ' + op;
}`;
const JXA_MENU_LIST = `function sc(mi) { try { var c = mi.attributes.byName('AXMenuItemCmdChar').value(); if (!c) return '';
  var m = mi.attributes.byName('AXMenuItemCmdModifiers').value(); var s = ''; if (m & 4) s += 'ctrl+'; if (m & 2) s += 'opt+'; if (m & 1) s += 'shift+'; if (!(m & 8)) s += 'cmd+'; return s + (c.length === 1 ? c.toLowerCase() : c); } catch (e) { return ''; } }
function run(argv) { var se = Application('System Events'); var p = argv[0] ? se.processes.byName(argv[0]) : se.processes.whose({ frontmost: true })[0];
  var top = argv[1] || '', recent = argv[2] === '1', out = [], bars = p.menuBars[0].menuBarItems();
  for (var i = 0; i < bars.length; i++) { var bn; try { bn = bars[i].name(); } catch (e) { continue; } if (top && bn !== top) continue; var items; try { items = bars[i].menus[0].menuItems(); } catch (e) { continue; }
    for (var j = 0; j < items.length; j++) { var it = items[j], n; try { n = it.name(); } catch (e) { continue; } if (!n) continue; var en = true; try { en = it.enabled(); } catch (e) {}
      var k = sc(it); out.push(bn + ' > ' + n + (k ? '\\t' + k : '') + (en ? '' : '\\t(disabled)'));
      if (!recent && /^(open recent|recent items|recent documents|recent files)$/i.test(n)) { out.push(bn + ' > ' + n + ' > …\t(recent items hidden; include_recent:true to list)'); continue; }
      try { var subs = it.menus[0].menuItems(); for (var q = 0; q < subs.length; q++) { var n2; try { n2 = subs[q].name(); } catch (e) { continue; } if (!n2) continue; var k2 = sc(subs[q]); out.push(bn + ' > ' + n + ' > ' + n2 + (k2 ? '\\t' + k2 : '')); } } catch (e) {} } }
  return p.name() + '\\n' + out.join('\\n'); }`;
const JXA_AX = `function pick(se, o) { var p = o.app ? se.processes.byName(o.app) : se.processes.whose({ frontmost: true })[0];
  var wins = p.windows(), w = null;
  if (o.window) { for (var i = 0; i < wins.length; i++) { try { if (String(wins[i].name()).toLowerCase().indexOf(String(o.window).toLowerCase()) >= 0) { w = wins[i]; break; } } catch (e) {} } }
  else if (wins.length) w = wins[0];
  if (!w) throw new Error('no window' + (o.window ? ' matching "' + o.window + '"' : '') + ' in ' + p.name());
  return { p: p, w: w }; }
function el(pr, path) { var props = {}; try { props = pr.properties(); } catch (e) {} return fromProps(props, path); }
function fromProps(props, path) { props = props || {};
  var pos = props.position || [0, 0], sz = props.size || [0, 0], v = props.value; if (v === null || v === undefined) v = '';
  var t = props.title || props.name || ''; if (t === null) t = '';
  return { p: path, r: String(props.role || ''), sr: String(props.subrole || ''), t: String(t), d: String(props.description || ''), v: String(v),
    x: Number(pos[0]) || 0, y: Number(pos[1]) || 0, w: Number(sz[0]) || 0, h: Number(sz[1]) || 0, e: props.enabled !== false, f: props.focused === true, help: String(props.help || '') }; }
function resolve(w, path) { var cur = w; for (var i = 0; i < path.length; i++) cur = cur.uiElements[path[i]]; return cur; }
function run(argv) { var o = JSON.parse(argv[0]), se = Application('System Events'), pw = pick(se, o);
  if (o.op === 'scan') { var out = [], max = o.max || 250, depth = o.depth || 12, trunc = false, events = 0, batched = 0, abatched = 0;
    // 0.4.1 (macbook: Finder 250 elements = 33 s at one Apple Event per element): fetch ALL children's properties in ONE event
    // (node.uiElements.properties()) and recurse only into CONTAINER roles; per-element fallback if the bridge refuses the batch form.
    var CONT = { AXGroup: 1, AXScrollArea: 1, AXSplitGroup: 1, AXToolbar: 1, AXTabGroup: 1, AXOutline: 1, AXTable: 1, AXRow: 1, AXList: 1, AXBrowser: 1,
      AXLayoutArea: 1, AXLayoutItem: 1, AXSheet: 1, AXDrawer: 1, AXCell: 1, AXColumn: 1, AXGrid: 1, AXRadioGroup: 1, AXPopover: 1, AXUnknown: 1, AXWebArea: 1, AXSplitter: 0 };
    var batchOK = null;   // 0.5.1: Big Sur refused the batch form at EVERY node in 0.4.1 (87.7 s / 501 events) — try once, cache the answer
    // 0.5.3 (macbook, Big Sur): per-ATTRIBUTE batching works where properties() is refused — node.uiElements.role() returns EVERY
    // child's role in ONE Apple Event (name(), position() … likewise). Roles first (gives the count); 4+ children → one event per attribute.
    var col = function (ue, attr, n) { events++; try { var r = ue[attr](); return (r && r.length === n) ? r : []; } catch (e) { return []; } };
    var t0 = Date.now(), budget = o.budget_ms || 90000, diag = null, timedOut = false;
    var walk = function (node, path, d) {
      if (Date.now() - t0 > budget) { trunc = true; timedOut = true; return; }   // 0.6.1: partial result instead of the 120 s osascript kill
      var props = null, kids = null, roles = null; events++;
      try { roles = node.uiElements.role(); } catch (e) { roles = null; }
      if (roles && roles.length === 0) return;
      // 0.6.1: batching costs 1 + 7 events vs n + 1 one-by-one → only for 8+ children (0.5.3's threshold of 4 slowed small windows 1.1 → 3.4 s)
      if (roles && roles.length >= 8) { var ue = node.uiElements, rn = roles.length; abatched++; var tb = Date.now(), tk = {};
        var tc = function (attr) { var t1 = Date.now(), r = col(ue, attr, rn); tk[attr] = Date.now() - t1; return r; };
        var nm = tc('name'), de = tc('description'), va = tc('value'), po = tc('position'), sz = tc('size'), en = tc('enabled'), fo = tc('focused');
        if (!diag || rn > diag.children) diag = { children: rn, role: String(path.length ? '' : 'window'), ms: Date.now() - tb, attr_ms: tk };
        props = []; for (var a = 0; a < rn; a++) props.push({ role: roles[a], name: nm[a], description: de[a], value: va[a], position: po[a], size: sz[a],
          enabled: en.length ? en[a] : undefined, focused: fo[a] }); }
      if (!props) events++;
      if (!props && batchOK !== false) { try { props = node.uiElements.properties(); batched++; batchOK = true; } catch (e) { props = null; if (batchOK === null) { batchOK = false; events++; } } }
      if (!props) { try { kids = node.uiElements(); } catch (e) { kids = []; } }
      var n = props ? props.length : kids.length;
      for (var i = 0; i < n; i++) { if (out.length >= max) { trunc = true; return; }
        var pth = path.concat([i]); var row = props ? fromProps(props[i], pth) : el(kids[i], pth); if (!props) events++;
        row.v = row.v.slice(0, 160); out.push(row);
        if (d < depth && CONT[row.r]) walk(node.uiElements[i], pth, d + 1); } };   // containers only, on BOTH paths
    walk(pw.w, [], 1);
    return JSON.stringify({ app: pw.p.name(), window: String(pw.w.name() || ''), els: out, truncated: trunc, timed_out: timedOut, ms: Date.now() - t0, events: events, batched: batched, abatched: abatched, batch: batchOK, diag: diag }); }
  var target = resolve(pw.w, o.path), note = '';
  if (o.op === 'press') { try { target.actions.byName('AXPress').perform(); note = 'AXPress'; } catch (e) { note = 'no AXPress: ' + e; } }
  if (o.op === 'set') { target.value = o.value; delay(0.1); note = 'value set'; }
  var r = el(target, o.path); var kids = 0; try { kids = target.uiElements().length; } catch (e) {} r.n = kids; r.ok = note.indexOf('no AXPress') !== 0; r.note = note;
  if (o.op !== 'get') r.v = r.v.slice(0, 4000);
  return JSON.stringify(r); }`;
const JXA_MENU_INVOKE = `function norm(s) { return String(s).replace(/\\u2026|\\.\\.\\.$/g, '').trim().toLowerCase(); }
function pick(coll, want) { var items = coll(); for (var i = 0; i < items.length; i++) { try { if (norm(items[i].name()) === norm(want)) return items[i]; } catch (e) {} }
  var names = []; for (var j = 0; j < items.length; j++) { try { names.push(items[j].name()); } catch (e) {} } throw new Error('no menu item "' + want + '" (have: ' + names.filter(Boolean).join(', ') + ')'); }
function run(argv) { var se = Application('System Events'), path = JSON.parse(argv[0]), app = argv[1];
  var p = app ? se.processes.byName(app) : se.processes.whose({ frontmost: true })[0]; if (app) { p.frontmost = true; delay(0.25); }
  var cur = pick(p.menuBars[0].menuBarItems, path[0]);
  for (var i = 1; i < path.length; i++) { var it = pick(cur.menus[0].menuItems, path[i]); if (i === path.length - 1) { it.click(); return 'clicked ' + path.join(' > ') + ' in ' + p.name(); } cur = it; }
  cur.click(); return 'opened ' + path[0]; }`;
// 0.6: one cheap desktop snapshot — window properties fetched per PROCESS in batched Apple Events (name/subrole/position/size = 4 events
// per app, not 4 per window); the focused element's value is reported as a LENGTH + HASH only (never the text; secure fields: nothing).
const JXA_STATE = `function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0; return h; }
function run(argv) { var t0 = Date.now(), full = argv[0] === 'full', se = Application('System Events'), out = { app: '', window: '', windows: [], apps: [], focus: null, partial: !full };
  try { out.app = se.processes.whose({ frontmost: true }).name()[0] || ''; } catch (e) {}
  var procs = null, names = [];
  if (full) { procs = se.processes.whose({ visible: true }); try { names = procs.name(); } catch (e) {} out.apps = names; }
  else if (out.app) { names = [out.app]; out.apps = [out.app]; }
  for (var i = 0; i < names.length; i++) { var p = full ? procs[i] : se.processes.byName(names[i]), t = [], sr = [], pos = [], sz = [];
    try { t = p.windows.name(); } catch (e) { continue; }
    try { sr = p.windows.subrole(); } catch (e) {}
    try { pos = p.windows.position(); } catch (e) {}
    try { sz = p.windows.size(); } catch (e) {}
    for (var j = 0; j < t.length && j < 25; j++) { var P = pos[j] || [0, 0], S = sz[j] || [0, 0];
      out.windows.push({ app: names[i], title: String(t[j] || ''), sr: String(sr[j] || ''), x: P[0], y: P[1], w: S[0], h: S[1] }); }
    if (names[i] === out.app && t.length) out.window = String(t[0] || ''); }
  if (out.app) { try { var f = se.processes.byName(out.app).attributes.byName('AXFocusedUIElement').value();
    if (f) { var r = '', ti = '', v = null;
      try { r = f.role(); } catch (e) {}
      try { ti = f.title() || ''; } catch (e) {}
      if (!ti) { try { ti = f.description() || ''; } catch (e) {} }
      try { v = f.value(); } catch (e) {}
      var vs = (v === null || v === undefined || r === 'AXSecureTextField') ? null : String(v);
      out.focus = { r: String(r).replace(/^AX/, ''), t: String(ti).slice(0, 120), n: vs === null ? null : vs.length, h: vs === null ? 0 : hash(vs) }; } } catch (e) {} }
  out.ms = Date.now() - t0;
  return JSON.stringify(out); }`;

export function macBackend(apps: string[], useCliclick = onPath('cliclick')): DesktopBackend {
  const jxa = async (...a: (string | number)[]) => {
    try { return String(await run('osascript', ['-l', 'JavaScript', '-e', JXA, ...a.map(String)])).trim(); }
    catch (e: any) {   // Big Sur's JXA bridge cannot marshal CG structs (0.2.1 report) — cliclick avoids every struct call
      if (/type encoding|NSGetSizeAndAlignment/i.test(String(e?.message))) throw new Error(`this macOS's JavaScript bridge cannot pass screen coordinates (CG structs); install cliclick (https://github.com/BlueM/cliclick/releases) on PATH and retry. (${String(e.message).slice(0, 160)})`);
      throw e;
    }
  };
  const PERM_HINT = 'macOS permission missing: System Preferences → Security & Privacy → Privacy → Accessibility (and Automation → System Events) for the app running this agent, then restart that app';
  const osa = (script: string) => run('osascript', ['-e', script], undefined, undefined, 12_000).catch((e: any) => {
    const m = String(e?.message ?? e);
    if (/-609|-1743|-25211|-1719|Connection is invalid|not allowed assistive|not authori[sz]ed|timed? ?out|ETIMEDOUT|SIGTERM/i.test(m) || /keystroke|key code/.test(script) && !m.trim().split(': ').pop()) throw new Error(`${PERM_HINT} (${m.slice(0, 200)})`);
    throw e;
  });
  const cc = (...a: string[]) => run('cliclick', ['-e', '40', ...a]);
  const tmp = () => path.join(os.tmpdir(), `nexus-desktop-${process.pid}-${Date.now()}.png`);
  return {
    name: `macos (${useCliclick ? 'cliclick' : 'CoreGraphics'})`,
    async size() {
      // 0.2.1 (Big Sur 11.7 report): the JXA bridge there cannot marshal CGRect/CGPoint ('unsupported type encoding … CGPoint'), so the
      // screen size comes from struct-free sources: Finder's desktop bounds (points) → system_profiler's UI resolution → JXA (macOS 12+).
      try { const b = String(await osa('tell application "Finder" to get bounds of window of desktop')).trim().split(/,\s*/).map(Number);
            if (b.length === 4 && b[2] > 0 && b[3] > 0) return { w: b[2] - b[0], h: b[3] - b[1] }; } catch { /* next */ }
      try { const j = JSON.parse(String(await run('system_profiler', ['SPDisplaysDataType', '-json'])));
            for (const gpu of j.SPDisplaysDataType ?? []) for (const d of gpu.spdisplays_ndrvs ?? []) {
              const r = /(\d+)\s*x\s*(\d+)/.exec(d._spdisplays_resolution ?? d.spdisplays_resolution ?? '');
              if (r && (d.spdisplays_main === 'spdisplays_yes' || (gpu.spdisplays_ndrvs ?? []).length === 1)) return { w: +r[1], h: +r[2] }; } } catch { /* next */ }
      const [w, h] = (await jxa('size')).split(/\s+/).map(Number); return { w: Math.round(w), h: Math.round(h) };
    },
    async frontApp() { return String(await osa('tell application "System Events" to name of first process whose frontmost is true')).trim(); },
    async state(o) { return JSON.parse(String(await run('osascript', ['-l', 'JavaScript', '-e', JXA_STATE, o?.full === false ? 'light' : 'full'], undefined, undefined, o?.timeoutMs ?? 10_000)).trim()) as DeskState; },
    async permissions() {
      try { const [ax, sr] = (await jxa('perms')).split(/\s+/).map(Number); return { accessibility: ax === 1, ...(sr === 2 ? {} : { screen_recording: sr === 1 }) }; } catch { return {}; }
    },
    async hotCorners() {
      const out: Corner[] = [];
      for (const c of ['tl', 'tr', 'bl', 'br'] as Corner[]) {
        const v = await run('defaults', ['read', 'com.apple.dock', `wvous-${c}-corner`]).then(b => Number(String(b).trim())).catch(() => 0);
        if (v > 1) out.push(c);   // 0/1 = no action
      }
      return out;
    },
    async capture(w, h, region) {
      const f = tmp(), g = tmp();
      try {
        const r = region ? ['-R', `${region[0]},${region[1]},${region[2] - region[0]},${region[3] - region[1]}`] : ['-m'];
        await run('screencapture', ['-x', '-t', 'png', ...r, f]);
        await run('sips', ['-z', String(h), String(w), f, '--out', g]);
        return fs.readFileSync(g);
      } finally { for (const p of [f, g]) { try { fs.unlinkSync(p); } catch { /* gone */ } } }
    },
    async move(p) { useCliclick ? await cc(`m:${p.x},${p.y}`) : await jxa('move', p.x, p.y); },
    async click(p, b, n) {
      if (useCliclick && b !== 'middle') { const c = b === 'right' ? 'rc' : n === 2 ? 'dc' : n === 3 ? 'tc' : 'c'; await cc(`${c}:${p.x},${p.y}`); return; }
      await jxa('click', p.x, p.y, b === 'right' ? 1 : b === 'middle' ? 2 : 0, n);
    },
    async drag(a, b) { useCliclick ? await cc(`dd:${a.x},${a.y}`, `dm:${b.x},${b.y}`, `du:${b.x},${b.y}`) : await jxa('drag', a.x, a.y, b.x, b.y); },
    async scroll(p, dir, amount) {
      const n = Math.max(1, amount); const dy = dir === 'up' ? n : dir === 'down' ? -n : 0; const dx = dir === 'left' ? n : dir === 'right' ? -n : 0;
      if (useCliclick) { await cc(`m:${p.x},${p.y}`); await jxa('scrollonly', dy, dx); } else await jxa('scroll', p.x, p.y, dy, dx);
    },
    async type(text, opts) {
      if (opts?.via === 'paste') {
        // Clipboard paste: immune to per-key drops/layout translation in VMs (Parallels shares the clipboard with the guest). Restore after.
        let saved: Buffer | null = null; try { saved = await run('pbpaste', []); } catch { /* empty */ }
        await run('pbcopy', [], undefined, text);
        try { await sleep(120); await this.key(opts.pasteKey ?? 'cmd+v'); await sleep(350); }
        finally { if (saved !== null) { try { await run('pbcopy', [], undefined, saved.toString()); } catch { /* best effort */ } } }
        return;
      }
      const d = opts?.charDelayMs ?? 0;
      if (d > 0) {   // one osascript, a keystroke per character with a delay — slower but VMs/legacy apps keep up
        await run('osascript', ['-e', `set t to ${asLiteral(text)}\ntell application "System Events"\nrepeat with c in (characters of t)\nkeystroke (c as text)\ndelay ${(Math.min(500, d) / 1000).toFixed(3)}\nend repeat\nend tell`], undefined, undefined, 12_000 + text.length * (Math.min(500, d) + 60));
        return;
      }
      await osa(`tell application "System Events" to keystroke ${asLiteral(text)}`);
    },
    async key(combo) { for (const k of combo.trim().split(/\s+/)) { await osa(macKeyScript(k)); await sleep(40); } },
    async cursor() { const [x, y] = (useCliclick ? String(await cc('p')).trim().replace(',', ' ') : await jxa('cursor')).split(/\s+/).map(Number); return { x, y }; },
    async launch(app) {
      if (!apps.includes(app)) throw new Error(`"${app}" is not in the launch allow-list (${apps.join(', ')}); set NEXUS_BROWSER_DESKTOP_APPS to change it`);
      await run('open', ['-a', app]);
    },
    async windows() {
      const s = `var se = Application('System Events'), out = [];
se.processes.whose({ visible: true })().forEach(function (p) { try { p.windows().forEach(function (w) {
  var pos = w.position(), sz = w.size(); out.push(p.name() + '\\t' + w.name() + '\\t' + pos[0] + ',' + pos[1] + ' ' + sz[0] + 'x' + sz[1]); }); } catch (e) {} });
out.join('\\n');`;
      return String(await run('osascript', ['-l', 'JavaScript', '-e', s])).trim() || '(no windows — is Accessibility granted to the host app?)';
    },
    async focus(target) { await osa(`tell application ${asLiteral(target)} to activate`); },
    async menuList(app, top, includeRecent) {
      return String(await run('osascript', ['-l', 'JavaScript', '-e', JXA_MENU_LIST, app ?? '', top ?? '', includeRecent ? '1' : ''], undefined, undefined, 90_000)).trim();
    },
    async menuInvoke(p, app) {
      return String(await run('osascript', ['-l', 'JavaScript', '-e', JXA_MENU_INVOKE, JSON.stringify(p), app ?? ''], undefined, undefined, 20_000)).trim();
    },
    async axScan(o) { return JSON.parse(String(await run('osascript', ['-l', 'JavaScript', '-e', JXA_AX, JSON.stringify({ op: 'scan', ...o })], undefined, undefined, 120_000))); },
    async axAct(o) { return JSON.parse(String(await run('osascript', ['-l', 'JavaScript', '-e', JXA_AX, JSON.stringify({ op: o.act, app: o.app, window: o.window, path: o.path, value: o.value })], undefined, undefined, 30_000))); },
    async shortcutSet(app, title, equiv) {
      const bid = String(await run('osascript', ['-e', `id of app ${asLiteral(app)}`])).trim();
      await run('defaults', ['write', bid, 'NSUserKeyEquivalents', '-dict-add', title, equiv]);
      // make it show in System Preferences → Keyboard → App Shortcuts (best effort; may need Full Disk Access on newer macOS)
      try { const cur = String(await run('defaults', ['read', 'com.apple.universalaccess', 'com.apple.custommenu.apps']).catch(() => Buffer.from('')));
            if (!cur.includes(bid)) await run('defaults', ['write', 'com.apple.universalaccess', 'com.apple.custommenu.apps', '-array-add', bid]); } catch { /* optional */ }
      return bid;
    },
    async shortcutList(app) {
      const bid = String(await run('osascript', ['-e', `id of app ${asLiteral(app)}`])).trim();
      const t = await run('defaults', ['read', bid, 'NSUserKeyEquivalents']).then(String).catch(() => '');
      return parseKeyEquivalents(t);
    },
    async shortcutRemove(app, title) {
      const bid = String(await run('osascript', ['-e', `id of app ${asLiteral(app)}`])).trim();
      const cur = parseKeyEquivalents(await run('defaults', ['read', bid, 'NSUserKeyEquivalents']).then(String).catch(() => ''));
      if (!(title in cur)) throw new Error(`no app shortcut "${title}" for ${app}`);
      delete cur[title];
      const rest = Object.entries(cur).flat();
      if (rest.length) await run('defaults', ['write', bid, 'NSUserKeyEquivalents', '-dict', ...rest]); else await run('defaults', ['delete', bid, 'NSUserKeyEquivalents']);
      return bid;
    },
  };
}

// ── the tool ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const READ_ONLY_ACTIONS = /^(screenshot|info|windows|stats|scan|grab|context|watch|cursor_position|zoom|wait|guest_ping|guest_windows|guest_scan|guest_grab)$/;
const DEFAULT_APPS = process.platform === 'darwin'
  ? ['Disk Utility', 'Terminal', 'Finder', 'System Settings', 'System Information', 'Activity Monitor', 'Console', 'TextEdit', 'Safari']
  : ['xterm', 'gnome-terminal', 'gedit', 'nautilus', 'gnome-disks', 'xclock'];

export interface DesktopOptions { mode: Mode; home: string; display?: string; maxWidth?: number; apps?: string[]; backend?: DesktopBackend; failsafe?: string; guestDir?: string }

export function desktopMode(): Mode | null {
  // 0.9.0: NEXUS_DESKTOP (the harness's own switch, `cortex desktop enable`) wins; NEXUS_BROWSER_DESKTOP is the legacy browser-package switch.
  const m = (process.env.NEXUS_DESKTOP || process.env.NEXUS_BROWSER_DESKTOP || '').toLowerCase();
  return m === 'virtual' || m === 'real' ? m : null;
}

export function createDesktop(o: DesktopOptions) {
  const apps = o.apps ?? (process.env.NEXUS_BROWSER_DESKTOP_APPS ? process.env.NEXUS_BROWSER_DESKTOP_APPS.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_APPS);
  const backend = o.backend ?? (process.platform === 'darwin' && o.mode === 'real'
    ? macBackend(apps)
    : x11Backend(o.display ?? process.env.NEXUS_BROWSER_DESKTOP_DISPLAY ?? (o.mode === 'virtual' ? ':99' : (process.env.DISPLAY ?? ':0')), apps));
  const maxW = o.maxWidth ?? Number(process.env.NEXUS_BROWSER_DESKTOP_MAX_WIDTH ?? 1280);
  const stopFile = path.join(o.home, 'DESKTOP_STOP');
  const logFile = path.join(o.home, 'desktop-actions.log');
  let geo: { w: number; h: number; sw: number; sh: number; f: number } | null = null;
  // Failsafe spot (0.2.2): macOS defaults to the MIDDLE OF THE TOP EDGE — Hot Corners can occupy all four corners (the operator's Mac does,
  // and `defaults` under-reported them), and the top-edge midpoint has no system action. Linux defaults to top-left.
  // NEXUS_BROWSER_DESKTOP_FAILSAFE = top | bottom | tl | tr | bl | br | off.
  let spot: FailsafeSpot | null | undefined;
  async function failsafeCorner(): Promise<FailsafeSpot | null> {
    if (spot !== undefined) return spot;
    const want = (o.failsafe ?? process.env.NEXUS_BROWSER_DESKTOP_FAILSAFE ?? (backend.name.startsWith('macos') ? 'top' : 'tl')).toLowerCase();
    if (want === 'off') return (spot = null);
    if (['top', 'bottom'].includes(want)) return (spot = want as FailsafeSpot);
    const hot = new Set(await backend.hotCorners?.().catch(() => [] as Corner[]) ?? []);
    spot = (hot.has(want as Corner) ? (['tl', 'tr', 'bl', 'br'] as Corner[]).find(c => !hot.has(c)) ?? 'top' : want) as FailsafeSpot;
    return spot;
  }
  const cornerPt = (c: FailsafeSpot, g: { w: number; h: number }) =>
    c === 'top' ? { x: Math.floor(g.w / 2), y: 0 } : c === 'bottom' ? { x: Math.floor(g.w / 2), y: g.h - 1 }
    : { x: c[1] === 'l' ? 0 : g.w - 1, y: c[0] === 't' ? 0 : g.h - 1 };
  // 0.2.3 (macbook report): after a trip + resume the cursor still sits ON the spot, so the next action re-tripped forever. The failsafe now
  // fires on ARRIVAL: once tripped it stays disarmed while the cursor remains on the spot, and re-arms the moment the cursor is seen elsewhere.
  let disarmedOnSpot = false;
  let stopLatched: string | null = null; let stopVanishLogged = false;
  const STOP_MSG = (why: string) => `desktop control is STOPPED by the user (${why}). Do not try to resume, move the cursor, or touch the stop file: end this task now and tell the user what you were doing. Only the user can resume (they delete the stop file and restart the agent).`;
  let permCache: { at: number; p: { accessibility?: boolean; screen_recording?: boolean } } | null = null;
  async function perms() {
    if (!backend.permissions) return {};
    if (!permCache || Date.now() - permCache.at > 10_000) permCache = { at: Date.now(), p: await backend.permissions() };
    return permCache.p;
  }
  /** After a pointer action, confirm the cursor really got there (cliclick exits 0 without Accessibility → false "success"). */
  async function verifyAt(target: Pt, what: string) {
    if (o.mode !== 'real') return;
    const c = await backend.cursor().catch(() => null);
    if (spot && geo) { const k = cornerPt(spot, geo); if (Math.abs(target.x - k.x) > 2 || Math.abs(target.y - k.y) > 2) disarmedOnSpot = false; }   // left the spot → re-arm
    if (c && (Math.abs(c.x - target.x) > 3 || Math.abs(c.y - target.y) > 3))
      throw new Error(`${what}: the cursor is at ${c.x},${c.y}, not ${target.x},${target.y} — input was ignored (on macOS: Accessibility permission for the app running this agent)`);
  }

  async function geometry() {
    const { w, h } = await backend.size();
    const sw = Math.min(w, maxW); const f = w / sw; const sh = Math.round(h / f);
    geo = { w, h, sw, sh, f }; return geo;
  }
  const toScreen = (c: number[] | undefined, g: NonNullable<typeof geo>): Pt => {
    if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite)) throw new Error('coordinate must be [x, y] in screenshot pixels');
    const [x, y] = c;
    if (x < 0 || y < 0 || x > g.sw || y > g.sh) throw new Error(`coordinate [${x}, ${y}] is outside the ${g.sw}×${g.sh} screenshot`);
    return { x: Math.round(x * g.f), y: Math.round(y * g.f) };
  };
  async function shot(): Promise<Shot> { const g = geo ?? await geometry(); return { png: await backend.capture(g.sw, g.sh), width: g.sw, height: g.sh }; }
  function audit(entry: Record<string, unknown>) {
    try { fs.mkdirSync(o.home, { recursive: true }); fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), mode: o.mode, ...entry }) + '\n'); } catch { /* best effort */ }
  }
  /** 0.2.6 feedback loop: classify an error so the stats roll up by cause, not by message text. */
  const errClass = (m: string) => /FAILSAFE/.test(m) ? 'failsafe' : /STOPPED/.test(m) ? 'stopped' : /permission|Accessibility|Screen Recording/i.test(m) ? 'permission'
    : /input was ignored/.test(m) ? 'input_ignored' : /allow-list/.test(m) ? 'allow_list' : /outside the|coordinate must|region must/.test(m) ? 'coordinate'
    : /timed? ?out|ETIMEDOUT|SIGTERM/i.test(m) ? 'timeout' : /cliclick|type encoding/i.test(m) ? 'backend' : 'other';
  /** Roll the audit log up per action (count, errors, p50/p95 ms) + error classes — the numbers behind every feedback report. */
  function summarize(sinceMin?: number, logPath?: string) {
    let rows: any[] = [];
    try { rows = fs.readFileSync(logPath ?? logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* none yet */ }
    if (sinceMin) { const cut = Date.now() - sinceMin * 60_000; rows = rows.filter(r => Date.parse(r.ts) >= cut); }
    const pct = (xs: number[], p: number) => { if (!xs.length) return null; const v = [...xs].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
    const by: Record<string, { n: number; err: number; ms: number[] }> = {}; const classes: Record<string, number> = {};
    for (const r of rows) {
      const k = r.action ?? '?'; const b = (by[k] ??= { n: 0, err: 0, ms: [] }); b.n++;
      if (r.ok === false) { b.err++; classes[r.err_class ?? 'other'] = (classes[r.err_class ?? 'other'] ?? 0) + 1; }
      if (typeof r.ms === 'number') b.ms.push(r.ms);
    }
    const actions = Object.fromEntries(Object.entries(by).sort((x, y) => y[1].n - x[1].n).map(([k, b]) => [k, { n: b.n, err: b.err, p50_ms: pct(b.ms, 0.5), p95_ms: pct(b.ms, 0.95) }]));
    return { version: VERSION, backend: backend.name, mode: o.mode, log: logPath ?? logFile, window_min: sinceMin ?? null, actions_total: rows.length,
      errors_total: rows.filter(r => r.ok === false).length, error_classes: classes, actions,
      first_ts: rows[0]?.ts ?? null, last_ts: rows.at(-1)?.ts ?? null };
  }
  async function guard() {
    if ((await perms()).accessibility === false) throw new Error('macOS permission missing: Accessibility is not granted to the app running this agent (System Preferences → Security & Privacy → Privacy → Accessibility), so clicks and keys would be silently ignored. Restart that app after granting.');
    // 0.10.1 (macbook D7 T5, 11-12): an agent cleared its own failsafe — the refusal named the file to delete, the stop file vanished and
    // the next mouse_move/type ran. A stop is now LATCHED for the life of this process: once seen (failsafe trip or a stop file), every
    // mutating action refuses even if the file disappears; only the user resumes (delete the file AND restart the agent). The agent-facing
    // text says stop-and-report and never how to resume.
    if (stopLatched) {
      if (!fs.existsSync(stopFile) && !stopVanishLogged) { stopVanishLogged = true; audit({ action: 'stop_file_removed_while_latched', ok: false, err_class: 'stopped' }); }
      throw new Error(STOP_MSG(stopLatched));
    }
    if (fs.existsSync(stopFile)) { stopLatched = 'stop file present'; throw new Error(STOP_MSG(stopLatched)); }
    if (o.mode === 'real') {
      const fc = await failsafeCorner(); const g = geo ?? await geometry();
      const c = fc ? await backend.cursor().catch(() => null) : null;
      if (c && fc) { const k = cornerPt(fc, g); const onSpot = Math.abs(c.x - k.x) <= 2 && Math.abs(c.y - k.y) <= 2;
        if (!onSpot) disarmedOnSpot = false;
        if (onSpot && !disarmedOnSpot) { disarmedOnSpot = true;
          fs.mkdirSync(o.home, { recursive: true }); fs.writeFileSync(stopFile, `failsafe tripped ${new Date().toISOString()} (cursor parked at the ${fc} failsafe spot)\n`);
          stopLatched = `failsafe tripped: cursor parked at the ${fc} spot`;
          throw new Error(`FAILSAFE: ${STOP_MSG(stopLatched)}`);
        } }
    }
  }

  // ── 0.3: macros (the agent's own "created shortcuts") + the desktop script runner ──
  const macroDir = path.join(o.home, 'macros');
  const macroPath = (name: string) => { if (!MACRO_NAME.test(name ?? '')) throw new Error('macro name: letters, digits, _ and - (max 64)'); return path.join(macroDir, `${name}.json`); };
  const readMacro = (name: string) => { const f = macroPath(name); if (!fs.existsSync(f)) throw new Error(`no macro "${name}" — macro {op:"list"} shows the saved ones`); return JSON.parse(fs.readFileSync(f, 'utf8')); };
  const platformOf = (a: any): HotkeyPlatform => a.platform ?? (backend.name.startsWith('macos') ? 'mac' : 'win');
  const quietSrc = (st: any) => st.kind === 'action' && (st.action.action === 'type' || st.action.action === 'fill_field')
    ? `${st.src.split(/\s+/)[0]} (${String(st.action.text ?? '').length} chars)` : st.src.slice(0, 90);   // never echo typed text
  async function runScript(textSrc: string, vars: Record<string, string>, depth: number, log: string[], images: any[]): Promise<void> {
    if (depth > 5) throw new Error('macro nesting deeper than 5 (a macro calling itself?)');
    const lines = textSrc.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = i + 1, t0 = Date.now(), pre = '  '.repeat(depth);
      const st = parseLine(substitute(lines[i], vars, ln), ln); if (!st) continue;
      try {
        if (st.kind === 'set') { vars[st.name] = st.value; log.push(`${pre}L${ln} set ${st.name}`); continue; }
        if (st.kind === 'macro') { const m = readMacro(st.name); log.push(`${pre}L${ln} macro ${st.name}`); await runScript(m.script, { ...vars, ...st.vars }, depth + 1, log, images); continue; }
        if (st.kind === 'wait_window') {
          const re = new RegExp(st.pattern, 'i'), end = Date.now() + st.timeoutS * 1000; let hit = false;
          while (Date.now() < end) { if (re.test(await backend.windows())) { hit = true; break; } await sleep(400); }
          if (!hit) throw new Error(`no window matching /${st.pattern}/ within ${st.timeoutS} s`);
          log.push(`${pre}L${ln} wait_window ${st.pattern} — ${Date.now() - t0} ms`); continue;
        }
        const r = await act({ screenshot: false, settle_ms: 150, ...st.action });
        if (r.isError) throw new Error(r.content?.[0]?.text ?? 'failed');
        // 0.3.2 (macbook): an explicit zoom/screenshot line was dropped once fill_field's automatic zooms had used the old 3-image cap.
        // Explicit images get their own cap (6); automatic ones keep 3; each image is labelled with its script line.
        const explicit = st.action.action === 'zoom' || st.action.action === 'screenshot';
        for (const c of r.content ?? []) if (c.type === 'image') {
          const n = images.filter((x: any) => x.__k === (explicit ? 'e' : 'a')).length;
          if (n < (explicit ? 6 : 3)) images.push({ __k: explicit ? 'e' : 'a', label: `[line ${ln}: ${st.action.action}]`, part: c });
        }
        audit({ action: st.action.action, via: 'script', ms: Date.now() - t0, ok: true, chars: typeof st.action.text === 'string' && (st.action.action === 'type' || st.action.action === 'fill_field') ? (st.action.text as string).length : undefined });
        log.push(`${pre}L${ln} ${quietSrc(st)} — ${Date.now() - t0} ms`);
      } catch (e: any) {
        const m = String(e?.message ?? e);
        audit({ action: (st as any).action?.action ?? st.kind, via: 'script', ms: Date.now() - t0, ok: false, err_class: errClass(m), error: m.slice(0, 300) });
        throw new Error(m.startsWith('line ') ? m : `line ${ln} (${quietSrc(st)}): ${m}`);
      }
    }
  }

  // 0.10 (plan §5c item 1): check a script/macro BEFORE any screen action. Two passes: the first records which (app, top menu) trees the
  // script's menu lines need, those are read live (macOS, one top menu each — fast), the second validates against them.
  async function validateOp(src: string, vars: Record<string, string>, liveMenus: boolean): Promise<{ content: any[]; isError?: boolean }> {
    let names: string[] = []; try { names = fs.readdirSync(macroDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); } catch { /* none */ }
    const rm = (n: string) => { try { return readMacro(n); } catch { return null; } };
    const g = geo ?? await geometry().catch(() => null);
    const base = { vars, platform: platformOf({}), macos: backend.name.startsWith('macos'), readMacro: rm, macroNames: names, apps,
      ...(g ? { screen: { width: g.sw, height: g.sh } } : {}) };
    const want = new Map<string, { app?: string; top: string }>();
    validateScript(src, { ...base, menuPaths: (app, top) => { want.set(`${app ?? ''}\u0000${top}`, { app, top }); return null; } });
    const trees = new Map<string, string[][]>(); let live: 'checked' | 'skipped' | 'unavailable' = 'checked';
    if (!liveMenus) live = 'skipped';
    else if (want.size && !backend.menuList) live = 'unavailable';
    else for (const [k, w] of want) {
      try { trees.set(k, parseMenuList(await backend.menuList!(w.app, w.top, false))); }
      catch { live = 'unavailable'; }
    }
    const r = validateScript(src, { ...base, menuPaths: (app, top) => trees.get(`${app ?? ''}\u0000${top}`) ?? null });
    // an INVALID report is a successful check, not a tool failure (macbook D7: the loop guards counted INVALID results as failures)
    return { content: [{ type: 'text', text: formatValidateReport(r, live) }] };
  }

  function macroOp(a: any): { content: any[]; isError?: boolean } {
    const text = (t: string) => ({ type: 'text', text: t });
        const op = a.op ?? 'list';
        if (op === 'list') { let names: string[] = []; try { names = fs.readdirSync(macroDir).filter(f => f.endsWith('.json')); } catch { /* none */ }
          return { content: [text(names.map(f => { const m = JSON.parse(fs.readFileSync(path.join(macroDir, f), 'utf8')); return `${m.name}\t${m.description ?? ''}`; }).join('\n') || '(no macros yet — macro {op:"save", name, script, description})')] }; }
        if (op === 'show') { const m = readMacro(a.name); return { content: [text(JSON.stringify(m, null, 1))] }; }
        if (op === 'delete') { fs.unlinkSync(macroPath(a.name)); return { content: [text(`deleted macro ${a.name}`)] }; }
        if (op === 'save') {
          if (typeof a.script !== 'string' || !a.script.trim()) throw new Error('macro save needs script');
          a.script.split('\n').forEach((l: string, i: number) => parseLine(l.replace(/\$\{[A-Za-z_]\w*\}/g, '0'), i + 1));   // syntax check now, not at replay
          fs.mkdirSync(macroDir, { recursive: true });
          fs.writeFileSync(macroPath(a.name), JSON.stringify({ name: a.name, description: a.description ?? '', script: a.script, saved_at: new Date().toISOString() }, null, 1));
          return { content: [text(`saved macro ${a.name} (${a.script.split('\n').filter((l: string) => l.trim() && !l.trim().startsWith('#')).length} steps) — run with {action:"run", macro:"${a.name}", vars:{…}}`)] };
        }
        throw new Error(`macro op ${op}: list | show | save | delete | validate`);
      }

  // ── 0.4: native perception (nexus-sense scan/grab parity) — macOS Accessibility tree, refs stable until the next scan ──
  let lastScan: (AxTree & { at: number }) | null = null;
  // 0.5.4 (field: refs died across processes — every MCP restart / new client lost the last scan): the last AX scan and the last guest
  // scan are persisted in the session home and reloaded when this process has none in memory.
  const axScanFile = path.join(o.home, 'last-ax-scan.json'), guestScanFile = path.join(o.home, 'last-guest-scan.json');
  const persist = (file: string, v: unknown) => { try { fs.mkdirSync(o.home, { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(v)); fs.renameSync(`${file}.tmp`, file); } catch { /* best effort */ } };
  const restore = <T,>(file: string): T | null => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && Array.isArray(v.els) ? v as T : null; } catch { return null; } };
  const ensureScan = () => { if (!lastScan) lastScan = restore<AxTree & { at: number }>(axScanFile); return lastScan; };
  const AX_ONLY = 'scan/grab/press/set_value read the macOS Accessibility tree — not available here (X11: AT-SPI not wired yet). Inside a Parallels Windows guest the guest\'s controls are invisible to macOS: use screenshot/zoom + keyboard/macros there.';
  const refEl = (ref: string) => {
    if (!ensureScan()) throw new Error('no scan yet — run {action:"scan"} first (refs come from the most recent scan)');
    const m = /^e(\d+)$/.exec(String(ref ?? '')); const el = m ? lastScan!.els[Number(m[1]) - 1] : undefined;
    if (!el) throw new Error(`unknown ref "${ref}" (last scan has e1–e${lastScan!.els.length})`);
    return el;
  };
  const centerPx = (el: AxEl, g: { f: number }) => [Math.round((el.x + el.w / 2) / g.f), Math.round((el.y + el.h / 2) / g.f)];
  const elLine = (el: AxEl, i: number, g: { f: number }) => {
    const [cx, cy] = centerPx(el, g); const label = el.t || el.d;
    return `e${i + 1}\t${el.r.replace(/^AX/, '')}${el.sr ? `/${el.sr.replace(/^AX/, '')}` : ''}\t${label ? JSON.stringify(label.slice(0, 80)) : '-'}\t@[${cx},${cy}] ${Math.round(el.w / g.f)}×${Math.round(el.h / g.f)}${el.v && el.v !== label ? `\tvalue=${JSON.stringify(el.v.slice(0, 60))}` : ''}${el.e ? '' : '\t(disabled)'}${el.f ? '\t(focused)' : ''}`;
  };

  // ── 0.5: IN-GUEST perception — guest/nexus-guest-uia.ps1 runs inside a Windows VM and answers through a SHARED FOLDER ──
  const guestDir = o.guestDir ?? process.env.NEXUS_BROWSER_GUEST_DIR ?? path.join(os.homedir(), 'nexus-guest-bridge');
  let lastGuestScan: { window: string; els: any[]; at?: number } | null = null;
  const GUEST_START = `start it INSIDE the VM: Win+R → powershell -ExecutionPolicy Bypass -NoExit -File "\\\\psf\\Home\\nexus-guest-bridge\\nexus-guest-uia.ps1" (Parallels shared Home = \\\\psf\\Home; some setups use \\\\Mac\\Home — pass -Bridge then) after copying guest/nexus-guest-uia.ps1 from the package into ${guestDir}; click a guest window first so Win+R reaches the guest`;
  let guestInflight = 0;   // 0.6: the watcher never queues a state poll behind an agent's guest request
  async function guestCall(op: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<any> {
    guestInflight++; try { return await guestCallInner(op, args, timeoutMs); } finally { guestInflight--; }
  }
  async function guestCallInner(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const alive = path.join(guestDir, 'helper-alive.json');
    let beat: any = null; try { beat = JSON.parse(fs.readFileSync(alive, 'utf8')); } catch { /* none */ }
    if (!beat || Date.now() - Date.parse(beat.ts) > 15_000) throw new Error(`the in-guest helper is not running (no heartbeat in ${guestDir} for 15 s) — ${GUEST_START}`);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const req = path.join(guestDir, `req-${id}.json`), resp = path.join(guestDir, `resp-${id}.json`);
    fs.writeFileSync(`${req}.tmp`, JSON.stringify({ op, ...args })); fs.renameSync(`${req}.tmp`, req);   // atomic: the helper only reads complete *.json
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (fs.existsSync(resp)) {
        let r: any; try { r = JSON.parse(fs.readFileSync(resp, 'utf8')); } catch { await sleep(50); continue; }
        try { fs.unlinkSync(resp); } catch { /* gone */ }
        if (!r.ok) throw new Error(`guest helper: ${r.error ?? 'failed'}`);
        return r;
      }
      await sleep(80);
    }
    try { fs.unlinkSync(req); } catch { /* the helper took it */ }
    throw new Error(`the in-guest helper did not answer ${op} within ${Math.round(timeoutMs / 1000)} s`);
  }
  const guestRef = (ref: string) => {
    if (!lastGuestScan) lastGuestScan = restore<{ window: string; els: any[]; at?: number }>(guestScanFile);
    if (!lastGuestScan) throw new Error('no guest scan yet — run {action:"guest_scan"} first');
    const m = /^g(\d+)$/.exec(String(ref ?? '')); const el = m ? lastGuestScan.els[Number(m[1]) - 1] : undefined;
    if (!el) throw new Error(`unknown guest ref "${ref}" (last guest scan has g1–g${lastGuestScan.els.length})`);
    return el;
  };
  async function guestOp(a: any): Promise<{ content: any[]; isError?: boolean }> {
    const text = (t: string) => ({ type: 'text', text: t });
    switch (a.action) {
      case 'guest_ping': { const r = await guestCall('ping'); return { content: [text(`guest helper ${r.version} — ${r.os}, PowerShell ${r.ps}, user ${r.user} (bridge ${guestDir})`)] }; }
      case 'guest_windows': { const r = await guestCall('windows'); return { content: [text((r.windows ?? []).map((w: any) => `${JSON.stringify(String(w.name ?? '').replace(/\u0000+/g, ''))}\t${w.cls}\tpid ${w.pid}\t${w.w}×${w.h}@${w.x},${w.y}`).join('\n') || '(no named top-level windows)')] }; }
      case 'guest_scan': {
        const r = await guestCall('scan', { window: a.window ?? '', max: a.max ?? 600, depth: a.depth ?? 12 }, 60_000);
        lastGuestScan = { window: r.window, els: r.els ?? [], at: Date.now() }; persist(guestScanFile, lastGuestScan);
        const f = a.filter ?? {}; const q = typeof f.hasText === 'string' ? f.hasText.toLowerCase() : null;
        const rows = lastGuestScan.els.map((el: any, i: number) => ({ el, i })).filter(({ el }: any) =>
          (f.interactive ? guestInteractive(el) : true) && (f.role ? `${el.r}\n${el.r === 'Pane' ? el.cls ?? '' : ''}`.toLowerCase().includes(String(f.role).toLowerCase()) : true)
          && (q ? `${el.t}\n${el.v}\n${el.aid}`.toLowerCase().includes(q) : true) && (a.include_hidden ? true : !el.off && el.w > 0 && el.h > 0));
        const shown = rows.slice(0, a.limit ?? 150);
        return { content: [text(`guest scan — ${JSON.stringify(r.window)} — ${lastGuestScan.els.length} elements in ${r.ms} ms (in-guest)${r.truncated ? ' (TRUNCATED: pass window + depth 4–6 + a filter)' : ''}; ${rows.length} match${rows.length > shown.length ? `, first ${shown.length} shown` : ''}. Act with guest_press {ref} / guest_set_value {ref, text} / guest_grab {ref}. Positions are GUEST pixels.\n` +
          shown.map(({ el, i }: any) => `g${i + 1}\t${guestRole(el)}\t${el.t ? JSON.stringify(String(el.t).slice(0, 80)) : '-'}${el.aid ? `\tid=${el.aid}` : ''}\t${el.w}×${el.h}@${el.x},${el.y}${el.v && el.v !== el.t ? `\tvalue=${JSON.stringify(String(el.v).slice(0, 60))}` : ''}${el.e ? '' : '\t(disabled)'}${el.f ? '\t(focused)' : ''}`).join('\n'))] };
      }
      case 'guest_grab': { const el = guestRef(a.ref); const r = await guestCall('get', { window: lastGuestScan!.window, path: el.p });
        return { content: [text(JSON.stringify({ ref: a.ref, role: r.r, name: r.t, automation_id: r.aid || undefined, class: r.cls, value: r.v, enabled: r.e, focused: r.f, offscreen: r.off, children: r.n, rect_guest_px: [r.x, r.y, r.w, r.h] }, null, 1))] }; }
      case 'guest_press': { await guard(); const el = guestRef(a.ref); const r = await guestCall('press', { window: lastGuestScan!.window, path: el.p });
        return { content: [text(`pressed ${a.ref} (${el.r} ${JSON.stringify(el.t)}) via UI Automation ${r.how} pattern`)] }; }
      case 'guest_set_value': { await guard(); if (typeof a.text !== 'string') throw new Error('guest_set_value needs text'); const el = guestRef(a.ref);
        const r = await guestCall('set', { window: lastGuestScan!.window, path: el.p, value: a.text }); const okv = r.v === a.text;
        return { content: [text(okv ? `set ${a.ref} value (${a.text.length} chars) — read back: matches` : `set ${a.ref}: read back DIFFERS (${String(r.v).length} chars) — the control may reformat (dates!) — guest_grab it to see the stored value`)], ...(okv ? {} : { isError: true }) }; }
      case 'guest_focus': { await guard(); const r = await guestCall('focus', { window: a.window ?? '' }); return { content: [text(`focused guest window ${JSON.stringify(r.window)}`)] }; }
    }
    throw new Error(`unknown guest action ${a.action}`);
  }


  // ── 0.6: CONTEXT + WATCH — the desktop twin of the SPA's {{workspaceContext}} header and CortexEventBus ({{recentEvents}}). ──
  // The watcher polls cheap state snapshots (host via backend.state(), the Windows guest via the helper's "state" op, folders via fs.watch),
  // diffs them into typed events, keeps the last 300 in memory and appends every event to <home>/desktop-events.jsonl (the feed a bus bridge
  // can tail). Every tool result then carries the events the agent has not seen yet: those observed DURING the action (its likely effects)
  // and those that happened SINCE the agent's last call (external). Refs from a scan whose window has since closed/retitled are flagged.
  const eventsFile = path.join(o.home, 'desktop-events.jsonl');
  type Ev = DeskEvent & { seq: number; ts: string };
  const ring: Ev[] = []; let evSeq = 0, delivered = 0;
  let hostState: DeskState | null = null, guestSt: DeskState | null = null;
  const W = { on: false, timer: null as NodeJS.Timeout | null, intervalMs: 0, guest: 'auto' as boolean | 'auto', paths: [] as string[], fsw: [] as fs.FSWatcher[],
    polls: 0, pollMs: [] as number[], innerMs: [] as number[], lastPollAt: 0, lastFullAt: 0, errors: 0, lastError: '', guestUp: null as boolean | null, lastGuestPoll: 0, startedAt: '', lastSweep: 0 };
  function pushEvents(evs: DeskEvent[]) {
    for (const e of evs) {
      const last = ring.at(-1);   // typing produces a value_changed per tick: coalesce into the newest UNDELIVERED one
      if (e.type === 'value_changed' && last && last.type === 'value_changed' && last.seq > delivered && last.src === e.src && last.app === e.app && last.role === e.role && last.title === e.title) {
        last.chars = e.chars; last.ts = new Date().toISOString(); continue;
      }
      // 0.7.1: every string field cleaned HERE (one choke point) — field: guest titles still carried NULs on the watch path
      for (const k of Object.keys(e) as (keyof DeskEvent)[]) { const v = e[k]; if (typeof v === 'string') (e as any)[k] = v.replace(/\\u0000/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); }
      const full: Ev = { seq: ++evSeq, ts: new Date().toISOString(), ...e };
      ring.push(full); if (ring.length > 300) ring.shift();
      try {
        fs.mkdirSync(o.home, { recursive: true });
        try { if (fs.statSync(eventsFile).size > 5_000_000) fs.renameSync(eventsFile, `${eventsFile}.1`); } catch { /* new file */ }
        fs.appendFileSync(eventsFile, JSON.stringify(full) + '\n');
      } catch { /* best effort */ }
    }
  }
  const guestAlive = () => { try { return Date.now() - Date.parse(JSON.parse(fs.readFileSync(path.join(guestDir, 'helper-alive.json'), 'utf8')).ts) < 15_000; } catch { return false; } };
  async function fetchGuestState(timeoutMs = 5000): Promise<DeskState> {
    const r = await guestCall('state', {}, timeoutMs);
    const z = (v: unknown) => String(v ?? '').replace(/\u0000+/g, '');   // 0.6.1: console titles arrive NUL-terminated ('powershell.exe\0')
    const windows: DeskWin[] = (r.windows ?? []).map((x: any) => ({ id: String(x.id), app: z(x.proc || x.cls || '?'), title: z(x.title), cls: z(x.cls) }));
    const fg = r.fg ?? {}; for (const k of ['title', 'cls', 'proc']) fg[k] = z(fg[k]); if (r.focus) { r.focus.t = z(r.focus.t); r.focus.cls = z(r.focus.cls); }
    return { app: String(fg.proc || fg.cls || ''), window: String(fg.title ?? ''), fgCls: String(fg.cls ?? ''), windows, apps: [...new Set(windows.map(w => w.app))],
      focus: r.focus ? { r: r.focus.r === 'Pane' && r.focus.cls ? `Pane[${r.focus.cls}]` : String(r.focus.r ?? ''), t: String(r.focus.t ?? ''), n: r.focus.n ?? null, h: Number(r.focus.h ?? 0), cls: r.focus.cls } : null };
  }
  async function pollOnce() {
    const t0 = Date.now();
    if (backend.state) {
      // 0.6.1 (macbook, Big Sur 2-core: full snapshot p50 4.0 s): LIGHT ticks (front app's windows + focus) and a FULL one every 5th tick
      // or 10 s — launches/quits/background windows lag by at most that; the front app (where actions land) is exact every tick
      const full = !hostState || W.polls % 5 === 0 || Date.now() - W.lastFullAt > 10_000;
      try { const raw = await backend.state({ full }); if (full) W.lastFullAt = Date.now(); if (typeof raw.ms === 'number') { W.innerMs.push(raw.ms); if (W.innerMs.length > 100) W.innerMs.shift(); }
        const s = mergeLight(hostState, raw);
        // 0.7.1: a FULL read that suddenly lists no windows while the last one had several is a failed read (busy VM / AX hiccup), not a mass close
        if (!raw.partial && hostState && hostState.windows.length >= 2 && s.windows.length === 0) { W.errors++; W.lastError = 'host snapshot listed 0 windows — ignored'; }
        else { pushEvents(diffState(hostState, s, 'host')); hostState = s; } }
      catch (e: any) { W.errors++; W.lastError = String(e?.message ?? e).slice(0, 200); }
    }
    const alive = W.guest === true || (W.guest === 'auto' && guestAlive());
    if (!alive && W.guestUp) { pushEvents([{ type: 'guest_helper_down', src: 'guest', note: 'heartbeat stopped' }]); W.guestUp = false; guestSt = null; }
    // the helper answers one request at a time: never queue a poll behind an agent's guest_scan
    if (alive && guestInflight === 0 && Date.now() - W.lastGuestPoll >= Math.max(2000, W.intervalMs)) {
      W.lastGuestPoll = Date.now();
      try {
        const s = await fetchGuestState();
        if (W.guestUp === false) pushEvents([{ type: 'guest_helper_up', src: 'guest', note: 're-baselined (changes during the gap are not replayed)' }]);
        W.guestUp = true;
        if (guestSt && guestSt.windows.length >= 2 && s.windows.length === 0) { W.errors++; W.lastError = 'guest snapshot listed 0 windows — ignored'; }
        else { pushEvents(diffState(guestSt, s, 'guest')); guestSt = s; }
      } catch (e: any) {
        const m = String(e?.message ?? e);
        if (/unknown op 'state'/.test(m)) { W.guest = false; W.lastError = 'guest helper predates 0.6 (no "state" op) — copy the new guest/nexus-guest-uia.ps1 into the bridge and restart it in a NEW PowerShell window'; }
        else { if (W.guestUp) pushEvents([{ type: 'guest_helper_down', src: 'guest', note: m.slice(0, 120) }]); W.guestUp = false; guestSt = null; W.errors++; W.lastError = m.slice(0, 200); }   // 0.7.1: re-baseline silently after a gap
      }
    }
    if (Date.now() - W.lastSweep > 60_000) {   // a guest answer that arrived after its caller timed out is never read — sweep it
      W.lastSweep = Date.now();
      try { for (const f of fs.readdirSync(guestDir)) if (/^resp-.*\.json$/.test(f)) { const p = path.join(guestDir, f); if (Date.now() - fs.statSync(p).mtimeMs > 120_000) fs.unlinkSync(p); } } catch { /* no bridge */ }
    }
    W.polls++; W.lastPollAt = Date.now(); W.pollMs.push(Date.now() - t0); if (W.pollMs.length > 100) W.pollMs.shift();
  }
  let pollChain: Promise<void> = Promise.resolve();
  const pollSerial = () => (pollChain = pollChain.then(pollOnce, pollOnce));
  function schedule() { if (!W.on) return; W.timer = setTimeout(() => { void pollSerial().finally(schedule); }, W.intervalMs); W.timer.unref?.(); }
  function watchPath(p: string) {
    const abs = path.resolve(p); const st = fs.statSync(abs);   // throws for a missing path — reported to the caller
    const dir = st.isDirectory() ? abs : path.dirname(abs), only = st.isDirectory() ? null : path.basename(abs);
    const known = new Set<string>(); try { for (const f of fs.readdirSync(dir)) known.add(f); } catch { /* unreadable */ }
    const pending = new Map<string, NodeJS.Timeout>();
    const w = fs.watch(dir, { persistent: false }, (_t, name) => {
      const f = String(name ?? ''); if (!f || (only && f !== only) || /^\.|\.(tmp|crdownload|part|download)$/i.test(f)) return;
      clearTimeout(pending.get(f)); pending.set(f, setTimeout(() => {   // debounce: one event per settled write
        pending.delete(f); const full = path.join(dir, f); const exists = fs.existsSync(full);
        pushEvents([{ type: !exists ? 'file_removed' : known.has(f) ? 'file_changed' : 'file_created', src: 'fs', path: full }]);
        if (exists) known.add(f); else known.delete(f);
      }, 700));
    });
    w.on('error', () => { /* folder vanished */ });
    W.fsw.push(w);
  }
  function stopWatch() { W.on = false; if (W.timer) clearTimeout(W.timer); W.timer = null; for (const w of W.fsw) { try { w.close(); } catch { /* closed */ } } W.fsw = []; }
  async function startWatch(a: any) {
    stopWatch();
    W.intervalMs = Math.max(500, Math.min(60_000, Number(a.interval_ms ?? (backend.name.startsWith('macos') ? 1500 : 1000))));
    W.guest = typeof a.guest === 'boolean' ? a.guest : 'auto'; W.paths = Array.isArray(a.paths) ? a.paths.map(String) : [];
    for (const p of W.paths) watchPath(p);
    hostState = null; guestSt = null; W.guestUp = null;   // 0.7.1: every start seeds a FRESH silent baseline (a restart diffed against a stale one)
    W.on = true; W.startedAt = new Date().toISOString(); W.errors = 0; W.lastError = '';
    await pollSerial();   // baseline snapshot — no events for what is already open
    schedule();
  }
  const pctl = (xs: number[], p: number) => { if (!xs.length) return null; const v = [...xs].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
  function watchStatus() {
    return { on: W.on, interval_ms: W.intervalMs || null, guest: W.guest, guest_up: W.guestUp, paths: W.paths, polls: W.polls, poll_p50_ms: pctl(W.pollMs, 0.5),
      poll_p95_ms: pctl(W.pollMs, 0.95), snapshot_inner_p50_ms: pctl(W.innerMs, 0.5), errors: W.errors, last_error: W.lastError || undefined, events_total: evSeq, buffered: ring.length, undelivered: evSeq - delivered,
      log: eventsFile, started: W.startedAt || undefined };
  }
  async function watchOp(a: any): Promise<{ content: any[] }> {
    const text = (t: string) => ({ type: 'text', text: t });
    const op = a.op ?? 'status';
    if (op === 'start') { await startWatch(a); return { content: [text(`watching (every ${W.intervalMs} ms${W.paths.length ? `, folders: ${W.paths.join(', ')}` : ''}; guest ${W.guest}) — baseline ${hostState ? `${hostState.windows.length} windows, front ${hostState.app}` : 'n/a (no state on this backend)'}. New events now ride on every desktop result; watch {op:"events"} lists them; log ${eventsFile}`)] }; }
    if (op === 'stop') { stopWatch(); return { content: [text(`watch stopped (${evSeq} events recorded; log ${eventsFile})`)] }; }
    if (op === 'status') return { content: [text(JSON.stringify(watchStatus(), null, 1))] };
    if (op === 'events') {
      if (W.on) await pollSerial();
      const since = a.since_seq != null ? Number(a.since_seq) : delivered;
      const types: string[] | null = Array.isArray(a.types) && a.types.length ? a.types.map(String) : null;
      const rows = ring.filter(e => e.seq > since && (!types || types.includes(e.type)));
      const shown = rows.slice(-(a.limit ?? 50));
      if (a.since_seq == null) delivered = evSeq;
      return { content: [text(`${rows.length} event(s) after #${since}${rows.length > shown.length ? `, last ${shown.length} shown` : ''}${W.on ? '' : ' (watch is OFF — watch {op:"start"})'}:\n${shown.map(fmtEvent).join('\n') || '(none)'}`)] };
    }
    throw new Error(`watch op ${op}: start | stop | status | events`);
  }
  /** Events not yet shown to the agent, split into "during this action" (seq > seqAtStart) and "since your last call". */
  function eventTrailer(seqAtStart: number): string | null {
    const fresh = ring.filter(e => e.seq > delivered); if (!fresh.length) return null;
    delivered = evSeq;
    const ext = fresh.filter(e => e.seq <= seqAtStart), dur = fresh.filter(e => e.seq > seqAtStart);
    const block = (title: string, xs: Ev[]) => xs.length ? `${title}:\n${xs.slice(-8).map(e => `  ${fmtEvent(e)}`).join('\n')}${xs.length > 8 ? `\n  (+${xs.length - 8} earlier — watch {op:"events", since_seq:${xs[0].seq - 1}})` : ''}` : '';
    return ['desktop events', block('since your last call', ext), block('during this action', dur)].filter(Boolean).join('\n');
  }
  /** A scan's refs point into a window that has since closed / been retitled / whose app quit → say so before the agent acts on them. */
  function staleNote(kind: 'ax' | 'guest'): string | null {
    const sc = kind === 'ax' ? ensureScan() : (lastGuestScan ?? (lastGuestScan = restore<{ window: string; els: any[]; at?: number }>(guestScanFile)));
    if (!sc?.at) return null;
    const app = kind === 'ax' ? (sc as any).app : undefined, win = sc.window;
    const hit = ring.find(e => Date.parse(e.ts) >= sc.at! && e.src === (kind === 'ax' ? 'host' : 'guest') && (
      (e.type === 'window_closed' && e.title === win && (!app || e.app === app)) || (e.type === 'window_retitled' && e.from === win && (!app || e.app === app))
      || (kind === 'ax' && e.type === 'app_quit' && e.app === app)));
    return hit ? `WARNING: refs from the last ${kind === 'ax' ? 'scan' : 'guest_scan'} may be stale — ${fmtEvent(hit)} since that scan; rescan before acting on refs.` : null;
  }
  async function contextOp(a: any): Promise<{ content: any[] }> {
    const L: string[] = [`desktop context — ${backend.name}, desktop ${VERSION}, ${new Date().toTimeString().slice(0, 8)}`]; let guestErr = '';
    let hs: DeskState | null = null;
    // 0.7.1 (field: the host snapshot timed out at 15 s while the VM was busy): host + guest reads run IN PARALLEL, the host capped at 8 s
    const guestBusy = guestInflight > 0;   // captured BEFORE our own read raises the counter
    const guestP: Promise<DeskState | null> = fs.existsSync(guestDir) && guestAlive() && !guestBusy ? fetchGuestState(6000).catch((e: any) => { guestErr = String(e?.message ?? e).slice(0, 160); return null; }) : Promise.resolve(null);
    if (backend.state) { try { hs = await backend.state({ full: true, timeoutMs: 8000 }); if (W.on) { pushEvents(diffState(hostState, hs, 'host')); hostState = hs; } } catch (e: any) { L.push(`host state unavailable (${/timed out/.test(String(e?.message)) ? 'timed out — the Mac is busy (a VM under load?)' : String(e?.message ?? e).slice(0, 160)}); guest + profile below still apply`); } }
    else L.push(`windows:\n${(await backend.windows()).split('\n').slice(0, a.limit ?? 12).join('\n')}`);
    const fmtFocus = (f: DeskFocus) => f ? `; focus ${f.r} ${q(f.t)}${f.n != null ? ` (${f.n} chars)` : ''}` : '';
    const winLine = (w: DeskWin) => `  ${w.app} ${q(w.title)}${(w.w ?? 0) > 0 ? ` ${w.w}x${w.h}@${w.x},${w.y}` : ''}${isDialogWin(w) ? ' [dialog]' : ''}`;
    if (hs) {
      L.push(`front: ${hs.app || '-'} ${q(hs.window)}${fmtFocus(hs.focus)}`);
      const lim = a.limit ?? 12;
      L.push(`windows (${hs.windows.length}${hs.windows.length > lim ? `, first ${lim}` : ''}):`, ...hs.windows.slice(0, lim).map(winLine));
    }
    let gsSeen: DeskState | null = null;
    if (fs.existsSync(guestDir)) {
      if (!guestAlive()) L.push('guest: helper not running (no heartbeat) — guest_ping says how to start it');
      else if (guestBusy) L.push('guest: helper busy with another request — skipped');
      else {
        try {
          const gs = await guestP; if (!gs) throw new Error(guestErr || 'no answer'); gsSeen = gs; if (W.on && !(guestSt && guestSt.windows.length >= 2 && gs.windows.length === 0)) { pushEvents(diffState(guestSt, gs, 'guest')); guestSt = gs; }
          L.push(`guest: front ${gs.app} ${q(gs.window)} [${gs.fgCls}]${fmtFocus(gs.focus)}; ${gs.windows.length} windows`, ...gs.windows.slice(0, 8).map(w => `  ${w.app} ${q(w.title)} [${w.cls}]`));
        } catch (e: any) { L.push(`guest: ${String(e?.message ?? e).slice(0, 160)}`); }
      }
    }
    try { L.push(...profileHint(hs, gsSeen)); } catch { /* a broken profile never breaks context */ }
    const sc = ensureScan();
    if (sc?.at) L.push(`scan: e1-e${sc.els.length} of ${sc.app} ${q(sc.window)}, ${Math.round((Date.now() - sc.at) / 1000)} s old${staleNote('ax') ? ' — STALE (window changed since)' : ''}`);
    const gsc = lastGuestScan ?? restore<{ window: string; els: any[]; at?: number }>(guestScanFile);
    if (gsc?.at) L.push(`guest scan: g1-g${gsc.els.length} of ${q(gsc.window)}, ${Math.round((Date.now() - gsc.at) / 1000)} s old${staleNote('guest') ? ' — STALE' : ''}`);
    if (W.on) L.push(`watch: on, every ${W.intervalMs} ms, ${evSeq} events, poll p50 ${pctl(W.pollMs, 0.5)} ms${W.lastError ? `, last error: ${W.lastError}` : ''}`);
    else L.push('watch: off — watch {op:"start"} streams window/focus/app/file events into every result');
    const recent = ring.slice(-(a.recent ?? 6));
    if (recent.length) { L.push('recent events:', ...recent.map(e => `  ${fmtEvent(e)}`)); delivered = evSeq; }
    const fc = await failsafeCorner().catch(() => null);
    L.push(`safety: failsafe ${fc ?? 'off'}${stopLatched ? ` — STOPPED by the user (${stopLatched}); do not act, report to the user` : fs.existsSync(stopFile) ? ' — STOPPED by the user; do not act, report to the user' : ''}`);
    return { content: [{ type: 'text', text: L.join('\n') }] };
  }

  // ── 0.7: APP PROFILES — the desktop twin of a window STEWARD (stewardManualCompiler + windowToolCompiler): one JSON per application with
  //    an operating manual, the app's keyboard schema (shortcuts with verified flags, per context), and named macros. context names the
  //    matching profile + the keys valid in the CURRENT context; app {op:"run"} executes a shortcut or macro by id; verify/note let field use
  //    grow the profile. Profiles are DATA, never shipped in the package: <home>/apps/*.json + NEXUS_BROWSER_DESKTOP_PROFILES (dirs, ':').
  type Match = { host_apps?: string[]; guest_classes?: string[]; guest_procs?: string[]; title?: string; class?: string };
  type Shortcut = { id: string; context?: string; keys?: string; how?: string; description: string; verified?: boolean | 'partial'; verified_at?: string };
  type PMacro = { id: string; description: string; script: string; vars?: Record<string, string>; verified?: boolean | 'partial'; verified_at?: string };
  type Profile = { id: string; name: string; match: Match; contexts?: { id: string; match: Match }[]; manual?: string; shortcuts?: Shortcut[]; macros?: PMacro[];
    notes?: { ts: string; text: string }[]; __file?: string };
  const appsDir = path.join(o.home, 'apps');
  function loadProfiles(): Profile[] {
    const dirs = [appsDir, ...String(process.env.NEXUS_BROWSER_DESKTOP_PROFILES ?? '').split(':').filter(Boolean)];
    const out: Profile[] = []; const seen = new Set<string>();
    for (const d of dirs) {
      let files: string[] = []; try { files = fs.readdirSync(d).filter(f => f.endsWith('.json')).sort(); } catch { continue; }
      for (const f of files) {
        try { const p = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as Profile;
          if (p && typeof p.id === 'string' && p.match && !seen.has(p.id)) { seen.add(p.id); p.__file = path.join(d, f); out.push(p); } } catch { /* a broken file is skipped; app list reports it */ }
      }
    }
    return out;
  }
  const rx = (s?: string) => { if (!s) return null; try { return new RegExp(s, 'i'); } catch { return null; } };
  /** Does a front window (host app name, or guest proc/class/title) satisfy a match block? Empty block = never. */
  function matches(m: Match, side: 'host' | 'guest', st: DeskState | null): boolean {
    if (!st) return false;
    const title = st.window ?? '', cls = side === 'guest' ? (st.fgCls ?? '') : '';
    let any = false, ok = true;
    if (side === 'host' && m.host_apps?.length) { any = true; ok &&= m.host_apps.includes(st.app); }
    if (side === 'guest' && (m.guest_classes?.length || m.guest_procs?.length)) { any = true;
      ok &&= !!(m.guest_classes?.includes(cls) || m.guest_procs?.some(p => p.toLowerCase() === String(st.app).toLowerCase())); }
    if (m.class) { any = true; ok &&= cls === m.class; }
    const t = rx(m.title); if (t) { any = true; ok &&= t.test(title); }
    if (side === 'host' && !m.host_apps?.length && !m.title) return false;
    if (side === 'guest' && !m.guest_classes?.length && !m.guest_procs?.length && !m.class && !m.title) return false;
    return any && ok;
  }
  /** The profile (and its current sub-context) for what is in front: the guest first (it is where TS lives), then the host. */
  function activeProfile(hs: DeskState | null, gs: DeskState | null): { p: Profile; side: 'host' | 'guest'; ctx: string | null; hostFront?: string } | null {
    for (const p of loadProfiles()) for (const side of ['guest', 'host'] as const) {
      const st = side === 'guest' ? gs : hs;
      if (!matches(p.match, side, st)) continue;
      const ctx = (p.contexts ?? []).find(c => matches(c.match, side, st))?.id ?? null;
      return { p, side, ctx, hostFront: side === 'guest' ? hs?.app : undefined };
    }
    return null;
  }
  const scLine = (s: Shortcut) => `${s.id}\t${s.keys ?? `(${s.how ?? 'manual'})`}\t${s.description}${s.verified === true ? '' : s.verified === 'partial' ? '\t(PARTIAL)' : '\t(UNVERIFIED — verify after a successful use)'}`;
  const VM_FRONT_RE = /parallels|prl_|vmware|virtualbox|windows|coherence/i;   // host front app = a VM (Parallels Desktop / prl_client_app / VM name in Coherence)
  // 0.8.2 ([desktop-feedback] HIGH, macbook 11-08): cmd+a sent while a Parallels Windows guest was front reached the guest as the WIN key —
  // the VM dropped out of full screen and the host terminal came forward (a self-capture risk). On macOS, when the host's front app is the VM
  // and the combo uses cmd, send ctrl instead (Windows select-all/copy/paste/save are ctrl). Host-level combos (cmd+tab, cmd+space,
  // cmd+shift+tab) are left alone so the agent can still leave the VM. guest_keys:"host" turns the remap off.
  async function guestKey(combo: string, mode?: string): Promise<{ combo: string; note: string }> {
    if (mode === 'host' || !backend.name.startsWith('macos') || !backend.frontApp) return { combo, note: '' };
    const parts = combo.split('+').map(s => s.trim().toLowerCase());
    if (!parts.some(p => p === 'cmd' || p === 'command')) return { combo, note: '' };
    const keyName = parts[parts.length - 1];
    if (keyName === 'tab' || keyName === 'space') return { combo, note: '' };
    const front = await backend.frontApp().catch(() => '');
    if (!front || !VM_FRONT_RE.test(front)) return { combo, note: '' };
    const mapped = parts.map(p => (p === 'cmd' || p === 'command') ? 'ctrl' : p).join('+');
    return { combo: mapped, note: ` (guest front: ${front} — sent ${mapped} for "${combo}"; guest_keys:"host" to send cmd)` };
  }
  function profileHint(hs: DeskState | null, gs: DeskState | null): string[] {
    const ap = activeProfile(hs, gs); if (!ap) return [];
    const sc = ap.p.shortcuts ?? [], here = sc.filter(s => s.keys && (!s.context || s.context === ap.ctx || s.context === 'global'));
    // guest profile while the HOST's front app is not the VM (name varies: Parallels Desktop / prl_client_app / the VM's own name in Coherence):
    // keys would land in that host app — say so instead of hiding the profile
    const warn = ap.side === 'guest' && ap.hostFront && !VM_FRONT_RE.test(ap.hostFront) ? ` — NOTE: host front app is ${ap.hostFront}; bring the VM to the front before sending keys` : '';
    return [`app profile: ${ap.p.id} (${ap.p.name}) — context ${ap.ctx ?? '(none matched)'}${warn}; ${sc.length} shortcuts (${sc.filter(s => s.verified === true).length} verified), ${(ap.p.macros ?? []).length} macros → app {op:"show", name:"${ap.p.id}"}`,
      ...here.slice(0, 8).map(s => `  keys here: ${s.keys} = ${s.description}${s.verified === true ? '' : ' (unverified)'}  [app run id:${s.id}]`)];
  }
  function saveProfile(p: Profile) {
    const file = p.__file && p.__file.startsWith(appsDir) ? p.__file : path.join(appsDir, `${p.id}.json`);
    const { __file, ...body } = p; void __file;
    fs.mkdirSync(appsDir, { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(body, null, 1)); fs.renameSync(`${file}.tmp`, file);
    return file;
  }
  const getProfile = (name: string) => { const p = loadProfiles().find(x => x.id === name); if (!p) throw new Error(`no app profile "${name}" — app {op:"list"} shows the installed ones (files in ${appsDir})`); return p; };
  async function appOp(a: any): Promise<{ content: any[]; isError?: boolean }> {
    const text = (t: string) => ({ type: 'text', text: t });
    const op = a.op ?? 'list';
    if (op === 'list') {
      const ps = loadProfiles();
      let front: ReturnType<typeof activeProfile> = null;
      try { front = activeProfile(backend.state ? await backend.state({ full: false }) : null, fs.existsSync(guestDir) && guestAlive() && guestInflight === 0 ? await fetchGuestState(5000).catch(() => null) : null); } catch { /* no state */ }
      return { content: [text(ps.length ? ps.map(p => `${p.id}\t${p.name}\t${(p.shortcuts ?? []).length} shortcuts, ${(p.macros ?? []).length} macros${front?.p.id === p.id ? `\t<- IN FRONT (context ${front.ctx ?? '-'})` : ''}`).join('\n')
        : `(no app profiles — put <app>.json files in ${appsDir} or a dir named by NEXUS_BROWSER_DESKTOP_PROFILES; app {op:"save", profile_json})`)] };
    }
    if (op === 'show') {
      const p = getProfile(a.name);
      const sc = (p.shortcuts ?? []).filter(s => !a.context || s.context === a.context);
      const byCtx = new Map<string, Shortcut[]>(); for (const s of sc) { const k = s.context ?? 'global'; byCtx.set(k, [...(byCtx.get(k) ?? []), s]); }
      return { content: [text([`${p.name} (${p.id})`, p.manual ?? '', '', 'SHORTCUTS (app {op:"run", name, id}):', ...[...byCtx].flatMap(([k, xs]) => [`[${k}]`, ...xs.map(s => `  ${scLine(s)}`)]),
        '', 'MACROS (app {op:"run", name, id, vars?}):', ...(p.macros ?? []).map(m => `  ${m.id}\t${m.description}${m.vars ? `\tvars ${Object.entries(m.vars).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}${m.verified === true ? '' : '\t(UNVERIFIED)'}`),
        ...(p.notes?.length ? ['', 'FIELD NOTES:', ...p.notes.slice(-10).map(n => `  ${n.ts.slice(0, 16)} ${n.text}`)] : []), '', `file: ${p.__file}`].join('\n'))] };
    }
    if (op === 'run') {
      const p = getProfile(a.name); const id = String(a.id ?? '');
      const sc = (p.shortcuts ?? []).find(s => s.id === id), m = (p.macros ?? []).find(x => x.id === id);
      if (sc) { if (!sc.keys) throw new Error(`shortcut ${id} is a manual procedure, not a key sequence: ${sc.how ?? sc.description}`);
        const r = await act({ action: 'key', text: sc.keys, screenshot: a.screenshot ?? false, settle_ms: a.settle_ms });
        r.content[0] = text(`${p.id}/${id}: pressed ${sc.keys} (${sc.description})${sc.verified === true ? '' : ' — UNVERIFIED: check the result, then app {op:"verify"} (or op:"note" what really happened)'}`); return r; }
      if (m) { const r = await act({ action: 'run', script: m.script, vars: { ...(m.vars ?? {}), ...(a.vars ?? {}) }, screenshot: a.screenshot });
        if (m.verified !== true && !r.isError) r.content.push(text(`${p.id}/${id} is UNVERIFIED — confirm the outcome, then app {op:"verify", name:"${p.id}", id:"${id}"}`)); return r; }
      throw new Error(`no shortcut or macro "${id}" in ${p.id} — app {op:"show", name:"${p.id}"}`);
    }
    if (op === 'verify' || op === 'note') {
      const p = getProfile(a.name);
      if (op === 'verify') { const x: any = (p.shortcuts ?? []).find(s => s.id === a.id) ?? (p.macros ?? []).find(s => s.id === a.id);
        if (!x) throw new Error(`no shortcut or macro "${a.id}" in ${p.id}`); x.verified = true; x.verified_at = new Date().toISOString(); }
      else { if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('app note needs text'); (p.notes ??= []).push({ ts: new Date().toISOString(), text: a.text.trim().slice(0, 500) }); }
      const f = saveProfile(p); return { content: [text(`${op === 'verify' ? `marked ${p.id}/${a.id} VERIFIED` : `noted in ${p.id}`} (${f})`)] };
    }
    if (op === 'save') {
      let p: Profile; try { p = JSON.parse(String(a.profile_json ?? '')); } catch (e: any) { throw new Error(`app save needs profile_json (a JSON object): ${e?.message ?? e}`); }
      if (!p?.id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.id) || !p.name || !p.match) throw new Error('profile needs id (a-z0-9_-), name and match');
      // syntax check now — with the macro's own default vars (a coordinate var like focus_xy must parse as X,Y), unknown vars as 0
      for (const m of p.macros ?? []) m.script.split('\n').forEach((l, i) => parseLine(l.replace(/\$\{([A-Za-z_]\w*)\}/g, (_x, k) => m.vars?.[k] ?? '0'), i + 1));
      return { content: [text(`saved app profile ${p.id} (${saveProfile(p)})`)] };
    }
    throw new Error(`app op ${op}: list | show | run | verify | note | save`);
  }

  // ── 0.8: BUS — step 4: forward watch events + the front snapshot to the user's own Nexus Terminal SPA through the INBOUND RELAY
  //    (POST <relay>/submit {tool:"desktop_events", args}); the SPA publishes them on CortexEventBus (CORTEX's recent events, the Agent
  //    Bus) and lists this machine under "Remote desktops" in the workspace context. One-way: nothing comes back to drive this desktop.
  //    The nrl_ key is the USER's (minted in ADMIN → Relay MCP API Keys, allowed_tools ["desktop_events"]) and is read from a 0600 FILE.
  const B = { on: false, timer: null as NodeJS.Timeout | null, url: '', host: '', keyFile: '', titles: true, intervalMs: 10_000, lastSent: 0, lastBeat: 0,
    sent: 0, batches: 0, failures: 0, consecutiveAuth: 0, lastError: '', lastRequestId: '', lastResult: '' as string, startedAt: '' };
  const readKey = () => {
    const k = B.keyFile ? fs.readFileSync(B.keyFile, 'utf8').trim() : String(process.env.NEXUS_BROWSER_DESKTOP_BUS_KEY ?? '').trim();
    if (!/^nrl_[A-Za-z0-9_-]{8,}$/.test(k)) throw new Error(`no relay key — put the user's nrl_ key (ADMIN → Relay MCP API Keys, allowed_tools ["desktop_events"]) in a 0600 file and pass key_file (or NEXUS_BROWSER_DESKTOP_BUS_KEY_FILE)`);
    if (B.keyFile && (fs.statSync(B.keyFile).mode & 0o077)) throw new Error(`${B.keyFile} is readable by others — chmod 600 it`);
    return k;
  };
  const redact = (e: Ev) => B.titles ? e : { ...e, title: e.title ? '(title hidden)' : e.title, from: e.from ? '(hidden)' : e.from, to: e.to ? '(hidden)' : e.to, path: e.path ? path.basename(e.path) : e.path };
  function frontSnapshot() {
    const ap = (() => { try { return activeProfile(hostState, guestSt); } catch { return null; } })();
    const hide = (t?: string) => (B.titles ? t : t ? '(title hidden)' : t);
    return { app: hostState?.app, window: hide(hostState?.window), guest_app: guestSt?.app, guest_window: hide(guestSt?.window), profile: ap?.p.id, context: ap?.ctx ?? undefined };
  }
  async function busFlush(force = false): Promise<string> {
    const fresh = ring.filter(e => e.seq > B.lastSent);
    const beatDue = Date.now() - B.lastBeat > 120_000;   // keep the SPA's "Remote desktops" line fresh (it drops a host after 10 min of silence)
    if (!fresh.length && !beatDue && !force) return 'nothing new';
    const batch = fresh.slice(0, 200).map(e => { const r = redact(e); const { seq, ts, ...rest } = r; void ts; return { ...r, line: fmtEvent({ ...rest, seq: undefined } as any) }; });
    const key = readKey();
    const res = await fetch(`${B.url}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ tool: 'desktop_events', args: { host: B.host, events: batch, front: frontSnapshot() }, timeoutMs: 15_000 }), signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    if (!res.ok) {
      B.failures++; B.lastError = `submit ${res.status}: ${body.replace(/nrl_[A-Za-z0-9_-]+/g, 'nrl_…').slice(0, 200)}`;
      if (res.status === 401 || res.status === 402 || res.status === 403) { if (++B.consecutiveAuth >= 3) { busStop(); B.lastError += ' — bus STOPPED after 3 auth failures (check the key and its allowed_tools)'; } }
      throw new Error(B.lastError);
    }
    B.consecutiveAuth = 0; B.lastBeat = Date.now(); B.batches++; B.sent += batch.length;
    if (batch.length) B.lastSent = Math.max(B.lastSent, ...batch.map(e => e.seq));
    try { B.lastRequestId = String(JSON.parse(body).requestId ?? ''); } catch { /* opaque */ }
    // read back the FIRST batch's result (and every 20th) — proves the user's SPA really claimed + executed it
    if (B.lastRequestId && (B.batches === 1 || B.batches % 20 === 0)) void busCheckResult(B.lastRequestId, key);
    return `sent ${batch.length} event(s) as batch ${B.batches} (request ${B.lastRequestId || '?'})`;
  }
  async function busCheckResult(id: string, key: string) {
    for (let i = 0; i < 10; i++) {
      await sleep(3000);
      try { const r = await fetch(`${B.url}/result?requestId=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
        if (r.status === 404) continue; B.lastResult = (await r.text()).replace(/nrl_[A-Za-z0-9_-]+/g, 'nrl_…').slice(0, 300); return; } catch { /* retry */ }
    }
    B.lastResult = `no result for ${id} after 30 s — is the user's Nexus Terminal SPA open and signed in? (only a live SPA claims relay requests)`;
  }
  function busSchedule() { if (!B.on) return; B.timer = setTimeout(() => { void busFlush().catch(() => { /* in status */ }).finally(busSchedule); }, B.intervalMs); B.timer.unref?.(); }
  function busStop() { B.on = false; if (B.timer) clearTimeout(B.timer); B.timer = null; }
  // 0.8.1: the bus runs DETACHED by default (desktop-bus-daemon.js) so it outlives a one-shot caller; pidfile + status file in the home
  const busPidFile = path.join(o.home, 'bus.pid'), busStatusFile = path.join(o.home, 'bus-status.json');
  // never our OWN pid: inside the daemon, its bus stop would otherwise SIGTERM itself in a loop (caught by the 0.8.1 test)
  const daemonPid = (): number | null => { try { const pid = Number(fs.readFileSync(busPidFile, 'utf8').trim()); if (pid > 0 && pid !== process.pid) { process.kill(pid, 0); return pid; } } catch { /* none / dead */ } return null; };
  const readDaemonStatus = () => { try { return JSON.parse(fs.readFileSync(busStatusFile, 'utf8')); } catch { return null; } };
  async function busStartDetached(a: any): Promise<{ content: any[]; isError?: boolean }> {
    const text = (t: string) => ({ type: 'text', text: t });
    const old = daemonPid(); if (old) { try { process.kill(old, 'SIGTERM'); } catch { /* gone */ } for (let i = 0; i < 30 && daemonPid(); i++) await sleep(200); }
    try { fs.unlinkSync(busStatusFile); } catch { /* none */ }
    const { detach: _d, action: _a, op: _o, ...rest } = a; void _d; void _a; void _o;
    const script = new URL('./desktop-bus-daemon.js', import.meta.url);
    if (!fs.existsSync(script)) throw new Error(`bus daemon script missing (${script.pathname}) — reinstall the package, or pass detach:false to run the bus inside this process`);
    fs.mkdirSync(o.home, { recursive: true });
    const log = fs.openSync(path.join(o.home, 'bus-daemon.log'), 'a');
    const child = spawn(process.execPath, [script.pathname], { detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, NEXUS_BROWSER_DESKTOP_HOME: o.home, NEXUS_BROWSER_DESKTOP: o.mode, NEXUS_BROWSER_GUEST_DIR: guestDir, NEXUS_BUS_ARGS: JSON.stringify(rest) } });
    child.unref(); fs.closeSync(log);
    for (let i = 0; i < 100; i++) { const st = readDaemonStatus(); if (st?.start_result) {
      return { content: [text(`bus DAEMON pid ${st.pid} (detached — survives this process; bus {op:"status"|"stop"} find it via ${busPidFile}): ${st.start_result}`)], ...(st.start_error ? { isError: true } : {}) }; } await sleep(200); }
    return { content: [text(`bus daemon spawned (pid ${child.pid}) but reported nothing in 20 s — see ${path.join(o.home, 'bus-daemon.log')}`)], isError: true };
  }
  async function busOp(a: any): Promise<{ content: any[]; isError?: boolean }> {
    const text = (t: string) => ({ type: 'text', text: t });
    const op = a.op ?? 'status';
    if (op === 'start' && a.detach !== false) return busStartDetached(a);
    if (op === 'start') {
      busStop();
      B.url = String(a.url ?? process.env.NEXUS_BROWSER_DESKTOP_BUS_URL ?? 'https://relay.spitfire-products.com').replace(/\/+$/, '');
      if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(B.url)) throw new Error('bus url must be https (or http on localhost for tests)');
      B.host = String(a.host ?? process.env.NEXUS_BROWSER_DESKTOP_BUS_HOST ?? os.hostname().split('.')[0]).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'desktop';
      B.keyFile = String(a.key_file ?? process.env.NEXUS_BROWSER_DESKTOP_BUS_KEY_FILE ?? '');
      B.titles = a.titles !== false; B.intervalMs = Math.max(5000, Math.min(300_000, Number(a.interval_ms ?? 10_000)));
      readKey();   // fail fast on a missing / loose key file
      if (!W.on) await startWatch({});
      B.lastSent = evSeq;   // forward from NOW (history stays in the local log)
      B.on = true; B.startedAt = new Date().toISOString(); B.failures = 0; B.lastError = ''; B.lastResult = ''; B.batches = 0; B.sent = 0;
      const first = await busFlush(true).catch((e: any) => `first submit FAILED: ${e?.message ?? e}`);
      busSchedule();
      return { content: [text(`bus ON → ${B.url} as host "${B.host}" every ${B.intervalMs / 1000} s (titles ${B.titles ? 'sent' : 'hidden'}); ${first}. watch is ${W.on ? 'on' : 'off'}. The SPA must be open + signed in to claim (bus {op:"status"} shows the read-back).`)] };
    }
    if (op === 'stop') {
      const pid = daemonPid(); let msg = '';
      if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } for (let i = 0; i < 30 && daemonPid(); i++) await sleep(200);
        msg = daemonPid() ? `bus daemon pid ${pid} did NOT stop within 6 s — kill it by PID: kill ${pid}` : `bus daemon pid ${pid} stopped`; }
      const local = B.on; busStop();
      return { content: [text(msg || (local ? `bus stopped (${B.sent} events in ${B.batches} batches)` : 'bus was not running'))] };
    }
    if (op === 'flush') { const r = await busFlush(true); return { content: [text(r)] }; }
    if (op === 'status' && !B.on) { const pid = daemonPid(); const st = readDaemonStatus();
      if (pid && st) return { content: [text(JSON.stringify({ ...st, daemon_alive: true }, null, 1))] };
      if (st && !pid) return { content: [text(JSON.stringify({ ...st, on: false, daemon_alive: false, note: 'daemon not running (last status shown)' }, null, 1))] }; }
    if (op === 'status') return { content: [text(JSON.stringify({ on: B.on, url: B.url || undefined, host: B.host || undefined, titles: B.titles, interval_ms: B.intervalMs, sent: B.sent, batches: B.batches,
      pending: ring.filter(e => e.seq > B.lastSent).length, failures: B.failures, last_error: B.lastError || undefined, last_request: B.lastRequestId || undefined, last_result: B.lastResult || undefined, started: B.startedAt || undefined }, null, 1))] };
    throw new Error(`bus op ${op}: start | stop | status | flush`);
  }
  async function act(a: any): Promise<{ content: any[]; isError?: boolean }> {
    const t0 = Date.now();
    // 0.3: display-free actions answer even when no screen is reachable (catalog, macros, stats, shortcut list)
    if (a.action === 'stats') return { content: [{ type: 'text', text: JSON.stringify(summarize(a.since_min, a.log_path), null, 1) }] };
    if (a.action === 'hotkey' && (a.list || !a.name)) return { content: [{ type: 'text', text: `native shortcuts (${platformOf(a)}) — {action:"hotkey", name}:\n${hotkeyCatalog(platformOf(a))}` }] };
    if (a.action === 'macro' && a.op === 'validate') { const m = a.name ? readMacro(a.name) : null; const src = m ? m.script : a.script;
      if (typeof src !== 'string' || !src.trim()) throw new Error('macro validate needs name (a saved macro) or script');
      return validateOp(src, { ...(m?.vars ?? {}), ...(a.vars ?? {}) }, a.live_menus !== false); }
    if (a.action === 'run' && a.validate) { const src = a.macro ? readMacro(a.macro).script : a.script;
      if (typeof src !== 'string' || !src.trim()) throw new Error('run needs script (desktop script lines) or macro (a saved macro name)');
      return validateOp(src, { ...(a.vars ?? {}) }, a.live_menus !== false); }
    if (a.action === 'macro') return macroOp(a);
    if (a.action === 'context') return contextOp(a);
    if (a.action === 'watch') return watchOp(a);
    if (a.action === 'app') return appOp(a);
    if (a.action === 'bus') return busOp(a);
    if (typeof a.action === 'string' && a.action.startsWith('guest_')) return guestOp(a);
    const g = geo ?? await geometry();
    const text = (s: string) => ({ type: 'text', text: s });
    const img = (s: Shot) => ({ type: 'image', data: s.png.toString('base64'), mimeType: 'image/png' });
    const after = async (msg: string) => {
      const want = a.screenshot ?? true;
      if (!want) return { content: [text(msg)] };
      await sleep(Math.max(0, Math.min(5000, a.settle_ms ?? 600)));
      const s = await shot();
      return { content: [text(`${msg} — screenshot ${s.width}×${s.height}`), img(s)] };
    };
    switch (a.action) {
      case 'info': {
        const c = await backend.cursor().catch(() => null); const fc = o.mode === 'real' ? await failsafeCorner() : null; const pm = await perms();
        return { content: [text(JSON.stringify({ mode: o.mode, failsafe_corner: fc, failsafe_corner_px: fc ? (({ x, y }) => [Math.round(x / g.f), Math.round(y / g.f)])(cornerPt(fc, g)) : null, backend: backend.name, screen_points: [g.w, g.h], screenshot: [g.sw, g.sh], scale: +g.f.toFixed(4),
          cursor_screenshot_px: c ? [Math.round(c.x / g.f), Math.round(c.y / g.f)] : null, permissions: pm, stop_file: stopFile, stopped: fs.existsSync(stopFile), launch_allow_list: apps }))] };
      }
      case 'screenshot': { const s = await shot(); const pm = await perms();
        const warn = pm.screen_recording === false ? ' — WARNING: Screen Recording is NOT granted, so this shows only the wallpaper/menu bar, not app windows' : '';
        return { content: [text(`screenshot ${s.width}×${s.height} (${backend.name})${warn}`), img(s)] }; }
      case 'zoom': {
        const r = normRegion(a.region); if (!r) throw new Error('zoom needs region [x1, y1, x2, y2] (or {x, y, width, height}) in screenshot pixels');
        const p1 = toScreen([r[0], r[1]], g), p2 = toScreen([r[2], r[3]], g);
        if (p2.x <= p1.x || p2.y <= p1.y) throw new Error('region must have x2 > x1 and y2 > y1');
        const outW = Math.min(1280, Math.round((p2.x - p1.x) * Math.max(1, Math.min(4, a.zoom_factor ?? 2))));
        const outH = Math.round(outW * (p2.y - p1.y) / (p2.x - p1.x));
        const png = await backend.capture(outW, outH, [p1.x, p1.y, p2.x, p2.y]);
        return { content: [text(`zoom of [${r.join(', ')}] → ${outW}×${outH} (coordinates in this image are NOT screen coordinates)`), img({ png, width: outW, height: outH })] };
      }
      case 'cursor_position': { const c = await backend.cursor(); return { content: [text(JSON.stringify({ x: Math.round(c.x / g.f), y: Math.round(c.y / g.f) }))] }; }
      case 'wait': { await sleep(Math.max(0, Math.min(30, a.duration ?? 1)) * 1000); return after(`waited ${a.duration ?? 1}s`); }
      case 'windows': return { content: [text(await backend.windows())] };
      case 'stats': return { content: [text(JSON.stringify(summarize(a.since_min, a.log_path), null, 1))] };
      case 'scan': {
        if (!backend.axScan) throw new Error(AX_ONLY);
        const ts = Date.now(); const tree = await backend.axScan({ app: a.app, window: a.window, max: a.max ?? 250, depth: a.depth ?? 12, budget_ms: a.budget_ms }); const took = Date.now() - ts;
        lastScan = { ...tree, at: Date.now() }; persist(axScanFile, lastScan);
        const f = a.filter ?? {}; const q = typeof f.hasText === 'string' ? f.hasText.toLowerCase() : null;
        const rows = tree.els.map((el, i) => ({ el, i })).filter(({ el }) =>
          (f.interactive ? AX_INTERACTIVE.has(el.r) : true) && (f.role ? el.r.toLowerCase().includes(String(f.role).toLowerCase().replace(/^ax/, '')) : true)
          && (q ? `${el.t}\n${el.d}\n${el.v}`.toLowerCase().includes(q) : true) && (a.include_hidden ? true : el.w > 0 && el.h > 0));
        const shown = rows.slice(0, a.limit ?? 120);
        return { content: [text(`accessibility scan — ${tree.app} / ${JSON.stringify(tree.window)} — ${tree.els.length} elements in ${took} ms${tree.timed_out ? ` — PARTIAL: stopped at the ${Math.round((a.budget_ms ?? 90000) / 1000)} s budget (scope it: window + depth 3-5 + a filter; or budget_ms)` : ''}${tree.diag ? ` — biggest batched node: ${tree.diag.children} children in ${tree.diag.ms} ms (${Object.entries(tree.diag.attr_ms).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}${tree.events ? ` (${tree.events} Apple Events, ${tree.abatched ?? 0} attribute-batched nodes, ${tree.batch === false ? 'properties batch refused → per-element below 4 children, containers only' : `${tree.batched ?? 0} properties-batched`})` : ''}${tree.truncated ? ' (TRUNCATED at max — for big windows scope it up front: window:"…", depth:4–6, and filter {interactive:true} or {hasText:…}; raise max only if needed)' : ''}; ${rows.length} match${rows.length > shown.length ? `, first ${shown.length} shown` : ''}. Coordinates are screenshot px; act with press {ref} / set_value {ref, text} / grab {ref}.\n` +
          shown.map(({ el, i }) => elLine(el, i, g)).join('\n'))] };
      }
      case 'grab': {
        if (!backend.axAct) throw new Error(AX_ONLY);
        let el: AxEl | undefined;
        if (a.ref) el = refEl(a.ref);
        else if (a.coordinate) {
          if (!ensureScan()) throw new Error('grab by coordinate needs a scan first (it picks the smallest scanned element containing the point)');
          const pt = toScreen(a.coordinate, g);
          el = lastScan!.els.filter(e => e.w > 0 && e.h > 0 && pt.x >= e.x && pt.x <= e.x + e.w && pt.y >= e.y && pt.y <= e.y + e.h).sort((x, y) => x.w * x.h - y.w * y.h)[0];
          if (!el) throw new Error(`no scanned element contains [${a.coordinate}]`);
        } else throw new Error('grab needs ref (from scan) or coordinate');
        const live = await backend.axAct({ app: lastScan!.app, window: lastScan!.window, path: el.p, act: 'get' });
        const i = lastScan!.els.indexOf(el);
        return { content: [text(JSON.stringify({ ref: `e${i + 1}`, role: live.r, subrole: live.sr || undefined, title: live.t, description: live.d || undefined, value: live.v, help: live.help || undefined,
          enabled: live.e, focused: live.f, children: live.n, center_px: centerPx(live, g), size_px: [Math.round(live.w / g.f), Math.round(live.h / g.f)] }, null, 1))] };
      }
      case 'hotkey': if (a.list || !a.name) return { content: [text(`native shortcuts (${platformOf(a)}) — {action:"hotkey", name}:\n${hotkeyCatalog(platformOf(a))}`)] }; break;
      case 'menu': if (a.list || !a.path) {
        if (!backend.menuList) throw new Error('menu by name is macOS-only — on X11 / inside a Windows VM use hotkeys (alt+letter opens menus) and macros');
        return { content: [text(await backend.menuList(a.app, a.top, a.include_recent === true))] }; } break;
      case 'shortcut': if ((a.op ?? 'list') === 'list') {
        if (!backend.shortcutList) throw new Error('app shortcuts are macOS-only (NSUserKeyEquivalents)'); if (!a.app) throw new Error('shortcut list needs app');
        return { content: [text(JSON.stringify(await backend.shortcutList(a.app), null, 1))] }; } break;
      case 'macro': return macroOp(a);
    }
    await guard();
    switch (a.action) {
      case 'mouse_move': { const p = toScreen(a.coordinate, g); await backend.move(p); await verifyAt(p, 'mouse_move'); return after(`moved to [${a.coordinate}]`); }
      case 'left_click': case 'right_click': case 'middle_click': case 'double_click': case 'triple_click': {
        const button = a.action === 'right_click' ? 'right' : a.action === 'middle_click' ? 'middle' : 'left';
        const n = a.action === 'double_click' ? 2 : a.action === 'triple_click' ? 3 : 1;
        const p = a.coordinate ? toScreen(a.coordinate, g) : a.ref ? toScreen(centerPx(refEl(a.ref), g), g) : await backend.cursor();
        await backend.click(p, button, n); await verifyAt(p, a.action);
        const front = a.report_front && backend.frontApp ? ` — frontmost app: ${await backend.frontApp().catch(() => '?')}` : '';
        return after(`${a.action} at [${a.coordinate ?? 'cursor'}]${front}`);
      }
      case 'left_click_drag': { const e = toScreen(a.coordinate, g); await backend.drag(toScreen(a.start_coordinate, g), e); await verifyAt(e, 'left_click_drag'); return after(`dragged [${a.start_coordinate}] → [${a.coordinate}]`); }
      case 'scroll': {
        const p = a.coordinate ? toScreen(a.coordinate, g) : await backend.cursor();
        await backend.scroll(p, a.scroll_direction ?? 'down', a.scroll_amount ?? 3); return after(`scrolled ${a.scroll_direction ?? 'down'} ×${a.scroll_amount ?? 3}`);
      }
      case 'type': { if (typeof a.text !== 'string' || !a.text) throw new Error('type needs text');
        await backend.type(a.text, { via: a.type_via, charDelayMs: a.char_delay_ms, pasteKey: a.paste_key });
        return after(`typed ${a.text.length} chars${a.type_via === 'paste' ? ' (paste)' : a.char_delay_ms ? ` (${a.char_delay_ms} ms/char)` : ''}`); }
      case 'key': { if (typeof a.text !== 'string' || !a.text) throw new Error('key needs text, e.g. "Return", "cmd+space", "ctrl+shift+t"');
        const k = await guestKey(a.text, a.guest_keys); await backend.key(k.combo); return after(`pressed ${k.combo}${k.note}`); }
      case 'fill_field': {
        // 0.2.7 (field: date pickers navigated page by page through calendars): ONE call = click the field's text → (Escape a popup) →
        // select existing content → type → commit key; returns a zoomed crop of the field to verify (full screenshot only on request).
        const p = toScreen(a.coordinate, g); const sel = a.select ?? 'triple_click';
        await backend.click(p, 'left', sel === 'double_click' ? 2 : sel === 'triple_click' ? 3 : 1); await verifyAt(p, 'fill_field');
        if (a.escape_first) { await sleep(120); await backend.key('Escape'); await sleep(120); }
        if (sel === 'select_all' || a.escape_first && sel !== 'none') await backend.key((await guestKey(a.select_all_key ?? (backend.name.startsWith('macos') ? 'cmd+a' : 'ctrl+a'), a.guest_keys)).combo);
        if (typeof a.text === 'string' && a.text.length) await backend.type(a.text, { via: a.type_via, charDelayMs: a.char_delay_ms, pasteKey: a.paste_key });
        const commit = typeof a.commit_key === 'string' && !/^(none|)$/i.test(a.commit_key.trim()) ? a.commit_key : null;   // 0.2.9: 'none' = type without committing
        if (commit) await backend.key(commit);
        await sleep(Math.max(0, Math.min(5000, a.settle_ms ?? 400)));
        const half = { w: Math.round(240 * g.f), h: Math.round(30 * g.f) };
        const r: [number, number, number, number] = [Math.max(0, p.x - half.w), Math.max(0, p.y - half.h), Math.min(g.w, p.x + half.w), Math.min(g.h, p.y + half.h)];
        const zw = Math.min(960, (r[2] - r[0]) * 2), zh = Math.round(zw * (r[3] - r[1]) / (r[2] - r[0]));
        const crop = await backend.capture(zw, zh, r);
        const parts: any[] = [text(`filled field at [${a.coordinate}] (${sel}${a.escape_first ? ' + Escape' : ''}, ${a.text?.length ?? 0} chars${a.type_via === 'paste' ? ' via paste' : a.char_delay_ms ? ` @${a.char_delay_ms} ms/char` : ''}${commit ? `, then ${commit}` : ', no commit key'}) — zoom of the field below (verify the value; NOT screen coordinates)`), img({ png: crop, width: zw, height: zh })];
        if (a.screenshot === true) { const s = await shot(); parts.push(text(`screenshot ${s.width}×${s.height}`), img(s)); }
        return { content: parts };
      }
      case 'press': {
        if (!backend.axAct) throw new Error(AX_ONLY);
        const el = refEl(a.ref);
        const r = await backend.axAct({ app: lastScan!.app, window: lastScan!.window, path: el.p, act: 'press' });
        if (!r.ok) { const [cx, cy] = centerPx(el, g); const p = toScreen([cx, cy], g); await backend.click(p, 'left', 1); await verifyAt(p, 'press'); return after(`pressed ${a.ref} by clicking its center (${r.note})`); }
        return after(`pressed ${a.ref} (${el.r.replace(/^AX/, '')} ${JSON.stringify(el.t || el.d)}) via AXPress`);
      }
      case 'set_value': {
        if (!backend.axAct) throw new Error(AX_ONLY);
        if (typeof a.text !== 'string') throw new Error('set_value needs text');
        const el = refEl(a.ref);
        const r = await backend.axAct({ app: lastScan!.app, window: lastScan!.window, path: el.p, act: 'set', value: a.text });
        const okv = r.v === a.text;
        return { content: [text(okv ? `set ${a.ref} value (${a.text.length} chars) — read back: matches` : `set ${a.ref}: read back DIFFERS (${r.v.length} chars) — the field may reformat or refuse direct set; use fill_field instead`)], ...(okv ? {} : { isError: true }) };
      }
      case 'hotkey': { const combo = hotkeyFor(a.name, platformOf(a)); await backend.key(combo); return after(`hotkey ${a.name} = ${combo}`); }
      case 'menu': {
        if (!backend.menuInvoke) throw new Error('menu by name is macOS-only — on X11 / inside a Windows VM use hotkeys (alt+letter opens menus) and macros');
        const mp = Array.isArray(a.path) ? a.path : String(a.path).split('>').map((x: string) => x.trim()).filter(Boolean);
        if (mp.length < 2) throw new Error('menu path needs at least a menu and an item, e.g. ["File","Save As…"] or "File > Save As…"');
        return after(await backend.menuInvoke(mp, a.app));
      }
      case 'shortcut': {
        const op = a.op; if (!a.app || !a.menu_item) throw new Error('shortcut set/remove needs app and menu_item');
        const title = keyEquivalentTitle(a.menu_item);
        if (op === 'remove') { if (!backend.shortcutRemove) throw new Error('app shortcuts are macOS-only'); const bid = await backend.shortcutRemove(a.app, title);
          return { content: [text(`removed the app shortcut for "${[a.menu_item].flat().join(' > ')}" in ${a.app} (${bid}); quit + reopen ${a.app} to unload it`)] }; }
        if (op === 'set') { if (!backend.shortcutSet) throw new Error('app shortcuts are macOS-only'); if (!a.keys) throw new Error('shortcut set needs keys, e.g. "cmd+opt+e"');
          const bid = await backend.shortcutSet(a.app, title, comboToKeyEquivalent(a.keys));
          return { content: [text(`created ${a.keys} → "${[a.menu_item].flat().join(' > ')}" in ${a.app} (${bid}). Apps read App Shortcuts at launch: QUIT and reopen ${a.app}, then {action:"key", text:"${a.keys}"} runs it. Remove with op:"remove".`)] }; }
        throw new Error('shortcut op: set | remove | list');
      }
      case 'run': {
        const src = a.macro ? readMacro(a.macro).script : a.script;
        if (typeof src !== 'string' || !src.trim()) throw new Error('run needs script (desktop script lines) or macro (a saved macro name)');
        const log: string[] = [], images: any[] = [];
        const imgParts = () => images.flatMap((x: any) => [text(x.label), x.part]);
        try { await runScript(src, { ...(a.vars ?? {}) }, a.macro ? 1 : 0, log, images); }
        catch (e: any) { return { content: [text(`script STOPPED at ${e?.message ?? e}\n${log.join('\n')}`), ...imgParts()], isError: true }; }
        const parts: any[] = [text(`script ok — ${log.length} steps in ${Date.now() - t0} ms\n${log.join('\n')}`), ...imgParts()];
        if (a.screenshot !== false) { const s2 = await shot(); parts.push(text(`screenshot ${s2.width}×${s2.height}`), img(s2)); }
        return { content: parts };
      }
      case 'launch': { if (!a.app) throw new Error('launch needs app'); await backend.launch(a.app); return after(`launched ${a.app}`); }
      case 'focus_window': { const w = a.window ?? a.app;   // 0.2.4: `app` accepted too (macbook passed {app:'prl_client_app'})
        if (!w) throw new Error('focus_window needs `window` (window id, title, or app name) — `app` also accepted'); await backend.focus(w); return after(`focused ${w}`); }
    }
    throw new Error(`unknown action "${a.action}"`);
  }

  if (/^(1|true|on)$/i.test(process.env.NEXUS_BROWSER_DESKTOP_WATCH ?? '')) void startWatch({}).catch(() => { /* reported by watch status */ });
  return {
    backend, stopFile, logFile, act, stopWatch,
    async handle(a: any) {
      const t0 = Date.now();
      // every action is audited uniformly (0.2.6): ms + ok + err_class feed the `stats` action; typed text by LENGTH only
      const base = () => ({ action: a.action, ms: Date.now() - t0, coordinate: a.coordinate, key: a.action === 'key' ? a.text : undefined,
        chars: (a.action === 'type' || a.action === 'fill_field' || a.action === 'set_value' || a.action === 'guest_set_value') && typeof a.text === 'string' ? a.text.length : undefined, via: (a.action === 'type' || a.action === 'fill_field') ? (a.type_via ?? (a.char_delay_ms ? `keys+${a.char_delay_ms}ms` : 'keys')) : undefined, app: a.app, window: a.window, shot: a.screenshot ?? undefined });
      // 0.6: stale-ref check BEFORE the action; after it, one fresh poll (when watching) so the action's own effects are reported, then the
      // trailer with every event the agent has not seen (during this action / since its last call)
      // attribution: a poll right BEFORE a mutating action files earlier changes under "since your last call", not under this action
      // (skipped when one finished < 300 ms ago; NEXUS_BROWSER_DESKTOP_WATCH_PREPOLL=0 turns it off to save one state read per action)
      if (W.on && !READ_ONLY_ACTIONS.test(a.action) && !a.list && Date.now() - W.lastPollAt > 300 && process.env.NEXUS_BROWSER_DESKTOP_WATCH_PREPOLL !== '0')
        await pollSerial().catch(() => { /* reported in watch status */ });
      const seqAtStart = evSeq;
      const stale = /^(grab|press|set_value)$/.test(a.action) && a.ref ? staleNote('ax') : /^guest_(grab|press|set_value)$/.test(a.action) ? staleNote('guest') : null;
      const decorate = async (r: { content: any[]; isError?: boolean }) => {
        if (W.on && !READ_ONLY_ACTIONS.test(a.action) && !a.list) await pollSerial().catch(() => { /* reported in watch status */ });
        const extra = [stale, a.action === 'context' || a.action === 'watch' ? null : eventTrailer(seqAtStart)].filter(Boolean);
        if (extra.length) r.content = [...r.content, { type: 'text', text: extra.join('\n') }];
        return r;
      };
      try {
        const r = await act(a);
        if (a.action !== 'stats') audit({ ...base(), ok: !r.isError });
        return await decorate(r);
      } catch (e: any) {
        const m = String(e?.message ?? e);
        audit({ ...base(), ok: false, err_class: errClass(m), error: m.slice(0, 300) });
        return await decorate({ content: [{ type: 'text', text: `desktop ${a.action} failed: ${e?.message ?? e}` }], isError: true });
      }
    },
  };
}

const DESCRIPTION = `KEYBOARD FIRST (standing rule): on any program you have not driven before, FIRST build its keyboard/shortcut schema — menu {list:true} (every menu item with its shortcut, macOS), hotkey {list:true}, on Windows the Alt-letter menus and underlined accelerators (Alt, then the letters; F10; Shift+F10 context menu), and the app's own shortcut list (Help / Keyboard Shortcuts / its docs) — then drive it by keys, run scripts and macros. Mouse clicks are the LAST resort (no key path exists) or for gates that need human-like movement.
See and drive the WHOLE screen with mouse and keyboard (not just a browser page). Use when a task needs other apps (Disk Utility, Terminal, Finder, installers, system dialogs). Take a screenshot first; coordinates are pixels IN THAT SCREENSHOT at the size "info" reports (info.screenshot) — if your viewer shows the image downscaled, scale your coordinates back up first (0.2.3 field trap: a 640-wide render of a 1280-wide shot put a click in the wrong menu).
FASTEST PATH (keyboard first) — always try in this order, clicks LAST: (1) a native shortcut: hotkey {name} (hotkey {list:true} = the catalog: spotlight, go_to_folder (works in every Open/Save dialog: type a path + Return), help_search (runs ANY menu item by typing its name + Return), save_as, app_switcher, menu_bar …; platform:"win" for a Windows VM) or key {text}; (2) a menu item BY NAME: menu {path:"File > Export > History", app?} (menu {list:true, top?} shows every item WITH its existing shortcut — macOS); (3) for a menu item you will use repeatedly that has no shortcut: shortcut {op:"set", app, menu_item, keys:"cmd+opt+e"} creates a real macOS App Shortcut (the app must be quit + reopened; op:"remove" undoes it); (4) a whole multi-step task in ONE call: run {script} — one command per line: hotkey NAME · key COMBO… · type TEXT · paste TEXT · fill X,Y [commit=tab|enter|none] [delay=MS] [escape] [paste] -- TEXT · click|dclick|tclick|rclick X,Y · move X,Y · drag X1,Y1 X2,Y2 · scroll X,Y DIR [N] · menu A > B [@App] · shortcut App | Item | keys · launch APP · focus WINDOW · wait SECONDS (1–2, never milliseconds) · wait_window REGEX [S] · zoom X1,Y1,X2,Y2 · screenshot · set NAME VALUE · macro NAME [k=v…] · # comment; \${name} = a variable; stops at the first failing line and says which; save a working sequence with macro {op:"save", name, script, description} and replay it with run {macro, vars} — macros are your own created shortcuts (macro {op:"list"}) — CHECK a new or long script FIRST with run {script, validate:true} (or macro {op:"validate", name}): nothing runs, every line is checked (vars, hotkey names, key combos, live menu paths, nested macros, allow-list, coordinates) and errors come back with line numbers + suggestions; (5) only then single clicks.
CONTEXT + EVENTS (0.6): context = one compact header (front app + window + focused element, every window, the Windows guest's front window and focus when its helper runs, scan freshness, watch state, recent events, safety) — call it FIRST and whenever you are unsure what is on screen; it is far cheaper than a screenshot. watch {op:"start", paths?, interval_ms?, guest?} then streams events (app_activated, window_opened [dialog], window_closed, window_focused, window_retitled, focus_changed, value_changed as a character COUNT only, app_launched/quit, file_created/changed/removed in watched folders, guest:… for the VM) and EVERY later desktop result ends with the events you have not seen, split into "during this action" (its effects: the dialog that opened, the window that closed) and "since your last call" (things that happened on their own: a download landing, an alert). React to events instead of re-screenshotting; watch {op:"events"} lists them, watch {op:"status"} shows poll cost. Acting on a ref whose window has since closed or been retitled returns a WARNING — rescan. Events are also appended to desktop-events.jsonl in the home folder.
BUS (0.8): bus {op:"start", key_file, host?, titles?} forwards watch events + the front-window snapshot to the user's own Nexus Terminal (CORTEX sees them as DESKTOP:<host> events and a "Remote desktops" line) through the inbound relay with the user's nrl_ key — one-way, nothing drives this machine back. bus {op:"status"} shows whether the SPA claimed the first batch. Needs the SPA open and signed in.
APP PROFILES (0.7): an app profile is the operating manual + keyboard schema for ONE application (contexts, shortcuts with verified flags, named macros). When the app in front has a profile, context says so and lists the keys valid in the current context. app {op:"list"} · app {op:"show", name} (read it BEFORE driving the app) · app {op:"run", name, id, vars?} runs a shortcut or macro by id · after an UNVERIFIED one works, app {op:"verify", name, id}; when something differs, app {op:"note", name, text} — the profile is how the next agent drives the app faster. Profiles are JSON files in the apps folder of the home (app {op:"save", profile_json} writes one).
PERCEPTION (macOS apps — nexus-sense scan/grab parity): scan {app?, window?, filter?: {role?, hasText?, interactive?}, depth?, max?} (cost grows with the element count — on macOS 11 about 0.15–0.25 s per element; big windows: pass window + depth 3–5 + a filter up front) lists the window's accessibility elements as refs e1…eN with role, title, value and screenshot-px center — read text and find controls WITHOUT screenshots; grab {ref | coordinate} returns one element's full details (complete value text, enabled, children); press {ref} activates it via AXPress (works even when covered; falls back to a center click); set_value {ref, text} writes a text field directly and verifies by reading it back (no typing, no dropped keys); clicks also take ref. Prefer scan → press/set_value over screenshot → coordinates. INSIDE A WINDOWS VM (macOS accessibility cannot see guest controls): guest_scan {window?, filter?} / guest_grab {ref} / guest_press {ref} / guest_set_value {ref, text} / guest_windows / guest_focus {window} / guest_ping talk to the in-guest helper (guest/nexus-guest-uia.ps1, Windows UI Automation, started once inside the VM; refs g1…gN; positions are GUEST pixels — on a Retina host they can be 2× the host screenshot pixels, so prefer guest_press/guest_set_value, which need no coordinates). Some apps draw custom widgets with no UI Automation controls (FXCM Trading Station: guest_scan shows only anonymous panes) — drive those by screenshot + keyboard/macros; the helper shines on native dialogs (Run, Save As, Explorer). On Windows 7 guests many controls are MSAA-bridged: role shows as Pane (the row then shows the class, e.g. Pane[Edit]; filter {interactive:true} matches by class too) and they expose NO UI Automation patterns — so guest PERCEPTION = names / classes / automation ids, guest ACTION = keyboard (focus the window, Tab / Alt+letter / accelerators, type) rather than guest_press/guest_set_value. Refs (e… and g…) survive a restart: the last scan of each kind is kept in the session home. Without the helper there: screenshot/zoom + keyboard/macros.
Actions (Anthropic computer-use names): screenshot · info · left_click/right_click/middle_click/double_click/triple_click {coordinate} · mouse_move {coordinate} · left_click_drag {start_coordinate, coordinate} · scroll {coordinate?, scroll_direction, scroll_amount} (with a coordinate it scrolls the PANE UNDER THAT POINT — grids, lists, side panels) · fill_field {coordinate, text, select?, escape_first?, commit_key?, type_via?, char_delay_ms?} — PREFERRED for any input box, ONE call: click + select + type + commit, returns a zoom of the field. DATE/TIME FIELDS: never page through a calendar — fill_field on the field's text with the date in the format the field displays (escape_first:true if a calendar pops up, char_delay_ms 40–60, commit_key "Tab"; segmented pickers advance on '/' or Right) · type {text, type_via?: "paste", char_delay_ms?} (if characters drop or garble — VMs, remote desktops, legacy apps — use type_via:"paste", or char_delay_ms 40–80) · key {text: "Return" | "cmd+space" | "ctrl+shift+t", space-separated for a sequence} · cursor_position · wait {duration s} · zoom {region [x1,y1,x2,y2]} (read small text) · launch {app} (allow-listed) · windows (list) · focus_window {window} · stats {since_min?} (per-action counts, errors, p50/p95 ms from the audit log — attach to feedback).
Mutating actions return a fresh screenshot (screenshot:false to skip). Known limits: in Parallels Coherence the guest's windows are not listed by "windows" — drive them by screenshot; a click can surface a background window (pass report_front:true to see which app is in front). Use ONE persistent home for a whole session — the failsafe stop file and the audit log (stats) live there. The operator can stop you at any time (failsafe spot — see info); if an action says STOPPED or FAILSAFE, stop and report.`;

/** Register `desktop` on the local MCP server when NEXUS_BROWSER_DESKTOP is virtual|real. Returns the controller or null. */
export function registerDesktopTool(server: any, home: string) {
  const mode = desktopMode(); if (!mode) return null;
  const d = createDesktop({ mode, home });
  const coord = z.array(z.number()).describe('[x, y] in screenshot pixels');
  server.tool('desktop', DESCRIPTION, {
    action: z.enum(['screenshot', 'info', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'mouse_move', 'left_click_drag',
      'scroll', 'type', 'key', 'cursor_position', 'wait', 'zoom', 'launch', 'windows', 'focus_window', 'stats', 'fill_field',
      'hotkey', 'menu', 'shortcut', 'run', 'macro', 'scan', 'grab', 'press', 'set_value',
      'guest_ping', 'guest_windows', 'guest_scan', 'guest_grab', 'guest_press', 'guest_set_value', 'guest_focus', 'context', 'watch', 'app', 'bus']),
    ref: z.string().optional().describe('scan ref like "e12" — for grab / press / set_value / clicks'),
    filter: z.object({ role: z.string().optional(), hasText: z.string().optional(), interactive: z.boolean().optional() }).optional().describe('scan: role (e.g. "Button", "TextField"), hasText (title/description/value contains), interactive'),
    max: z.number().int().min(10).max(2000).optional().describe('scan: max elements walked (default 250)'),
    depth: z.number().int().min(1).max(40).optional().describe('scan: max tree depth (default 12)'),
    limit: z.number().int().min(1).max(1000).optional().describe('scan: max matches printed (default 120)'),
    include_hidden: z.boolean().optional().describe('scan: also list zero-size elements'),
    budget_ms: z.number().int().min(5000).max(110000).optional().describe('scan (macOS): stop walking after this long and return what was found, marked PARTIAL (default 90000)'),
    name: z.string().optional().describe('hotkey: the shortcut intent (hotkey list:true shows them); macro: the macro name; app: the profile id'),
    list: z.boolean().optional().describe('hotkey / menu: list instead of run (menu list = the app\'s menus WITH their existing shortcuts)'),
    platform: z.enum(['mac', 'win']).optional().describe('hotkey: which binding set (default: the host; use "win" inside a Windows VM)'),
    top: z.string().optional().describe('menu list: only this top-level menu (faster), e.g. "File"'),
    include_recent: z.boolean().optional().describe('menu list: also list Open Recent / Recent Items (personal file names; slow) — default hidden'),
    path: z.union([z.array(z.string()), z.string()]).optional().describe('menu: ["File","Export","History"] or "File > Export > History"'),
    op: z.enum(['set', 'list', 'remove', 'save', 'show', 'delete', 'validate', 'start', 'stop', 'status', 'events', 'run', 'verify', 'note', 'flush']).optional().describe('shortcut: set|list|remove; macro: save|list|show|delete|validate; watch: start|stop|status|events; app: list|show|run|verify|note|save; bus: start|stop|status|flush'),
    key_file: z.string().optional().describe('bus start: path to a 0600 file holding the user\'s nrl_ relay key (allowed_tools must include desktop_events)'),
    url: z.string().optional().describe('bus start: relay base URL (default https://relay.spitfire-products.com)'),
    host: z.string().optional().describe('bus start: this machine\'s name in the SPA (default: hostname)'),
    titles: z.boolean().optional().describe('bus start: false = send window titles/paths as hidden (privacy); default true'),
    detach: z.boolean().optional().describe('bus start: default true = run as a detached daemon that outlives this process; false = inside this process'),
    id: z.string().optional().describe('app run/verify: the shortcut or macro id from app show'),
    context: z.string().optional().describe('app show: only this context\'s shortcuts'),
    profile_json: z.string().optional().describe('app save: the whole profile as a JSON string {id, name, match, contexts?, manual?, shortcuts?, macros?}'),
    interval_ms: z.number().int().min(500).max(60000).optional().describe('watch start: poll interval (default 1500 macOS, 1000 X11)'),
    paths: z.array(z.string()).optional().describe('watch start: folders (or files) to watch for created/changed/removed files, e.g. an exports folder'),
    guest: z.boolean().optional().describe('watch start: also poll the Windows guest helper (default: whenever its heartbeat is live)'),
    since_seq: z.number().int().min(0).optional().describe('watch events: list events after this sequence number (default: the ones not yet shown)'),
    types: z.array(z.string()).optional().describe('watch events: only these types (app_activated, window_opened, window_closed, window_focused, window_retitled, focus_changed, value_changed, app_launched, app_quit, file_created, file_changed, file_removed, guest_helper_up/down)'),
    recent: z.number().int().min(0).max(50).optional().describe('context: how many recent events to include (default 6)'),
    menu_item: z.union([z.string(), z.array(z.string())]).optional().describe('shortcut: the menu item title, or a path array to pin a submenu item'),
    keys: z.string().optional().describe('shortcut set: the combo to assign, e.g. "cmd+opt+e" (needs cmd or ctrl)'),
    script: z.string().optional().describe('run / macro save: desktop script, one command per line (see the tool description)'),
    macro: z.string().optional().describe('run: name of a saved macro to run'),
    validate: z.boolean().optional().describe('run: true = CHECK the script/macro (syntax, vars, hotkey names, key combos, live menu paths, nested macros, allow-list, coordinates) and run NOTHING; returns line-numbered errors + suggestions'),
    live_menus: z.boolean().optional().describe('run validate / macro validate: false = skip reading the app\'s live menu tree (macOS)'),
    vars: z.record(z.string(), z.string()).optional().describe('run: variables for ${name} in the script/macro'),
    description: z.string().optional().describe('macro save: what it does (shown by macro list)'),
    select: z.enum(['triple_click', 'double_click', 'select_all', 'none']).optional().describe('fill_field: how to select the existing value (default triple_click; select_all = click + select-all key)'),
    select_all_key: z.string().optional().describe('fill_field: select-all combo (default cmd+a on macOS, ctrl+a elsewhere)'),
    escape_first: z.boolean().optional().describe('fill_field: press Escape after clicking (closes a calendar/dropdown popup), then select-all'),
    commit_key: z.string().optional().describe('fill_field: key to commit after typing, e.g. "Tab" or "Return"; omit or "none" = leave the value uncommitted'),
    type_via: z.enum(['keys', 'paste']).optional().describe('type: "paste" = clipboard + paste key (most reliable into VMs / remote desktops / legacy apps; clipboard restored); default keys'),
    char_delay_ms: z.number().int().min(0).max(500).optional().describe('type via keys: pause between characters (try 40–80 when characters drop)'),
    paste_key: z.string().optional().describe('type via paste: the paste combo (default cmd+v; a Windows VM in Coherence usually maps cmd+v → ctrl+v)'),
    log_path: z.string().optional().describe('stats: read this audit log instead of this home\'s (aggregate a session that used another home)'),
    guest_keys: z.enum(['auto', 'host']).optional().describe('key / fill_field (macOS): auto (default) sends ctrl in place of cmd when the front app is a VM (Parallels) — Windows guests read cmd as the Win key; host = always send cmd'),
    report_front: z.boolean().optional().describe('clicks (macOS): also report the frontmost app afterwards — detects focus theft by a background window'),
    since_min: z.number().min(1).optional().describe('stats: only the last N minutes of the audit log (default: all)'),
    coordinate: coord.optional(),
    start_coordinate: coord.optional(),
    text: z.string().optional().describe('type: the text; key: the key or combo'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    scroll_amount: z.number().int().min(1).max(30).optional(),
    duration: z.number().min(0).max(30).optional(),
    region: z.union([z.array(z.number()), z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }), z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() })]).optional().describe('zoom: [x1, y1, x2, y2] or {x, y, width, height} in screenshot pixels'),
    zoom_factor: z.number().min(1).max(4).optional(),
    app: z.string().optional().describe('launch: app to open (allow-listed); focus_window: app name (alias of window)'),
    window: z.string().optional(),
    screenshot: z.boolean().optional().describe('return a screenshot after a mutating action (default true)'),
    settle_ms: z.number().int().min(0).max(5000).optional(),
  }, async (args: any) => d.handle(args));
  process.stderr.write(`[nexus-browser] desktop tool ON (${mode}, ${d.backend.name}); stop file ${d.stopFile}\n`);
  return d;
}
