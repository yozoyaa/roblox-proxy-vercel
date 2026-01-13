// api/proxy.js
// Vercel serverless GET proxy for Roblox APIs
//
// Env vars (Vercel):
// - ROBLOX_OPEN_CLOUD_KEY       (optional)
// - ROBLOX_SECURITY_COOKIE      (optional; value only, WITHOUT ".ROBLOSECURITY=" prefix)
//
// Response is ALWAYS JSON so Roblox can always JSONDecode it:
// {
//   ok: boolean,
//   upstreamStatus: number,            // 0 if network error before response
//   upstreamContentType: string,
//   json: object|null,                 // parsed JSON when possible
//   text: string,                      // raw upstream body text
//   error?: string                     // present when fetch threw
// }

const ALLOWED_HOSTS = [
	"games.roblox.com",
	"apis.roblox.com",
	"users.roblox.com",
	"thumbnails.roblox.com",
	"catalog.roblox.com",
];

module.exports = async function handler(req, res) {
	try {
		// Only allow GET
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

		// Safety: don't make this an open proxy
		if (!ALLOWED_HOSTS.includes(urlObj.host)) {
			return res.status(403).json({ ok: false, error: "Host not allowed" });
		}

		const openCloudKey = process.env.ROBLOX_OPEN_CLOUD_KEY;
		const rbxCookie = process.env.ROBLOX_SECURITY_COOKIE;

		const headers = {
			Accept: "application/json",
			"User-Agent": "vercel-proxy/1.0",
		};

		// Attach auth ONLY for apis.roblox.com
		if (urlObj.host === "apis.roblox.com") {
			if (openCloudKey && openCloudKey.trim() !== "") {
				headers["x-api-key"] = openCloudKey.trim();
			}

			if (rbxCookie && rbxCookie.trim() !== "") {
				// IMPORTANT: cookie header must be exactly formatted like this:
				headers["Cookie"] = `.ROBLOSECURITY=${rbxCookie.trim()}`;
			}
		}

		let upstream;
		let bodyText = "";
		let upstreamStatus = 0;
		let upstreamContentType = "";
		let fetchError = null;

		try {
			upstream = await fetch(targetUrl, {
				method: "GET",
				headers,
				redirect: "follow",
			});

			upstreamStatus = upstream.status;
			upstreamContentType = upstream.headers.get("content-type") || "";
			bodyText = await upstream.text();
		} catch (e) {
			fetchError = String(e);
		}

		// Attempt to parse JSON when upstream claims JSON
		let parsedJson = null;
		if (upstreamContentType.includes("application/json") && bodyText) {
			try {
				parsedJson = JSON.parse(bodyText);
			} catch {
				parsedJson = null;
			}
		}

		// Always respond JSON (so Roblox never gets body=nil)
		return res.status(200).json({
			ok: fetchError == null && upstreamStatus >= 200 && upstreamStatus < 300,
			upstreamStatus,
			upstreamContentType,
			json: parsedJson,
			text: bodyText || "",
			error: fetchError || undefined,
		});
	} catch (err) {
		return res.status(200).json({
			ok: false,
			upstreamStatus: 0,
			upstreamContentType: "",
			json: null,
			text: "",
			error: String(err),
		});
	}
}
