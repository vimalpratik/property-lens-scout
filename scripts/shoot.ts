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

// ---------------------------------------------------------------- map shots

interface GeoRow { id: string; name: string; builderName: string; locality: string; localityName: string; score: number; geo?: { lat: number; lng: number } }
let INDEX: GeoRow[] | null = null;
async function loadIndex(): Promise<GeoRow[]> {
  if (!INDEX) INDEX = (await (await fetch(`${SITE}/data/index.json`)).json()) as GeoRow[];
  return INDEX;
}

/** Score bands as the site colours them. */
const band = (s: number) => (s >= 55 ? "#3ecf8e" : s >= 40 ? "#e08a3c" : "#d9534f");
const MAP_LABELS = 10;

/**
 * The site's live map clusters a corridor into "143 projects" bubbles, which
 * proves nothing. Draw the corridor from the dataset instead: every project as
 * a dot in its score colour, and the top projects (plus any the draft names)
 * labelled with name and score, so the image shows actual projects.
 */
async function shootMap(page: Page, lead: ScoutLead, spec: ShotSpec, out: string): Promise<void> {
  const ok = (r: GeoRow) => !!r.geo && Number.isFinite(r.geo.lat) && Number.isFinite(r.geo.lng);
  const rows = (await loadIndex()).filter((r) => ok(r) && (!spec.locality || r.locality === spec.locality));
  if (!rows.length) throw new Error(`no projects with coordinates for locality "${spec.locality}"`);
  const draft = lead.draft.toLowerCase();
  const named = rows.filter((r) => r.name.length > 4 && draft.includes(r.name.toLowerCase()));
  const labelled = [...new Set([...named, ...[...rows].sort((a, b) => b.score - a.score)])].slice(0, Math.max(MAP_LABELS, named.length));
  const ids = new Set(labelled.map((r) => r.id));
  const data = {
    area: spec.locality ? rows[0].localityName : "Bengaluru",
    total: rows.length,
    nLabels: labelled.length,
    pts: rows.map((r) => ({ lat: r.geo!.lat, lng: r.geo!.lng, c: band(r.score), s: r.score, l: ids.has(r.id) ? `${r.name} · ${Math.round(r.score)}` : "" })),
  };
  await page.setViewportSize({ width: 1200, height: 760 });
  // Drawn on property-lens.ai itself so the site's own Google Maps key (referrer-locked) loads the basemap.
  await page.goto(`${SITE}/map`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => !!(window as unknown as { google?: { maps?: { Map?: unknown } } }).google?.maps?.Map, null, { timeout: 30_000 });
  await page.evaluate(`(${MAP_SCRIPT})(${JSON.stringify(data).replace(/</g, "\\u003c")})`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 30_000 }).catch(() => note("map tiles did not finish loading"));
  await page.waitForTimeout(1000);
  await page.locator("#plshot").screenshot({ path: out });
}

