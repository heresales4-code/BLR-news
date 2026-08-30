const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ---- Push notifications setup ----
// VAPID keys identify this server to push services (Chrome, Firefox, etc).
// These were generated once with `webpush.generateVAPIDKeys()`. In a real
// production deploy, move these to environment variables instead of hardcoding —
// this is fine for local development and personal use.
const VAPID_PUBLIC_KEY = 'BKyX8jBvmNSDWC91DfZ8aB_U3n_o-Zrxl8_EogxMSmERaSE5zVP3EYCd7c7BjGjwe4Jl-Fq_0DhslAwqBXd8a6Y';
const VAPID_PRIVATE_KEY = 'M1f09IWeat33yrMy_T7vCLyfwtYHfprSy29dMVUh1gM';
webpush.setVapidDetails('mailto:example@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

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

// ---- NewsData.io (optional, recommended) ----
// Sign up free at https://newsdata.io, get an API key, and paste it below.
// This fixes two problems with Google News RSS: (1) it gives direct publisher
// links instead of Google's JS-redirect interstitial, and (2) it returns real
// article images. Free tier: 200 credits/day, 1 credit per category query
// below — we query 6 categories, so keep fetches to roughly once an hour
// (6 categories × 24 times/day = 144 credits, leaving good headroom).
// Leave this blank to keep using the Google News RSS feeds below instead.
const NEWSDATA_API_KEY = 'pub_466c76fa865748d492e9f8e87ed39a49'; // e.g. 'pub_1234567890abcdef...'
const NEWSDATA_ENABLED = !!NEWSDATA_API_KEY;

const NEWSDATA_QUERIES = [
  { category: 'Traffic', q: 'Bangalore traffic OR BBMP road' },
  { category: 'Metro', q: 'Namma Metro Bengaluru' },
  { category: 'Tech', q: 'Bangalore startup OR tech' },
  { category: 'Weather', q: 'Bangalore weather OR rain OR monsoon' },
  { category: 'Civic', q: 'BBMP OR Bengaluru civic' },
  { category: 'Karnataka', q: 'Karnataka news' }
];

async function fetchFromNewsData(category, query) {
  const url = `https://newsdata.io/api/1/latest?apikey=${NEWSDATA_API_KEY}&q=${encodeURIComponent(query)}&country=in&language=en`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`NewsData.io returned ${res.status} for "${category}"`);
  const data = await res.json();
  if (data.status !== 'success') throw new Error(`NewsData.io error: ${data.message || 'unknown'}`);

  return (data.results || []).slice(0, 10).map((item) => ({
    cat: category,
    headline: item.title || '',
    summary: trimSummary(item.description || ''),
    source: item.source_name || item.source_id || 'NewsData',
    time: timeAgo(item.pubDate),
    pubDate: item.pubDate || null,
    link: item.link || '',
    image: item.image_url || null
  }));
}

// Many news sites 403 the default Node.js user-agent as basic bot-defense —
// a browser-like UA header gets past that for legitimate feed reading.
// customFields tells rss-parser to also pull out media/image tags, which most
// news feeds include specifically so aggregators can show a thumbnail.
const parser = new Parser({
  timeout: 8000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
      ['enclosure', 'enclosure'],
      ['source', 'gnewsSource']
    ]
  }
});

// Pull the best available image URL out of the various places feeds put it
function extractImage(item) {
  if (item.mediaContent && item.mediaContent.length) {
    const withImage = item.mediaContent.find(m => m?.$?.url);
    if (withImage) return withImage.$.url;
  }
  if (item.mediaThumbnail?.$?.url) return item.mediaThumbnail.$.url;
  if (item.enclosure?.url && /image/.test(item.enclosure.type || '')) return item.enclosure.url;
  // Some feeds embed an <img> directly in the HTML content
  const html = item.content || item['content:encoded'] || '';
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match) return match[1];
  return null;
}

// Cache TTL: 10 min normally, but if NewsData.io is enabled we back off to an
// hour, since its free tier only allows 200 credits/day (1 per category query,
// 7 categories = 7 credits per fetch — hourly keeps us at ~168/day, safely
// under budget with room for manual refreshes).
const cache = new NodeCache({ stdTTL: NEWSDATA_ENABLED ? 3600 : 600 });

app.use(cors());
app.use(express.static('public'));

// ---- Feed sources ----
// Edit this list freely. `category` maps to the chip filters in the UI.
// IMPORTANT: verify each feed's terms of use before running ads against it —
// some publishers (e.g. Deccan Herald) restrict RSS use for commercial/ad-supported pages.
const FEEDS = [
  // General Karnataka feed — good broad coverage, categorized automatically by content
  {
    name: 'The Hindu',
    url: 'https://www.thehindu.com/news/national/karnataka/feeder/default.rss',
    category: 'Civic'
  },
  // Google News search feeds, one per category — far more reliable than chasing
  // individual publishers' RSS URLs (which move/break often), and guarantees
  // each category actually has content instead of relying on one general feed.
  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=Bangalore+traffic+OR+BBMP+road&hl=en-IN&gl=IN&ceid=IN:en',
    category: 'Traffic',
    isGoogleNews: true
  },
  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=Namma+Metro+Bengaluru&hl=en-IN&gl=IN&ceid=IN:en',
    category: 'Metro',
    isGoogleNews: true
  },
  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=Bangalore+startup+OR+tech+OR+IT+sector&hl=en-IN&gl=IN&ceid=IN:en',
    category: 'Tech',
    isGoogleNews: true
  },
  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=Bangalore+weather+OR+rain+OR+monsoon&hl=en-IN&gl=IN&ceid=IN:en',
    category: 'Weather',
    isGoogleNews: true
  },
  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=BBMP+OR+Bengaluru+civic&hl=en-IN&gl=IN&ceid=IN:en',
    category: 'Civic',
    isGoogleNews: true
  },
  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=Karnataka+news&hl=en-IN&gl=IN&ceid=IN:en',
    category: 'Karnataka',
    isGoogleNews: true
  }
  // Add more feeds here as you find good ones. Give each a `category` matching
  // a UI chip. Set isGoogleNews:true for Google News search feeds so their
  // "Headline - Source Name" title format gets cleaned up automatically.
];

