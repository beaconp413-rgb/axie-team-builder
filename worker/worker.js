// Axie Team Builder price store.
// GET  /prices  -> public price list {id: {price, sold}}
// PUT  /prices  -> replace the list; needs header X-Seller-Password = SELLER_PASSWORD secret
// POST /login   -> 204 if the password is right, 401 if not
// POST /sync    -> starts the GitHub wallet sync now (password; GITHUB_TOKEN secret can only run this repo's Actions)
const ORIGINS = ["https://beaconp413-rgb.github.io"];

function cors(req) {
  const o = req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Seller-Password",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

async function sameSecret(given, expected) {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given || "")),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function clean(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out = {};
  for (const [id, v] of Object.entries(body)) {
    if (!/^\d{1,12}$/.test(id) || !v || typeof v !== "object") return null;
    const price = v.price == null ? null : Math.round(Number(v.price));
    if (price != null && !(price >= 0 && price <= 100000000)) return null;
    out[id] = { price, sold: !!v.sold };
  }
  return Object.keys(out).length <= 2000 ? out : null;
}

export default {
  async fetch(req, env) {
    const h = cors(req);
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...h, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const { pathname } = new URL(req.url);

    if (pathname === "/prices" && req.method === "GET") {
      return new Response((await env.SHOP.get("prices")) || "{}", { headers: { ...h, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (pathname === "/login" && req.method === "POST") {
      return (await sameSecret(req.headers.get("X-Seller-Password"), env.SELLER_PASSWORD))
        ? new Response(null, { status: 204, headers: h }) : json({ error: "wrong password" }, 401);
    }
    if (pathname === "/sync" && req.method === "POST") {
      if (!(await sameSecret(req.headers.get("X-Seller-Password"), env.SELLER_PASSWORD))) return json({ error: "wrong password" }, 401);
      if (!env.GITHUB_TOKEN) return json({ error: "sync not set up" }, 503);
      const last = Number((await env.SHOP.get("lastSync")) || 0);
      if (Date.now() - last < 60000) return json({ ok: true, note: "already syncing" });
      const r = await fetch("https://api.github.com/repos/beaconp413-rgb/axie-team-builder/actions/workflows/sync.yml/dispatches", {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.GITHUB_TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "axie-shop-worker", "X-GitHub-Api-Version": "2022-11-28" },
        body: JSON.stringify({ ref: "main" }),
      });
      if (!r.ok) return json({ error: "github " + r.status }, 502);
      await env.SHOP.put("lastSync", String(Date.now()));
      return json({ ok: true });
    }
    if (pathname === "/prices" && req.method === "PUT") {
      if (!(await sameSecret(req.headers.get("X-Seller-Password"), env.SELLER_PASSWORD))) return json({ error: "wrong password" }, 401);
      const text = await req.text();
      if (text.length > 200000) return json({ error: "too large" }, 413);
      let body; try { body = JSON.parse(text); } catch { return json({ error: "bad json" }, 400); }
      const data = clean(body);
      if (!data) return json({ error: "bad price list" }, 400);
      await env.SHOP.put("prices", JSON.stringify(data));
      return json({ ok: true, count: Object.keys(data).length });
    }
    return json({ error: "not found" }, 404);
  },
};
