# Sitewright Chatbot Kit

A working AI chat widget + backend + admin dashboard, built for the "build fee +
retainer" business we scoped together. This version has all six upgrades we
discussed: memory, lead capture, retrieval, streaming, an admin dashboard, and
human handoff.

## What's in here

```
server.js              backend — streaming chat, leads, handoffs, admin API
retrieval.js            picks the most relevant knowledge-base paragraphs per question
scheduler.js             runs monthly reports + fallback alerts, on a schedule or once
lib/stats.js             shared stats logic (all-time and monthly-window)
lib/report.js            builds + saves the monthly client report
lib/alerts.js            fallback-rate watchdog, alerts once/day via webhook
lib/scraper.js           crawls a client's site so the AI can draft their knowledge base
clients/example.json    one file per client: persona + rules (short, not full of facts)
knowledge/example.txt   the client's actual facts — one paragraph per topic
public/widget.js        the embeddable widget (drop-in <script> tag)
public/demo.html         a stand-in "client site" so you can see it running
public/dashboard.html   simple client-facing report (conversations, top questions)
public/admin.html        YOUR view — all clients, leads, handoffs, knowledge editor,
                          AI-assisted edits, and on-demand report generation
analytics/ leads/ handoffs/ reports/   auto-created — one log per client per category
```

## Run it locally

```bash
npm install
cp .env.example .env        # then paste your Anthropic API key into .env
npm start
```

- `http://localhost:3000/demo.html` — the widget running on a stand-in client site
- `http://localhost:3000/admin.html` — your multi-client control panel
- `http://localhost:3000/dashboard.html?clientId=example` — the simpler report you'd show a client

Without a key in `.env` it still runs in demo mode (canned streaming replies) so
you can see the UI immediately.

## The six upgrades, and where to find each one

**1. Memory** — `public/widget.js` keeps the conversation in a `history` array
and sends it with every request; `server.js` passes it straight to Claude as
prior turns. Capped to the last 10 turns so token usage stays bounded.

**2. Lead capture** — the system prompt (`clients/example.json`,
`systemPromptTemplate`) instructs the model to end a reply with the marker
`[[CAPTURE_LEAD]]` when it can't answer or the visitor shows buying intent.
`server.js` strips the marker before the visitor sees it and tells the widget
to show an inline name/contact form. Submissions land in `leads/<clientId>.jsonl`
and show up in the admin dashboard.

**3. Retrieval** — `retrieval.js` scores each paragraph in
`knowledge/<clientId>.txt` against the visitor's question (keyword/TF-IDF
scoring, no extra API key needed) and only sends the top 3 matches into the
system prompt. This is what lets a client's knowledge base grow past a
one-page FAQ without blowing up your token cost or confusing the model — and
it's what the admin dashboard's knowledge editor writes to.

*Honest limitation:* this is keyword scoring, not true semantic embeddings —
it stems words (rent/rental/rentals match) but won't catch a question phrased
with completely different words than the knowledge base uses. Good enough
through your first several clients; if a client's content library gets large
or their visitors phrase things very differently than the source docs, swap
`retrieval.js` for a real embeddings provider (Voyage AI pairs natively with
Anthropic) — nothing else in the codebase needs to change, since every call
site only depends on `topChunks()` returning an array of strings.

**4. Streaming** — `POST /api/chat/stream` streams the reply as
server-sent events; `widget.js` reads the response body as a stream and
paints text as it arrives, the way this chat does. A non-streaming
`POST /api/chat` also exists for quick testing with curl.

**5. Admin dashboard** — `public/admin.html`. Pick a client from the dropdown,
see their stats, leads, and handoffs, and edit their knowledge base directly
in a textarea (saves to `knowledge/<clientId>.txt` — the exact file retrieval
reads from). This is the thing that saves you time once you're past 2-3
clients and juggling files by hand gets old.

Every panel on the page — stats, leads, handoffs, knowledge base, changelog —
is scoped to whichever client is selected; each client's data lives in its
own files, so there's no crossover. To keep several clients open at once,
click **"Open in new tab"** next to the dropdown. Each tab remembers its
client in its own URL (`admin.html?client=acme-bikes`), so one tab can stay
pinned to Acme Bike Co while another stays pinned to a different client —
bookmark one tab per client you check often, and it'll always load straight
to that client instead of resetting to whichever one loads first.

