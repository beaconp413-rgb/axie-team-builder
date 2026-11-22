// Checkout: buyer orders -> pays GCash -> types the reference number -> the seller checks GCash and taps
// Approve in Telegram -> this Worker sends the Axies from the store wallet to the buyer's Ronin address.
//
// POST /order               {ids, ronin, name}  -> creates an order and holds the Axies for PAY_MINUTES
// GET  /order/<code>        -> order status (the buyer's page polls this)
// POST /order/<code>/paid   {ref}  -> buyer's GCash reference number; sends the seller a Telegram Approve/Reject message
// GET  /gcash-qr            -> the seller's GCash QR image (KV "gcash-qr")
// GET  /config              -> {checkout, test}; CHECKOUT var: "off" | "test" (only #test links show it) | "on"
// POST /tg                  -> Telegram webhook (button taps); only TG_CHAT_ID may approve
// POST /tg-setup            -> registers the webhook (seller password)
//
// Nothing here trusts the buyer: prices come from KV, ownership from the chain, and the payment is confirmed
// only by the seller's own tap, sent from the seller's own Telegram account.
import { privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi } from "viem";

const RPC = "https://api.roninchain.com/rpc";
const AXIE = "0x32950db2a7164ae833121501c797d79e7b79d74c";
const ABI = parseAbi(["function safeTransferFrom(address from, address to, uint256 tokenId)"]);
const PAY_MINUTES = 30;          // time to pay and enter the reference number
const CHECK_HOURS = 72;          // how long Axies stay held while the seller checks a payment
const CODE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const peso = n => "₱" + Math.round(n).toLocaleString("en-PH");
const html = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const phDay = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

async function rpc(method, params) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message || "rpc error"), { rpc: true });
      return j.result;
    } catch (e) {
      if (e.rpc || i >= 2) throw e;
      await sleep(600 * (i + 1));
    }
  }
}
async function ownerOf(id) {
  const res = await rpc("eth_call", [{ to: AXIE, data: "0x6352211e" + BigInt(id).toString(16).padStart(64, "0") }, "latest"]);
  return "0x" + res.slice(-40).toLowerCase();
}

export function normalizeRonin(s) {
  const v = String(s || "").trim().replace(/^ronin:/i, "0x");
  return /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v) ? v.toLowerCase() : null;
}

const getJson = async (env, key, dflt) => { const v = await env.SHOP.get(key); return v ? JSON.parse(v) : dflt; };
const saveOrder = (env, o) => env.SHOP.put("order:" + o.code, JSON.stringify(o), { expirationTtl: 180 * 86400 });

async function releaseHolds(env, code) {
  const holds = await getJson(env, "holds", {});
  for (const [id, h] of Object.entries(holds)) if (h.code === code) delete holds[id];
  await env.SHOP.put("holds", JSON.stringify(holds));
}
async function setHolds(env, ids, code, until) {
  const holds = await getJson(env, "holds", {}), now = Date.now();
  for (const [id, h] of Object.entries(holds)) if (h.until < now) delete holds[id];
  for (const id of ids) holds[id] = { code, until };
  await env.SHOP.put("holds", JSON.stringify(holds));
}

// Unpaid orders expire; sent orders get their transactions confirmed on read.
async function refresh(env, o) {
  if (o.status === "awaiting_payment" && Date.now() > o.payBy) {
    o.status = "expired"; await saveOrder(env, o); await releaseHolds(env, o.code);
  }
  if (o.status === "sent" && !o.confirmed) {
    try {
      let all = true;
      for (const t of Object.values(o.txs || {})) {
        if (t.ok) continue;
        const rc = await rpc("eth_getTransactionReceipt", [t.hash]);
        if (!rc) { all = false; continue; }
        if (rc.status === "0x1") t.ok = true;
        else { o.status = "problem"; o.note = "A transfer failed on the blockchain."; all = false; }
      }
      if (all && o.status === "sent") o.confirmed = true;
      await saveOrder(env, o);
    } catch { /* try again on the next read */ }
  }
  return o;
}

function publicOrder(o, gcash) {
  const out = { code: o.code, status: o.status, items: o.items, total: o.total, ronin: o.ronin, name: o.name,
    payBy: o.payBy, ref: o.ref || null, txs: o.txs || {}, confirmed: !!o.confirmed, createdAt: o.createdAt };
  if (o.status === "awaiting_payment" && gcash) out.gcash = { name: gcash.name, number: gcash.number, qr: !!gcash.qr };
  return out;
}

