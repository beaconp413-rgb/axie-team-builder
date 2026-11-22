
const PRICES = window.PRICES || {};
const seenIds = new Set();
// drop repeats and unhatched eggs (no class or parts) so a bad sync can't double or break the grid
let AXIES = (window.AXIES || []).filter(a => a && a.cls && a.parts && a.parts.length && a.stats && !seenIds.has(a.id) && seenIds.add(a.id)).map(a => ({ ...a, price: PRICES[a.id]?.price ?? null, sold: !!PRICES[a.id]?.sold }));
const byId = () => Object.fromEntries(AXIES.map(a => [a.id, a]));
const CLASS_ORDER = ["Aquatic","Plant","Bird","Beast","Bug","Reptile","Dawn","Dusk","Mech"];
const classes = CLASS_ORDER.filter(c => AXIES.some(a => a.cls === c));
const cv = c => `var(--c-${c}, var(--muted))`;
const peso = n => "₱" + Math.round(n).toLocaleString("en-PH");
const imgFull = id => `https://axiecdn.axieinfinity.com/axies/${id}/axie/axie-full-transparent.png`;
const noThumb = new Set(); // ids with no local thumbnail yet; go straight to the CDN on later renders
const img = id => noThumb.has(id) ? imgFull(id) : `img/${id}.png`;
document.addEventListener("error", e => { const t = e.target; if (t.tagName === "IMG" && t.dataset.ax && !t.dataset.fb) { t.dataset.fb = 1; noThumb.add(t.dataset.ax); t.src = imgFull(t.dataset.ax); } }, true);
const priced = a => typeof a.price === "number" && a.price > 0;
const available = a => priced(a) && !a.sold;
const CARDS = window.CARDS || {};
const lv2 = a => a.parts.filter(p => p[3] === 2).length;

let team = [];
const ACCOUNT_FEE = 100;
let noAccount = false;
try { noAccount = localStorage.getItem("axieNoAccount") === "1"; } catch(e) {}
const acctFee = () => noAccount ? ACCOUNT_FEE : 0;
try { const m = byId(); team = JSON.parse(localStorage.getItem("axieTeam") || "[]").filter(id => m[id] && available(m[id])).slice(0,3); } catch(e) {}
let activeClass = null, editing = false, dirty = false;

const $ = s => document.querySelector(s);
const grid = $("#grid"), slots = $("#slots");
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

function chips(){
  const shown = editing ? AXIES : AXIES.filter(a => !a.sold);
  const all = [`<button class="chip" type="button" data-c="" aria-pressed="${!activeClass}">All <span class="id">${shown.length}</span></button>`];
  classes.forEach(c => {
    const n = shown.filter(a => a.cls === c).length;
    if (n) all.push(`<button class="chip" type="button" data-c="${c}" aria-pressed="${activeClass===c}"><span class="dot" style="background:${cv(c)}"></span>${c} <span class="id">${n}</span></button>`);
  });
  $("#classChips").innerHTML = all.join("");
}

function list(){
  const q = $("#q").value.trim().toLowerCase();
  let items = AXIES.filter(a => (editing || !a.sold) && (!activeClass || a.cls === activeClass));
  if (q) items = items.filter(a => (a.name + " " + a.id + " " + a.cls + " " + a.parts.map(p => p[1] + " " + (CARDS[p[4]]?.n || "")).join(" ")).toLowerCase().includes(q));
  const P = a => priced(a) ? a.price : Infinity;
  const f = {
    "price-asc": (a,b) => P(a) - P(b),
    "price-desc": (a,b) => (priced(b) ? b.price : -1) - (priced(a) ? a.price : -1),
    "speed-desc": (a,b) => b.stats.speed - a.stats.speed,
    "breeds-asc": (a,b) => a.breeds - b.breeds || P(a) - P(b),
    "lv2-desc": (a,b) => lv2(b) - lv2(a) || P(a) - P(b),
  }[$("#sort").value];
  return items.sort(f);
}

