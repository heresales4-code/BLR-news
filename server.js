const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ---- Push notifications setup ----
// VAPID keys identify this server to push services (Chrome, Firefox, etc).
// Read from environment variables (set in Render's dashboard under
// Environment) rather than hardcoding them here — keeps them out of your
// public GitHub repo. Generate new ones anytime with:
//   npx web-push generate-vapid-keys
// Note: changing these invalidates any existing push subscriptions — anyone
// already subscribed will need to tap "Notify" again after this change.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:nammablr5@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Subscriptions and "already notified" links are persisted to disk (simple JSON
// files) so they survive server restarts — no database needed for this scale.
const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');
const SEEN_LINKS_FILE = path.join(__dirname, 'seen-links.json');

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let subscriptions = loadJSON(SUBSCRIPTIONS_FILE, []);
let seenLinks = new Set(loadJSON(SEEN_LINKS_FILE, []));

// ---- APITube (news source) ----
// Sign up free at https://apitube.io, get an API key, and paste it below.
// Chosen after Google News (aggregator ToS explicitly bans ad-supported use)
// and NewsData.io (12-hour delay on the free tier) both turned out to be a
// poor fit. APITube's free tier is genuinely real-time AND explicitly
// permits commercial use — confirmed directly on their own site:
// "Yes, the free tier can be used for commercial applications within the
// request limits." Free tier: 1,000 requests/day, 1 request per category
// query below (6 categories) — polling every 15 min uses ~576/day, safely
// under budget. Read from an environment variable (set in Render's
// dashboard under Environment) rather than hardcoding it here — this keeps
// it out of your public GitHub repo entirely. Set APITUBE_API_KEY in
// Render's Environment tab; locally you can still set it by running:
//   set APITUBE_API_KEY=your_key_here && node server.js   (Windows)
const APITUBE_API_KEY = process.env.APITUBE_API_KEY || '';
const APITUBE_ENABLED = !!APITUBE_API_KEY;

const APITUBE_QUERIES = [
  { category: 'Traffic', q: '"Bangalore traffic" OR "Bengaluru traffic" OR "Karnataka traffic" OR "Karnataka roads" OR "BBMP road" OR "Silk Board" OR flyover' },
  { category: 'Metro', q: '"Namma Metro" OR "Bengaluru Metro" OR "Bangalore Metro" OR BMRCL' },
  { category: 'Tech', q: '"Bangalore startup" OR "Bengaluru startup" OR "Bangalore tech" OR Whitefield' },
  { category: 'Civic', q: 'BBMP OR "Bengaluru civic" OR "Bangalore civic" OR "Karnataka civic" OR "Karnataka government"' },
  { category: 'Civic', q: '"Bangalore weather" OR "Bengaluru weather" OR "Karnataka weather" OR "Karnataka rain" OR monsoon' },
  { category: 'Karnataka', q: 'Karnataka' }
];

