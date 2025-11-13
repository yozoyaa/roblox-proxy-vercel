// api/proxy.js
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
    const headers = {
      // act like a normal browser hitting Roblox
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.roblox.com/",
    };

    // 1) Roblox web API auth via cookie (dummy account)
    if (process.env.COOKIES) {
      // COOKIES should be like: ".ROBLOSECURITY=xxx; otherCookie=yyy"
      headers["Cookie"] = process.env.COOKIES;
    }

    // 2) Roblox Open Cloud auth (x-api-key)
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
      parsedBody = textBody; // not JSON, return as string
    }

    // Helpful logging (server-side only)
    if (status !== 200) {
      console.error("Upstream Roblox error:", {
        url: targetUrl,
        status,
        bodyPreview:
          typeof parsedBody === "string"
            ? parsedBody.slice(0, 300)
            : JSON.stringify(parsedBody).slice(0, 300),
      });
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
      // never include cookies or env values here
      detail: String(err),
    });
  }
}
