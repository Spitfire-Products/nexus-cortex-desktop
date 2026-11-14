// 0.11.0 native automation: parsers + runners against the REAL formats measured on the m2 (knowledge/m2-native-automation/REPORT.md §A, §D).
import assert from 'node:assert/strict';
import { parseOsaError, osaHint, stripShortcutsNoise, runOsa, runShortcuts } from '../dist/index.js';
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('PASS', name); };
ok('compile error: line + number', () => {
  const e = parseOsaError('bad.applescript:4: error: Expected “else”, etc. but found “end tell”. (-2741)');
  assert.equal(e.line, 4); assert.equal(e.number, -2741); assert.match(e.hint, /Syntax/);
});
ok('run error: start:end offsets', () => {
  const e = parseOsaError('rt.applescript:22:27: execution error: Can’t make "abc" into type number. (-1700)');
  assert.equal(e.start, 22); assert.equal(e.end, 27); assert.equal(e.number, -1700);
});
ok('-e run error without file', () => {
  const e = parseOsaError('33:36: execution error: Finder got an error: Can’t get nme of folder 1. (-1728)');
  assert.equal(e.start, 33); assert.equal(e.number, -1728); assert.ok(e.hint);
});
ok('JXA run error: no offsets', () => {
  const e = parseOsaError("execution error: Error: TypeError: null is not an object (evaluating 'null.foo') (-2700)");
  assert.equal(e.number, -2700); assert.equal(e.line, undefined);
});
ok('JXA run error from a temp file (m2 0.11.1 bug 1): number + hint parsed, path dropped, Error: not doubled', () => {
  const e = parseOsaError("/var/folders/ab/xyz/T/nexus-desktop-123-1763100000000-k3j2h1.js: execution error: Error: Error: Can't get object. (-1728)");
  assert.equal(e.number, -1728); assert.ok(e.hint); assert.doesNotMatch(e.message, /var\/folders|nexus-desktop-/); assert.doesNotMatch(e.message, /Error: Error:/);
  assert.match(e.message, /Can't get object/);
});
ok('permission hints', () => { assert.match(osaHint(-1743), /Automation/); assert.match(osaHint(-1719), /Accessibility/); assert.match(osaHint(-600), /not running/); });
ok('shortcuts noise stripped', () => {
  const noise = Array(5).fill('ERROR: Unrecognized attribute string flag \'?\' in attribute string "T@\\"NSString\\",?,R,C" for property debugDescription').join('\n');
  assert.equal(stripShortcutsNoise(noise), '');
  assert.match(stripShortcutsNoise(noise + '\nError: The operation couldn’t be completed. Couldn’t find shortcut'), /Couldn’t find shortcut/);
});
const stub = (map) => async (cmd, args) => map(cmd, args);
await (async () => {
  let r = await runOsa(stub((c) => c === 'osacompile' ? { code: 1, stdout: '', stderr: 't.applescript:4: error: Expected end of line. (-2741)' } : { code: 0, stdout: '', stderr: '' }), 'bad', 'applescript');
  assert.equal(r.ok, false); assert.equal(r.compiled, false); assert.equal(r.error.line, 4); n++; console.log('PASS osa compile failure');
  r = await runOsa(stub((c) => ({ code: 0, stdout: c === 'osascript' ? 'hello\n' : '', stderr: '' })), 'return "hello"', 'applescript');
  assert.deepEqual([r.ok, r.output], [true, 'hello']); n++; console.log('PASS osa run');
  r = await runOsa(stub(() => ({ code: 0, stdout: '', stderr: '' })), 'x', 'jxa', { validate: true });
  assert.deepEqual([r.ok, r.compiled, r.output], [true, true, undefined]); n++; console.log('PASS osa validate only');
  const s = await runShortcuts(stub(() => ({ code: 1, stdout: '', stderr: 'ERROR: Unrecognized attribute string flag x\nError: The operation couldn’t be completed. Couldn’t find shortcut' })), 'run', 'nope');
  assert.equal(s.ok, false); assert.match(s.error, /Couldn’t find shortcut/); n++; console.log('PASS shortcut not found');
  const noType = await runShortcuts(async (c, a) => { const o = a[a.indexOf('-o') + 1]; (await import('node:fs')).writeFileSync(o, ''); return { code: 0, stdout: 'M2 DESKTOP TEST\n', stderr: '' }; }, 'run', 'upper-signed', 'm2 desktop test');
  assert.equal(noType.output, 'M2 DESKTOP TEST'); n++; console.log('PASS shortcut run without output_type returns stdout when the -o file is empty (m2 bug 2)');
  const l = await runShortcuts(stub(() => ({ code: 0, stdout: 'A\nB\n', stderr: '' })), 'list');
  assert.deepEqual(l.names, ['A', 'B']); n++; console.log('PASS shortcut list');
})();
console.log(`ALL PASS (${n})`);
