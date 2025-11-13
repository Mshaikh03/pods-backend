const express = require("express");
module.exports = ({ mongoose }) => {
  const router = express.Router();
  const Upload = mongoose.model(
    "UploadMeta",
    new mongoose.Schema({
      userId: String,
      title: String,
      description: String,
      fileUrl: String,
      createdAt: { type: Date, default: Date.now },
    }).index({ userId: 1, createdAt: -1 })
  );

  router.get("/me", async (req, res) => {
    const [uploads, count] = await Promise.all([
      Upload.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(5).lean(),
      Upload.countDocuments({ userId: req.user.id }),
    ]);
    res.json({
      userId: req.user.id,
      email: req.user.email,
      uploads,
      uploadsCount: count,
    });
  });

  router.get("/uploads/mine", async (req, res) => {
    const uploads = await Upload.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ uploads });
  });

  return router;
};