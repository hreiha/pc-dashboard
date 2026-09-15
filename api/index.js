const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// data.json is bundled into the function at build time, so it is never
// reachable as a static file. Every request goes through the auth check below.
const data = require("../data.json");

// Read with a literal __dirname path. Vercel's file tracing follows this pattern and
// bundles the file automatically, which is why no "functions" block is needed in vercel.json.
let html;
try {
  html = fs.readFileSync(path.join(__dirname, "../views/index.html"), "utf8");
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
  // Trimmed, because a trailing space or newline pasted into the Vercel field is invisible
  // in the UI and would otherwise fail every sign in attempt.
  const user = (process.env.DASH_USER || "").trim();
  const pass = (process.env.DASH_PASS || "").trim();
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
  const route = (req.url || "/").split("?")[0];

  // Diagnostic, deliberately before the auth check so it can be reached when sign in fails.
  // Reports the shape of the configured values, never the values themselves.
  if (route === "/healthz") {
    const rawUser = process.env.DASH_USER;
    const rawPass = process.env.DASH_PASS;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({
      ok: true,
      authEnabled:
        (process.env.DASH_USER || "").trim().length > 0 &&
        (process.env.DASH_PASS || "").trim().length > 0,
      userConfigured: typeof rawUser === "string" && rawUser.trim().length > 0,
      passConfigured: typeof rawPass === "string" && rawPass.trim().length > 0,
      userHasWhitespace: typeof rawUser === "string" && rawUser !== rawUser.trim(),
      passHasWhitespace: typeof rawPass === "string" && rawPass !== rawPass.trim(),
      userLength: typeof rawUser === "string" ? rawUser.trim().length : 0,
      passLength: typeof rawPass === "string" ? rawPass.trim().length : 0,
      deployedAt: new Date().toISOString()
    }));
  }

  // Auth is on whenever both variables are set. Clear either one in Vercel to run open,
  // which is fine while the dashboard holds sample data and is not once it holds real figures.
  const authEnabled =
    (process.env.DASH_USER || "").trim().length > 0 &&
    (process.env.DASH_PASS || "").trim().length > 0;

  if (authEnabled && !authorised(req)) {
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="P&C Dashboard", charset="UTF-8"');
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("Sign in to view this dashboard.");
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  if (route === "/data.json") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify(data));
  }

  if (!html) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("views/index.html was not bundled with the function. Tell Claude and we will inline it instead.");
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!authEnabled) {
    const banner =
      '<div style="background:#FF6D2E;color:#fff;padding:10px 24px;font:500 13px/1.4 ' +
      'Archivo,system-ui,sans-serif">This dashboard has no sign in. Set DASH_USER and ' +
      'DASH_PASS in Vercel before it holds real figures.</div>';
    return res.end(html.replace("<body>", "<body>" + banner));
  }

  return res.end(html);
};
