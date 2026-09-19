/**
 * Distribution scout — shared types + targeting config (PropertyLens edition).
 *
 * The scout agent (scripts/scout.ts) runs every 8 hours in GitHub Actions and
 * writes data/scout-queue.json: a ranked list of live discussions about
 * Bengaluru property where a PropertyLens page genuinely answers what is being
 * asked. The owner reviews it at property-lens.ai/admin/scout and posts by hand.
 *
 * Why draft-only: Reddit/X/LinkedIn all ban unattended promo posting, and a
 * link dropped by a bot is the fastest way to lose the account that carries
 * the traffic. The agent does the finding and the writing; a human presses
 * post. That also keeps every comment truthful — a person checked it.
 */

export type Platform = "reddit" | "x" | "linkedin" | "quora" | "hn" | "forum";

export const PLATFORM_LABEL: Record<Platform, string> = {
  reddit: "Reddit",
  x: "X",
  linkedin: "LinkedIn",
  quora: "Quora",
  hn: "Hacker News",
  forum: "Forum",
};

/** Self-promo tolerance per platform — drives how the draft is written. */
export const PLATFORM_RULES: Record<Platform, string> = {
  reddit:
    "Strictest. No links at all. The comment must fully answer the question on its own. Assume NO IMAGE: " +
    "most subs disable comment images, so any figure worth showing has to be written out — as plain " +
    "lines, never a markdown table: the default composer is rich text and renders table syntax as literal garbage. " +
    "r/bangalore and r/IndiaRealEstate are hostile to anything that smells like a broker.",
  x:
    "Reply in the thread, conversational, no hashtags. Lead with the actual number or insight — the " +
    "reply has to be worth reading on its own. End with the lead's landing URL on its own line (the one " +
    "link allowed; X counts it as 23 characters toward the 280).",
  linkedin:
    "Comment as a practitioner. No emoji-bullet listicles. No links. The post collapses after ~210 characters " +
    "behind 'see more', so the opening must be a complete thought that earns the expand.",
  quora:
    "Long-form answer. Write it with no links: the scout itself appends the relevant PropertyLens " +
    "page to half of the Quora answers, as one closing line. Answer the question completely so it " +
    "stands with or without that line.",
  hn: "No links. Only comment if you can add real substance (data source, methodology, what RERA filings " +
    "actually contain). No images and no tables — figures go inline in prose.",
  forum:
    "Follow the individual forum's self-promo rule. Assume a human moderator reads every post, and " +
    "assume no image support — write the numbers out.",
};

/**
 * What the lead's image has to prove. Chosen per-lead by the scout, because the
 * right picture for "is Prestige X worth it" is that project's score card, and the
 * right picture for "Whitefield vs Sarjapur" is the two side by side — never the
 * same screenshot of a landing page every time.
 */
export interface ShotSpec {
  /**
   * project — a project's score, price growth, returns and unit choice (the hero of /p/<id>)
   * dd      — the financial & legal due-diligence dashboard of /p/<id> (RERA timeline, money, complaints)
   * compare — two projects side by side (/compare?a=&b=)
   * map     — the score map of one locality (/map?loc=<locality-id>)
   * list    — the ranked project cards for a developer or the whole city (/?dev=<name>)
   */
  kind: "project" | "dd" | "compare" | "map" | "list";
  /** project/dd/compare: the project id(s) as they appear in the site's URLs. */
  projectId: string;
  projectIdB: string;
  /** map: a locality id from the allowed list. */
  locality: string;
  /** list: a developer name exactly as PropertyLens spells it, or empty for the whole city. */
  developer: string;
  /**
   * The page to capture. Filled in by the scout from the fields above; kept so
   * older leads still render. Empty falls back to the lead's landing.
   */
  url: string;
  /** One line on what the image is meant to show. Displayed under it. */
  caption: string;
}

/** At most three images per lead — X, Reddit and LinkedIn all cap around four,
 *  and three is already more than most readers will look at. */
export const MAX_SHOTS = 3;

