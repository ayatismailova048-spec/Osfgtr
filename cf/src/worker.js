// Домашние дела на Cloudflare Workers: API, хранилище (Durable Object с SQLite), push и рассылки по расписанию.
import { DurableObject } from "cloudflare:workers";
import { buildPushPayload } from "@block65/webcrypto-web-push";
import S from "../public/schedule.js";
import ASSETS from "./assets.js";

const TZ = "Europe/Moscow";
const WHO = ["k0", "k1", "k2", "k3", "parent"];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

function nowParts() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const o = {}; f.formatToParts(new Date()).forEach(p => (o[p.type] = p.value));
  return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24 };
}
const todayDate = () => { const n = nowParts(); return new Date(n.y, n.m - 1, n.d); };
const leftText = left => left.map(t => S.TASKS[t][0]).join(", ");
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})_([0-3])_([a-zA-Z]+)$/;

export class Family extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const q of [
      "CREATE TABLE IF NOT EXISTS done (key TEXT PRIMARY KEY, by TEXT, at INTEGER)",
      "CREATE TABLE IF NOT EXISTS colors (person INTEGER PRIMARY KEY, hue INTEGER)",
      "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, to_p INTEGER, text TEXT, at INTEGER, seen INTEGER DEFAULT 0)",
      "CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, who TEXT, p256dh TEXT, auth TEXT)",
      "CREATE TABLE IF NOT EXISTS sent (k TEXT PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)"
    ]) this.sql.exec(q);
  }
  q(query, ...b) { return this.sql.exec(query, ...b).toArray(); }

  async vapid() {
    const row = this.q("SELECT v FROM kv WHERE k='vapid'")[0];
    if (row) return JSON.parse(row.v);
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pub = new Uint8Array([4, ...unb64u(jwk.x), ...unb64u(jwk.y)]);
    const keys = { publicKey: b64u(pub), privateKey: jwk.d };
    this.q("INSERT OR IGNORE INTO kv (k,v) VALUES ('vapid',?)", JSON.stringify(keys));
    return JSON.parse(this.q("SELECT v FROM kv WHERE k='vapid'")[0].v);
  }

  async pushTo(who, payload) {
    const subs = this.q("SELECT endpoint,p256dh,auth FROM subs WHERE who=?", who);
    if (!subs.length) return 0;
    const keys = await this.vapid();
    const v = { subject: this.env.SUBJECT || "https://example.com", publicKey: keys.publicKey, privateKey: keys.privateKey };
    let ok = 0;
    for (const s of subs) {
      try {
        const req = await buildPushPayload({ data: JSON.stringify(payload), options: { ttl: 6 * 3600 } },
          { endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.p256dh, auth: s.auth } }, v);
        const r = await fetch(s.endpoint, req);
        if (r.status === 404 || r.status === 410) this.q("DELETE FROM subs WHERE endpoint=?", s.endpoint);
        else if (r.ok) ok++;
      } catch (e) { console.log("push failed", String(e)); }
    }
    return ok;
  }

  // дела на сегодня: свои и перенесённые с прошлых дней
  dayStatus(d) {
    const done = new Set(this.q("SELECT key FROM done WHERE key >= ?", S.iso(S.addDays(d, -8))).map(r => r.key));
    return S.assign(d).map((list, p) => {
      const car = S.carried(done, d, p).map(c => c.t);
      const all = list.concat(car);
      const left = list.filter(t => !done.has(S.key(d, p, t))).concat(car);
      const total = S.sumPts(all);
      return { p, total, got: total - S.sumPts(left), left };
    });
  }
  hueOf(p) { const r = this.q("SELECT hue FROM colors WHERE person=?", p)[0]; return r ? r.hue : S.DEFHUE[p]; }

  // вызывается по расписанию каждые 5 минут
  async tick() {
    const n = nowParts(), d = todayDate(), ds = S.iso(d);
    let status = null;
    for (const [slot, from, to] of [["r13", 13, 15], ["r18", 18, 20], ["r20", 20, 22], ["digest", 21, 24]]) {
      if (n.h < from || n.h >= to) continue;
      if (this.q("SELECT 1 FROM sent WHERE k=?", ds + "_" + slot).length) continue;
      this.q("INSERT INTO sent (k) VALUES (?)", ds + "_" + slot);
      status = status || this.dayStatus(d);
      if (slot === "r13") {
        for (const s of status) if (s.left.includes("dishAM")) await this.pushTo("k" + s.p, { title: "Посуда до обеда", body: "Мытьё посуды до обеда ещё не отмечено.", tag: "r13" });
      } else if (slot === "r18") {
        for (const s of status) if (s.left.length) await this.pushTo("k" + s.p, { title: "Осталось сделать", body: leftText(s.left), tag: "r18" });
      } else if (slot === "r20") {
        for (const s of status) if (s.left.length) await this.pushTo("k" + s.p, { title: "Уже поздно, а дела не сделаны", body: leftText(s.left), tag: "r20" });
      } else {
        const lines = status.map(s => {
          const name = S.NAMES[s.p];
          if (s.got === s.total) return `${name}: ${s.got} из ${s.total}. Сделано всё, можно похвалить.`;
          if (s.got === 0) return `${name}: 0 из ${s.total}. Ничего не отмечено, стоит поговорить.`;
          return `${name}: ${s.got} из ${s.total}. Осталось: ${leftText(s.left)}.`;
        });
        await this.pushTo("parent", { title: "Сводка дня, " + S.fmt(d), body: lines.join("\n"), tag: "digest" });
      }
    }
    this.q("DELETE FROM sent WHERE k < ?", S.iso(S.addDays(d, -3)));
  }

  async fetch(request) {
    const url = new URL(request.url), path = url.pathname, m = request.method;
    const who = request.headers.get("x-who");
    if (!WHO.includes(who)) return json({ error: "no_user" }, 401);
    const parent = who === "parent", person = parent ? null : +who.slice(1);
    const body = m === "POST" ? await request.json().catch(() => ({})) : {};

    if (path === "/api/state" && m === "GET") {
      const from = S.iso(S.addDays(todayDate(), -45));
      const have = Object.fromEntries(this.q("SELECT who, COUNT(*) c FROM subs GROUP BY who").map(r => [r.who, r.c > 0]));
      const notes = parent ? this.q("SELECT id,to_p,text,at FROM notes ORDER BY at DESC LIMIT 40")
                           : this.q("SELECT id,to_p,text,at FROM notes WHERE to_p=? AND seen=0 ORDER BY at", person);
      return json({
        done: this.q("SELECT key FROM done WHERE key >= ?", from).map(r => r.key),
        colors: Object.fromEntries(this.q("SELECT person,hue FROM colors").map(r => [r.person, r.hue])),
        notes: notes.map(r => ({ id: r.id, to: r.to_p, text: r.text, at: r.at })),
        notifyOn: parent ? Object.fromEntries([0, 1, 2, 3].map(i => [i, !!have["k" + i]])) : undefined,
        subscribed: !!have[who],
        vapid: (await this.vapid()).publicKey
      });
    }
    if (path === "/api/done" && m === "POST") {
      const k = typeof body.key === "string" && KEY_RE.exec(body.key);
      if (!k) return json({ error: "bad_key" }, 400);
      const p = +k[4], t = k[5], d = new Date(+k[1], +k[2] - 1, +k[3]);
      if (!S.TASKS[t] || !S.assign(d)[p].includes(t)) return json({ error: "bad_task" }, 400);
      if (!parent && person !== p) return json({ error: "forbidden" }, 403);
      if (body.on) this.q("INSERT OR REPLACE INTO done (key,by,at) VALUES (?,?,?)", body.key, who, Date.now());
      else this.q("DELETE FROM done WHERE key=?", body.key);
      return json({ ok: true });
    }
    if (path === "/api/color" && m === "POST") {
      if (parent) return json({ error: "forbidden" }, 403);
      const hue = Number(body.hue);
      if (!S.HUES.includes(hue)) return json({ error: "bad_hue" }, 400);
      if ([0, 1, 2, 3].some(i => i !== person && this.hueOf(i) === hue)) return json({ error: "taken" }, 409);
      this.q("INSERT OR REPLACE INTO colors (person,hue) VALUES (?,?)", person, hue);
      return json({ ok: true });
    }
    if (path === "/api/notes" && m === "POST") {
      if (!parent) return json({ error: "forbidden" }, 403);
      const to = Number(body.to), text = String(body.text || "").trim().slice(0, 200);
      if (!(to >= 0 && to <= 3) || !text) return json({ error: "bad_note" }, 400);
      const id = rid();
      this.q("INSERT INTO notes (id,to_p,text,at) VALUES (?,?,?,?)", id, to, text, Date.now());
      await this.pushTo("k" + to, { title: "Сообщение от родителя", body: text, tag: "note-" + id });
      return json({ ok: true });
    }
    const nm = /^\/api\/notes\/([a-f0-9]+)(\/seen)?$/.exec(path);
    if (nm && m === "DELETE" && parent) { this.q("DELETE FROM notes WHERE id=?", nm[1]); return json({ ok: true }); }
    if (nm && nm[2] && m === "POST" && !parent) { this.q("UPDATE notes SET seen=1 WHERE id=? AND to_p=?", nm[1], person); return json({ ok: true }); }
    if (path === "/api/push/subscribe" && m === "POST") {
      const s = body.subscription;
      if (!s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: "bad_sub" }, 400);
      this.q("INSERT OR REPLACE INTO subs (endpoint,who,p256dh,auth) VALUES (?,?,?,?)", s.endpoint, who, String(s.keys.p256dh), String(s.keys.auth));
      return json({ ok: true });
    }
    if (path === "/api/push/test" && m === "POST") {
      const n = await this.pushTo(who, { title: "Домашние дела", body: "Проверка уведомлений: всё работает.", tag: "test" });
      return json({ ok: true, devices: n });
    }
    return json({ error: "not_found" }, 404);
  }
}

const family = env => env.FAMILY.get(env.FAMILY.idFromName("family"));

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      try { return await family(env).fetch(request); } catch (e) { console.log("api error", String(e)); return json({ error: "server" }, 500); }
    }
    const f = ASSETS[pathname === "/" ? "/index.html" : pathname];
    if (!f) return new Response("Not found", { status: 404 });
    const bytes = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0));
    return new Response(bytes, { headers: { "content-type": f.type, "cache-control": "no-cache" } });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(family(env).tick()); }
};
