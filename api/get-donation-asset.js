export const config = { runtime: "nodejs" }

const DEFAULTS = {
	includeGamepasses: true,
	includeClothing: true,
	maxPlaces: 50,
	maxUniversePages: 10,
	maxInventoryPages: 10,
	pageSize: 100,

	concurrency: 5,
	catalogBatchSize: 50,
}

const INVENTORY_ASSET_TYPES = ["CLASSIC_TSHIRT", "CLASSIC_SHIRT", "CLASSIC_PANTS"]
const ASSET_LIST_KEYS = ["GAMEPASS", ...INVENTORY_ASSET_TYPES]

const ALLOWED_HOSTS = [
	"apis.roblox.com",
	"catalog.roblox.com",
	"games.roblox.com",
]

const UPSTREAM_DELAY_MIN_MS = 200
const UPSTREAM_DELAY_MAX_MS = 300

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function getUpstreamDelayMs() {
	return UPSTREAM_DELAY_MIN_MS + Math.floor(Math.random() * (UPSTREAM_DELAY_MAX_MS - UPSTREAM_DELAY_MIN_MS + 1))
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
	if (
		(s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))
	) {
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
	const t = obj?.nextPageToken
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

function parseGroupOwnerUserId(groupObj) {
	const ownerRaw = groupObj?.owner
	if (ownerRaw == null) return null
	const s = String(ownerRaw).trim()
	const m = s.match(/users\/(\d+)/i)
	if (!m) return null
	const n = Number(m[1])
	return Number.isFinite(n) ? n : null
}

function normalizeCatalogCreatorType(creatorTypeRaw) {
	if (typeof creatorTypeRaw === "string") {
		const s = creatorTypeRaw.trim().toLowerCase()
		if (s === "group") return "Group"
		if (s === "user") return "User"
		return null
	}

	if (typeof creatorTypeRaw === "number" && Number.isFinite(creatorTypeRaw)) {
		if (creatorTypeRaw === 2) return "Group"
		if (creatorTypeRaw === 1) return "User"
		return "Unknown"
	}

	return null
}

function isCatalogForSale(item) {
	if (!item || typeof item !== "object") return false
	if (item.isOffSale === true) return false

	const price = parseRobuxPrice(item.price)
	if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return false

	if (typeof item.priceStatus === "string") {
		const ps = item.priceStatus.trim().toLowerCase()
		if (ps === "offsale") return false
	}

	return true
}

// ---- CSRF handling for Catalog POST ----
let cachedCsrfToken = null

async function catalogPostItemsDetails(assetIds, errors, userId, requestId) {
	const body = {
		items: assetIds.map((id) => ({
			itemType: 1,
			id,
		})),
	}

	const rbxCookie = normalizeRobloxCookie(process.env.ROBLOX_SECURITY_COOKIE)

	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json",
	}

	if (truthy(rbxCookie)) {
		headers.cookie = rbxCookie
	}

	if (cachedCsrfToken) {
		headers["x-csrf-token"] = cachedCsrfToken
	}

	async function doPost() {
		await sleep(getUpstreamDelayMs())

		return fetch("https://catalog.roblox.com/v1/catalog/items/details", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		})
	}

	try {
		let res = await doPost()

		// If CSRF is required, Roblox returns 403 + x-csrf-token header.
		if (res.status === 403) {
			const newToken = res.headers.get("x-csrf-token")
			if (newToken && newToken !== cachedCsrfToken) {
				cachedCsrfToken = newToken
				headers["x-csrf-token"] = newToken
				res = await doPost()
			}
		}

		const text = await res.text()
		const parsed = safeJsonParse(text)

		if (!parsed.ok) {
			errors.push({
				step: "catalog.details",
				message: "Catalog returned non-JSON response",
				context: { userId, status: res.status, bodySnippet: text.slice(0, 300) },
			})
			return null
		}

		const data = parsed.value?.data
		if (!Array.isArray(data)) {
			errors.push({
				step: "catalog.details",
				message: "Catalog response missing data[]",
				context: { userId, status: res.status, response: parsed.value },
			})
			return null
		}

		return data
	} catch (e) {
		errors.push({
			step: "catalog.details",
			message: "Catalog POST failed",
			context: { userId, error: String(e) },
		})
		return null
	}
}

