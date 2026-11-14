import {
  createDesktop,
  desktopMode
} from "./chunk-LAL2EA5A.js";
import "./chunk-ZQPMRQT4.js";

// src/desktop-bus-daemon.ts
import fs from "node:fs";
import path from "node:path";
var home = String(process.env.NEXUS_BROWSER_DESKTOP_HOME ?? "");
if (!home) {
  console.error("desktop-bus-daemon: NEXUS_BROWSER_DESKTOP_HOME is not set");
  process.exit(2);
}
var pidFile = path.join(home, "bus.pid");
var statusFile = path.join(home, "bus-status.json");
var args = {};
try {
  args = JSON.parse(String(process.env.NEXUS_BUS_ARGS ?? "{}"));
} catch {
}
var d = createDesktop({ mode: desktopMode() ?? "real", home, guestDir: process.env.NEXUS_BROWSER_GUEST_DIR || void 0 });
var writeStatus = async (extra = {}) => {
  try {
    const s = JSON.parse((await d.handle({ action: "bus", op: "status" })).content[0].text);
    const w = JSON.parse((await d.handle({ action: "watch", op: "status" })).content[0].text);
    fs.writeFileSync(`${statusFile}.tmp`, JSON.stringify({ ...s, daemon: true, pid: process.pid, watch_polls: w.polls, watch_p50_ms: w.poll_p50_ms, updated: (/* @__PURE__ */ new Date()).toISOString(), ...extra }, null, 1));
    fs.renameSync(`${statusFile}.tmp`, statusFile);
  } catch {
  }
};
var cleanup = () => {
  try {
    if (fs.readFileSync(pidFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(pidFile);
  } catch {
  }
};
var shutdown = async (why) => {
  try {
    await d.handle({ action: "bus", op: "stop" });
  } catch {
  }
  await writeStatus({ on: false, stopped: why });
  cleanup();
  process.exit(0);
};
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("exit", cleanup);
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));
var r = await d.handle({ action: "bus", op: "start", ...args, detach: false });
await writeStatus({ start_result: String(r.content?.[0]?.text ?? "").slice(0, 400), start_error: r.isError === true });
if (r.isError) {
  cleanup();
  process.exit(1);
}
setInterval(() => {
  void writeStatus();
}, 15e3);
//# sourceMappingURL=desktop-bus-daemon.js.map