function card(a){
  const picked = team.includes(a.id);
  const full = team.length >= 3 && !picked;
  const off = !available(a);
  const head = `
    <div class="art"><img data-ax="${a.id}" src="${img(a.id)}" alt="${a.cls} Axie ${a.id}" loading="lazy">${a.sold ? '<span class="stamp">Sold</span>' : ""}</div>
    <div class="top"><div style="min-width:0"><div class="name">${esc(a.name)}</div><div class="id">#${a.id}</div></div>
      <span class="cls" style="background:${cv(a.cls)}">${a.cls}</span></div>
    <div class="meta"><span>SPD <b>${a.stats.speed}</b></span><span>HP <b>${a.stats.hp}</b></span><span>Breeds <b>${a.breeds}/7</b></span>${lv2(a) ? `<span class="lvcount">Lv2 ×${lv2(a)}</span>` : ""}</div>
    <div class="parts">${a.parts.map(p => `<div class="part" title="${p[0]}: ${p[1]} (${p[2]})${p[3] === 2 ? ", level 2" : ""}"><i style="background:${cv(p[2])}"></i><span>${esc(p[1])}</span>${p[3] === 2 ? '<b class="lv2">Lv2</b>' : ""}</div>`).join("")}</div>
    <button class="cardsbtn" type="button" data-cards="${a.id}">View cards</button>`;
  if (editing) {
    return `<article class="card" data-id="${a.id}">${head}
      <div class="ed">
        <div class="peso"><span>₱</span><input type="number" id="p-${a.id}" data-price="${a.id}" min="0" step="1" inputmode="numeric" placeholder="Set price" value="${priced(a) ? a.price : ""}" aria-label="Price in pesos for ${esc(a.name)}"></div>
        <label for="s-${a.id}"><input type="checkbox" id="s-${a.id}" data-sold="${a.id}" ${a.sold ? "checked" : ""}> Sold</label>
      </div></article>`;
  }
  const priceHtml = priced(a) ? `<div class="price">${peso(a.price)}</div>` : `<div class="price none">Price coming soon</div>`;
  const label = picked ? "Remove" : !priced(a) ? "Not yet for sale" : full ? "Team full" : "Add to team";
  return `<article class="card ${picked ? "picked" : ""} ${off ? "off" : ""}" ${off ? "" : 'tabindex="0"'} data-id="${a.id}" aria-label="${esc(a.name)}${priced(a) ? ", " + peso(a.price) : ""}">${head}
    <div class="buy">${priceHtml}<button class="btn ${picked ? "ghost" : ""}" type="button" ${(full || off) && !picked ? "disabled" : ""}>${label}</button></div>
  </article>`;
}

function renderGrid(){
  document.body.classList.toggle("editing", editing);
  const items = list();
  $("#count").textContent = `${items.length} Axie${items.length === 1 ? "" : "s"} shown`;
  grid.innerHTML = items.map(card).join("") || `<p class="count">No Axies match that search.</p>`;
}

function renderTray(){
  const m = byId();
  team = team.filter(id => m[id] && available(m[id]));
  slots.innerHTML = [0,1,2].map(i => {
    const a = m[team[i]];
    if (!a) return `<div class="slot"><span class="empty">Slot ${i+1}<br>empty</span></div>`;
    return `<div class="slot full"><img data-ax="${a.id}" src="${img(a.id)}" alt=""><div class="t"><b>${esc(a.name)}</b><span style="color:${cv(a.cls)};font-weight:700">${a.cls}</span> · ${peso(a.price)}</div><button class="x" type="button" data-rm="${a.id}" aria-label="Remove ${esc(a.name)}">×</button></div>`;
  }).join("");
  const total = team.reduce((s,id) => s + m[id].price, 0) + (team.length ? acctFee() : 0);
  $("#sum").textContent = peso(total);
  document.querySelectorAll("[data-acct]").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.acct === "no") === noAccount)));
  $("#note").textContent = team.length === 0 ? "Pick 3 Axies" : team.length < 3 ? `${3-team.length} more to pick` : "Team complete";
  $("#copy").disabled = team.length === 0;
  $("#viewTeam").disabled = team.length < 3;
  $("#checkout").disabled = team.length === 0;
  $("#msgWrap").hidden = true;
  try { localStorage.setItem("axieTeam", JSON.stringify(team)); } catch(e) {}
}