async function fetchFromAPITube(category, query) {
  const params = new URLSearchParams({
    query,
    'language.code': 'en',
    per_page: '10',
    api_key: APITUBE_API_KEY
  });
  const url = `https://api.apitube.io/v1/news/everything?${params.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`APITube returned ${res.status} for "${category}": ${bodyText.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(`APITube error: ${data.message || 'unknown'}`);

  return (data.results || []).map((item) => ({
    cat: category,
    headline: item.title || '',
    summary: trimSummary(item.description || ''),
    source: item.source?.name || item.source?.domain || 'APITube',
    time: timeAgo(item.published_at),
    pubDate: item.published_at || null,
    link: item.href || '',
    image: upgradeToHttps(item.media?.images?.[0]?.url) || null
  }));
}

// Some sources return http:// image URLs, which browsers silently block on
// an https:// site (mixed content policy) — upgrading to https fixes most of
// these without needing to verify each source individually.
function upgradeToHttps(url) {
  if (!url) return url;
  return url.startsWith('http://') ? url.replace('http://', 'https://') : url;
}

// Cache TTL: APITube's free tier is real-time and generous (1,000 req/day),
// so we can poll far more often than we could with NewsData.io's 200/day —
// every 15 minutes uses only ~576/day across 6 categories.
const cache = new NodeCache({ stdTTL: 900 });

app.use(cors());
app.use(express.static('public'));

// Some sources' description field contains site boilerplate instead of an
// actual article summary — News18's "Rapid Read" AI-summary teaser text,
// generic "Last Updated" metadata, or site navigation menus that leaked in
// (e.g. "Skip to content +91-..."). Strip these out; if nothing substantive
// is left, return empty so the card just shows the headline instead of
// confusing junk text.
const JUNK_PATTERNS = [
  /^News agency-feeds\s*/i,
  /Last Updated:\s*[A-Za-z]+ \d{1,2},?\s*\d{4},?\s*\d{1,2}:\d{2}\s*IST/i,
  /Rapid Read\.?\s*Summarized by AI\.?/i,
  /\+?\s*Got Question about the\.?/i,
  /Skip to content/i,
  /\+91[-\s]?\d{6,10}/g, // Indian phone numbers that leak in from site headers
];

function trimSummary(text, wordLimit = 80) {
  if (!text) return '';
  let plain = text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

  JUNK_PATTERNS.forEach((pattern) => {
    plain = plain.replace(pattern, ' ');
  });
  plain = plain.replace(/\s+/g, ' ').trim();

  // If cleanup stripped most of it away, there's nothing worth showing —
  // a headline-only card is more honest than a fragment of junk text.
  if (plain.length < 20) return '';

  // Promotional/marketing copy that leaked in from a business listing page
  // rather than an actual news article tends to over-use exclamation marks
  // and phrases like "REFER & WIN" — real news descriptions don't write
  // like this, so treat it as junk too.
  const exclamationCount = (plain.match(/!/g) || []).length;
  if (exclamationCount >= 2) return '';

  const words = plain.split(' ');
  if (words.length <= wordLimit) return plain;
  return words.slice(0, wordLimit).join(' ') + '…';
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// APITube (and any future source) can pad thin category queries with
// loosely-related national content instead of just returning fewer results —
// a story about Gujarat civic works or Delhi road cleaning has no business
// in a Bangalore-focused feed. Require every story to actually mention
// Bangalore/Bengaluru/Karnataka, a Karnataka district or city, or a
// well-known Bangalore-specific civic body/acronym.
const KARNATAKA_RELEVANCE_PATTERN = new RegExp(
  '\\b(' + [
    'bengaluru', 'bangalore', 'karnataka', 'namma metro',
    // Karnataka districts / major cities (covers Karnataka-wide, not just city)
    'mysuru', 'mysore', 'hubballi', 'hubli', 'dharwad', 'belagavi', 'belgaum',
    'kalaburagi', 'gulbarga', 'mangaluru', 'mangalore', 'shivamogga', 'shimoga',
    'tumakuru', 'tumkur', 'davanagere', 'vijayapura', 'bijapur', 'ballari', 'bellary',
    'raichur', 'bidar', 'chikkamagaluru', 'chikmagalur', 'hassan', 'mandya',
    'kolar', 'chitradurga', 'haveri', 'gadag', 'koppal', 'yadgir',
    'chamarajanagar', 'kodagu', 'coorg', 'udupi', 'dakshina kannada',
    'uttara kannada', 'bagalkot', 'ramanagara', 'chikkaballapur', 'vijayanagara',
    // Bangalore-specific civic/transit bodies — a strong local signal even
    // when the story doesn't spell out the city name
    'bbmp', 'bmrcl', 'bwssb', 'bescom', 'ksrtc', 'gba', 'silk board',
    'whitefield', 'koramangala', 'indiranagar', 'electronic city', 'yelahanka',
    'jayanagar', 'malleswaram', 'hebbal', 'marathahalli', 'hsr layout'
  ].join('|') + ')\\b',
  'i'
);

function isKarnatakaRelevant(story) {
  const text = `${story.headline} ${story.summary}`;
  return KARNATAKA_RELEVANCE_PATTERN.test(text);
}

// Compare freshly fetched stories against what we've already notified about,
// and push a notification for genuinely new ones. Skips the very first run
// (when seenLinks is empty) so we don't blast 50 "new" stories on first boot.
async function checkForNewStoriesAndNotify(stories) {
  const isFirstRun = seenLinks.size === 0;
  const newStories = stories.filter(s => s.link && !seenLinks.has(s.link));

  stories.forEach(s => { if (s.link) seenLinks.add(s.link); });
  saveJSON(SEEN_LINKS_FILE, [...seenLinks]);

  if (isFirstRun || !newStories.length || !subscriptions.length) return;

  // Cap how many notifications fire per check so a burst of new stories
  // doesn't spam the user with 10 notifications at once.
  const toNotify = newStories.slice(0, 3);

  for (const story of toNotify) {
    const payload = JSON.stringify({
      title: `${story.cat} · BLR News`,
      body: story.headline,
      url: story.link
    });

    // Send to every subscribed browser; drop subscriptions that are no longer valid
    const stillValid = [];
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(sub, payload);
        stillValid.push(sub);
      } catch (err) {
        // 410/404 means the subscription expired or was revoked — safe to drop it
        if (err.statusCode !== 410 && err.statusCode !== 404) stillValid.push(sub);
      }
    }
    subscriptions = stillValid;
  }
  saveJSON(SUBSCRIPTIONS_FILE, subscriptions);
}

