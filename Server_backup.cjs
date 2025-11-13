// --- ENV + DEPENDENCIES (CommonJS only) ---
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const http = require("http");
const RSSParser = require("rss-parser");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const NodeCache = require("node-cache");
const axios = require("axios");
const crypto = require("crypto");

// --- CONFIG ---
const app = express();
app.get("/ping", (req, res) => res.json({ ok: true }))
const PORT = Number(process.env.PORT) || 4000;
const NODE_ENV = process.env.NODE_ENV || "development";
const DB_FILE = process.env.DB_FILE || "podcastindex_feeds.db";
const isProd = NODE_ENV === "production";
const BASE_URL = "https://api.podcastindex.org/api/1.0";
const API_KEY = process.env.PODCASTINDEX_API_KEY;
const API_SECRET = process.env.PODCASTINDEX_API_SECRET;

// Keep-alive for outbound HTTP(S)
http.globalAgent.keepAlive = true;
app.disable("x-powered-by");
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false,
  })
);

app.use(compression());
app.use(express.json({ limit: "512kb" }));
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://10.0.0.87:8080",
      "http://10.17.150.120:8080",
      "https://unpalpitating-gladys-perfectly.ngrok-free.dev",
    ],
    credentials: true,
  })
);

// --- SUPABASE (Storage Only) ---
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  console.log("✅ Supabase client initialized");
} else {
  console.warn("⚠️ Supabase envs not set — /api/upload disabled");
}

// --- SQLITE (still initialized for uploads & backup) ---
const dbPath = path.join(__dirname, DB_FILE);
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("❌ SQLite connection failed:", err.message);
  else console.log("✅ SQLite connected:", dbPath);
});
const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );

// --- CACHES ---
const cache = new NodeCache({ stdTTL: 120, checkperiod: 200 });
const capabilityCache = new NodeCache({ stdTTL: 300, checkperiod: 400 });


// --- PODCASTINDEX AUTH HELPERS ---
function getAuthHeaders() {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = API_KEY?.trim();
  const secret = API_SECRET?.trim();
  if (!key || !secret) throw new Error("Missing PodcastIndex API credentials");
  const hash = crypto
    .createHash("sha1")
    .update(key + secret + timestamp, "utf8")
    .digest("hex");
  return {
    "User-Agent": "Pods/1.0 (+https://podstudio.ca)",
    "X-Auth-Date": timestamp.toString(),
    "X-Auth-Key": key,
    Authorization: hash,
  };
}