function orderText(){
  const m = byId();
  const lines = team.map((id,i) => { const a = m[id]; return `${i+1}. ${a.name} (#${a.id}, ${a.cls}) - ${peso(a.price)}`; });
  if (noAccount) lines.push(`+ New Axie account (I don't have one) - ${peso(ACCOUNT_FEE)}`);
  const total = team.reduce((s,id) => s + m[id].price, 0) + acctFee();
  return `Hi! I'd like to buy this Axie team:\n${lines.join("\n")}\nTotal: ${peso(total)}`;
}

function toast(t){ const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 2600); }

function toggle(id){
  const a = byId()[id];
  if (team.includes(id)) team = team.filter(x => x !== id);
  else if (!available(a)) return;
  else if (team.length >= 3) { toast("Your team already has 3 Axies. Remove one first."); return; }
  else { team.push(id); if (team.length === 3) toast("Team complete. Tap View team to see your lineup."); }
  renderGrid(); renderTray();
}

/* ---------- battle cards ---------- */
const dlg = $("#cardsDlg");
const LV2 = window.CARDS_LV2 || {};
const SWORD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M13.5 1.5 6 9l1 1 7.5-7.5V1.5zM4.6 8.2l3.2 3.2-1 1-1.1-1.1-2 2 .3.3-.9.9-1.8-1.8.9-.9.3.3 2-2-1.1-1.1z"/></svg>';
const SHIELD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1 2.5 3v4.2c0 3.3 2.3 6.3 5.5 7.8 3.2-1.5 5.5-4.5 5.5-7.8V3z"/></svg>';
function cardFor(p){
  const base = CARDS[p[4]];
  if (p[3] === 2 && LV2[p[4]]) return { ...base, ...LV2[p[4]], lv2: true };
  if (p[3] === 2) return { ...base, t: "Level 2 card. Message me for its exact Level 2 effect.", lv2: true };
  return { ...base, lv2: false };
}
function cardsHtml(a, withDesc){
  return a.parts.filter(p => p[4] && CARDS[p[4]]).map(p => {
    const c = cardFor(p);
    return `<div class="bc">
      <div class="bcard" style="background-image:url('${c.img}')" role="img" aria-label="${esc(c.n)} card, ${c.e} energy, ${c.a} damage, ${c.d} shield">
        <span class="en">${c.e}</span><span class="nm">${esc(c.n)}</span>
        <span class="at">${SWORD}${c.a}</span><span class="df">${SHIELD}${c.d}</span>
        ${p[3] === 2 ? '<span class="lv">Lv2</span>' : ""}<span class="ds">${esc(c.t)}</span>
      </div>
      <div class="bpart">${p[0]}: ${esc(p[1])}</div>
    </div>`;
  }).join("");
}