**6. Human handoff** — a "Talk to a person" button is always visible in the
widget header. Clicking it logs the request to `handoffs/<clientId>.jsonl`
(visible in the admin dashboard) and, if you set `handoffWebhookUrl` in a
client's config file, posts a notification there too (a Slack incoming
webhook URL works directly — paste it into that field and any handoff pings
your Slack).

## Using this for a real prospect (your outreach hook)

**The fast way — one URL in, a working bot out.** Open `admin.html`. At the
top there's an "Add a new client" box. Paste their homepage URL — and, if
they run a separate FAQ or support site, add those too in the box underneath
(one per line) — then click **Create chatbot**. That single action:

1. Creates `clients/<slug>.json` for them — the business name is guessed
   from their main site (`og:site_name`, falling back to the page `<title>`),
   the `clientId` is a slug of that name, and everything else (webhooks,
   alert threshold, the system prompt) gets sane defaults you can edit after.
2. Crawls every site you gave it and drafts one knowledge base from all of
   it combined.
3. With "Auto-apply" checked (the default), saves it straight to
   `knowledge/<slug>.txt` — the bot is answering real questions immediately.
   Uncheck it first if you'd rather review the draft before it goes live.

The client picker at the top of the page auto-selects the new client when
it's done, so you can go straight to testing it in the widget.

**The manual way**, if you'd rather set it up by hand or the auto-build
missed something:

1. Copy `clients/example.json` → `clients/<their-name>.json`, keep the
   `systemPromptTemplate` as-is (it's generic on purpose), just change
   `clientId`, `businessName`, and `brandColor`.
2. Write `knowledge/<their-name>.txt` — one paragraph per fact/policy/topic,
   pulled from their real site. This is the file you'll keep editing (via
   `admin.html`) as their retainer client.
3. Test it against real questions a visitor would actually ask, including
   ones outside the knowledge base — confirm lead capture triggers instead
   of the bot making something up.
4. Send the outreach email pointing to a page running their own trained bot —
   "I already built you something" beats describing it.

## Deploying so it's live on their actual site

This needs to run somewhere reachable 24/7 — localhost is only for your own
testing.

- **Railway** or **Render** — connect this folder to a GitHub repo, both
  build and host it with a public URL, both have cheap/free starter tiers.
- Set `ANTHROPIC_API_KEY` (and optionally `PORT`) as environment variables in
  whichever platform you use — never commit `.env` to the repo.

### Persistent disk (don't skip this before you have real clients)

By default, every client, their knowledge base, leads, and everything else
this app writes lives as plain files right in the project folder. Most
hosting platforms — Render included — wipe that folder clean on every
redeploy unless you attach persistent storage. Skip this and pushing an
update later could wipe out every client you've built.

1. In Render, on your service, add a **Disk** and mount it at `/var/data`
   (any empty path works, but `/var/data` is the convention).
2. Add an environment variable: `DATA_DIR` = `/var/data`.
3. Redeploy. From then on, `clients/`, `knowledge/`, `analytics/`, `leads/`,
   `handoffs/`, and `reports/` all live on that disk instead of the
   project folder, and survive every future deploy.

Leave `DATA_DIR` unset for local testing — everything falls back to living
in the project folder exactly like before, no setup needed.

Once deployed, the client adds one line to their site:

```html
<script src="https://your-deployed-url.example.com/widget.js"
        data-client-id="their-client-id"
        data-business="Their Business Name"
        data-color="#their-brand-color"
        data-endpoint="https://your-deployed-url.example.com"></script>
```

## Password-protecting your dashboard

Once this is deployed, `admin.html` and everything in it — every client's
leads, their private conversations, their knowledge base — is reachable by
anyone who has the URL, unless you set a password. This isn't optional once
real client data is flowing through it.

**How to turn it on — no code, just one setting:**

1. On Render (or wherever you deployed), find where you added
   `ANTHROPIC_API_KEY` as an environment variable.
2. Add a second one right next to it, named exactly `ADMIN_PASSWORD`, and
   set its value to any password you'll remember.
3. Save/redeploy.

