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

// Cache news for 10 minutes so we don't hammer source sites on every page load
const cache = new NodeCache({ stdTTL: 600 });

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
  },
  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=South+India+OR+Chennai+OR+Hyderabad+OR+Kochi+news&hl=en-IN&gl=IN&ceid=IN:en',
    category: 'South India',
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

async function fetchAllFeeds() {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const parsed = await parser.parseURL(feed.url);
      return parsed.items.slice(0, 10).map((item) => {
        const summaryText = item.contentSnippet || item.content || item.summary || '';
        let headline = item.title || '';
        let source = feed.name;

        if (feed.isGoogleNews) {
          const parsed = parseGoogleNewsItem(item, feed.name);
          headline = parsed.headline;
          source = parsed.source;
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
    })
  );

  const stories = [];
  const errors = [];

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      stories.push(...r.value);
    } else {
      errors.push({ feed: FEEDS[i].name, error: r.reason.message });
    }
  });

  // Newest first
  stories.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

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

// Poll feeds in the background every 10 minutes so notifications can fire even
// when nobody currently has the page open (as long as the server is running).
setInterval(async () => {
  try {
    const data = await fetchAllFeeds();
    cache.set('news', data);
    checkForNewStoriesAndNotify(data.stories);
  } catch (err) {
    console.error('Background feed poll failed:', err.message);
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BLR News backend running at http://localhost:${PORT}`);
  console.log(`News API: http://localhost:${PORT}/api/news`);
});
