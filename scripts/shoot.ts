/**
 * Screenshot agent — renders the exact PropertyLens view each lead's shot spec
 * names, so the owner has an image to attach when they post.
 *
 *   npx tsx scripts/shoot.ts            # shoot every lead missing an image
 *   npx tsx scripts/shoot.ts --force    # re-shoot everything
 *
 * A link alone gets scrolled past on X and LinkedIn; a picture of the tool
 * actually answering the question is what earns the click. Each shot kind maps
 * to one region of one page, clipped so the image is the answer and nothing else.
 *
 * Images live in public/scout/ and are pruned to whatever is currently on the
 * board — otherwise the repo grows by ~10 PNGs every cycle, forever.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { EMPTY_QUEUE, MAX_SHOTS, type ScoutLead, type ShotSpec, type ScoutQueue } from "../lib/scout";

const SITE = process.env.SITE_URL ?? "https://property-lens.ai";
const QUEUE_FILE = path.join(process.cwd(), "data", "scout-queue.json");
const SHOT_DIR = path.join(process.cwd(), "public", "scout");
const FORCE = process.argv.includes("--force");

const note = (m: string) => console.log(`[shoot] ${m}`);

const FALLBACK_SPEC: ShotSpec = { kind: "project", projectId: "", projectIdB: "", locality: "", developer: "", url: "", caption: "" };

/** The page a shot captures, derived from its fields so a stale or invented url can never be used. */
function targetFor(spec: ShotSpec, landing: string): string {
  if (spec.kind === "project" && spec.projectId) return `${SITE}/p/${spec.projectId}`;
  if (spec.kind === "dd" && spec.projectId) return `${SITE}/p/${spec.projectId}`;
  if (spec.kind === "compare" && spec.projectId && spec.projectIdB) return `${SITE}/compare?a=${spec.projectId}&b=${spec.projectIdB}`;
  if (spec.kind === "map") return `${SITE}/map${spec.locality ? `?loc=${encodeURIComponent(spec.locality)}` : ""}`;
  if (spec.kind === "list") return `${SITE}/${spec.developer ? `?dev=${encodeURIComponent(spec.developer)}` : ""}`;
  return landing;
}

/** Which part of the page carries the argument for each kind. */
const FOCUS: Record<ShotSpec["kind"], { sel: string; maxH: number; width: number }> = {
  project: { sel: "#hero", maxH: 760, width: 1200 },
  dd: { sel: "#dd", maxH: 900, width: 1200 },
  compare: { sel: "table.cmp", maxH: 900, width: 1200 },
  map: { sel: ".mapcard", maxH: 720, width: 1200 },
  list: { sel: "#cards", maxH: 720, width: 1200 },
};

async function shoot(page: Page, lead: ScoutLead, spec: ShotSpec, out: string): Promise<void> {
  const f = FOCUS[spec.kind] ?? FOCUS.project;
  await page.setViewportSize({ width: f.width, height: 900 });
  const target = targetFor(spec, lead.landing);
  await page.goto(target, { waitUntil: "networkidle", timeout: 60_000 });
  // The share row and bottom nav sit over the content on every page.
  await page.addStyleTag({ content: `.sharebar,.bottomnav,.tip{display:none!important}` }).catch(() => {});
  if (spec.kind === "map") await page.waitForTimeout(6000); // tiles and clusters
  else if (spec.kind === "compare" || spec.kind === "list") await page.waitForTimeout(3500); // client data
  else await page.waitForTimeout(1200);
  if (spec.kind === "list") {
    // Cards are pre-rendered; a developer filter re-renders them from the index once it loads.
    await page.waitForTimeout(1500);
  }
  const el = page.locator(f.sel).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  const box = await el.boundingBox().catch(() => null);
  if (box && box.width > 200) {
    await page.screenshot({
      path: out,
      fullPage: true,
      clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 10), width: Math.min(box.width + 20, f.width), height: Math.min(box.height + 20, f.maxH) },
    });
    return;
  }
  await page.screenshot({ path: out });
}

async function main() {
  const queue: ScoutQueue = (() => { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")) as ScoutQueue; } catch { return EMPTY_QUEUE; } })();
  if (!queue.leads.length) return note("no leads on the board — nothing to shoot");
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
  const page = await ctx.newPage();

  let shot = 0, skipped = 0;
  const live = new Set<string>();
  for (const lead of queue.leads) {
    const specs = (lead.shots?.length ? lead.shots : [FALLBACK_SPEC]).slice(0, MAX_SHOTS);
    for (const [i, spec] of specs.entries()) {
      const name = `${lead.id}-${i}.png`;
      live.add(name);
      const out = path.join(SHOT_DIR, name);
      if (!FORCE && fs.existsSync(out)) { skipped++; continue; }
      try {
        await shoot(page, lead, spec, out);
        shot++;
        note(`${lead.id}[${i}] ${spec.kind} <- ${targetFor(spec, lead.landing).replace(/^https?:\/\/[^/]+/, "")}`);
      } catch (err) {
        note(`FAILED ${lead.landing} [${spec.kind}]: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  await browser.close();

  let pruned = 0;
  for (const file of fs.readdirSync(SHOT_DIR)) {
    if (file.endsWith(".png") && !live.has(file)) { fs.unlinkSync(path.join(SHOT_DIR, file)); pruned++; }
  }
  note(`${shot} shot, ${skipped} already had one, ${pruned} pruned`);
}

main().catch((err) => { console.error("[shoot] fatal:", err); process.exit(1); });
