// One browser: one temporary profile on one proxy session. Ported from serpmaven's browser.py (MIT).
//
// - Patchright, headful: headless builds announce `HeadlessChrome` in the UA.
// - A persistent context with `viewport: null` (no_viewport), so the page reports the real screen.
// - `locale` and `timezoneId` are never set: through the context, the main thread and Web Workers
//   would disagree.
// - The proxy, credentials included, goes straight to patchright. No local relay.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserContext, Page, Response } from "patchright";
import type { BrowserSide, Fetched, Headers } from "./hybrid.js";
import type { ProxyEndpoint } from "./proxy.js";

export const BROWSERS_DIR = resolve(import.meta.dirname, "../../.browsers");
export const GOOGLE = "https://www.google.com";
const NAV_TIMEOUT_MS = 60_000;
const WARM_TIMEOUT_MS = 30_000;
const READY = "#rso, #search";
// Reject first: it sets the smaller cookie. The middle one is the redirect form served to EU exits.
const CONSENT_BUTTONS = [
  "button#W0wltc",
  'form[action="https://consent.google.com/save"]:has(input[name="set_eom"][value="true"]) button',
  "button#L2AGLb",
];
/** How the browser reports a navigation cut short by another one. */
const INTERRUPTED_BY = "is interrupted by another navigation to";

export class Browser implements BrowserSide {
  headers: Headers | null = null;
  /** Results pages loaded since this browser (re)started. */
  pages = 0;

  private constructor(
    private readonly launch: () => Promise<BrowserContext>,
    private context: BrowserContext,
    private page: Page,
    private readonly profile: string,
    private readonly origin: string,
  ) {}

  static async open(proxy: ProxyEndpoint | null, origin = GOOGLE): Promise<Browser> {
    // Read by patchright when it is first loaded, hence the late import.
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= BROWSERS_DIR;
    const { chromium } = await import("patchright");
    const profile = await mkdtemp(join(tmpdir(), "openserp-profile-"));
    const launch = () =>
      chromium.launchPersistentContext(profile, {
        headless: false,
        viewport: null,
        ...(proxy && { proxy: { server: proxy.server, username: proxy.username, password: proxy.password } }),
      });
    try {
      const context = await launch();
      const page = context.pages()[0] ?? (await context.newPage());
      return new Browser(launch, context, page, profile, origin);
    } catch (err) {
      await rm(profile, { recursive: true, force: true });
      throw err;
    }
  }

  /** Open a warm-up page and stay on it. Returns whether it arrived. */
  async visit(url: string, dwellMs: number, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: WARM_TIMEOUT_MS });
    } catch {
      return false;
    }
    await sleep(dwellMs, undefined, { signal });
    return true;
  }

  /** Open Google's front page, capture the request headers and clear the consent wall. */
  async home(): Promise<boolean> {
    let response: Response | null;
    try {
      response = await this.page.goto(`${this.origin}/?hl=en`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    } catch {
      return false;
    }
    if (response) await this.capture(response);
    await this.dismissConsent();
    return true;
  }

  async search(url: string): Promise<Fetched> {
    this.pages++;
    let response = await this.gotoResults(url);
    // A fresh exit can be shown the consent wall instead of results; clear it and open them again.
    if (await this.dismissConsent()) response = await this.gotoResults(url);
    if (response && !this.headers) await this.capture(response);
    // Google builds results in the browser; a refusal never grows the container, so this
    // short wait is expected to expire on those.
    await this.page.waitForSelector(READY, { state: "attached", timeout: 8_000 }).catch(() => {});
    return { url: this.page.url(), status: response?.status() ?? null, html: await this.page.content() };
  }

  async cookies(): Promise<string> {
    const jar = await this.context.cookies(`${this.origin}/search`);
    return jar.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  /** Take the values in a cookie header, keeping each known cookie's attributes. */
  async setCookies(header: string): Promise<void> {
    const known = new Map((await this.context.cookies(`${this.origin}/search`)).map((c) => [c.name, c]));
    const update = [];
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i <= 0) continue;
      const name = part.slice(0, i).trim();
      const value = part.slice(i + 1).trim();
      const base = known.get(name);
      if (base?.value === value) continue;
      if (!base) {
        update.push({ name, value, url: this.origin });
        continue;
      }
      const { partitionKey: _, ...rest } = base;
      update.push({ ...rest, name, value });
    }
    if (update.length) await this.context.addCookies(update);
  }

  /** Leave the current page, stopping whatever it is still loading. */
  async blank(): Promise<void> {
    await this.page.goto("about:blank").catch(() => {});
  }

  /**
   * Close the browser and open it again on the same profile and proxy: Chromium's renderer grows
   * with every page and only a new browser gives the memory back. Captured headers stay.
   */
  async restart(): Promise<void> {
    // Session cookies are not written to the profile, so the whole jar is carried over by hand.
    const jar = await this.context.cookies();
    await this.context.close().catch(() => {});
    this.context = await this.launch();
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    if (jar.length) await this.context.addCookies(jar.map(({ partitionKey: _, ...c }) => c));
    this.pages = 0;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await rm(this.profile, { recursive: true, force: true });
  }

  private async capture(response: Response): Promise<void> {
    const all = await response.request().headersArray();
    this.headers = all.filter((h) => !h.name.startsWith(":")).map((h) => [h.name.toLowerCase(), h.value]);
  }

  /**
   * Google sometimes answers first with a check page whose script loads the results URL again
   * before the first load is over. That is the results arriving, not a failure: wait for them.
   */
  private async gotoResults(url: string): Promise<Response | null> {
    try {
      return await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      const target = String(err).split(INTERRUPTED_BY)[1] ?? "";
      if (!target.includes("/search?")) throw err;
      await this.page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS });
      return null;
    }
  }

  /** Clear the consent overlay if one is up. It is intermittent, so finding none is normal. */
  private async dismissConsent(): Promise<boolean> {
    for (const selector of CONSENT_BUTTONS) {
      for (const handle of await this.page.$$(selector)) {
        if (!(await handle.isVisible())) continue;
        await handle.click({ timeout: 10_000 });
        await this.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        await this.page.waitForTimeout(500);
        return true;
      }
    }
    return false;
  }
}
