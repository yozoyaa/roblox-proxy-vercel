// Vercel serverless function acting as a safe GET proxy for Roblox APIs

const ALLOWED_HOSTS = [
  "games.roblox.com",
  "apis.roblox.com",
  "users.roblox.com",
  "thumbnails.roblox.com",
  "catalog.roblox.com",
];

export default async function handler(req, res) {
  try {
    // Only allow GET
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const target = req.query.url;
    if (!target) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing 'url' query parameter" });
    }

    let targetUrl;
    try {
      targetUrl = decodeURIComponent(target);
    } catch (e) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid URL encoding" });
    }

    let urlObj;
    try {
      urlObj = new URL(targetUrl);
    } catch (e) {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid URL format" });
    }

    // Safety: don't make this an open proxy
    if (!ALLOWED_HOSTS.includes(urlObj.host)) {
      return res
        .status(403)
        .json({ ok: false, error: `Host not allowed: ${urlObj.host}` });
    }

    // ---------- Build headers ----------
    const headers = {};

    // 1) Roblox web APIs that need auth cookies (dummy account)
    // COOKIES should be a full cookie string, e.g.:
    // ".ROBLOSECURITY=xxx; otherCookie=yyy"
    if (process.env.COOKIES) {
      headers["cookie"] = process.env.COOKIES;
    }

    // 2) Roblox Open Cloud APIs that need x-api-key (for automation)
    // OPEN_CLOUD_KEY should be set in Vercel env
    if (urlObj.host === "apis.roblox.com" && process.env.OPEN_CLOUD_KEY) {
      headers["x-api-key"] = process.env.OPEN_CLOUD_KEY;
    }

    const upstreamResponse = await fetch(targetUrl, {
      method: "GET",
      headers,
    });

    const status = upstreamResponse.status;
    const textBody = await upstreamResponse.text();

    let parsedBody;
    try {
      parsedBody = JSON.parse(textBody);
    } catch {
      parsedBody = textBody;
    }

    return res.status(200).json({
      ok: true,
      upstreamStatus: status,
      body: parsedBody,
    });
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal proxy error",
      // never include env values in responses
      detail: String(err),
    });
  }
}
