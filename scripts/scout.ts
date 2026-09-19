/**
 * Distribution scout agent — finds live discussions where a PropertyLens page is
 * genuinely the best answer, and drafts the comment for a human to post.
 *
 *   npx tsx scripts/scout.ts              # one cycle
 *   npx tsx scripts/scout.ts --dry-run    # don't write data/, just print
 *   npx tsx scripts/scout.ts --limit 8    # cap leads kept this cycle
 *   npx tsx scripts/scout.ts --rewrite    # re-draft the board against the current rules, no search
 *
 * Runs every 8 hours in .github/workflows/scout.yml and commits the queue;
 * the owner reviews and posts at property-lens.ai/admin/scout.
 *
 * Two-stage by design, because judgement is the expensive part:
 *   1. Cheap deterministic sweep — Reddit per-subreddit feeds (OAuth when
 *      credentials exist, Atom otherwise) and the HN Algolia index, keyword-trimmed.
 *   2. One Claude call with web search — searches X/LinkedIn/Quora and still-ranking
 *      older threads itself, judges every candidate for genuine fit, picks the deep
 *      link, and writes the comment. The only numbers it may quote come from the
 *      live PropertyLens dataset handed to it in the prompt.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  EMPTY_QUEUE,
  MAX_SHOTS,
  CYCLE_HOURS,
  MAX_THREAD_AGE_HOURS,
  maxAgeFor,
  KEYWORDS,
  PLATFORM_RULES,
  SUBREDDITS,
  type Platform,
  type ScoutLead,
  type ScoutQueue,
  type ShotSpec,
} from "../lib/scout";

const SITE = process.env.SITE_URL ?? "https://property-lens.ai";
const DATA_DIR = path.join(process.cwd(), "data");
const QUEUE_FILE = path.join(DATA_DIR, "scout-queue.json");
const HISTORY_FILE = path.join(DATA_DIR, "scout-history.json");
const UA = "Mozilla/5.0 (compatible; propertylens-scout/1.0; +https://property-lens.ai)";
const MODEL = "claude-opus-5";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const REWRITE = args.includes("--rewrite");
const LIMIT = Number(args[args.indexOf("--limit") + 1]) || 10;

/** Keep history bounded but long enough that we never re-suggest a thread. */
const HISTORY_MAX = 4000;

const errors: string[] = [];
const note = (msg: string) => console.log(`[scout] ${msg}`);
const fail = (where: string, err: unknown) => {
  const msg = `${where}: ${err instanceof Error ? err.message : String(err)}`;
  errors.push(msg);
  console.error(`[scout] ${msg}`);
};

interface Candidate {
  platform: Platform;
  url: string;
  title: string;
  context: string;
  postedAt: string | null;
  signal: string;
}

const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Strip tracking junk so the same thread hashes to the same id every cycle. */
function canonical(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    u.hostname = u.hostname.replace(/^(www|old|new)\./, "");
    u.pathname = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}

const matchesKeyword = (text: string) => {
  const t = text.toLowerCase();
  return KEYWORDS.some((k) => t.includes(k));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reddit rate-limits anonymous feed reads hard. Back off and retry; honour Retry-After. */
async function getText(url: string, timeoutMs = 20_000, attempts = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, signal: ctrl.signal });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 4000 * 2 ** i;
        lastErr = new Error(`HTTP ${res.status}`);
        if (i < attempts - 1) { await sleep(Math.min(wait, 30_000)); continue; }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) throw err;
      await sleep(4000 * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- sources

async function redditToken(): Promise<string | null> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": UA,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { access_token?: string }).access_token ?? null;
  } catch (err) {
    fail("reddit auth", err);
    return null;
  }
}

