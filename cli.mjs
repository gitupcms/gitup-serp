#!/usr/bin/env node
// npm `bin` entry: runs the TypeScript CLI through the local tsx, so tsx need not be on PATH.
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = import.meta.dirname;
const child = spawn(resolve(root, "node_modules/.bin/tsx"), [resolve(root, "src/cli/index.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});

// SIGINT from a terminal already reaches the child (same process group); forwarding it would send a second one.
const noop = () => {};
const forward = (sig) => () => child.kill(sig);
process.on("SIGINT", noop);
process.on("SIGTERM", forward("SIGTERM"));
process.on("SIGHUP", forward("SIGHUP"));

child.on("error", (err) => {
  console.error(`gitup-serp: cannot start tsx: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
