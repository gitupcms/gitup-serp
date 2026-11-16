import { describe, expect, it, vi } from "vitest";
import { CloudflareApi, COMPATIBILITY_DATE } from "../src/egress/cf.js";

function mockFetch(result: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify({ success: status < 400, errors: status < 400 ? [] : [{ code: 10000, message: "bad" }], result }), { status }),
  );
}

describe("CloudflareApi", () => {
  it("deploy sends a multipart module upload with the secret binding", async () => {
    const f = mockFetch({});
    await new CloudflareApi("api-tok", "acc1", f).deploy("openserp-egress-001", "export default {}", "egress-tok");

    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc1/workers/scripts/openserp-egress-001");
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer api-tok");

    const form = init?.body as FormData;
    const meta = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(meta).toEqual({
      main_module: "index.js",
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [{ type: "secret_text", name: "EGRESS_TOKEN", text: "egress-tok" }],
    });
    const mod = form.get("index.js") as File;
    expect(mod.name).toBe("index.js");
    expect(mod.type).toBe("application/javascript+module");
    expect(await mod.text()).toBe("export default {}");
  });

  it("enableSubdomain, getSubdomain, list, remove", async () => {
    const f = mockFetch({ subdomain: "me" });
    const cf = new CloudflareApi("t", "a", f);
    await cf.enableSubdomain("w");
    expect(f.mock.calls[0]![0]).toMatch(/\/workers\/scripts\/w\/subdomain$/);
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({ enabled: true });
    expect(await cf.getSubdomain()).toBe("me");

    const l = mockFetch([{ id: "openserp-egress-002" }, { id: "other" }, { id: "openserp-egress-001" }]);
    expect(await new CloudflareApi("t", "a", l).list("openserp-egress-")).toEqual(["openserp-egress-001", "openserp-egress-002"]);

    const d = mockFetch(null);
    await new CloudflareApi("t", "a", d).remove("w");
    expect(d.mock.calls[0]![1]!.method).toBe("DELETE");
  });

  it("errors carry the API message but never the token", async () => {
    const err = await new CloudflareApi("secret-api-token", "a", mockFetch(null, 403)).remove("w").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 403 10000 bad/);
    expect((err as Error).message).not.toContain("secret-api-token");
  });
});
