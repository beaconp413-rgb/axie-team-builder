// Axie Team Builder price store.
// GET  /prices  -> public price list {id: {price, sold}}
// PUT  /prices  -> replace the list; needs header X-Seller-Password = SELLER_PASSWORD secret
// POST /login   -> 204 if the password is right, 401 if not
// POST /sync    -> reads the wallet from the Axie API now and stores it (password)
// GET  /wallet  -> the latest wallet snapshot saved by /sync
// Checkout routes (/order, /tg, /config, /gcash-qr) live in orders.js
import { handleOrders, restock } from "./orders.js";
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

// sort is required: without it the API's paging order shifts between pages (repeats and skipped Axies)
const QUERY = `query($o:String!,$f:Int!){ axies(owner:$o, from:$f, size:100, sort: IdAsc){ total results{ id name class breedCount bodyShape
  stats{hp speed skill morale} parts{ name class type stage abilities{ id name attack defense energy description backgroundUrl } } } } }`;
// Official Sky Mavis API; the key is the Worker secret SKYMAVIS_API_KEY
async function fetchWallet(env, owner = env.LIST_WALLET) {
  const out = [];
  for (let from = 0; ; from += 100) {
    const r = await fetch("https://api-gateway.skymavis.com/graphql/axie-marketplace", {
      method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": env.SKYMAVIS_API_KEY },
      body: JSON.stringify({ query: QUERY, variables: { o: owner, f: from } }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const page = (await r.json()).data.axies;
    out.push(...page.results);
    if (from + 100 >= page.total) return out;
  }
}

function shape(raw) {
  const cards = {}, seen = new Set();
  // skip repeats and unhatched eggs (no class or parts yet)
  const axies = raw.filter(a => a.class && a.parts && a.parts.length && !seen.has(a.id) && seen.add(a.id)).map(a => ({
    id: a.id, name: (a.name || "").trim() || "Axie #" + a.id, cls: a.class, breeds: a.breedCount, shape: a.bodyShape, stats: a.stats,
    parts: a.parts.map(p => {
      const ab = p.abilities && p.abilities[0];
      if (ab) cards[ab.id] = { n: ab.name, a: ab.attack, d: ab.defense, e: ab.energy, t: ab.description, img: ab.backgroundUrl };
      return [p.type, p.name, p.class, p.stage, ab ? ab.id : null];
    }),
  }));
  return { axies, cards };
}

export default {
  async fetch(req, env, ctx) {
    const h = cors(req);
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...h, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);
    // "/store/..." = the separate Axie Store site (store wallet, its own prices); everything else = the original shop
    const store = url.pathname.startsWith("/store/");
    const pathname = store ? url.pathname.slice(6) : url.pathname;
    const K = store ? { prices: "store-prices", wallet: "store-wallet", owner: env.STORE_WALLET } : { prices: "prices", wallet: "wallet", owner: env.LIST_WALLET };
    const orderRes = await handleOrders(req, env, ctx, json, r => sameSecret(r.headers.get("X-Seller-Password"), env.SELLER_PASSWORD));
    if (orderRes) return orderRes;

    if (pathname === "/prices" && req.method === "GET") {
      return new Response((await env.SHOP.get(K.prices)) || "{}", { headers: { ...h, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (pathname === "/login" && req.method === "POST") {
      return (await sameSecret(req.headers.get("X-Seller-Password"), env.SELLER_PASSWORD))
        ? new Response(null, { status: 204, headers: h }) : json({ error: "wrong password" }, 401);
    }
    if (pathname === "/wallet" && req.method === "GET") {
      return new Response((await env.SHOP.get(K.wallet)) || "{}", { headers: { ...h, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    // test mode only: the store wallet's Axies, so #test links can order them before go-live
    if (pathname === "/store-axies" && req.method === "GET" && env.CHECKOUT === "test") {
      try { return json(shape(await fetchWallet(env, env.STORE_WALLET))); } catch (e) { return json({ error: e.message }, 502); }
    }
    if (pathname === "/sync" && req.method === "POST") {
      if (!(await sameSecret(req.headers.get("X-Seller-Password"), env.SELLER_PASSWORD))) return json({ error: "wrong password" }, 401);
      const prev = JSON.parse((await env.SHOP.get(K.wallet)) || "{}");
      if (prev.syncedAt && Date.now() - Date.parse(prev.syncedAt) < 30000) return json({ ok: true, count: prev.axies.length, note: "just synced" });
      let raw;
      try { raw = await fetchWallet(env, K.owner); } catch (e) { return json({ error: "axie api: " + e.message }, 502); }
      if (!raw.length && !store) return json({ error: "axie api returned no axies" }, 502);
      const { axies, cards } = shape(raw);
      const wallet = { syncedAt: new Date().toISOString(), axies, cards };
      await env.SHOP.put(K.wallet, JSON.stringify(wallet));
      const restocked = store ? await restock(env, axies) : 0;
      return json({ ok: true, count: axies.length, restocked });
    }
    if (pathname === "/prices" && req.method === "PUT") {
      if (!(await sameSecret(req.headers.get("X-Seller-Password"), env.SELLER_PASSWORD))) return json({ error: "wrong password" }, 401);
      const text = await req.text();
      if (text.length > 200000) return json({ error: "too large" }, 413);
      let body; try { body = JSON.parse(text); } catch { return json({ error: "bad json" }, 400); }
      const data = clean(body);
      if (!data) return json({ error: "bad price list" }, 400);
      await env.SHOP.put(K.prices, JSON.stringify(data));
      return json({ ok: true, count: Object.keys(data).length });
    }
    return json({ error: "not found" }, 404);
  },
  // every 15 minutes: refresh the Axie Store's wallet snapshot (the original shop keeps its GitHub sync)
  async scheduled(event, env) {
    const { axies, cards } = shape(await fetchWallet(env, env.STORE_WALLET));
    await env.SHOP.put("store-wallet", JSON.stringify({ syncedAt: new Date().toISOString(), axies, cards }));
    await restock(env, axies);
  },
};
