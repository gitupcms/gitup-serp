// Where an identity gets its exit from. Ported from serpmaven's proxy.py (MIT).
//
// One identity holds one exit for a series of queries, so it needs a sticky session. Most
// residential gateways pick a sticky exit from a session id in the proxy username, so the
// provider is described by a URL with a `{session}` placeholder where the id goes:
//   http://user-sid-{session}:pass@gate.nodemaven.com:8080
// Without the placeholder every identity shares the one URL (a rotating gateway).

import { randomBytes } from "node:crypto";

const PLACEHOLDER = "{session}";
const SCHEMES = ["http:", "https:", "socks5:"];

/** One identity's proxy, in the shape patchright's `proxy` option takes, plus what records may show. */
export interface ProxyEndpoint {
  server: string; // scheme://host:port, no credentials
  username?: string;
  password?: string;
  session: string;
  host: string; // host:port, safe to log
}

/** Twelve hex characters: unique enough per run and legal in every username format seen so far. */
export function newSessionId(): string {
  return randomBytes(6).toString("hex");
}

/** Hide the credentials of every URL in `s`. Library errors can echo a proxy URL. */
export function redact(s: string): string {
  return String(s).replace(/\/\/[^\s/@]+@/g, "//***@");
}

export class ProxyTemplate {
  readonly sticky: boolean;

  constructor(private readonly url: string) {
    let u: URL;
    try {
      u = new URL(url.replaceAll(PLACEHOLDER, "session"));
    } catch {
      throw new Error(`SCRAPER_PROXY is not a URL: ${redact(url)}`);
    }
    if (!SCHEMES.includes(u.protocol)) {
      throw new Error(`SCRAPER_PROXY scheme must be http, https or socks5, got ${u.protocol.slice(0, -1)}`);
    }
    if (!u.hostname || !u.port) throw new Error("SCRAPER_PROXY needs a host and a port, e.g. http://user:pass@host:port");
    if (u.protocol === "socks5:" && (u.username || u.password)) {
      // Chromium does not implement SOCKS5 authentication: it would connect without credentials.
      throw new Error(
        "Chromium cannot authenticate to a SOCKS5 proxy. Use the provider's HTTP port, " +
          "or whitelist this machine's address and drop the credentials.",
      );
    }
    this.sticky = url.includes(PLACEHOLDER);
  }

  forSession(session: string): ProxyEndpoint {
    const u = new URL(this.url.replaceAll(PLACEHOLDER, session));
    const ep: ProxyEndpoint = { server: `${u.protocol}//${u.host}`, session, host: u.host };
    if (u.username) ep.username = decodeURIComponent(u.username);
    if (u.password) ep.password = decodeURIComponent(u.password);
    return ep;
  }

  describe(): string {
    const u = new URL(this.url.replaceAll(PLACEHOLDER, "session"));
    return `${u.protocol}//${u.host} (${this.sticky ? "sticky" : "rotating: no {session} placeholder"})`;
  }
}
