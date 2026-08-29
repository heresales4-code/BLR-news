# BLR. — Bangalore News App

## Run it locally
1. `npm install`
2. `node server.js`
3. Open http://localhost:3000

## Features
- **Live news** from The Hindu (Karnataka) plus category-specific Google News
  feeds for Traffic, Metro, Tech, Weather, Civic, Karnataka, and South India.
- **Search** — filters the current feed by headline/summary as you type.
- **Bookmarks** — tap the bookmark icon on any story to save it (stored in
  your browser via localStorage). View saved stories from the "Saved" tab.
- **Push notifications** — tap "Notify" in the bottom nav to subscribe. The
  server checks feeds every 10 minutes in the background and pushes a
  notification when genuinely new stories appear (skips the very first run
  so you don't get flooded on startup).

## How the backend works
- `server.js` fetches feeds, strips HTML, trims each summary to ~60 words,
  classifies stories by category, and caches results for 10 minutes.
- `GET /api/news` — cached news (fast)
- `GET /api/news/refresh` — force a fresh fetch, bypassing cache
- `GET /api/vapid-public-key` — public key for the push subscription flow
- `POST /api/subscribe` / `POST /api/unsubscribe` — manage push subscriptions
- Two small JSON files (`subscriptions.json`, `seen-links.json`) are created
  automatically to persist push subscribers and "already notified" story
  links across server restarts — safe to delete either to reset that state.

## If feeds return 403 or 404
Some sites block requests from datacenter/cloud IPs (Cloudflare-style bot
protection) — try running from a residential connection first. 404s usually
mean the publisher moved their RSS URL; check their site for the current one.
The Google News search feeds are generally the most reliable since they
aggregate from many sources.

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

Worth knowing: AdSense's policies favor sites with substantial original
content. Since this app mainly aggregates headlines from other publishers,
approval isn't guaranteed — adding your own commentary, local context, or
original write-ups alongside the aggregated stories can help.

## Before running ads against any feed
Check each publisher's RSS terms first. Deccan Herald, for example, explicitly
disallows using their RSS feed on a page run "for commercial gain" — which would
include ad-supported pages. Confirm terms per source before monetizing.

## Adding more sources
Add entries to the `FEEDS` array in `server.js`. For a normal publisher feed:
{ name: 'Source Name', url: 'https://.../feed.rss', category: 'Traffic' }
For a Google News search feed (recommended for reliability):
{ name: 'Google News', url: 'https://news.google.com/rss/search?q=YOUR+QUERY&hl=en-IN&gl=IN&ceid=IN:en', category: 'Traffic', isGoogleNews: true }
`category` should match one of the chip filters in the frontend.

## Push notifications in production
The VAPID keys in `server.js` are hardcoded for local development. Before
deploying publicly, generate your own with `npx web-push generate-vapid-keys`
and move them to environment variables instead.
