// Shop dashboard data for the Axie Store: live viewers, visits and orders.
// Everything lives in one Durable Object ("Insights", SQLite) so frequent heartbeats don't use up KV's daily write limit.
// Privacy: no IP addresses are stored, only Cloudflare's city/region/country guess, device type and a random per-tab id.
//
// POST /beat            (public)   {sid, page, seller}  -> the store page says "I'm here" every 30 s
// GET  /admin/stats     (password) -> live viewers, visitors, orders, sales
import { DurableObject } from "cloudflare:workers";

const LIVE_MS = 75 * 1000;
const phMidnight = (daysAgo = 0) => { const d = new Date(Date.now() + 8 * 3600e3); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 8 * 3600e3 - daysAgo * 86400e3; };
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

export class Insights extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, first INTEGER, last INTEGER, city TEXT, region TEXT, country TEXT,
      device TEXT, page TEXT, ref TEXT, seller INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orders (code TEXT PRIMARY KEY, status TEXT, name TEXT, total INTEGER, items TEXT, ronin TEXT,
      created INTEGER, updated INTEGER, city TEXT, country TEXT, reason TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  }
  beat(b) {
    const now = Date.now();
    this.sql.exec(`INSERT INTO sessions (sid, first, last, city, region, country, device, page, ref, seller) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sid) DO UPDATE SET last = excluded.last, page = excluded.page, seller = MAX(sessions.seller, excluded.seller)`,
      b.sid, now, now, b.city, b.region, b.country, b.device, b.page, b.ref, b.seller ? 1 : 0);
    if (Math.random() < 0.01) this.sql.exec(`DELETE FROM sessions WHERE last < ?`, now - 60 * 86400e3);
  }
  order(o) {
    this.sql.exec(`INSERT INTO orders (code, status, name, total, items, ronin, created, updated, city, country, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET status = excluded.status, name = excluded.name, updated = excluded.updated, reason = excluded.reason`,
      o.code, o.status, o.name || "", o.total || 0, JSON.stringify((o.items || []).map(i => ({ id: i.id, name: i.name, price: i.price }))), o.ronin || "",
      o.createdAt || Date.now(), Date.now(), o.city || "", o.country || "", o.reason || "");
  }
  isBackfilled() { return this.sql.exec(`SELECT v FROM meta WHERE k = 'backfilled'`).toArray().length > 0; }
  markBackfilled() { this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('backfilled', '1')`); }
  stats() {
    const now = Date.now(), today = phMidnight(), week = phMidnight(6);
    const all = q => this.sql.exec(q[0], ...q.slice(1)).toArray();
    const live = all([`SELECT sid, first, last, city, region, country, device, page, ref, seller FROM sessions WHERE last > ? ORDER BY first DESC`, now - LIVE_MS]);
    const visitorsToday = all([`SELECT COUNT(*) AS n FROM sessions WHERE first >= ? AND seller = 0`, today])[0].n;
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const from = phMidnight(i), to = from + 86400e3;
      const v = all([`SELECT COUNT(*) AS n FROM sessions WHERE first >= ? AND first < ? AND seller = 0`, from, to])[0].n;
      const s = all([`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS p FROM orders WHERE status = 'sent' AND created >= ? AND created < ?`, from, to])[0];
      days.push({ day: new Date(from + 8 * 3600e3).toISOString().slice(0, 10), visitors: v, sold: s.n, sales: s.p });
    }
    const cities = all([`SELECT city, region, country, COUNT(*) AS n FROM sessions WHERE first >= ? AND seller = 0 GROUP BY city, region, country ORDER BY n DESC LIMIT 10`, week]);
    const recent = all([`SELECT sid, first, last, city, region, country, device, page, ref, seller FROM sessions WHERE seller = 0 ORDER BY first DESC LIMIT 25`]);
    const orders = all([`SELECT * FROM orders ORDER BY created DESC LIMIT 60`]).map(o => ({ ...o, items: JSON.parse(o.items || "[]") }));
    const ordersToday = orders.filter(o => o.created >= today);
    return {
      now, live, visitorsToday, days, cities, recent, orders,
      ordersToday: ordersToday.length,
      salesToday: ordersToday.filter(o => o.status === "sent").reduce((s, o) => s + o.total, 0),
      waiting: orders.filter(o => o.status === "checking").length,
    };
  }
}

const stub = env => env.INSIGHTS.get(env.INSIGHTS.idFromName("axie-store"));

// Called whenever an order is saved (best effort: the dashboard must never break checkout).
export async function trackOrder(env, o) {
  if (!env.INSIGHTS) return;
  try { await stub(env).order(o); } catch { /* dashboard only */ }
}

export async function handleInsights(req, env, ctx, json, checkPw) {
  const { pathname } = new URL(req.url);
  if (pathname === "/beat" && req.method === "POST") {
    const ua = req.headers.get("User-Agent") || "";
    if (/bot|crawl|spider|headless|preview|facebookexternalhit/i.test(ua)) return json({ ok: true });
    let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!/^[a-z0-9]{8,24}$/.test(String(b.sid || ""))) return json({ error: "bad sid" }, 400);
    const cf = req.cf || {};
    await stub(env).beat({
      sid: b.sid, page: clip(b.page, 60), ref: clip(b.ref, 80), seller: !!b.seller,
      city: clip(cf.city || "", 60), region: clip(cf.region || "", 60), country: clip(cf.country || "", 4),
      device: /iPad|Tablet/i.test(ua) ? "Tablet" : /Mobi|Android|iPhone/i.test(ua) ? "Phone" : "Computer",
    });
    return json({ ok: true });
  }
  if (pathname === "/admin/stats" && req.method === "GET") {
    if (!(await checkPw(req))) return json({ error: "wrong password" }, 401);
    const s = stub(env);
    if (!(await s.isBackfilled())) {
      // one time: copy orders placed before the dashboard existed
      for (const k of (await env.SHOP.list({ prefix: "order:" })).keys) {
        const v = await env.SHOP.get(k.name); if (v) await s.order(JSON.parse(v));
      }
      await s.markBackfilled();
    }
    const out = await s.stats();
    out.shopClosed = !!(await env.SHOP.get("shop-closed"));
    return json(out);
  }
  return null;
}
