// Домашние дела на Cloudflare Workers: API, база D1, push-уведомления и расписание рассылок.
import { buildPushPayload } from "@block65/webcrypto-web-push";
import S from "../public/schedule.js";

const TZ = "Europe/Moscow";
const WHO = ["k0", "k1", "k2", "k3", "parent"];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

// ---------- база ----------
let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch([
    "CREATE TABLE IF NOT EXISTS done (key TEXT PRIMARY KEY, by TEXT, at INTEGER)",
    "CREATE TABLE IF NOT EXISTS colors (person INTEGER PRIMARY KEY, hue INTEGER)",
    "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, to_p INTEGER, text TEXT, at INTEGER, seen INTEGER DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, who TEXT, p256dh TEXT, auth TEXT)",
    "CREATE TABLE IF NOT EXISTS sent (k TEXT PRIMARY KEY)",
    "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)"
  ].map(q => db.prepare(q)));
  ready = true;
}

// ---------- ключи VAPID (создаются один раз и хранятся в базе) ----------
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
async function vapid(db) {
  const row = await db.prepare("SELECT v FROM kv WHERE k='vapid'").first();
  if (row) return JSON.parse(row.v);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = new Uint8Array([4, ...unb64u(jwk.x), ...unb64u(jwk.y)]);
  const keys = { publicKey: b64u(pub), privateKey: jwk.d };
  await db.prepare("INSERT OR IGNORE INTO kv (k,v) VALUES ('vapid',?)").bind(JSON.stringify(keys)).run();
  const again = await db.prepare("SELECT v FROM kv WHERE k='vapid'").first();
  return JSON.parse(again.v);
}

// ---------- push ----------
async function pushTo(env, who, payload) {
  const { results } = await env.DB.prepare("SELECT endpoint,p256dh,auth FROM subs WHERE who=?").bind(who).all();
  if (!results.length) return 0;
  const keys = await vapid(env.DB);
  const v = { subject: env.SUBJECT || "https://example.com", publicKey: keys.publicKey, privateKey: keys.privateKey };
  let ok = 0;
  for (const s of results) {
    try {
      const req = await buildPushPayload({ data: JSON.stringify(payload), options: { ttl: 6 * 3600 } },
        { endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.p256dh, auth: s.auth } }, v);
      const r = await fetch(s.endpoint, req);
      if (r.status === 404 || r.status === 410) await env.DB.prepare("DELETE FROM subs WHERE endpoint=?").bind(s.endpoint).run();
      else if (r.ok) ok++;
    } catch (e) { console.log("push failed", String(e)); }
  }
  return ok;
}

// ---------- время ----------
function nowParts() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const o = {}; f.formatToParts(new Date()).forEach(p => (o[p.type] = p.value));
  return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24 };
}
const todayDate = () => { const n = nowParts(); return new Date(n.y, n.m - 1, n.d); };
const leftText = left => left.map(t => S.TASKS[t][0]).join(", ");

async function dayStatus(db, d) {
  const ds = S.iso(d);
  const { results } = await db.prepare("SELECT key FROM done WHERE key >= ? AND key < ?").bind(ds + "_", ds + "`").all();
  const done = new Set(results.map(r => r.key));
  return S.assign(d).map((list, p) => {
    const left = list.filter(t => !done.has(S.key(d, p, t)));
    const total = S.sumPts(list);
    return { p, total, got: total - S.sumPts(left), left };
  });
}

// ---------- рассылки по расписанию ----------
async function tick(env) {
  await init(env.DB);
  const n = nowParts(), d = todayDate(), ds = S.iso(d);
  const once = async (slot, from, to) => {
    if (n.h < from || n.h >= to) return false;
    const r = await env.DB.prepare("INSERT OR IGNORE INTO sent (k) VALUES (?)").bind(ds + "_" + slot).run();
    return r.meta.changes > 0;
  };
  const kinds = [["r13", 13, 15], ["r18", 18, 20], ["r20", 20, 22], ["digest", 21, 24]];
  let status = null;
  for (const [slot, from, to] of kinds) {
    if (n.h < from || n.h >= to) continue;
    const already = await env.DB.prepare("SELECT 1 FROM sent WHERE k=?").bind(ds + "_" + slot).first();
    if (already) continue;
    status = status || await dayStatus(env.DB, d);
    if (!(await once(slot, from, to))) continue;
    if (slot === "r13") {
      for (const s of status) if (s.left.includes("dishAM")) await pushTo(env, "k" + s.p, { title: "Посуда до обеда", body: "Мытьё посуды до обеда ещё не отмечено.", tag: "r13" });
    } else if (slot === "r18") {
      for (const s of status) if (s.left.length) await pushTo(env, "k" + s.p, { title: "Осталось сделать", body: leftText(s.left), tag: "r18" });
    } else if (slot === "r20") {
      for (const s of status) if (s.left.length) await pushTo(env, "k" + s.p, { title: "Уже поздно, а дела не сделаны", body: leftText(s.left), tag: "r20" });
    } else {
      const lines = status.map(s => {
        const name = S.NAMES[s.p];
        if (s.got === s.total) return `${name}: ${s.got} из ${s.total}. Сделано всё, можно похвалить.`;
        if (s.got === 0) return `${name}: 0 из ${s.total}. Ничего не отмечено, стоит поговорить.`;
        return `${name}: ${s.got} из ${s.total}. Осталось: ${leftText(s.left)}.`;
      });
      await pushTo(env, "parent", { title: "Сводка дня, " + S.fmt(d), body: lines.join("\n"), tag: "digest" });
    }
  }
  const old = S.iso(S.addDays(d, -3));
  await env.DB.prepare("DELETE FROM sent WHERE k < ?").bind(old).run();
}

