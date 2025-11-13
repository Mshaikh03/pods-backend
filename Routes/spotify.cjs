router.get("/episodes", requireAuth, async (req, res) => {
  const token = req.user?.spotifyAccessToken;
  // use fetch("https://api.spotify.com/v1/...") with Authorization: Bearer token
});