That's it. From then on, opening `admin.html` pops up your browser's own
login box asking for a username and password — type anything for the
username (it's ignored) and your real password. Get it right and you're in;
your browser remembers it after that so you're not retyping it constantly.
Anyone without the password is blocked from admin.html and from every
`/api/clients/...` route — they can't view or edit any client's data.

The chat widget itself, and the simple report page you can show a client
(`dashboard.html`), are never behind this password — visitors and clients
need to reach those with no login at all, and they still do.

If you skip this step, the server prints a warning every time it starts up
so you never forget it's unprotected — but nothing stops working, so it's
easy to miss if you're not watching the logs. Set the password before you
send anyone their embed code.

## Abuse protection & cost visibility

Two safeguards run automatically, no setup needed:

**A speed limit per visitor.** If the same visitor sends more than 12
messages in a minute — far more than a real person typing — they get a
"you're sending messages too fast" reply instead of a real (paid-for) one,
until they slow down. This stops one bot or bad actor from running up your
API bill by hammering a client's chat window. Real visitors never notice it.

**A daily volume alert.** The first time a client crosses 300 chat messages
in a single day (a lot for a small local business — tune it with the
`DAILY_MESSAGE_ALERT_THRESHOLD` environment variable if a client's normal
volume runs higher or lower), you get one webhook notification — the same
one used for other alerts — so a real traffic spike, or a client getting
spammed from many different visitors at once, shows up on your radar
instead of silently costing you money. It does NOT block anyone; a real
spike in business is exactly the kind of day you don't want to turn
customers away. If it turns out to be spam, that's when you'd use the
pause button below.

## Pausing a client (if they stop paying)

Once you've handed a client their embed code, it's pasted into their own
website — you can't remove it yourself, and you shouldn't count on them
removing it either. The way you actually take the bot back is by turning it
off from your side, not by touching their site:

1. Open `admin.html` and pick that client from the dropdown.
2. Click **"Pause chatbot"** next to the client picker and confirm.

From that moment, any visitor on their site who talks to the bot just gets
"This chat isn't available right now. Please contact us directly." — no real
answer, and no AI cost to you, since paused clients never call the API.
Click **"Resume chatbot"** the moment they pay again and it's back to normal
instantly, still with all their existing knowledge base intact.

This is also exactly how you'd demo the bot to a prospect before they've
paid at all: build it from their URL, show them `demo.html` (or their embed
code on a private test page) while it's live, and simply don't hand them
the real embed code — or pause it — until payment clears.

## Cutting your own maintenance time (reports, alerts, AI-drafted edits)

Three pieces exist specifically to shrink the "hours per client per month" you
spend on upkeep as you scale:

**Automated monthly reports.** `admin.html` has a "Generate now" button that
builds the report on demand. To have it happen without you remembering:

```bash
node scheduler.js --now      # run once, right now — good for testing
node scheduler.js            # stays running: reports on the 1st at 9am,
                              #   fallback checks daily at 9am
```

The always-running form needs `node-cron` (already in `package.json` as an
optional dependency, so `npm install` gets it). If you'd rather not keep a
second process running, most host platforms (Railway, Render) have their own
scheduled-job feature — point it at `node scheduler.js --now` on whatever
cadence you want instead of running the built-in cron.

Set `reportWebhookUrl` in a client's config file (a Slack incoming webhook
works directly) to have the report posted somewhere the moment it's
generated, instead of only living in `reports/<clientId>/`.

**Fallback-rate alerts.** Runs on the same schedule (daily). If a client's
fallback rate crosses `fallbackAlertThreshold` (default 15%, editable per
client) with enough volume to be meaningful, it posts one alert per day to
`handoffWebhookUrl` — so you find out a knowledge base needs attention
without checking the dashboard yourself. Tested end-to-end: a client at a 33%
fallback rate correctly fires exactly one webhook call with a clear message.

**Build the knowledge base from their website(s).** In `admin.html`, paste a
client's site URL(s) — one per line — into the "Build from their website(s)"
box and click "Scrape site(s)." A lot of small businesses split their content
across more than one site (a main site plus a separate FAQ or support site,
or a booking subdomain), so this isn't limited to one URL: give it every site
that has real information about the business and it crawls all of them (each
one up to 12 pages — using its `sitemap.xml` when it has one, otherwise
following links from its homepage), pulls the visible text off every page,
and has Claude turn the combined result into one set of knowledge-base
paragraphs — merging duplicate info across pages *and* across sites into a
single paragraph per topic. Like the AI-drafted edits below, this only fills
the knowledge editor textarea — nothing saves until you read it over and
click Save yourself. Good for standing up a brand-new client fast; you'll
still want to skim the result for anything the scrape got wrong or missed (a
page buried too deep to be found, a promo banner it mistook for a real
policy, etc.) before it goes live.

