# Roblox Proxy (Vercel)

GET-only proxy for Roblox APIs, used by a Roblox game server via HttpService.

Usage:
GET /api/proxy?url=<url-encoded-target-url>

Safety:
- Only allows specific Roblox hosts (games.roblox.com, apis.roblox.com, etc.)
- Future: inject Open Cloud API key via environment variable for apis.roblox.com
