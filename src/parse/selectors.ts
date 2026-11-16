// Selector table for the SERP parser. Each entry is a fallback chain, tried in order:
// structural selectors (ids, tags, attributes) first, Google's obfuscated class names as a
// later hint. Code that cannot be a selector (climbing to a result's block) lives in parse/index.ts.

export const SELECTORS = {
  /** Where organic results live. `#search` keeps results when `#rso` is renamed. */
  organicContainer: ["#rso", "#search"],
  /** A result's outer block. Only a hint: without it the parser climbs to the largest ancestor holding one result heading. */
  resultBlock: [".MjjYud"],
  displayedLink: ["cite"],
  source: [".VuuXrf"],
  snippet: [".VwiC3b", "[data-sncf]", "div[style*='-webkit-line-clamp']"],
  snippetDate: [".YrbPuc > span"],
  /** People also ask: an element per question, the question in `data-q`. */
  relatedQuestion: ["div.related-question-pair", "div[data-q]"],
  relatedQuestionAncestor: [".related-question-pair", "[data-q]"],
  relatedSearchContainer: ["#bres", "#botstuff"],
  nextPage: ["#pnnext"],
  resultStats: ["#result-stats"],
  adBlock: ["div[data-text-ad]"],
  adAnchor: ["a[data-pcu]", "a[href]"],
  adHeading: ["div[role='heading']", "[role='heading']"],
  adDisplayed: ["span[data-dtld]"],
  localDetails: [".rllt__details"],
  localHeading: ["[role='heading']"],
  localRating: ["[role='img'][aria-label]"],
  localQuote: [".pJ3Ci"],
  /**
   * AI Overview containers, matched without reading text.
   * shortcut: these attributes are not verified against a live page; when one is confirmed,
   * put it first. Until then the heading text (AI_OVERVIEW_HEADINGS) does the work.
   */
  aiOverview: ["[data-attrid='AIOverview']", "[data-subtree='aimc']", "#m-x-content"],
} as const;

/** AI Overview heading per language; English is always tried as well. */
export const AI_OVERVIEW_HEADINGS: Record<string, readonly string[]> = {
  en: ["AI Overview"],
  tr: ["Yapay Zeka Genel Bakışı", "Yapay zeka genel bakışı"],
  de: ["Übersicht mit KI"],
  fr: ["Aperçu IA", "Aperçu généré par l'IA", "Aperçu généré par l’IA"],
  es: ["Resumen creado por IA", "Vista creada con IA"],
};
