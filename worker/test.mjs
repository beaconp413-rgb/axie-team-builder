// Checkout flow test with a fake blockchain, fake Telegram and in-memory KV. Nothing real is sent.
// Run: npm test   (in /worker)
import { handleOrders, normalizeRonin } from "./orders.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseTransaction, recoverTransactionAddress, decodeFunctionData, parseAbi } from "viem";

const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok -", m); };
const key = generatePrivateKey(), store = privateKeyToAccount(key).address.toLowerCase();
const buyer = "0x" + "ab".repeat(20), SELLER = 5550001;
const kv = new Map();
const env = {
  SHOP: { get: async k => kv.has(k) ? kv.get(k) : null, put: async (k, v) => { kv.set(k, v); }, delete: async k => { kv.delete(k); },
    getWithMetadata: async k => ({ value: kv.get(k) || null, metadata: { type: "image/png" } }),
    list: async ({ prefix }) => ({ keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }) },
  CHECKOUT: "on", STORE_WALLET: store, LIST_WALLET: "0xe8a963a82a739e18319b89ac5d85971b0808a108", MAX_SENT_PER_DAY: "20",
  STORE_WALLET_KEY: key, TG_TOKEN: "x", TG_CHAT_ID: String(SELLER), TG_SECRET: "sec",
};
kv.set("store-prices", JSON.stringify({ "111": { price: 500, sold: false }, "222": { price: 300, sold: false }, "333": { price: 0, sold: false } }));
kv.set("gcash", JSON.stringify({ name: "M. K.", number: "09170000000", qr: true }));
const owners = { "111": store, "222": store }, sent = [], tgCalls = [];
globalThis.fetch = async (url, init) => {
  const res = r => ({ json: async () => r });
  if (url.includes("telegram")) {
    const b = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, k === "reply_markup" ? JSON.parse(v) : v])) : JSON.parse(init.body);
    tgCalls.push([url.split("/").pop(), b]); return res({ ok: true, result: { chat: { id: SELLER }, message_id: 42 } });
  }
  const b = JSON.parse(init.body);
  if (b.method === "eth_call") { const id = BigInt("0x" + b.params[0].data.slice(10)).toString(); return res({ result: "0x" + (owners[id] || "0x" + "00".repeat(20)).slice(2).padStart(64, "0") }); }
  if (b.method === "eth_getTransactionCount") return res({ result: "0x7" });
  if (b.method === "eth_gasPrice") return res({ result: "0x4e3b29200" });
  if (b.method === "eth_estimateGas") return res({ result: "0x186a0" });
  if (b.method === "eth_sendRawTransaction") { sent.push(b.params[0]); return res({ result: "0x" + String(sent.length).padStart(64, "0") }); }
  if (b.method === "eth_getTransactionReceipt") return res({ result: { status: "0x1" } });
  throw new Error("unexpected " + url + " " + b.method);
};
const json = (d, s = 200) => ({ status: s, body: d });
const waits = [], ctx = { waitUntil: p => waits.push(p) };
const call = (method, path, body) => handleOrders({ method, url: "https://w.dev" + path, headers: new Headers({ "CF-Connecting-IP": "1.1.1.1" }), json: async () => body,
  formData: async () => { const f = new FormData(); if (body && body.file) f.append("receipt", body.file); return f; } }, env, ctx, json, async () => false);
const shot = (type = "image/png", size = 2000) => ({ file: new File([new Uint8Array(size)], "r.png", { type }) });
const tap = (data, from = SELLER, secret = "sec") => handleOrders({ method: "POST", url: "https://w.dev/tg", headers: new Headers({ "X-Telegram-Bot-Api-Secret-Token": secret }),
  json: async () => ({ callback_query: { id: "q", from: { id: from }, data, message: { chat: { id: SELLER }, message_id: 42 } } }) }, env, ctx, json, async () => false);
const lastEdit = () => tgCalls.filter(c => c[0].startsWith("editMessage")).at(-1)[1];
const order = c => JSON.parse(kv.get("order:" + c));

