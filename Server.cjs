require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const compression = require("compression");
const helmet = require("helmet");
const NodeCache = require("node-cache");
const mongoose = require("mongoose");
const { createClient } = require("@supabase/supabase-js");
const mountAIDiscover = require("./api/ai-discover");
const Parser = require("rss-parser"); // ✅ switched to require()

console.log("Booting server...");
console.log("Loaded API_KEY:", process.env.PODCASTINDEX_API_KEY);
console.log(
  "Loaded API_SECRET:",
  process.env.PODCASTINDEX_API_SECRET ? "✅ Exists" : "❌ Missing"
);

const app = express();
const PORT = process.env.PORT || 4000;
const BASE_URL = "https://api.podcastindex.org/api/1.0";
const API_KEY = process.env.PODCASTINDEX_API_KEY?.trim();
const API_SECRET = process.env.PODCASTINDEX_API_SECRET?.trim();

if (!API_KEY || !API_SECRET) {
  console.error("❌ Missing PodcastIndex credentials in .env");
  process.exit(1);
}

//  MIDDLEWARE
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false,
  })
);
app.use(compression());
app.use(express.json({ limit: "10mb" }));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,Range"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

//  CACHE + AUTH HELPERS

const cache = new NodeCache({ stdTTL: 90, checkperiod: 120 });

function cachedRoute(keyFn, handler) {
  return async (req, res) => {
    const key = keyFn(req);
    const hit = cache.get(key);
    if (hit) {
      console.log(`[CACHE HIT] ${key}`);
      return res.json(hit);
    }
    try {
      const data = await handler(req, res);
      cache.set(key, data);
      res.json(data);
    } catch (err) {
      console.error(`[ERROR] ${key}:`, err.message);
      res.status(500).json({ error: err.message });
    }
  };
}

function getAuthHeaders() {
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto
    .createHash("sha1")
    .update(API_KEY + API_SECRET + ts, "utf8")
    .digest("hex");
  return {
    "User-Agent": "PodsAPI/1.0",
    "X-Auth-Date": String(ts),
    "X-Auth-Key": API_KEY,
    Authorization: hash,
  };
}


//  SUPABASE + MONGO INIT

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  console.log("✅ Supabase initialized");
}

if (process.env.MONGO_URI) {
  mongoose
    .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
    .then(() => {
      const schema = new mongoose.Schema({
        title: String,
        author: String,
        description: String,
        fileUrl: String,
        createdAt: { type: Date, default: Date.now },
      });
      mongoose.model("PodcastUpload", schema);
      console.log("✅ MongoDB connected:", mongoose.connection.name);
    })
    .catch((err) => console.error("❌ MongoDB connection failed:", err.message));
} else {
  console.warn("⚠️ MONGO_URI not set – skipping Mongo setup");
}


//  CORE PODCAST INDEX ROUTES

app.get("/ping", (req, res) => {
  console.log("→ Ping request received");
  res.json({ ok: true, message: "Backend connected", apiBase: BASE_URL });
});

app.get(
  "/trending",
  cachedRoute(() => "trending", async () => {
    console.log("→ Fetching trending podcasts...");
    const headers = getAuthHeaders();
    const { data } = await axios.get(`${BASE_URL}/podcasts/trending`, {
      headers,
    });
    console.log(`✓ Trending fetched (${data.feeds?.length || 0})`);
    return data;
  })
);

app.get(
  "/search/:term",
  cachedRoute((req) => `search:${req.params.term}`, async (req) => {
    const { term } = req.params;
    console.log(`→ Searching for "${term}"`);
    const headers = getAuthHeaders();
    const { data } = await axios.get(
      `${BASE_URL}/search/byterm?q=${encodeURIComponent(term)}`,
      { headers }
    );
    console.log(`✓ Search complete (${data.feeds?.length || 0})`);
    return data;
  })
);

app.get(
  "/podcasts/home",
  cachedRoute(() => "home", async () => {
    console.log("→ Building home feed...");
    const headers = getAuthHeaders();
    const [trending, tech, lifestyle, sports] = await Promise.all([
      axios.get(`${BASE_URL}/podcasts/trending?max=10`, { headers }),
      axios.get(`${BASE_URL}/search/byterm?q=technology&max=10`, { headers }),
      axios.get(`${BASE_URL}/search/byterm?q=lifestyle&max=10`, { headers }),
      axios.get(`${BASE_URL}/search/byterm?q=sports&max=10`, { headers }),
    ]);
    return {
      trending: trending.data.feeds || [],
      technology: tech.data.feeds || [],
      lifestyle: lifestyle.data.feeds || [],
      sports: sports.data.feeds || [],
    };
  })
);

//  FIXED EPISODES ROUTE

const parser = new Parser({
  headers: { "User-Agent": "Mozilla/5.0 (PodsApp RSS Fetcher)" },
});

app.get("/episodes", async (req, res) => {
  const feedUrl = req.query.feedUrl;
  if (!feedUrl) return res.status(400).json({ error: "Missing feedUrl" });

  try {
    console.log("Fetching feed:", feedUrl);
    const feed = await parser.parseURL(feedUrl);

    const episodes = feed.items
      .map((item) => ({
        guid: item.guid || null,
        title: item.title || "Untitled Episode",
        description: item.contentSnippet || item.content || "",
        pubDate: item.pubDate || null,
        link: item.link || null,
        mediaUrl: item.enclosure?.url || null,
        mediaType: item.enclosure?.type || null,
        image:
          item.itunes?.image ||
          feed.itunes?.image ||
          feed.image?.url ||
          null,
        duration: item.itunes?.duration || null,
      }))
      .filter((e) => e.mediaUrl);

    if (!episodes.length)
      throw new Error("No episodes found with valid media URLs.");

    res.json({ episodes });
  } catch (err) {
    console.error("Episode fetch failed:", err.message);
    res.status(500).json({ error: "Failed to fetch episodes" });
  }
});

//  AI DISCOVER ROUTE
mountAIDiscover(app, { getAuthHeaders, BASE_URL });


//  404 HANDLER + SERVER START

app.use((req, res) => {
  console.warn("404:", req.path);
  res.status(404).json({ error: "Route not found", path: req.path });
});

app.listen(PORT, "127.0.0.1", () =>
  console.log(`✅ Server running at http://127.0.0.1:${PORT}`)
);