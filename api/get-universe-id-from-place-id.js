export const config = { runtime: "nodejs" };
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ROBLOX_API_HOST = "apis.roblox.com";
const ROBLOX_UNIVERSE_URL = `https://${ROBLOX_API_HOST}/universes/v1/places`;
const TIMEOUT_MS = 12000;

const sendJson = (res, status, payload) => {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
};

const normalizeCookie = (cookieRaw) => {
  if (!cookieRaw) return "";
  let value = cookieRaw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\s+/g, "");
  if (!value.includes("ROBLOSECURITY=") && !value.includes(".ROBLOSECURITY=")) {
    value = `.ROBLOSECURITY=${value}`;
  }
  return value;
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  }

  const placeParam = Array.isArray(req.query?.placeId)
    ? req.query.placeId[0]
    : req.query?.placeId;
  const placeId = Number.parseInt(placeParam, 10);
  if (!Number.isInteger(placeId) || placeId <= 0) {
    return sendJson(res, 400, { ok: false, error: "Invalid placeId" });
  }

  const headers = { Accept: "application/json" };
  const apiKey = process.env.ROBLOX_OPEN_CLOUD_KEY;
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  const cookieValue = normalizeCookie(process.env.ROBLOX_SECURITY_COOKIE);
  if (cookieValue) {
    headers.Cookie = cookieValue;
  }

  const upstreamUrl = `${ROBLOX_UNIVERSE_URL}/${placeId}/universe`;

  try {
    const { host } = new URL(upstreamUrl);
    if (host !== ROBLOX_API_HOST) {
      return sendJson(res, 500, {
        ok: false,
        error: "Invalid upstream host",
        placeId,
      });
    }
  } catch {
    return sendJson(res, 500, {
      ok: false,
      error: "Failed to construct upstream URL",
      placeId,
    });
  }

  let upstreamRes;
  try {
    upstreamRes = await fetchWithTimeout(upstreamUrl, {
      method: "GET",
      headers,
      cache: "no-store",
    });
  } catch (err) {
    const isTimeout = err && err.name === "AbortError";
    return sendJson(res, 502, {
      ok: false,
      error: isTimeout ? "Upstream request timed out" : "Upstream request failed",
      placeId,
    });
  }

  let rawBody = "";
  try {
    rawBody = await upstreamRes.text();
  } catch {
    rawBody = "";
  }

  let parsedBody;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = rawBody ? rawBody.slice(0, 500) : "";
  }

  if (!upstreamRes.ok) {
    return sendJson(res, upstreamRes.status || 502, {
      ok: false,
      error: "Upstream error",
      placeId,
      status: upstreamRes.status,
      body: parsedBody,
    });
  }

  const universeId = parsedBody && parsedBody.universeId;
  if (!universeId) {
    return sendJson(res, 502, {
      ok: false,
      error: "Missing universeId in upstream response",
      placeId,
      upstream: parsedBody,
    });
  }

  return sendJson(res, 200, {
    ok: true,
    placeId,
    universeId,
    upstream: parsedBody,
  });
}
