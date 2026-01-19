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

async function proxyGet(req, actualUrl, errors, step, context) {
	const baseUrl = getBaseUrl(req)
	const proxyUrl = `${baseUrl}/api/proxy?url=${encodeURIComponent(actualUrl)}`

	try {
		const res = await fetch(proxyUrl, { method: "GET" })
		const text = await res.text()

		const parsed = safeJsonParse(text)
		if (!parsed.ok) {
			errors.push({
				step,
				message: "Proxy returned non-JSON response",
				context: { ...context, status: res.status, bodySnippet: text.slice(0, 300) },
			})
			return null
		}

		return parsed.value
	} catch (e) {
		errors.push({
			step,
			message: "Proxy fetch failed",
			context: { ...context, error: String(e) },
		})
		return null
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
	// Endpoint historically returns string ("User"/"Group") in the wild,
	// but you also shared a schema where it can be numeric.
	if (typeof creatorTypeRaw === "string") {
		const s = creatorTypeRaw.trim().toLowerCase()
		if (s === "group") return "Group"
		if (s === "user") return "User"
		return null
	}

	if (typeof creatorTypeRaw === "number" && Number.isFinite(creatorTypeRaw)) {
		// Common Roblox pattern: 1 = User, 2 = Group (search APIs use this).
		if (creatorTypeRaw === 2) return "Group"
		if (creatorTypeRaw === 1) return "User"
		// Unknown (0/other) => caller may probe group endpoint if needed.
		return "Unknown"
	}

	return null
}

function isCatalogForSale(item) {
	// Per your schema: priceStatus, isOffSale, price
	// We treat "for sale" as: not offsale + price is finite > 0
	if (!item || typeof item !== "object") return false
	if (item.isOffSale === true) return false

	const price = parseRobuxPrice(item.price)
	if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return false

	// If priceStatus exists and explicitly indicates offsale, respect it
	if (typeof item.priceStatus === "string") {
		const ps = item.priceStatus.trim().toLowerCase()
		if (ps === "offsale") return false
	}

	return true
}

async function catalogPostItemsDetails(assetIds, errors, userId) {
	// POST https://catalog.roblox.com/v1/catalog/items/details
	// Body: { items: [ { itemType: 1, id: <assetId> } ] }
	const body = {
		items: assetIds.map((id) => ({
			itemType: 1,
			id,
		})),
	}

	try {
		const res = await fetch("https://catalog.roblox.com/v1/catalog/items/details", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		})

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
				context: { userId, response: parsed.value },
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

		let pageSize = Number.isFinite(toInt(req.query.pageSize))
			? toInt(req.query.pageSize)
			: DEFAULTS.pageSize
		pageSize = clamp(pageSize, 1, 100)

		const limiter = createLimiter(DEFAULTS.concurrency)

		// Data: AssetList (keys are strings)
		const data = {}
		for (const key of ASSET_LIST_KEYS) data[key] = {}

		// -----------------------------
		// A) List games -> rootPlace.id
		// -----------------------------
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

		// -----------------------------
		// B) placeId -> universeId (concurrency limited)
		// -----------------------------
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

		// -----------------------------
		// C) Gamepasses per universe (NO details endpoint)
		// -----------------------------
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
									(typeof gp?.displayName === "string" && gp.displayName.trim() !== "" && gp.displayName) ||
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

		// -----------------------------
		// D) Inventory items (Cloud v2) assetIds for classic clothing types
		// -----------------------------
		if (includeClothing) {
			const assetsByType = {
				CLASSIC_TSHIRT: new Set(),
				CLASSIC_SHIRT: new Set(),
				CLASSIC_PANTS: new Set(),
			}

			for (const assetType of INVENTORY_ASSET_TYPES) {
				let pageToken = null
				for (let page = 0; page < maxInventoryPages; page += 1) {
					// filter param value must be: "inventoryItemAssetTypes=<ASSET_TYPE>"
					const filterValue = `inventoryItemAssetTypes=${assetType}`
					const url =
						`https://apis.roblox.com/cloud/v2/users/${userId}/inventory-items` +
						`?maxPageSize=${pageSize}` +
						`&filter=${encodeURIComponent(filterValue)}` +
						(pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")

					const invJson = await proxyGet(req, url, errors, "inventory.list", {
						userId,
						assetType,
						page,
					})
					if (!invJson) break

					const items = Array.isArray(invJson?.inventoryItems) ? invJson.inventoryItems : []
					for (const it of items) {
						const rawAssetId = it?.assetDetails?.assetId
						if (typeof rawAssetId !== "string" || rawAssetId.trim() === "") continue
						const assetId = Number(rawAssetId)
						if (Number.isFinite(assetId) && assetId > 0) {
							assetsByType[assetType].add(assetId)
						}
					}

					pageToken = getNextPageToken(invJson)
					if (!pageToken) break
				}
			}

			// -----------------------------
			// E) Catalog batch details + filtering (for sale + price > 0 + creator rules)
			// -----------------------------
			const allAssetIds = Array.from(
				new Set([
					...assetsByType.CLASSIC_TSHIRT,
					...assetsByType.CLASSIC_SHIRT,
					...assetsByType.CLASSIC_PANTS,
				])
			)

			if (allAssetIds.length > 0) {
				// assetId -> preferred inventory type key
				const assetTypeLookup = new Map()
				for (const id of assetsByType.CLASSIC_TSHIRT) assetTypeLookup.set(id, "CLASSIC_TSHIRT")
				for (const id of assetsByType.CLASSIC_SHIRT) assetTypeLookup.set(id, "CLASSIC_SHIRT")
				for (const id of assetsByType.CLASSIC_PANTS) assetTypeLookup.set(id, "CLASSIC_PANTS")

				// Cache for group owner lookups
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
							(typeof item?.name === "string" && item.name.trim() !== "" && item.name) ||
							`Asset ${assetId}`

						const creatorTargetId = item?.creatorTargetId
						const creatorTypeNorm = normalizeCatalogCreatorType(item?.creatorType)

						if (creatorTypeNorm === "User") {
							if (Number(creatorTargetId) !== userId) continue
							const typeId = invKey === "CLASSIC_TSHIRT" ? 2 : invKey === "CLASSIC_SHIRT" ? 11 : 12
							data[invKey][String(assetId)] = makeAssetEntry(name, invKey, typeId, price)
						} else if (creatorTypeNorm === "Group") {
							const groupId = Number(creatorTargetId)
							if (!Number.isFinite(groupId) || groupId <= 0) continue

							groupChecks.push(
								limiter(async () => {
									const ownerUserId = await getGroupOwner(groupId)
									if (ownerUserId === userId) {
										const typeId =
											invKey === "CLASSIC_TSHIRT" ? 2 : invKey === "CLASSIC_SHIRT" ? 11 : 12
										data[invKey][String(assetId)] = makeAssetEntry(name, invKey, typeId, price)
									}
								})
							)
						} else if (creatorTypeNorm === "Unknown") {
							// Schema mismatch / unknown enum value:
							// Try treating creatorTargetId as group first (probe), otherwise fall back to User.
							const maybeId = Number(creatorTargetId)

							if (Number.isFinite(maybeId) && maybeId > 0) {
								groupChecks.push(
									limiter(async () => {
										const ownerUserId = await getGroupOwner(maybeId)
										if (ownerUserId != null) {
											// It was a real group
											if (ownerUserId === userId) {
												const typeId =
													invKey === "CLASSIC_TSHIRT"
														? 2
														: invKey === "CLASSIC_SHIRT"
															? 11
															: 12
												data[invKey][String(assetId)] = makeAssetEntry(name, invKey, typeId, price)
											}
											return
										}

										// Not a group (or not readable) -> treat as User
										if (maybeId === userId) {
											const typeId =
												invKey === "CLASSIC_TSHIRT" ? 2 : invKey === "CLASSIC_SHIRT" ? 11 : 12
											data[invKey][String(assetId)] = makeAssetEntry(name, invKey, typeId, price)
										}
									})
								)
							}
						}
					}

					if (groupChecks.length > 0) {
						await Promise.all(groupChecks)
					}
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
