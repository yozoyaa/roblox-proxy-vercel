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

    const openCloudKey = process.env.ROBLOX_OPEN_CLOUD_KEY;
    const rbxCookie = process.env.ROBLOX_SECURITY_COOKIE;

    const headers = {
      "Accept": "application/json",
      // Some Roblox infra behaves better with a UA:
      "User-Agent": "vercel-proxy/1.0",
    };

    // Attach auth ONLY for apis.roblox.com (where your failing endpoint lives)
    if (urlObj.host === "apis.roblox.com") {
      if (openCloudKey) {
        headers["x-api-key"] = openCloudKey;
      }

      if (rbxCookie) {
        // IMPORTANT: cookie header must be exactly formatted like this:
        headers["Cookie"] = `.ROBLOSECURITY=${rbxCookie}`;
      }
    }

    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers,
      redirect: "follow",
    });

    const bodyText = await upstream.text();

    // Pass through status
    res.status(upstream.status);

    // Try JSON if possible
    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        return res.json(JSON.parse(bodyText));
      } catch {
        // If Roblox returns JSON but parsing fails, still return raw
      }
    }

    return res.send(bodyText);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
