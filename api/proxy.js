// api/proxy.js
const ALLOWED_HOSTS = [
  "games.roblox.com",
  "apis.roblox.com",
  "users.roblox.com",
  "thumbnails.roblox.com",
  "catalog.roblox.com",
];

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const target = req.query.url;
    if (!target) {
      return res.status(400).json({ ok: false, error: "Missing 'url' query parameter" });
    }

    let targetUrl;
    try {
      targetUrl = decodeURIComponent(target);
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid URL encoding" });
    }

    let urlObj;
    try {
      urlObj = new URL(targetUrl);
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid URL format" });
    }

    if (!ALLOWED_HOSTS.includes(urlObj.host)) {
      return res.status(403).json({ ok: false, error: "Host not allowed" });
    }

    // Add Open Cloud API key ONLY on the server
    const openCloudKey = process.env.ROBLOX_OPEN_CLOUD_KEY;

    const headers = {
      "Accept": "application/json",
    };

    // Only attach x-api-key for apis.roblox.com Open Cloud endpoints
    if (urlObj.host === "apis.roblox.com") {
      if (!openCloudKey) {
        return res.status(500).json({ ok: false, error: "Missing ROBLOX_OPEN_CLOUD_KEY env var" });
      }
      headers["x-api-key"] = openCloudKey;
    }

    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers,
    });

    const body = await upstream.text();

    // Pass through status + body
    res.status(upstream.status);

    // Try to return JSON if possible
    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        return res.json(JSON.parse(body));
      } catch {
        // fall through
      }
    }

    return res.send(body);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