export interface ScoutLead {
  /** Stable id (sha1 of the canonical URL) — used to dedupe across cycles. */
  id: string;
  platform: Platform;
  url: string;
  title: string;
  /** Where it lives: r/bangalore, @handle, site name. */
  context: string;
  /** ISO date the thread was posted, when known. */
  postedAt: string | null;
  /** True only for an older Quora question worth answering. */
  evergreen: boolean;
  /** 0-100: how squarely PropertyLens answers what this person actually asked. */
  fit: number;
  /** What the person actually wants, in one line. */
  intent: string;
  /** The PropertyLens deep link to use. */
  landing: string;
  /** Why that page and not the homepage. */
  landingWhy: string;
  /** Ready-to-paste comment. */
  draft: string;
  risk: "low" | "medium" | "high";
  riskNote: string;
  /** 1-3 images, in the order they should be attached. The first is the one
   *  that carries the argument; later ones are supporting evidence. */
  shots: ShotSpec[];
  foundAt: string;
}

export interface ScoutQueue {
  generatedAt: string;
  /** Leads found this cycle, best first. */
  leads: ScoutLead[];
  stats: {
    candidates: number;
    kept: number;
    skippedSeen: number;
    byPlatform: Record<string, number>;
    /** Populated when a source failed, so a silent outage is visible. */
    errors: string[];
  };
}

export const EMPTY_QUEUE: ScoutQueue = {
  generatedAt: new Date(0).toISOString(),
  leads: [],
  stats: { candidates: 0, kept: 0, skippedSeen: 0, byPlatform: {}, errors: [] },
};

/** Subreddits where Bengaluru property questions actually get asked. */
export const SUBREDDITS = [
  "bangalore",
  "Bengaluru",
  "IndiaRealEstate",
  "indianrealestate",
  "RealEstateIndia",
  "IndiaInvestments",
  "personalfinanceindia",
  "FIREIndia",
  "IndiaTax",
  "IndianHomeBuyers",
];

/**
 * A thread must hit one of these to be worth a human's attention. Kept broad —
 * the model does the real relevance judgement; this only trims the firehose.
 */
export const KEYWORDS = [
  "property", "real estate", "apartment", "flat ", "2 bhk", "3 bhk", "2bhk", "3bhk", "4 bhk", "villa",
  "plot", "under construction", "under-construction", "possession", "handover", "rera", "builder",
  "developer", "home loan", "registration", "stamp duty", "khata", "resale", "rental yield", "rent vs buy",
  "buy vs rent", "price per sqft", "per sq ft", "sqft", "appreciation", "invest in property", "book a flat",
  "prestige", "sobha", "brigade", "godrej", "puravankara", "purva", "provident", "sattva", "salarpuria",
  "total environment", "embassy", "century real", "assetz", "casagrand", "mahindra lifespaces", "birla estates",
  "lodha", "tata realty", "shriram properties", "sumadhura", "ds max", "ds-max", "adarsh", "vaishnavi",
  "whitefield", "sarjapur", "hebbal", "yelahanka", "devanahalli", "electronic city", "kanakapura", "hoskote",
  "bannerghatta", "jp nagar", "hsr", "koramangala", "indiranagar", "marathahalli", "varthur", "thanisandra",
  "hennur", "budigere", "attibele", "mysore road", "kengeri", "tumkur road", "jakkur", "old madras road",
  "bengaluru property", "bangalore property", "bangalore real estate", "bengaluru real estate", "north bangalore",
  "east bangalore", "south bangalore",
];

/** How often the workflow runs. Keep in step with .github/workflows/scout.yml. */
export const CYCLE_HOURS = 8;

/**
 * How old a thread may be, per platform.
 *
 * On a feed, value decays with the thread: a reply lands while people are still
 * reading, and past a day the thread is archived in all but name. Quora is the
 * exception and is deliberately absent here — its answers rank in Google and
 * pull traffic for years, so a two-year-old question is still worth answering.
 */
export const MAX_THREAD_AGE_HOURS: Partial<Record<Platform, number>> = {
  reddit: 24,
  x: 24,
  linkedin: 24,
  hn: 24,
  forum: 24,
};

/** Hours a lead may sit on the board before it ages out (null = no limit). */
export const maxAgeFor = (p: Platform): number | null => MAX_THREAD_AGE_HOURS[p] ?? null;
