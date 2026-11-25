"use strict";
// Домашние дела: сервер с личными ссылками, отметками и push-уведомлениями.
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");
const S = require("./public/schedule.js");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TZ = process.env.TZ_NAME || "Europe/Moscow";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const PARENTS = (process.env.PARENTS || "Родитель").split(",").map(s => s.trim()).filter(Boolean);
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, "state.json");

// ---------- состояние ----------
const rnd = () => crypto.randomBytes(18).toString("hex");
function load() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; }
}
const st = load();
st.tokens = st.tokens || {};      // токен -> id человека
st.done = st.done || {};          // ключ -> {by, at}
st.colors = st.colors || {};      // номер ребёнка -> оттенок
st.notes = st.notes || [];        // {id,to,text,at,from,seenBy:[]}
st.subs = st.subs || {};          // id -> [подписки]
st.sent = st.sent || {};          // дата_слот -> true
if (!st.vapid) st.vapid = webpush.generateVAPIDKeys();
// люди: дети k0..k3, родители p0..
const PEOPLE = [
  ...S.NAMES.map((n, i) => ({ id: "k" + i, role: "kid", person: i, name: n })),
  ...PARENTS.map((n, i) => ({ id: "p" + i, role: "parent", name: n }))
];
const byId = Object.fromEntries(PEOPLE.map(p => [p.id, p]));
for (const p of PEOPLE) if (!Object.values(st.tokens).includes(p.id)) st.tokens[rnd()] = p.id;
let saving = false, dirty = false;
function save() {
  dirty = true; if (saving) return; saving = true;
  setImmediate(() => {
    dirty = false;
    const tmp = STATE_FILE + ".tmp";
    fs.writeFile(tmp, JSON.stringify(st), err => {
      if (!err) fs.rename(tmp, STATE_FILE, () => { saving = false; if (dirty) save(); });
      else { saving = false; console.error("save failed", err.message); }
    });
  });
}
save();

webpush.setVapidDetails(process.env.RENDER_EXTERNAL_URL || "https://example.com", st.vapid.publicKey, st.vapid.privateKey);

// ---------- время ----------
function nowParts() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const o = {}; f.formatToParts(new Date()).forEach(p => o[p.type] = p.value);
  return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, min: +o.minute };
}
const todayDate = () => { const n = nowParts(); return new Date(n.y, n.m - 1, n.d); };

// ---------- push ----------
async function push(id, payload) {
  const list = st.subs[id] || [];
  const alive = [];
  for (const sub of list) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600 }); alive.push(sub); }
    catch (e) { if (!(e.statusCode === 404 || e.statusCode === 410)) alive.push(sub); else console.log("sub removed for", id); }
  }
  if (alive.length !== list.length) { st.subs[id] = alive; save(); }
  return list.length;
}
const kidIds = S.NAMES.map((_, i) => "k" + i);
const parentIds = PEOPLE.filter(p => p.role === "parent").map(p => p.id);

function dayStatus(d) {
  return S.assign(d).map((list, p) => {
    const left = list.filter(t => !st.done[S.key(d, p, t)]);
    const total = S.sumPts(list);
    const got = total - S.sumPts(left);
    return { p, total, got, left };
  });
}
const leftText = left => left.map(t => S.TASKS[t][0]).join(", ");

