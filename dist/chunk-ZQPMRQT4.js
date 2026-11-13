// src/desktop-script.ts
var HOTKEYS = {
  // launch / switch
  spotlight: { mac: "cmd+space", note: "type an app/file name + Return to open it \u2014 usually faster than any Dock/Finder navigation" },
  app_switcher: { mac: "cmd+Tab", win: "alt+Tab" },
  next_window_same_app: { mac: "cmd+`" },
  hide_app: { mac: "cmd+h" },
  hide_others: { mac: "cmd+alt+h" },
  minimize: { mac: "cmd+m", win: "win+Down" },
  close_window: { mac: "cmd+w", win: "ctrl+w", note: "win: closes a document/tab; alt+F4 closes the window" },
  close_app_window: { win: "alt+F4" },
  quit_app: { mac: "cmd+q", win: "alt+F4" },
  force_quit_dialog: { mac: "cmd+alt+Escape", win: "ctrl+shift+Escape" },
  run_dialog: { win: "win+r", note: "type a program/path + Return" },
  start_menu: { win: "win" },
  // documents / editing
  new: { mac: "cmd+n", win: "ctrl+n" },
  open: { mac: "cmd+o", win: "ctrl+o" },
  save: { mac: "cmd+s", win: "ctrl+s" },
  save_as: { mac: "cmd+shift+s", win: "F12", note: "win: F12 in Office-style apps; otherwise use the File menu (alt+f)" },
  print: { mac: "cmd+p", win: "ctrl+p" },
  undo: { mac: "cmd+z", win: "ctrl+z" },
  redo: { mac: "cmd+shift+z", win: "ctrl+y" },
  cut: { mac: "cmd+x", win: "ctrl+x" },
  copy: { mac: "cmd+c", win: "ctrl+c" },
  paste: { mac: "cmd+v", win: "ctrl+v" },
  select_all: { mac: "cmd+a", win: "ctrl+a" },
  find: { mac: "cmd+f", win: "ctrl+f" },
  find_next: { mac: "cmd+g", win: "F3" },
  preferences: { mac: "cmd+," },
  // the universal menu invoker: Help → search box finds ANY menu item by name; Return runs it
  help_search: { mac: "cmd+shift+/", note: "then type part of a menu item's name + Return: runs that item in the front app" },
  menu_bar: { mac: "ctrl+F2", win: "alt", note: "keyboard into the menu bar; win: then the underlined letters (alt+f = File)" },
  file_menu: { win: "alt+f" },
  edit_menu: { win: "alt+e" },
  view_menu: { win: "alt+v" },
  dock: { mac: "ctrl+F3" },
  // Finder + every Open/Save dialog
  go_to_folder: { mac: "cmd+shift+g", note: "in Finder AND in any Open/Save dialog: type a path + Return \u2014 skips all folder clicking" },
  dialog_path: { win: "alt+d", note: "win Open/Save dialogs and Explorer: focus the address/path box; or type a full path into File name" },
  show_hidden_files: { mac: "cmd+shift+." },
  finder_home: { mac: "cmd+shift+h" },
  finder_desktop: { mac: "cmd+shift+d" },
  finder_apps: { mac: "cmd+shift+a" },
  finder_downloads: { mac: "cmd+alt+l" },
  explorer: { win: "win+e" },
  dont_save: { mac: "cmd+d", note: 'in a "Save changes?" sheet' },
  // windows / spaces
  full_screen: { mac: "ctrl+cmd+f", win: "F11" },
  mission_control: { mac: "ctrl+Up" },
  app_windows: { mac: "ctrl+Down" },
  space_left: { mac: "ctrl+Left" },
  space_right: { mac: "ctrl+Right" },
  show_desktop: { mac: "F11", win: "win+d" },
  lock_screen: { mac: "ctrl+cmd+q", win: "win+l" },
  // tabs / browsers
  new_tab: { mac: "cmd+t", win: "ctrl+t" },
  next_tab: { mac: "ctrl+Tab", win: "ctrl+Tab" },
  prev_tab: { mac: "ctrl+shift+Tab", win: "ctrl+shift+Tab" },
  reopen_tab: { mac: "cmd+shift+t", win: "ctrl+shift+t" },
  address_bar: { mac: "cmd+l", win: "ctrl+l" },
  // text navigation
  line_start: { mac: "cmd+Left", win: "Home" },
  line_end: { mac: "cmd+Right", win: "End" },
  doc_start: { mac: "cmd+Up", win: "ctrl+Home" },
  doc_end: { mac: "cmd+Down", win: "ctrl+End" },
  delete_word: { mac: "alt+BackSpace", win: "ctrl+BackSpace" },
  // capture
  screenshot_full: { mac: "cmd+shift+3", win: "PrintScreen" },
  screenshot_area: { mac: "cmd+shift+4", win: "win+shift+s" },
  emoji: { mac: "ctrl+cmd+space", win: "win+." }
};
function hotkeyFor(name, platform) {
  const h = HOTKEYS[name];
  if (!h) throw new Error(`unknown hotkey "${name}" \u2014 list them with {action:"hotkey", list:true}`);
  const k = h[platform];
  if (!k) throw new Error(`hotkey "${name}" has no ${platform === "mac" ? "macOS" : "Windows"} binding${h.note ? ` (${h.note})` : ""}`);
  return k;
}
function hotkeyCatalog(platform) {
  return Object.entries(HOTKEYS).filter(([, h]) => h[platform]).map(([n, h]) => `${n}	${h[platform]}${h.note ? `	\u2014 ${h.note}` : ""}`).join("\n");
}
var FKEY = (n) => String.fromCharCode(63236 + n - 1);
var NAMED_EQUIV = {
  up: "\uF700",
  down: "\uF701",
  left: "\uF702",
  right: "\uF703",
  home: "\uF729",
  end: "\uF72B",
  pageup: "\uF72C",
  page_up: "\uF72C",
  pagedown: "\uF72D",
  page_down: "\uF72D",
  return: "\r",
  enter: "\r",
  tab: "	",
  escape: "\x1B",
  esc: "\x1B",
  delete: "\b",
  backspace: "\b",
  space: " "
};
function comboToKeyEquivalent(combo) {
  const parts = combo.trim().split("+").map((s) => s.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = parts.map((m) => m.toLowerCase());
  const known = { cmd: "@", command: "@", super: "@", opt: "~", option: "~", alt: "~", ctrl: "^", control: "^", shift: "$" };
  let out = "";
  for (const m of ["cmd", "command", "super", "opt", "option", "alt", "ctrl", "control", "shift"]) if (mods.includes(m) && !out.includes(known[m])) out += known[m];
  for (const m of mods) if (!(m in known)) throw new Error(`unknown modifier "${m}" (use cmd, opt/alt, ctrl, shift)`);
  if (!out.includes("@") && !out.includes("^")) throw new Error("an app shortcut needs cmd or ctrl (macOS ignores bare-key menu equivalents)");
  const f = /^f(\d{1,2})$/i.exec(key);
  if (f && +f[1] >= 1 && +f[1] <= 20) return out + FKEY(+f[1]);
  const named = NAMED_EQUIV[key.toLowerCase()];
  if (named) return out + named;
  if ([...key].length !== 1) throw new Error(`key "${key}" \u2014 use one character, F1\u2013F20, or Up/Down/Left/Right/Home/End/PageUp/PageDown/Return/Tab/Escape/Delete/Space`);
  return out + key.toLowerCase();
}
function keyEquivalentTitle(item) {
  return Array.isArray(item) ? item.length === 1 ? item[0] : item.map((s) => `\x1B${s}`).join("") : item;
}
function parseKeyEquivalents(text) {
  const out = {};
  const unq = (s) => s.replace(/^"|"$/g, "").replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\U([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\033/g, "\x1B");
  for (const m of text.matchAll(/^\s*("(?:[^"\\]|\\.)*"|[^\s=]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;\s]+);/gm)) out[unq(m[1])] = unq(m[2]);
  return out;
}
var XY = (s, line) => {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s ?? "");
  if (!m) throw new Error(`line ${line}: expected X,Y but got "${s ?? ""}"`);
  return [Number(m[1]), Number(m[2])];
};
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(n|t|"|\\)/g, (_, c) => ({ n: "\n", t: "	", '"': '"', "\\": "\\" })[c]);
  return t;
}
function substitute(s, vars, line) {
  return s.replace(/\$\{([A-Za-z_][\w]*)\}/g, (_, n) => {
    if (!(n in vars)) throw new Error(`line ${line}: variable \${${n}} is not set`);
    return vars[n];
  });
}
function parseLine(raw, line) {
  const src = raw.replace(/^\s+|\s+$/g, "");
  if (!src || src.startsWith("#")) return null;
  const sp = src.indexOf(" ");
  const verb = (sp < 0 ? src : src.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? "" : src.slice(sp + 1).trim();
  const words = rest.split(/\s+/).filter(Boolean);
  const A = (action) => ({ line, src, kind: "action", action });
  switch (verb) {
    case "hotkey": {
      if (!words[0]) throw new Error(`line ${line}: hotkey needs a name`);
      const pl = words.slice(1).map((w) => /^platform=(win|mac)$/i.exec(w)).find(Boolean);
      if (words.slice(1).some((w) => !/^platform=(win|mac)$/i.test(w))) throw new Error(`line ${line}: hotkey options: platform=win|mac`);
      return A({ action: "hotkey", name: words[0], ...pl ? { platform: pl[1].toLowerCase() } : {} });
    }
    case "key":
      if (!rest) throw new Error(`line ${line}: key needs a combo`);
      return A({ action: "key", text: rest });
    // 'type -- TEXT' / 'paste -- TEXT' = everything after '-- ' is literal (text that itself starts with '-' — 0.5.1 report)
    case "type": {
      const om = /^((?:(?:delay=\d+|paste)\s+)+)-- (.*)$/s.exec(rest);
      if (om) {
        const o = { action: "type", text: unquote(om[2]) };
        for (const opt of om[1].trim().split(/\s+/)) {
          if (opt === "paste") o.type_via = "paste";
          else o.char_delay_ms = Math.min(500, Number(opt.slice(6)));
        }
        if (!o.text) throw new Error(`line ${line}: type needs text`);
        return A(o);
      }
      const tx = rest.startsWith("-- ") ? rest.slice(3) : rest;
      if (!tx) throw new Error(`line ${line}: type needs text`);
      return A({ action: "type", text: unquote(tx) });
    }
    case "paste": {
      const tx = rest.startsWith("-- ") ? rest.slice(3) : rest;
      if (!tx) throw new Error(`line ${line}: paste needs text`);
      return A({ action: "type", text: unquote(tx), type_via: "paste" });
    }
    case "click":
    case "dclick":
    case "tclick":
    case "rclick":
      return A({ action: { click: "left_click", dclick: "double_click", tclick: "triple_click", rclick: "right_click" }[verb], coordinate: XY(words[0], line) });
    case "move":
      return A({ action: "mouse_move", coordinate: XY(words[0], line) });
    case "drag":
      return A({ action: "left_click_drag", start_coordinate: XY(words[0], line), coordinate: XY(words[1], line) });
    case "scroll": {
      const dir = (words[1] ?? "down").toLowerCase();
      if (!["up", "down", "left", "right"].includes(dir)) throw new Error(`line ${line}: scroll direction up|down|left|right`);
      return A({ action: "scroll", coordinate: XY(words[0], line), scroll_direction: dir, scroll_amount: words[2] ? Number(words[2]) : 3 });
    }
    case "fill": {
      const sep = rest.indexOf(" -- ");
      const head = (sep < 0 ? rest : rest.slice(0, sep)).split(/\s+/).filter(Boolean);
      const text = sep < 0 ? "" : unquote(rest.slice(sep + 4));
      const a = { action: "fill_field", coordinate: XY(head[0], line), text };
      for (const opt of head.slice(1)) {
        const [k, v] = opt.split("=");
        if (k === "commit") a.commit_key = { tab: "Tab", enter: "Return", return: "Return", none: "none" }[(v ?? "").toLowerCase()] ?? v;
        else if (k === "delay") a.char_delay_ms = Number(v);
        else if (k === "escape") a.escape_first = true;
        else if (k === "paste") a.type_via = "paste";
        else if (k === "select") a.select = v;
        else throw new Error(`line ${line}: unknown fill option "${opt}" (commit=, delay=, escape, paste, select=)`);
      }
      if (sep < 0) throw new Error(`line ${line}: fill needs "-- TEXT" after the options`);
      return A(a);
    }
    case "menu": {
      const at = /\s@(.+)$/.exec(rest);
      const p = (at ? rest.slice(0, at.index) : rest).split(">").map((s) => s.trim()).filter(Boolean);
      if (p.length < 2) throw new Error(`line ${line}: menu needs a path like "File > Save As\u2026"`);
      return A({ action: "menu", path: p, ...at ? { app: at[1].trim() } : {} });
    }
    case "shortcut": {
      const [app, item, keys] = rest.split("|").map((s) => s.trim());
      if (!app || !item || !keys) throw new Error(`line ${line}: shortcut App | Menu Item (or File > Item) | cmd+opt+k`);
      return A({ action: "shortcut", op: "set", app, menu_item: item.includes(">") ? item.split(">").map((s) => s.trim()) : item, keys });
    }
    case "launch":
      return A({ action: "launch", app: rest });
    case "focus":
      return A({ action: "focus_window", window: rest });
    case "wait":
      return A({ action: "wait", duration: Number(words[0] ?? 1) });
    case "zoom": {
      const n = (words[0] ?? "").split(",").map(Number);
      if (n.length !== 4 || !n.every(Number.isFinite)) throw new Error(`line ${line}: zoom X1,Y1,X2,Y2`);
      return A({ action: "zoom", region: n });
    }
    case "screenshot":
      return A({ action: "screenshot" });
    case "wait_window": {
      if (!words[0]) throw new Error(`line ${line}: wait_window needs a title pattern`);
      const t = Number(words.at(-1));
      return { line, src, kind: "wait_window", pattern: Number.isFinite(t) && words.length > 1 ? words.slice(0, -1).join(" ") : rest, timeoutS: Number.isFinite(t) && words.length > 1 ? t : 10 };
    }
    case "set": {
      if (!words[0]) throw new Error(`line ${line}: set NAME VALUE`);
      return { line, src, kind: "set", name: words[0], value: unquote(rest.slice(words[0].length)) };
    }
    case "macro": {
      if (!words[0]) throw new Error(`line ${line}: macro NAME [k=v \u2026]`);
      const vars = {};
      const argsSrc = rest.slice(words[0].length).trim();
      let used = 0;
      for (const m of argsSrc.matchAll(/([A-Za-z_]\w*)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
        vars[m[1]] = unquote(m[2]);
        used += m[0].length;
      }
      if (argsSrc.replace(/([A-Za-z_]\w*)=("(?:[^"\\]|\\.)*"|\S+)/g, "").trim()) throw new Error(`line ${line}: macro args are k=v (quote values with spaces)`);
      return { line, src, kind: "macro", name: words[0], vars };
    }
  }
  throw new Error(`line ${line}: unknown command "${verb}" (hotkey key type paste fill click dclick tclick rclick move drag scroll menu shortcut launch focus wait wait_window zoom screenshot set macro)`);
}
var MACRO_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var KNOWN_MODS = /* @__PURE__ */ new Set(["cmd", "command", "super", "meta", "win", "ctrl", "control", "alt", "option", "opt", "shift", "fn"]);
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function closest(word, candidates) {
  const w = word.toLowerCase();
  const sub = candidates.filter((c) => c.toLowerCase().includes(w) || w.includes(c.toLowerCase()));
  const near = candidates.map((c) => [c, editDistance(w, c.toLowerCase())]).filter(([, n]) => n <= Math.max(2, Math.round(w.length * 0.4))).sort((x, y) => x[1] - y[1]).map(([c]) => c);
  return [.../* @__PURE__ */ new Set([...sub, ...near])].slice(0, 3);
}
function parseMenuList(text) {
  return text.split("\n").slice(1).map((l) => l.split("	")[0].split(" > ").map((s) => s.trim())).filter((p) => p.length >= 2 && !p.includes("\u2026"));
}
var normTitle = (s) => s.toLowerCase().replace(/(…|\.\.\.)$/, "").trim();
function validateScript(src, o) {
  const issues = [];
  let steps = 0, menusChecked = false;
  const menuCache = /* @__PURE__ */ new Map();
  const walk = (text, vars, stack) => {
    const macro = stack.at(-1);
    const add = (line, level, msg, hint) => issues.push({ line, ...macro ? { macro } : {}, level, msg, ...hint ? { hint } : {} });
    const defined = new Set(Object.keys(vars));
    text.split("\n").forEach((raw, i) => {
      const ln = i + 1;
      const missing = [...raw.matchAll(/\$\{([A-Za-z_]\w*)\}/g)].map((m) => m[1]).filter((n) => !defined.has(n));
      for (const n of new Set(missing)) add(ln, "error", `variable \${${n}} is not set`, defined.size ? `known: ${[...defined].join(", ")}` : "pass it in vars, or set it on an earlier line");
      let st = null, perr = "";
      for (const ph of ["0", "0,0"]) {
        try {
          st = parseLine(raw.replace(/\$\{([A-Za-z_]\w*)\}/g, (_x, n) => defined.has(n) ? vars[n] ?? ph : ph), ln);
          perr = "";
          break;
        } catch (e) {
          perr = String(e?.message ?? e).replace(/^line \d+: /, "");
        }
      }
      if (perr) {
        add(ln, "error", perr);
        return;
      }
      if (!st) return;
      steps++;
      if (st.kind === "set") {
        defined.add(st.name);
        vars = { ...vars, [st.name]: st.value };
        return;
      }
      if (st.kind === "wait_window") {
        try {
          new RegExp(st.pattern, "i");
        } catch (e) {
          add(ln, "error", `wait_window pattern is not a valid regex: ${e?.message ?? e}`);
        }
        if (st.timeoutS > 300) add(ln, "warn", `wait_window timeout ${st.timeoutS} s is long`);
        return;
      }
      if (st.kind === "macro") {
        if (stack.includes(st.name)) {
          add(ln, "error", `macro ${st.name} calls itself (${[...stack, st.name].join(" \u2192 ")})`);
          return;
        }
        if (stack.length >= 5) {
          add(ln, "error", "macro nesting deeper than 5");
          return;
        }
        const m = o.readMacro?.(st.name) ?? null;
        if (!m) {
          const sug = closest(st.name, o.macroNames ?? []);
          add(ln, "error", `no saved macro "${st.name}"`, sug.length ? `did you mean ${sug.join(" / ")}?` : 'macro {op:"list"} shows the saved ones');
          return;
        }
        walk(m.script, { ...m.vars ?? {}, ...vars, ...st.vars }, [...stack, st.name]);
        return;
      }
      const a = st.action;
      switch (a.action) {
        case "hotkey": {
          const plat = a.platform ?? o.platform, h = HOTKEYS[a.name];
          if (!h) {
            const sug = closest(a.name, Object.keys(HOTKEYS));
            add(ln, "error", `unknown hotkey "${a.name}"`, sug.length ? `did you mean ${sug.join(" / ")}?` : "hotkey {list:true} shows the catalog");
          } else if (!h[plat]) add(ln, "error", `hotkey "${a.name}" has no ${plat === "mac" ? "macOS" : "Windows"} binding`, h.note);
          break;
        }
        case "key":
          for (const combo of String(a.text).trim().split(/\s+/)) {
            const parts = combo.split("+");
            if (parts.some((p) => !p)) {
              add(ln, "error", `key combo "${combo}" has an empty part`);
              continue;
            }
            for (const m of parts.slice(0, -1)) if (!KNOWN_MODS.has(m.toLowerCase())) add(ln, "error", `"${m}" in "${combo}" is not a modifier`, "modifiers: cmd ctrl alt/opt shift fn (win/super = cmd)");
          }
          break;
        case "menu":
        case "shortcut": {
          if (!o.macos) {
            add(ln, "error", `${a.action} lines are macOS-only`, "on X11 / inside a Windows VM use hotkeys (alt+letter opens menus)");
            break;
          }
          if (a.action !== "menu") break;
          const key = `${a.app ?? ""}\0${a.path[0]}`;
          if (!menuCache.has(key)) menuCache.set(key, o.menuPaths?.(a.app, a.path[0]) ?? null);
          const tree = menuCache.get(key);
          if (!tree) break;
          menusChecked = true;
          let level = tree;
          for (let d = 0; d < a.path.length; d++) {
            const want = normTitle(a.path[d]);
            const next = level.filter((p) => p.length > d && normTitle(p[d]) === want);
            if (!next.length) {
              const sibs = [...new Set(level.filter((p) => p.length > d).map((p) => p[d]))];
              const sug = closest(a.path[d], sibs);
              add(ln, "error", `menu "${a.path.slice(0, d + 1).join(" > ")}" not found${a.app ? ` in ${a.app}` : ""}`, sug.length ? `did you mean ${sug.join(" / ")}?` : `there: ${sibs.slice(0, 12).join(", ")}`);
              break;
            }
            level = next;
          }
          break;
        }
        case "launch":
          if (o.apps && !o.apps.includes(a.app)) add(ln, "error", `"${a.app}" is not in the launch allow-list`, `allowed: ${o.apps.join(", ")} (NEXUS_BROWSER_DESKTOP_APPS)`);
          break;
        case "wait":
          if (!Number.isFinite(a.duration) || a.duration < 0) add(ln, "error", "wait needs a number of SECONDS");
          else if (a.duration > 60) add(ln, "error", `wait ${a.duration} \u2014 waits are in SECONDS (did you mean ${a.duration / 1e3} s?)`, "use wait 1 or wait 2; wait_window REGEX waits for the real event");
          else if (a.duration > 10) add(ln, "warn", `wait ${a.duration} s is long \u2014 wait_window REGEX waits for the real event`);
          break;
      }
      if (o.screen) for (const c of [a.coordinate, a.start_coordinate].filter(Array.isArray)) {
        if (c[0] < 0 || c[1] < 0 || c[0] > o.screen.width || c[1] > o.screen.height)
          add(ln, "warn", `coordinate ${c.join(",")} is outside the screenshot (${o.screen.width}\xD7${o.screen.height})`);
      }
    });
  };
  walk(src, { ...o.vars ?? {} }, []);
  return { ok: !issues.some((i) => i.level === "error"), steps, issues, menusChecked };
}
function formatValidateReport(r, liveMenus) {
  const errs = r.issues.filter((i) => i.level === "error").length, warns = r.issues.length - errs;
  const head = `${r.ok ? "VALID" : "INVALID"} \u2014 ${r.steps} steps, ${errs} error(s), ${warns} warning(s); nothing was run. menus: ${liveMenus === "checked" && !r.menusChecked ? "none in script" : liveMenus}`;
  return [head, ...r.issues.map((i) => `${i.level === "error" ? "ERROR" : "warn "} ${i.macro ? `macro ${i.macro} ` : ""}line ${i.line}: ${i.msg}${i.hint ? ` \u2014 ${i.hint}` : ""}`)].join("\n");
}

export {
  HOTKEYS,
  hotkeyFor,
  hotkeyCatalog,
  comboToKeyEquivalent,
  keyEquivalentTitle,
  parseKeyEquivalents,
  unquote,
  substitute,
  parseLine,
  MACRO_NAME,
  closest,
  parseMenuList,
  validateScript,
  formatValidateReport
};
//# sourceMappingURL=chunk-ZQPMRQT4.js.map
