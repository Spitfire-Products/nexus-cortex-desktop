// desktop-mac-selftest.mjs — run ON A MAC to verify the `desktop` tool's macOS backend against the real screen (TextEdit only).
// Usage: node desktop-mac-selftest.mjs [path-to-installed-package-dist]   (default: global npm root/@nexus-cortex/browser/dist)
// Needs: the app running this (Terminal/iTerm) granted Screen Recording + Accessibility. Prints one JSON report; screenshots → ./desktop-selftest/.
// Touches only: a new TextEdit document (typed text "nexus desktop selftest"), the cursor, and a stop-file failsafe check.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const groot = execSync('npm root -g').toString().trim();   // 0.9.0 split: the desktop tool lives in @nexus-cortex/desktop (browser = fallback for old installs)
const dist = process.argv[2] ?? [path.join(groot, '@nexus-cortex', 'desktop', 'dist'), path.join(groot, '@nexus-cortex', 'browser', 'dist')].find(p => fs.existsSync(path.join(p, 'desktop.js')));
const { createDesktop } = await import(path.join(dist, 'desktop.js'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-selftest-'));
const out = path.resolve('desktop-selftest'); fs.mkdirSync(out, { recursive: true });
const d = createDesktop({ mode: 'real', home, apps: ['TextEdit'] });
// the test copies text to check typing; save the operator's clipboard and put it back at the end (never print it — 0.2.1 report)
let savedClip = null; try { savedClip = execSync('pbpaste'); } catch { /* empty */ }
const restoreClip = () => { try { if (savedClip !== null) execSync('pbcopy', { input: savedClip }); } catch { /* best effort */ } };
process.on('exit', restoreClip);
const report = { version: JSON.parse(fs.readFileSync(path.join(dist, '..', 'package.json'), 'utf8')).version, cliclick: (() => { try { return execSync('command -v cliclick').toString().trim(); } catch { return null; } })(), macos: execSync('sw_vers -productVersion').toString().trim(), node: process.version, backend: d.backend.name, steps: [] };
const save = (name, r) => { const im = r.content?.find(c => c.type === 'image'); if (im) fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(im.data, 'base64')); };
async function step(name, args, check = r => !r.isError) {
  const t0 = Date.now(); let r, ok = false, note = '';
  try { r = await d.handle(args); ok = !!check(r); note = (r.content?.find(c => c.type === 'text')?.text ?? '').slice(0, 300); save(name, r); }
  catch (e) { note = String(e?.message ?? e).slice(0, 300); }
  report.steps.push({ name, ok, ms: Date.now() - t0, note }); console.error(`${ok ? 'PASS' : 'FAIL'} ${name} — ${note.slice(0, 120)}`);
  return r;
}
// 0.2.1: never crash on a failed step — every failure lands in the JSON report (the 0.2.0 run died parsing an error string)
let info = null; try { const r = await step('info', { action: 'info' }); info = r && !r.isError ? JSON.parse(r.content[0].text) : null; } catch { /* reported */ }
report.info = info;
if (!info) { report.passed = report.steps.filter(s => s.ok).length; report.total = report.steps.length; console.log(JSON.stringify(report, null, 1)); console.error('info failed — nothing else can run; see report'); process.exit(1); }
const [W, H] = info.screenshot;
await step('screenshot', { action: 'screenshot' }, r => r.content?.some(c => c.type === 'image'));
await step('mouse_move center', { action: 'mouse_move', coordinate: [Math.round(W / 2), Math.round(H / 2)], screenshot: false });
await step('cursor_position round-trip', { action: 'cursor_position' }, r => { if (r.isError) return false; const c = JSON.parse(r.content[0].text); return Math.abs(c.x - W / 2) <= 2 && Math.abs(c.y - H / 2) <= 2; });
await step('launch TextEdit', { action: 'launch', app: 'TextEdit', settle_ms: 2500 });
await step('new document (cmd+n)', { action: 'key', text: 'cmd+n', settle_ms: 1500 });
await step('type', { action: 'type', text: 'nexus desktop selftest', settle_ms: 800 });
await step('select all + copy (cmd+a cmd+c)', { action: 'key', text: 'cmd+a cmd+c', screenshot: false });
{ let clip = ''; try { clip = execSync('pbpaste').toString(); } catch { /* none */ } const hit = clip.includes('nexus desktop selftest');
  report.steps.push({ name: 'typed text reached TextEdit (clipboard)', ok: hit, ms: 0, note: hit ? 'clipboard holds the typed text' : `clipboard does not hold it (${clip.length} chars, content not shown)` }); }
// never put window titles in the report (0.2.2 run listed private document names) — count + TextEdit presence only
{ const t0 = Date.now(); let ok = false, note = '';
  try { const r = await d.handle({ action: 'windows' }); const t = r.content?.[0]?.text ?? ''; ok = !r.isError && /TextEdit/.test(t); note = r.isError ? t.slice(0, 200) : `${t.split('\n').filter(Boolean).length} windows listed; TextEdit ${/TextEdit/.test(t) ? 'present' : 'absent'} (titles not shown)`; }
  catch (e) { note = String(e?.message ?? e).slice(0, 200); }
  report.steps.push({ name: 'windows', ok, ms: Date.now() - t0, note }); console.error(`${ok ? 'PASS' : 'FAIL'} windows — ${note}`); }
await step('zoom', { action: 'zoom', region: [0, 0, Math.round(W / 4), Math.round(H / 4)] }, r => r.content?.some(c => c.type === 'image'));
await step('double_click center', { action: 'double_click', coordinate: [Math.round(W / 2), Math.round(H / 2)], settle_ms: 500 });
await step('right_click + Escape', { action: 'right_click', coordinate: [Math.round(W / 2), Math.round(H / 2)], settle_ms: 500 });
await step('Escape', { action: 'key', text: 'Escape', screenshot: false });
await step('scroll down', { action: 'scroll', coordinate: [Math.round(W / 2), Math.round(H / 2)], scroll_direction: 'down', scroll_amount: 3, screenshot: false });
await step('drag', { action: 'left_click_drag', start_coordinate: [Math.round(W / 2) - 40, Math.round(H / 2)], coordinate: [Math.round(W / 2) + 40, Math.round(H / 2)], screenshot: false });
// ── 0.3: native hotkeys, menus by name, App Shortcuts, scripts + macros (TextEdit only; every change is undone) ──
await step('hotkey list (mac catalog)', { action: 'hotkey', list: true }, r => !r.isError && /go_to_folder\tcmd\+shift\+g/.test(r.content[0].text));
// Edit menu: no personal content (File > Open Recent lists the operator's file names — 0.3.0 report); shortcuts are lowercase since 0.3.1
await step('menu list (TextEdit, Edit menu only)', { action: 'menu', list: true, app: 'TextEdit', top: 'Edit' }, r => !r.isError && /Edit > Copy\tcmd\+c/i.test(r.content[0].text));
await step('menu invoke File > New (by name)', { action: 'menu', path: 'File > New', app: 'TextEdit', settle_ms: 800 });
await step('run script: one call types into the new doc', { action: 'run', script: 'type desktop 0.3 script\nkey cmd+a', screenshot: false }, r => !r.isError && /script ok/.test(r.content[0].text));
await step('shortcut set (TextEdit Format > Make Plain Text = cmd+opt+ctrl+p)', { action: 'shortcut', op: 'set', app: 'TextEdit', menu_item: 'Make Plain Text', keys: 'cmd+opt+ctrl+p' }, r => !r.isError && /created/.test(r.content[0].text));
await step('shortcut list shows it', { action: 'shortcut', op: 'list', app: 'TextEdit' }, r => !r.isError && /Make Plain Text/.test(r.content[0].text));
await step('shortcut remove (undo)', { action: 'shortcut', op: 'remove', app: 'TextEdit', menu_item: 'Make Plain Text' }, r => !r.isError && /removed/.test(r.content[0].text));
await step('macro save', { action: 'macro', op: 'save', name: 'selftest_macro', description: 'selftest', script: 'key cmd+a\ntype ${word}' }, r => !r.isError);
await step('run macro with vars', { action: 'run', macro: 'selftest_macro', vars: { word: 'macro-ok' }, screenshot: false }, r => !r.isError && /script ok/.test(r.content[0].text));
await step('macro delete', { action: 'macro', op: 'delete', name: 'selftest_macro' }, r => !r.isError);
// ── 0.4: perception parity (accessibility scan / grab / press / set_value) — TextEdit only ──
await step('scan TextEdit window', { action: 'scan', app: 'TextEdit' }, r => !r.isError && /accessibility scan — TextEdit/.test(r.content[0].text) && /\te\d+|^e\d+\t/m.test(r.content[0].text));
{ const t0 = Date.now(); let ok = false, note = '';
  try { const r = await d.handle({ action: 'scan', app: 'TextEdit', filter: { role: 'TextArea' } }); const m = /^(e\d+)\t/m.exec(r.content[0].text);
    if (m) { const sv = await d.handle({ action: 'set_value', ref: m[1], text: 'set by accessibility' }); const gb = await d.handle({ action: 'grab', ref: m[1] });
      ok = !sv.isError && JSON.parse(gb.content[0].text).value === 'set by accessibility'; note = `${m[1]}: set_value ${sv.isError ? 'FAILED' : 'ok'}, grab read back ${ok ? 'matches' : 'differs'}`; }
    else note = 'no TextArea in scan'; } catch (e) { note = String(e?.message ?? e).slice(0, 200); }
  report.steps.push({ name: 'set_value + grab on the document text area', ok, ms: Date.now() - t0, note }); console.error(`${ok ? 'PASS' : 'FAIL'} set_value + grab — ${note}`); }
{ const t0 = Date.now(); let ok = false, note = '';
  try { const r = await d.handle({ action: 'scan', app: 'TextEdit', filter: { interactive: true } }); const n = (r.content[0].text.match(/^e\d+\t/gm) || []).length;
    ok = !r.isError && n > 0; note = `${n} interactive elements; scan took ${Date.now() - t0} ms`; } catch (e) { note = String(e?.message ?? e).slice(0, 200); }
  report.steps.push({ name: 'scan interactive (speed)', ok, ms: Date.now() - t0, note }); console.error(`${ok ? 'PASS' : 'FAIL'} scan interactive — ${note}`); }
// ── 0.6: context + watch (notes carry event TYPES, counts and timings only — never window titles or values) ──
async function quiet(name, fn) { const t0 = Date.now(); let ok = false, note = '';
  try { [ok, note] = await fn(); } catch (e) { note = String(e?.message ?? e).slice(0, 200); }
  report.steps.push({ name, ok, ms: Date.now() - t0, note }); console.error(`${ok ? 'PASS' : 'FAIL'} ${name} — ${note}`); }
const evTypes = r => (r.content ?? []).map(c => c.text ?? '').join('\n').split('\n').map(l => /^\s+#\d+ \S+ (?:guest:)?(\w+)/.exec(l)?.[1]).filter(Boolean);
await quiet('context (one call, header)', async () => { const t0 = Date.now(); const r = await d.handle({ action: 'context' }); const t = r.content[0].text;
  return [!r.isError && /^front: TextEdit/m.test(t) && /^windows \(\d+/m.test(t) && /^watch: off/m.test(t), `${t.split('\n').length} lines, ${Date.now() - t0} ms, front=TextEdit ${/^front: TextEdit/m.test(t)}`]; });
await quiet('watch start (1500 ms)', async () => { const r = await d.handle({ action: 'watch', op: 'start', interval_ms: 1500 }); return [!r.isError && /watching/.test(r.content[0].text), r.isError ? r.content[0].text.slice(0, 160) : 'on']; });
await quiet('event: cmd+n window_opened DURING the action', async () => { const r = await d.handle({ action: 'key', text: 'cmd+n', screenshot: false, settle_ms: 800 });
  const all = (r.content ?? []).map(c => c.text ?? '').join('\n'); const during = all.split('during this action:')[1] ?? '';
  return [/window_opened TextEdit/.test(during), `types: ${evTypes(r).join(',') || '(none)'}`]; });
await quiet('event: typing = value_changed (count only)', async () => { const r = await d.handle({ action: 'type', text: 'watch-ok', screenshot: false });
  const all = (r.content ?? []).map(c => c.text ?? '').join('\n'); return [/value_changed TextEdit .* -> \d+ chars/.test(all) && !/watch-ok/.test(all.split('desktop events')[1] ?? ''), `types: ${evTypes(r).join(',') || '(none)'}`]; });
await quiet('event: switch to Finder and back = app_activated', async () => { await d.handle({ action: 'focus_window', app: 'Finder', screenshot: false, settle_ms: 600 });
  const r = await d.handle({ action: 'focus_window', app: 'TextEdit', screenshot: false, settle_ms: 600 }); return [evTypes(r).includes('app_activated'), `types: ${evTypes(r).join(',')}`]; });
await quiet('watch status (poll cost on this Mac)', async () => { const s = JSON.parse((await d.handle({ action: 'watch', op: 'status' })).content[0].text);
  report.watch = { polls: s.polls, poll_p50_ms: s.poll_p50_ms, poll_p95_ms: s.poll_p95_ms, errors: s.errors, events: s.events_total, last_error: s.last_error };
  return [s.on && s.polls > 0 && s.errors === 0, `polls ${s.polls}, p50 ${s.poll_p50_ms} ms, p95 ${s.poll_p95_ms} ms, errors ${s.errors}, events ${s.events_total}`]; });
await quiet('watch stop', async () => { const r = await d.handle({ action: 'watch', op: 'stop' }); return [/watch stopped/.test(r.content[0].text), 'off']; });
await step('launch allow-list refuses Calculator', { action: 'launch', app: 'Calculator', screenshot: false }, r => r.isError && /allow-list/.test(r.content[0].text));
// failsafe: park the cursor in the failsafe corner `info` reports (never a Hot Corner), then any mutating action must refuse
const fc = info.failsafe_corner_px ?? [0, 0];
await step(`park cursor on failsafe spot ${info.failsafe_corner} [${fc}]`, { action: 'mouse_move', coordinate: fc, screenshot: false });
await step('failsafe refuses + writes stop file', { action: 'key', text: 'Escape', screenshot: false }, r => r.isError && /FAILSAFE/.test(r.content[0].text) && fs.existsSync(d.stopFile));
// 0.10.1 LATCH (D7 T5): deleting the stop file does NOT resume this process; only a restart does
try { fs.unlinkSync(d.stopFile); } catch { /* none */ }
await step('latched: stop holds after the stop file is deleted', { action: 'mouse_move', coordinate: [Math.round(W / 2), Math.round(H / 2)], screenshot: false },
  r => r.isError && /STOPPED by the user/.test(r.content[0].text));
// the user's resume: move the cursor off the spot themselves (cliclick, outside the tool) + restart (= a fresh instance on the same home)
try { execSync(`cliclick m:${Math.round(W / 2)},${Math.round(H / 2)}`); } catch { /* cliclick missing: the fresh instance below will trip and the step fails */ }
try { fs.unlinkSync(d.stopFile); } catch { /* none */ }
const d2 = createDesktop({ mode: 'real', home, apps: ['TextEdit'] });
{ const t0 = Date.now(); const r = await d2.handle({ action: 'mouse_move', coordinate: [Math.round(W / 2) + 20, Math.round(H / 2)], screenshot: false });
  report.steps.push({ name: 'resume = delete + move off + restart (fresh instance)', ok: !r.isError, ms: Date.now() - t0, note: r.isError ? String(r.content?.[0]?.text ?? '').slice(0, 160) : 'resumed' }); console.error(`${r.isError ? 'FAIL' : 'PASS'} resume = delete + move off + restart`); }
report.passed = report.steps.filter(s => s.ok).length; report.total = report.steps.length;
console.log(JSON.stringify(report, null, 1));
console.error(`\n${report.passed}/${report.total} passed — screenshots in ${out} (check screenshot.png shows WINDOWS, not just wallpaper = Screen Recording granted). Close the TextEdit doc without saving.`);
