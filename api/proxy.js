// api/proxy.js
// Vercel serverless GET proxy for Roblox APIs (safe allowlist + always-send auth)
//
// Env vars (Vercel):
// - ROBLOX_OPEN_CLOUD_KEY      (API key value)
// - ROBLOX_SECURITY_COOKIE     (cookie value only; can be ".ROBLOSECURITY=..." or token only)
//
// Response is ALWAYS JSON.

export const config = { runtime: "nodejs" };

const ALLOWED_HOSTS = [
	"games.roblox.com",
	"apis.roblox.com",
	"users.roblox.com",
	"thumbnails.roblox.com",
	"catalog.roblox.com",
	"inventory.roblox.com",
];

function truthy(s) {
	return typeof s === "string" && s.trim() !== "";
}

function safeUpstreamLabel(urlObj) {
	return `${urlObj.host}${urlObj.pathname}`;
}

function normalizeRobloxCookie(raw) {
	if (typeof raw !== "string") return "";

	let s = raw.trim();

	// strip wrapping quotes (common in env UI)
	if (
		(s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))
	) {
		s = s.slice(1, -1).trim();
	}

	// remove ALL whitespace (spaces/newlines/tabs) that can break cookie parsing
	s = s.replace(/\s+/g, "").trim();

	// allow storing token-only; prefix it
	if (!s.includes("ROBLOSECURITY=")) {
		s = `.ROBLOSECURITY=${s}`;
	}

	return s;
}

export default async function handler(req, res) {
	res.setHeader("Cache-Control", "no-store");

	const requestId =
		typeof crypto !== "undefined" && crypto.randomUUID
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`;

	try {
		// Only allow GET
		if (req.method !== "GET") {
			res.setHeader("Allow", "GET");
			console.log(`[Proxy:${requestId}] 405 Method Not Allowed`);
			return res.status(405).json({ ok: false, error: "Method Not Allowed" });
		}

		const target = req.query.url;
		if (!target) {
			console.log(`[Proxy:${requestId}] 400 Missing url param`);
			return res.status(400).json({ ok: false, error: "Missing 'url' query parameter" });
		}

		let targetUrl;
		try {
			targetUrl = decodeURIComponent(target);
		} catch {
			console.log(`[Proxy:${requestId}] 400 Invalid URL encoding`);
			return res.status(400).json({ ok: false, error: "Invalid URL encoding" });
		}

		let urlObj;
		try {
			urlObj = new URL(targetUrl);
		} catch {
			console.log(`[Proxy:${requestId}] 400 Invalid URL format`);
			return res.status(400).json({ ok: false, error: "Invalid URL format" });
		}

		if (!ALLOWED_HOSTS.includes(urlObj.host)) {
			console.log(`[Proxy:${requestId}] 403 Host not allowed: ${urlObj.host}`);
			return res.status(403).json({ ok: false, error: "Host not allowed" });
		}

		const openCloudKey = (process.env.ROBLOX_OPEN_CLOUD_KEY || "").trim();
		const rbxCookie = normalizeRobloxCookie(process.env.ROBLOX_SECURITY_COOKIE);

		const baseHeaders = {
			Accept: "application/json",
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
				"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Referer: "https://www.roblox.com/",
		};

		const tried = [];
		let sentCookieLen = 0;

		async function readUpstream(upstream) {
			const upstreamStatus = upstream.status;
			const upstreamContentType = upstream.headers.get("content-type") || "";
			const text = await upstream.text();

			let json = null;
			if (upstreamContentType.includes("application/json") && text) {
				try {
					json = JSON.parse(text);
				} catch {
					json = null;
				}
			}

			return { upstreamStatus, upstreamContentType, text: text || "", json };
		}

		async function doFetch(url, headersObj) {
			const h = new Headers(headersObj);

			// Debug (no secrets leaked)
			const cookieHeader = h.get("cookie") || "";
			console.log(
				`[Proxy:${requestId}] outgoing cookieHeaderLen=${cookieHeader.length} hasPair=${cookieHeader.includes(
					"ROBLOSECURITY="
				)} url=${new URL(url).host}${new URL(url).pathname}`
			);

			const upstream = await fetch(url, {
				method: "GET",
				headers: h,
				redirect: "manual",
			});

			// follow 1 redirect with same headers
			if (upstream.status >= 300 && upstream.status < 400) {
				const loc = upstream.headers.get("location");
				if (loc) {
					const nextUrl = new URL(loc, url).toString();
					console.log(
						`[Proxy:${requestId}] redirect ${upstream.status} -> ${new URL(nextUrl).host}${new URL(
							nextUrl
						).pathname}`
					);

					const upstream2 = await fetch(nextUrl, {
						method: "GET",
						headers: h,
						redirect: "manual",
					});

					return await readUpstream(upstream2);
				}
			}

			return await readUpstream(upstream);
		}

		console.log(
			`[Proxy:${requestId}] START host=${urlObj.host} path=${safeUpstreamLabel(urlObj)}`
		);
		console.log(
			`[Proxy:${requestId}] env openCloudKeyLen=${openCloudKey.length} cookieLen=${rbxCookie.length}`
		);

		// Always send both (if present)
		const headers = { ...baseHeaders };

		if (truthy(openCloudKey)) {
			tried.push("apiKey");
			headers["x-api-key"] = openCloudKey;
		}

		if (truthy(rbxCookie)) {
			tried.push("cookie");
			sentCookieLen = rbxCookie.length;

			// IMPORTANT: use lowercase 'cookie' key
			headers.cookie = rbxCookie;
		}

		const result = await doFetch(targetUrl, headers);

		const ok = result.upstreamStatus >= 200 && result.upstreamStatus < 300;

		console.log(
			`[Proxy:${requestId}] END ok=${ok} status=${result.upstreamStatus} tried=${tried.join(",")}`
		);

		return res.status(200).json({
			ok,
			upstreamStatus: result.upstreamStatus,
			upstreamContentType: result.upstreamContentType,
			json: result.json,
			text: result.text,
			authSent: {
				tried,
				cookieLen: sentCookieLen,
				apiKeyLen: openCloudKey.length,
			},
		});
	} catch (err) {
		console.error(`[Proxy:${requestId}] HANDLER ERROR:`, err);
		return res.status(200).json({
			ok: false,
			upstreamStatus: 0,
			upstreamContentType: "",
			json: null,
			text: "",
			error: String(err),
			authSent: { tried: [], cookieLen: 0, apiKeyLen: 0 },
		});
	}
}
