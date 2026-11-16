// Minimal Cloudflare API client for the egress Workers. Never logs or echoes either token.

import { randomBytes } from "node:crypto";

const API ="https://api.cloudflare.com/client/v4";
export const COMPATIBILITY_DATE = "2025-01-01";

interface Envelope<T> {
  success?: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

export class CloudflareError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class CloudflareApi {
  constructor(
    private readonly token: string,
    private readonly account: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(`${API}/accounts/${this.account}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.headers as Record<string, string>) },
    });
    const body = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !body?.success) {
      const why = body?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? "";
      throw new CloudflareError(`cloudflare ${init.method ?? "GET"} ${path}: HTTP ${res.status} ${why}`.trim(), res.status);
    }
    return body.result;
  }

  /** Upload `script` as an ES module Worker with EGRESS_TOKEN as a secret binding. */
  async deploy(name: string, script: string, secretToken: string): Promise<void> {
    const metadata = {
      main_module: "index.js",
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [{ type: "secret_text", name: "EGRESS_TOKEN", text: secretToken }],
    };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("index.js", new Blob([script], { type: "application/javascript+module" }), "index.js");
    await this.call(`/workers/scripts/${name}`, { method: "PUT", body: form });
  }

  async enableSubdomain(name: string): Promise<void> {
    await this.call(`/workers/scripts/${name}/subdomain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
  }

  /** The account's `<sub>` in `<worker>.<sub>.workers.dev`, or undefined when the account has none yet. */
  async getSubdomain(): Promise<string | undefined> {
    try {
      return (await this.call<{ subdomain?: string }>("/workers/subdomain")).subdomain || undefined;
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** The account's workers.dev subdomain, creating a random `openserp-xxxxxxxx` one when missing. */
  async ensureSubdomain(): Promise<string> {
    const have = await this.getSubdomain();
    if (have) return have;
    for (let attempt = 0; ; attempt++) {
      const subdomain = `openserp-${randomBytes(4).toString("hex")}`;
      try {
        await this.call("/workers/subdomain", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subdomain }),
        });
        return subdomain;
      } catch (err) {
        // Name taken: Cloudflare answers 409 (or 400 with a "taken" error); one retry with a fresh name.
        if (attempt > 0 || !(err instanceof CloudflareError) || (err.status !== 409 && err.status !== 400)) throw err;
      }
    }
  }

  async list(prefix: string): Promise<string[]> {
    const scripts = await this.call<{ id: string }[]>("/workers/scripts");
    return scripts.map((s) => s.id).filter((id) => id.startsWith(prefix)).sort();
  }

  async remove(name: string): Promise<void> {
    await this.call(`/workers/scripts/${name}`, { method: "DELETE" });
  }
}