The sites you scrape for a client are remembered (`websiteUrls` in their
config file) — the box pre-fills with them next time, and the fallback-rate
watchdog's auto-fix (below) re-scrapes all of them, not just the first one,
when it's trying to close a gap in what the bot knows.

*Honest limitation:* this only sees server-rendered HTML, not anything a
page builds with JavaScript after load. It works fine on most small-business
sites (Squarespace, Wix, WordPress, plain HTML) but if a client's site is a
JS-heavy single-page app and the scrape comes back empty or thin, fall back
to typing the knowledge base in by hand, or view-source a couple of their key
pages and paste the text into the AI-assisted update box below instead.

**AI-drafted knowledge edits.** In `admin.html`, paste a client's raw message
("we're closing early Fridays now") into the box above the knowledge editor
and click "Draft update" — Claude rewrites the relevant paragraph (or adds a
new one) and loads it into the textarea below. Nothing saves automatically:
you review the draft and the change summary, then click the existing Save
button yourself. This is deliberately draft-then-approve, not auto-apply —
a wrong fact silently entering a client's knowledge base is the one failure
mode worth staying in the loop for.

**Fully automated (no click required).** Set `"autoApplyKnowledgeEdits": true`
in a client's config file and two things change:

- The AI-drafted edit box no longer waits for you to click Save — as soon as
  Claude drafts the update, it's written straight to the live knowledge base.
- The fallback-rate alert stops being just a notification. When it fires, it
  re-scrapes the client's own site (remembered automatically the first time
  you scrape them from admin.html) and tries to close the gap itself — but
  **only using facts that are actually on the page.** If a fallback question
  genuinely isn't answered anywhere on the site (a delivery policy that just
  doesn't exist yet, say), it will not invent one; it lists that as still
  needing you, right in the alert message, instead of guessing.

Every automated write — manual, drafted, scraped, or alert-triggered — is
versioned first (`knowledge/<clientId>.history/`), logged to
`knowledge/<clientId>.changelog.jsonl`, and shown in admin.html under "Recent
changes" with a one-click **Undo** button (also `POST
/api/clients/:id/knowledge/rollback`). So "automated" doesn't mean
"unrecoverable" — a bad auto-apply is one click to reverse, and every
automatic change still posts you a message (to `knowledgeWebhookUrl`, or
`handoffWebhookUrl`/`reportWebhookUrl` if you haven't set a dedicated one)
saying exactly what changed, so you're never finding out days later.

**Worth knowing before you flip this on:** with it on, a client's bot can
start saying something new to real visitors without you reading it first.
The grounding-in-the-real-site rule and the instant undo are there
specifically to keep that safe, but they don't replace occasionally
skimming "Recent changes" for a client, especially early on with a new one
— the failure mode this is protecting against isn't "the AI adds a wrong
fact from nowhere" (it's instructed not to), it's "the site itself was
unclear or the scrape picked up a promotional page instead of the real
policy," which the AI can't always tell apart from a person's judgment.
Leave it `false` for any client where you'd rather see every edit first.

**Realistic effect on your time:** once these three are running, the
"maintenance hours per client" you'd plug into the ROI model drops mostly to
"read the alert or report when one arrives, approve or tweak the AI's draft
edit" — a few minutes, not the half-hour-plus of manually checking dashboards
and hand-writing edits this replaces.

## Where the retainer earns its keep

- **Knowledge drift**: their hours/pricing/policies change — you update
  `knowledge/<id>.txt` via the admin dashboard. This is the core maintenance work.
- **The monthly report**: `dashboard.html` numbers, or a screenshot/export of
  `admin.html` — conversations handled, leads captured, resolution rate.
  Leads captured is now your strongest line in that report: it's a direct,
  countable dollar signal, not just "the bot answered some questions."
- **Fallback rate rising**: your signal that the knowledge base needs more
  content — a concrete, billable reason to reach out instead of going quiet
  between invoices.

## What this kit still doesn't do (be upfront with early clients)

- Analytics/leads/handoffs are flat files — fine through your first several
  clients, worth moving to a real database before you're running dozens.
- Retrieval is keyword-based, not true embeddings (see the note under #3).
- Admin login is one shared password (see "Password-protecting your
  dashboard" above), not individual accounts — fine for a one-person shop,
  not built for a team with different access levels.
- The AI-drafted knowledge edits are a starting draft, not a guarantee — read
  the summary and the diff-by-eye before clicking Save, same as you would
  with any edit someone else proposed to a document you're responsible for.