async function createOrder(req, env) {
  if (env.CHECKOUT !== "on" && env.CHECKOUT !== "test") return [403, { error: "Checkout is closed right now. Tap Copy order and message me instead." }];
  let body; try { body = await req.json(); } catch { return [400, { error: "Bad request." }]; }
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = "rl:" + ip, tries = +(await env.SHOP.get(rlKey) || 0);
  if (tries >= 6) return [429, { error: "Too many orders from your connection. Try again in an hour, or message me." }];

  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
  if (!ids.length || ids.length > 3 || !ids.every(id => /^\d{1,12}$/.test(id))) return [400, { error: "Pick 1 to 3 Axies first." }];
  const ronin = normalizeRonin(body.ronin);
  if (!ronin) return [400, { error: "That Ronin address doesn't look right. It starts with ronin: or 0x, followed by 40 letters and numbers." }];
  if (ronin === env.STORE_WALLET.toLowerCase() || ronin === env.LIST_WALLET.toLowerCase()) return [400, { error: "Enter your own Ronin address." }];
  const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) return [400, { error: "Enter your Facebook name so I know who you are." }];

  const prices = await getJson(env, "prices", {});
  const wallet = await getJson(env, "wallet", {});
  const names = Object.fromEntries((wallet.axies || []).map(a => [a.id, a.name]));
  const items = [];
  for (const id of ids) {
    const p = prices[id];
    if (!p || !(p.price > 0) || p.sold) return [409, { error: `Axie #${id} isn't for sale anymore. Refresh the page.`, unavailable: [id] }];
    items.push({ id, name: names[id] || "Axie #" + id, price: p.price });
  }
  const holds = await getJson(env, "holds", {}), now = Date.now();
  const held = ids.filter(id => holds[id] && holds[id].until > now);
  if (held.length) return [409, { error: `Someone is already buying ${held.map(i => "#" + i).join(", ")}. Pick another Axie, or try again in 30 minutes.`, unavailable: held }];
  let owners;
  try { owners = await Promise.all(ids.map(ownerOf)); } catch { return [503, { error: "Couldn't reach the Ronin network. Try again in a minute." }]; }
  const gone = ids.filter((id, i) => owners[i] !== env.STORE_WALLET.toLowerCase());
  if (gone.length) return [409, { error: `${gone.map(i => "#" + i).join(", ")} can't be bought with checkout right now. Tap Copy order and message me.`, unavailable: gone }];

  let code;
  do { code = [...crypto.getRandomValues(new Uint8Array(8))].map(b => CODE_ABC[b % CODE_ABC.length]).join(""); }
  while (await env.SHOP.get("order:" + code));
  const o = { code, status: "awaiting_payment", items, total: items.reduce((s, i) => s + i.price, 0), ronin, name,
    createdAt: now, payBy: now + PAY_MINUTES * 60e3, ip };
  await saveOrder(env, o);
  await setHolds(env, ids, code, o.payBy);
  await env.SHOP.put(rlKey, String(tries + 1), { expirationTtl: 3600 });
  return [200, publicOrder(o, await getJson(env, "gcash", null))];
}

async function markPaid(req, env, o) {
  if (o.status !== "awaiting_payment") return [409, { error: "This order can't take a payment anymore.", order: publicOrder(o) }];
  let body; try { body = await req.json(); } catch { return [400, { error: "Bad request." }]; }
  const ref = String(body.ref || "").replace(/\D/g, "");
  if (ref.length < 10 || ref.length > 16) return [400, { error: "Type the reference number from your GCash receipt (13 digits)." }];
  if (await env.SHOP.get("ref:" + ref)) return [409, { error: "This reference number was already used for another order. Message me if this is a mistake." }];
  await env.SHOP.put("ref:" + ref, o.code, { expirationTtl: 365 * 86400 });
  o.status = "checking"; o.ref = ref; o.paidAt = Date.now();
  await saveOrder(env, o);
  await setHolds(env, o.items.map(i => i.id), o.code, Date.now() + CHECK_HOURS * 3600e3);
  try {
    const m = await tg(env, "sendMessage", { chat_id: env.TG_CHAT_ID, text: tgText(o), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: tgButtons(o) });
    o.tg = { chat: m.chat.id, msg: m.message_id }; await saveOrder(env, o);
  } catch (e) { o.tgError = String(e.message || e); await saveOrder(env, o); }
  return [200, publicOrder(o)];
}

