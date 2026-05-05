export const config = { runtime: "nodejs" }
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

const DEFAULTS = {
	includeGamepasses: true,
	includeClothing: true,
	maxPlaces: 50,
	maxUniversePages: 10,
	maxCatalogPages: 10,
	pageSize: 100,

	concurrency: 5,
}

const CLOTHING_ASSET_TYPES = {
	CLASSIC_TSHIRT: 2,
	CLASSIC_SHIRT: 11,
	CLASSIC_PANTS: 12,
}
const ASSET_LIST_KEYS = ["GAMEPASS", ...Object.keys(CLOTHING_ASSET_TYPES)]
const SOFT_ERROR = Symbol("soft_error")

// Only the hosts this endpoint actually calls
const ALLOWED_HOSTS = [
	"apis.roblox.com",
	"catalog.roblox.com",
	"games.roblox.com",
]

// small jitter to reduce bursts
const UPSTREAM_DELAY_MIN_MS = 200
const UPSTREAM_DELAY_MAX_MS = 300

// retry controls
const MAX_ATTEMPTS = 4
const RETRY_BASE_DELAY_MS = 600
const RETRY_MAX_DELAY_MS = 8000
const UPSTREAM_TIMEOUT_MS = 15000

// verbose logs: set Vercel env DEBUG_LOG_ALL=1
const DEBUG_LOG_ALL = process.env.DEBUG_LOG_ALL === "1"

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function getUpstreamDelayMs() {
	return UPSTREAM_DELAY_MIN_MS + Math.floor(Math.random() * (UPSTREAM_DELAY_MAX_MS - UPSTREAM_DELAY_MIN_MS + 1))
}

function clampInt(n, min, max) {
	return Math.max(min, Math.min(max, Math.trunc(n)))
}

function truthy(s) {
	return typeof s === "string" && s.trim() !== ""
}

function safeUpstreamLabel(urlObj) {
	return `${urlObj.host}${urlObj.pathname}`
}

function normalizeRobloxCookie(raw) {
	if (typeof raw !== "string") return ""

	let s = raw.trim()

	// strip wrapping quotes (common in env UI)
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		s = s.slice(1, -1).trim()
	}

	// remove ALL whitespace (spaces/newlines/tabs) that can break cookie parsing
	s = s.replace(/\s+/g, "").trim()

	// allow storing token-only; prefix it
	if (s !== "" && !s.includes("ROBLOSECURITY=")) {
		s = `.ROBLOSECURITY=${s}`
	}

	return s
}

function toInt(value) {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
	if (typeof value !== "string") return NaN
	const s = value.trim()
	if (s === "") return NaN
	const n = Number(s)
	return Number.isFinite(n) ? Math.trunc(n) : NaN
}

function clamp(n, min, max) {
	return Math.max(min, Math.min(max, n))
}

function parseBool(value, defaultValue) {
	if (value == null) return defaultValue
	if (typeof value === "boolean") return value
	const s = String(value).trim().toLowerCase()
	if (s === "true" || s === "1" || s === "yes" || s === "y") return true
	if (s === "false" || s === "0" || s === "no" || s === "n") return false
	return defaultValue
}

function safeJsonParse(text) {
	try {
		return { ok: true, value: JSON.parse(text) }
	} catch (e) {
		return { ok: false, error: e }
	}
}

// Simple concurrency limiter (no deps)
function createLimiter(limit) {
	let active = 0
	const queue = []

	const next = () => {
		if (active >= limit) return
		const job = queue.shift()
		if (!job) return
		active += 1
		Promise.resolve()
			.then(job.fn)
			.then(job.resolve, job.reject)
			.finally(() => {
				active -= 1
				next()
			})
	}

	return function run(fn) {
		return new Promise((resolve, reject) => {
			queue.push({ fn, resolve, reject })
			next()
		})
	}
}

function getNextPageToken(obj) {
	const t = obj?.nextPageToken ?? obj?.nextPageCursor
	if (t == null) return null
	const s = String(t).trim()
	return s.length > 0 ? s : null
}

function parseRobuxPrice(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (typeof value === "string") {
		const s = value.trim()
		if (s !== "") {
			const n = Number(s)
			if (Number.isFinite(n)) return n
		}
	}
	return null
}

