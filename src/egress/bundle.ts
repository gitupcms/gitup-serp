// Bundle the Worker into one ES module string for the Cloudflare API. No wrangler.

import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ENTRY = fileURLToPath(new URL("../../worker/src/index.ts", import.meta.url));

export async function bundleWorker(): Promise<string> {
  const out = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    target: "es2022",
    minify: true,
    external: ["cloudflare:sockets"],
    logLevel: "silent",
  });
  return out.outputFiles[0]!.text;
}