/* ---------- Telegram ---------- */
async function tg(env, method, payload) {
  if (!env.TG_TOKEN) throw new Error("TG_TOKEN not set");
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || "telegram error");
  return j.result;
}
const short = a => a.slice(0, 8) + "…" + a.slice(-6);
const txLink = h => `https://app.roninchain.com/tx/${h}`;
function tgText(o) {
  const head = {
    checking: "🛒 <b>New order — check your GCash</b>",
    sending: "⏳ <b>Sending Axies…</b>",
    sent: "✅ <b>Sent</b>",
    rejected: "❌ <b>Rejected</b> — Axies are back on sale",
    problem: "⚠️ <b>Problem sending</b>",
  }[o.status] || o.status;
  const lines = [
    head, "",
    `Order <code>${o.code}</code> · <b>${peso(o.total)}</b>`,
    `Buyer: ${html(o.name)}`,
    `GCash ref: <code>${o.ref}</code>`,
    ...o.items.map(i => `• #${i.id} ${html(i.name)} — ${peso(i.price)}`),
    `Send to: <code>${o.ronin}</code>`,
  ];
  if (o.status === "checking") lines.push("", `👉 Open GCash. Did you receive <b>${peso(o.total)}</b> with ref <b>${o.ref}</b>? Only then tap Approve.`);
  if (o.status === "sent") lines.push("", ...Object.entries(o.txs || {}).map(([id, t]) => `#${id}: <a href="${txLink(t.hash)}">transaction</a>`));
  if (o.status === "problem") lines.push("", "Error: " + html(o.note || "unknown"), ...Object.entries(o.txs || {}).map(([id, t]) => `#${id} sent: <a href="${txLink(t.hash)}">transaction</a>`), "Tap Retry to send what's left, or message the buyer.");
  return lines.join("\n");
}
function tgButtons(o, confirm) {
  if (o.status === "checking" && confirm) return { inline_keyboard: [[{ text: `✅ Yes, send to ${short(o.ronin)}`, callback_data: "send:" + o.code }], [{ text: "↩️ Back", callback_data: "back:" + o.code }]] };
  if (o.status === "checking") return { inline_keyboard: [[{ text: "✅ Approve", callback_data: "ok:" + o.code }, { text: "❌ Reject", callback_data: "no:" + o.code }]] };
  if (o.status === "problem") return { inline_keyboard: [[{ text: "🔁 Retry", callback_data: "send:" + o.code }]] };
  return { inline_keyboard: [] };
}
async function tgShow(env, o, confirm) {
  if (!o.tg) return;
  try { await tg(env, "editMessageText", { chat_id: o.tg.chat, message_id: o.tg.msg, text: tgText(o), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: tgButtons(o, confirm) }); } catch { /* message unchanged */ }
}

async function onTelegram(req, env, ctx) {
  if (!env.TG_SECRET || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_SECRET) return new Response("no", { status: 401 });
  const u = await req.json();
  if (u.message) {
    // lets the seller find their chat ID during setup; harmless for anyone else
    if (/^\/(start|id)\b/.test(u.message.text || "")) await tg(env, "sendMessage", { chat_id: u.message.chat.id, text: `Your chat ID is ${u.message.chat.id}` }).catch(() => {});
    return new Response("ok");
  }
  const cq = u.callback_query;
  if (!cq) return new Response("ok");
  const answer = text => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});
  if (!env.TG_CHAT_ID || String(cq.from.id) !== String(env.TG_CHAT_ID)) { await answer("Not allowed."); return new Response("ok"); }
  const [act, code] = String(cq.data || "").split(":");
  const o = await getJson(env, "order:" + code, null);
  if (!o) { await answer("Order not found."); return new Response("ok"); }
  if (!o.tg && cq.message) o.tg = { chat: cq.message.chat.id, msg: cq.message.message_id };

  if (act === "ok" || act === "back") {
    if (o.status !== "checking") { await answer("Already handled."); await tgShow(env, o); return new Response("ok"); }
    await tgShow(env, o, act === "ok"); await answer(act === "ok" ? "Check the address, then confirm." : "");
  } else if (act === "no") {
    if (o.status !== "checking") { await answer("Already handled."); return new Response("ok"); }
    o.status = "rejected"; o.closedAt = Date.now(); await saveOrder(env, o); await releaseHolds(env, o.code);
    await tgShow(env, o); await answer("Rejected.");
  } else if (act === "send") {
    if (o.status !== "checking" && o.status !== "problem") { await answer("Already handled."); await tgShow(env, o); return new Response("ok"); }
    const day = "sent:" + phDay(), count = +(await env.SHOP.get(day) || 0);
    if (o.status === "checking" && count >= +(env.MAX_SENT_PER_DAY || 20)) { await answer(`Daily limit reached (${count} orders). Change MAX_SENT_PER_DAY to send more.`); return new Response("ok"); }
    o.status = "sending"; o.approvedAt = Date.now(); await saveOrder(env, o);
    await tgShow(env, o); await answer("Sending…");
    ctx.waitUntil(deliver(env, o, o.txs ? count : count + 1));
  } else await answer("");
  return new Response("ok");
}

