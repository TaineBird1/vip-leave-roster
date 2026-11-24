// Vercel entry point: every /api/* request is routed here (see vercel.json).
const { app } = require("../server");

module.exports = (req, res) => {
  // vercel.json passes the original path as ?__p=... ; put it back so Express routes match.
  const url = new URL(req.url, "http://localhost");
  const p = url.searchParams.get("__p");
  if (p !== null && !url.pathname.startsWith("/api/")) {
    url.searchParams.delete("__p");
    req.url = "/api/" + p + (url.search || "");
  }
  return app(req, res);
};
