const mongoose = require("mongoose");

const PodcastLikeSchema = new mongoose.Schema(
  {
    podcastId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    liked: { type: Boolean, default: true },
  },
  { timestamps: true }
);

PodcastLikeSchema.index({ podcastId: 1, userId: 1 }, { unique: true });

module.exports =
  mongoose.models.PodcastLike ||
  mongoose.model("PodcastLike", PodcastLikeSchema);