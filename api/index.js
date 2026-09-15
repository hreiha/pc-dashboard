const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// data.json is bundled into the function at build time, so it is never
// reachable as a static file. Every request goes through the auth check below.
const data = require("../data.json");

let html;
try {
  html = fs.readFileSync(path.join(process.cwd(), "views", "index.html"), "utf8");
} catch (err) {
  html = null;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function authorised(req) {
  const user = process.env.DASH_USER || "";
  const pass = process.env.DASH_PASS || "";
  if (!user || !pass) return false;

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;

  return safeEqual(decoded.slice(0, idx), user) && safeEqual(decoded.slice(idx + 1), pass);
}

module.exports = (req, res) => {
  if (!process.env.DASH_USER || !process.env.DASH_PASS) {
    res.status(500).setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("DASH_USER and DASH_PASS are not set. Add them in Vercel project settings.");
  }

  if (!authorised(req)) {
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="P&C Dashboard", charset="UTF-8"');
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("Sign in to view this dashboard.");
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  const url = (req.url || "/").split("?")[0];

  if (url === "/data.json") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify(data));
  }

  if (url === "/healthz") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("ok");
  }

  if (!html) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("views/index.html was not bundled. Check the includeFiles setting in vercel.json.");
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.end(html);
};