async function fromRedditApi(token: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const cutoff = Date.now() - (MAX_THREAD_AGE_HOURS.reddit ?? 24) * 36e5;
  for (const sub of SUBREDDITS) {
    try {
      const res = await fetch(`https://oauth.reddit.com/r/${sub}/new?limit=100`, {
        headers: { authorization: `Bearer ${token}`, "user-agent": UA },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: { children?: Array<{ data: Record<string, any> }> } };
      for (const { data: d } of json.data?.children ?? []) {
        const posted = (d.created_utc ?? 0) * 1000;
        if (posted < cutoff) continue;
        if (!matchesKeyword(`${d.title ?? ""} ${d.selftext ?? ""}`)) continue;
        out.push({
          platform: "reddit",
          url: `https://www.reddit.com${d.permalink}`,
          title: String(d.title ?? "").slice(0, 200),
          context: `r/${sub}`,
          postedAt: new Date(posted).toISOString(),
          signal: `${Math.round((Date.now() - posted) / 36e5)}h ago · ${d.score ?? 0} pts, ${d.num_comments ?? 0} comments`,
        });
      }
      await sleep(700);
    } catch (err) {
      fail(`reddit api r/${sub}`, err);
    }
  }
  return out;
}

/** Reddit per-subreddit Atom feed — the anonymous fallback. */
async function fromReddit(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const perCycle = 8;
  const offset = (Math.floor(Date.now() / 36e5 / CYCLE_HOURS) * perCycle) % SUBREDDITS.length;
  const window = Array.from({ length: perCycle }, (_, i) => SUBREDDITS[(offset + i) % SUBREDDITS.length]);
  for (const sub of window) {
    try {
      const xml = await getText(`https://www.reddit.com/r/${sub}/new/.rss?limit=50`);
      const entries = xml.split("<entry>").slice(1);
      for (const e of entries) {
        const url = /<link[^>]*href="([^"]+)"/.exec(e)?.[1];
        const title = /<title>([\s\S]*?)<\/title>/.exec(e)?.[1];
        if (!url || !title) continue;
        const clean = title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
        const body = /<content[^>]*>([\s\S]*?)<\/content>/.exec(e)?.[1] ?? "";
        if (!matchesKeyword(`${clean} ${body}`)) continue;
        const updated = /<updated>([^<]+)<\/updated>/.exec(e)?.[1] ?? null;
        const posted = updated ? Date.parse(updated) : NaN;
        if (Number.isNaN(posted) || posted < Date.now() - (MAX_THREAD_AGE_HOURS.reddit ?? 24) * 36e5) continue;
        out.push({
          platform: "reddit",
          url,
          title: clean,
          context: `r/${sub}`,
          postedAt: updated,
          signal: `posted ${Math.round((Date.now() - posted) / 36e5)}h ago`,
        });
      }
      await sleep(7000);
    } catch (err) {
      fail(`reddit r/${sub}`, err);
    }
  }
  return out;
}

