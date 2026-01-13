// api/proxy.js
// Vercel serverless GET proxy for Roblox APIs (safe host allowlist)
//
// Auth rules (your requested behavior):
// - apis.roblox.com  -> use ONLY Open Cloud API key (no cookie)
// - other allowed domains -> use cookie (like original approach)
//
// Env vars (Vercel):
// - ROBLOX_OPEN_CLOUD_KEY     (required for apis.roblox.com calls)
// - ROBLOX_SECURITY_COOKIE    (required for non-apis.roblox.com calls; value only, no ".ROBLOSECURITY=" prefix)
//
// Response is ALWAYS JSON:
// {
//   ok: boolean,
//   upstreamStatus: number,
//   upstreamContentType: string,
//   json: object|null,
//   text: string,
//   error?: string,
//   authSent: { apiKey: boolean, cookie: boolean, cookieLen: number }
// }

const ALLOWED_HOSTS = [
	"games.roblox.com",
	"apis.roblox.com",
	"users.roblox.com",
	"thumbnails.roblox.com",
	"catalog.roblox.com",
];

function truthy(s) {
	return typeof s === "string" && s.trim() !== "";
}

export default async function handler(req, res) {
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

		let sentApiKey = false;
		let sentCookie = false;
		let cookieLen = 0;

		if (urlObj.host === "apis.roblox.com") {
			// apis.roblox.com -> Open Cloud API key ONLY
			if (!truthy(openCloudKey)) {
				return res.status(200).json({
					ok: false,
					upstreamStatus: 0,
					upstreamContentType: "",
					json: null,
					text: "",
					error: "Missing ROBLOX_OPEN_CLOUD_KEY env var for apis.roblox.com",
					authSent: { apiKey: false, cookie: false, cookieLen: 0 },
				});
			}

			headers["x-api-key"] = openCloudKey.trim();
			sentApiKey = true;
		} else {
			// Other allowed Roblox domains -> cookie auth (like original)
			if (!truthy(rbxCookie)) {
				return res.status(200).json({
					ok: false,
					upstreamStatus: 0,
					upstreamContentType: "",
					json: null,
					text: "",
					error: `Missing ROBLOX_SECURITY_COOKIE env var for ${urlObj.host}`,
					authSent: { apiKey: false, cookie: false, cookieLen: 0 },
				});
			}

			const cookieVal = rbxCookie.trim();
			cookieLen = cookieVal.length;
			headers["Cookie"] = `.ROBLOSECURITY=${cookieVal}`;
			sentCookie = true;
		}

		let upstreamStatus = 0;
		let upstreamContentType = "";
		let bodyText = "";
		let fetchError = null;

		try {
			const upstream = await fetch(targetUrl, {
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

		let parsedJson = null;
		if (upstreamContentType.includes("application/json") && bodyText) {
			try {
				parsedJson = JSON.parse(bodyText);
			} catch {
				parsedJson = null;
			}
		}

		return res.status(200).json({
			ok: fetchError == null && upstreamStatus >= 200 && upstreamStatus < 300,
			upstreamStatus,
			upstreamContentType,
			json: parsedJson,
			text: bodyText || "",
			error: fetchError || undefined,
			authSent: { apiKey: sentApiKey, cookie: sentCookie, cookieLen },
		});
	} catch (err) {
		return res.status(200).json({
			ok: false,
			upstreamStatus: 0,
			upstreamContentType: "",
			json: null,
			text: "",
			error: String(err),
			authSent: { apiKey: false, cookie: false, cookieLen: 0 },
		});
	}
}
