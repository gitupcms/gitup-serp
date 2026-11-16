// Minimal Cloudflare API client for the egress Workers. Never logs or echoes either token.

const API = "https://api.cloudflare.com/client/v4";
export const COMPATIBILITY_DATE = "2025-01-01";

interface Envelope<T> {
  success?: boolean;
  errors?: { code: number; message: string }[];
  result: T;
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
      throw new Error(`cloudflare ${init.method ?? "GET"} ${path}: HTTP ${res.status} ${why}`.trim());
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

  /** The account's `<sub>` in `<worker>.<sub>.workers.dev`. */
  async getSubdomain(): Promise<string> {
    return (await this.call<{ subdomain: string }>("/workers/subdomain")).subdomain;
  }

  async list(prefix: string): Promise<string[]> {
    const scripts = await this.call<{ id: string }[]>("/workers/scripts");
    return scripts.map((s) => s.id).filter((id) => id.startsWith(prefix)).sort();
  }

  async remove(name: string): Promise<void> {
    await this.call(`/workers/scripts/${name}`, { method: "DELETE" });
  }
}
