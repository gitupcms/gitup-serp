// Link resolution against a fake lookup (ported from serpmaven's tests/test_links.py, MIT).
import { describe, expect, it } from "vitest";
import { parseSerp } from "../src/parse/index.js";
import type { OrganicResult } from "../src/parse/index.js";
import { destination, fillLinks, heldRefresh, type LinkAnswer, pingDestination } from "../src/scraper/links.js";

const ORIGIN = "https://www.google.com";

function pingAnswer(url: string): string {
  const script = url.replaceAll("&", "\\x26");
  return (
    '<html lang="en"><head><meta content="origin" name="referrer"><script nonce="n">' +
    `(function(){var redirectUrl='${script}';google.navigateTo(parent,window,redirectUrl);})();` +
    `</script><noscript><meta content="0;url=${url.replaceAll("&", "&amp;")}" http-equiv="refresh"></noscript></head></html>`
  );
}

/** Google's "Verifying your request" page, which names the same /goto again. */
function interstitial(token: string, delay = 3): string {
  return (
    `<html><head><meta content="${delay};url=/goto?url=${token}" http-equiv="refresh"></head>` +
    '<body><div>Verifying your request</div><div disabled="" role="button">Continue</div>' +
    `<script>(function(){var delayMillis=926;var redirectUrl='/goto?url\\x3d${token}';})();</script></body></html>`
  );
}

const PAGE =
  '<html><body><div id="rso">' +
  '<a href="/goto?url=AAA" ping="/url?sa=t&amp;source=web&amp;url=AAA&amp;ved=1"><h3>one</h3></a>' +
  '<a href="/goto?url=BBB" ping="/url?sa=t&amp;source=web&amp;url=BBB&amp;ved=2"><h3>two</h3></a>' +
  '<a href="/goto?url=CCC"><h3>no ping</h3></a>' +
  "</div></body></html>";
const PING_A = "/url?sa=t&source=web&url=AAA&ved=1";
const PING_B = "/url?sa=t&source=web&url=BBB&ved=2";
const PINGS = { AAA: PING_A, BBB: PING_B };

const results = (...tokens: string[]): OrganicResult[] =>
  tokens.map((t, i) => ({ position: i + 1, title: t, link: null, redirect_link: `${ORIGIN}/goto?url=${t}` }));
const ok = (body: string): LinkAnswer => ({ status: 200, location: "", body });
const redirect = (location: string): LinkAnswer => ({ status: 302, location, body: "" });
const SORRY = redirect("https://www.google.com/sorry/index?continue=x");

/** A lookup answering each path from `answers` in turn; records what was asked and waited. */
function fake(answers: Record<string, LinkAnswer[]>) {
  const asked: string[] = [];
  const waited: number[] = [];
  const lookup = async (url: string) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    asked.push(path);
    const a = answers[path]?.shift();
    if (!a) throw new Error(`no answer for ${path}`);
    return a;
  };
  const wait = async (ms: number) => void waited.push(ms);
  return { asked, waited, lookup, wait };
}

describe("ping parsing", () => {
  it("maps each result's /goto token to its anchor's ping URL", () => {
    expect(parseSerp(PAGE, "en").ping_paths).toEqual(PINGS);
  });

  it("reads the destination from the refresh tag or the script", () => {
    expect(pingDestination(pingAnswer("https://e.com/a?b=1&c=2"))).toBe("https://e.com/a?b=1&c=2");
    expect(pingDestination(String.raw`<script>var redirectUrl='https://e.com/x\x3dy';</script>`)).toBe("https://e.com/x=y");
    expect(pingDestination("<html>Loading...</html>")).toBeNull();
  });

  it("does not take Google's own redirects or malformed URLs for destinations", () => {
    expect(pingDestination(interstitial("AAA"))).toBeNull();
    for (const bad of [
      "https://www.google.com/goto?url=AAA",
      "https://www.google.com/url?q=x",
      "https://google.co.uk/url?q=x",
      "https://www.google.cat/url?q=x",
      "https://www.google.com./goto?url=A",
      "javascript:void(0)",
      "http://[::1/x",
      "http://example.com:bad/path",
      "https://example.com:70000/path",
    ]) {
      expect(pingDestination(pingAnswer(bad)), bad).toBeNull();
    }
    for (const kept of ["https://www.google.com/travel/flights/x.html", "https://notgoogle.com/url", "https://google.example.com/goto"]) {
      expect(destination(kept)).toBe(kept);
    }
  });

  it("reads the held page's delay and the /goto it reloads", () => {
    expect(heldRefresh(interstitial("AAA", 7))).toEqual([7, "/goto?url=AAA"]);
    expect(heldRefresh(pingAnswer("https://e.com/"))).toBeNull();
    expect(heldRefresh("<html>Loading...</html>")).toBeNull();
  });
});

