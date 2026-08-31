# BLR. — Bangalore News App

## Run it locally
1. `npm install`
2. Set your APITube API key (see below), then `node server.js`
3. Open http://localhost:3000

## News source: APITube
Sign up free at https://apitube.io — no credit card needed. Their free tier
(1,000 requests/day) is genuinely real-time (no delay, unlike most "free"
news APIs) and explicitly permits commercial use, confirmed directly on
their site. This app checks 6 category queries every 15 minutes
(~576 requests/day, safely under the 1,000/day limit).

Set the key as an environment variable, not hardcoded in the code:
- **Render**: dashboard → your service → Environment tab → add
  `APITUBE_API_KEY` = your key → Save (triggers auto-redeploy)
- **Local Windows testing**: `set APITUBE_API_KEY=your_key_here && node server.js`

Without a key set, the app still runs but returns zero live stories (the
frontend falls back to sample data with an "Offline preview" notice).

## Why not Google News or NewsData.io?
Both were tried and removed:
- **Google News**: Google's own Terms of Service explicitly ban using it
  "to increase traffic to your Web site for commercial reasons, such as
  advertising sales" — directly conflicts with running ads.
- **NewsData.io**: free tier works, and explicitly permits commercial use,
  but has a built-in ~12-hour delay on data, which defeats the point of a
  "latest news" app. Removing the 12-hour delay requires their $199.99/month
  Basic plan — too expensive for this project's stage.
- **The Hindu, Deccan Herald, Indian Express, Bangalore Mirror**: all
  checked directly — each either explicitly restricts commercial/ad-supported
  use in their RSS terms, or (Bangalore Mirror) had a broken feed URL.

## How the backend works
- `server.js` queries APITube for 6 categories, strips HTML, trims each
  summary to ~60 words, and caches results for 15 minutes.
- `GET /api/news` — cached news (fast)
- `GET /api/news/refresh` — force a fresh fetch, bypassing cache (careful —
  this also counts against your daily APITube quota, so don't automate it)
- `GET /api/vapid-public-key` — public key for the push subscription flow
- `POST /api/subscribe` / `POST /api/unsubscribe` — manage push subscriptions
- `POST /api/newsletter/subscribe` — stores an email address (no sending
  built yet)
- Three small JSON files (`subscriptions.json`, `seen-links.json`,
  `newsletter-emails.json`) are created automatically to persist state
  across server restarts — safe to delete any of them to reset that state.

## Filters applied to every story
- **Relevance**: must mention Bangalore/Bengaluru/Karnataka, a Karnataka
  district/city, or a known local civic body (BBMP, BMRCL, etc.) — drops
  off-topic national content some queries can return.
- **Recency**: nothing older than 7 days makes it into the feed.
- **Dedup**: compares meaningful word overlap between headlines (not just
  exact matches) so the same real-world story covered by two outlets with
  different wording doesn't show up twice.

## Before running ads
This app's current source (APITube) explicitly permits commercial use on
its free tier — but if you add more sources later, check each one's terms
first. Many major Indian publishers (Deccan Herald, Indian Express, and
likely others) restrict RSS use for commercial/ad-supported pages.

## Setting up real ads (Google AdSense)
The ad slots currently show a friendly placeholder. To switch them to real ads:

1. **Deploy the app first.** AdSense reviews and approves specific public
   URLs — it won't work on localhost, and you can't apply without a live site.
2. Sign up at https://adsense.google.com with your deployed site's URL.
3. Once approved, AdSense gives you a **publisher ID** (`ca-pub-...`) and,
   per ad unit you create, a **slot ID** (a number).
4. Open `public/index.html`, find `ADSENSE_CLIENT_ID` and `ADSENSE_SLOT_ID`
   near the top of the script section, and fill both in.
5. Fill in your publisher ID in `public/ads.txt` too (required for AdSense
   to verify your domain — the file explains the exact format).
6. Redeploy. The placeholders will automatically switch to real ad units —
   no other code changes needed.

## Adding more sources later
Add entries to the `APITUBE_QUERIES` array in `server.js` — each needs a
`category` (matching a UI chip) and a `q` search query. Check APITube's docs
at https://docs.apitube.io for the full query syntax (supports AND/OR/NOT,
exact phrases, and more).

## Push notifications in production
The VAPID keys in `server.js` are hardcoded for local development. Before
deploying publicly, generate your own with `npx web-push generate-vapid-keys`
and move them to environment variables instead.