async function tick() {
  const n = nowParts(), d = todayDate(), ds = S.iso(d);
  const once = (slot, from, to) => {
    const k = ds + "_" + slot;
    if (st.sent[k] || n.h < from || n.h >= to) return false;
    st.sent[k] = true; save(); return true;
  };
  const status = dayStatus(d);
  if (once("r13", 13, 15)) {
    for (const s of status) if (s.left.includes("dishAM")) await push("k" + s.p, { title: "Посуда до обеда", body: "Мытьё посуды до обеда ещё не отмечено.", tag: "r13" });
  }
  if (once("r18", 18, 20)) {
    for (const s of status) if (s.left.length) await push("k" + s.p, { title: "Осталось сделать", body: leftText(s.left), tag: "r18" });
  }
  if (once("r20", 20, 22)) {
    for (const s of status) if (s.left.length) await push("k" + s.p, { title: "Уже поздно, а дела не сделаны", body: leftText(s.left), tag: "r20" });
  }
  if (once("digest", 21, 24)) {
    const lines = status.map(s => {
      const name = S.NAMES[s.p];
      if (s.got === s.total) return `${name}: ${s.got} из ${s.total}. Сделано всё, можно похвалить.`;
      if (s.got === 0) return `${name}: 0 из ${s.total}. Ничего не отмечено, стоит поговорить.`;
      return `${name}: ${s.got} из ${s.total}. Осталось: ${leftText(s.left)}.`;
    });
    for (const id of parentIds) await push(id, { title: "Сводка дня, " + S.fmt(d), body: lines.join("\n"), tag: "digest" });
  }
  // чистим старые отметки о рассылках
  const keep = S.iso(S.addDays(d, -3));
  for (const k of Object.keys(st.sent)) if (k.slice(0, 10) < keep) delete st.sent[k];
}
setInterval(() => tick().catch(e => console.error("tick", e)), 60 * 1000);

// ---------- http ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));