function makeAssetEntry(assetName, assetType, assetTypeId, assetPrice) {
	return {
		AssetName: String(assetName || ""),
		AssetType: assetType,
		AssetTypeId: Number(assetTypeId) || 0,
		AssetPrice: Number(assetPrice) || 0,
	}
}

// ---- Retry / timeout helpers ----

function fetchWithTimeout(url, options, timeoutMs) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)

	return fetch(url, {
		...options,
		signal: controller.signal,
	}).finally(() => clearTimeout(timer))
}

function isRetryableStatus(status) {
	return status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504
}

function getRateLimitInfo(headers) {
	const pick = (name) => headers.get(name) || null

	return {
		retryAfter: pick("retry-after"),
		remaining: pick("x-ratelimit-remaining") || pick("x-rate-limit-remaining"),
		limit: pick("x-ratelimit-limit") || pick("x-rate-limit-limit"),
		reset: pick("x-ratelimit-reset") || pick("x-rate-limit-reset"),
	}
}

function computeBackoffMs(attemptIndex, retryAfterMs) {
	if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
		return clampInt(retryAfterMs, 0, RETRY_MAX_DELAY_MS)
	}

	const exp = RETRY_BASE_DELAY_MS * Math.pow(2, attemptIndex - 1)
	const jitter = Math.floor(Math.random() * 250)
	return clampInt(exp + jitter, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS)
}

function makeLogger(requestId) {
	const prefix = `[GetDonationAsset:${requestId}]`

	return {
		debug: (msg) => {
			if (DEBUG_LOG_ALL) console.log(`${prefix} ${msg}`)
		},
		info: (msg) => console.log(`${prefix} ${msg}`),
		warn: (msg) => console.warn(`${prefix} ${msg}`),
		error: (msg) => console.error(`${prefix} ${msg}`),
	}
}

function getSnippet(text) {
	return String(text || "")
		.slice(0, 180)
		replace(/\s+/g, " ")
		.trim()
}

function isSoftCatalogClothingError(status) {
	return status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504
}

