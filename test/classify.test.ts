import { describe, expect, it } from "vitest";
import { classify, relevance, unrelated } from "../src/classify/index.js";
import type { VerdictKind } from "../src/types.js";
import * as pages from "./fixtures/pages.js";

const SEARCH = "https://www.google.com/search?q=x";

describe("classify", () => {
  it.each<[string, string, VerdictKind]>([
    [SEARCH, pages.resultsPage(), "serp"],
    [SEARCH, "", "empty"],
    [pages.SORRY_URL, pages.SORRY_PAGE, "sorry"],
    [SEARCH, '<a href="/sorry/index?continue=x">here</a>', "sorry"],
    [SEARCH, pages.SORRY_PAGE, "sorry"],
    [SEARCH, '<html><body><form id="captcha-form" action="index"></form></body></html>', "sorry"],
    ["https://consent.google.com/m?continue=x", "<html>consent</html>", "consent"],
    [SEARCH, pages.CONSENT_PAGE, "consent"],
    [SEARCH, pages.NO_RESULTS_PAGE, "serp"],
    [SEARCH, pages.WALL_PAGE, "wall"],
    [SEARCH, pages.NO_JS_PAGE, "no_js"],
    [SEARCH, "<html><title>Error 403 (Forbidden)!!1</title></html>", "block"],
  ])("%s -> %#", (url, html, kind) => {
    expect(classify(html, url).kind).toBe(kind);
  });

  it("returns unknown, not block, for a page it cannot recognise", () => {
    expect(classify("<html><body>something else</body></html>", SEARCH)).toEqual({
      kind: "unknown",
      reason: expect.any(String),
    });
  });

  it("finds the unusual-traffic page in other languages", () => {
    for (const sentence of [
      "Sistemlerimiz, bilgisayar ağınızdan gelen olağan dışı trafik tespit etti.",
      "Unsere Systeme haben ungewöhnlichen Datenverkehr aus Ihrem Computernetzwerk festgestellt.",
      "Nos systèmes ont détecté un trafic exceptionnel sur votre réseau informatique.",
      "Nuestros sistemas han detectado tráfico inusual procedente de tu red.",
    ]) {
      expect(classify(`<html><body>${sentence}</body></html>`, SEARCH).kind).toBe("sorry");
    }
  });

  it("calls the no-JS scaffold no_js, not a wall", () => {
    expect(classify("<html><body><noscript>enable</noscript>enablejs</body></html>", SEARCH).kind).toBe("no_js");
  });

  it("keeps a served page with a dormant consent panel a SERP", () => {
    const html = pages.resultsPage() + '<form action="https://consent.google.com/save"></form>';
    expect(classify(html, SEARCH).kind).toBe("serp");
  });

  it("does not take a data-id attribute for the results container", () => {
    expect(classify('<html><body><div data-id="rso"></div></body></html>', SEARCH).kind).toBe("unknown");
  });
});

describe("unrelated", () => {
  it("flags titles that miss the query's words", () => {
    expect(unrelated("swimming for beginners", ["Cheap flights to Rome", "Best pizza near me"])).toBe(true);
    expect(unrelated("swimming for beginners", ["Swimming 101: The Beginner's Guide", "Beginner swim lessons"])).toBe(false);
  });

  it("has no opinion on a short query or an empty page", () => {
    expect(unrelated("swimming", ["anything"])).toBeNull();
    expect(unrelated("swimming lessons", [])).toBeNull();
  });

  it("matches word starts, stems, joined terms and other scripts", () => {
    expect(relevance("cat food", ["Education for all"])).toBe(0);
    expect(relevance("puppies training", ["Puppy training tips"])).toBe(1);
    expect(relevance("pubsub pricing", ["Google Pub/Sub pricing"])).toBe(1);
    expect(relevance("node.js streams", ["NodeJS streams explained"])).toBe(1);
    expect(relevance("кошки корм", ["Корм для кошки"])).toBe(1);
  });
});

describe("http status", () => {
  it("429 is sorry and 403 is block regardless of body", () => {
    expect(classify("<html></html>", "https://www.google.com/search?q=x", 429).kind).toBe("sorry");
    expect(classify("<html></html>", "https://www.google.com/search?q=x", 403).kind).toBe("block");
  });
});
