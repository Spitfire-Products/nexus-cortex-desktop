// test/desktop.mjs — the `desktop` tool (src/desktop.ts). Pure checks always; the X11 drive test runs on a PRIVATE Xvfb display when
// Xvfb + xdotool + ImageMagick `import` are on PATH (never touches the user's screen). macOS is verified on a Mac (see README §Desktop).
// Run: node test/desktop.mjs   (after npm run build)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCombo, macKeyScript, xdoKey, asLiteral, createDesktop, x11Backend, fixMojibake, normRegion } from '../dist/desktop.js';
import { hotkeyFor, hotkeyCatalog, comboToKeyEquivalent, keyEquivalentTitle, parseKeyEquivalents, parseLine, substitute, validateScript, parseMenuList, closest } from '../dist/desktop-script.js';

let fail = 0; const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fail++; };
const onPath = b => (process.env.PATH ?? '').split(':').some(d => { try { fs.accessSync(path.join(d, b), fs.constants.X_OK); return true; } catch { return false; } });

// ── source guard: no backtick inside the tool DESCRIPTION template literal (broke the 0.2.4 build; nearly 0.2.8) ──
{ const src = fs.readFileSync(new URL('../src/desktop.ts', import.meta.url), 'utf8'); const m = /const DESCRIPTION = `([\s\S]*?)`;\n/.exec(src);
  ok(m && !m[1].includes('`'), 'DESCRIPTION template literal contains no backticks');
  ok(m && !/(^|[^\\])\$\{/.test(m[1]), 'DESCRIPTION has no unescaped ${…} interpolation'); }
// ── 0.5.1 guards: the in-guest helper must be ASCII-only (PS 2.0 reads BOM-less scripts as ANSI) and must not use JavaScriptSerializer for OUTPUT ──
{ const ps = fs.readFileSync(new URL('../guest/nexus-guest-uia.ps1', import.meta.url), 'utf8');
  ok([...ps].every(c => c.charCodeAt(0) < 128), 'guest helper .ps1 is ASCII-only');
  ok(!/\.Serialize\(/.test(ps) && /function ToJson/.test(ps) && /psf\\Home/.test(ps), 'guest helper emits JSON by hand + defaults to \\\\psf\\Home'); }
// ── 0.5.3 guards: the helper enumerates real top-level HWNDs (Save As = owned #32770) + Win32 focus fallback; PS2-safe C# (no lambdas) ──
{ const ps = fs.readFileSync(new URL('../guest/nexus-guest-uia.ps1', import.meta.url), 'utf8');
  ok(/EnumWindows/.test(ps) && /SetForegroundWindow/.test(ps) && /FromHandle/.test(ps) && /NativeWindowHandle/.test(ps), 'guest helper: EnumWindows + FromHandle merge (dedupe by NativeWindowHandle) + SetForegroundWindow focus fallback');
  ok(!/ConvertTo-Json/.test(ps) && !/=>/.test(ps), 'guest helper: no ConvertTo-Json (PS 3+) and no C# lambdas (PS 2.0 Add-Type compiles C# 2.0)');
  const pkgV = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  ok(ps.includes(`$VERSION = '${pkgV}'`), `guest helper $VERSION matches package.json (${pkgV})`); }
// ── 0.5.3: the JXA_AX source (attribute batching) still parses as JavaScript (osascript is not available here) ──
{ const src = fs.readFileSync(new URL('../src/desktop.ts', import.meta.url), 'utf8'); const m = /const JXA_AX = `([\s\S]*?)`;\n/.exec(src);
  let jxa = null, perr = ''; try { jxa = new Function('return `' + m[1] + '`')(); new Function(jxa); } catch (e) { perr = e.message; }
  ok(m && jxa && !perr, `JXA_AX parses as JavaScript${perr ? ' — ' + perr : ''}`);
  ok(jxa && /uiElements\.role\(\)/.test(jxa) && /abatched/.test(jxa) && /properties\(\)/.test(jxa), 'JXA_AX: roles-first attribute batching + properties() fallback kept');
  const d = /const DESCRIPTION = `([\s\S]*?)`;\n/.exec(src); ok(d && /^KEYBOARD FIRST/.test(d[1]), 'DESCRIPTION opens with the KEYBOARD FIRST standing rule'); }
// ── pure ──
ok(JSON.stringify(parseCombo('cmd+shift+T')) === JSON.stringify({ mods: ['cmd', 'shift'], key: 'T' }), 'parseCombo cmd+shift+T');
ok(macKeyScript('Return') === 'tell application "System Events" to key code 36', 'mac Return → key code 36');
ok(macKeyScript('cmd+space') === 'tell application "System Events" to key code 49 using {command down}', 'mac cmd+space');
ok(macKeyScript('ctrl+a') === 'tell application "System Events" to keystroke "a" using {control down}', 'mac ctrl+a keystroke');
ok(macKeyScript('Page_Down') === 'tell application "System Events" to key code 121', 'mac Page_Down');
let threw = false; try { macKeyScript('NotAKey'); } catch { threw = true; } ok(threw, 'mac unknown named key throws');
ok(xdoKey('cmd+l') === 'super+l' && xdoKey('enter') === 'Return' && xdoKey('ctrl+shift+Tab') === 'ctrl+shift+Tab', 'xdotool key mapping');
ok(fixMojibake('Fixture Station â€” Login') === 'Fixture Station — Login' && fixMojibake('CafÃ© ok') === 'Café ok' && fixMojibake('plain — text') === 'plain — text' && fixMojibake('ASCII') === 'ASCII', 'X11 title mojibake repaired (and correct text untouched)');
ok(JSON.stringify(normRegion([1, 2, 3, 4])) === '[1,2,3,4]' && JSON.stringify(normRegion({ x: 10, y: 20, width: 30, height: 40 })) === '[10,20,40,60]' && JSON.stringify(normRegion({ x1: 1, y1: 2, x2: 3, y2: 4 })) === '[1,2,3,4]' && normRegion({ x: 1 }) === null, 'zoom region accepts array, {x,y,width,height}, {x1..y2}');
ok(asLiteral('say "hi" \\ ok\nline2') === '"say \\"hi\\" \\\\ ok" & return & "line2"', 'AppleScript literal escaping');

// ── 0.3 pure: hotkey catalog, App Shortcut encoding, script parser ──
ok(hotkeyFor('go_to_folder', 'mac') === 'cmd+shift+g' && hotkeyFor('run_dialog', 'win') === 'win+r' && /help_search/.test(hotkeyCatalog('mac')), 'hotkey catalog (mac + win)');
{ let t = false; try { hotkeyFor('go_to_folder', 'win'); } catch { t = true; } ok(t, 'hotkey with no binding on that platform throws'); }
ok(comboToKeyEquivalent('cmd+opt+e') === '@~e' && comboToKeyEquivalent('cmd+shift+F5') === '@$\uf708' && comboToKeyEquivalent('ctrl+Up') === '^\uf700', 'NSUserKeyEquivalents encoding');
{ let t = false; try { comboToKeyEquivalent('opt+e'); } catch { t = true; } ok(t, 'a shortcut without cmd/ctrl is refused'); }
ok(keyEquivalentTitle(['File', 'Export', 'History']) === '\u001bFile\u001bExport\u001bHistory' && keyEquivalentTitle('Save As…') === 'Save As…', 'submenu-pinned titles');
ok(JSON.stringify(parseKeyEquivalents('{\n    "Export to Excel\\U2026" = "@~e";\n    Zoom = "@^z";\n}')) === JSON.stringify({ 'Export to Excel…': '@~e', Zoom: '@^z' }), 'parse `defaults read` NSUserKeyEquivalents');
{ const f = parseLine('fill 320,114 commit=tab delay=50 escape -- 01/03/2024', 4);
  ok(f.kind === 'action' && f.action.action === 'fill_field' && f.action.commit_key === 'Tab' && f.action.char_delay_ms === 50 && f.action.escape_first === true && f.action.text === '01/03/2024', 'script: fill with options');
  const m = parseLine('menu File > Export to Excel > History @Trading Station', 5); ok(JSON.stringify(m.action.path) === '["File","Export to Excel","History"]' && m.action.app === 'Trading Station', 'script: menu path + @App');
  const sc = parseLine('shortcut TextEdit | Format > Make Plain Text | cmd+opt+p', 6); ok(sc.action.op === 'set' && JSON.stringify(sc.action.menu_item) === '["Format","Make Plain Text"]', 'script: shortcut');
  ok(parseLine('# comment', 7) === null && parseLine('   ', 8) === null, 'script: comments + blanks');
  ok(parseLine('type -- -- & "x"', 15).action.text === '-- & "x"' && parseLine('paste -- -flag', 16).action.text === '-flag', 'script: type/paste -- literal text');
  ok(parseLine('hotkey run_dialog platform=win', 13).action.platform === 'win' && !('platform' in parseLine('hotkey spotlight', 14).action), 'script: hotkey platform=win');
  ok(parseLine('type "a\\tb"', 9).action.text === 'a\tb' && parseLine('macro login user=bob pw="x y"', 10).vars.pw === 'x y', 'script: quoting + macro args');
  let t = false; try { parseLine('frobnicate 1', 11); } catch (e) { t = /line 11: unknown command/.test(e.message); } ok(t, 'script: unknown command names the line');
  let u = false; try { substitute('type ${nope}', {}, 12); } catch (e) { u = /line 12: variable/.test(e.message); } ok(u, 'script: unset variable names the line'); }

// ── a fake backend: scaling, guard, failsafe, audit ──
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
const calls = []; let cur = { x: 500, y: 500 };
const fake = { name: 'fake', size: async () => ({ w: 2560, h: 1600 }), capture: async (w, h) => Buffer.from(`png${w}x${h}`),
  move: async p => { calls.push(['move', p]); cur = p; }, click: async (p, b, n) => { calls.push(['click', p, b, n]); cur = p; }, drag: async (a, b) => { calls.push(['drag', a, b]); cur = b; },
  scroll: async (p, d, n) => calls.push(['scroll', p, d, n]), type: async t => calls.push(['type', t]), key: async k => calls.push(['key', k]),
  cursor: async () => cur, launch: async a => calls.push(['launch', a]), windows: async () => 'w', focus: async w => calls.push(['focus', w]) };
let d = createDesktop({ mode: 'real', home, backend: fake, maxWidth: 1280 });
let r = await d.handle({ action: 'info' }); const info = JSON.parse(r.content[0].text);
ok(info.version === JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, `info reports the RUNNING version (${info.version}) — 11-14: an agent installed 0.11.5 but its server still ran 0.11.4`);
ok(info.screenshot[0] === 1280 && info.screenshot[1] === 800 && info.scale === 2, `scale 2560×1600 → 1280×800, f=2 (${r.content[0].text.slice(0, 80)})`);
r = await d.handle({ action: 'left_click', coordinate: [100, 50], screenshot: false });
ok(JSON.stringify(calls.at(-1)) === JSON.stringify(['click', { x: 200, y: 100 }, 'left', 1]), 'click maps screenshot px → screen points ×2');
r = await d.handle({ action: 'double_click', coordinate: [10, 10], screenshot: false });
ok(calls.at(-1)[3] === 2, 'double_click count 2');
r = await d.handle({ action: 'left_click', coordinate: [5000, 10], screenshot: false });
ok(r.isError && /outside/.test(r.content[0].text), 'out-of-bounds coordinate rejected');
r = await d.handle({ action: 'left_click', coordinate: [100, 50] });
ok(r.content.some(c => c.type === 'image'), 'mutating action returns a screenshot by default');
r = await d.handle({ action: 'type', text: 'secret-pass', screenshot: false });
ok(!fs.readFileSync(d.logFile, 'utf8').includes('secret-pass') && /"chars":11/.test(fs.readFileSync(d.logFile, 'utf8')), 'audit log records typed LENGTH, never the text');
cur = { x: 0, y: 1 };
r = await d.handle({ action: 'left_click', coordinate: [100, 50], screenshot: false });
ok(r.isError && /FAILSAFE/.test(r.content[0].text) && fs.existsSync(d.stopFile), 'cursor parked top-left trips the failsafe + writes the stop file');
cur = { x: 500, y: 500 };
r = await d.handle({ action: 'key', text: 'Return', screenshot: false });
ok(r.isError && /STOPPED/.test(r.content[0].text), 'stop file halts every mutating action');
r = await d.handle({ action: 'screenshot' });
ok(!r.isError, 'read-only actions still work while stopped (screenshot)');
r = await d.handle({ action: 'key', text: 'a', screenshot: false });
ok(r.isError && !/[Dd]elete .*to resume/.test(r.content[0].text), 'refusal never tells the agent how to resume');
// 0.10.1 (macbook D7 T5): the agent deleted the stop file and moved the cursor off the spot → the stop must HOLD in this process
fs.unlinkSync(d.stopFile); cur = { x: 300, y: 300 };
r = await d.handle({ action: 'mouse_move', coordinate: [300, 300], screenshot: false });
ok(r.isError && /STOPPED by the user/.test(r.content[0].text) && /end this task/.test(r.content[0].text), 'LATCH: stop file deleted in-process → mouse_move still refused');
r = await d.handle({ action: 'type', text: 'more', screenshot: false });
ok(r.isError && /STOPPED/.test(r.content[0].text), 'LATCH: type still refused after the stop file vanished');
ok(/stop_file_removed_while_latched/.test(fs.readFileSync(d.logFile, 'utf8')), 'LATCH: the vanished stop file is audited');
d = createDesktop({ mode: 'real', home, backend: fake, maxWidth: 1280 });   // the user restarted the agent but left the cursor parked
cur = { x: 0, y: 1 };
r = await d.handle({ action: 'mouse_move', coordinate: [300, 300], screenshot: false });
ok(r.isError && /FAILSAFE/.test(r.content[0].text), 'a fresh process that starts with the cursor PARKED trips (the parked cursor is the stop signal)');
fs.unlinkSync(d.stopFile); d = createDesktop({ mode: 'real', home, backend: fake, maxWidth: 1280 }); cur = { x: 500, y: 500 };   // user: delete + move + restart
r = await d.handle({ action: 'mouse_move', coordinate: [300, 300], screenshot: false });
ok(!r.isError && !fs.existsSync(d.stopFile), 'resume = delete the stop file + move the cursor off + restart');
cur = { x: 1, y: 0 }; r = await d.handle({ action: 'key', text: 'a', screenshot: false });
ok(r.isError && /FAILSAFE/.test(r.content[0].text), 're-armed: arriving on the spot again trips');
fs.unlinkSync(d.stopFile); cur = { x: 500, y: 500 };
r = await d.handle({ action: 'key', text: 'Return', screenshot: false });
ok(r.isError && /STOPPED/.test(r.content[0].text), 'LATCH: a re-trip also holds after the file is deleted');
d = createDesktop({ mode: 'real', home, backend: fake, maxWidth: 1280 });
r = await d.handle({ action: 'key', text: 'Return', screenshot: false });
ok(!r.isError, 'deleting the stop file + restarting the agent resumes');
// 0.2.2: input that silently did nothing (cliclick without Accessibility) is an ERROR, not a false PASS
{ const dead = { ...fake, move: async () => {}, click: async () => {}, cursor: async () => ({ x: 7, y: 7 }) };
  const d3 = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk3-')), backend: dead, maxWidth: 1280 });
  let r3 = await d3.handle({ action: 'left_click', coordinate: [300, 300], screenshot: false });
  ok(r3.isError && /input was ignored/.test(r3.content[0].text), 'click whose cursor never arrived → error (no false positive)');
  const noAx = { ...fake, permissions: async () => ({ accessibility: false, screen_recording: false }) };
  const d4 = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk4-')), backend: noAx, maxWidth: 1280 });
  r3 = await d4.handle({ action: 'key', text: 'a', screenshot: false }); ok(r3.isError && /Accessibility is not granted/.test(r3.content[0].text), 'missing Accessibility refuses mutating actions up front');
  r3 = await d4.handle({ action: 'screenshot' }); ok(/Screen Recording is NOT granted/.test(r3.content[0].text), 'missing Screen Recording warns on screenshot');
  const i4 = JSON.parse((await d4.handle({ action: 'info' })).content[0].text); ok(i4.permissions.accessibility === false, 'info reports permissions');
  // failsafe 'top' (macOS default; all four corners can be Hot Corners): middle of the top edge
  const d5 = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk5-')), backend: { ...fake, hotCorners: async () => ['tl', 'tr', 'bl', 'br'] }, maxWidth: 1280, failsafe: 'top' });
  const i5 = JSON.parse((await d5.handle({ action: 'info' })).content[0].text);
  ok(i5.failsafe_corner === 'top' && i5.failsafe_corner_px[0] === 640 && i5.failsafe_corner_px[1] === 0, `failsafe top → [${i5.failsafe_corner_px}]`);
  cur = { x: 1280, y: 0 }; r3 = await d5.handle({ action: 'key', text: 'a', screenshot: false }); ok(r3.isError && /FAILSAFE.*top/.test(r3.content[0].text), 'cursor at top-edge middle trips the failsafe');
  cur = { x: 0, y: 0 }; const d6 = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk6-')), backend: { ...fake, hotCorners: async () => ['tl', 'tr', 'bl', 'br'] }, maxWidth: 1280 });
  const i6 = JSON.parse((await d6.handle({ action: 'info' })).content[0].text); ok(i6.failsafe_corner === 'top', `all four corners hot + corner requested → falls back to top (${i6.failsafe_corner})`);
  cur = { x: 500, y: 500 }; }
// 0.2.6 typing modes reach the backend (paste for VMs; per-character delay)
{ const seen = []; const tk = { ...fake, type: async (t, o) => seen.push(o) };
  const dt = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk7-')), backend: tk, maxWidth: 1280 });
  await dt.handle({ action: 'type', text: 'abc', type_via: 'paste', paste_key: 'cmd+v', screenshot: false });
  await dt.handle({ action: 'type', text: 'abc', char_delay_ms: 60, screenshot: false });
  ok(seen[0]?.via === 'paste' && seen[0]?.pasteKey === 'cmd+v' && seen[1]?.charDelayMs === 60, `type opts reach the backend ${JSON.stringify(seen)}`);
  ok(/"via":"paste"/.test(fs.readFileSync(dt.logFile, 'utf8')) && /"via":"keys\+60ms"/.test(fs.readFileSync(dt.logFile, 'utf8')), 'audit records the typing mode'); }
// 0.2.7 fill_field: one call = click(n) → [Escape → select-all] → type → commit, returns a field zoom (no full screenshot by default)
{ const seq = []; const fk = { ...fake, click: async (p, b, n) => { seq.push(`click${n}@${p.x},${p.y}`); cur = p; }, key: async k => seq.push(`key:${k}`), type: async (t, o) => seq.push(`type:${t.length}:${o?.charDelayMs ?? 0}`), capture: async (w, h) => Buffer.from(`z${w}x${h}`) };
  const df = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk8-')), backend: fk, maxWidth: 1280 });
  const r8 = await df.handle({ action: 'fill_field', coordinate: [200, 100], text: '01/02/2024', escape_first: true, char_delay_ms: 50, commit_key: 'Tab' });
  ok(!r8.isError && seq.join(' ') === 'click3@400,200 key:Escape key:ctrl+a type:10:50 key:Tab', `fill_field sequence ${seq.join(' ')}`);
  ok(r8.content.filter(c => c.type === 'image').length === 1 && /zoom of the field/.test(r8.content[0].text), 'fill_field returns ONE image (the field zoom), not a full screenshot');
  seq.length = 0; const rn = await df.handle({ action: 'fill_field', coordinate: [200, 100], text: 'x', commit_key: 'none' });
  ok(!rn.isError && !seq.some(k => /key:none/i.test(k)) && /no commit key/.test(rn.content[0].text), `commit_key "none" = no commit (${seq.join(' ')})`);
  cur = { x: 500, y: 500 }; }
// 0.2.8: stats can read another home's audit log; report_front on clicks
{ const st2 = JSON.parse((await d.handle({ action: 'stats', log_path: d.logFile })).content[0].text); ok(st2.log === d.logFile && st2.actions_total > 0, 'stats log_path reads a given audit log');
  const ff = { ...fake, frontApp: async () => 'Parallels Desktop' }; const dfr = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk9-')), backend: ff, maxWidth: 1280 });
  const rf = await dfr.handle({ action: 'left_click', coordinate: [100, 100], report_front: true, screenshot: false }); ok(/frontmost app: Parallels Desktop/.test(rf.content[0].text), 'report_front names the frontmost app');
  cur = { x: 500, y: 500 }; }
// 0.3 actions on the fake backend: hotkey, menu, shortcut, run (script), macro save/list/show/run/delete
{ const ev = []; const fk3 = { ...fake, key: async k => ev.push(`key:${k}`), type: async t => ev.push(`type:${t.length}`), click: async (p, b, n) => { ev.push(`click${n}@${p.x},${p.y}`); cur = p; },
    windows: async () => 'Fixture — Ready', menuInvoke: async (p, app) => { ev.push(`menu:${p.join('>')}@${app ?? ''}`); return `clicked ${p.join(' > ')}`; },
    shortcutSet: async (app, title, eq) => { ev.push(`sc:${app}:${title}:${eq}`); return 'com.example.app'; }, name: 'macos (fake)' };
  const d3 = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk10-')), backend: fk3, maxWidth: 1280 });
  let r = await d3.handle({ action: 'hotkey', name: 'go_to_folder', screenshot: false }); ok(!r.isError && ev.at(-1) === 'key:cmd+shift+g', `hotkey → native combo (${ev.at(-1)})`);
  r = await d3.handle({ action: 'hotkey', list: true }); ok(/go_to_folder\tcmd\+shift\+g/.test(r.content[0].text), 'hotkey list = the catalog');
  r = await d3.handle({ action: 'menu', path: 'File > Export to Excel > History', app: 'TS', screenshot: false }); ok(!r.isError && ev.at(-1) === 'menu:File>Export to Excel>History@TS', 'menu by path');
  r = await d3.handle({ action: 'shortcut', op: 'set', app: 'TextEdit', menu_item: 'Make Plain Text', keys: 'cmd+opt+p' }); ok(!r.isError && ev.at(-1) === 'sc:TextEdit:Make Plain Text:@~p' && /QUIT and reopen/.test(r.content[0].text), 'shortcut set encodes + tells the agent to relaunch');
  ev.length = 0;
  r = await d3.handle({ action: 'run', screenshot: false, vars: { who: 'bob' }, script: 'set greeting hi\nhotkey spotlight\ntype ${greeting} ${who}\nwait_window Ready 2\nfill 10,20 commit=tab -- secret-ish\nkey Return' });
  ok(!r.isError && ev.join(' ') === 'key:cmd+space type:6 click3@20,40 type:10 key:Tab key:Return', `run: one call, every step in order (${ev.join(' ')})`);
  ok(!/secret-ish/.test(r.content[0].text) && /fill \(10 chars\)/.test(r.content[0].text), 'run log never echoes typed text');
  { const rz = await d3.handle({ action: 'run', screenshot: false, script: 'fill 1,1 -- a\nfill 2,2 -- b\nfill 3,3 -- c\nfill 4,4 -- d\nzoom 0,0,100,50' });
    const labels = rz.content.filter(c => c.type === 'text' && /^\[line /.test(c.text)).map(c => c.text);
    ok(!rz.isError && labels.includes('[line 5: zoom]') && labels.filter(l => /fill_field/.test(l)).length === 3, `run keeps an explicit zoom after 4 fills (${labels.join(' ')})`); }
  r = await d3.handle({ action: 'run', screenshot: false, script: 'key a\nfrobnicate\nkey b' }); ok(r.isError && /line 2/.test(r.content[0].text), 'run stops at the first bad line and names it');
  r = await d3.handle({ action: 'macro', op: 'save', name: 'greet', description: 'say hi', script: 'hotkey spotlight\ntype ${msg}' }); ok(!r.isError && /saved macro greet/.test(r.content[0].text), 'macro save');
  r = await d3.handle({ action: 'macro', op: 'save', name: 'bad', script: 'click nowhere' }); ok(r.isError, 'macro save syntax-checks at save time');
  r = await d3.handle({ action: 'macro', op: 'list' }); ok(/greet\tsay hi/.test(r.content[0].text), 'macro list');
  ev.length = 0; r = await d3.handle({ action: 'run', macro: 'greet', vars: { msg: 'yo' }, screenshot: false }); ok(!r.isError && ev.join(' ') === 'key:cmd+space type:2', 'run a saved macro with vars');
  ev.length = 0; r = await d3.handle({ action: 'run', screenshot: false, script: 'macro greet msg=abc\nkey Escape' }); ok(!r.isError && ev.join(' ') === 'key:cmd+space type:3 key:Escape', 'a script can call a macro');
  r = await d3.handle({ action: 'macro', op: 'save', name: 'loop', script: 'macro loop' }); r = await d3.handle({ action: 'run', macro: 'loop', screenshot: false }); ok(r.isError && /deeper than 5/.test(r.content[0].text), 'self-calling macro is stopped');
  r = await d3.handle({ action: 'macro', op: 'delete', name: 'greet' }); ok(!r.isError && !/greet/.test((await d3.handle({ action: 'macro', op: 'list' })).content[0].text), 'macro delete');
  cur = { x: 500, y: 500 }; }
// 0.10 VALIDATE (plan §5c item 1): pure validator + run {validate:true} / macro {op:"validate"} on the fake backend — nothing may run
{ const menuText = 'TextEdit\nFile > New\tcmd+n\nFile > Save…\tcmd+s\nFile > Export as PDF…\nFormat > Font > Bold\tcmd+b\nFormat > Make Plain Text\tshift+cmd+t';
  const tree = parseMenuList(menuText); ok(tree.length === 5 && tree[3].join('|') === 'Format|Font|Bold', `parseMenuList (${tree.length} paths)`);
  ok(closest('spotlite', ['spotlight', 'save', 'open'])[0] === 'spotlight', 'closest: edit-distance suggestion');
  const macros = { inner: { script: 'hotkey save\ntype ${who}' }, cyc: { script: 'macro cyc2' }, cyc2: { script: 'macro cyc' } };
  const base = { platform: 'mac', macos: true, readMacro: n => macros[n] ?? null, macroNames: Object.keys(macros), apps: ['TextEdit'],
    screen: { width: 1280, height: 800 }, menuPaths: (app, top) => tree.filter(p => p[0] === top) };
  const good = validateScript('set who bob\nhotkey spotlight\ntype ${who}\nmenu File > Save...\nmenu Format > Font > Bold\nkey cmd+shift+s Return\nmacro inner\nlaunch TextEdit\nclick 100,100', base);
  ok(good.ok && good.issues.length === 0 && good.steps === 11 && good.menusChecked, `valid script passes (9 lines + 2 inside the macro) (${JSON.stringify(good.issues)})`);
  const bad = validateScript('hotkey spotlite\nkey cmnd+s\ntype ${nobody}\nmenu File > Sav As\nmacro innr\nmacro cyc\nlaunch Calculator\nwait_window ([ 3\nclick 2000,10\nfrobnicate\nhotkey run_dialog', base);
  const at = n => bad.issues.filter(i => i.line === n && !i.macro).map(i => `${i.msg} ${i.hint ?? ''}`).join(' | ');
  ok(!bad.ok, 'invalid script fails');
  ok(/unknown hotkey "spotlite".*spotlight/.test(at(1)), `L1 hotkey suggestion (${at(1)})`);
  ok(/"cmnd" in "cmnd\+s" is not a modifier/.test(at(2)), `L2 bad modifier (${at(2)})`);
  ok(/\$\{nobody\} is not set/.test(at(3)), `L3 unset var (${at(3)})`);
  ok(/menu "File > Sav As" not found/.test(at(4)) && /Save/.test(at(4)), `L4 live menu path + suggestion (${at(4)})`);
  ok(/no saved macro "innr".*inner/.test(at(5)), `L5 macro suggestion (${at(5)})`);
  ok(bad.issues.some(i => i.macro === 'cyc2' && /calls itself/.test(i.msg)), 'L6 macro cycle found inside the nested macro');
  ok(/not in the launch allow-list/.test(at(7)), `L7 allow-list (${at(7)})`);
  ok(/not a valid regex/.test(at(8)), `L8 regex (${at(8)})`);
  ok(/outside the screenshot/.test(at(9)) && bad.issues.find(i => i.line === 9).level === 'warn', `L9 coordinate warning (${at(9)})`);
  ok(/unknown command "frobnicate"/.test(at(10)), `L10 syntax error, and checking went on past it (${at(10)})`);
  ok(/no macOS binding/.test(at(11)), `L11 platform binding (${at(11)})`);
  const x11 = validateScript('menu File > Save', { ...base, macos: false, platform: 'win' }); ok(!x11.ok && /macOS-only/.test(x11.issues[0].msg), 'menu line refused off macOS');
  { const w = validateScript('wait 1500\nwait 15\nwait 1', base); ok(!w.ok && /SECONDS \(did you mean 1.5 s\?\)/.test(w.issues[0].msg) && w.issues[1].level === 'warn' && w.issues.length === 2, `wait in ms is an error (${JSON.stringify(w.issues)})`); }
  const inner = validateScript('macro inner', { ...base }); ok(!inner.ok && inner.issues[0].macro === 'inner' && /\$\{who\}/.test(inner.issues[0].msg), 'nested macro lines checked with the merged vars');
  ok(validateScript('macro inner who=al', base).ok, 'macro call args satisfy the nested macro vars');
  // act level: nothing runs, live menus are read per top menu
  const ev = []; const reads = [];
  const fkv = { ...fake, name: 'macos (fake)', key: async k => ev.push(`key:${k}`), type: async t => ev.push(`type:${t.length}`), click: async () => ev.push('click'),
    menuInvoke: async () => { ev.push('menu'); return 'x'; }, menuList: async (app, top) => { reads.push(`${app ?? ''}/${top}`); return menuText.split('\n').filter((l, i) => i === 0 || l.startsWith(top + ' >')).join('\n'); } };
  const dv = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk10v-')), backend: fkv, maxWidth: 1280 });
  let r = await dv.handle({ action: 'run', validate: true, script: 'hotkey spotlight\nmenu File > Save…\nmenu Format > Make Plain Txt @TextEdit\nkey cmd+s' });
  ok(!r.isError && /INVALID — 4 steps, 1 error/.test(r.content[0].text) && /line 3: menu "Format > Make Plain Txt" not found in TextEdit — did you mean Make Plain Text/.test(r.content[0].text), `run validate reports (${r.content[0].text.replace(/\n/g, ' / ')})`);
  ok(ev.length === 0, `run validate ran NOTHING (${ev.join(' ')})`);
  ok(reads.sort().join(',') === '/File,TextEdit/Format', `live menu tree read once per (app, top) (${reads.join(',')})`);
  r = await dv.handle({ action: 'run', validate: true, live_menus: false, script: 'menu File > Nope' }); ok(!r.isError && /VALID/.test(r.content[0].text) && /menus: skipped/.test(r.content[0].text), 'live_menus:false skips the menu check');
  await dv.handle({ action: 'macro', op: 'save', name: 'mv', script: 'hotkey save\ntype ${who}' });
  r = await dv.handle({ action: 'macro', op: 'validate', name: 'mv' }); ok(!r.isError && /INVALID/.test(r.content[0].text) && /\$\{who\} is not set/.test(r.content[0].text), 'macro validate by name');
  r = await dv.handle({ action: 'macro', op: 'validate', name: 'mv', vars: { who: 'x' } }); ok(!r.isError && /^VALID/.test(r.content[0].text), 'macro validate with vars');
  r = await dv.handle({ action: 'run', validate: true, macro: 'mv', vars: { who: 'x' } }); ok(!r.isError && ev.length === 0, 'run {macro, validate:true} checks without running'); }
// 0.8.2 guest key remap ([desktop-feedback] HIGH 11-08: cmd+a reached a Parallels Windows guest as the Win key)
{ const keys = []; let front = 'Parallels Desktop';
  const gk = { ...fake, name: 'macos (fake)', key: async k => keys.push(k), frontApp: async () => front };
  const dg = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk82-')), backend: gk, maxWidth: 1280 });
  let r = await dg.handle({ action: 'key', text: 'cmd+a', screenshot: false });
  ok(!r.isError && keys.at(-1) === 'ctrl+a' && /guest front/.test(r.content[0].text), `guest front: cmd+a sent as ctrl+a (${keys.at(-1)})`);
  r = await dg.handle({ action: 'key', text: 'cmd+tab', screenshot: false }); ok(keys.at(-1) === 'cmd+tab', 'guest front: cmd+tab stays host (leave the VM)');
  r = await dg.handle({ action: 'key', text: 'cmd+space', screenshot: false }); ok(keys.at(-1) === 'cmd+space', 'guest front: cmd+space stays host');
  r = await dg.handle({ action: 'key', text: 'cmd+a', guest_keys: 'host', screenshot: false }); ok(keys.at(-1) === 'cmd+a', 'guest_keys host: no remap');
  r = await dg.handle({ action: 'key', text: 'Return', screenshot: false }); ok(keys.at(-1) === 'Return', 'no cmd: untouched');
  front = 'TextEdit'; r = await dg.handle({ action: 'key', text: 'cmd+a', screenshot: false }); ok(keys.at(-1) === 'cmd+a', 'host app front: cmd+a stays cmd+a');
  const gx = { ...fake, key: async k => keys.push(k), frontApp: async () => 'Parallels Desktop' };   // non-mac backend: never remaps
  const dx = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk82x-')), backend: gx, maxWidth: 1280 });
  r = await dx.handle({ action: 'key', text: 'cmd+a', screenshot: false }); ok(keys.at(-1) === 'cmd+a', 'non-mac backend: no remap'); }

// 0.4 perception: scan / grab / press / set_value on a fake accessibility tree (macOS-only for real; X11 refuses clearly)
{ const tree = { app: 'TextEdit', window: 'Untitled', els: [
    { p: [0], r: 'AXToolbar', t: '', d: 'toolbar', v: '', x: 0, y: 0, w: 2560, h: 80, e: true },
    { p: [0, 0], r: 'AXButton', t: 'Export', d: '', v: '', x: 100, y: 20, w: 120, h: 40, e: true },
    { p: [0, 1], r: 'AXButton', t: 'Disabled thing', d: '', v: '', x: 300, y: 20, w: 120, h: 40, e: false },
    { p: [1], r: 'AXTextArea', t: '', d: 'body', v: 'hello world', x: 0, y: 100, w: 2560, h: 1400, e: true, f: true },
    { p: [2], r: 'AXStaticText', t: '', d: '', v: 'hidden', x: 0, y: 0, w: 0, h: 0, e: true } ] };
  const acts = []; let vals = { '1': 'hello world' };
  const ax = { ...fake, name: 'macos (fake)', axScan: async () => tree,
    axAct: async (o) => { acts.push(`${o.act}:${o.path.join('.')}`); const el = tree.els.find(e => e.p.join('.') === o.path.join('.'));
      if (o.act === 'set') vals[o.path.join('.')] = o.value; const v = vals[o.path.join('.')] ?? el.v;
      return { ...el, v, n: 0, ok: !(o.act === 'press' && el.r !== 'AXButton'), note: o.act === 'press' ? (el.r === 'AXButton' ? 'AXPress' : 'no AXPress: n/a') : '' }; } };
  const dx = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk11-')), backend: ax, maxWidth: 1280 });
  let r = await dx.handle({ action: 'press', ref: 'e2', screenshot: false }); ok(r.isError && /no scan yet/.test(r.content[0].text), 'press before scan refuses');
  r = await dx.handle({ action: 'scan' }); const t = r.content[0].text;
  ok(/TextEdit \/ "Untitled" — 5 elements/.test(t) && /e2\tButton\t"Export"\t@\[80,20\] 60×20/.test(t) && !/hidden/.test(t), 'scan lists refs with screenshot-px centers, hides zero-size');
  ok(/e3\tButton\t"Disabled thing".*\(disabled\)/.test(t) && /e4\tTextArea\t"body".*value="hello world".*\(focused\)/.test(t), 'scan marks disabled / focused / value');
  r = await dx.handle({ action: 'scan', filter: { interactive: true, hasText: 'export' } }); ok(/1 match/.test(r.content[0].text) && /e2/.test(r.content[0].text) && !/e4/.test(r.content[0].text), 'scan filter interactive + hasText');
  r = await dx.handle({ action: 'grab', ref: 'e4' }); const gj = JSON.parse(r.content[0].text); ok(gj.value === 'hello world' && gj.role === 'AXTextArea' && gj.center_px[0] === 640, 'grab by ref');
  r = await dx.handle({ action: 'grab', coordinate: [80, 20] }); ok(JSON.parse(r.content[0].text).ref === 'e2', 'grab by coordinate picks the smallest containing element');
  r = await dx.handle({ action: 'press', ref: 'e2', screenshot: false }); ok(!r.isError && /via AXPress/.test(r.content[0].text) && acts.at(-1) === 'press:0.0', 'press via AXPress');
  r = await dx.handle({ action: 'press', ref: 'e4', screenshot: false }); ok(!r.isError && /by clicking its center/.test(r.content[0].text), 'press falls back to a center click when AXPress is missing');
  r = await dx.handle({ action: 'set_value', ref: 'e4', text: 'set directly' }); ok(!r.isError && /read back: matches/.test(r.content[0].text), 'set_value writes + verifies');
  r = await dx.handle({ action: 'left_click', ref: 'e2', screenshot: false }); ok(!r.isError && calls.at(-1)[1].x === 160 && calls.at(-1)[1].y === 40, 'click by ref');
  r = await dx.handle({ action: 'press', ref: 'e99', screenshot: false }); ok(r.isError && /unknown ref "e99"/.test(r.content[0].text), 'unknown ref is named');
  const dn = createDesktop({ mode: 'virtual', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk12-')), backend: fake, maxWidth: 1280 });
  r = await dn.handle({ action: 'scan' }); ok(r.isError && /Accessibility tree/.test(r.content[0].text), 'scan on a backend without accessibility refuses clearly');
  cur = { x: 500, y: 500 }; }
// 0.5 in-guest perception: host side against an EMULATED helper (same file protocol as guest/nexus-guest-uia.ps1)
{ const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-')); const seen = [];
  const dg = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk13-')), backend: fake, maxWidth: 1280, guestDir: gdir });
  let r = await dg.handle({ action: 'guest_ping' }); ok(r.isError && /helper is not running/.test(r.content[0].text) && /powershell -ExecutionPolicy Bypass/.test(r.content[0].text), 'guest_* without a heartbeat → how-to-start message');
  const els = [ { p: [0], r: 'Pane', t: 'wizard', aid: '', cls: 'WindowsForms', v: '', x: 0, y: 0, w: 600, h: 400, e: true, f: false, off: false },
    { p: [0, 0], r: 'Edit', t: 'Date from', aid: 'dtFrom', cls: 'SysDateTimePick32', v: '1/3/2024', x: 10, y: 10, w: 120, h: 20, e: true, f: false, off: false },
    { p: [0, 1], r: 'Button', t: 'Next >', aid: 'btnNext', cls: 'Button', v: '', x: 500, y: 360, w: 80, h: 24, e: true, f: false, off: false } ];
  const vals = {};
  const tick = setInterval(() => {
    fs.writeFileSync(path.join(gdir, 'helper-alive.json'), JSON.stringify({ version: 'emu', ts: new Date().toISOString() }));
    for (const f of fs.readdirSync(gdir).filter(f => /^req-.*\.json$/.test(f))) {
      const req = JSON.parse(fs.readFileSync(path.join(gdir, f), 'utf8')); fs.unlinkSync(path.join(gdir, f)); seen.push(req.op);
      const id = f.slice(4, -5); let res;
      if (req.op === 'ping') res = { ok: true, version: 'emu', os: 'Microsoft Windows NT 6.1', ps: '2.0', user: 'operator' };
      else if (req.op === 'windows') res = { ok: true, windows: [{ name: 'Backtesting - Wizard', cls: 'WindowsForms', pid: 42, x: 0, y: 0, w: 600, h: 400 }] };
      else if (req.op === 'scan') res = { ok: true, window: 'Backtesting - Wizard', els, truncated: false, ms: 12 };
      else if (req.op === 'get') { const e = els.find(e => e.p.join('.') === req.path.join('.')); res = { ok: true, ...e, v: vals[req.path.join('.')] ?? e.v, n: 0 }; }
      else if (req.op === 'press') res = { ok: true, how: 'Invoke' };
      else if (req.op === 'set') { vals[req.path.join('.')] = req.value === '01/04/2024' ? '1/4/2024' : req.value; res = { ok: true, v: vals[req.path.join('.')] }; }
      else res = { ok: false, error: `unknown op '${req.op}'` };
      fs.writeFileSync(path.join(gdir, `resp-${id}.tmp`), JSON.stringify(res)); fs.renameSync(path.join(gdir, `resp-${id}.tmp`), path.join(gdir, `resp-${id}.json`));
    } }, 40);
  await new Promise(r => setTimeout(r, 100));
  r = await dg.handle({ action: 'guest_ping' }); ok(!r.isError && /Windows NT 6.1, PowerShell 2.0/.test(r.content[0].text), 'guest_ping round-trips through the shared folder');
  r = await dg.handle({ action: 'guest_windows' }); ok(/"Backtesting - Wizard"/.test(r.content[0].text), 'guest_windows');
  r = await dg.handle({ action: 'guest_press', ref: 'g3' }); ok(r.isError && /no guest scan yet/.test(r.content[0].text), 'guest_press before guest_scan refuses');
  r = await dg.handle({ action: 'guest_scan', window: 'Backtesting', filter: { interactive: true } });
  ok(/3 elements in 12 ms/.test(r.content[0].text) && /g2\tEdit\t"Date from"\tid=dtFrom/.test(r.content[0].text) && /g3\tButton\t"Next >"/.test(r.content[0].text) && !/g1\t/.test(r.content[0].text), 'guest_scan lists refs (interactive filter)');
  r = await dg.handle({ action: 'guest_press', ref: 'g3' }); ok(!r.isError && /UI Automation Invoke pattern/.test(r.content[0].text), 'guest_press via Invoke');
  r = await dg.handle({ action: 'guest_set_value', ref: 'g2', text: 'abc' }); ok(!r.isError && /read back: matches/.test(r.content[0].text), 'guest_set_value verifies the read-back');
  r = await dg.handle({ action: 'guest_set_value', ref: 'g2', text: '01/04/2024' }); ok(r.isError && /DIFFERS/.test(r.content[0].text) && /dates/.test(r.content[0].text), 'guest_set_value flags a reformatted value (date pickers)');
  r = await dg.handle({ action: 'guest_grab', ref: 'g2' }); ok(JSON.parse(r.content[0].text).value === '1/4/2024' && JSON.parse(r.content[0].text).class === 'SysDateTimePick32', 'guest_grab shows the stored value + class');
  clearInterval(tick);
  ok(seen.join(',') === 'ping,windows,scan,press,set,set,get' && fs.readdirSync(gdir).every(f => !/^(req|resp)-/.test(f)), `protocol: every request consumed, every response cleaned up (${seen.join(',')})`); }
// 0.5.4: Win7 MSAA-bridged guest controls (role Pane, class tells the truth) + refs that survive a new process (persisted last scans)
{ const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest7-')); const home7 = fs.mkdtempSync(path.join(os.tmpdir(), 'desk14-')); const seen = [];
  const els = [ { p: [0], r: 'Pane', t: 'Backtest', aid: '', cls: 'WindowsForms10.Window.8.app.0.2bf8098_r11_ad1', v: '', x: 0, y: 0, w: 600, h: 400, e: true, f: false, off: false },
    { p: [0, 0], r: 'Pane', t: 'Symbol', aid: '', cls: 'Edit', v: 'EUR/USD', x: 10, y: 10, w: 120, h: 20, e: true, f: false, off: false },
    { p: [0, 1], r: 'Pane', t: 'Run', aid: '', cls: 'WindowsForms10.BUTTON.app.0.2bf8098_r11_ad1', v: '', x: 500, y: 360, w: 80, h: 24, e: true, f: false, off: false },
    { p: [0, 2], r: 'Pane', t: 'Results', aid: '', cls: 'SysListView32', v: '', x: 10, y: 40, w: 580, h: 300, e: true, f: false, off: false },
    { p: [0, 3], r: 'Pane', t: 'Notes', aid: '', cls: 'RichEdit20W', v: '', x: 10, y: 345, w: 200, h: 40, e: true, f: false, off: false },
    { p: [0, 4], r: 'Pane', t: 'Progress', aid: '', cls: 'msctls_progress32', v: '', x: 220, y: 345, w: 200, h: 10, e: true, f: false, off: false },
    { p: [0, 5], r: 'Text', t: 'Label', aid: '', cls: 'Static', v: '', x: 220, y: 360, w: 60, h: 20, e: true, f: false, off: false } ];
  const tick = setInterval(() => {
    fs.writeFileSync(path.join(gdir, 'helper-alive.json'), JSON.stringify({ version: 'emu', ts: new Date().toISOString() }));
    for (const f of fs.readdirSync(gdir).filter(f => /^req-.*\.json$/.test(f))) {
      const req = JSON.parse(fs.readFileSync(path.join(gdir, f), 'utf8')); fs.unlinkSync(path.join(gdir, f)); seen.push(`${req.op}${req.path ? ':' + req.path.join('.') : ''}`);
      const id = f.slice(4, -5);
      const res = req.op === 'scan' ? { ok: true, window: 'Backtest', els, truncated: false, ms: 9 } : req.op === 'press' ? { ok: true, how: 'Invoke' } : { ok: false, error: `unknown op '${req.op}'` };
      fs.writeFileSync(path.join(gdir, `resp-${id}.tmp`), JSON.stringify(res)); fs.renameSync(path.join(gdir, `resp-${id}.tmp`), path.join(gdir, `resp-${id}.json`));
    } }, 40);
  await new Promise(r => setTimeout(r, 100));
  const g1 = createDesktop({ mode: 'real', home: home7, backend: fake, maxWidth: 1280, guestDir: gdir });
  let r = await g1.handle({ action: 'guest_scan', filter: { interactive: true } }); const t = r.content[0].text;
  ok(/5 match/.test(t) && /g2\tPane\[Edit\]\t"Symbol"/.test(t) && /g3\tPane\[WindowsForms10\.BUTTON/.test(t) && /g4\tPane\[SysListView32\]/.test(t) && /g5\tPane\[RichEdit20W\]/.test(t) && /g6\tPane\[msctls_progress32\]/.test(t) && !/g1\t/.test(t) && !/g7\t/.test(t),
    'guest_scan interactive filter matches Win7 Pane elements by class (Edit/WinForms BUTTON/SysListView32/RichEdit*/msctls_*) and shows Pane[class]');
  r = await g1.handle({ action: 'guest_scan', filter: { role: 'listview' } }); ok(/1 match/.test(r.content[0].text) && /g4\t/.test(r.content[0].text), 'guest_scan role filter also matches a Pane by its class');
  ok(fs.existsSync(path.join(home7, 'last-guest-scan.json')), 'guest_scan persists <home>/last-guest-scan.json');
  const g2 = createDesktop({ mode: 'real', home: home7, backend: fake, maxWidth: 1280, guestDir: gdir });   // a NEW process (fresh in-memory state)
  r = await g2.handle({ action: 'guest_press', ref: 'g3' }); ok(!r.isError && seen.at(-1) === 'press:0.1', 'guest refs survive a new desktop instance (persisted last guest scan)');
  r = await g2.handle({ action: 'guest_press', ref: 'g99' }); ok(r.isError && /last guest scan has g1–g7/.test(r.content[0].text), 'a persisted guest scan still names out-of-range refs');
  clearInterval(tick);
  // AX scan persistence (macOS refs) — scan in one instance, press/grab in another
  const tree = { app: 'TextEdit', window: 'Untitled', els: [ { p: [0], r: 'AXButton', t: 'Export', d: '', v: '', x: 100, y: 20, w: 120, h: 40, e: true } ] }; const acts = [];
  const ax = { ...fake, name: 'macos (fake)', axScan: async () => tree, axAct: async (o) => { acts.push(`${o.act}:${o.path.join('.')}`); return { ...tree.els[0], n: 0, ok: true, note: 'AXPress' }; } };
  const homeAx = fs.mkdtempSync(path.join(os.tmpdir(), 'desk15-'));
  const a1 = createDesktop({ mode: 'real', home: homeAx, backend: ax, maxWidth: 1280 }); await a1.handle({ action: 'scan' });
  ok(fs.existsSync(path.join(homeAx, 'last-ax-scan.json')), 'scan persists <home>/last-ax-scan.json');
  const a2 = createDesktop({ mode: 'real', home: homeAx, backend: ax, maxWidth: 1280 });
  r = await a2.handle({ action: 'press', ref: 'e1', screenshot: false }); ok(!r.isError && acts.at(-1) === 'press:0', 'AX refs survive a new desktop instance (persisted last AX scan)');
  r = await a2.handle({ action: 'grab', coordinate: [80, 20] }); ok(!r.isError && JSON.parse(r.content[0].text).ref === 'e1', 'grab by coordinate works from a persisted AX scan');
  const a3 = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk16-')), backend: ax, maxWidth: 1280 });
  r = await a3.handle({ action: 'press', ref: 'e1', screenshot: false }); ok(r.isError && /no scan yet/.test(r.content[0].text), 'a fresh home still refuses refs before any scan');
  cur = { x: 500, y: 500 }; }
// 0.2.6 stats: the audit log rolls up per action with ms + error classes; typed text never appears
{ const st = JSON.parse((await d.handle({ action: 'stats' })).content[0].text);
  ok(st.actions_total > 5 && st.actions.left_click?.n >= 1 && typeof st.actions.left_click.p50_ms === 'number', `stats per action (${st.actions_total} rows, left_click n=${st.actions.left_click?.n})`);
  ok(st.error_classes.failsafe >= 1 && st.error_classes.stopped >= 1 && st.error_classes.coordinate >= 1, `stats error classes ${JSON.stringify(st.error_classes)}`);
  ok(!fs.readFileSync(d.logFile, 'utf8').includes('secret-pass') && st.version === JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, 'stats/audit never hold typed text; version matches package.json'); }
// hot corner: top-left bound by the OS → the failsafe moves to the top-right corner, and the top-left no longer trips it
{ const fk = { ...fake, hotCorners: async () => ['tl'] }; const d2 = createDesktop({ mode: 'real', home: fs.mkdtempSync(path.join(os.tmpdir(), 'desk2-')), backend: fk, maxWidth: 1280 });
  const i2 = JSON.parse((await d2.handle({ action: 'info' })).content[0].text);
  ok(i2.failsafe_corner === 'tr' && i2.failsafe_corner_px[0] === 1280 && i2.failsafe_corner_px[1] === 0, `hot top-left → failsafe corner tr at [${i2.failsafe_corner_px}]`);
  cur = { x: 0, y: 0 }; let r2 = await d2.handle({ action: 'key', text: 'a', screenshot: false }); ok(!r2.isError, 'top-left does NOT trip when it is a hot corner');
  cur = { x: 2559, y: 0 }; r2 = await d2.handle({ action: 'key', text: 'a', screenshot: false }); ok(r2.isError && /FAILSAFE.*tr /.test(r2.content[0].text), 'top-right trips instead: ' + r2.content[0].text.slice(0, 90));
  cur = { x: 500, y: 500 }; }
r = await d.handle({ action: 'launch', app: 'Definitely Not Allowed', screenshot: false });
ok(true, 'launch allow-list is enforced by the backend (checked in the X11 drive test)');

// ── 0.6: context + watch (pure diff, fake-backend stream, trailer split, stale refs, folder events, guest op guard) ──
{ const { diffState, fmtEvent } = await import('../dist/desktop.js');
  const S = (o = {}) => ({ app: 'Finder', window: 'Downloads', apps: ['Finder', 'Terminal'], focus: { r: 'TextField', t: 'Search', n: 0, h: 1 },
    windows: [{ app: 'Finder', title: 'Downloads', x: 0, y: 25, w: 800, h: 600 }, { app: 'Terminal', title: 'bash', x: 900, y: 25, w: 600, h: 400 }], ...o });
  const a = S();
  ok(diffState(null, a, 'host').length === 0, 'diff: first snapshot is a baseline (no events)');
  let ev = diffState(a, S({ windows: [...a.windows, { app: 'Finder', title: 'Save', sr: 'AXDialog', x: 10, y: 10, w: 300, h: 200 }] }), 'host');
  ok(ev.length === 1 && ev[0].type === 'window_opened' && ev[0].dialog === true, `diff: dialog opened (${ev.map(e => e.type)})`);
  ev = diffState(a, S({ windows: [{ ...a.windows[0], title: 'Documents' }, a.windows[1]], window: 'Documents' }), 'host');
  ok(ev.length === 1 && ev[0].type === 'window_retitled' && ev[0].from === 'Downloads' && ev[0].to === 'Documents', `diff: same geometry = retitle, not close+open+focus (${ev.map(e => e.type)})`);
  ev = diffState(a, S({ app: 'Terminal', window: 'bash', apps: ['Finder', 'Terminal', 'TextEdit'], windows: [a.windows[1]] }), 'host');
  ok(['app_launched', 'window_closed', 'app_activated'].every(t => ev.some(e => e.type === t)), `diff: launch + close + activate (${ev.map(e => e.type)})`);
  ev = diffState(a, S({ focus: { r: 'TextField', t: 'Search', n: 5, h: 99 } }), 'host');
  ok(ev.length === 1 && ev[0].type === 'value_changed' && ev[0].chars === 5 && !('value' in ev[0]), 'diff: value change reported as a COUNT only');
  const g1 = { app: 'TS', window: 'Main', apps: ['TS'], focus: null, windows: [{ id: '42', app: 'TS', title: 'Main', cls: 'X' }] };
  ev = diffState(g1, { ...g1, window: 'Main *', windows: [{ id: '42', app: 'TS', title: 'Main *', cls: 'X' }] }, 'guest');
  ok(ev.length === 1 && ev[0].type === 'window_retitled', `diff: id-keyed window retitle (${ev.map(e => e.type)})`);
  ok(/^#3 guest:window_opened TS "Save As" \[dialog\]$/.test(fmtEvent({ seq: 3, type: 'window_opened', src: 'guest', app: 'TS', title: 'Save As', dialog: true })), 'fmtEvent: guest dialog line');

  // fake backend with a mutable state
  let st = S();
  const wHome = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-watch-')), drop = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-drop-'));
  const tree = { app: 'Finder', window: 'Downloads', els: [{ p: [0], r: 'AXButton', t: 'Go', d: '', v: '', x: 10, y: 10, w: 50, h: 20, e: true }] };
  const wb = { ...fake, name: 'macos (fake)', state: async () => JSON.parse(JSON.stringify(st)), axScan: async () => tree,
    axAct: async () => ({ ...tree.els[0], n: 0, ok: true, note: 'AXPress' }),
    key: async k => { calls.push(['key', k]); if (k === 'cmd+shift+s') st = S({ windows: [...st.windows, { app: 'Finder', title: 'Save', sr: 'AXSheet', x: 1, y: 1, w: 9, h: 9 }] }); } };
  const wd = createDesktop({ mode: 'virtual', home: wHome, backend: wb, maxWidth: 1280, guestDir: path.join(wHome, 'no-bridge') });
  let w = await wd.handle({ action: 'watch', op: 'start', interval_ms: 60000, paths: [drop] });
  ok(!w.isError && /baseline 2 windows, front Finder/.test(w.content[0].text), `watch start: baseline (${w.content[0].text.slice(0, 80)})`);
  st = S({ app: 'Terminal', window: 'bash' });   // EXTERNAL change between calls
  await new Promise(r => setTimeout(r, 350));   // > the 300 ms pre-poll skip window
  w = await wd.handle({ action: 'key', text: 'cmd+shift+s', screenshot: false });   // the action's own effect: a sheet opens
  const tr = w.content.map(c => c.text ?? '').join('\n');
  ok(/since your last call:\n\s+#\d+ \S+ app_activated Terminal/.test(tr) && !/during this action:[\s\S]*app_activated Terminal/.test(tr),
    `trailer: external activation listed under "since your last call"`);
  ok(/during this action:\n[\s\S]*window_opened Finder "Save" \[dialog\]/.test(tr), `trailer: the action's sheet listed under "during this action" (${tr.replace(/\n/g, ' | ').slice(0, 260)})`);
  w = await wd.handle({ action: 'key', text: 'Escape', screenshot: false });
  ok(!w.content.some(c => /desktop events/.test(c.text ?? '')), 'trailer: nothing repeated once delivered');
  // stale refs: scan, then the scanned window closes
  st = S({ app: 'Finder', window: 'Downloads' }); await wd.handle({ action: 'watch', op: 'events' });
  await wd.handle({ action: 'scan' });
  st = S({ windows: [a.windows[1]], window: '' });
  await wd.handle({ action: 'watch', op: 'events' });
  w = await wd.handle({ action: 'press', ref: 'e1', screenshot: false });
  ok(w.content.some(c => /WARNING: refs from the last scan may be stale — .*window_closed Finder "Downloads"/.test(c.text ?? '')), 'stale: press on a ref from a closed window warns');
  // folder events
  fs.writeFileSync(path.join(drop, 'history.csv'), 'a,b\n');
  let got = ''; for (let i = 0; i < 20 && !/file_created/.test(got); i++) { await new Promise(r => setTimeout(r, 150)); got = (await wd.handle({ action: 'watch', op: 'events', since_seq: 0 })).content[0].text; }
  ok(new RegExp(`file_created ${path.join(drop, 'history.csv').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`).test(got), 'watch: a file landing in a watched folder is an event');
  const stt = JSON.parse((await wd.handle({ action: 'watch', op: 'status' })).content[0].text);
  ok(stt.on && stt.polls >= 3 && stt.events_total >= 4 && stt.log.endsWith('desktop-events.jsonl'), `watch status (${JSON.stringify({ polls: stt.polls, ev: stt.events_total, p50: stt.poll_p50_ms })})`);
  const jl = fs.readFileSync(path.join(wHome, 'desktop-events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  ok(jl.length === stt.events_total && jl.every((e, i) => e.seq === i + 1), `events log: ${jl.length} rows, sequential`);
  const cx = (await wd.handle({ action: 'context' })).content[0].text;
  ok(/^front: Finder ""; focus TextField "Search" \(0 chars\)$/m.test(cx) && /windows \(1\):/.test(cx) && /scan: e1-e1 of Finder "Downloads", \d+ s old — STALE/.test(cx) && /watch: on/.test(cx) && /safety: failsafe/.test(cx),
    `context header (${cx.replace(/\n/g, ' | ').slice(0, 300)})`);
  ok(!/guest:/.test(cx), 'context: no guest line when no bridge folder exists');
  w = await wd.handle({ action: 'watch', op: 'stop' }); ok(/watch stopped/.test(w.content[0].text), 'watch stop');
  wd.stopWatch();
  // guest bridge present, helper dead → one honest line
  fs.mkdirSync(path.join(wHome, 'bridge'));
  const gd = createDesktop({ mode: 'virtual', home: wHome, backend: wb, maxWidth: 1280, guestDir: path.join(wHome, 'bridge') });
  ok(/guest: helper not running/.test((await gd.handle({ action: 'context' })).content[0].text), 'context: dead guest helper reported, not hung');
  const ps = fs.readFileSync(new URL('../guest/nexus-guest-uia.ps1', import.meta.url), 'utf8');
  ok(/'state'\s+\{ return \(Get-State\) \}/.test(ps) && /class NexusGuestFg/.test(ps) && !/NexusGuestWin32::GetForegroundWindow/.test(ps), 'guest helper: state op + separate NexusGuestFg type (old consoles keep working)');
}

// ── 0.6.1: light/full tiering (macbook Big Sur: full snapshot p50 4.0 s), batch threshold, error text, guest NULs ──
{ const { mergeLight, diffState } = await import('../dist/desktop.js');
  const full = { app: 'Finder', window: 'Downloads', apps: ['Finder', 'Terminal'], focus: null, windows: [{ app: 'Finder', title: 'Downloads', x: 0, y: 0, w: 9, h: 9 }, { app: 'Terminal', title: 'bash', x: 1, y: 1, w: 9, h: 9 }] };
  const light = { app: 'Finder', window: 'Downloads', apps: ['Finder'], focus: null, partial: true, windows: [{ app: 'Finder', title: 'Downloads', x: 0, y: 0, w: 9, h: 9 }, { app: 'Finder', title: 'Copy', sr: 'AXDialog', x: 2, y: 2, w: 5, h: 5 }] };
  const m = mergeLight(full, light); const ev = diffState(full, m, 'host');
  ok(m.windows.some(w => w.app === 'Terminal') && m.apps.includes('Terminal') && !m.partial, 'mergeLight: a light tick keeps the other apps\' windows + apps');
  ok(ev.length === 1 && ev[0].type === 'window_opened' && ev[0].dialog, `mergeLight: only the front app's new dialog is an event (${ev.map(e => e.type)})`);
  const lightOther = { ...light, app: 'TextEdit', window: 'Untitled', apps: ['TextEdit'], windows: [{ app: 'TextEdit', title: 'Untitled', x: 3, y: 3, w: 9, h: 9 }] };
  const ev2 = diffState(full, mergeLight(full, lightOther), 'host').map(e => e.type).sort().join(',');
  ok(ev2 === 'app_activated,app_launched,window_opened', `mergeLight: switching to a new app on a light tick (${ev2})`);
  // the watcher asks for light ticks between full ones
  const asks = []; const tb = { ...fake, name: 'macos (fake)', state: async (o) => { asks.push(o?.full ? 'F' : 'L'); return o?.full ? { ...full, ms: 900 } : { ...light, ms: 120 }; } };
  const th = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-tier-'));
  const td = createDesktop({ mode: 'virtual', home: th, backend: tb, maxWidth: 1280, guestDir: path.join(th, 'nb') });
  await td.handle({ action: 'watch', op: 'start', interval_ms: 60000 });
  for (let i = 0; i < 6; i++) await td.handle({ action: 'watch', op: 'events' });
  const stt = JSON.parse((await td.handle({ action: 'watch', op: 'status' })).content[0].text); td.stopWatch();
  ok(asks[0] === 'F' && asks.filter(x => x === 'L').length >= 4 && asks.filter(x => x === 'F').length <= 3, `tiering: baseline full, then mostly light (${asks.join('')})`);
  ok(stt.snapshot_inner_p50_ms === 120, `status reports the in-osascript snapshot time (${stt.snapshot_inner_p50_ms})`);
  const ctx = []; const cb = { ...tb, state: async (o) => { ctx.push(o?.full); return { ...full, ms: 1 }; } };
  await createDesktop({ mode: 'virtual', home: th, backend: cb, guestDir: path.join(th, 'nb') }).handle({ action: 'context' });
  ok(ctx[0] === true, 'context always takes a FULL snapshot');
  const src = fs.readFileSync(new URL('../src/desktop.ts', import.meta.url), 'utf8');
  ok(/roles\.length >= 8/.test(src) && !/roles\.length >= 4/.test(src), 'scan: attribute batching only for 8+ children');
  ok(/budget_ms/.test(src) && /timed_out: timedOut/.test(src), 'scan: time budget returns a PARTIAL result');
  ok(/abbreviated now, stderr comes first-class/.test(src) && /x\.length > 40/.test(src), 'run(): long args (the JXA script) are abbreviated so stderr stays visible');
}
// ── 0.7: app profiles (steward manual + compiled keyboard schema) + type options ──
{ const t1 = parseLine('type delay=25 -- \\\\psf\\Home\\x.csv', 1).action, t2 = parseLine('type paste -- hi there', 2).action, t3 = parseLine('type -- delay=5 is text', 3).action, t4 = parseLine('type hello world', 4).action;
  ok(t1.text === '\\\\psf\\Home\\x.csv' && t1.char_delay_ms === 25, `script: type delay=25 -- TEXT sets the delay, not the text (${JSON.stringify(t1)})`);
  ok(t2.type_via === 'paste' && t2.text === 'hi there' && t3.text === 'delay=5 is text' && !t3.char_delay_ms && t4.text === 'hello world', 'script: type paste / literal "--" / plain text unchanged');
  const ph = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-app-')); fs.mkdirSync(path.join(ph, 'apps'));
  const prof = { id: 'textedit', name: 'TextEdit', match: { host_apps: ['TextEdit'] }, contexts: [{ id: 'doc', match: { title: 'Untitled' } }],
    manual: 'MANUAL: keyboard first.', shortcuts: [
      { id: 'new_doc', context: 'doc', keys: 'cmd+n', description: 'new document', verified: true },
      { id: 'plain', context: 'doc', keys: 'cmd+shift+t', description: 'make plain text' },
      { id: 'dates', context: 'doc', how: 'fill_field per field', description: 'a manual step', verified: 'partial' } ],
    macros: [{ id: 'hello', description: 'type at a spot', vars: { xy: '10,10', word: 'hi' }, script: 'click ${xy}\ntype delay=5 -- ${word}' }] };
  fs.writeFileSync(path.join(ph, 'apps', 'textedit.json'), JSON.stringify(prof));
  fs.writeFileSync(path.join(ph, 'apps', 'broken.json'), '{nope');
  const pc = []; const st = { app: 'TextEdit', window: 'Untitled', apps: ['TextEdit'], focus: null, windows: [{ app: 'TextEdit', title: 'Untitled', x: 0, y: 0, w: 9, h: 9 }] };
  const pb = { ...fake, name: 'macos (fake)', state: async () => st, key: async k => pc.push(['key', k]), type: async (t, o) => pc.push(['type', t, o?.charDelayMs]), click: async (p) => pc.push(['click', p]) };
  const pd = createDesktop({ mode: 'virtual', home: ph, backend: pb, maxWidth: 1280, guestDir: path.join(ph, 'nb') });
  let r = await pd.handle({ action: 'app', op: 'list' });
  ok(/^textedit\tTextEdit\t3 shortcuts, 1 macros\t<- IN FRONT \(context doc\)/m.test(r.content[0].text) && !/broken/.test(r.content[0].text), `app list: profile in front + its context; broken file skipped (${r.content[0].text.slice(0, 120)})`);
  r = await pd.handle({ action: 'context' }); const cx = r.content[0].text;
  ok(/^app profile: textedit \(TextEdit\) — context doc; 3 shortcuts \(1 verified\), 1 macros/m.test(cx) && /keys here: cmd\+n = new document  \[app run id:new_doc\]/.test(cx) && /keys here: cmd\+shift\+t = make plain text \(unverified\)/.test(cx), `context names the profile + the keys valid HERE (${cx.split('\n').filter(l => /profile|keys here/.test(l)).join(' | ')})`);
  r = await pd.handle({ action: 'app', op: 'show', name: 'textedit' }); const sh = r.content[0].text;
  ok(/MANUAL: keyboard first/.test(sh) && /\[doc\]\n  new_doc\tcmd\+n\tnew document\n/.test(sh) && /plain\tcmd\+shift\+t\tmake plain text\t\(UNVERIFIED/.test(sh) && /dates\t\(fill_field per field\)/.test(sh), 'app show: manual + shortcuts by context with verified flags');
  r = await pd.handle({ action: 'app', op: 'run', name: 'textedit', id: 'plain' });
  ok(!r.isError && pc.some(c => c[0] === 'key' && c[1] === 'cmd+shift+t') && /UNVERIFIED/.test(r.content[0].text), 'app run: a shortcut sends its keys and flags itself unverified');
  r = await pd.handle({ action: 'app', op: 'run', name: 'textedit', id: 'dates' }); ok(r.isError && /manual procedure/.test(r.content[0].text), 'app run: a manual (how) step refuses with the procedure');
  r = await pd.handle({ action: 'app', op: 'run', name: 'textedit', id: 'hello', vars: { word: 'yo' }, screenshot: false });
  ok(!r.isError && pc.some(c => c[0] === 'type' && c[1] === 'yo' && c[2] === 5) && pc.some(c => c[0] === 'click'), `app run: a macro runs with default + caller vars (${JSON.stringify(pc.slice(-2))})`);
  r = await pd.handle({ action: 'app', op: 'verify', name: 'textedit', id: 'plain' });
  r = await pd.handle({ action: 'app', op: 'note', name: 'textedit', text: 'cmd+shift+t toggles back to rich text too' });
  const saved = JSON.parse(fs.readFileSync(path.join(ph, 'apps', 'textedit.json'), 'utf8'));
  ok(saved.shortcuts.find(s => s.id === 'plain').verified === true && saved.notes?.[0]?.text.startsWith('cmd+shift+t toggles') && !('__file' in saved), 'app verify + note persist into the profile file');
  r = await pd.handle({ action: 'app', op: 'save', profile_json: JSON.stringify({ id: 'bad', name: 'x', match: {}, macros: [{ id: 'm', description: '', script: 'frobnicate' }] }) });
  ok(r.isError && /unknown command/.test(r.content[0].text), 'app save: macros are syntax-checked before saving');
  r = await pd.handle({ action: 'app', op: 'save', profile_json: JSON.stringify({ id: 'ok2', name: 'x', match: { host_apps: ['X'] }, macros: [{ id: 'm', description: '', vars: { xy: '5,5' }, script: 'click ${xy}' }] }) });
  ok(!r.isError && fs.existsSync(path.join(ph, 'apps', 'ok2.json')), 'app save: a coordinate var parses with its default value');
  // guest-side matching: a Windows guest profile matched by class, sub-context by dialog class + title, host-not-VM warning
  const gp = { id: 'ts', name: 'TS', match: { guest_classes: ['TradingStationIIClass'], guest_procs: ['FXTSpp'] }, contexts: [{ id: 'save_as', match: { class: '#32770', title: 'save' } }, { id: 'main', match: { class: 'TradingStationIIClass' } }], shortcuts: [{ id: 'esc', context: 'save_as', keys: 'Escape', description: 'cancel', verified: true }] };
  fs.writeFileSync(path.join(ph, 'apps', 'ts.json'), JSON.stringify(gp)); fs.unlinkSync(path.join(ph, 'apps', 'textedit.json'));
  const gdir = path.join(ph, 'gb'); fs.mkdirSync(gdir);
  const beat = setInterval(() => fs.writeFileSync(path.join(gdir, 'helper-alive.json'), JSON.stringify({ version: 'emu', ts: new Date().toISOString() })), 200);
  fs.writeFileSync(path.join(gdir, 'helper-alive.json'), JSON.stringify({ version: 'emu', ts: new Date().toISOString() }));
  const emu = setInterval(() => { for (const f of fs.readdirSync(gdir).filter(f => /^req-.*\.json$/.test(f))) { const id = f.slice(4, -5); fs.unlinkSync(path.join(gdir, f));
    fs.writeFileSync(path.join(gdir, `resp-${id}.json`), JSON.stringify({ ok: true, fg: { id: 7, title: 'Save As\u0000', cls: '#32770', proc: 'FXTSpp' }, focus: { r: 'Pane', t: 'File name:', cls: 'Edit', n: 0, h: 0 }, windows: [{ id: 7, title: 'Save As', cls: '#32770', proc: 'FXTSpp' }, { id: 8, title: 'FXCM Trading Station', cls: 'TradingStationIIClass', proc: 'FXTSpp' }] })); } }, 50);
  try {
    const gd2 = createDesktop({ mode: 'virtual', home: ph, backend: { ...pb, state: async () => ({ ...st, app: 'Safari' }) }, maxWidth: 1280, guestDir: gdir });
    const g = (await gd2.handle({ action: 'context' })).content[0].text;
    ok(/^app profile: ts \(TS\) — context save_as — NOTE: host front app is Safari/m.test(g) && /keys here: Escape = cancel/.test(g) && /guest: front FXTSpp "Save As" \[#32770\]; focus Pane\[Edit\] "File name:"/.test(g), `guest profile: save_as context from the dialog class + title, host-not-VM warning, NUL stripped (${g.split('\n').filter(l => /profile|guest:/.test(l)).join(' | ')})`);
  } finally { clearInterval(beat); clearInterval(emu); }
}

// ── 0.7.1 field fixes: fresh baseline per start, empty reads ignored, NULs cleaned at the choke point, context when the host times out ──
{ let st = { app: 'A', window: 'w1', apps: ['A'], focus: null, windows: [{ id: '1', app: 'A', title: 'w1\u0000' }, { id: '2', app: 'A', title: 'w2' }] };
  const rh = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-071-'));
  const rb = { ...fake, name: 'x11 fake', state: async () => JSON.parse(JSON.stringify(st)) };
  const rd = createDesktop({ mode: 'virtual', home: rh, backend: rb, guestDir: path.join(rh, 'nb') });
  await rd.handle({ action: 'watch', op: 'start', interval_ms: 60000 });
  await rd.handle({ action: 'watch', op: 'stop' });
  st = { ...st, windows: [...st.windows, { id: '3', app: 'A', title: 'w3' }, { id: '4', app: 'A', title: 'w4' }] };
  await rd.handle({ action: 'watch', op: 'start', interval_ms: 60000 });
  let ev = (await rd.handle({ action: 'watch', op: 'events', since_seq: 0 })).content[0].text;
  ok(/^0 event\(s\)/.test(ev), `watch restart seeds a FRESH silent baseline (${ev.split('\n')[0]})`);
  const keep = st; st = { ...st, windows: [] };
  ev = (await rd.handle({ action: 'watch', op: 'events', since_seq: 0 })).content[0].text;
  const s1 = JSON.parse((await rd.handle({ action: 'watch', op: 'status' })).content[0].text);
  ok(/^0 event\(s\)/.test(ev) && /listed 0 windows — ignored/.test(s1.last_error ?? ''), 'an empty full read is a failed read, not a mass close');
  st = { ...keep, windows: [...keep.windows.slice(1), { id: '5', app: 'A', title: 'dlg\u0000\u0007' }] };
  ev = (await rd.handle({ action: 'watch', op: 'events', since_seq: 0 })).content[0].text;
  ok(/window_opened A "dlg"/.test(ev) && /window_closed A "w1"/.test(ev) && !/\\u0000|\u0000|\u0007/.test(ev), `events: NUL/control chars cleaned at the choke point (${ev.replace(/\n/g, ' | ').slice(0, 160)})`);
  const jl = fs.readFileSync(path.join(rh, 'desktop-events.jsonl'), 'utf8'); ok(!/\\u0000|\\u0007/.test(jl), 'events log carries no control-char escapes');
  rd.stopWatch();
  const src = fs.readFileSync(new URL('../src/desktop.ts', import.meta.url), 'utf8');
  ok(/const guestBusy = guestInflight > 0;/.test(src) && /timeoutMs: 8000/.test(src) && /guestSt = null; W\.errors\+\+/.test(src), 'context reads host+guest in parallel (busy flag captured first, host capped 8 s); guest failure re-baselines');
}

// ── 0.8: bus forwarder → a fake relay (auth header, payload shape, redaction, key-file perms, read-back, auth-failure stop) ──
{ const http = await import('node:http');
  const got = []; let mode = 'ok';
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    if (req.url.startsWith('/submit')) { got.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      if (mode === 'deny') { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":"tool \'desktop_events\' not authorized for this key nrl_secretsecret"}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ requestId: `r${got.length}` })); }
    if (req.url.startsWith('/result')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"done","result":{"success":true,"accepted":2}}'); }
    res.writeHead(404); res.end(); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${srv.address().port}`;
  const bh = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-bus-')); const kf = path.join(bh, 'relay.key');
  fs.writeFileSync(kf, 'nrl_testkey_1234567890\n', { mode: 0o644 });
  let st = { app: 'Finder', window: 'Secret Plans.pages', apps: ['Finder'], focus: null, windows: [{ app: 'Finder', title: 'Secret Plans.pages', x: 0, y: 0, w: 9, h: 9 }] };
  const bb = { ...fake, name: 'macos (fake)', state: async () => JSON.parse(JSON.stringify(st)) };
  const bd = createDesktop({ mode: 'virtual', home: bh, backend: bb, guestDir: path.join(bh, 'nb') });
  let r = await bd.handle({ action: 'bus', op: 'start', detach: false, url, key_file: kf, host: 'macbook' });
  ok(r.isError && /chmod 600/.test(r.content[0].text), 'bus refuses a key file readable by others');
  fs.chmodSync(kf, 0o600);
  r = await bd.handle({ action: 'bus', op: 'start', detach: false, url, key_file: kf, host: 'mac book!', titles: false, interval_ms: 60000 });
  ok(!r.isError && /bus ON → http:\/\/127\.0\.0\.1:\d+ as host "mac-book-"/.test(r.content[0].text) && got.length === 1, `bus start: first (heartbeat) submit (${r.content[0].text.slice(0, 110)})`);
  ok(got[0].auth === 'Bearer nrl_testkey_1234567890' && got[0].body.tool === 'desktop_events' && got[0].body.args.host === 'mac-book-' && got[0].body.args.front.window === '(title hidden)', 'bus: bearer key, tool name, host, front snapshot with the title hidden');
  st = { ...st, windows: [...st.windows, { app: 'Finder', title: 'Copy Secret', sr: 'AXDialog', x: 1, y: 1, w: 5, h: 5 }] };
  await bd.handle({ action: 'watch', op: 'events' });
  r = await bd.handle({ action: 'bus', op: 'flush' });
  const ev = got.at(-1).body.args.events;
  ok(/sent 1 event/.test(r.content[0].text) && ev.length === 1 && ev[0].type === 'window_opened' && ev[0].title === '(title hidden)' && ev[0].dialog === true && typeof ev[0].line === 'string' && !/Secret/.test(JSON.stringify(got.at(-1).body)), `bus: events forwarded with titles hidden (${JSON.stringify(ev[0]).slice(0, 140)})`);
  r = await bd.handle({ action: 'bus', op: 'flush' }); ok(got.at(-1).body.args.events.length === 0, 'bus: an event is sent once');
  await new Promise(res => setTimeout(res, 3300));
  let bs = JSON.parse((await bd.handle({ action: 'bus', op: 'status' })).content[0].text);
  ok(bs.on && /"accepted":2/.test(bs.last_result ?? ''), `bus status reads back the SPA's result (${bs.last_result})`);
  mode = 'deny';
  for (let i = 0; i < 3; i++) await bd.handle({ action: 'bus', op: 'flush' });
  bs = JSON.parse((await bd.handle({ action: 'bus', op: 'status' })).content[0].text);
  ok(!bs.on && /STOPPED after 3 auth failures/.test(bs.last_error) && !/secretsecret/.test(bs.last_error), `bus stops after 3 auth failures and never echoes a key (${bs.last_error.slice(0, 120)})`);
  r = await bd.handle({ action: 'bus', op: 'start', detach: false, url: 'http://example.com', key_file: kf }); ok(r.isError && /must be https/.test(r.content[0].text), 'bus refuses a plain-http remote relay');
  bd.stopWatch();
  // 0.8.1: DETACHED daemon — outlives the caller; a later one-shot process finds it via the pidfile, reads its status, stops it by PID
  mode = 'ok'; const dh = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-busd-')); const before = got.length;
  const one = createDesktop({ mode: 'virtual', home: dh, backend: bb, guestDir: path.join(dh, 'nb') });
  r = await one.handle({ action: 'bus', op: 'start', url, key_file: kf, host: 'daemon-test', interval_ms: 60000 });
  const dpid = Number(/pid (\d+)/.exec(r.content[0].text)?.[1]);
  ok(!r.isError && dpid > 0 && dpid !== process.pid && got.length > before && got.at(-1).body.args.host === 'daemon-test', `bus start detaches a daemon that submits on its own (${r.content[0].text.slice(0, 110)})`);
  let alive = true; try { process.kill(dpid, 0); } catch { alive = false; }
  const later = createDesktop({ mode: 'virtual', home: dh, backend: bb, guestDir: path.join(dh, 'nb') });   // a NEW caller process stand-in
  const ds = JSON.parse((await later.handle({ action: 'bus', op: 'status' })).content[0].text);
  ok(alive && ds.daemon_alive === true && ds.pid === dpid && ds.on === true && !JSON.stringify(ds).includes('nrl_testkey'), `a later caller sees the live daemon status (pid ${ds.pid}, batches ${ds.batches})`);
  r = await later.handle({ action: 'bus', op: 'stop' });
  let gone = false; for (let i = 0; i < 20 && !gone; i++) { try { process.kill(dpid, 0); await new Promise(z => setTimeout(z, 100)); } catch { gone = true; } }
  ok(/bus daemon pid \d+ stopped/.test(r.content[0].text) && gone && !fs.existsSync(path.join(dh, 'bus.pid')), 'bus stop kills the daemon BY PID and clears the pidfile');
  srv.close();
}

// ── X11 drive test on a private Xvfb ──
if (['Xvfb', 'xdotool', 'import'].every(onPath)) {
  const disp = ':77';
  const xvfb = spawn('Xvfb', [disp, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  const { execFileSync } = await import('node:child_process');
  for (let i = 0; i < 50; i++) { try { execFileSync('xdotool', ['getdisplaygeometry'], { env: { ...process.env, DISPLAY: disp }, stdio: 'ignore' }); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
  try {
    const xd = createDesktop({ mode: 'virtual', home, display: disp, maxWidth: 1280, apps: ['xclock'] });
    let s = await xd.handle({ action: 'screenshot' });
    const png = Buffer.from(s.content[1].data, 'base64');
    ok(png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 1280 && png.readUInt32BE(20) === 800, `X11 screenshot is a 1280×800 PNG (${s.content[0].text})`);
    s = await xd.handle({ action: 'mouse_move', coordinate: [640, 400], screenshot: false });
    s = await xd.handle({ action: 'cursor_position' });
    const c = JSON.parse(s.content[0].text);
    ok(Math.abs(c.x - 640) <= 1 && Math.abs(c.y - 400) <= 1, `X11 move + cursor_position round-trip (${s.content[0].text})`);
    s = await xd.handle({ action: 'left_click', coordinate: [100, 100], screenshot: false }); ok(!s.isError, 'X11 left_click');
    s = await xd.handle({ action: 'left_click_drag', start_coordinate: [100, 100], coordinate: [300, 200], screenshot: false }); ok(!s.isError, 'X11 drag');
    s = await xd.handle({ action: 'scroll', coordinate: [200, 200], scroll_direction: 'down', scroll_amount: 2, screenshot: false }); ok(!s.isError, 'X11 scroll');
    s = await xd.handle({ action: 'type', text: 'hello', screenshot: false }); ok(!s.isError, 'X11 type');
    s = await xd.handle({ action: 'key', text: 'ctrl+a Return', screenshot: false }); ok(!s.isError, `X11 key sequence ${s.content[0].text}`);
    s = await xd.handle({ action: 'zoom', region: [0, 0, 320, 200] });
    const z = Buffer.from(s.content[1].data, 'base64'); ok(z.readUInt32BE(16) === 800, `X11 zoom 2× of a 320px-wide region → 800px (${s.content[0].text.slice(0, 60)})`);
    s = await xd.handle({ action: 'launch', app: 'rm', screenshot: false }); ok(s.isError && /allow-list/.test(s.content[0].text), 'X11 launch refuses a non-allow-listed app');
    s = await xd.handle({ action: 'windows' }); ok(!s.isError, `X11 windows (${s.content[0].text.slice(0, 40)})`);
  } finally { xvfb.kill(); }
} else console.log('SKIP X11 drive test (Xvfb/xdotool/import not on PATH)');

// ── MCP layer: the server must LIST the desktop tool (0.3 first build: z.record with one arg broke listTools with "_zod") ──
// 0.9.0: desktop is SERVED by the @nexus-cortex/browser local server (it registers the tool) — test it there; NEXUS_DESKTOP_MCP_SERVER overrides.
const mcpServer = process.env.NEXUS_DESKTOP_MCP_SERVER || new URL('../../browser/dist/server.js', import.meta.url).pathname;
if (!fs.existsSync(mcpServer)) console.log(`SKIP MCP-layer check: ${mcpServer} not built (build packages/browser first)`); else
{ const { Client } = await import('@modelcontextprotocol/sdk/client/index.js'); const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const c = new Client({ name: 'desk-test', version: '0' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [mcpServer],
    env: { ...process.env, NEXUS_BROWSER_SANDBOX: '0', NEXUS_BROWSER_DESKTOP: 'virtual', NEXUS_BROWSER_DESKTOP_DISPLAY: ':77' }, stderr: 'ignore' }));
  let tl = null; try { tl = await c.listTools(); } catch (e) { ok(false, `MCP listTools: ${e.message}`); }
  if (tl) { const t = tl.tools.find(x => x.name === 'desktop'); ok(!!t && t.inputSchema.properties.action.enum.includes('run') && !!t.inputSchema.properties.vars, `MCP lists desktop with ${t?.inputSchema.properties.action.enum.length} actions`);
    const r = await c.callTool({ name: 'desktop', arguments: { action: 'hotkey', list: true } }); ok(!r.isError && /run_dialog\twin\+r/.test(r.content[0].text), 'MCP call: hotkey list (X11 → the Windows-style binding set)'); }
  await c.close(); }
console.log(fail ? `${fail} FAILED` : 'ALL PASS'); process.exit(fail ? 1 : 0);
