#!/usr/bin/env node
import {
  createDesktopMCP
} from "./chunk-CRPMGPDG.js";
import "./chunk-ZIIANQVA.js";
import "./chunk-ZQPMRQT4.js";

// src/stdio-guard.ts
var toErr = (...a) => {
  process.stderr.write(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
};
console.log = toErr;
console.info = toErr;
console.warn = toErr;
console.debug = toErr;

// src/server.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
var made;
try {
  made = await createDesktopMCP();
} catch (e) {
  process.stderr.write(`${e.message}
`);
  process.exit(2);
}
var { server, close } = made;
await server.connect(new StdioServerTransport());
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  void close().finally(() => process.exit(0));
});
//# sourceMappingURL=server.js.map
