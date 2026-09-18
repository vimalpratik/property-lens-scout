# PropertyLens distribution scout

Finds live discussions about Bengaluru residential property where a PropertyLens page is genuinely the best answer, drafts the reply, and screenshots the evidence. A human reviews the board at **property-lens.ai/admin/scout** and posts by hand. Nothing here posts anywhere.

- `scripts/scout.ts` — sweep Reddit and Hacker News feeds, then one Claude call with web search judges every candidate, searches X / LinkedIn / Quora itself, picks the deep link and writes the comment. Only numbers from the live PropertyLens dataset (`/data/index.json`) may be quoted.
- `scripts/shoot.ts` — Playwright screenshots of the exact view each lead names (project score card, due-diligence dashboard, comparison, locality map, ranked list).
- `data/scout-queue.json` — the board. `data/scout-history.json` — everything ever surfaced, so a thread is offered once.
- `.github/workflows/scout.yml` — runs every 8 hours and commits the queue. The site reads this repo directly, so no site deploy is needed.

Secrets: `ANTHROPIC_API_KEY` (required), `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` (optional).

Run locally: `npm install && ANTHROPIC_API_KEY=… npm run scout -- --dry-run`.
