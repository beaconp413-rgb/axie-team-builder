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
  SHOP: { get: async k => kv.has(k) ? kv.get(k) : null, put: async (k, v) => { kv.set(k, v); } },
  CHECKOUT: "on", STORE_WALLET: store, LIST_WALLET: "0xe8a963a82a739e18319b89ac5d85971b0808a108", MAX_SENT_PER_DAY: "20",
  STORE_WALLET_KEY: key, TG_TOKEN: "x", TG_CHAT_ID: String(SELLER), TG_SECRET: "sec",
};
kv.set("store-prices", JSON.stringify({ "111": { price: 500, sold: false }, "222": { price: 300, sold: false }, "333": { price: 0, sold: false } }));
kv.set("gcash", JSON.stringify({ name: "M. K.", number: "09170000000", qr: true }));
const owners = { "111": store, "222": store }, sent = [], tgCalls = [];
globalThis.fetch = async (url, init) => {
  const b = JSON.parse(init.body), res = r => ({ json: async () => r });
  if (url.includes("telegram")) { tgCalls.push([url.split("/").pop(), b]); return res({ ok: true, result: { chat: { id: SELLER }, message_id: 42 } }); }
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
const call = (method, path, body) => handleOrders({ method, url: "https://w.dev" + path, headers: new Headers({ "CF-Connecting-IP": "1.1.1.1" }), json: async () => body }, env, ctx, json, async () => false);
const tap = (data, from = SELLER, secret = "sec") => handleOrders({ method: "POST", url: "https://w.dev/tg", headers: new Headers({ "X-Telegram-Bot-Api-Secret-Token": secret }),
  json: async () => ({ callback_query: { id: "q", from: { id: from }, data, message: { chat: { id: SELLER }, message_id: 42 } } }) }, env, ctx, json, async () => false);
const lastEdit = () => tgCalls.filter(c => c[0] === "editMessageText").at(-1)[1];
const order = c => JSON.parse(kv.get("order:" + c));

assert(normalizeRonin("ronin:" + "AB".repeat(20)) === buyer, "ronin: address normalized");
assert(normalizeRonin("0x123") === null, "short address rejected");
let r = await call("POST", "/order", { ids: ["333"], ronin: buyer, name: "Juan" }); assert(r.status === 409, "unpriced Axie refused");
r = await call("POST", "/order", { ids: ["111"], ronin: store, name: "Juan" }); assert(r.status === 400, "store wallet as buyer refused");
r = await call("POST", "/order", { ids: ["111", "222"], ronin: "ronin:" + "ab".repeat(20), name: "Juan Dela Cruz", total: 1 });
assert(r.status === 200 && r.body.total === 800 && r.body.gcash.number, "order created, total 800 from server prices, GCash info shown");
const code = r.body.code;
r = await call("POST", "/order", { ids: ["222"], ronin: buyer, name: "Pedro" }); assert(r.status === 409, "held Axie can't be ordered by someone else");
r = await call("POST", `/order/${code}/paid`, { ref: "12" }); assert(r.status === 400, "short ref refused");
r = await call("POST", `/order/${code}/paid`, { ref: "1012 345 678 901" }); assert(r.status === 200 && r.body.status === "checking", "ref accepted -> checking");
assert(tgCalls.at(-1)[0] === "sendMessage" && tgCalls.at(-1)[1].text.includes("₱800"), "seller got Telegram message with ₱800");

r = await tap("send:" + code, SELLER, "wrong"); assert(r.status === 401, "webhook with wrong secret refused");
await tap("send:" + code, 999); assert(sent.length === 0 && order(code).status === "checking", "stranger's tap ignored");
await tap("ok:" + code); assert(sent.length === 0 && lastEdit().reply_markup.inline_keyboard[0][0].text.startsWith("✅ Yes"), "Approve asks to confirm first, nothing sent");
await tap("send:" + code); await Promise.all(waits);
assert(sent.length === 2 && order(code).status === "sent", "confirm -> 2 transfers sent, status sent");
{ const tx = parseTransaction(sent[0]); const d = decodeFunctionData({ abi: parseAbi(["function safeTransferFrom(address,address,uint256)"]), data: tx.data });
  assert(tx.to === "0x32950db2a7164ae833121501c797d79e7b79d74c" && tx.chainId === 2020 && (await recoverTransactionAddress({ serializedTransaction: sent[0] })).toLowerCase() === store
    && d.args[0].toLowerCase() === store && d.args[1].toLowerCase() === buyer && d.args[2] === 111n, "signed tx: Axie contract, Ronin chain 2020, store -> buyer, Axie #111"); }
assert(JSON.parse(kv.get("store-prices"))["111"].sold, "Axies marked sold");
assert(lastEdit().text.includes("✅ <b>Sent</b>"), "Telegram message updated to Sent");
await tap("send:" + code); await Promise.all(waits); assert(sent.length === 2, "second tap doesn't send again");
r = await call("POST", "/order", { ids: ["111"], ronin: buyer, name: "X" }); assert(r.status === 409, "sold Axie can't be ordered");

kv.set("store-prices", JSON.stringify({ "444": { price: 100, sold: false } })); owners["444"] = store;
r = await call("POST", "/order", { ids: ["444"], ronin: buyer, name: "Y" }); const c2 = r.body.code;
r = await call("POST", `/order/${c2}/paid`, { ref: "1012345678901" }); assert(r.status === 409, "same GCash ref can't be reused");
await call("POST", `/order/${c2}/paid`, { ref: "2012345678901" }); await tap("no:" + c2);
assert(order(c2).status === "rejected" && !JSON.parse(kv.get("holds"))["444"], "reject releases the hold");

r = await call("POST", "/order", { ids: ["444"], ronin: buyer, name: "Z" }); const c3 = r.body.code;
const o3 = order(c3); o3.payBy = Date.now() - 1; kv.set("order:" + c3, JSON.stringify(o3));
r = await call("GET", `/order/${c3}`); assert(r.body.status === "expired" && !JSON.parse(kv.get("holds"))["444"], "unpaid order expires and frees the Axie");

kv.delete("rl:1.1.1.1");
r = await call("POST", "/order", { ids: ["444"], ronin: buyer, name: "W" }); const c4 = r.body.code;
await call("POST", `/order/${c4}/paid`, { ref: "3012345678901" }); env.STORE_WALLET_KEY = generatePrivateKey();
await tap("ok:" + c4); await tap("send:" + c4); await Promise.all(waits);
assert(order(c4).status === "problem" && /doesn't match/.test(order(c4).note) && sent.length === 2, "wrong key -> problem, nothing sent");
console.log("ALL PASSED");
