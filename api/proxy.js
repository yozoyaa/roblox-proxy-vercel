// api/proxy.js
// Vercel serverless GET proxy for Roblox APIs (safe host allowlist)
//
// TODO implemented:
// 1) If apis.roblox.com returns 403 using apiKey, retry using cookie.
// 2) Add logs (console.log) so Vercel shows request logs.
//
// Env vars (Vercel):
// - ROBLOX_OPEN_CLOUD_KEY      (API key value)
// - ROBLOX_SECURITY_COOKIE     (cookie value only, WITHOUT ".ROBLOSECURITY=" prefix)
//
// Response is ALWAYS JSON:
// {
//   ok: boolean,
//   upstreamStatus: number,
//   upstreamContentType: string,
//   json: object|null,
//   text: string,
//   error?: string,
//   authSent: { method: "apiKey"|"cookie"|"none", tried: string[], cookieLen: number }
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

function safeUpstreamLabel(urlObj) {
	// Don’t print full query; keep logs readable
	return `${urlObj.host}${urlObj.pathname}`;
}

export default async function handler(req, res) {
	// Prevent caching (helps ensure logs always show per request)
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
			"User-Agent": "vercel-proxy/1.0",
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
			if (urlObj.host === "apis.roblox.com") {
				// 1) Try API key first
				if (truthy(openCloudKey)) {
					tried.push("apiKey");
					usedMethod = "apiKey";

					const headers = { ...baseHeaders, "x-api-key": openCloudKey.trim() };
					console.log(`[Proxy:${requestId}] TRY apiKey -> ${safeUpstreamLabel(urlObj)}`);

					result = await doFetch(headers);

					console.log(
						`[Proxy:${requestId}] apiKey status=${result.upstreamStatus} ct=${result.upstreamContentType}`
					);

					// 2) If 403, fallback to cookie (if present)
					if (result.upstreamStatus === 403 && truthy(rbxCookie)) {
						tried.push("cookie");
						usedMethod = "cookie";

						const cookieVal = rbxCookie.trim();
						sentCookieLen = cookieVal.length;

						const headers2 = {
							...baseHeaders,
							Cookie: `.ROBLOSECURITY=${cookieVal}`,
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
					// No API key available, go cookie directly
					tried.push("cookie");
					usedMethod = "cookie";

					const cookieVal = rbxCookie.trim();
					sentCookieLen = cookieVal.length;

					const headers = {
						...baseHeaders,
						Cookie: `.ROBLOSECURITY=${cookieVal}`,
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
					console.log(`[Proxy:${requestId}] No auth available for apis.roblox.com`);
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
			} else {
				// Non-apis.roblox.com -> cookie only (original behavior)
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

				const cookieVal = rbxCookie.trim();
				sentCookieLen = cookieVal.length;

				const headers = {
					...baseHeaders,
					Cookie: `.ROBLOSECURITY=${cookieVal}`,
				};

				console.log(
					`[Proxy:${requestId}] TRY cookie (len=${sentCookieLen}) -> ${safeUpstreamLabel(urlObj)}`
				);

				result = await doFetch(headers);

				console.log(
					`[Proxy:${requestId}] cookie status=${result.upstreamStatus} ct=${result.upstreamContentType}`
				);
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