assert(normalizeRonin("ronin:" + "AB".repeat(20)) === buyer, "ronin: address normalized");
assert(normalizeRonin("0x123") === null, "short address rejected");
let r = await call("POST", "/order", { ids: ["333"], ronin: buyer, name: "Juan" }); assert(r.status === 409, "unpriced Axie refused");
r = await call("POST", "/order", { ids: ["111"], ronin: store, name: "Juan" }); assert(r.status === 400, "store wallet as buyer refused");
r = await call("POST", "/order", { ids: ["111", "222"], ronin: "ronin:" + "ab".repeat(20), name: "Juan Dela Cruz", total: 1 });
assert(r.status === 200 && r.body.total === 800 && r.body.gcash.number, "order created, total 800 from server prices, GCash info shown");
const code = r.body.code;
r = await call("POST", "/order", { ids: ["222"], ronin: buyer, name: "Pedro" }); assert(r.status === 409, "held Axie can't be ordered by someone else");
r = await call("POST", `/order/${code}/paid`, {}); assert(r.status === 400, "no screenshot refused");
r = await call("POST", `/order/${code}/paid`, shot("application/pdf")); assert(r.status === 400, "non-image refused");
r = await call("POST", `/order/${code}/paid`, shot("image/png", 6 * 1024 * 1024)); assert(r.status === 413, "huge image refused");
r = await call("POST", `/order/${code}/paid`, shot()); assert(r.status === 200 && r.body.status === "checking", "screenshot accepted -> checking");
assert(tgCalls.at(-1)[0] === "sendPhoto" && tgCalls.at(-1)[1].caption.includes("₱800") && tgCalls.at(-1)[1].caption.includes("Juan Dela Cruz") && tgCalls.at(-1)[1].photo, "seller got the screenshot in Telegram with ₱800 and buttons");
assert(kv.get("receipt:" + code), "receipt copy kept");

r = await tap("send:" + code, SELLER, "wrong"); assert(r.status === 401, "webhook with wrong secret refused");
await tap("send:" + code, 999); assert(sent.length === 0 && order(code).status === "checking", "stranger's tap ignored");
await tap("ok:" + code); assert(sent.length === 0 && lastEdit().reply_markup.inline_keyboard[0][0].text.startsWith("✅ Yes"), "Approve asks to confirm first, nothing sent");
await tap("send:" + code); await Promise.all(waits);
assert(sent.length === 2 && order(code).status === "sent", "confirm -> 2 transfers sent, status sent");
{ const tx = parseTransaction(sent[0]); const d = decodeFunctionData({ abi: parseAbi(["function safeTransferFrom(address,address,uint256)"]), data: tx.data });
  assert(tx.to === "0x32950db2a7164ae833121501c797d79e7b79d74c" && tx.chainId === 2020 && (await recoverTransactionAddress({ serializedTransaction: sent[0] })).toLowerCase() === store
    && d.args[0].toLowerCase() === store && d.args[1].toLowerCase() === buyer && d.args[2] === 111n, "signed tx: Axie contract, Ronin chain 2020, store -> buyer, Axie #111"); }
assert(JSON.parse(kv.get("store-prices"))["111"].sold, "Axies marked sold");
assert(lastEdit().caption.includes("✅ <b>Sent</b>"), "Telegram message updated to Sent");
await tap("send:" + code); await Promise.all(waits); assert(sent.length === 2, "second tap doesn't send again");
r = await call("POST", "/order", { ids: ["111"], ronin: buyer, name: "X" }); assert(r.status === 409, "sold Axie can't be ordered");

