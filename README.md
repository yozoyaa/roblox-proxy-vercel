# Roblox Cloud API Gateway (Vercel)

This repo is a small **Vercel Serverless “gateway”** focused on making **GET + POST** calls to Roblox Cloud / Roblox web APIs safely from your backend.

Right now it includes:
- `GET /api/fetch-url` → a safe allowlisted Roblox **GET proxy**
- `GET /api/get-donation-asset` → builds a donation asset list (gamepasses + classic clothing)

The **`/api` folder is intended to grow** — you can add more endpoints later and reuse the same proxy + auth approach.

---

## Why this repo exists

Roblox APIs often require:
- Open Cloud auth (`x-api-key`)
- Roblox cookie auth (`.ROBLOSECURITY=...`)
- CSRF handling for POST requests (`x-csrf-token` negotiation)

This repo centralizes that logic so your game/client code can call a single backend endpoint that handles auth, pagination, filtering, and rate-limit-friendly concurrency.

---

## Deployment

1. Deploy to Vercel (import this repo)
2. Add environment variables (Project → Settings → Environment Variables)

### Required
- `ROBLOX_OPEN_CLOUD_KEY`  
  Roblox Open Cloud API key (value only)

- `ROBLOX_SECURITY_COOKIE`  
  Roblox cookie (either token only OR full `.ROBLOSECURITY=...`)

The proxy normalizes the cookie:
- If you provide only the token, it becomes `.ROBLOSECURITY=<token>`
- Quotes/whitespace are removed to avoid parsing issues

---

## API Endpoints

## 1) `GET /api/fetch-url`

**File:** `api/fetch-url.js`  
**Purpose:** Safe allowlisted proxy for Roblox **GET** requests.

### How it works
- Accepts: `?url=<encodedURL>`
- Validates the URL host against `ALLOWED_HOSTS` (prevents SSRF)
- Always sends auth headers when available:
  - `x-api-key` (Open Cloud key)
  - `cookie: .ROBLOSECURITY=...` (Roblox cookie)
- Returns status `200` with a JSON envelope (includes upstream status/body)

### Allowed domains (host allowlist)

This proxy only allows requests to known Roblox domains:

- apis.roblox.com  
- accountinformation.roblox.com  
- accountsettings.roblox.com  
- adconfiguration.roblox.com  
- assetdelivery.roblox.com  
- auth.roblox.com  
- avatar.roblox.com  
- badges.roblox.com  
- catalog.roblox.com  
- clientsettings.roblox.com  
- contacts.roblox.com  
- develop.roblox.com  
- economy.roblox.com  
- economycreatorstats.roblox.com  
- engagementpayouts.roblox.com  
- followings.roblox.com  
- friends.roblox.com  
- gameinternationalization.roblox.com  
- games.roblox.com  
- groups.roblox.com  
- inventory.roblox.com  
- itemconfiguration.roblox.com  
- locale.roblox.com  
- localizationtables.roblox.com  
- notifications.roblox.com  
- premiumfeatures.roblox.com  
- presence.roblox.com  
- privatemessages.roblox.com  
- publish.roblox.com  
- thumbnails.roblox.com  
- thumbnailsresizer.roblox.com  
- users.roblox.com  

> To add more Roblox domains later, update `ALLOWED_HOSTS` in `api/fetch-url.js`.

### Response format (always JSON)
```json
{
  "ok": true,
  "upstreamStatus": 200,
  "upstreamContentType": "application/json",
  "json": {},
  "text": "",
  "authSent": {
    "tried": ["apiKey", "cookie"],
    "cookieLen": 1234,
    "apiKeyLen": 40
  }
}