/** Hacker News via Algolia — rarely relevant for Bengaluru property, but free and occasionally right. */
async function fromHn(): Promise<Candidate[]> {
  const queries = ["real estate india", "bangalore property", "rera", "rent vs buy india"];
  const out: Candidate[] = [];
  for (const q of queries) {
    try {
      const raw = await getText(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=15` +
          `&numericFilters=points>5,created_at_i>${Math.floor((Date.now() - (MAX_THREAD_AGE_HOURS.hn ?? 24) * 36e5) / 1000)}`,
      );
      const json = JSON.parse(raw) as { hits: Array<Record<string, unknown>> };
      for (const h of json.hits) {
        const title = String(h.title ?? "");
        if (!title || !matchesKeyword(title)) continue;
        out.push({
          platform: "hn",
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          title,
          context: "Hacker News",
          postedAt: h.created_at ? String(h.created_at) : null,
          signal: `${h.points ?? 0} points, ${h.num_comments ?? 0} comments`,
        });
      }
    } catch (err) {
      fail(`hn "${q}"`, err);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the dataset

interface IndexRow {
  id: string; name: string; builderName: string; locality: string; localityName: string; zone: string;
  status: string; type: string; segment: string; score: number; evidence: number; cagr5: number; cagr10: number;
  irr: number; wealth: number; yield: number; psf: number; psfKind: string; ticket: number; label: string;
  possession: string | null; units: number | null; verified: boolean; red: number; complaints: number | null; devRank: number | null;
}

let INDEX: IndexRow[] = [];

async function loadIndex(): Promise<IndexRow[]> {
  try {
    INDEX = JSON.parse(await getText(`${SITE}/data/index.json`, 60_000)) as IndexRow[];
  } catch (err) {
    fail("index", err);
    INDEX = [];
  }
  return INDEX;
}

/**
 * The pages the agent is allowed to link to. Restricting it to real URLs is what
 * stops it inventing a plausible-looking 404 — the one mistake that would make a
 * posted comment actively embarrassing. Project pages are allowed only for the
 * projects in the digest; the digest is what carries their numbers.
 */
function linkMap(digestIds: Set<string>): string[] {
  const locs = [...new Set(INDEX.map((e) => e.locality))];
  const devs = [...new Set(INDEX.map((e) => e.builderName))];
  return [
    `${SITE}/`, `${SITE}/map`, `${SITE}/compare`, `${SITE}/developers`,
    ...locs.map((l) => `${SITE}/map?loc=${encodeURIComponent(l)}`),
    ...devs.map((d) => `${SITE}/?dev=${encodeURIComponent(d)}`),
    ...[...digestIds].map((id) => `${SITE}/p/${id}`),
    ...[...digestIds].map((id) => `${SITE}/dd/${id}`),
  ];
}

/**
 * Enforce the link rule in code, not just the prompt: X drafts may carry the
 * lead's landing URL and nothing else; every other platform gets no URL and no
 * bare mention of the domain.
 */
function enforceLinks(platform: Platform, draft: string, landing: string): string {
  const keep = platform === "x" ? landing.replace(/\/+$/, "") : null;
  const out = draft
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, text: string, url: string) => (keep && url.replace(/\/+$/, "") === keep ? url : text))
    .replace(/https?:\/\/[^\s)>\]]+/g, (url) => (keep && url.replace(/[.,;:!?]+$/, "").replace(/\/+$/, "") === keep ? url : ""))
    .replace(platform === "x" ? /$^/ : /\b(?:www\.)?property-lens\.ai\b/gi, "PropertyLens")
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}

/** The closing line that carries a Quora answer's link — phrased for what the page shows. */
function linkLine(landing: string): string {
  const path = landing.replace(/^https?:\/\/[^/]+/, "");
  const what =
    path.startsWith("/p/") || path.startsWith("/dd/") ? "the full numbers and the RERA record for this project are here" :
    path.startsWith("/compare") ? "the two side by side, after every cost, are here" :
    path.startsWith("/map?loc=") ? "every project on this corridor, scored on one map, is here" :
    path.startsWith("/map") ? "every analysed Bengaluru project, scored on one map, is here" :
    path.startsWith("/developers") ? "the developer-by-developer delivery records are here" :
    path.startsWith("/?dev=") ? "every project from this developer, scored, is here" :
    "all 1,850+ analysed Bengaluru projects, ranked with net returns, are here";
  return `If you want to check these numbers yourself, ${what}: ${landing}`;
}

/**
 * Half of the Quora answers carry one PropertyLens link as a closing line;
 * the rest stay link-free. Leads that already carry one keep it; the
 * highest-fit link-free ones are topped up until half the Quora leads link.
 */
function linkHalfOfQuora(leads: ScoutLead[]): number {
  const quora = leads.filter((l) => l.platform === "quora").sort((a, b) => b.fit - a.fit);
  const has = (l: ScoutLead) => l.draft.includes(l.landing);
  let linked = quora.filter(has).length;
  const target = Math.ceil(quora.length / 2);
  let added = 0;
  for (const l of quora) {
    if (linked >= target) break;
    if (has(l)) continue;
    l.draft = `${l.draft.trimEnd()}\n\n${linkLine(l.landing)}`;
    l.riskNote = "Carries one PropertyLens link as its closing line (half of Quora answers do). Keep it to that one link.";
    linked++; added++;
  }
  return added;
}

/**
 * Replace each digest project's complaint count with the one filed against its
 * own RERA registration. index.json's "complaints" (and the site's complaint
 * log) attach another project's complaints from the same promoter — every
 * Casagrand project shows Casagrand Orlena's 102 — so it must never be quoted.
 * Each project's own file carries the per-registration count in
 * rera_signals.complaints; when that can't be read the count becomes unknown.
 */
async function loadRegistrationComplaints(ids: Set<string>): Promise<number> {
  let fixed = 0;
  const rows = INDEX.filter((r) => ids.has(r.id));
  for (let i = 0; i < rows.length; i += 8) {
    await Promise.all(rows.slice(i, i + 8).map(async (r) => {
      try {
        const p = JSON.parse(await getText(`${SITE}/data/p/${r.id}.json`, 20_000, 2)) as { project?: { rera_signals?: { complaints?: unknown } } };
        const n = p.project?.rera_signals?.complaints;
        r.complaints = typeof n === "number" && Number.isFinite(n) ? n : null;
        fixed++;
      } catch (err) {
        r.complaints = null;
        fail(`complaints ${r.id}`, err);
      }
    }));
  }
  return fixed;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const cr = (n: number) => (n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : `₹${(n / 1e5).toFixed(1)} L`);

/**
 * A compact digest of the real dataset, handed to the drafter.
 *
 * Without this the model has URLs but no numbers, and since it is (rightly)
 * forbidden from inventing figures, every draft comes out as prose with nothing
 * concrete — fatal on Reddit, where the numbers ARE the comment. These are the
 * only project figures it is allowed to quote.
 */
function projectDigest(perLocality = 4): { text: string; ids: Set<string> } {
  const ids = new Set<string>();
  const lines: string[] = [];
  const byLoc = new Map<string, IndexRow[]>();
  for (const e of INDEX) { const arr = byLoc.get(e.localityName) ?? []; arr.push(e); byLoc.set(e.localityName, arr); }
  const locs = [...byLoc.entries()].sort((a, b) => b[1].length - a[1].length);
  lines.push("## Locality overview (projects analysed · median score · median 5-yr price growth · median price per sq ft)");
  for (const [name, rows] of locs) {
    const med = (arr: number[]) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    lines.push(`${name} · ${rows.length} · ${Math.round(med(rows.map((r) => r.score)))} · ${pct(med(rows.map((r) => r.cagr5)))} · ₹${Math.round(med(rows.map((r) => r.psf))).toLocaleString("en-IN")}`);
  }
  lines.push("", "## Projects (id | name | developer | locality | status | score/100 | 5-yr price growth/yr | net-wealth CAGR (8-yr, 75% loan) | cash-flow IRR | gross yield | price per sq ft (observed/assumed) | ticket for the default home | red flags in due diligence | RERA complaints on this registration — unknown means never quote a count)");
  for (const [, rows] of locs) {
    const top = [...rows].sort((a, b) => b.score - a.score).slice(0, perLocality);
    // Also carry the biggest names people ask about by name, even when their score is middling.
    const famous = rows.filter((r) => /prestige|sobha|brigade|godrej|purva|provident|sattva|total environment|embassy|birla|lodha|tata|mahindra|casagrand|assetz/i.test(r.builderName)).sort((a, b) => b.score - a.score).slice(0, 4);
    for (const r of [...new Set([...top, ...famous])]) {
      ids.add(r.id);
      lines.push([r.id, r.name, r.builderName, r.localityName.split(" (")[0], r.status, r.score.toFixed(0), pct(r.cagr5), pct(r.wealth), pct(r.irr), pct(r.yield), `₹${Math.round(r.psf).toLocaleString("en-IN")} (${r.psfKind})`, cr(r.ticket), String(r.red ?? 0), r.complaints === null ? "unknown" : String(r.complaints)].join(" | "));
    }
  }
  return { text: lines.join("\n"), ids };
}

// ---------------------------------------------------------------- history

interface HistoryEntry { id: string; url: string; seenAt: string }

const readJson = <T,>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------- the agent

const SYSTEM = `You are the distribution scout for PropertyLens (${SITE}) — a free, ad-free research tool for
people buying or investing in residential property in Bengaluru. What it actually does:

- Analyses every registered residential project of Bengaluru's top 200 developers (1,850+ apartments,
  villas and plots) from Karnataka RERA filings, the promoter's quarterly progress updates, the K-RERA
  complaint register, public credit ratings and dated locality price evidence.
- Gives each project a 0-100 investment score across eleven factors (price growth expectation, price
  vs comparables, rental demand, resale liquidity, employment access, transit, social infrastructure,
  developer delivery record, product, environment, legal). 50 is the average analysed Bengaluru
  project; 12 points is one standard deviation; 70+ is well above average.
- Projects price growth per year over 5 and 10 years from locality evidence, office pipelines,
  supply and demand from the filings, and dated infrastructure events.
- Computes net returns after EVERY cost — GST, stamp duty and registration, other charges, interiors,
  vacancy, maintenance, loan interest, selling costs — as a net-wealth CAGR and a cash-flow IRR, for a
  75% home loan by default. Under-construction homes earn no rent before handover; plots earn none.
- Publishes a financial and legal due-diligence report per project: RERA timeline and extensions,
  construction vs bookings, money through the RERA account, complaints, court cases, NBFC funding,
  land ownership, credit ratings, with red flags and the questions to put to the developer.
- Every figure is marked observed (from a named source) or assumed (a model estimate the visitor can
  edit). Free, no login, no ads, no brokerage, no leads sold. It is research, NOT investment advice.

YOUR JOB: find discussions about Bengaluru residential property where a SPECIFIC PropertyLens page is
genuinely the most useful reply someone could leave, and write that reply. Threads about mutual funds,
stocks, other cities or commercial property do not qualify, however good the fit sounds.

The bar is high. A lead only qualifies if a knowledgeable stranger reading your comment would think
"that actually answered the question", and the page is the natural evidence for the answer — not an
advertisement bolted onto a generic reply. If the honest fit is weak, drop the lead. Ten good leads
beat forty mediocre ones, and a mediocre one gets the account banned.

HARD RULES for every draft you write:
1. The comment must stand on its own. If the reader never clicks, they should still have got a real
   answer — a specific number, a concrete method, a correction of a wrong assumption.
2. LINKS — X ONLY. On x, end the draft with the lead's "landing" URL, exactly as given, on its own
   line; that is the only link, and it counts as 23 characters toward the 280. On EVERY other
   platform (reddit, quora, linkedin, hn, forum): write no links at all. (On quora the scout appends
   the landing page as a closing line to half the answers itself — never add one yourself.) No bare URLs, no markdown links, no
   "you can find it at ...", and no naming the domain in running text. Attribution there comes from
   the author's profile credential ("Founder at property-lens.ai") and from the screenshot.
   Pick "landing" and the shot specs as normal on every platform — they decide which page is
   screenshotted.
3. You may say you built the tool when it is relevant and honest ("I pulled this from the RERA
   filings myself", "the screenshot is from something I built") — never pretend to be a neutral
   third party. Where there is no link in the draft, the better move is usually to just answer well and let
   the credential do the attribution. Never write a sentence whose purpose is to sell.
4. Never promise appreciation, never call a project "the best" as a fact, never give personalised
   investment advice, never tell someone to buy or not buy. PropertyLens is research. Say so if the
   thread is asking "should I buy X".
5. Match the register of the platform and the thread. Reddit is blunt and allergic to marketing
   language; r/bangalore in particular treats anyone who sounds like a broker as one. LinkedIn is
   professional. Write like a person, not a brand. No emoji-bullet lists, no "Great question!", no
   hashtags.
6. Never fabricate a number. Quote only figures from the PROJECT DATA block. Every quoted number
   must be labelled with what it is ("PropertyLens score", "projected 5-yr price growth", "RERA
   completion date"), and price-per-sq-ft figures marked (assumed) must be called estimates. When
   unsure, describe what the page shows rather than quoting a value. Complaint counts are only ever
   the "RERA complaints on this registration" column for that named project — never a promoter
   total, never a number seen on a project page, and never one marked "unknown".
7. "landing" and each shot's page must come from the allowed list. Never invent a project id or a
   path, and never write either of them into the draft (on x, the landing URL itself is the one exception).
8. Watch for periodic threads (weekly "buying/renting" megathreads, monthly review threads). Only
   the CURRENT period's thread is live. Never surface one whose period has passed.
9. The person on the other side may be spending their life savings. Mention the things that
   actually protect them when they are relevant: RERA registration, extensions, complaints,
   escrow, land ownership, occupancy certificate — that is what makes a reply worth its place.

FORMATTING — the draft is pasted verbatim into a comment box, so it must already look posted:
- Short paragraphs, 2-3 sentences each, separated by a BLANK LINE (\\n\\n). Never emit one long block.
- Open with the sentence that carries the answer. No throat-clearing.
- Use a plain hyphen or "• " list only where you are genuinely enumerating. Two to four items,
  one line each. Never bullet an entire answer.
- No markdown headers, no bold, no emoji, no hashtags, no tables anywhere.

RENDERING — what each composer actually does to your text:
- reddit: the default composer is RICH TEXT, not markdown. No tables, no **bold**, no # headings.
  Every line break becomes a paragraph, so cap comparison lines at 4 and start them with "• ".
- linkedin: collapses after roughly 210 characters behind "…see more". Whatever sits above that fold
  must be a COMPLETE thought that earns the click. No markdown; "• " renders literally and is fine.
- x: no formatting at all. Line breaks work. 280 characters is a hard limit per tweet; a 2-3 tweet
  thread separated by a line containing only "---" is allowed, each tweet under 280.
- quora: rich text, plain paragraphs rank best, lists sparingly. No markdown.
- hn / forum: plain text, blank lines between paragraphs, nothing else.

TEXT-ONLY PLATFORMS — reddit, hn and forum: assume THE IMAGE WILL NOT BE THERE. Put the actual
figures in the comment, one plain line per project, measures in the same order every line, e.g.
      • Prestige Park Grove — score 54, projected 10.1%/yr, RERA handover Dec 2027, 0 complaints
State the basis in one short clause ("PropertyLens score, RERA filings as of Sep 2026"). Lead with
the most surprising true number you have.
LENGTH, hard limits: x 280 characters per tweet · reddit 80-150 words plus up to 4 comparison lines ·
quora 150-280 words · linkedin 60-120 words with the first 200 characters ending on a complete
sentence · hn 60-120 words plain prose · forum 80-150 words.

THE IMAGES — every lead carries one to three screenshots, and each must prove a specific claim the
draft makes. A picture of a landing page is worse than no picture. Choose the narrowest shot that
answers the thread:
- kind "project": the project's score, growth, returns and unit choice. For "is X worth it / what
  do you think of X" threads. projectId from the PROJECT DATA block.
- kind "dd": the due-diligence dashboard (RERA timeline and extensions, construction vs bookings,
  money through the RERA account, complaints, court cases). For "is the builder reliable / delays /
  RERA" threads. projectId required.
- kind "compare": two projects side by side. For "X vs Y" threads. projectId and projectIdB.
- kind "map": the score map of one locality. For "which area / is Whitefield or Sarjapur better"
  threads. locality is a locality id from the allowed map links.
- kind "list": the ranked cards for a developer or the city. For "which Prestige project / best
  under 1 Cr" threads. developer is the name exactly as spelt in the data, or empty for the city.
Two shots is usually right: the one that PROVES the claim first, then supporting evidence. Never
lead with an empty page.

PLATFORM SELF-PROMO RULES:
${(Object.keys(PLATFORM_RULES) as Platform[]).map((p) => `- ${p}: ${PLATFORM_RULES[p]}`).join("\n")}

SEARCH COVERAGE — a requirement, not a suggestion. The feed sweep only reaches Reddit and Hacker
News, so X, LinkedIn and Quora exist ONLY if you go and look for them.
- Run at least THREE separate x.com searches with different angles — a locality or project people
  are arguing about this week, a builder delay or RERA story, and a "should I buy in Bengaluru now"
  style question. Search around accounts that post on Bengaluru real estate and Indian personal
  finance; a reply on a big account's thread reaches more people than a new post ever will.
- At least one search scoped to linkedin.com, and one to quora.com.
- Scope x.com, linkedin.com and forum searches to the last 24 hours. Quora searches should NOT be
  date-scoped: search it for high-intent Bengaluru property questions whatever their age.
- No more than HALF your leads from any single platform. Do not pad with weak fits.

Verify a thread exists and is real before you list it; do not list a URL you have not seen in a
search result or in the candidate list.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["leads"],
  properties: {
    leads: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "platform", "url", "title", "context", "postedAt", "evergreen",
          "fit", "intent", "landing", "landingWhy", "draft", "risk", "riskNote", "shots",
        ],
        properties: {
          platform: { type: "string", enum: ["reddit", "x", "linkedin", "quora", "hn", "forum"] },
          url: { type: "string", description: "Direct link to the thread/post to reply to." },
          title: { type: "string" },
          context: { type: "string", description: "r/Subreddit, @handle, or site name." },
          postedAt: {
            type: "string",
            description:
              "REQUIRED and checked: ISO 8601 timestamp the thread was posted. On every platform " +
              "except quora it must be within the last 24 hours or the lead is discarded. Do not " +
              "guess — omit the lead instead.",
          },
          evergreen: { type: "boolean", description: "True only for an older Quora question worth answering." },
          fit: { type: "integer", description: "0-100: how squarely PropertyLens answers what was asked." },
          intent: { type: "string", description: "What the person actually wants, one line." },
          landing: { type: "string", description: "PropertyLens URL from the allowed list." },
          landingWhy: { type: "string", description: "Why this page beats the homepage here." },
          draft: { type: "string", description: "The ready-to-paste comment." },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          riskNote: { type: "string", description: "Self-promo/removal risk and how the draft handles it." },
          shots: {
            type: "array",
            description: "1-3 images for this lead, best first.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "projectId", "projectIdB", "locality", "developer", "url", "caption"],
              properties: {
                kind: { type: "string", enum: ["project", "dd", "compare", "map", "list"] },
                projectId: { type: "string", description: "project/dd/compare: a project id from the PROJECT DATA block. Empty otherwise." },
                projectIdB: { type: "string", description: "compare only: the second project id. Empty otherwise." },
                locality: { type: "string", description: "map only: a locality id from the allowed /map?loc= links. Empty otherwise." },
                developer: { type: "string", description: "list only: developer name exactly as in the data, or empty for the whole city." },
                url: { type: "string", description: "Leave empty; filled in from the fields above." },
                caption: { type: "string", description: "One line: what this image shows." },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** The page a shot actually captures, derived from its fields so it can never be invented. */
function shotUrl(s: ShotSpec): string {
  if (s.kind === "project" && s.projectId) return `${SITE}/p/${s.projectId}`;
  if (s.kind === "dd" && s.projectId) return `${SITE}/p/${s.projectId}#dd`;
  if (s.kind === "compare" && s.projectId && s.projectIdB) return `${SITE}/compare?a=${s.projectId}&b=${s.projectIdB}`;
  if (s.kind === "map") return `${SITE}/map${s.locality ? `?loc=${encodeURIComponent(s.locality)}` : ""}`;
  if (s.kind === "list") return `${SITE}/${s.developer ? `?dev=${encodeURIComponent(s.developer)}` : ""}`;
  return "";
}

async function judge(candidates: Candidate[], links: string[], digest: string): Promise<Omit<ScoutLead, "id" | "foundAt">[]> {
  const client = new Anthropic();
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `Today is ${today}.

ALLOWED PROPERTYLENS URLS — "landing" must be one of these (project ids for shots come from the data block):
${links.join("\n")}

PROJECT DATA — real, current figures from the live dataset (${INDEX.length} projects analysed; this block
carries the top-scoring and best-known projects per locality). These are the ONLY property numbers you may
quote. Never invent or recall a figure from anywhere else, and never quote a number for a project that is
not listed here. Say the basis in a short clause when you use one.

${digest}


CANDIDATE THREADS from this cycle's feed sweep (Reddit + Hacker News). Judge each one honestly; most will not
qualify, and anything not about Bengaluru residential property is out:
${candidates.length ? candidates.map((c, i) =>
  `${i + 1}. [${c.platform}] ${c.title}\n   ${c.url}\n   ${c.context} · ${c.signal}${c.postedAt ? ` · posted ${c.postedAt}` : ""}`,
).join("\n") : "(none — the sweep found nothing this cycle; rely entirely on your own search)"}

Now also search the web yourself for qualifying discussions on X, LinkedIn, Quora and Indian property forums,
plus older Quora threads that still rank for high-intent Bengaluru property queries.

AGE — a hard filter, applied before anything else:
- reddit, x, linkedin, hn, forums: the thread must have been POSTED IN THE LAST 24 HOURS.
- quora: NO age limit. Judge on fit and on how well the existing answers hold up.
Set postedAt accurately on every lead — it is checked in code.

Return at most ${LIMIT} leads, best first. Fewer is fine — return an empty list rather than padding with weak
fits. Aim for a spread across platforms rather than ten Reddit threads.`;

  const res = await client.beta.messages.stream({
    model: MODEL,
    max_tokens: 48000,
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: "claude-opus-4-8" }],
    // The system prompt and the data-heavy user prompt are identical across every tool turn of one call, and the
    // allow-list + digest barely change between cycles. Caching them cuts the resent-input bill by roughly 90%.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> } },
    tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 10 }],
    messages: [{ role: "user", content: [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }] }],
  }).finalMessage();

  if (res.stop_reason === "max_tokens") throw new Error(`hit max_tokens (${res.usage.output_tokens} out) — response truncated`);
  if (res.stop_reason === "refusal") throw new Error(`model declined (${res.stop_details?.category ?? "unknown"})`);
  const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  note(`model: ${res.model} · in ${res.usage.input_tokens} (+${res.usage.cache_read_input_tokens ?? 0} cached, ${res.usage.cache_creation_input_tokens ?? 0} written) / out ${res.usage.output_tokens} tokens`);
  const json = text.trim().startsWith("{") ? text : /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) throw new Error("model returned no JSON");
  return (JSON.parse(json) as { leads: Omit<ScoutLead, "id" | "foundAt">[] }).leads ?? [];
}

/** Re-draft existing leads against the current writing rules. No sweep, no web search. */
const REWRITE_BATCH = 10;
interface Rewritten { draft: string; shots: ShotSpec[] }

async function rewriteBatch(leads: ScoutLead[], digest: string): Promise<Map<string, Rewritten>> {
  const client = new Anthropic();
  const schema = {
    type: "object", additionalProperties: false, required: ["drafts"],
    properties: { drafts: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "draft", "shots"], properties: { id: { type: "string" }, draft: { type: "string" }, shots: (SCHEMA.properties.leads.items.properties as Record<string, unknown>).shots } } } },
  };
  const prompt = `For each lead below, rewrite the draft so it satisfies the FORMATTING and length rules exactly,
keeping every substantive point, and specify its images per THE IMAGES rules. Do not research anything new.

${digest}

The block above is the real dataset — the ONLY project numbers you may quote. Never invent a figure.

${leads.map((l) => `id: ${l.id}\nplatform: ${l.platform}  (thread: ${l.title})\nlanding: ${l.landing}\ncurrent draft:\n${l.draft}\n`).join("\n---\n")}`;
  const res = await client.beta.messages.stream({
    model: MODEL, max_tokens: 32000, betas: ["server-side-fallback-2026-06-01"], fallbacks: [{ model: "claude-opus-4-8" }],
    system: SYSTEM, output_config: { effort: "medium", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  }).finalMessage();
  if (res.stop_reason === "max_tokens") throw new Error(`rewrite hit max_tokens (${res.usage.output_tokens} out)`);
  if (res.stop_reason === "refusal") throw new Error("model declined the rewrite");
  const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  const json = text.trim().startsWith("{") ? text : /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) throw new Error("model returned no JSON");
  const parsed = JSON.parse(json) as { drafts: Array<{ id: string; draft: string; shots: ShotSpec[] }> };
  return new Map(parsed.drafts.map((d) => [d.id, { draft: d.draft, shots: d.shots ?? [] }]));
}

