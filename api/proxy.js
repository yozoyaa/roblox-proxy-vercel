// api/proxy.js
// Vercel serverless GET proxy for Roblox APIs (safe allowlist + auth strategy)
//
// Auth strategies:
// - HYBRID_HOSTS: try API key first, if 403 then fallback to cookie
// - COOKIE_ONLY_HOSTS: cookie only
//
// Env vars (Vercel):
// - ROBLOX_OPEN_CLOUD_KEY      (API key value)
// - ROBLOX_SECURITY_COOKIE     (cookie value only)
//
// Response is ALWAYS JSON.

const HYBRID_HOSTS = [
	"apis.roblox.com",
];

const COOKIE_ONLY_HOSTS = [
	"games.roblox.com",
	"users.roblox.com",
	"thumbnails.roblox.com",
	"catalog.roblox.com",
  "inventory.roblox.com",
];

// Allowlist = union of both
const ALLOWED_HOSTS = Array.from(new Set([...HYBRID_HOSTS, ...COOKIE_ONLY_HOSTS]));

function truthy(s) {
	return typeof s === "string" && s.trim() !== "";
}

function safeUpstreamLabel(urlObj) {
	return `${urlObj.host}${urlObj.pathname}`;
}

export default async function handler(req, res) {
	res.setHeader("Cache-Control", "no-store");

	const requestId =
		typeof crypto !== "undefined" && crypto.randomUUID
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`;

	try {
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

		const openCloudKey = process.env.ROBLOX_OPEN_CLOUD_KEY;
		const rbxCookie = process.env.ROBLOX_SECURITY_COOKIE;

		const baseHeaders = {
			Accept: "application/json",
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Referer: "https://www.roblox.com/",
		};

		const tried = [];
		let usedMethod = "none";
		let sentCookieLen = 0;

		async function doFetch(withHeaders) {
			const upstream = await fetch(targetUrl, {
				method: "GET",
				headers: withHeaders,
				redirect: "follow",
			});

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

		console.log(
			`[Proxy:${requestId}] START host=${urlObj.host} path=${safeUpstreamLabel(urlObj)}`
		);

		let result = null;
		let fetchError = null;

		try {
			const isHybrid = HYBRID_HOSTS.includes(urlObj.host);
			const isCookieOnly = COOKIE_ONLY_HOSTS.includes(urlObj.host);

			if (isHybrid) {
				// Try API key first (if available)
				if (truthy(openCloudKey)) {
					tried.push("apiKey");
					usedMethod = "apiKey";

					const headers = { ...baseHeaders, "x-api-key": openCloudKey.trim() };
					console.log(`[Proxy:${requestId}] TRY apiKey -> ${safeUpstreamLabel(urlObj)}`);

					result = await doFetch(headers);

					console.log(
						`[Proxy:${requestId}] apiKey status=${result.upstreamStatus} ct=${result.upstreamContentType}`
					);

					// If 403, fallback to cookie (if available)
					if (result.upstreamStatus === 403 && truthy(rbxCookie)) {
						tried.push("cookie");
						usedMethod = "cookie";

						sentCookieLen = rbxCookie.length;

						const headers2 = {
							...baseHeaders,
							Cookie: rbxCookie,
						};

						console.log(
							`[Proxy:${requestId}] FALLBACK cookie (len=${sentCookieLen}) -> ${safeUpstreamLabel(
								urlObj
							)}`
						);

						result = await doFetch(headers2);

						console.log(
							`[Proxy:${requestId}] cookie status=${result.upstreamStatus} ct=${result.upstreamContentType}`
						);
					}
				} else if (truthy(rbxCookie)) {
					// No API key, go cookie directly
					tried.push("cookie");
					usedMethod = "cookie";

					sentCookieLen = rbxCookie.length;

					const headers = {
						...baseHeaders,
						Cookie: rbxCookie,
					};

					console.log(
						`[Proxy:${requestId}] TRY cookie (len=${sentCookieLen}) -> ${safeUpstreamLabel(
							urlObj
						)}`
					);

					result = await doFetch(headers);

					console.log(
						`[Proxy:${requestId}] cookie status=${result.upstreamStatus} ct=${result.upstreamContentType}`
					);
				} else {
					console.log(`[Proxy:${requestId}] No auth available for hybrid host`);
					return res.status(200).json({
						ok: false,
						upstreamStatus: 0,
						upstreamContentType: "",
						json: null,
						text: "",
						error: "Missing ROBLOX_OPEN_CLOUD_KEY and ROBLOX_SECURITY_COOKIE env vars",
						authSent: { method: "none", tried, cookieLen: 0 },
					});
				}
			} else if (isCookieOnly) {
				// Cookie only
				if (!truthy(rbxCookie)) {
					console.log(`[Proxy:${requestId}] Missing cookie for ${urlObj.host}`);
					return res.status(200).json({
						ok: false,
						upstreamStatus: 0,
						upstreamContentType: "",
						json: null,
						text: "",
						error: `Missing ROBLOX_SECURITY_COOKIE env var for ${urlObj.host}`,
						authSent: { method: "none", tried, cookieLen: 0 },
					});
				}

				tried.push("cookie");
				usedMethod = "cookie";

				sentCookieLen = rbxCookie.length;

				const headers = {
					...baseHeaders,
					Cookie: rbxCookie,
				};

				console.log(
					`[Proxy:${requestId}] TRY cookie (len=${sentCookieLen}) -> ${safeUpstreamLabel(urlObj)}`
				);

				result = await doFetch(headers);

				console.log(
					`[Proxy:${requestId}] cookie status=${result.upstreamStatus} ct=${result.upstreamContentType}`
				);
			} else {
				// Should never happen (ALLOWED_HOSTS is union), but keep safe
				console.log(`[Proxy:${requestId}] 403 Host not configured: ${urlObj.host}`);
				return res.status(403).json({ ok: false, error: "Host not configured" });
			}
		} catch (e) {
			fetchError = String(e);
			console.error(`[Proxy:${requestId}] FETCH ERROR: ${fetchError}`);
		}

		if (!result) {
			return res.status(200).json({
				ok: false,
				upstreamStatus: 0,
				upstreamContentType: "",
				json: null,
				text: "",
				error: fetchError || "Unknown fetch error",
				authSent: { method: usedMethod, tried, cookieLen: sentCookieLen },
			});
		}

		const ok = fetchError == null && result.upstreamStatus >= 200 && result.upstreamStatus < 300;

		console.log(
			`[Proxy:${requestId}] END ok=${ok} status=${result.upstreamStatus} method=${usedMethod} tried=${tried.join(
				","
			)}`
		);

		return res.status(200).json({
			ok,
			upstreamStatus: result.upstreamStatus,
			upstreamContentType: result.upstreamContentType,
			json: result.json,
			text: result.text,
			error: fetchError || undefined,
			authSent: {
				method: usedMethod,
				tried,
				cookieLen: sentCookieLen,
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
			authSent: { method: "none", tried: [], cookieLen: 0 },
		});
	}
}
