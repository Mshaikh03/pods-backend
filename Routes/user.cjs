const express = require("express");

module.exports = ({ mongoose, db }) => {
  const router = express.Router();
  const History = mongoose.model(
    "WatchHistory",
    new mongoose.Schema({
      userId: String,
      episodeId: String,
      podcastId: String,
      positionSec: Number,
      completed: Boolean,
      lastPlayedAt: { type: Date, default: Date.now },
      source: String,
    }).index({ userId: 1, lastPlayedAt: -1 })
  );

  // POST /user/history
  router.post("/history", async (req, res) => {
    const { episodeId, podcastId, positionSec, completed, source } = req.body;
    if (!episodeId) return res.status(400).json({ error: "episodeId required" });
    await History.updateOne(
      { userId: req.user.id, episodeId },
      {
        $set: {
          podcastId,
          positionSec: Math.floor(positionSec || 0),
          completed: !!completed,
          lastPlayedAt: new Date(),
          source: source || "rss",
        },
      },
      { upsert: true }
    );
    res.sendStatus(204);
  });

  // GET /user/continue
  router.get("/continue", async (req, res) => {
    const rows = await History.find({ userId: req.user.id, completed: false })
      .sort({ lastPlayedAt: -1 })
      .limit(10)
      .lean();

    if (!rows.length) return res.json({ items: [] });
    const ids = rows.map(r => r.episodeId);
    const placeholders = ids.map(() => "?").join(",");
    db.all(
      `SELECT id, podcastId, title, imageUrl AS image, mediaUrl, mediaType
       FROM episodes WHERE id IN (${placeholders})`,
      ids,
      (err, result) => {
        if (err) return res.status(500).json({ error: "DB error" });
        const byId = Object.fromEntries(result.map(r => [String(r.id), r]));
        const items = rows.map(r => ({
          ...byId[r.episodeId],
          progress: r.positionSec,
          lastPlayedAt: r.lastPlayedAt,
        }));
        res.json({ items: items.filter(Boolean) });
      }
    );
  });

  // GET /user/foryou (lightweight recs)
  router.get("/foryou", async (req, res) => {
    const recent = await History.find({ userId: req.user.id })
      .sort({ lastPlayedAt: -1 })
      .limit(20)
      .lean();
    const catHint = recent.length ? "tech" : "life"; // placeholder heuristic
    const sql = `
      SELECT id, title, itunesAuthor AS author, imageUrl AS image, url
      FROM podcasts
      WHERE lower(category1) LIKE ? OR lower(category2) LIKE ?
      ORDER BY popularityScore DESC LIMIT 10`;
    db.all(sql, [`%${catHint}%`, `%${catHint}%`], (e, rows) =>
      e ? res.status(500).json({ error: "DB error" }) : res.json({ items: rows })
    );
  });

  return router;
};