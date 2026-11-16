// npm run egress:up [-- N] | egress:down | egress:ls. Needs CF_API_TOKEN and CF_ACCOUNT_ID.

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { bundleWorker } from "./bundle.js";
import { CloudflareApi } from "./cf.js";
import { readEgressState, STATE_FILE, writeEgressState } from "./state.js";
import { dailyLimit, readUsage } from "./usage.js";

// up and down replace every Worker with this prefix; CI uses its own so it can't remove yours.
const PREFIX = `${process.env.EGRESS_PREFIX || "openserp-egress"}-`;
if (!/^[a-z0-9][a-z0-9-]{0,40}-$/.test(PREFIX)) throw new Error("EGRESS_PREFIX: lowercase letters, digits and dashes only");
const workerName = (i: number) => `${PREFIX}${String(i).padStart(3, "0")}`;

function api(): CloudflareApi {
  const { CF_API_TOKEN, CF_ACCOUNT_ID } = process.env;
  if (!CF_API_TOKEN || !CF_ACCOUNT_ID) throw new Error("CF_API_TOKEN and CF_ACCOUNT_ID must be set (e.g. in .env)");
  return new CloudflareApi(CF_API_TOKEN, CF_ACCOUNT_ID);
}

async function up(n: number) {
  const cf = api();
  const prev = readEgressState();
  const token = prev?.token ?? randomBytes(32).toString("base64url");
  // Save the token before deploying so a partial failure can be retried with the same secret.
  writeEgressState({ token, workers: prev?.workers ?? [] });

  const script = await bundleWorker();
  const sub = await cf.ensureSubdomain();
  const workers: string[] = [];
  for (let i = 1; i <= n; i++) {
    const name = workerName(i);
    await cf.deploy(name, script, token);
    await cf.enableSubdomain(name);
    workers.push(`https://${name}.${sub}.workers.dev`);
    console.error(`deployed ${name}`);
  }
  const wanted = new Set(Array.from({ length: n }, (_, i) => workerName(i + 1)));
  for (const name of await cf.list(PREFIX)) {
    if (!wanted.has(name)) {
      await cf.remove(name);
      console.error(`removed ${name}`);
    }
  }
  writeEgressState({ token, workers });
  console.error(`egress: ${n} workers, state in ${STATE_FILE}`);
}

async function down() {
  const cf = api();
  for (const name of await cf.list(PREFIX)) {
    await cf.remove(name);
    console.error(`removed ${name}`);
  }
  rmSync(STATE_FILE, { force: true });
}

async function ls() {
  const names = await api().list(PREFIX);
  for (const name of names) console.log(name);
  const state = readEgressState();
  console.error(`${names.length} deployed, ${state?.workers.length ?? 0} in ${STATE_FILE}`);
  console.error(`today (UTC): ${readUsage()} of ${dailyLimit()} Worker requests`);
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "up") {
    const n = arg === undefined ? 3 : Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error("usage: egress:up [N], 1 <= N <= 999");
    await up(n);
  } else if (cmd === "down") await down();
  else if (cmd === "ls") await ls();
  else throw new Error("usage: cli.ts up [N] | down | ls");
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
