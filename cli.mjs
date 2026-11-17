#!/usr/bin/env node
// npm `bin` entry. Runs the TypeScript sources through tsx, resolved from wherever npm put it,
// with `.env` from the current directory.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = import.meta.dirname;
const [command, ...rest] = process.argv.slice(2);

const CURL_URL = "https://github.com/lexiforest/curl-impersonate/releases/download/v2.3.2/curl-impersonate-v2.3.2.x86_64-linux-gnu.tar.gz";
const entries = {
  serve: "src/index.ts",
  mcp: "src/mcp/index.ts",
  egress: "src/egress/cli.ts",
  canary: "src/cli/canary.ts",
};

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: "inherit", ...opts });
  // SIGINT from a terminal already reaches the child (same process group); forwarding it would send a second one.
  process.on("SIGINT", () => {});
  for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
  child.on("error", (err) => {
    console.error(`gitup-serp: cannot start ${cmd}: ${err.message}`);
    process.exit(1);
  });
  return new Promise((done) =>
    child.on("exit", (code, signal) => {
      if (signal) {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      } else done(code ?? 1);
    }),
  );
}

let code;
if (command === "setup") {
  // Into the package directory, where src/scraper looks for them.
  code = await run("sh", ["-c", `mkdir -p bin && curl -fsSL ${CURL_URL} | tar -xz -C bin`], { cwd: root });
  if (code === 0) {
    // patchright exports no `cli.js` subpath; it sits next to the main entry.
    const patchright = resolve(dirname(fileURLToPath(import.meta.resolve("patchright"))), "cli.js");
    code = await run(process.execPath, [patchright, "install", "chromium"], {
      cwd: root,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(root, ".browsers") },
    });
  }
} else {
  const entry = entries[command] ?? "src/cli/index.ts";
  const args = entries[command] ? rest : process.argv.slice(2);
  const env = existsSync(".env") ? ["--env-file=.env"] : [];
  code = await run(process.execPath, [...env, "--import", import.meta.resolve("tsx"), resolve(root, entry), ...args]);
}
process.exit(code);