try {
  db.serialize(() => {
    db.run("PRAGMA journal_mode=WAL;");
    db.run("PRAGMA synchronous=NORMAL;");
    db.run("PRAGMA temp_store=MEMORY;");
    db.run("PRAGMA cache_size=-20000;");
    db.run("PRAGMA busy_timeout=60000;");
    db.run("PRAGMA mmap_size=268435456;");
    db.run("PRAGMA foreign_keys=ON;");
    db.run("PRAGMA cache_spill=FALSE;");

    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS podcasts_fts USING fts5(
        title, description, itunesAuthor,
        content='podcasts', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
    `, (err) => err && console.warn("SQLite FTS init warning:", err.message));
  });
} catch (err) {
  console.warn("⚠️ SQLite init skipped:", err.message);
}

// --- HELPER: FETCH FROM PODCASTINDEX WITH CACHING ---
async function fetchPodcastIndex(endpoint, params = "") {
  const url = `${BASE_URL}${endpoint}${params ? `?${params}` : ""}`;
  const cached = cache.get(url);
  if (cached) return cached;

  try {
    const headers = getAuthHeaders();
    const { data } = await axios.get(url, { headers, timeout: 8000 });
    cache.set(url, data);
    return data;
  } catch (err) {
    console.error("PodcastIndex fetch failed:", err.message);
    throw err;
  }
}

// --- COLUMN CAPABILITIES (cached) ---
async function getPodcastsColumns() {
  const hit = capabilityCache.get("podcasts_cols");
  if (hit) return hit;
  const cols = await dbAll("PRAGMA table_info(podcasts);");
  const names = new Set(cols.map((c) => c.name.toLowerCase()));
  const caps = {
    hasCountry: names.has("country"),
    hasLanguage: names.has("language"),
    hasPopularity:
      names.has("popularityscore") || names.has("popularity_score"),
    cat1: names.has("category1"),
    cat2: names.has("category2"),
    hasDescription: names.has("description"),
    hasUrl: names.has("url"),
    hasLink: names.has("link"),
    hasImageUrl: names.has("imageurl"),
    hasItunesAuthor: names.has("itunesauthor"),
  };
  capabilityCache.set("podcasts_cols", caps);
  return caps;
}

// --- REGION / POPULARITY HELPERS ---
function buildRegionLangFilter(caps) {
  const parts = [];
  if (caps.hasCountry) {
    parts.push(
      "(lower(country) IN ('us','usa','united states','ca','canada') OR country IS NULL)"
    );
  }
  if (caps.hasLanguage) {
    parts.push("(lower(language) IN ('en','english') OR language IS NULL)");
  }
  return parts.length ? `AND ${parts.join(" AND ")}` : "";
}

function orderByPopularity(caps) {
  return caps.hasPopularity
    ? "ORDER BY popularityScore DESC"
    : "ORDER BY id DESC";
}

// --- MULTER (for uploads) ---
const upload = multer({ storage: multer.memoryStorage() });

// --- RSS PARSER ---
const rss = new RSSParser({
  timeout: 8000,
  headers: {
    "User-Agent": "PodsBot/1.0 (+https://pods.example.com)",
    Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
  },
  customFields: {
    item: [
      ["itunes:image", "itunesImage", { keepArray: false }],
      ["media:content", "mediaContent", { keepArray: true }],
      ["itunes:duration", "itunesDuration", { keepArray: false }],
    ],
  },
});


// --- SIMPLE CACHE MIDDLEWARE ---
function cacheMW(keyBuilder) {
  return (req, res, next) => {
    const key = keyBuilder(req);
    const hit = cache.get(key);
    if (hit) {
      res.set("X-Cache", "HIT");
      return res.json(hit);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      cache.set(key, body);
      res.set("X-Cache", "MISS");
      return originalJson(body);
    };

    next();
  };
}

// --- ROUTES: HEALTH ---
console.log("✅ Starting to register routes...");
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
// --- ROUTES: EPISODES (RSS feed → playable episode list) ---
app.get(
  ["/episodes", "/podcasts/episodes"],
  cacheMW((req) => `episodes:${req.query.feedUrl}`),
  async (req, res) => {
    const rawFeedUrl = req.query.feedUrl;
    if (!rawFeedUrl) return res.status(400).json({ error: "Missing feedUrl" });

    const feedUrl = decodeURIComponent(rawFeedUrl).trim();
    if (!/^https?:\/\//i.test(feedUrl))
      return res.status(400).json({ error: "Invalid feed URL" });

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Feed fetch timed out")), 9000)
      );

      const feed = await Promise.race([rss.parseURL(feedUrl), timeoutPromise]);

      if (!feed || !feed.items?.length)
        return res.status(404).json({ error: "No episodes found" });

      const episodes = feed.items.map((item) => {
        const mc = Array.isArray(item.mediaContent) ? item.mediaContent : [];
        const mediaUrl =
          item.enclosure?.url ||
          (mc[0]?.$?.url ?? null) ||
          null;

        const mediaType =
          item.enclosure?.type ||
          (mc[0]?.$?.type ?? null) ||
          null;

        const image =
          item.itunesImage?.href ||
          item["itunes:image"]?.href ||
          feed.image?.url ||
          null;

        return {
          guid: item.guid || null,
          title: (item.title || "Untitled Episode").trim(),
          description: item.contentSnippet || item.summary || item.description || "",
          pubDate: item.pubDate || null,
          link: item.link || null,
          mediaUrl,
          mediaType,
          image,
          duration: item.itunes?.duration || item.itunesDuration || null,
        };
      }).filter(ep => !!ep.mediaUrl); // only return playable items

      if (!episodes.length) {
        return res.status(404).json({ error: "No playable media in feed" });
      }

      res.set("Cache-Control", "public, max-age=60");
      res.json({
        title: feed.title,
        author: feed.itunes?.author || feed.title || "Unknown",
        episodes,
      });
    } catch (err) {
      console.error("❌ RSS parse error:", err.message, feedUrl);
      res.status(404).json({
        error: "Feed not found or unavailable",
        details: err.message,
      });
    }
  }
);

// --- SEARCH ---
app.get(
  "/podcasts/search",
  async (req, res) => {
    try {
      const q = (req.query.q || "").trim();
      if (!q) return res.json({ podcasts: [], hasMore: false });

      const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);
      const data = await fetchPodcastIndex("/search/byterm", `q=${encodeURIComponent(q)}&max=${limit}`);

      const podcasts =
        data.feeds?.map((p) => ({
          id: p.id,
          title: p.title,
          author: p.author || p.itunesAuthor || "Unknown",
          image: p.image || p.artwork,
          url: p.url || p.link,
          link: p.link,
          description: p.description || "",
        })) || [];

      res.set("Cache-Control", "public, max-age=60");
      res.json({ podcasts, hasMore: podcasts.length === limit });
    } catch (err) {
      console.error("Search API error:", err.message);
      // 🔸 fallback to SQLite FTS (commented backup)
      /*
      const match = `${q.replace(/"/g, '""')}*`;
      const sql = `
        SELECT p.id, p.title, p.description, p.itunesAuthor AS author,
               p.imageUrl AS image, p.url, p.link
        FROM podcasts_fts
        JOIN podcasts p ON p.id = podcasts_fts.rowid
        WHERE podcasts_fts MATCH ?
        ORDER BY bm25(podcasts_fts) ASC LIMIT 10;
      `;
      const podcasts = await dbAll(sql, [match]);
      return res.json({ podcasts, hasMore: false });
      */
      res.status(500).json({ error: "Search failed" });
    }
  }
);

// --- HOME FEED (example with 3 API endpoints combined) ---
app.get(
  "/podcasts/home",
  async (_req, res) => {
    try {
      const [trending, tech, lifestyle] = await Promise.all([
        fetchPodcastIndex("/podcasts/trending", "max=10"),
        fetchPodcastIndex("/search/byterm", "q=technology&max=10"),
        fetchPodcastIndex("/search/byterm", "q=lifestyle&max=10"),
      ]);

      const mapFeeds = (feeds) =>
        feeds?.map((p) => ({
          id: p.id,
          title: p.title,
          author: p.author || p.itunesAuthor || "Unknown",
          image: p.image || p.artwork,
          url: p.url || p.link,
          link: p.link,
          description: p.description || "",
        })) || [];

      res.set("Cache-Control", "public, max-age=90");
      res.json({
        trending: mapFeeds(trending.feeds),
        technology: mapFeeds(tech.feeds),
        lifestyle: mapFeeds(lifestyle.feeds),
        userUploads: [], // handled via Supabase upload route below
      });
    } catch (err) {
      console.error("Home feed API error:", err.message);
      res.status(500).json({ error: "Home feed failed" });
    }
  }
);

// --- ROUTES: TRENDING ---
app.get(
  ["/podcasts/trending", "/trending"],
  async (req, res) => {
    try {
      const page = Math.max(parseInt(req.query.page || "1", 10), 1);
      const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);
      const data = await fetchPodcastIndex("/podcasts/trending", `max=${limit}&page=${page}`);
      const podcasts =
        data.feeds?.map((p) => ({
          id: p.id,
          title: p.title,
          author: p.author || p.itunesAuthor || "Unknown",
          image: p.image || p.artwork,
          url: p.url || p.link,
          link: p.link,
          description: p.description || "",
        })) || [];
      res.set("Cache-Control", "public, max-age=60");
      res.json({ podcasts, hasMore: podcasts.length === limit });
    } catch (err) {
      console.error("Trending API error:", err.message);
      // 🔸 fallback to SQLite backup if available
      // const rows = await dbAll("SELECT id, title, itunesAuthor AS author, imageUrl AS image FROM podcasts LIMIT 10;");
      res.status(500).json({ error: "Trending fetch failed" });
    }
  }
);

// --- ROUTES: CATEGORY ---
app.get(
  "/podcasts/category/:name",
  cacheMW((req) => `category:${req.params.name}:${req.query.page}:${req.query.limit}`),
  async (req, res) => {
    try {
      const caps = await getPodcastsColumns();
      const name = (req.params.name || "").toLowerCase();
      const page = Math.max(parseInt(req.query.page || "1", 10), 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 50);
      const offset = (page - 1) * limit;
      const filter = buildRegionLangFilter(caps);
      const order = orderByPopularity(caps);

      const map = {
        sports: "%sport%",
        news: "%news%",
        truecrime: "%crime%",
        technology: "%tech%",
        lifestyle: "%life%",
      };
      const match = map[name];
      if (!match) return res.status(400).json({ error: "Unknown category" });

      let sql;
      let params;

      if (!caps.cat1 && !caps.cat2) {
        sql = `
          SELECT id, title, itunesAuthor AS author, imageUrl AS image, 
                 ${caps.hasUrl ? "url" : "NULL AS url"}, 
                 ${caps.hasLink ? "link" : "NULL AS link"}
          FROM podcasts 
          WHERE lower(title) LIKE lower(?) ${filter} ${order} LIMIT ? OFFSET ?;
        `;
        params = [match, limit, offset];
      } else {
        const where = [
          caps.cat1 ? "lower(category1) LIKE lower(?)" : "",
          caps.cat2 ? "lower(category2) LIKE lower(?)" : "",
        ]
          .filter(Boolean)
          .join(" OR ");

        sql = `
          SELECT id, title, itunesAuthor AS author, imageUrl AS image, 
                 ${caps.hasUrl ? "url" : "NULL AS url"}, 
                 ${caps.hasLink ? "link" : "NULL AS link"}
          FROM podcasts
          WHERE (${where}) ${filter} ${order} LIMIT ? OFFSET ?;
        `;
        params = caps.cat1 && caps.cat2 ? [match, match, limit, offset] : [match, limit, offset];
      }

      const rows = await dbAll(sql, params);
      res.set("Cache-Control", "public, max-age=60");
      res.json({ podcasts: rows, hasMore: rows.length === limit });
    } catch (err) {
      console.error("Category error:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// --- ROUTE: USER UPLOAD (Supabase Storage + SQLite metadata) ---
app.post("/api/upload", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    if (!supabase)
      return res.status(500).json({ error: "Supabase not configured" });

    const { title, author, description } = req.body;
    const file = req.file;

    // Generate unique filename
    const ext = path.extname(file.originalname || "");
    const filename = `${Date.now()}-${Math.random()
      .toString(36)
      .substring(2)}${ext || ".webm"}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from("podcasts")
      .upload(filename, file.buffer, {
        contentType: file.mimetype || "audio/webm",
      });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabase.storage
      .from("podcasts")
      .getPublicUrl(filename);
    const audioUrl = publicUrlData?.publicUrl || null;
    if (!audioUrl) throw new Error("Failed to obtain public URL");

    // Insert metadata into SQLite
    const insertSql = `
      INSERT INTO podcasts (title, itunesAuthor, description, url, imageUrl, link, popularityScore)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `;
    const params = [
      title || file.originalname,
      author || "Unknown Creator",
      description || "",
      audioUrl,
      "https://placehold.co/600x600?text=Pods",
      audioUrl,
      Math.floor(Math.random() * 100),
    ];

    db.run(insertSql, params, (err) => {
      if (err) {
        console.error("SQLite insert error:", err);
        return res.status(500).json({ error: "Failed to save metadata" });
      }
      res.json({ success: true, url: audioUrl });
    });
  } catch (error) {
    console.error("Upload failed:", error);
    res.status(500).json({ error: "Upload failed", details: error.message });
  }
});
console.log("✅ Finished registering routes.");
setTimeout(() => {
  console.log("🧭 Route check:", app._router?.stack?.filter(r => r.route)?.length || 0, "routes registered");
  app._router?.stack
    ?.filter(r => r.route)
    .forEach(r =>
      console.log("🛠", Object.keys(r.route.methods)[0].toUpperCase(), r.route.path)
    );
}, 500);
// === DEBUG: list all routes that Express actually registered ===
app._router?.stack
  ?.filter((r) => r.route)
  .forEach((r) =>
    console.log("🛠", Object.keys(r.route.methods)[0].toUpperCase(), r.route.path)
  );

// --- 404 fallback ---
app.use((req, res) => {
  res.status(404).json({ error: "Route not found", path: req.path });
});

// --- START SERVER after current tick ---
process.nextTick(() => {
  const HOST = "0.0.0.0";
  app.listen(PORT, HOST, () => {
    console.log(`✅ Server running at http://${HOST}:${PORT}`);
  });
});