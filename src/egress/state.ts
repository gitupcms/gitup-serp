// `.openserp/egress.json`: the egress token and Worker URLs, shared by the CLI and the server.
// The directory defaults to `<cwd>/.openserp` and can be moved with EGRESS_STATE_DIR (e.g. a Docker volume).

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const STATE_DIR = resolve(process.env.EGRESS_STATE_DIR || ".openserp");
export const STATE_FILE = join(STATE_DIR, "egress.json");

const schema = z.object({ token: z.string().min(16), workers: z.array(z.url()) });
export type EgressState = z.infer<typeof schema>;

/** The stored state, or undefined when there is no file. Throws on a malformed file. */
export function readEgressState(file = STATE_FILE): EgressState | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`${file} is malformed: run npm run egress:up again`);
  return parsed.data;
}

export function writeEgressState(state: EgressState, file = STATE_FILE): void {
  writePrivate(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Write `data` readable by the owner only, creating the directory 0700. */
export function writePrivate(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600); // mode above only applies when the file is created
}