export default async function handler(req, res) {
	res.setHeader("Content-Type", "application/json; charset=utf-8")
	res.setHeader("Cache-Control", "no-store")

	const requestId =
		typeof crypto !== "undefined" && crypto.randomUUID
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`

	const log = makeLogger(requestId)

	const errors = []
	const out = {
		ok: false,
		userId: 0,
		summary: {
			places: 0,
			universes: 0,
			gamepasses: 0,
			clothing: 0,
		},
		Data: {},
		errors,
	}

	const metrics = {
		upstreamCalls: 0,
		upstreamRetries: 0,
		upstream429: 0,
		upstreamNon2xx: 0,
	}

	const requestStart = Date.now()

	try {
		if (req.method !== "GET") {
			errors.push({ step: "validate", message: "Method not allowed (GET only)", context: {} })
			log.warn("FAIL step=validate reason=method_not_allowed")
			out.ok = false
			log.info(`END ok=false ms=${Date.now() - requestStart} errors=${errors.length}`)
			return res.status(200).json(out)
		}

		const userId = toInt(req.query.userId)
		if (!Number.isFinite(userId) || userId <= 0) {
			errors.push({
				step: "validate",
				message: "Missing or invalid userId (must be a positive integer)",
				context: { userId: req.query.userId },
			})
			log.warn("FAIL step=validate reason=invalid_userId")
			out.ok = false
			log.info(`END ok=false ms=${Date.now() - requestStart} errors=${errors.length}`)
			return res.status(200).json(out)
		}
		out.userId = userId

		const includeGamepasses = parseBool(req.query.includeGamepasses, DEFAULTS.includeGamepasses)
		const includeClothing = parseBool(req.query.includeClothing, DEFAULTS.includeClothing)

		const maxPlaces = clamp(
			Number.isFinite(toInt(req.query.maxPlaces)) ? toInt(req.query.maxPlaces) : DEFAULTS.maxPlaces,
			1,
			50
		)
		const maxUniversePages = clamp(
			Number.isFinite(toInt(req.query.maxUniversePages)) ? toInt(req.query.maxUniversePages) : DEFAULTS.maxUniversePages,
			1,
			100
		)
		const maxCatalogPages = clamp(
			Number.isFinite(toInt(req.query.maxCatalogPages)) ? toInt(req.query.maxCatalogPages) : DEFAULTS.maxCatalogPages,
			1,
			100
		)

		let pageSize = Number.isFinite(toInt(req.query.pageSize)) ? toInt(req.query.pageSize) : DEFAULTS.pageSize
		pageSize = clamp(pageSize, 1, 100)

		const limiter = createLimiter(DEFAULTS.concurrency)

		const openCloudKey = (process.env.ROBLOX_OPEN_CLOUD_KEY || "").trim()
		const rbxCookie = normalizeRobloxCookie(process.env.ROBLOX_SECURITY_COOKIE)

		const baseHeaders = {
			Accept: "application/json",
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
			"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		Referer: "https://www.roblox.com/",
		"Cache-Control": "no-cache",
	}

		function buildAuthHeaders() {
			const headers = { ...baseHeaders }

			if (truthy(openCloudKey)) {
				headers["x-api-key"] = openCloudKey
			}

			if (truthy(rbxCookie)) {
				headers.Cookie = rbxCookie
			}

			return headers
		}

		async function robloxGetJson(url, step, context, options = {}) {
			let urlObj
			try {
				urlObj = new URL(url)
			} catch {
				errors.push({ step, message: "Invalid URL format", context: { ...context, url } })
				log.warn(`FAIL step=${step} reason=invalid_url`)
				return null
			}

			if (!ALLOWED_HOSTS.includes(urlObj.host)) {
				errors.push({ step, message: "Host not allowed", context: { ...context, host: urlObj.host, url } })
				log.warn(`FAIL step=${step} reason=host_not_allowed host=${urlObj.host}`)
				return null
			}

			const headers = step === "gamepasses.list" ? { ...baseHeaders } : buildAuthHeaders()
			const isSoftError =
				typeof options.softErrorPredicate === "function" ? options.softErrorPredicate : null
			const isSoftException =
				typeof options.softExceptionPredicate === "function" ? options.softExceptionPredicate : null

			async function fetchTextOnce(targetUrl) {
				await sleep(getUpstreamDelayMs())

				const cacheBust = Date.now().toString()
				const addCacheBuster = (rawUrl) => {
					const u = new URL(rawUrl)
					u.searchParams.append("cb", cacheBust)
					return u.toString()
				}

				const start = Date.now()
				const upstream = await fetchWithTimeout(
					addCacheBuster(targetUrl),
					{ method: "GET", headers, redirect: "manual", cache: "no-store", next: { revalidate: 0 } },
					UPSTREAM_TIMEOUT_MS
				)

				// follow 1 redirect with same headers
				if (upstream.status >= 300 && upstream.status < 400) {
					const loc = upstream.headers.get("location")
					if (loc) {
						const nextUrl = new URL(loc, targetUrl).toString()
						const nextObj = new URL(nextUrl)

						if (!ALLOWED_HOSTS.includes(nextObj.host)) {
							return {
								status: 0,
								ms: Date.now() - start,
								text: "",
								contentType: "",
								rate: null,
								redirectBlocked: { from: targetUrl, to: nextUrl, host: nextObj.host },
							}
						}

						await sleep(getUpstreamDelayMs())

						const upstream2 = await fetchWithTimeout(
							addCacheBuster(nextUrl),
							{ method: "GET", headers, redirect: "manual", cache: "no-store", next: { revalidate: 0 } },
							UPSTREAM_TIMEOUT_MS
						)

						const text2 = await upstream2.text()
						return {
							status: upstream2.status,
							ms: Date.now() - start,
							text: text2 || "",
							contentType: upstream2.headers.get("content-type") || "",
							rate: getRateLimitInfo(upstream2.headers),
						}
					}
				}

				const text = await upstream.text()
				return {
					status: upstream.status,
					ms: Date.now() - start,
					text: text || "",
					contentType: upstream.headers.get("content-type") || "",
					rate: getRateLimitInfo(upstream.headers),
				}
			}

			metrics.upstreamCalls += 1

			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
				try {
					if (DEBUG_LOG_ALL) {
						log.debug(
							`GET step=${step} attempt=${attempt}/${MAX_ATTEMPTS} host=${urlObj.host} path=${safeUpstreamLabel(urlObj)}`
						)
					}

					const result = await fetchTextOnce(url)

					if (result.redirectBlocked) {
						errors.push({
							step,
							message: "Redirect host not allowed",
							context: { ...context, ...result.redirectBlocked },
						})
						log.warn(`FAIL step=${step} reason=redirect_host_not_allowed host=${result.redirectBlocked.host}`)
						return null
					}

					const ok = result.status >= 200 && result.status < 300
					if (!ok) {
						metrics.upstreamNon2xx += 1
						if (result.status === 429) metrics.upstream429 += 1

						if (
							isSoftError &&
							isSoftError({
								status: result.status,
								text: result.text,
								contentType: result.contentType,
								context,
							})
						) {
							log.warn(`SKIP step=${step} status=${result.status} reason=soft_error`)
							return SOFT_ERROR
						}

						log.warn(`FAIL step=${step} status=${result.status} ms=${result.ms} snippet="${getSnippet(result.text)}"`)

						if (isRetryableStatus(result.status) && attempt < MAX_ATTEMPTS) {
							const waitMs = computeBackoffMs(attempt, null)
							metrics.upstreamRetries += 1
							log.warn(`RETRY step=${step} status=${result.status} attempt=${attempt}/${MAX_ATTEMPTS} wait=${waitMs}ms`)
							await sleep(waitMs)
							continue
						}

						errors.push({
							step,
							message: "Upstream error",
							context: {
								...context,
								url,
								upstreamStatus: result.status,
								ms: result.ms,
								rateLimit: result.rate,
								bodySnippet: String(result.text || "").slice(0, 300),
							},
						})
						return null
					}

					const parsed = safeJsonParse(result.text)
					if (!parsed.ok) {
						errors.push({
							step,
							message: "Upstream returned non-JSON response",
							context: {
								...context,
								url,
								upstreamStatus: result.status,
								ms: result.ms,
								upstreamContentType: result.contentType,
								bodySnippet: String(result.text || "").slice(0, 300),
							},
						})
						log.warn(`FAIL step=${step} reason=non_json status=${result.status} ms=${result.ms}`)
						return null
					}

					return parsed.value
				} catch (e) {
					const isAbort = String(e && e.name) === "AbortError"
					const isLast = attempt >= MAX_ATTEMPTS

					if (
						isSoftException &&
						isSoftException({
							error: e,
							isAbort,
							context,
						})
					) {
						log.warn(`SKIP step=${step} reason=soft_exception error="${String(e)}"`)
						return SOFT_ERROR
					}

					if (!isLast) {
						const waitMs = computeBackoffMs(attempt, null)
						metrics.upstreamRetries += 1
						log.warn(
							`RETRY step=${step} reason=${isAbort ? "timeout" : "network"} attempt=${attempt}/${MAX_ATTEMPTS} wait=${waitMs}ms error="${String(e)}"`
						)
						await sleep(waitMs)
						continue
					}

					errors.push({ step, message: "Upstream fetch failed", context: { ...context, url, error: String(e) } })
					log.error(`FAIL step=${step} reason=fetch_failed error="${String(e)}"`)
					return null
				}
			}

			return null
		}

		function getClothingAssetTypeId(assetType) {
			return CLOTHING_ASSET_TYPES[assetType] || 0
		}

		function addClothingAsset(assetType, assetId, assetName, assetPrice) {
			const id = Number(assetId)
			if (!Number.isFinite(id) || id <= 0) return
			data[assetType][String(id)] = makeAssetEntry(
				assetName || `Asset ${id}`,
				assetType,
				getClothingAssetTypeId(assetType),
				assetPrice
			)
		}

		function isCatalogCreatorUser(creatorTypeRaw) {
			if (typeof creatorTypeRaw === "string") return creatorTypeRaw.trim().toLowerCase() === "user"
			if (typeof creatorTypeRaw === "number") return creatorTypeRaw === 1
			return false
		}

		function isCatalogItemOffSale(item) {
			if (item?.isOffSale === true) return true
			if (typeof item?.priceStatus !== "string") return false
			const s = item.priceStatus.trim().toLowerCase().replace(/\s+/g, "")
			return s === "offsale"
		}

		function catalogItemMatchesAssetType(item, assetType) {
			const expectedTypeId = getClothingAssetTypeId(assetType)

			if (Number(item?.assetType) === expectedTypeId) return true
			if (Number(item?.assetTypeId) === expectedTypeId) return true

			return false
		}

		async function collectCreatorClassicClothingAssets() {
			for (const assetType of Object.keys(CLOTHING_ASSET_TYPES)) {
				const expectedAssetTypeId = CLOTHING_ASSET_TYPES[assetType]
				let cursor = null

				for (let page = 0; page < maxCatalogPages; page += 1) {
					const urlObj = new URL("https://catalog.roblox.com/v2/search/items/details")
					urlObj.searchParams.set("AssetTypeIds", String(expectedAssetTypeId))
					urlObj.searchParams.set("CreatorTargetId", String(userId))
					urlObj.searchParams.set("CreatorType", "User")
					urlObj.searchParams.set("MinPrice", "1")
					urlObj.searchParams.set("IncludeNotForSale", "false")
					urlObj.searchParams.set("limit", String(pageSize))
					urlObj.searchParams.set("sortOrder", "Desc")
					urlObj.searchParams.set("CategoryFilter", "0")
					urlObj.searchParams.set("SortAggregation", "0")
					urlObj.searchParams.set("SortType", "0")
					urlObj.searchParams.set("SalesTypeFilter", "0")
					urlObj.searchParams.set("Keyword", "")
					urlObj.searchParams.set("Topics", "")
					urlObj.searchParams.set("TriggeredByTopicDiscovery", "false")
					urlObj.searchParams.set("Taxonomy", "")
					urlObj.searchParams.set("CreatorName", "")
					urlObj.searchParams.set("MaxPrice", "2147483647")
					if (cursor) urlObj.searchParams.set("cursor", cursor)

					const searchJson = await robloxGetJson(urlObj.toString(), "catalog.search", { userId, assetType, page }, {
						softErrorPredicate: ({ status }) => isSoftCatalogClothingError(status),
						softExceptionPredicate: () => true,
					})

					if (searchJson === SOFT_ERROR) {
						log.warn(`SKIP clothing type=${assetType}: catalog search soft error`)
						break
					}
					if (!searchJson) break

					const items = Array.isArray(searchJson?.data) ? searchJson.data : []
					for (const item of items) {
						const assetId = Number(item?.id)
						if (!Number.isFinite(assetId) || assetId <= 0) continue
						if (Number(item?.creatorTargetId) !== userId) continue
						if (!isCatalogCreatorUser(item?.creatorType)) continue
						if (isCatalogItemOffSale(item)) continue
						if (!catalogItemMatchesAssetType(item, assetType)) continue

						const price = parseRobuxPrice(item?.price)
						if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue

						const name =
							(typeof item?.name === "string" && item.name.trim() !== "" && item.name) || `Asset ${assetId}`

						addClothingAsset(assetType, assetId, name, price)
					}

					cursor = getNextPageToken(searchJson)
					if (!cursor) break
				}
			}
		}

		log.info(
			`START userId=${userId} includeGamepasses=${includeGamepasses} includeClothing=${includeClothing} ` +
				`concurrency=${DEFAULTS.concurrency} delayMs=${UPSTREAM_DELAY_MIN_MS}-${UPSTREAM_DELAY_MAX_MS} ` +
				`timeoutMs=${UPSTREAM_TIMEOUT_MS} maxAttempts=${MAX_ATTEMPTS}`
		)

		const data = {}
		for (const key of ASSET_LIST_KEYS) data[key] = {}

		if (includeGamepasses) {
			// A) games -> placeIds
			const gamesUrl = `https://games.roblox.com/v2/users/${userId}/games?sortOrder=Asc&limit=50`
			const gamesJson = await robloxGetJson(gamesUrl, "games.list", { userId })

			const gamesArr = Array.isArray(gamesJson?.data) ? gamesJson.data : []
			const placeIdsRaw = []
			for (const item of gamesArr) {
				const pid = item?.rootPlace?.id
				if (typeof pid === "number" && Number.isFinite(pid)) placeIdsRaw.push(pid)
			}

			const placeIds = Array.from(new Set(placeIdsRaw)).slice(0, maxPlaces)
			out.summary.places = placeIds.length

			// B) place -> universe
			const universeIdSet = new Set()
			await Promise.all(
				placeIds.map((placeId) =>
					limiter(async () => {
						const universeUrl = `https://apis.roblox.com/universes/v1/places/${placeId}/universe`
						const uniJson = await robloxGetJson(universeUrl, "universes.fromPlace", { userId, placeId })

						const universeId = uniJson?.universeId
						if (typeof universeId === "number" && Number.isFinite(universeId)) {
							universeIdSet.add(universeId)
						} else if (uniJson != null) {
							errors.push({
								step: "universes.fromPlace",
								message: "Invalid universe response (missing universeId)",
								context: { userId, placeId, response: uniJson },
							})
							log.warn(`FAIL step=universes.fromPlace reason=missing_universeId placeId=${placeId}`)
						}
					})
				)
			)

			const universeIds = Array.from(universeIdSet)
			out.summary.universes = universeIds.length

			// C) gamepasses
			const seenGamepassIds = new Set()

			await Promise.all(
				universeIds.map((universeId) =>
					limiter(async () => {
						let pageToken = null
						for (let page = 0; page < maxUniversePages; page += 1) {
							const url =
								`https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes` +
								`?passView=Full&pageSize=${pageSize}` +
								(pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")

							const gpJson = await robloxGetJson(url, "gamepasses.list", { userId, universeId, page })
							if (!gpJson) return

							const passes = Array.isArray(gpJson?.gamePasses) ? gpJson.gamePasses : []
							for (const gp of passes) {
								const gpId = gp?.id
								if (typeof gpId !== "number" || !Number.isFinite(gpId)) continue
								if (seenGamepassIds.has(gpId)) continue
								if (gp?.isForSale !== true) continue

								const price = parseRobuxPrice(gp?.price)
								if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue

								const name =
									(typeof gp?.name === "string" && gp.name.trim() !== "" && gp.name) ||
									(typeof gp?.displayName === "string" &&
										gp.displayName.trim() !== "" &&
										gp.displayName) ||
									`Game Pass ${gpId}`

								seenGamepassIds.add(gpId)
								data.GAMEPASS[String(gpId)] = makeAssetEntry(name, "GAMEPASS", 34, price)
							}

							pageToken = getNextPageToken(gpJson)
							if (!pageToken) break
						}
					})
				)
			)
		}

		if (includeClothing) {
			await collectCreatorClassicClothingAssets()
		}

		out.Data = data
		out.summary.gamepasses = Object.keys(data.GAMEPASS).length
		out.summary.clothing =
			Object.keys(data.CLASSIC_TSHIRT).length +
			Object.keys(data.CLASSIC_SHIRT).length +
			Object.keys(data.CLASSIC_PANTS).length

		out.ok = errors.length === 0

		const totalMs = Date.now() - requestStart
		log.info(
			`END ok=${out.ok} ms=${totalMs} errors=${errors.length} ` +
				`places=${out.summary.places} universes=${out.summary.universes} ` +
				`gamepasses=${out.summary.gamepasses} clothing=${out.summary.clothing} ` +
				`upstreamCalls=${metrics.upstreamCalls} retries=${metrics.upstreamRetries} ` +
				`429=${metrics.upstream429} non2xx=${metrics.upstreamNon2xx}`
		)

		out.debug = {
			serverTime: new Date().toISOString(),
			region: process.env.VERCEL_REGION || "local",
		}

		return res.status(200).json(out)
	} catch (e) {
		errors.push({
			step: "fatal",
			message: "Unhandled server error",
			context: { error: String(e) },
		})

		out.ok = false
		log.error(`END ok=false reason=fatal ms=${Date.now() - requestStart} error="${String(e)}"`)
		return res.status(200).json(out)
	}
}