// Fetch a story's article page and pull its og:image meta tag — this works
// for virtually any publisher since it's the same image used for social
// sharing previews. Used as a fallback for the rare story APITube doesn't
// already include an image for.
async function fetchOgImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });
    if (!res.ok) return null;
    // Only read enough of the page to find the meta tag (usually in <head>) —
    // avoids downloading full article HTML/images just for one meta value.
    const reader = res.body.getReader();
    let html = '';
    const decoder = new TextDecoder();
    for (let i = 0; i < 30; i++) { // cap how much we read, ~30 chunks is plenty for <head>
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes('</head>') || html.length > 50000) break;
    }
    reader.cancel().catch(() => {});
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return match ? upgradeToHttps(match[1]) : null;
  } catch (err) {
    return null; // timeout, network error, blocked, etc. — just skip the image
  } finally {
    clearTimeout(timeout);
  }
}

// Run og:image lookups for stories missing one, a few at a time so we don't
// fire 50+ concurrent requests (slow, and some hosts will rate-limit that).
async function fillMissingImages(stories, concurrency = 5, cap = 25) {
  const missing = stories.filter(s => !s.image && s.link).slice(0, cap);
  for (let i = 0; i < missing.length; i += concurrency) {
    const batch = missing.slice(i, i + concurrency);
    await Promise.all(batch.map(async (story) => {
      story.image = await fetchOgImage(story.link);
    }));
  }
}