/* ---------- sending the Axies ---------- */
async function deliver(env, o, dayCount) {
  try {
    const key = (env.STORE_WALLET_KEY || "").trim();
    if (!key) throw new Error("The store wallet key isn't set up yet.");
    const account = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);
    const from = account.address.toLowerCase();
    if (from !== env.STORE_WALLET.toLowerCase()) throw new Error("The wallet key doesn't match STORE_WALLET.");
    let nonce = parseInt(await rpc("eth_getTransactionCount", [from, "pending"]), 16);
    const gasPrice = BigInt(await rpc("eth_gasPrice", []));
    o.txs = o.txs || {};
    for (const it of o.items) {
      const owner = await ownerOf(it.id);
      if (owner === o.ronin) { if (!o.txs[it.id]) o.txs[it.id] = { hash: null, ok: true, note: "already with buyer" }; continue; }
      if (owner !== from) throw new Error(`#${it.id} isn't in the store wallet anymore.`);
      const data = encodeFunctionData({ abi: ABI, functionName: "safeTransferFrom", args: [from, o.ronin, BigInt(it.id)] });
      // estimateGas also simulates the transfer: if it would fail, nothing is sent
      const gas = BigInt(await rpc("eth_estimateGas", [{ from, to: AXIE, data }])) * 13n / 10n;
      const signed = await account.signTransaction({ chainId: 2020, nonce, to: AXIE, data, gas, gasPrice, type: "legacy" });
      const hash = await rpc("eth_sendRawTransaction", [signed]);
      nonce++;
      o.txs[it.id] = { hash, ok: false };
      await saveOrder(env, o);
    }
    o.status = "sent"; o.note = null; o.sentAt = Date.now();
    // wait briefly for confirmations; anything not yet confirmed is checked when the order is next read
    for (let i = 0; i < 6 && Object.values(o.txs).some(t => !t.ok); i++) { await sleep(2500); await refresh(env, o); }
    await saveOrder(env, o);
    if (o.status === "sent") {
      const prices = await getJson(env, "prices", {});
      for (const it of o.items) if (prices[it.id]) prices[it.id].sold = true;
      await env.SHOP.put("prices", JSON.stringify(prices));
      await releaseHolds(env, o.code);
      await env.SHOP.put("sent:" + phDay(), String(dayCount), { expirationTtl: 3 * 86400 });
    }
  } catch (e) {
    o.status = "problem"; o.note = String(e.shortMessage || e.message || e).slice(0, 300);
    await saveOrder(env, o);
  }
  await tgShow(env, o);
}

/* ---------- router ---------- */
export async function handleOrders(req, env, ctx, json, checkPw) {
  const { pathname } = new URL(req.url);
  if (pathname === "/config" && req.method === "GET") return json({ checkout: env.CHECKOUT === "on", test: env.CHECKOUT === "test" });
  if (pathname === "/order" && req.method === "POST") { const [s, b] = await createOrder(req, env); return json(b, s); }
  const m = pathname.match(/^\/order\/([A-Z2-9]{8})(\/paid)?$/);
  if (m) {
    const o = await getJson(env, "order:" + m[1], null);
    if (!o) return json({ error: "Order not found." }, 404);
    await refresh(env, o);
    if (m[2] && req.method === "POST") { const [s, b] = await markPaid(req, env, o); return json(b, s); }
    if (!m[2] && req.method === "GET") return json(publicOrder(o, await getJson(env, "gcash", null)));
  }
  if (pathname === "/gcash-qr" && req.method === "GET") {
    const img = await env.SHOP.get("gcash-qr", "arrayBuffer");
    return img ? new Response(img, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=600" } }) : json({ error: "no qr" }, 404);
  }
  if (pathname === "/tg" && req.method === "POST") return onTelegram(req, env, ctx);
  if (pathname === "/tg-setup" && req.method === "POST") {
    if (!(await checkPw(req))) return json({ error: "wrong password" }, 401);
    const url = new URL(req.url); url.pathname = "/tg";
    try {
      await tg(env, "setWebhook", { url: url.toString(), secret_token: env.TG_SECRET, allowed_updates: ["message", "callback_query"] });
      return json({ ok: true });
    } catch (e) { return json({ error: e.message }, 502); }
  }
  return null;
}