/* ---------- team sheet (screenshot view) ---------- */
const teamDlg = $("#teamDlg");
const POS = ["Front", "Middle", "Back"];
function renderSheet(){
  const m = byId();
  const mem = team.map(id => m[id]);
  const total = mem.reduce((s,a) => s + a.price, 0) + acctFee();
  const date = new Date().toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
  $("#sheet").innerHTML = `
    <div class="sheet-head">
      <div><h2>My Axie Team</h2><div class="date">${date} · ${mem.map(a => "#" + a.id).join(" · ")}</div></div>
      <div class="sheet-total"><span class="lbl">Team total</span><span class="sum">${peso(total)}</span>${noAccount ? `<span class="lbl">incl. ${peso(ACCOUNT_FEE)} new account</span>` : ""}</div>
    </div>
    <div class="lineup">${mem.map((a,i) => `
      <div class="mem">
        <div class="pos"><span>${POS[i]}</span><span class="mv">
          <button type="button" data-mv="${i}" data-dir="-1" aria-label="Move ${esc(a.name)} left" ${i === 0 ? "disabled" : ""}>←</button>
          <button type="button" data-mv="${i}" data-dir="1" aria-label="Move ${esc(a.name)} right" ${i === mem.length - 1 ? "disabled" : ""}>→</button></span></div>
        <div class="pic"><img data-ax="${a.id}" src="${img(a.id)}" alt="${a.cls} Axie ${a.id}"></div>
        <div class="name">${esc(a.name)}</div>
        <div class="meta"><span class="cls" style="background:${cv(a.cls)}">${a.cls}</span><span>#${a.id}</span></div>
        <div class="meta"><span>SPD <b>${a.stats.speed}</b></span><span>HP <b>${a.stats.hp}</b></span>${lv2(a) ? `<span class="lvcount">Lv2 ×${lv2(a)}</span>` : ""}</div>
        <div class="mprice">${peso(a.price)}</div>
      </div>`).join("")}</div>
    <div class="deck"><h3>Team cards</h3>${mem.map((a,i) => `
      <div class="deck-row">
        <div class="who"><span class="cls" style="background:${cv(a.cls)}">${POS[i]}</span><b>${esc(a.name)}</b><span class="id">#${a.id}</span></div>
        <div class="bcards">${cardsHtml(a, true)}</div>
      </div>`).join("")}</div>
    <div class="sheet-foot">I want to buy this team · ${peso(total)} for 3 Axies${noAccount ? " + new Axie account" : ""}</div>`;
}
document.querySelectorAll("[data-acct]").forEach(b => b.addEventListener("click", () => {
  noAccount = b.dataset.acct === "no";
  try { localStorage.setItem("axieNoAccount", noAccount ? "1" : "0"); } catch(e) {}
  renderTray();
  if (noAccount) toast(`Added ${peso(ACCOUNT_FEE)} so I can make you an Axie account.`);
}));
$("#viewTeam").addEventListener("click", () => { if (team.length < 3) return; renderSheet(); if (!teamDlg.open) teamDlg.showModal(); teamDlg.scrollTop = 0; });
$("#teamClose").addEventListener("click", () => teamDlg.close());
$("#sheet").addEventListener("click", e => {
  const b = e.target.closest("[data-mv]"); if (!b) return;
  const i = +b.dataset.mv, j = i + +b.dataset.dir;
  if (j < 0 || j >= team.length) return;
  [team[i], team[j]] = [team[j], team[i]];
  renderSheet(); renderGrid(); renderTray();
});
function showCards(id){
  const a = byId()[id]; if (!a) return;
  const cards = cardsHtml(a);
  $("#dlgBody").innerHTML = `
    <div class="dlg-head"><img data-ax="${a.id}" src="${img(a.id)}" alt=""><div style="min-width:0"><div class="name">${esc(a.name)}</div>
      <div class="meta"><span class="cls" style="background:${cv(a.cls)}">${a.cls}</span><span>#${a.id}</span>${lv2(a) ? `<span class="lvcount">Lv2 ×${lv2(a)}</span>` : ""}${priced(a) && !a.sold ? `<span><b>${peso(a.price)}</b></span>` : ""}</div></div>
      <button class="x" type="button" id="dlgClose" aria-label="Close">×</button></div>
    <div class="bcards">${cards || '<p class="dlg-note">No card data for this Axie.</p>'}</div>
    <p class="dlg-note">Axie Classic cards. Energy is the number in the top-left circle. Lv2 marks an evolved part.</p>`;
  $("#dlgClose").addEventListener("click", () => dlg.close());
  if (!dlg.open) dlg.showModal();
}
dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });

/* ---------- buyer interactions ---------- */
grid.addEventListener("click", e => {
  const cb = e.target.closest("[data-cards]");
  if (cb) { showCards(cb.dataset.cards); return; }
  if (editing || e.target.closest("a")) return;
  const c = e.target.closest(".card"); if (c) toggle(c.dataset.id);
});
grid.addEventListener("keydown", e => {
  if (editing) return;
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")) { e.preventDefault(); toggle(e.target.dataset.id); }
});
slots.addEventListener("click", e => { const b = e.target.closest("[data-rm]"); if (b) toggle(b.dataset.rm); });
$("#classChips").addEventListener("click", e => { const b = e.target.closest(".chip"); if (!b) return; activeClass = b.dataset.c || null; chips(); renderGrid(); });
$("#q").addEventListener("input", renderGrid);
$("#sort").addEventListener("change", renderGrid);
$("#clear").addEventListener("click", () => { team = []; renderGrid(); renderTray(); });
$("#copy").addEventListener("click", () => {
  const text = orderText(), ta = $("#msg"); ta.value = text;
  navigator.clipboard.writeText(text).then(() => toast("Order copied. Paste it in Messenger."), () => {
    $("#msgWrap").hidden = false; ta.focus(); ta.select(); toast("Copy the message below and send it to me.");
  });
});