async function fetchAllFeeds() {
  if (!APITUBE_ENABLED) {
    return { stories: [], errors: [{ feed: 'APITube', error: 'APITUBE_API_KEY not set' }], fetchedAt: new Date().toISOString() };
  }

  const jobs = APITUBE_QUERIES.map(({ category, q }) => fetchFromAPITube(category, q));
  const jobLabels = APITUBE_QUERIES.map(q => `APITube (${q.category})`);

  const results = await Promise.allSettled(jobs);

  const stories = [];
  const errors = [];

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      stories.push(...r.value);
    } else {
      errors.push({ feed: jobLabels[i], error: r.reason.message });
    }
  });

  // Newest first
  stories.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

  // Clean up headlines/summaries some sources format oddly (some outlets
  // bake their own name into the title, or repeat the headline as the summary).
  stories.forEach((s) => {
    s.headline = s.headline.replace(/\s*\|\s*Inshorts\s*$/i, '').trim();
    const normHeadline = s.headline.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const normSummary = (s.summary || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (normSummary && (normSummary === normHeadline || normHeadline.startsWith(normSummary) || normSummary.startsWith(normHeadline))) {
      s.summary = '';
    }
  });

  // Dedupe near-duplicate coverage of the same real-world story across
  // sources. Different outlets word the same event completely differently
  // (e.g. "Srinath spotted on Metro" vs "Srinath's Metro photo goes viral"),
  // so exact-match isn't enough — compare significant word overlap instead.
  // Keeps the first occurrence, which after the sort above is the newest.
  const STOPWORDS = new Set(['the','a','an','of','in','on','at','to','for','and','or','is','are','with','his','her','their','after','over']);
  function significantWords(text) {
    return new Set(
      text.toLowerCase()
        .replace(/'s\b/g, '')          // strip possessive 's before removing other punctuation
        .replace(/[^a-z0-9 ]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOPWORDS.has(w))
    );
  }
  function wordOverlapRatio(a, b) {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared / Math.min(a.size, b.size);
  }

  const seenWordSets = [];
  const deduped = stories.filter((s) => {
    if (!s.headline) return false;
    const words = significantWords(s.headline);
    const isDuplicate = seenWordSets.some(prev => wordOverlapRatio(words, prev) >= 0.4);
    if (isDuplicate) return false;
    seenWordSets.push(words);
    return true;
  });

  // Drop stories that don't actually mention Bangalore/Karnataka anywhere —
  // see isKarnatakaRelevant for why this is needed.
  const relevant = deduped.filter(isKarnatakaRelevant);

  // Drop anything older than a week so the feed actually feels like "latest
  // news" instead of a mixed timeline going back months.
  const MAX_STORY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const fresh = relevant.filter((s) => {
    if (!s.pubDate) return true; // keep undated items rather than guessing
    return (Date.now() - new Date(s.pubDate).getTime()) <= MAX_STORY_AGE_MS;
  });

  // Fetch og:image for the rare story APITube didn't already include one for
  await fillMissingImages(fresh);

  return { stories: fresh, errors, fetchedAt: new Date().toISOString() };
}

app.get('/api/news', async (req, res) => {
  const cached = cache.get('news');
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const data = await fetchAllFeeds();
    cache.set('news', data);
    checkForNewStoriesAndNotify(data.stories); // fire-and-forget
    res.json({ ...data, cached: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch news', details: err.message });
  }
});

// Manual refresh, bypassing cache — handy while testing
app.get('/api/news/refresh', async (req, res) => {
  try {
    const data = await fetchAllFeeds();
    cache.set('news', data);
    checkForNewStoriesAndNotify(data.stories); // fire-and-forget
    res.json({ ...data, cached: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch news', details: err.message });
  }
});

// ---- Push notification subscription management ----
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const alreadyExists = subscriptions.some(s => s.endpoint === subscription.endpoint);
  if (!alreadyExists) {
    subscriptions.push(subscription);
    saveJSON(SUBSCRIPTIONS_FILE, subscriptions);
  }
  res.json({ success: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  saveJSON(SUBSCRIPTIONS_FILE, subscriptions);
  res.json({ success: true });
});

// ---- Newsletter signup (stores emails only — no sending built yet) ----
const NEWSLETTER_FILE = path.join(__dirname, 'newsletter-emails.json');
let newsletterEmails = new Set(loadJSON(NEWSLETTER_FILE, []));

app.post('/api/newsletter/subscribe', (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!validEmail) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  newsletterEmails.add(email);
  saveJSON(NEWSLETTER_FILE, [...newsletterEmails]);
  res.json({ success: true });
});

// Poll feeds in the background every 15 minutes so notifications can fire
// even when nobody currently has the page open (as long as the server is
// running), and so the cache is always warm when a real visitor arrives.
const BACKGROUND_POLL_INTERVAL = 15 * 60 * 1000;
setInterval(async () => {
  try {
    const data = await fetchAllFeeds();
    cache.set('news', data);
    checkForNewStoriesAndNotify(data.stories);
  } catch (err) {
    console.error('Background feed poll failed:', err.message);
  }
}, BACKGROUND_POLL_INTERVAL);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BLR News backend running at http://localhost:${PORT}`);
  console.log(`News API: http://localhost:${PORT}/api/news`);
});
