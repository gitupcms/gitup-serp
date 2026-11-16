import { describe, expect, it } from "vitest";
import { parseSerp, placeFacts, resolveGoto } from "../src/parse/index.js";
import * as pages from "./fixtures/pages.js";

const parse = (html: string, hl = "en") => parseSerp(html, hl);

describe("organic results", () => {
  it("come in page order without people also ask", () => {
    const organic = parse(pages.resultsPage()).organic_results;
    expect(organic.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(organic.map((r) => r.title)).toEqual([
      "Swimming 101: The Beginner's Guide",
      "A Beginner's Guide to Techniques",
      "Unresolvable result",
    ]);
  });

  it("resolve /goto links through the inline JSON", () => {
    const first = parse(pages.resultsPage()).organic_results[0]!;
    expect(first.link).toBe("https://www.usms.org/fitness-and-training/guides/swimming-101?a=1");
    expect(first.redirect_link?.startsWith("https://www.google.com/goto?url=")).toBe(true);
  });

  it("keep the redirect when a /goto token cannot be resolved", () => {
    const third = parse(pages.resultsPage()).organic_results[2]!;
    expect(third.link).toBeNull();
    expect(third.redirect_link).toBe(`https://www.google.com/goto?url=${pages.GOTO_B}`);
  });

  it("read /url?q= and direct hrefs", () => {
    const organic = parse(pages.resultsPage({ goto: false })).organic_results;
    expect(organic[0]!.link).toBe("https://www.usms.org/guide");
    expect(organic[0]).not.toHaveProperty("redirect_link");
    expect(organic[1]!.link).toBe("https://www.swimnow.co.uk/guide");
  });

  it("carry source, displayed link, date and snippet", () => {
    const first = parse(pages.resultsPage()).organic_results[0]!;
    expect(first.source).toBe("U.S. Masters Swimming");
    expect(first.displayed_link).toBe("https://www.usms.org › guides");
    expect(first.date).toBe("7 Aug 2025");
    expect(first.snippet).toBe("In this guide we cover swimming lingo.");
  });

  it("survive Google dropping its class names", () => {
    const organic = parse(pages.resultsPage({ bare: true })).organic_results;
    expect(organic.map((r) => r.title)).toEqual([
      "Swimming 101: The Beginner's Guide",
      "A Beginner's Guide to Techniques",
      "Unresolvable result",
    ]);
    expect(organic[0]!.link).toBe("https://www.usms.org/fitness-and-training/guides/swimming-101?a=1");
    expect(organic[0]!.displayed_link).toBe("https://www.usms.org › guides");
    // The snippet is lost without its class; the result is not.
    expect(organic[1]!.link).toBe("https://www.swimnow.co.uk/guide");
  });

  it("fall back to #search when #rso is missing", () => {
    const html = pages.resultsPage().replace('<div id="rso">', '<div id="renamed">');
    expect(parse(html).organic_results).toHaveLength(3);
  });

  it("expose the /goto link map", () => {
    expect(parse(pages.resultsPage()).goto_links).toEqual({
      [pages.GOTO_A]: "https://www.usms.org/fitness-and-training/guides/swimming-101?a=1",
    });
  });
});

describe("other blocks", () => {
  it("ads", () => {
    expect(parse(pages.resultsPage()).ads).toEqual([
      {
        position: 1,
        block_position: "top",
        title: "Swim better",
        link: "https://eolab.com/",
        displayed_link: "https://www.eolab.com › swim",
        source: "eolab.com",
      },
    ]);
  });

  it("related questions and searches are deduplicated", () => {
    const parsed = parse(pages.resultsPage());
    expect(parsed.related_questions).toEqual([
      { question: "Is swimming good exercise?" },
      { question: "How do I start swimming?" },
    ]);
    expect(parsed.related_searches.map((s) => s.query)).toEqual(["swimming for beginners"]);
  });

  it("pagination and totals", () => {
    const parsed = parse(pages.resultsPage());
    expect(parsed.pagination.next?.startsWith("https://www.google.com/search?q=swimming")).toBe(true);
    expect(parsed.pagination.current).toBe(1);
    expect(parsed.search_information.total_results).toBe(1230000);
  });

  it("are empty when absent", () => {
    const parsed = parse("<html><body><div id='search'></div></body></html>");
    expect(parsed.organic_results).toEqual([]);
    expect(parsed.ads).toEqual([]);
    expect(parsed.related_questions).toEqual([]);
    expect(parsed.related_searches).toEqual([]);
    expect(parsed.pagination).toEqual({});
    expect(parsed.ai_overview).toEqual({});
    expect(parsed.local_results).toEqual([]);
  });
});

describe("resolveGoto", () => {
  it("skips occurrences not followed by a destination", () => {
    const page = String.raw`"/goto?url=TOK",null,null ... "/goto?url=TOK"],["https://dest.example/a&b","t"]`;
    expect(resolveGoto(page, "TOK")).toBe("https://dest.example/a&b");
    expect(resolveGoto(page, "MISSING")).toBeNull();
  });

  it("resolves video results through their video entry", () => {
    const token = "CAESvideo";
    const page =
      `[null,1,[null,null,5,null,"A video",null,"/goto?url=${token}"],null,` +
      `["/goto?url=${token}",null,35,"Source: YouTube"],2,null,` +
      '["VIDEO_RESULT","CKoG",null,"https://www.youtube.com/watch?v=abc"]]' +
      ',[null,1,[null,null,5,null,"next",null,"/goto?url=OTHER"],' +
      '["https://wrong.example/"]]';
    expect(resolveGoto(page, token)).toBe("https://www.youtube.com/watch?v=abc");
  });

  it("ignores URLs before the video marker", () => {
    const page =
      '[null,1,[null,null,5,null,"A video",null,"/goto?url=CAESvideo"],null,' +
      '["http://www.w3.org/2000/svg"],' +
      '["VIDEO_RESULT","CKoG",null,"https://www.youtube.com/watch?v=abc"]]';
    expect(resolveGoto(page, "CAESvideo")).toBe("https://www.youtube.com/watch?v=abc");
  });

  it("leaves a result without a video marker unresolved", () => {
    const page =
      '[null,1,[null,null,5,null,"t",null,"/goto?url=TOK"],null,' +
      '["http://www.w3.org/2000/svg"],["https://cdn.example/thumb.jpg"]]';
    expect(resolveGoto(page, "TOK")).toBeNull();
  });

  it("does not cross into the next entry", () => {
    const page =
      '[null,1,[null,null,5,null,"t",null,"/goto?url=TOK"],null,' +
      '["https://www.gstatic.com/icon.png"]],' +
      '[null,1,[null,null,5,null,"n",null,"/goto?url=NEXT"],["https://next.example/"]]';
    expect(resolveGoto(page, "TOK")).toBeNull();
  });
});

describe("AI Overview", () => {
  const withBlock = (block: string, hl = "en") => parse(pages.resultsPage({ aiOverview: block }), hl);

  it("is the text without heading, label, interface or script", () => {
    const parsed = withBlock(pages.aiOverviewBlock());
    expect(parsed.ai_overview).toEqual({ text: pages.AI_ANSWER });
    expect(parsed.organic_results).toHaveLength(3);
  });

  it("leaves out the AI Mode replied label", () => {
    const block = pages
      .aiOverviewBlock()
      .replace('<span class="hidden">AI Mode reply for swimming</span>', '<h3 class="MheKwc">AI Mode replied:</h3>');
    expect(withBlock(block).ai_overview).toEqual({ text: pages.AI_ANSWER });
  });

  it("keeps an answer that starts like the label", () => {
    const answer = "AI Mode replaces the classic results page for some queries. " + pages.AI_ANSWER;
    expect(withBlock(pages.aiOverviewBlock(answer)).ai_overview).toEqual({ text: answer });
  });

  it("drops the replied label but keeps an answer in its element", () => {
    const block = pages
      .aiOverviewBlock()
      .replace('<span class="hidden">AI Mode reply for swimming</span>', "")
      .replace(`<div><span>${pages.AI_ANSWER}</span></div>`, `<div>AI Mode replied: ${pages.AI_ANSWER}</div>`);
    expect(withBlock(block).ai_overview).toEqual({ text: pages.AI_ANSWER });
  });

  it("leaves out a label with a no-break space", () => {
    const block = pages
      .aiOverviewBlock()
      .replace('<span class="hidden">AI Mode reply for swimming</span>', '<h3 class="MheKwc">AI Mode replied:</h3>');
    expect(withBlock(block).ai_overview).toEqual({ text: pages.AI_ANSWER });
  });

  it("does not count the label or heading towards an inner block's length", () => {
    for (const [cutAt, label] of [
      [180, '<h3 class="MheKwc">AI Mode replied:</h3>'],
      [195, ""],
    ] as const) {
      const cut = pages.AI_ANSWER.lastIndexOf(" ", cutAt);
      const head = pages.AI_ANSWER.slice(0, cut);
      const tail = pages.AI_ANSWER.slice(cut + 1);
      const block =
        '<div class="outer"><div class="inner">' +
        '<div role="heading"><strong>AI Overview</strong></div>' +
        `${label}<span>${head}</span></div><span>${tail}</span></div>`;
      expect(withBlock(block).ai_overview.text).toBe(pages.AI_ANSWER);
    }
  });

  it("is empty when absent or when the heading has no answer", () => {
    expect(parse(pages.resultsPage()).ai_overview).toEqual({});
    expect(withBlock(pages.aiOverviewBlock("Loading")).ai_overview).toEqual({});
  });

  it("keeps label words that are part of the answer", () => {
    const answer = pages.AI_ANSWER + " Learn more about pacing in the second week.";
    expect(withBlock(pages.aiOverviewBlock(answer)).ai_overview.text?.endsWith("Learn more about pacing in the second week.")).toBe(true);
    const inline = pages.AI_ANSWER + " <span>Learn more</span> about pacing in week two.";
    expect(withBlock(pages.aiOverviewBlock(inline)).ai_overview.text).toContain("Learn more about pacing in week two.");
  });

  it("leaves out the share and feedback panels", () => {
    const panels =
      '<div role="dialog"><span>Thank you</span> See our Privacy Policy. Report a problem</div>' +
      "<div><div>This public link is valid for 7 days.</div><span>Copy link</span><span>Facebook</span></div>" +
      "<div>AI responses may include mistakes. For financial advice, consult a professional.</div>";
    const block = pages.aiOverviewBlock().replace("<div>Show more</div>", "<div>Show more</div>" + panels);
    expect(withBlock(block).ai_overview.text).toBe(pages.AI_ANSWER);
  });

  it("is found by the page language's heading", () => {
    for (const [hl, heading] of [
      ["tr", "Yapay Zeka Genel Bakışı"],
      ["de-DE", "Übersicht mit KI"],
      ["fr", "Aperçu IA"],
      ["es", "Resumen creado por IA"],
    ] as const) {
      expect(withBlock(pages.aiOverviewBlock(pages.AI_ANSWER, heading), hl).ai_overview).toEqual({ text: pages.AI_ANSWER });
    }
  });

  it("is found structurally, with no heading text at all", () => {
    const block = `<div data-attrid="AIOverview"><div><span>${pages.AI_ANSWER}</span></div><div>Show more</div></div>`;
    expect(withBlock(block, "ja").ai_overview).toEqual({ text: pages.AI_ANSWER });
  });
});

describe("local results", () => {
  it("read the map pack", () => {
    const parsed = parse(pages.resultsPage({ local: pages.localPackBlock() }));
    const [first, second] = parsed.local_results;
    expect(first).toEqual({
      position: 1,
      title: "Lane Swim Center",
      rating: 4.6,
      reviews: 1700,
      price: "$$",
      type: "Swimming pool",
      extensions: ["12 Main St"],
      address: "12 Main St",
      description: "Clean lanes and friendly staff.",
    });
    expect(second!.reviews).toBe(44);
    expect(second!.type).toBe("Gym");
    expect(second).not.toHaveProperty("price");
    expect(second!.hours).toBe("Open · Closes 9 PM");
    expect(second).not.toHaveProperty("address");
    expect(parsed.organic_results.map((r) => r.title)).not.toContain("Lane Swim Center");
  });

  it("are empty without a map pack", () => {
    expect(parse(pages.resultsPage()).local_results).toEqual([]);
  });

  it("a bare rating has no review count", () => {
    const lone = pages
      .place("Solo", "4.6", "1", "", "1 Elm St")
      .replace('<span class="RDApEe" aria-hidden="true">(1)</span>', "");
    const p = parse(pages.resultsPage({ local: lone })).local_results[0]!;
    expect(p.rating).toBe(4.6);
    expect(p).not.toHaveProperty("reviews");
  });
});

describe("placeFacts", () => {
  it("splits lines into address, phone and hours", () => {
    expect(
      placeFacts(["JFK International Airport, NY · (718) 656-1890", "Open · Closes 1 AM", "Rentals available from US$ 44/day"]),
    ).toEqual({ address: "JFK International Airport, NY", phone: "(718) 656-1890", hours: "Open · Closes 1 AM" });
    expect(placeFacts(["Sunset Blvd 12"])).toEqual({ address: "Sunset Blvd 12" });
    expect(placeFacts(["Pasadena, MD", "Sat: 7 AM–12 PM"]).hours).toBe("Sat: 7 AM–12 PM");
  });

  it("does not take service options or offers for an address", () => {
    expect(placeFacts(["Dine-in · Takeout", "12 Main St"])).toEqual({ address: "12 Main St" });
    expect(placeFacts(["Broadway", "Open · Closes 9 PM"]).address).toBe("Broadway");
    expect(placeFacts(["Dine-in · Takeout"])).not.toHaveProperty("address");
    expect(placeFacts(["Broadway", "Rentals available from US$ 44/day", "12 Main St"]).address).toBe("12 Main St");
    expect(placeFacts(["J2C6+HC7 Marrakesh"]).address).toBe("J2C6+HC7 Marrakesh");
  });
});