describe("fillLinks", () => {
  it("resolves through the ping URL, then the /goto Location for results without one", async () => {
    const f = fake({ [PING_A]: [ok(pingAnswer("https://aaa.example/"))], "/goto?url=CCC": [redirect("https://ccc.example/")] });
    const rs = results("AAA", "CCC");
    await fillLinks(rs, PINGS, f.lookup, ORIGIN);
    expect(rs.map((r) => r.link)).toEqual(["https://aaa.example/", "https://ccc.example/"]);
    expect(f.asked).toEqual([PING_A, "/goto?url=CCC"]);
  });

  it("skips results that already have a link, and leaves a /goto without Location null", async () => {
    const f = fake({ "/goto?url=CCC": [ok("")] });
    const rs = [{ position: 1, title: "k", link: "https://kept.example/", redirect_link: `${ORIGIN}/goto?url=AAA` }, ...results("CCC")];
    await fillLinks(rs, PINGS, f.lookup, ORIGIN);
    expect(rs.map((r) => r.link)).toEqual(["https://kept.example/", null]);
    expect(f.asked).toEqual(["/goto?url=CCC"]);
  });

  it("falls back to the /goto when the ping only names Google's own redirect", async () => {
    const f = fake({ [PING_A]: [redirect("https://www.google.com/goto?url=AAA")], "/goto?url=AAA": [redirect("https://aaa.example/")] });
    const rs = results("AAA");
    await fillLinks(rs, PINGS, f.lookup, ORIGIN);
    expect(rs[0]!.link).toBe("https://aaa.example/");
  });

  it("waits out the verifying page's delay, then asks its /goto again", async () => {
    const f = fake({ [PING_B]: [ok(interstitial("BBB", 3))], "/goto?url=BBB": [redirect("https://bbb.example/page")] });
    const rs = results("BBB");
    await fillLinks(rs, PINGS, f.lookup, ORIGIN, undefined, { wait: f.wait });
    expect(rs[0]!.link).toBe("https://bbb.example/page");
    expect(f.asked).toEqual([PING_B, "/goto?url=BBB"]);
    expect(f.waited).toHaveLength(1);
    expect(f.waited[0]).toBeGreaterThan(3000);
    expect(f.waited[0]).toBeLessThanOrEqual(3500);
  });

  it("gives a link held again one more round, then leaves it null", async () => {
    const f = fake({
      [PING_A]: [ok(interstitial("AAA"))],
      [PING_B]: [ok(interstitial("BBB"))],
      "/goto?url=AAA": [ok(interstitial("AAA", 5)), redirect("https://aaa.example/")],
      "/goto?url=BBB": [ok(interstitial("BBB", 5)), ok(interstitial("BBB", 8))],
    });
    const rs = results("AAA", "BBB");
    await fillLinks(rs, PINGS, f.lookup, ORIGIN, undefined, { wait: f.wait });
    expect(rs.map((r) => r.link)).toEqual(["https://aaa.example/", null]);
    expect(f.asked.filter((p) => p === "/goto?url=BBB")).toHaveLength(2);
  });

  it("does not wait for a hold longer than worth waiting or past the budget", async () => {
    const f = fake({ [PING_A]: [ok(interstitial("AAA", 31))], [PING_B]: [ok(interstitial("BBB", 3))] });
    const rs = results("AAA", "BBB");
    await fillLinks(rs, PINGS, f.lookup, ORIGIN, undefined, { wait: f.wait, budgetMs: 2_000 });
    expect(rs.map((r) => r.link)).toEqual([null, null]);
    expect(f.waited).toEqual([]);
  });

  it("stops the page's lookups on a sorry answer", async () => {
    const f = fake({ [PING_A]: [SORRY], [PING_B]: [ok(pingAnswer("https://bbb.example/"))] });
    const rs = results("AAA", "BBB", "CCC");
    await fillLinks(rs, PINGS, f.lookup, ORIGIN, undefined, { parallel: 1 });
    expect(rs.map((r) => r.link)).toEqual([null, null, null]);
    expect(f.asked).toEqual([PING_A]);
  });

  it("leaves a failed lookup null and carries on with the rest, never throwing", async () => {
    const f = fake({ [PING_B]: [ok(pingAnswer("https://bbb.example/"))] }); // AAA's lookup throws
    const rs = results("AAA", "BBB");
    await expect(fillLinks(rs, PINGS, f.lookup, ORIGIN, undefined, { parallel: 1 })).resolves.toBeUndefined();
    expect(rs.map((r) => r.link)).toEqual([null, "https://bbb.example/"]);
  });

  it("runs at most four lookups at once and keeps each link on its result", async () => {
    let running = 0;
    let peak = 0;
    const lookup = async (url: string) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return redirect(`https://${new URL(url).searchParams.get("url")!.toLowerCase()}.example/`);
    };
    const tokens = Array.from({ length: 10 }, (_, i) => `T${i}`);
    const rs = results(...tokens);
    await fillLinks(rs, {}, lookup, ORIGIN);
    expect(rs.map((r) => r.link)).toEqual(tokens.map((t) => `https://${t.toLowerCase()}.example/`));
    expect(peak).toBe(4);
  });

  it("gives up on lookups still out when the page budget runs out", async () => {
    const lookup = (_url: string, signal: AbortSignal) =>
      new Promise<LinkAnswer>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const rs = results("AAA", "BBB", "CCC", "DDD", "EEE");
    const started = performance.now();
    await fillLinks(rs, PINGS, lookup, ORIGIN, undefined, { budgetMs: 50 });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(rs.every((r) => r.link === null)).toBe(true);
  });

  it("honours the caller's abort", async () => {
    const ac = new AbortController();
    let asked = 0;
    const lookup = (_url: string, signal: AbortSignal) => {
      asked++;
      return new Promise<LinkAnswer>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const rs = results("AAA", "BBB", "CCC", "DDD", "EEE", "FFF");
    setTimeout(() => ac.abort(new Error("timeout")), 20);
    await fillLinks(rs, PINGS, lookup, ORIGIN, ac.signal);
    expect(asked).toBe(4); // the queued ones are never sent
    expect(rs.every((r) => r.link === null)).toBe(true);
    const later = results("AAA");
    await fillLinks(later, PINGS, async () => ok(pingAnswer("https://x.example/")), ORIGIN, ac.signal);
    expect(later[0]!.link).toBeNull();
  });
});
