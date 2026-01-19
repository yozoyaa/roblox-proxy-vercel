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

const PROXY_ROUTE = "/api/fetch-url"

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

function getBaseUrl(req) {
	const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim()
	const host = req.headers.host
	return `${proto}://${host}`
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
	// Can be string or number depending on Roblox service behavior
	if (typeof creatorTypeRaw === "string") {
		const s = creatorTypeRaw.trim().toLowerCase()
		if (s === "group") return "Group"
		if (s === "user") return "User"
		return null
	}

	if (typeof creatorTypeRaw === "number" && Number.isFinite(creatorTypeRaw)) {
		// Common Roblox convention: 1=User, 2=Group
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

function unwrapProxyWire(parsedValue) {
	// Expected wire:
	// { ok: boolean, upstreamStatus: number, upstreamContentType: string, json?: any, text?: string, error?: string }
	if (!parsedValue || typeof parsedValue !== "object") return { ok: true, body: parsedValue }

	const isWire =
		typeof parsedValue.ok === "boolean" &&
		(parsedValue.upstreamStatus != null || parsedValue.upstreamContentType != null)

	if (!isWire) return { ok: true, body: parsedValue }

	const upstreamStatus = typeof parsedValue.upstreamStatus === "string"
		? Number(parsedValue.upstreamStatus)
		: parsedValue.upstreamStatus

	const in2xx = Number.isFinite(upstreamStatus) && upstreamStatus >= 200 && upstreamStatus < 300
	if (!(parsedValue.ok === true && in2xx)) {
		let snippet = ""
		if (parsedValue.json != null) {
			try {
				snippet = JSON.stringify(parsedValue.json).slice(0, 300)
			} catch {
				snippet = String(parsedValue.json).slice(0, 300)
			}
		} else if (typeof parsedValue.text === "string") {
			snippet = parsedValue.text.slice(0, 300)
		}

		return {
			ok: false,
			upstreamStatus: Number.isFinite(upstreamStatus) ? upstreamStatus : 0,
			error: parsedValue.error ? String(parsedValue.error) : "",
			bodySnippet: snippet,
		}
	}

	if (parsedValue.json != null) return { ok: true, body: parsedValue.json }

	if (typeof parsedValue.text === "string") {
		const parsedText = safeJsonParse(parsedValue.text)
		return { ok: true, body: parsedText.ok ? parsedText.value : parsedValue.text }
	}

	return { ok: true, body: null }
}

async function proxyGet(req, actualUrl, errors, step, context) {
	const baseUrl = getBaseUrl(req)
	const proxyUrl = `${baseUrl}${PROXY_ROUTE}?url=${encodeURIComponent(actualUrl)}`

	try {
		const res = await fetch(proxyUrl, { method: "GET" })
		const text = await res.text()

		const parsed = safeJsonParse(text)
		if (!parsed.ok) {
			errors.push({
				step,
				message: "Proxy returned non-JSON response",
				context: { ...context, status: res.status, proxyUrl, bodySnippet: text.slice(0, 300) },
			})
			return null
		}

		const unwrapped = unwrapProxyWire(parsed.value)
		if (!unwrapped.ok) {
			errors.push({
				step,
				message: "Upstream error via fetch-url proxy",
				context: {
					...context,
					proxyUrl,
					upstreamStatus: unwrapped.upstreamStatus,
					error: unwrapped.error,
					bodySnippet: unwrapped.bodySnippet,
				},
			})
			return null
		}

		return unwrapped.body
	} catch (e) {
		errors.push({
			step,
			message: "Proxy fetch failed",
			context: { ...context, proxyUrl, error: String(e) },
		})
		return null
	}
}

// ---- CSRF handling for Catalog POST ----
let cachedCsrfToken = null

function buildRobloxCookieHeader() {
	const raw = process.env.ROBLOX_SECURITY_COOKIE
	if (!raw || typeof raw !== "string" || raw.trim() === "") return null

	// Support both formats:
	// - raw cookie value only
	// - full ".ROBLOSECURITY=...." string
	if (raw.includes(".ROBLOSECURITY=")) return raw
	return `.ROBLOSECURITY=${raw}`
}

async function catalogPostItemsDetails(assetIds, errors, userId) {
	const body = {
		items: assetIds.map((id) => ({
			itemType: 1,
			id,
		})),
	}

	const cookieHeader = buildRobloxCookieHeader()

	const headers = {
		"Content-Type": "application/json",
		"Accept": "application/json",
	}

	// If you want consistent behavior and access, send cookie if available.
	if (cookieHeader) {
		headers.Cookie = cookieHeader
	}

	if (cachedCsrfToken) {
		headers["x-csrf-token"] = cachedCsrfToken
	}

	async function doPost() {
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

		const data = {}
		for (const key of ASSET_LIST_KEYS) data[key] = {}

		// A) games -> placeIds
		const gamesUrl = `https://games.roblox.com/v2/users/${userId}/games?sortOrder=Asc&limit=50`
		const gamesJson = await proxyGet(req, gamesUrl, errors, "games.list", { userId })

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
					const uniJson = await proxyGet(req, universeUrl, errors, "universes.fromPlace", {
						userId,
						placeId,
					})

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

							const gpJson = await proxyGet(req, url, errors, "gamepasses.list", {
								userId,
								universeId,
								page,
							})
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

					const invJson = await proxyGet(req, url, errors, "inventory.list", { userId, assetType, page })
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
					const gJson = await proxyGet(req, url, errors, "groups.get", { userId, groupId })
					const ownerUserId = gJson ? parseGroupOwnerUserId(gJson) : null
					groupOwnerCache.set(groupId, ownerUserId)
					return ownerUserId
				}

				for (let i = 0; i < allAssetIds.length; i += DEFAULTS.catalogBatchSize) {
					const batchIds = allAssetIds.slice(i, i + DEFAULTS.catalogBatchSize)
					const details = await catalogPostItemsDetails(batchIds, errors, userId)
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