// ---------- API ----------
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})_([0-3])_([a-zA-Z]+)$/;
async function api(request, env, ctx) {
  await init(env.DB);
  const url = new URL(request.url), path = url.pathname, m = request.method;
  const who = request.headers.get("x-who");
  if (!WHO.includes(who)) return json({ error: "no_user" }, 401);
  const parent = who === "parent", person = parent ? null : +who.slice(1);
  const body = m === "POST" ? await request.json().catch(() => ({})) : {};

  if (path === "/api/state" && m === "GET") {
    const from = S.iso(S.addDays(todayDate(), -45));
    const [done, colors, notes, subs, keys] = await Promise.all([
      env.DB.prepare("SELECT key FROM done WHERE key >= ?").bind(from).all(),
      env.DB.prepare("SELECT person,hue FROM colors").all(),
      parent ? env.DB.prepare("SELECT id,to_p,text,at FROM notes ORDER BY at DESC LIMIT 40").all()
             : env.DB.prepare("SELECT id,to_p,text,at FROM notes WHERE to_p=? AND seen=0 ORDER BY at").bind(person).all(),
      env.DB.prepare("SELECT who, COUNT(*) c FROM subs GROUP BY who").all(),
      vapid(env.DB)
    ]);
    const have = Object.fromEntries(subs.results.map(r => [r.who, r.c > 0]));
    return json({
      done: done.results.map(r => r.key),
      colors: Object.fromEntries(colors.results.map(r => [r.person, r.hue])),
      notes: notes.results.map(r => ({ id: r.id, to: r.to_p, text: r.text, at: r.at })),
      notifyOn: parent ? Object.fromEntries([0, 1, 2, 3].map(i => [i, !!have["k" + i]])) : undefined,
      subscribed: !!have[who],
      vapid: keys.publicKey
    });
  }
  if (path === "/api/done" && m === "POST") {
    const k = typeof body.key === "string" && KEY_RE.exec(body.key);
    if (!k) return json({ error: "bad_key" }, 400);
    const p = +k[4], t = k[5], d = new Date(+k[1], +k[2] - 1, +k[3]);
    if (!S.TASKS[t] || !S.assign(d)[p].includes(t)) return json({ error: "bad_task" }, 400);
    if (!parent && person !== p) return json({ error: "forbidden" }, 403);
    if (body.on) await env.DB.prepare("INSERT OR REPLACE INTO done (key,by,at) VALUES (?,?,?)").bind(body.key, who, Date.now()).run();
    else await env.DB.prepare("DELETE FROM done WHERE key=?").bind(body.key).run();
    return json({ ok: true });
  }
  if (path === "/api/color" && m === "POST") {
    if (parent) return json({ error: "forbidden" }, 403);
    const hue = Number(body.hue);
    if (!S.HUES.includes(hue)) return json({ error: "bad_hue" }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO colors (person,hue) VALUES (?,?)").bind(person, hue).run();
    return json({ ok: true });
  }
  if (path === "/api/notes" && m === "POST") {
    if (!parent) return json({ error: "forbidden" }, 403);
    const to = Number(body.to), text = String(body.text || "").trim().slice(0, 200);
    if (!(to >= 0 && to <= 3) || !text) return json({ error: "bad_note" }, 400);
    const id = rid();
    await env.DB.prepare("INSERT INTO notes (id,to_p,text,at) VALUES (?,?,?,?)").bind(id, to, text, Date.now()).run();
    ctx.waitUntil(pushTo(env, "k" + to, { title: "Сообщение от родителя", body: text, tag: "note-" + id }));
    return json({ ok: true });
  }
  const nm = /^\/api\/notes\/([a-f0-9]+)(\/seen)?$/.exec(path);
  if (nm && m === "DELETE" && parent) { await env.DB.prepare("DELETE FROM notes WHERE id=?").bind(nm[1]).run(); return json({ ok: true }); }
  if (nm && nm[2] && m === "POST" && !parent) { await env.DB.prepare("UPDATE notes SET seen=1 WHERE id=? AND to_p=?").bind(nm[1], person).run(); return json({ ok: true }); }
  if (path === "/api/push/subscribe" && m === "POST") {
    const s = body.subscription;
    if (!s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: "bad_sub" }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO subs (endpoint,who,p256dh,auth) VALUES (?,?,?,?)").bind(s.endpoint, who, String(s.keys.p256dh), String(s.keys.auth)).run();
    return json({ ok: true });
  }
  if (path === "/api/push/test" && m === "POST") {
    const n = await pushTo(env, who, { title: "Домашние дела", body: "Проверка уведомлений: всё работает.", tag: "test" });
    return json({ ok: true, devices: n });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      try { return await api(request, env, ctx); } catch (e) { console.log("api error", String(e)); return json({ error: "server" }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); }
};