function cookies(req) {
  const o = {}; (req.headers.cookie || "").split(";").forEach(c => { const i = c.indexOf("="); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return o;
}
function who(req) { const id = st.tokens[cookies(req).fk]; return id ? byId[id] : null; }
const need = (req, res) => { const u = who(req); if (!u) { res.status(401).json({ error: "no_user" }); return null; } return u; };

// вход по личной ссылке
app.get("/", (req, res, next) => {
  const t = req.query.k;
  if (typeof t === "string" && st.tokens[t]) {
    res.setHeader("Set-Cookie", `fk=${t}; Path=/; Max-Age=${3600 * 24 * 365}; HttpOnly; SameSite=Lax${req.secure ? "; Secure" : ""}`);
    return res.redirect("/");
  }
  next();
});

app.get("/admin", (req, res) => {
  const k = String(req.query.key || "");
  const ok = ADMIN_KEY && k.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));
  if (!ok) return res.status(403).send("Нет доступа");
  const base = `${req.protocol}://${req.get("host")}`;
  const rows = PEOPLE.map(p => {
    const t = Object.keys(st.tokens).find(x => st.tokens[x] === p.id);
    const u = `${base}/?k=${t}`;
    return `<tr><td>${p.name}</td><td>${p.role === "parent" ? "родитель" : "ребёнок"}</td><td>${(st.subs[p.id] || []).length ? "включены" : "нет"}</td><td><input readonly value="${u}" onclick="this.select()" style="width:100%"></td></tr>`;
  }).join("");
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Личные ссылки</title>
<style>body{font:15px system-ui;margin:20px;max-width:900px}td,th{padding:8px;border-bottom:1px solid #ccc;text-align:left}table{width:100%;border-collapse:collapse}</style>
<h1>Личные ссылки</h1><p>Отправьте каждому его ссылку. Ссылка работает как пароль: не пересылайте её другим.</p>
<table><tr><th>Кто</th><th>Роль</th><th>Уведомления</th><th>Ссылка</th></tr>${rows}</table>`);
});

app.get("/api/me", (req, res) => {
  const u = who(req); if (!u) return res.json({ user: null });
  res.json({ user: { id: u.id, role: u.role, person: u.person ?? null, name: u.name }, vapid: st.vapid.publicKey, tz: TZ, subscribed: (st.subs[u.id] || []).length > 0 });
});

app.get("/api/state", (req, res) => {
  const u = need(req, res); if (!u) return;
  const from = S.iso(S.addDays(todayDate(), -45));
  const done = Object.keys(st.done).filter(k => k.slice(0, 10) >= from);
  const notes = st.notes.filter(n => u.role === "parent" || (n.to === u.person && !n.seenBy.includes(u.id)))
    .slice(-40).map(n => ({ id: n.id, to: n.to, text: n.text, at: n.at }));
  const status = Object.fromEntries(S.NAMES.map((_, i) => [i, (st.subs["k" + i] || []).length > 0]));
  res.json({ done, colors: st.colors, notes, notifyOn: u.role === "parent" ? status : undefined });
});

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})_([0-3])_([a-zA-Z]+)$/;
app.post("/api/done", (req, res) => {
  const u = need(req, res); if (!u) return;
  const { key, on } = req.body || {};
  const m = typeof key === "string" && KEY_RE.exec(key);
  if (!m) return res.status(400).json({ error: "bad_key" });
  const p = +m[4], t = m[5], d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (!S.TASKS[t] || !S.assign(d)[p].includes(t)) return res.status(400).json({ error: "bad_task" });
  if (u.role === "kid" && u.person !== p) return res.status(403).json({ error: "forbidden" });
  if (on) st.done[key] = { by: u.id, at: Date.now() }; else delete st.done[key];
  save(); res.json({ ok: true });
});

app.post("/api/color", (req, res) => {
  const u = need(req, res); if (!u) return;
  if (u.role !== "kid") return res.status(403).json({ error: "forbidden" });
  const hue = Number(req.body && req.body.hue);
  if (!S.HUES.includes(hue)) return res.status(400).json({ error: "bad_hue" });
  st.colors[u.person] = hue; save(); res.json({ ok: true });
});

app.post("/api/notes", async (req, res) => {
  const u = need(req, res); if (!u) return;
  if (u.role !== "parent") return res.status(403).json({ error: "forbidden" });
  const to = Number(req.body && req.body.to), text = String((req.body && req.body.text) || "").trim().slice(0, 200);
  if (!(to >= 0 && to <= 3) || !text) return res.status(400).json({ error: "bad_note" });
  const n = { id: rnd().slice(0, 12), to, text, at: Date.now(), from: u.id, seenBy: [] };
  st.notes.push(n); if (st.notes.length > 200) st.notes.splice(0, st.notes.length - 200);
  save();
  const sent = await push("k" + to, { title: "Сообщение от родителя", body: text, tag: "note-" + n.id });
  res.json({ ok: true, delivered: sent });
});
app.delete("/api/notes/:id", (req, res) => {
  const u = need(req, res); if (!u) return;
  if (u.role !== "parent") return res.status(403).json({ error: "forbidden" });
  st.notes = st.notes.filter(n => n.id !== req.params.id); save(); res.json({ ok: true });
});
app.post("/api/notes/:id/seen", (req, res) => {
  const u = need(req, res); if (!u) return;
  const n = st.notes.find(x => x.id === req.params.id);
  if (n && n.to === u.person && !n.seenBy.includes(u.id)) { n.seenBy.push(u.id); save(); }
  res.json({ ok: true });
});

app.post("/api/push/subscribe", (req, res) => {
  const u = need(req, res); if (!u) return;
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://") || !sub.keys) return res.status(400).json({ error: "bad_sub" });
  const list = (st.subs[u.id] || []).filter(s => s.endpoint !== sub.endpoint);
  list.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
  st.subs[u.id] = list.slice(-5); save(); res.json({ ok: true });
});
app.post("/api/push/test", async (req, res) => {
  const u = need(req, res); if (!u) return;
  const n = await push(u.id, { title: "Домашние дела", body: "Проверка уведомлений: всё работает.", tag: "test" });
  res.json({ ok: true, devices: n });
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: 0 }));
for (const p of PEOPLE) { const t = Object.keys(st.tokens).find(x => st.tokens[x] === p.id); console.log("Личная ссылка, " + p.name + ": /?k=" + t); }
app.listen(PORT, () => console.log("Домашние дела: порт " + PORT + ", часовой пояс " + TZ + ", родители: " + PARENTS.join(", ")));
module.exports = { tick, dayStatus };