/* ---------- seller price editor ---------- */
function markDirty(){ dirty = true; $("#save").disabled = false; }
grid.addEventListener("input", e => {
  const id = e.target.dataset.price; if (!id) return;
  const v = e.target.value.trim(), a = AXIES.find(x => x.id === id);
  a.price = v === "" ? null : Math.max(0, Math.round(Number(v)));
  markDirty();
});
grid.addEventListener("change", e => {
  const id = e.target.dataset.sold; if (!id) return;
  AXIES.find(x => x.id === id).sold = e.target.checked;
  markDirty();
});
$("#editToggle").addEventListener("click", () => {
  editing = !editing;
  $("#editToggle").textContent = editing ? "Done editing" : "Edit prices";
  $("#bulk").hidden = !editing; $("#save").hidden = !editing && !dirty;
  chips(); renderGrid(); renderTray();
});
$("#bulkApply").addEventListener("click", () => {
  const v = Math.round(Number($("#bulkPrice").value));
  if (!(v > 0)) { toast("Type a peso amount first."); return; }
  let n = 0; AXIES.forEach(a => { if (!priced(a)) { a.price = v; n++; } });
  if (!n) { toast("Every Axie already has a price."); return; }
  markDirty(); renderGrid(); toast(`Set ${n} Axies to ${peso(v)}.`);
});

/* ---------- seller mode: one-tap save to the price store (password-protected) ---------- */
const STORE = window.PRICE_STORE;
let sellerPw = null; // kept only while this page is open, never stored
function pricesJson(){
  const out = {};
  AXIES.forEach(a => { if (priced(a) || a.sold) out[a.id] = { price: priced(a) ? a.price : null, sold: !!a.sold }; });
  return JSON.stringify(out);
}
function showSeller(){
  $("#ownerBar").hidden = false;
  const unpriced = AXIES.filter(a => !priced(a)).length;
  $("#ownerText").innerHTML = `<b>Seller mode.</b> ${unpriced ? `${unpriced} Axie${unpriced === 1 ? " has" : "s have"} no price yet. ` : ""}Set prices and mark sold Axies, then press <b>Save</b>. Buyers see changes right away. Just bought or sold an Axie? Press <b>Sync now</b>.`;
}
$("#sellerLink").addEventListener("click", () => { if ($("#ownerBar").hidden) { showSeller(); $("#ownerBar").scrollIntoView({ behavior: "smooth" }); } else $("#ownerBar").hidden = true; });
if (location.hash === "#seller") showSeller();

async function savePrices(){
  const btn = $("#save"); btn.disabled = true; btn.textContent = "Saving…";
  try {
    const r = await fetch(STORE + "/prices", { method: "PUT", headers: { "Content-Type": "application/json", "X-Seller-Password": sellerPw }, body: pricesJson() });
    if (r.status === 401) { sellerPw = null; $("#pwForm").hidden = false; $("#pwMsg").textContent = "Wrong password. Try again."; btn.textContent = "Save"; btn.disabled = false; return askPw(savePrices); }
    if (!r.ok) throw new Error(r.status);
    dirty = false; btn.textContent = "Saved"; $("#pwForm").hidden = true; $("#pwMsg").textContent = "";
    toast("Prices saved. Buyers see them now.");
  } catch (e) {
    btn.disabled = false; btn.textContent = "Save";
    toast("Couldn't save. Check your internet, then press Save again.");
  }
}
let pendingAction = null;
function askPw(action){ pendingAction = action; $("#pwForm").hidden = false; $("#pw").focus(); }
$("#save").addEventListener("click", () => {
  if (!STORE) { toast("Saving isn't set up yet."); return; }
  if (!sellerPw) return askPw(savePrices);
  savePrices();
});
async function syncNow(){
  const btn = $("#syncNow"); btn.disabled = true; btn.textContent = "Syncing…";
  try {
    const r = await fetch(STORE + "/sync", { method: "POST", headers: { "X-Seller-Password": sellerPw } });
    if (r.status === 401) { sellerPw = null; $("#pwMsg").textContent = "Wrong password. Try again."; btn.disabled = false; btn.textContent = "Sync now"; return askPw(syncNow); }
    if (!r.ok) throw new Error(r.status);
    $("#pwForm").hidden = true; $("#pwMsg").textContent = "";
    const j = await r.json();
    toast(`Synced: ${j.count} Axies in your wallet. Reloading…`);
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    btn.disabled = false; btn.textContent = "Sync now";
    toast("Couldn't sync right now. Try again in a minute. The automatic sync still runs every 15 to 30 minutes.");
  }
}
$("#syncNow").addEventListener("click", () => {
  if (!STORE) return;
  if (!sellerPw) return askPw(syncNow);
  syncNow();
});
$("#pwForm").addEventListener("submit", e => {
  e.preventDefault();
  sellerPw = $("#pw").value; $("#pw").value = "";
  if (sellerPw) (pendingAction || savePrices)();
});
window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
if (window.SYNC && window.SYNC.syncedAt) $("#syncNote").textContent = "Axie list updated " + new Date(window.SYNC.syncedAt).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });

/* ---------- checkout: buyer pays GCash, the seller approves in Telegram, the bot sends the Axies ---------- */
const payDlg = $("#payDlg"), payBody = $("#payBody"), orderBar = $("#orderBar");
const FINAL = ["sent", "rejected", "expired"];
let curOrder = null, pollT = null, tickT = null;
const okRonin = s => { const v = String(s || "").trim().replace(/^ronin:/i, "0x"); return /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null; };
const roninShow = a => "ronin:" + a.slice(2);
const remember = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch(e) {} };
const recall = k => { try { return localStorage.getItem(k) || ""; } catch(e) { return ""; } };
if (window.CHECKOUT) $("#checkout").hidden = false;

async function api(path, opts){
  const r = await fetch(STORE + path, { cache: "no-store", ...opts, headers: { "Content-Type": "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || "Something went wrong. Check your internet and try again."), { data: j });
  return j;
}
const head = t => `<div class="pay-head"><h2>${t}</h2><button class="x" type="button" data-close aria-label="Close">×</button></div>`;
const itemsHtml = items => `<ul class="pay-items">${items.map(i => `<li><span>${esc(i.name)} <span class="id">#${i.id}</span></span><b>${peso(i.price)}</b></li>`).join("")}</ul>`;

function openCheckout(){
  if (curOrder && !FINAL.includes(curOrder.status)) return showOrder(curOrder);
  if (!team.length) return;
  if (noAccount) {
    payBody.innerHTML = `${head("Checkout")}
      <p class="note">Checkout sends the Axies straight to <b>your own Ronin wallet</b>. You chose <b>None</b>, so I'll make an account for you by hand: tap <b>Copy order</b> and message me on Facebook.</p>
      <button class="btn" type="button" id="coHave">I have a Ronin wallet</button>`;
    $("#coHave").addEventListener("click", () => { noAccount = false; remember("axieNoAccount", "0"); renderTray(); openCheckout(); });
  } else renderForm();
  if (!payDlg.open) payDlg.showModal();
}

function renderForm(){
  const m = byId(), items = team.map(id => ({ id, name: m[id].name, price: m[id].price }));
  payBody.innerHTML = `${head("Checkout")}${itemsHtml(items)}
    <div class="pay-total"><span>Total</span><span class="big">${peso(items.reduce((s, i) => s + i.price, 0))}</span></div>
    <form id="coForm" class="pay" style="padding:0" novalidate>
      <label class="f">Your Facebook name<input type="text" id="coName" autocomplete="name" maxlength="60" value="${esc(recall("axieBuyerName"))}"></label>
      <label class="f">Your Ronin wallet address<span class="h">In the Ronin Wallet app, tap your address to copy it. It starts with ronin: or 0x.</span>
        <input type="text" class="mono" id="coAddr" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ronin:…" value="${esc(recall("axieBuyerRonin"))}"></label>
      <label class="chk"><input type="checkbox" id="coOk"><span>My address is correct. Axies sent to a wrong address can't be returned.</span></label>
      <p class="err" id="coErr" role="alert"></p>
      <button class="btn" type="submit" id="coGo">Place order</button>
      <p class="note">Next you pay with GCash. Your Axies are held for you for 30 minutes.</p>
    </form>`;
  $("#coForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = t => { $("#coErr").textContent = t; };
    const name = $("#coName").value.trim(), ronin = okRonin($("#coAddr").value);
    if (!name) return err("Enter your Facebook name.");
    if (!ronin) return err("That Ronin address doesn't look right. Copy it again from the Ronin Wallet app.");
    if (!$("#coOk").checked) return err("Tick the box to confirm your address.");
    remember("axieBuyerName", name); remember("axieBuyerRonin", roninShow(ronin));
    const go = $("#coGo"); go.disabled = true; go.textContent = "Placing order…"; err("");
    try {
      const o = await api("/order", { method: "POST", body: JSON.stringify({ ids: team, ronin, name }) });
      setOrder(o); showOrder(o);
    } catch (x) {
      go.disabled = false; go.textContent = "Place order"; err(x.message);
      const gone = x.data && x.data.unavailable;
      if (gone && gone.length) { team = team.filter(id => !gone.includes(id)); renderGrid(); renderTray(); }
    }
  });
}

function setOrder(o){
  curOrder = o; remember("axieOrder", o.code);
  history.replaceState(null, "", "#order=" + o.code);
  orderBar.hidden = payDlg.open || FINAL.includes(o.status);
  orderBar.textContent = o.status === "awaiting_payment" ? `Order ${o.code}: waiting for your GCash payment →` : `Order ${o.code}: ${o.status === "checking" ? "checking your payment" : "sending your Axies"} →`;
}

function showOrder(o){
  clearInterval(tickT); clearTimeout(pollT);
  const linkBtn = `<button class="btn ghost" type="button" data-link>Copy link to this order</button>`;
  if (o.status === "awaiting_payment") {
    const g = o.gcash || {};
    payBody.innerHTML = `${head("Pay with GCash")}
      <p class="note">Order <b>${o.code}</b> · <span class="timer" id="coTimer"></span> left to pay</p>
      <div class="pay-total"><span>Send exactly</span><span class="big">${peso(o.total)}</span></div>
      ${g.qr ? `<img class="qr" src="${STORE}/gcash-qr" alt="GCash QR code to pay">` : ""}
      ${g.number ? `<div class="gc"><div class="row"><span>GCash name</span><b>${esc(g.name || "")}</b></div>
        <div class="row"><span>GCash number</span><span><span class="num">${esc(g.number)}</span> <button class="btn ghost" type="button" data-copy="${esc(g.number)}">Copy</button></span></div></div>` : ""}
      <p class="note">After paying, copy the <b>Ref. No.</b> from your GCash receipt and paste it below.</p>
      <form id="refForm" class="pay" style="padding:0" novalidate>
        <label class="f">GCash reference number<input type="text" class="mono" id="coRef" inputmode="numeric" maxlength="24" placeholder="13 digits"></label>
        <p class="err" id="refErr" role="alert"></p>
        <button class="btn" type="submit" id="refGo">I've paid</button>
      </form>
      <p class="note">Your Axies will be sent to:</p><div class="addr">${roninShow(o.ronin)}</div>`;
    const tick = () => {
      const left = Math.max(0, o.payBy - Date.now());
      const el = $("#coTimer"); if (el) el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`;
      if (!left) { clearInterval(tickT); refreshOrder(); }
    };
    tick(); tickT = setInterval(tick, 1000);
    $("#refForm").addEventListener("submit", async e => {
      e.preventDefault();
      const ref = $("#coRef").value.replace(/\D/g, "");
      if (ref.length < 10) { $("#refErr").textContent = "Paste the reference number from your GCash receipt (13 digits)."; return; }
      const go = $("#refGo"); go.disabled = true; go.textContent = "Sending…";
      try { const n = await api(`/order/${o.code}/paid`, { method: "POST", body: JSON.stringify({ ref }) }); setOrder(n); showOrder(n); }
      catch (x) { go.disabled = false; go.textContent = "I've paid"; $("#refErr").textContent = x.message; if (x.data && x.data.order) { setOrder(x.data.order); showOrder(x.data.order); } }
    });
  } else if (o.status === "checking" || o.status === "sending" || o.status === "problem") {
    const checking = o.status === "checking";
    payBody.innerHTML = `${head(checking ? "Payment received" : "Sending your Axies")}
      <div class="state"><div class="spin" aria-hidden="true"></div>
        <h3>${checking ? "Checking your payment" : "Sending your Axies…"}</h3>
        <p class="note">${checking
          ? `I'm checking my GCash for <b>${peso(o.total)}</b> (ref ${esc(o.ref || "")}). Once it's confirmed, your Axies are sent to your wallet automatically.`
          : o.status === "problem" ? "This is taking longer than usual. I'm on it, and your Axies are still held for you." : "Your payment is confirmed. This takes about a minute."}</p></div>
      ${itemsHtml(o.items)}
      <p class="note">You can close this page. Open the order link again any time to see the status.</p>${linkBtn}`;
    pollT = setTimeout(refreshOrder, checking ? 8000 : 4000);
  } else if (o.status === "sent") {
    payBody.innerHTML = `${head("Done!")}
      <div class="state"><div class="ic" aria-hidden="true">✅</div><h3>${o.confirmed ? "Your Axies are in your wallet" : "Your Axies are on the way"}</h3>
        <p class="note">Open Axie Classic to use them. Thank you for buying!</p></div>
      <ul class="pay-items">${o.items.map(i => { const t = o.txs[i.id]; return `<li><span>${esc(i.name)} <span class="id">#${i.id}</span></span>${t && t.hash ? `<a href="https://app.roninchain.com/tx/${t.hash}" target="_blank" rel="noopener">Proof ↗</a>` : "<b>Sent</b>"}</li>`; }).join("")}</ul>
      <div class="addr">${roninShow(o.ronin)}</div>
      <button class="btn" type="button" data-done>Done</button>`;
    if (!o.confirmed) pollT = setTimeout(refreshOrder, 5000);
    const ids = o.items.map(i => i.id);
    AXIES.forEach(a => { if (ids.includes(a.id)) a.sold = true; });
    team = team.filter(id => !ids.includes(id)); renderGrid(); renderTray();
  } else {
    const rejected = o.status === "rejected";
    payBody.innerHTML = `${head(rejected ? "Payment not found" : "Time's up")}
      <div class="state"><div class="ic" aria-hidden="true">${rejected ? "❌" : "⏰"}</div>
        <p class="note">${rejected
          ? `I couldn't find your GCash payment for order <b>${o.code}</b>. Message me on Facebook with a screenshot of your GCash receipt and I'll sort it out.`
          : "The 30 minutes to pay ran out, so the Axies were released. You can order again."}</p></div>
      <button class="btn" type="button" data-done>${rejected ? "Close" : "Start over"}</button>`;
  }
  if (!payDlg.open) payDlg.showModal();
  orderBar.hidden = true;
}

async function refreshOrder(){
  if (!curOrder) return;
  try { const o = await api("/order/" + curOrder.code); setOrder(o); if (payDlg.open) showOrder(o); }
  catch (x) { if (payDlg.open && !FINAL.includes(curOrder.status)) pollT = setTimeout(refreshOrder, 10000); }
}

payBody.addEventListener("click", e => {
  if (e.target.closest("[data-close]")) return payDlg.close();
  const c = e.target.closest("[data-copy]");
  if (c) navigator.clipboard.writeText(c.dataset.copy).then(() => toast("GCash number copied."), () => {});
  if (e.target.closest("[data-link]")) navigator.clipboard.writeText(location.href.split("#")[0] + "#order=" + curOrder.code).then(() => toast("Order link copied. Keep it to check your order."), () => {});
  if (e.target.closest("[data-done]")) { remember("axieOrder", null); curOrder = null; history.replaceState(null, "", location.pathname); payDlg.close(); }
});
payDlg.addEventListener("click", e => { if (e.target === payDlg) payDlg.close(); });
payDlg.addEventListener("close", () => {
  clearInterval(tickT); clearTimeout(pollT);
  if (curOrder && !FINAL.includes(curOrder.status)) setOrder(curOrder);
});
orderBar.addEventListener("click", () => curOrder && (showOrder(curOrder), refreshOrder()));
$("#checkout").addEventListener("click", openCheckout);

// reopen an order from its link (#order=CODE) or from this phone's last order
(async () => {
  const code = (location.hash.match(/order=([A-Z2-9]{8})/) || [])[1] || recall("axieOrder");
  if (!code || !STORE) return;
  try {
    const o = await api("/order/" + code);
    curOrder = o;
    if (location.hash.includes(code) || !FINAL.includes(o.status)) showOrder(o);
    else remember("axieOrder", null);
  } catch (e) { remember("axieOrder", null); }
})();

chips(); renderGrid(); renderTray();