export default async function handler(req, res) {
	res.setHeader("Content-Type", "application/json; charset=utf-8")
	res.setHeader("Cache-Control", "no-store")

	const requestId =
		typeof crypto !== "undefined" && crypto.randomUUID
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`

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

	try {
		if (req.method !== "GET") {
			errors.push({ step: "validate", message: "Method not allowed (GET only)", context: {} })
			return res.status(200).json(out)
		}

		const userId = toInt(req.query.userId)
		if (!Number.isFinite(userId) || userId <= 0) {
			errors.push({
				step: "validate",
				message: "Missing or invalid userId (must be a positive integer)",
				context: { userId: req.query.userId },
			})
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
			Number.isFinite(toInt(req.query.maxUniversePages))
				? toInt(req.query.maxUniversePages)
				: DEFAULTS.maxUniversePages,
			1,
			100
		)
		const maxInventoryPages = clamp(
			Number.isFinite(toInt(req.query.maxInventoryPages))
				? toInt(req.query.maxInventoryPages)
				: DEFAULTS.maxInventoryPages,
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
		}

		function buildAuthHeaders() {
			const headers = { ...baseHeaders }

			if (truthy(openCloudKey)) {
				headers["x-api-key"] = openCloudKey
			}

			if (truthy(rbxCookie)) {
				headers.cookie = rbxCookie
			}

			return headers
		}

		async function readUpstream(upstream) {
			const upstreamStatus = upstream.status
			const upstreamContentType = upstream.headers.get("content-type") || ""
			const text = await upstream.text()
			return { upstreamStatus, upstreamContentType, text: text || "" }
		}

		async function robloxGetJson(url, step, context) {
			let urlObj
			try {
				urlObj = new URL(url)
			} catch {
				errors.push({
					step,
					message: "Invalid URL format",
					context: { ...context, url },
				})
				return null
			}

			if (!ALLOWED_HOSTS.includes(urlObj.host)) {
				errors.push({
					step,
					message: "Host not allowed",
					context: { ...context, host: urlObj.host, url },
				})
				return null
			}

			const headers = buildAuthHeaders()

			try {
				await sleep(getUpstreamDelayMs())

				console.log(`[GetDonationAsset:${requestId}] GET host=${urlObj.host} path=${safeUpstreamLabel(urlObj)} step=${step}`)

				const upstream = await fetch(url, {
					method: "GET",
					headers,
					redirect: "manual",
				})

				let result = await readUpstream(upstream)

				if (result.upstreamStatus >= 300 && result.upstreamStatus < 400) {
					const loc = upstream.headers.get("location")
					if (loc) {
						const nextUrl = new URL(loc, url).toString()
						const nextObj = new URL(nextUrl)

						if (!ALLOWED_HOSTS.includes(nextObj.host)) {
							errors.push({
								step,
								message: "Redirect host not allowed",
								context: { ...context, from: url, to: nextUrl, host: nextObj.host },
							})
							return null
						}

						await sleep(getUpstreamDelayMs())

						const upstream2 = await fetch(nextUrl, {
							method: "GET",
							headers,
							redirect: "manual",
						})

						result = await readUpstream(upstream2)
					}
				}

				const ok = result.upstreamStatus >= 200 && result.upstreamStatus < 300
				if (!ok) {
					errors.push({
						step,
						message: "Upstream error",
						context: {
							...context,
							url,
							upstreamStatus: result.upstreamStatus,
							bodySnippet: result.text.slice(0, 300),
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
							upstreamStatus: result.upstreamStatus,
							upstreamContentType: result.upstreamContentType,
							bodySnippet: result.text.slice(0, 300),
						},
					})
					return null
				}

				return parsed.value
			} catch (e) {
				errors.push({
					step,
					message: "Upstream fetch failed",
					context: { ...context, url, error: String(e) },
				})
				return null
			}
		}

		const data = {}
		for (const key of ASSET_LIST_KEYS) data[key] = {}

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
					}
				})
			)
		)

		const universeIds = Array.from(universeIdSet)
		out.summary.universes = universeIds.length

		// C) gamepasses
		if (includeGamepasses) {
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

		// D/E) inventory + catalog enrich
		if (includeClothing) {
			const assetsByType = {
				CLASSIC_TSHIRT: new Set(),
				CLASSIC_SHIRT: new Set(),
				CLASSIC_PANTS: new Set(),
			}

			for (const assetType of INVENTORY_ASSET_TYPES) {
				let pageToken = null
				for (let page = 0; page < maxInventoryPages; page += 1) {
					const filterValue = `inventoryItemAssetTypes=${assetType}`
					const url =
						`https://apis.roblox.com/cloud/v2/users/${userId}/inventory-items` +
						`?maxPageSize=${pageSize}` +
						`&filter=${encodeURIComponent(filterValue)}` +
						(pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")

					const invJson = await robloxGetJson(url, "inventory.list", { userId, assetType, page })
					if (!invJson) break

					const items = Array.isArray(invJson?.inventoryItems) ? invJson.inventoryItems : []
					for (const it of items) {
						const rawAssetId = it?.assetDetails?.assetId
						if (typeof rawAssetId !== "string" || rawAssetId.trim() === "") continue
						const assetId = Number(rawAssetId)
						if (Number.isFinite(assetId) && assetId > 0) assetsByType[assetType].add(assetId)
					}

					pageToken = getNextPageToken(invJson)
					if (!pageToken) break
				}
			}

			const allAssetIds = Array.from(
				new Set([
					...assetsByType.CLASSIC_TSHIRT,
					...assetsByType.CLASSIC_SHIRT,
					...assetsByType.CLASSIC_PANTS,
				])
			)

			if (allAssetIds.length > 0) {
				const assetTypeLookup = new Map()
				for (const id of assetsByType.CLASSIC_TSHIRT) assetTypeLookup.set(id, "CLASSIC_TSHIRT")
				for (const id of assetsByType.CLASSIC_SHIRT) assetTypeLookup.set(id, "CLASSIC_SHIRT")
				for (const id of assetsByType.CLASSIC_PANTS) assetTypeLookup.set(id, "CLASSIC_PANTS")

				const groupOwnerCache = new Map()

				async function getGroupOwner(groupId) {
					if (groupOwnerCache.has(groupId)) return groupOwnerCache.get(groupId)

					const url = `https://apis.roblox.com/cloud/v2/groups/${groupId}`
					const gJson = await robloxGetJson(url, "groups.get", { userId, groupId })
					const ownerUserId = gJson ? parseGroupOwnerUserId(gJson) : null
					groupOwnerCache.set(groupId, ownerUserId)
					return ownerUserId
				}

				for (let i = 0; i < allAssetIds.length; i += DEFAULTS.catalogBatchSize) {
					const batchIds = allAssetIds.slice(i, i + DEFAULTS.catalogBatchSize)
					const details = await catalogPostItemsDetails(batchIds, errors, userId, requestId)
					if (!details) continue

					const groupChecks = []

					for (const item of details) {
						const assetId = item?.id
						if (typeof assetId !== "number" || !Number.isFinite(assetId) || assetId <= 0) continue

						const invKey = assetTypeLookup.get(assetId)
						if (!invKey) continue
						if (!isCatalogForSale(item)) continue

						const price = parseRobuxPrice(item.price)
						if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue

						const name =
							(typeof item?.name === "string" && item.name.trim() !== "" && item.name) || `Asset ${assetId}`

						const creatorTargetId = item?.creatorTargetId
						const creatorTypeNorm = normalizeCatalogCreatorType(item?.creatorType)

						const typeId = invKey === "CLASSIC_TSHIRT" ? 2 : invKey === "CLASSIC_SHIRT" ? 11 : 12

						if (creatorTypeNorm === "User") {
							if (Number(creatorTargetId) !== userId) continue
							data[invKey][String(assetId)] = makeAssetEntry(name, invKey, typeId, price)
						} else if (creatorTypeNorm === "Group") {
							const groupId = Number(creatorTargetId)
							if (!Number.isFinite(groupId) || groupId <= 0) continue

							groupChecks.push(
								limiter(async () => {
									const ownerUserId = await getGroupOwner(groupId)
									if (ownerUserId === userId) {
										data[invKey][String(assetId)] = makeAssetEntry(name, invKey, typeId, price)
									}
								})
							)
						} else if (creatorTypeNorm === "Unknown") {
							const maybeId = Number(creatorTargetId)
							if (!Number.isFinite(maybeId) || maybeId <= 0) continue

							groupChecks.push(
								limiter(async () => {
									const ownerUserId = await getGroupOwner(maybeId)
									if (ownerUserId != null) {
										if (ownerUserId === userId) {
											data[invKey][String(assetId)] = makeAssetEntry(name, invKey, typeId, price)
										}
										return
									}

									// Not a group (or not readable) -> treat as User
									if (maybeId === userId) {
										data[invKey][String(assetId)] = makeAssetEntry(name, invKey, typeId, price)
									}
								})
							)
						}
					}

					if (groupChecks.length > 0) await Promise.all(groupChecks)
				}
			}
		}

		out.Data = data
		out.summary.gamepasses = Object.keys(data.GAMEPASS).length
		out.summary.clothing =
			Object.keys(data.CLASSIC_TSHIRT).length +
			Object.keys(data.CLASSIC_SHIRT).length +
			Object.keys(data.CLASSIC_PANTS).length

		out.ok = errors.length === 0
		return res.status(200).json(out)
	} catch (e) {
		errors.push({
			step: "fatal",
			message: "Unhandled server error",
			context: { error: String(e) },
		})
		out.ok = false
		return res.status(200).json(out)
	}
}
