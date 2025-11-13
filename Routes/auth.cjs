const jwksClient = require("jwks-rsa");
const jwt = require("jsonwebtoken");
const express = require("express");

module.exports = (env) => {
  const router = express.Router();
  const client = jwksClient({ jwksUri: env.SUPABASE_JWKS_URI });

  const getKey = (header, cb) =>
    client.getSigningKey(header.kid, (err, key) => cb(err, key?.getPublicKey()));

  function requireAuth(req, res, next) {
    const token =
      req.cookies["sb-access-token"] ||
      (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    jwt.verify(
      token,
      getKey,
      { audience: env.SUPABASE_AUD, issuer: env.SUPABASE_ISS },
      (err, decoded) => {
        if (err) return res.status(401).json({ error: "Invalid token" });
        req.user = { id: decoded.sub, email: decoded.email };
        next();
      }
    );
  }

  // session hand-off
  router.post("/session/handoff", (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "Missing token" });
    res.cookie("sb-access-token", token, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 86400_000,
    });
    res.sendStatus(204);
  });

  // Spotify link placeholder
  router.get("/spotify/link", (req, res) => {
    const redirect = encodeURIComponent(env.SPOTIFY_REDIRECT_URI);
    const scope = encodeURIComponent("user-read-email user-read-private");
    res.json({
      authUrl: `https://accounts.spotify.com/authorize?client_id=${env.SPOTIFY_CLIENT_ID}&response_type=code&redirect_uri=${redirect}&scope=${scope}`,
    });
  });

  return { requireAuth, supabaseJWKS: { client, getKey }, authPublic: router };
};