kv.set("store-prices", JSON.stringify({ "444": { price: 100, sold: false } })); owners["444"] = store;
r = await call("POST", "/order", { ids: ["444"], ronin: buyer, name: "Y" }); const c2 = r.body.code;
await call("POST", `/order/${c2}/paid`, shot()); r = await call("POST", `/order/${c2}/paid`, shot()); assert(r.status === 409, "can't upload twice");
await tap("no:" + c2);
assert(order(c2).status === "checking" && lastEdit().reply_markup.inline_keyboard.length === 5, "Reject first asks for a reason, nothing changes yet");
await tap("back:" + c2); assert(order(c2).status === "checking" && lastEdit().reply_markup.inline_keyboard[0][0].text === "✅ Approve", "Back from reasons restores Approve/Reject");
await tap("no:" + c2); await tap("rj:" + c2 + ":fake");
assert(order(c2).status === "rejected" && /not real/.test(order(c2).reason) && !JSON.parse(kv.get("holds"))["444"], "reject with reason releases the hold");
r = await call("GET", `/order/${c2}`); assert(r.body.reason && /not real/.test(r.body.reason), "buyer sees the reason");
assert(lastEdit().reply_markup.inline_keyboard[0].map(b => b.text).join() === "✏️ Edit reason,↩️ Undo reject", "rejected message has Edit reason / Undo");
await tap("no:" + c2); await tap("rj:" + c2 + ":own");
await handleOrders({ method: "POST", url: "https://w.dev/tg", headers: new Headers({ "X-Telegram-Bot-Api-Secret-Token": "sec" }), json: async () => ({ message: { text: "Ref number does not exist in GCash", chat: { id: SELLER }, from: { id: SELLER } } }) }, env, ctx, json, async () => false);
assert(order(c2).reason === "Ref number does not exist in GCash" && !kv.get("tg-reason-wait"), "typed reason saved as the new reason");
await tap("un:" + c2); assert(order(c2).status === "checking" && !order(c2).reason && JSON.parse(kv.get("holds"))["444"].code === c2, "Undo reject: back to waiting, Axie held again");
await tap("no:" + c2); await tap("rj:" + c2 + ":nr"); assert(order(c2).status === "rejected", "rejected again");

r = await call("POST", "/order", { ids: ["444"], ronin: buyer, name: "Z" }); const c3 = r.body.code;
const o3 = order(c3); o3.payBy = Date.now() - 1; kv.set("order:" + c3, JSON.stringify(o3));
r = await call("GET", `/order/${c3}`); assert(r.body.status === "expired" && !JSON.parse(kv.get("holds"))["444"], "unpaid order expires and frees the Axie");

kv.delete("rl:1.1.1.1");
r = await call("POST", "/order", { ids: ["444"], ronin: buyer, name: "W" }); const c4 = r.body.code;
await call("POST", `/order/${c4}/paid`, shot()); env.STORE_WALLET_KEY = generatePrivateKey();
await tap("ok:" + c4); await tap("send:" + c4); await Promise.all(waits);
assert(order(c4).status === "problem" && /doesn't match/.test(order(c4).note) && sent.length === 2, "wrong key -> problem, nothing sent");
// /pending re-sends a receipt that never reached Telegram
kv.delete("rl:1.1.1.1"); kv.set("store-prices", JSON.stringify({ "555": { price: 50, sold: false } })); owners["555"] = env.STORE_WALLET;
r = await call("POST", "/order", { ids: ["555"], ronin: buyer }); assert(r.status === 400 && /name/.test(r.body.error), "order without a name refused");
r = await call("POST", "/order", { ids: ["555"], ronin: buyer, name: "Ana" }); const c5 = r.body.code;
env.TG_TOKEN = ""; await call("POST", `/order/${c5}/paid`, shot()); env.TG_TOKEN = "x"; assert(order(c5).tgError && !order(c5).tg, "Telegram down: order kept, error noted");
const before = tgCalls.length;
await handleOrders({ method: "POST", url: "https://w.dev/tg", headers: new Headers({ "X-Telegram-Bot-Api-Secret-Token": "sec" }), json: async () => ({ message: { text: "/pending", chat: { id: SELLER }, from: { id: SELLER } } }) }, env, ctx, json, async () => false);
assert(tgCalls.slice(before).some(c => c[0] === "sendPhoto" && c[1].caption.includes(c5)) && order(c5).tg, "/pending re-sent the receipt");
// restock: sold Axie back in the store wallet is for sale again; one that left stays sold
{ const { restock } = await import("./orders.js");
  kv.set("store-prices", JSON.stringify({ "777": { price: 90, sold: true }, "888": { price: 90, sold: true } })); owners["777"] = env.STORE_WALLET; owners["888"] = buyer;
  const n = await restock(env, [{ id: 777 }, { id: 888 }]); const p = JSON.parse(kv.get("store-prices"));
  assert(n === 1 && !p["777"] && p["888"].sold, "returned Axie loses its old price; one that left stays sold"); }
console.log("ALL PASSED");