// Trim a description down to roughly N words, stripping any HTML tags the feed included
function trimSummary(text, wordLimit = 60) {
  if (!text) return '';
  const plain = text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
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

// Classify a story by keywords in its headline + summary, since a single broad
// feed (e.g. "Karnataka news") covers many topics, not just its assigned label.
// Order matters — first matching category wins, so more specific ones go first.
const CATEGORY_KEYWORDS = [
  ['Metro', /\b(metro|bmrcl|namma metro|yellow line|purple line|pink line)\b/i],
  ['Weather', /\b(rain|rainfall|monsoon|flood|weather|forecast|cyclone|heatwave|drought)\b/i],
  ['Traffic', /\b(traffic|flyover|junction|underpass|road closure|signal|accident|vehicle|bike rider|truck|lane)\b/i],
  ['Tech', /\b(tech|startup|it sector|software|whitefield|silicon|funding|layoff|infosys|wipro|electronics city)\b/i],
  ['Civic', /\b(bbmp|bwssb|civic|garbage|pothole|sewage|municipal|water supply|encroachment)\b/i]
];

function categorize(text, fallback) {
  for (const [category, pattern] of CATEGORY_KEYWORDS) {
    if (pattern.test(text)) return category;
  }
  return fallback;
}

// Google News RSS appends " - Source Name" to every title, and puts the
// source in a <source> tag too. Split those apart for a cleaner display.
function parseGoogleNewsItem(item, feedName) {
  const rawTitle = item.title || '';
  const sourceFromTag = item.gnewsSource?._ || item.gnewsSource || null;
  const lastDash = rawTitle.lastIndexOf(' - ');
  const headline = lastDash > -1 ? rawTitle.slice(0, lastDash) : rawTitle;
  const source = sourceFromTag || (lastDash > -1 ? rawTitle.slice(lastDash + 3) : feedName);
  return { headline, source };
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
// sharing previews. Used as a fallback when the RSS feed itself has no image
// (which is most Google News items).
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
    return match ? match[1] : null;
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
  // The Hindu's general RSS feed runs either way — it's free, no credit cost,
  // and gives good broad Karnataka coverage alongside whichever category
  // source (NewsData.io or Google News) we use below.
  const hindu = FEEDS.find(f => f.name === 'The Hindu');
  const categoryFeeds = NEWSDATA_ENABLED
    ? [] // NewsData.io covers all 7 categories directly, so skip the Google News RSS feeds entirely
    : FEEDS.filter(f => f.isGoogleNews);

  const rssJobs = [hindu, ...categoryFeeds].map(async (feed) => {
    const parsed = await parser.parseURL(feed.url);
    return parsed.items.slice(0, 10).map((item) => {
      const summaryText = item.contentSnippet || item.content || item.summary || '';
      let headline = item.title || '';
      let source = feed.name;

      if (feed.isGoogleNews) {
        const parsedItem = parseGoogleNewsItem(item, feed.name);
        headline = parsedItem.headline;
        source = parsedItem.source;
      }

      return {
        cat: feed.isGoogleNews ? feed.category : categorize(`${headline} ${summaryText}`, feed.category),
        headline,
        summary: trimSummary(summaryText),
        source,
        time: timeAgo(item.isoDate || item.pubDate),
        pubDate: item.isoDate || item.pubDate || null,
        link: item.link || '',
        image: extractImage(item)
      };
    });
  });

  const newsDataJobs = NEWSDATA_ENABLED
    ? NEWSDATA_QUERIES.map(({ category, q }) => fetchFromNewsData(category, q))
    : [];

  const allJobs = [...rssJobs, ...newsDataJobs];
  const jobLabels = [hindu, ...categoryFeeds].map(f => f.name)
    .concat(NEWSDATA_ENABLED ? NEWSDATA_QUERIES.map(q => `NewsData.io (${q.category})`) : []);

  const results = await Promise.allSettled(allJobs);

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

  // Fetch og:image for stories that still don't have one (NewsData.io usually
  // provides image_url directly, so this mostly matters for Google News mode)
  await fillMissingImages(stories);

  return { stories, errors, fetchedAt: new Date().toISOString() };
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

// Poll feeds in the background so notifications can fire even when nobody
// currently has the page open (as long as the server is running). Interval
// matches the cache TTL above — hourly when NewsData.io is enabled to respect
// its free-tier daily credit budget, otherwise every 10 minutes.
const BACKGROUND_POLL_INTERVAL = NEWSDATA_ENABLED ? 60 * 60 * 1000 : 10 * 60 * 1000;
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