// ---------------------------------------------------------------- main

async function main() {
  await loadIndex();
  // Pick the digest projects, correct their complaint counts, then build the digest from the corrected rows.
  note(`complaints: read the per-registration count for ${await loadRegistrationComplaints(projectDigest().ids)} projects`);
  const { text: digest, ids: digestIds } = projectDigest();

  if (REWRITE) {
    const queue = readJson<ScoutQueue>(QUEUE_FILE, EMPTY_QUEUE);
    if (!queue.leads.length) return note("nothing on the board to rewrite");
    let changed = 0;
    for (let i = 0; i < queue.leads.length; i += REWRITE_BATCH) {
      const batch = queue.leads.slice(i, i + REWRITE_BATCH);
      try {
        for (const [id, r] of await rewriteBatch(batch, digest)) {
          const lead = queue.leads.find((l) => l.id === id); if (!lead) continue;
          const draft = r.draft ? enforceLinks(lead.platform, r.draft, lead.landing) : "";
          if (draft && draft !== lead.draft) { lead.draft = draft; changed++; }
          if (r.shots?.length) lead.shots = r.shots.slice(0, MAX_SHOTS).map((s) => ({ ...s, url: shotUrl(s) }));
        }
      } catch (err) { fail(`rewrite batch ${i / REWRITE_BATCH + 1}`, err); }
    }
    changed += linkHalfOfQuora(queue.leads);
    note(`rewrote ${changed} drafts`);
    if (!DRY_RUN && changed) fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
    return;
  }

  const startedAt = new Date();
  note(`cycle start ${startedAt.toISOString()}${DRY_RUN ? " (dry run)" : ""}`);

  const history = readJson<HistoryEntry[]>(HISTORY_FILE, []);
  const seen = new Set(history.map((h) => h.id));

  const token = await redditToken();
  if (token) note("reddit: using OAuth API");
  const [reddit, hn] = await Promise.all([token ? fromRedditApi(token) : fromReddit(), fromHn()]);
  const links = linkMap(digestIds);
  const raw = [...reddit, ...hn];
  note(`sweep: ${reddit.length} reddit + ${hn.length} hn · ${links.length} linkable pages · ${digestIds.size} projects in the digest`);

  const byId = new Map<string, Candidate>();
  let skippedSeen = 0;
  for (const c of raw) {
    const id = sha1(canonical(c.url));
    if (seen.has(id)) { skippedSeen++; continue; }
    if (!byId.has(id)) byId.set(id, c);
  }
  const candidates = [...byId.values()];
  note(`${candidates.length} fresh candidates (${skippedSeen} already surfaced)`);

  let judged: Omit<ScoutLead, "id" | "foundAt">[] = [];
  let judgeFailed = false;
  try {
    judged = await judge(candidates, links, digest);
  } catch (err) {
    fail("judge", err);
    judgeFailed = true;
  }

  const foundAt = startedAt.toISOString();
  const allowed = new Set(links.map((u) => u.replace(/\/+$/, "")));
  const leads: ScoutLead[] = judged
    .filter((l) => { const ok = allowed.has(l.landing.replace(/\/+$/, "")); if (!ok) fail("landing", `dropped lead with unlisted link ${l.landing}`); return ok; })
    .filter((l) => !seen.has(sha1(canonical(l.url))))
    .filter((l) => {
      const limit = maxAgeFor(l.platform);
      if (limit === null) return true;
      const t = l.postedAt ? Date.parse(l.postedAt) : NaN;
      const label = l.title.slice(0, 50);
      if (Number.isNaN(t)) { fail("age", `dropped ${l.platform} "${label}" — no usable postedAt`); return false; }
      const hrs = (Date.now() - t) / 36e5;
      if (hrs > limit) { fail("age", `dropped ${l.platform} "${label}" — posted ${Math.round(hrs)}h ago`); return false; }
      return true;
    })
    .map((l) => ({
      ...l,
      draft: enforceLinks(l.platform, l.draft, l.landing),
      id: sha1(canonical(l.url)),
      fit: Math.max(0, Math.min(100, Math.round(l.fit))),
      evergreen: maxAgeFor(l.platform) === null && !!l.evergreen,
      // Shots may only point at real projects and localities; anything else is dropped.
      shots: (l.shots ?? []).filter((s) => (s.kind === "map" || s.kind === "list") || (s.projectId && digestIds.has(s.projectId) && (s.kind !== "compare" || digestIds.has(s.projectIdB)))).slice(0, MAX_SHOTS).map((s) => ({ ...s, url: shotUrl(s) })),
      foundAt,
    }))
    .sort((a, b) => b.fit - a.fit)
    .slice(0, LIMIT);

  const byPlatform: Record<string, number> = {};
  for (const l of leads) byPlatform[l.platform] = (byPlatform[l.platform] ?? 0) + 1;

  const queue: ScoutQueue = {
    generatedAt: foundAt,
    leads,
    stats: { candidates: candidates.length, kept: leads.length, skippedSeen, byPlatform, errors },
  };

  note(`${leads.length} leads: ${Object.entries(byPlatform).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  for (const l of leads) note(`  ${l.fit} · ${l.platform} · ${l.title.slice(0, 70)}`);

  if (DRY_RUN) { console.log(JSON.stringify(queue, null, 2)); return; }

  const previous = readJson<ScoutQueue>(QUEUE_FILE, null as unknown as ScoutQueue);
  const carried = (previous?.leads ?? []).filter((l) => {
    if (leads.some((n) => n.id === l.id)) return false;
    const limit = maxAgeFor(l.platform);
    if (limit === null) return true;
    return Date.now() - Date.parse(l.foundAt) < limit * 36e5;
  });
  queue.leads = [...leads, ...carried].sort((a, b) => b.fit - a.fit);
  const linkedQuora = linkHalfOfQuora(queue.leads);
  if (linkedQuora) note(`quora: added the PropertyLens link to ${linkedQuora} answer(s)`);

  const before = (previous?.leads ?? []).map((l) => l.id).join(",");
  const after = queue.leads.map((l) => l.id).join(",");
  if (before === after && leads.length === 0) {
    note("no change to the queue — leaving it untouched");
    if (judgeFailed) throw new Error("cycle produced no leads because the judge failed — see errors above");
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  fs.writeFileSync(HISTORY_FILE, JSON.stringify([...leads.map((l) => ({ id: l.id, url: l.url, seenAt: foundAt })), ...history].slice(0, HISTORY_MAX), null, 2));
  note(`wrote ${queue.leads.length} leads to data/scout-queue.json`);
}

main().catch((err) => {
  console.error("[scout] fatal:", err);
  process.exit(1);
});