/** Runs in the page: replaces it with a titled map, score-coloured dots, and collision-free labels. */
const MAP_SCRIPT = String.raw`function (d) {
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  document.body.innerHTML = '<div id="plshot"><div id="plhead"><div><h1>' + esc(d.area) + '</h1><p>' + d.total +
    ' analysed projects · top ' + d.nLabels + ' by investment score labelled (0–100)' +
    '<span class="k"><i style="background:#3ecf8e"></i>55+</span><span class="k"><i style="background:#e08a3c"></i>40–54</span>' +
    '<span class="k"><i style="background:#d9534f"></i>under 40</span></p></div><div id="plbrand"><b>PropertyLens</b><br>RERA filings · Sep 2026</div></div>' +
    '<div id="plmap"></div></div>';
  const st = document.createElement("style");
  st.textContent = 'html,body{margin:0!important;background:#0f1614!important;overflow:hidden}' +
    '#plshot{position:fixed;inset:0;width:1200px;height:760px;display:flex;flex-direction:column;background:#0f1614;color:#e8efe9;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;z-index:99999}' +
    '#plhead{padding:18px 24px 12px;display:flex;justify-content:space-between;align-items:flex-end}' +
    '#plhead h1{margin:0;font-size:26px;font-weight:700;color:#e8efe9}#plhead p{margin:4px 0 0;color:#9fb0a8;font-size:15px}' +
    '#plbrand{font-size:15px;color:#9fb0a8;text-align:right}#plbrand b{color:#e8efe9;font-size:18px}' +
    '#plmap{flex:1;margin:0 24px 24px;border-radius:14px;overflow:hidden}' +
    '.k{display:inline-flex;align-items:center;gap:6px;margin-left:14px}.k i{width:11px;height:11px;border-radius:50%;display:inline-block}' +
    '.pd{position:absolute;border-radius:50%;transform:translate(-50%,-50%)}' +
    '.pl{position:absolute;white-space:nowrap;background:#18211e;border:1px solid #3a4a44;color:#e8efe9;font:600 13px -apple-system,"Segoe UI",Roboto,sans-serif;padding:3px 7px;border-radius:6px}' +
    '.ln{position:absolute;height:1px;background:#7d8f88;transform-origin:0 0}';
  document.head.appendChild(st);
  const dark = [
    { elementType: "geometry", stylers: [{ color: "#1b2421" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#8a9a93" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#141c19" }] },
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c3834" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3b4a45" }] },
    { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1a1f" }] },
  ];
  const map = new google.maps.Map(document.getElementById("plmap"), { styles: dark, disableDefaultUI: true, backgroundColor: "#1b2421", keyboardShortcuts: false });
  const lab = d.pts.filter((p) => p.l);
  const b = new google.maps.LatLngBounds();
  lab.forEach((p) => b.extend(p));
  map.fitBounds(b, { top: 70, bottom: 60, left: 200, right: 200 });
  class Layer extends google.maps.OverlayView {
    onAdd() { this.div = document.createElement("div"); this.getPanes().floatPane.appendChild(this.div); }
    draw() {
      const pr = this.getProjection(); const W = this.div; W.innerHTML = "";
      const px = (p) => pr.fromLatLngToDivPixel(new google.maps.LatLng(p.lat, p.lng));
      for (const p of d.pts.filter((q) => !q.l)) { const o = px(p); const e = document.createElement("div"); e.className = "pd";
        Object.assign(e.style, { left: o.x + "px", top: o.y + "px", width: "9px", height: "9px", background: p.c, opacity: "0.8" }); W.appendChild(e); }
      const placed = []; const pins = lab.map((p) => ({ p, o: px(p) }));
      // div-pixel -> container-pixel offset, so labels can be kept inside the visible frame
      const c0 = pr.fromLatLngToContainerPixel(new google.maps.LatLng(lab[0].lat, lab[0].lng)), d0 = px(lab[0]);
      const ox = d0.x - c0.x, oy = d0.y - c0.y, box = document.getElementById("plmap"), BW = box.offsetWidth, BH = box.offsetHeight;
      const outside = (r) => Math.max(0, ox + 8 - r.x) + Math.max(0, r.x + r.w - (ox + BW - 8)) + Math.max(0, oy + 8 - r.y) + Math.max(0, r.y + r.h - (oy + BH - 30));
      for (const { o } of pins) placed.push({ x: o.x - 9, y: o.y - 9, w: 18, h: 18 });
      const hit = (r) => placed.reduce((n, q) => n + Math.max(0, Math.min(r.x + r.w, q.x + q.w) - Math.max(r.x, q.x)) * Math.max(0, Math.min(r.y + r.h, q.y + q.h) - Math.max(r.y, q.y)), 0);
      const measure = (t) => { const e = document.createElement("div"); e.className = "pl"; e.textContent = t; e.style.visibility = "hidden"; W.appendChild(e); const r = { w: e.offsetWidth, h: e.offsetHeight }; e.remove(); return r; };
      for (const { p, o } of [...pins].sort((a, c) => c.p.s - a.p.s)) {
        const m = measure(p.l); let best = null;
        for (const dist of [12, 34, 60, 90]) for (const [dx, dy] of [[1, 0], [-1, 0], [1, -1], [1, 1], [-1, -1], [-1, 1], [0, -1], [0, 1]]) {
          const x = dx > 0 ? o.x + dist : dx < 0 ? o.x - dist - m.w : o.x - m.w / 2;
          const y = dy > 0 ? o.y + dist * 0.6 : dy < 0 ? o.y - dist * 0.6 - m.h : o.y - m.h / 2;
          const r = { x, y, w: m.w, h: m.h }; const s = hit(r) * 10 + outside(r) * 2000 + dist;
          if (!best || s < best.s) best = { r, s };
        }
        placed.push(best.r);
        const cx = Math.max(best.r.x, Math.min(o.x, best.r.x + best.r.w)), cy = Math.max(best.r.y, Math.min(o.y, best.r.y + best.r.h));
        const len = Math.hypot(cx - o.x, cy - o.y);
        if (len > 14) { const ln = document.createElement("div"); ln.className = "ln";
          Object.assign(ln.style, { left: o.x + "px", top: o.y + "px", width: len + "px", transform: "rotate(" + Math.atan2(cy - o.y, cx - o.x) + "rad)" }); W.appendChild(ln); }
        const e = document.createElement("div"); e.className = "pl"; e.textContent = p.l; Object.assign(e.style, { left: best.r.x + "px", top: best.r.y + "px" }); W.appendChild(e);
      }
      for (const { p, o } of pins) { const e = document.createElement("div"); e.className = "pd";
        Object.assign(e.style, { left: o.x + "px", top: o.y + "px", width: "15px", height: "15px", background: p.c, border: "2px solid #0f1614" }); W.appendChild(e); }
    }
  }
  new Layer().setMap(map);
  google.maps.event.addListenerOnce(map, "tilesloaded", () => setTimeout(() => { window.__ready = true; }, 600));
}`;

async function shoot(page: Page, lead: ScoutLead, spec: ShotSpec, out: string): Promise<void> {
  if (spec.kind === "map") return shootMap(page, lead, spec, out);
  const f = FOCUS[spec.kind] ?? FOCUS.project;
  await page.setViewportSize({ width: f.width, height: 900 });
  const target = targetFor(spec, lead.landing);
  await page.goto(target, { waitUntil: "networkidle", timeout: 60_000 });
  // The share row and bottom nav sit over the content on every page.
  // The site header and the project bar are sticky: left alone they get painted
  // across the middle of any crop below the fold. Pin them to the top instead.
  await page.addStyleTag({ content: `.sharebar,.bottomnav,.tip{display:none!important} header.top,.projhead{position:static!important}` }).catch(() => {});
  if (spec.kind === "compare" || spec.kind === "list") await page.waitForTimeout(3500); // client data
  else await page.waitForTimeout(1200);
  if (spec.kind === "list") {
    // Cards are pre-rendered; a developer filter re-renders them from the index once it loads.
    await page.waitForTimeout(1500);
  }
  const el = page.locator(f.sel).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  // fullPage clips are in document coordinates; boundingBox() is viewport-relative.
  const box = await el.evaluate((n) => { const r = n.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; }).catch(() => null);
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
