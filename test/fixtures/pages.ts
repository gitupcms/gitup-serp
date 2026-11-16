// Synthetic Google pages for the offline tests, ported from serpmaven's tests/pages.py (MIT).
// Built by hand rather than saved from Google: a saved page carries the exit's location.

export const GOTO_A = "CAESdQHrOzAVat9YfzzCS78CJFjg4kgZKige7dVy07UiYTbvGT";
export const GOTO_B = "CAESiwEB6zswFVamDUs51KMKO7m25UC";

export interface OrganicOpts {
  /** Drop Google's class names, keeping only the structure. */
  bare?: boolean;
}

function organic(href: string, title: string, cite: string, source: string, snippet: string, date = "", o: OrganicOpts = {}): string {
  const c = (name: string) => (o.bare ? "" : ` class="${name}"`);
  const dateHtml = date ? `<span${c("YrbPuc")}><span>${date}</span> — </span>` : "";
  return (
    `<div${c("MjjYud")}><div${c("A6K0A")}><div${c("tF2Cxc")}>` +
    `<div${c("yuRUbf")}><a href="${href}"><h3${c("LC20lb")}>${title}</h3>` +
    `<div><span${c("VuuXrf")}>${source}</span><cite>${cite}</cite></div></a></div>` +
    `<div${c("VwiC3b")}>${dateHtml}<span>${snippet}</span></div>` +
    "</div></div></div>"
  );
}

export const AI_ANSWER =
  "To start swimming, get comfortable with putting your face in the water and " +
  "blowing bubbles, then practise floating on your front and back. " +
  "Freestyle is the usual first stroke: keep your body horizontal, kick from the hips " +
  "and breathe to the side every two or three strokes.";

/** Google's AI Overview: a heading, a hidden label, the answer, interface text and a script. */
export function aiOverviewBlock(answer = AI_ANSWER, heading = "AI Overview"): string {
  return (
    '<div class="CKgc1d"><div class="SGF5Lb"><div><div class="ux3nGb">' +
    `<div role="heading"><strong>${heading}</strong></div></div></div></div>` +
    '<div><span class="hidden">AI Mode reply for swimming</span>' +
    `<div><span>${answer}</span></div>` +
    "<script>var notText = 1;</script>" +
    "<div>AI responses may include mistakes. <a>Learn more</a></div>" +
    "<div>Show more</div></div></div>"
  );
}

export function place(name: string, stars: string, count: string, facts: string, address: string, quote = ""): string {
  const rating =
    `<span class="Y0A0hc" aria-label="Rated ${stars} out of 5, ${count} user reviews" ` +
    `role="img"><span class="yi40Hd" aria-hidden="true">${stars}</span>` +
    '<span aria-hidden="true" role="img" aria-label="Rated"><span></span></span>' +
    `<span class="RDApEe" aria-hidden="true">(${count})</span></span>`;
  const said = quote ? `<div class="pJ3Ci"><span>"${quote}"</span></div>` : "";
  return (
    '<div class="VkpGBb"><div class="rllt__details">' +
    `<div class="dbg0pd" aria-level="3" role="heading"><span>${name}</span></div>` +
    `<div><span>${rating}</span>${facts}</div><div>${address}</div>${said}</div></div>`
  );
}

export function localPackBlock(): string {
  return (
    '<div class="Qq3Lb"><div role="heading">Places</div>' +
    place("Lane Swim Center", "4.6", "1.7K", " · $$ · Swimming pool", "12 Main St", "Clean lanes and friendly staff.") +
    place("City Aquatics", "4.1", "44", " · Gym", "Open ⋅ Closes 9 PM") +
    "</div>"
  );
}

export function resultsPage(opts: { goto?: boolean; withJson?: boolean; aiOverview?: string; local?: string; bare?: boolean } = {}): string {
  const { goto = true, withJson = true, aiOverview = "", local = "", bare = false } = opts;
  const first = goto ? `/goto?url=${GOTO_A}` : "https://www.usms.org/guide";
  const o = { bare };
  const results = [
    organic(first, "Swimming 101: The Beginner&#39;s Guide", "https://www.usms.org › guides", "U.S. Masters Swimming", "In this guide we cover swimming lingo.", "7 Aug 2025", o),
    organic("/url?q=https://www.swimnow.co.uk/guide&amp;sa=U", "A Beginner&#39;s Guide to Techniques", "https://www.swimnow.co.uk › guide", "SwimNow", "Different swimming techniques explained.", "", o),
    organic(`/goto?url=${GOTO_B}`, "Unresolvable result", "https://example.org", "Example", "This token has no JSON pair.", "", o),
  ];
  const paa =
    '<div class="related-question-pair" data-q="Is swimming good exercise?">' +
    '<a href="https://answers.example/q"><h3>Not an organic result</h3></a></div>' +
    '<div class="related-question-pair" data-q="How do I start swimming?"></div>';
  const ad =
    '<div id="tads"><div data-text-ad="1"><a data-pcu="https://eolab.com/,https://www.eolab.com/"' +
    ' href="/goto?url=CAESadtoken"><div role="heading"><span>Swim better</span></div>' +
    '<span data-dtld="eolab.com">https://www.eolab.com › swim</span></a></div></div>';
  const href = "/search?hl=en&amp;q=swimming+for+beginners&amp;sa=X";
  const related = `<div id="bres"><a class="ngTNl" href="${href}">swimming for beginners</a><a class="ngTNl" href="${href}">dup</a></div>`;
  const nav = '<table><tr><td><a id="pnnext" href="/search?q=swimming&amp;start=10&amp;sa=N">Next</a></td></tr></table>';
  const script = withJson
    ? '<script>var data=[null,1,[null,null,5,null,"Swimming 101",null,' +
      `"/goto?url\\u003d${GOTO_A}"],["https://www.usms.org/fitness-and-training/` +
      'guides/swimming-101?a\\u003d1","Swimming 101"]];</script>'
    : "";
  return (
    "<html><head><title>swimming - Google Search</title></head><body>" +
    '<div id="result-stats">About 1,230,000 results (0.42 seconds)</div>' +
    `<div id="search">${aiOverview}${local}${ad}` +
    `<div id="rso">${results[0]}${paa}${results.slice(1).join("")}` +
    `</div></div>${related}${nav}${script}</body></html>`
  );
}

export const SORRY_URL = "https://www.google.com/sorry/index?continue=https://www.google.com/search";
export const SORRY_PAGE = "<html><body>Our systems have detected unusual traffic from your computer network.";
export const NO_RESULTS_PAGE = '<html><body><div id="search"><p>did not match any documents</p></div></body>';
export const WALL_PAGE = '<html><head><title>Google Search</title></head><body><a href="/x?emsg=SG_REL">';
export const NO_JS_PAGE =
  '<html><body><noscript><meta content="0;url=/search?q=x&amp;emsg=SG_REL&amp;' +
  'enablejs=1"></noscript><div id="main"></div></body></html>';
export const CONSENT_PAGE =
  '<html><body><form action="https://consent.google.com/save"><button>Reject all</button></form></body></html>';
