/* 옥정섬 SOS · 클리어 아레나 서버
 * 실행: node server.js            (필요한 것: Node.js 18 이상. npm install 필요 없음)
 * 환경 변수: PORT(기본 3000), ADMIN_KEY(관리자 비밀번호, 없으면 실행할 때마다 새로 만듦)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = +process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(3).toString('hex');
const PUB = path.join(__dirname, 'public');

/* ======================= tiny static server ======================= */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/admin' || p === '/tv') p = '/admin.html';
  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('없는 페이지예요'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

/* ======================= minimal WebSocket (RFC 6455, text frames) ======================= */
const MAX_MSG = 16 * 1024;
class Conn {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.frag = null; this.open = true; this.alive = true;
    sock.on('data', d => this.onData(d));
    sock.on('close', () => this.close());
    sock.on('error', () => this.close());
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > MAX_MSG * 4) return this.close();
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1], fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; const hi = this.buf.readUInt32BE(2); len = this.buf.readUInt32BE(6); if (hi) return this.close(); off = 10; }
      if (len > MAX_MSG) return this.close();
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = this.buf.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = this.buf.subarray(need);
      if (op === 8) return this.close();
      if (op === 9) { this.raw(0x8a, payload); continue; }
      if (op === 10) { this.alive = true; continue; }
      if (op === 1 || op === 0) {
        this.frag = this.frag ? Buffer.concat([this.frag, payload]) : payload;
        if (this.frag.length > MAX_MSG) return this.close();
        if (fin) { const s = this.frag.toString('utf8'); this.frag = null; let msg; try { msg = JSON.parse(s); } catch (e) { continue; } if (this.onmsg) this.onmsg(msg); }
      }
    }
  }
  raw(b0, payload) {
    if (!this.open) return;
    const len = payload.length; let head;
    if (len < 126) head = Buffer.from([b0, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = b0; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = b0; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    try { this.sock.write(Buffer.concat([head, payload])); } catch (e) { this.close(); }
  }
  send(obj) { this.raw(0x81, Buffer.from(JSON.stringify(obj))); }
  ping() { this.raw(0x89, Buffer.alloc(0)); }
  close() { if (!this.open) return; this.open = false; try { this.sock.end(); this.sock.destroy(); } catch (e) { /* ignore */ } if (this.onclose) this.onclose(); }
}
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  onConnect(new Conn(sock));
});
setInterval(() => { for (const c of conns) { if (!c.alive) { c.close(); continue; } c.alive = false; c.ping(); } }, 20000);

/* ======================= game constants ======================= */
const R = 62;                          // island radius
const TICK = 1 / 20;
const MAXLV = 10;
const xpNeed = lv => 30 + (lv - 1) * 25;
const SKILLS = {
  punch: { lv: 1, cd: .45 }, dash: { lv: 2, cd: 8 }, whirl: { lv: 3, cd: 7 }, cannon: { lv: 4, cd: 6 },
  heal: { lv: 5, cd: 18 }, shield: { lv: 6, cd: 16 }, thunder: { lv: 7, cd: 10 }, tornado: { lv: 8, cd: 14 }
};
const MON = {
  snail: { hp: 26, spd: 1.2, dmg: 6, xp: 10, coins: [3, 5], r: .7, aggro: 9, lv: 1 },
  slime: { hp: 46, spd: 2.4, dmg: 8, xp: 16, coins: [5, 8], r: .8, aggro: 11, lv: 2 },
  bee: { hp: 32, spd: 5, dmg: 7, xp: 20, coins: [7, 11], r: .6, aggro: 15, lv: 3 },
  boar: { hp: 90, spd: 3.2, dmg: 14, xp: 38, coins: [14, 20], r: 1, aggro: 15, lv: 5 },
  golem: { hp: 220, spd: 2.2, dmg: 24, xp: 80, coins: [30, 44], r: 1.5, aggro: 12, lv: 7 }
};
const UPG = [60, 120, 200, 300];       // forge cost to reach tier 1..4
const GEARN = ['맨손', '스패너', '토크 렌치', '돌풍 해머', '태풍 블레이드'];
const ARMN = ['작업복', '작업 조끼', '방풍 재킷', '탄소섬유 슈트', '태풍 갑옷'];
const ARENA_SALT = 'oksland-arena';

/* ======================= map ======================= */
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const OBS = [];
(function buildMap() {
  const r = rng(20261012);
  OBS.push([0, 0, 3.2, 'forge']);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + .3; OBS.push([Math.cos(a) * 38, Math.sin(a) * 38, 1.1, 'turbine']); }
  let tries = 0;
  while (OBS.length < 70 && tries++ < 4000) {
    const a = r() * Math.PI * 2, d = 9 + Math.sqrt(r()) * (R - 14), x = Math.cos(a) * d, z = Math.sin(a) * d;
    const kind = r() < .55 ? 'tree' : 'rock', rad = kind === 'tree' ? .7 + r() * .3 : .9 + r() * 1.4;
    if (OBS.some(o => Math.hypot(o[0] - x, o[1] - z) < o[2] + rad + 3)) continue;
    OBS.push([+x.toFixed(2), +z.toFixed(2), +rad.toFixed(2), kind]);
  }
})();
function collide(x, z, rad) {
  for (const o of OBS) {
    const dx = x - o[0], dz = z - o[1], d = Math.hypot(dx, dz), m = o[2] + rad;
    if (d < m && d > 1e-4) { x = o[0] + dx / d * m; z = o[1] + dz / d * m; }
  }
  const d = Math.hypot(x, z), lim = R - 1.2;
  if (d > lim) { x *= lim / d; z *= lim / d; }
  return [x, z];
}
function freeSpot(minPlayerDist) {
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2, d = 6 + Math.random() * (zoneR() - 10), x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (OBS.some(o => Math.hypot(o[0] - x, o[1] - z) < o[2] + 1.5)) continue;
    if ([...players.values()].some(p => p.alive && online(p) && Math.hypot(p.x - x, p.z - z) < minPlayerDist)) continue;
    return [x, z];
  }
  return [4, 4];
}

/* ======================= state ======================= */
const conns = new Set();
const players = new Map();   // id -> player
const mons = new Map();
const projs = [];
const picks = new Map();
const pending = [];          // delayed strikes (thunder)
let nextId = 1;
const round = { phase: 'free', endsAt: 0, len: 0, zone0: 0, final: null };
let gate = true;
function zoneR() {
  if (round.phase !== 'play') return R;
  const total = round.len, left = (round.endsAt - Date.now()) / 1000, shrink = Math.min(150, total * .4);
  if (left > shrink) return R;
  const k = 1 - Math.max(0, left) / shrink;
  return R - (R - 14) * k;
}

const online = p => !!(p.c && p.c.open);
const stat = p => ({
  maxHp: 100 + (p.lv - 1) * 15 + p.arm * 22,
  atk: 10 + (p.lv - 1) * 4 + p.wpn * 5,
  def: p.arm * .06,
  spd: 7.6 * (1 + (p.lv - 1) * .04) * (p.dashT > 0 ? 1.8 : 1)
});
function newPlayer(c, name) {
  const [x, z] = freeSpot(10);
  const p = { id: nextId++, c, name, x, z, dir: 0, mx: 0, mz: 0, lv: 1, xp: 0, coins: 0, wpn: 0, arm: 0, hp: 100, kills: 0, deaths: 0, streak: 0, best: 0,
    alive: true, respawnAt: 0, prot: Date.now() + 3000, cds: {}, dashT: 0, shieldT: 0, lastHurt: 0, dmgBy: new Map(), joined: Date.now(), lastIn: Date.now() };
  p.hp = stat(p).maxHp;
  return p;
}
function resetPlayer(p) {
  p.lv = 1; p.xp = 0; p.coins = 0; p.wpn = 0; p.arm = 0; p.kills = 0; p.deaths = 0; p.streak = 0; p.best = 0; p.cds = {}; p.dashT = 0; p.shieldT = 0;
  const [x, z] = freeSpot(10); p.x = x; p.z = z; p.alive = true; p.prot = Date.now() + 3000; p.hp = stat(p).maxHp; p.dmgBy.clear();
}

/* ======================= helpers ======================= */
function broadcast(obj) { const s = JSON.stringify(obj); const buf = Buffer.from(s); for (const c of conns) if (c.open && (c.pid || c.admin)) c.raw(0x81, buf); }
const evq = [];
function ev(o) { evq.push(o); }
function kstYmd(offsetDays = 0) { return new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10).replace(/-/g, ''); }
function clearCode(name, ymd) {
  const s = String(name).replace(/\s+/g, '') + '|' + ymd + '|' + ARENA_SALT;
  let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return String(1000 + (h % 9000));
}
function cleanName(n) { return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14); }
function rankList() {
  return [...players.values()].filter(online).sort((a, b) => b.lv - a.lv || b.xp - a.xp || b.coins - a.coins || b.kills - a.kills);
}
let king = null;  // current #1 id
function bountyOf(p) { return 30 + p.lv * 6 + p.streak * 15; }

function gainXp(p, n) {
  if (p.lv >= MAXLV) return;
  p.xp += n;
  let up = false;
  while (p.lv < MAXLV && p.xp >= xpNeed(p.lv)) { p.xp -= xpNeed(p.lv); p.lv++; up = true; }
  if (p.lv >= MAXLV) p.xp = 0;
  if (up) { p.hp = stat(p).maxHp; ev({ k: 'lv', id: p.id, lv: p.lv }); }
}
function addCoins(p, n) { p.coins += n; }
function dropPick(kind, val, x, z) {
  const id = nextId++;
  const a = Math.random() * Math.PI * 2, d = Math.random() * 1.6;
  let px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;[px, pz] = collide(px, pz, .3);
  picks.set(id, { id, kind, val, x: px, z: pz, ttl: kind === 'coin' ? 40 : 60 });
}

/* ======================= damage & death ======================= */
function hurtPlayer(v, dmg, src) {
  if (!v.alive || Date.now() < v.prot) return;
  const st = stat(v);
  let d = dmg * (1 - st.def) * (v.shieldT > 0 ? .4 : 1);
  d = Math.max(1, Math.round(d));
  v.hp -= d; v.lastHurt = Date.now();
  if (src && src.kind === 'p') { v.dmgBy.set(src.p.id, Date.now()); src.p.lastHurt = Date.now(); }
  ev({ k: 'hit', t: 'p', id: v.id, d, x: +v.x.toFixed(1), z: +v.z.toFixed(1) });
  if (v.hp <= 0) killPlayer(v, src);
}
function killPlayer(v, src) {
  v.hp = 0; v.alive = false; v.respawnAt = Date.now() + 5000; v.deaths++;
  const vLv = v.lv;
  const wasKing = king === v.id, bounty = wasKing ? bountyOf(v) : 0;
  // penalties: 30% coins dropped, one gear tier dropped, XP loss (may level down)
  const lost = Math.floor(v.coins * .3); v.coins -= lost;
  if (lost > 0) { const n = Math.min(6, Math.max(1, Math.ceil(lost / 15))); for (let i = 0; i < n; i++) dropPick('coin', Math.floor(lost / n) + (i < lost % n ? 1 : 0), v.x, v.z); }
  let gearLost = null;
  if (v.wpn > 0 || v.arm > 0) {
    if (v.wpn >= v.arm) { dropPick('wpn', v.wpn, v.x, v.z); v.wpn--; gearLost = GEARN[v.wpn + 1]; }
    else { dropPick('arm', v.arm, v.x, v.z); v.arm--; gearLost = ARMN[v.arm + 1]; }
  }
  const xpLoss = Math.round(xpNeed(v.lv) * .4); let lvDown = false;
  v.xp -= xpLoss; if (v.xp < 0) { if (v.lv > 1) { v.lv--; v.xp = Math.max(0, xpNeed(v.lv) + v.xp); lvDown = true; } else v.xp = 0; }
  v.streak = 0;
  let killer = null, helpers = [];
  if (src && src.kind === 'p' && src.p.id !== v.id) {
    killer = src.p; killer.kills++; killer.streak++; killer.best = Math.max(killer.best, killer.streak);
    gainXp(killer, 20 + vLv * 8); addCoins(killer, 10 + vLv * 3);
  }
  if (bounty) {
    const now = Date.now();
    helpers = [...v.dmgBy.entries()].filter(([id, t]) => now - t < 12000 && players.has(id) && id !== v.id).map(([id]) => players.get(id));
    if (killer && !helpers.includes(killer)) helpers.push(killer);
    if (helpers.length) { const share = Math.ceil(bounty / helpers.length); for (const h of helpers) { addCoins(h, share); gainXp(h, 15); } }
  }
  v.dmgBy.clear();
  ev({ k: 'kill', v: v.id, a: killer ? killer.id : null, src: src && src.kind === 'm' ? src.m.type : src && src.kind === 'z' ? 'zone' : null, bounty, helpers: helpers.map(h => h.id) });
  if (v.c) v.c.send({ t: 'dead', by: killer ? killer.name : src && src.kind === 'm' ? src.m.type : src && src.kind === 'z' ? 'zone' : '?', lost, gearLost, lvDown, xpLoss, respawn: 5 });
}
function hurtMon(m, dmg, p) {
  if (m.dead) return;
  m.hp -= dmg; m.tgt = p.id; m.hitT = .15;
  ev({ k: 'hit', t: 'm', id: m.id, d: dmg, x: +m.x.toFixed(1), z: +m.z.toFixed(1) });
  if (m.hp <= 0) {
    m.dead = true; mons.delete(m.id);
    const def = MON[m.type];
    gainXp(p, def.xp); addCoins(p, def.coins[0] + Math.floor(Math.random() * (def.coins[1] - def.coins[0] + 1)));
    const r = Math.random(), gearP = { snail: .06, slime: .1, bee: .14, boar: .28, golem: .6 }[m.type];
    if (r < gearP) { const tier = Math.min(4, 1 + Math.floor(Math.random() * ({ snail: 1, slime: 1.6, bee: 2, boar: 3, golem: 4 }[m.type]))); dropPick(Math.random() < .5 ? 'wpn' : 'arm', tier, m.x, m.z); }
    else if (r < gearP + .22) dropPick('heal', 30, m.x, m.z);
    ev({ k: 'mdie', id: m.id, x: +m.x.toFixed(1), z: +m.z.toFixed(1), by: p.id, type: m.type });
  }
}

/* ======================= targeting ======================= */
function enemiesNear(p, range) {
  const out = [];
  for (const q of players.values()) if (q !== p && q.alive && online(q) && Date.now() >= q.prot) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d <= range) out.push({ kind: 'p', o: q, d }); }
  for (const m of mons.values()) { const d = Math.hypot(m.x - p.x, m.z - p.z); if (d <= range + MON[m.type].r * .5) out.push({ kind: 'm', o: m, d }); }
  return out.sort((a, b) => a.d - b.d);
}
function hitTarget(p, t, dmg) { if (t.kind === 'p') hurtPlayer(t.o, dmg, { kind: 'p', p }); else hurtMon(t.o, dmg, p); }

/* ======================= actions ======================= */
function useSkill(p, id) {
  const sk = SKILLS[id]; if (!sk || !p.alive || p.lv < sk.lv) return;
  const now = Date.now() / 1000;
  if ((p.cds[id] || 0) > now) return;
  p.cds[id] = now + sk.cd;
  if (p.prot > Date.now() && id !== 'dash' && id !== 'heal' && id !== 'shield') p.prot = 0;   // attacking ends spawn protection
  const st = stat(p);
  if (id === 'punch') {
    const t = enemiesNear(p, 3.4)[0];
    if (t) { p.dir = Math.atan2(t.o.x - p.x, t.o.z - p.z); hitTarget(p, t, st.atk); }
    ev({ k: 'fx', s: 'punch', id: p.id, x: +p.x.toFixed(1), z: +p.z.toFixed(1), a: +p.dir.toFixed(2) });
  } else if (id === 'dash') { p.dashT = 2.5; ev({ k: 'fx', s: 'dash', id: p.id, x: p.x, z: p.z }); }
  else if (id === 'whirl') {
    for (const t of enemiesNear(p, 5.6)) hitTarget(p, t, Math.round(st.atk * 1.5));
    ev({ k: 'fx', s: 'whirl', id: p.id, x: p.x, z: p.z });
  } else if (id === 'cannon' || id === 'tornado') {
    const t = enemiesNear(p, 26)[0], a = t ? Math.atan2(t.o.x - p.x, t.o.z - p.z) : p.dir;
    p.dir = a;
    projs.push(id === 'cannon'
      ? { id: nextId++, kind: 'cannon', by: p.id, x: p.x, z: p.z, dx: Math.sin(a), dz: Math.cos(a), spd: 26, life: 1.1, dmg: Math.round(st.atk * 2.2), hit: new Set(), r: 1 }
      : { id: nextId++, kind: 'tornado', by: p.id, x: p.x, z: p.z, dx: Math.sin(a), dz: Math.cos(a), spd: 6, life: 2.8, dmg: Math.round(st.atk * .7), tick: 0, r: 2.6 });
  } else if (id === 'heal') {
    p.hp = Math.min(st.maxHp, p.hp + st.maxHp * .45); ev({ k: 'fx', s: 'heal', id: p.id, x: p.x, z: p.z });
  } else if (id === 'shield') { p.shieldT = 3; ev({ k: 'fx', s: 'shield', id: p.id, x: p.x, z: p.z }); }
  else if (id === 'thunder') {
    const t = enemiesNear(p, 18)[0]; const x = t ? t.o.x : p.x + Math.sin(p.dir) * 8, z = t ? t.o.z : p.z + Math.cos(p.dir) * 8;
    pending.push({ at: Date.now() + 800, by: p.id, x, z, r: 3.2, dmg: Math.round(st.atk * 3) });
    ev({ k: 'fx', s: 'warn', x: +x.toFixed(1), z: +z.toFixed(1), r: 3.2 });
  }
}
function upgrade(p, what) {
  if (!p.alive) return;
  const cur = what === 'wpn' ? p.wpn : p.arm; if (cur >= 4) return;
  const cost = UPG[cur]; if (p.coins < cost) return p.c && p.c.send({ t: 'msg', s: `코인이 모자라요 (${cost}코인 필요)` });
  if (Date.now() - p.lastHurt < 4000) return p.c && p.c.send({ t: 'msg', s: '싸우는 중에는 강화할 수 없어요. 4초만 숨으세요!' });
  p.coins -= cost; if (what === 'wpn') p.wpn++; else { p.arm++; p.hp += 22; }
  p.c && p.c.send({ t: 'msg', s: `${what === 'wpn' ? GEARN[p.wpn] : ARMN[p.arm]}(으)로 강화했어요!` });
  ev({ k: 'fx', s: 'upg', id: p.id, x: p.x, z: p.z });
}

/* ======================= simulation ======================= */
let monT = 0, lbT = 0, snapT = 0;
function step(dt) {
  const now = Date.now();
  // round
  if (round.phase === 'play' && now >= round.endsAt) endRound();
  const zr = zoneR();
  // players
  for (const p of [...players.values()]) {
    if (!online(p)) { if (now - (p.offAt || now) > 180000) { players.delete(p.id); broadcast({ t: 'ro', gone: p.id, name: p.name }); } continue; }
    if (!p.alive) {
      if (now >= p.respawnAt) { const [x, z] = freeSpot(10); p.x = x; p.z = z; p.alive = true; p.prot = now + 3000; p.hp = stat(p).maxHp; ev({ k: 'spawn', id: p.id }); }
      continue;
    }
    p.dashT -= dt; p.shieldT -= dt;
    const st = stat(p);
    const len = Math.hypot(p.mx, p.mz);
    if (len > .05) {
      const k = Math.min(1, len); const nx = p.x + p.mx / len * st.spd * k * dt, nz = p.z + p.mz / len * st.spd * k * dt;
      [p.x, p.z] = collide(nx, nz, .45); p.dir = Math.atan2(p.mx, p.mz);
    }
    if (now - p.lastHurt > 5000 && p.hp < st.maxHp) p.hp = Math.min(st.maxHp, p.hp + st.maxHp * .04 * dt);
    if (p.hp > st.maxHp) p.hp = st.maxHp;
    if (Math.hypot(p.x, p.z) > zr) { p.zoneAcc = (p.zoneAcc || 0) + dt; if (p.zoneAcc > .5) { p.zoneAcc = 0; hurtPlayer(p, 6 + Math.round(st.maxHp * .03), { kind: 'z' }); } }
    // pickups
    for (const k of picks.values()) {
      if (Math.hypot(k.x - p.x, k.z - p.z) > 1.6) continue;
      if (k.kind === 'coin') addCoins(p, k.val);
      else if (k.kind === 'heal') p.hp = Math.min(st.maxHp, p.hp + st.maxHp * .3);
      else if (k.kind === 'wpn' || k.kind === 'arm') {
        const cur = p[k.kind];
        if (k.val > cur) { p[k.kind] = k.val; p.c && p.c.send({ t: 'msg', s: `${k.kind === 'wpn' ? GEARN[k.val] : ARMN[k.val]} 획득!` }); }
        else { addCoins(p, 15 * k.val); p.c && p.c.send({ t: 'msg', s: `이미 더 좋은 장비라 ${15 * k.val}코인으로 바꿨어요` }); }
      }
      ev({ k: 'pick', id: k.id, by: p.id, kind: k.kind, val: k.val });
      picks.delete(k.id);
    }
  }
  // monsters spawn
  monT -= dt;
  const alive = [...players.values()].filter(p => p.alive && online(p));
  const cap = Math.min(30, 4 + Math.ceil(alive.length * 1.4));
  if (monT <= 0 && alive.length && mons.size < cap) {
    monT = 1.2;
    const avgLv = alive.reduce((s, p) => s + p.lv, 0) / Math.max(1, alive.length);
    const pool = Object.entries(MON).filter(([, d]) => d.lv <= Math.max(2, avgLv + 2));
    const w = pool.map(([k, d]) => k === 'snail' ? Math.max(.6, 4 - avgLv * .4) : k === 'golem' ? .5 + (avgLv - 7) * .3 : 2);
    let r = Math.random() * w.reduce((a, b) => a + b, 0), type = pool[0][0];
    for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) { type = pool[i][0]; break; } }
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2, d = 8 + Math.random() * (zr - 12), x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (OBS.some(o => Math.hypot(o[0] - x, o[1] - z) < o[2] + 2)) continue;
      if (alive.some(p => Math.hypot(p.x - x, p.z - z) < 11)) continue;
      const def = MON[type]; const id = nextId++;
      mons.set(id, { id, type, x, z, hp: def.hp, max: def.hp, dir: Math.random() * 6.28, wT: 0, atkCd: 1, tgt: null, hitT: 0 });
      break;
    }
  }
  // monsters move/attack
  for (const m of mons.values()) {
    const def = MON[m.type];
    let tgt = null, td = def.aggro;
    for (const p of alive) { if (now < p.prot) continue; const d = Math.hypot(p.x - m.x, p.z - m.z); if (d < td || (m.tgt === p.id && d < def.aggro * 1.6)) { if (d < td || !tgt) { tgt = p; td = d; } } }
    let spd = def.spd;
    if (tgt) m.dir = Math.atan2(tgt.x - m.x, tgt.z - m.z) + (m.type === 'bee' ? Math.sin(now / 200 + m.id) * .6 : 0);
    else { spd *= .4; m.wT -= dt; if (m.wT <= 0) { m.wT = 2 + Math.random() * 3; m.dir = Math.random() * 6.28; } }
    const nx = m.x + Math.sin(m.dir) * spd * dt, nz = m.z + Math.cos(m.dir) * spd * dt;
    [m.x, m.z] = collide(nx, nz, def.r * .7);
    if (Math.hypot(m.x, m.z) > zr + 4) { m.dir += Math.PI; }
    m.atkCd -= dt;
    if (tgt && td < def.r + .6 && m.atkCd <= 0) { m.atkCd = 1.1; hurtPlayer(tgt, def.dmg, { kind: 'm', m }); }
  }
  // projectiles
  for (let i = projs.length - 1; i >= 0; i--) {
    const pr = projs[i], owner = players.get(pr.by); pr.life -= dt;
    pr.x += pr.dx * pr.spd * dt; pr.z += pr.dz * pr.spd * dt;
    if (!owner) { projs.splice(i, 1); continue; }
    if (pr.kind === 'cannon') {
      for (const t of enemiesNear({ x: pr.x, z: pr.z, id: -1 }, pr.r + .6)) { if (t.kind === 'p' && t.o.id === pr.by) continue; const key = t.kind + t.o.id; if (pr.hit.has(key)) continue; pr.hit.add(key); hitTarget(owner, t, pr.dmg); }
    } else {
      pr.tick -= dt;
      if (pr.tick <= 0) { pr.tick = .3; for (const t of enemiesNear({ x: pr.x, z: pr.z, id: -1 }, pr.r)) { if (t.kind === 'p' && t.o.id === pr.by) continue; hitTarget(owner, t, pr.dmg); if (t.kind === 'm') { t.o.x += (pr.x - t.o.x) * .15; t.o.z += (pr.z - t.o.z) * .15; } } }
    }
    if (pr.life <= 0 || Math.hypot(pr.x, pr.z) > R + 4) projs.splice(i, 1);
  }
  // delayed strikes
  for (let i = pending.length - 1; i >= 0; i--) {
    const s = pending[i]; if (now < s.at) continue; pending.splice(i, 1);
    const owner = players.get(s.by); ev({ k: 'fx', s: 'thunder', x: +s.x.toFixed(1), z: +s.z.toFixed(1) });
    if (!owner) continue;
    for (const t of enemiesNear({ x: s.x, z: s.z, id: -1 }, s.r)) { if (t.kind === 'p' && t.o.id === s.by) continue; hitTarget(owner, t, s.dmg); }
  }
  // pickups ttl
  for (const k of picks.values()) { k.ttl -= dt; if (k.ttl <= 0) picks.delete(k.id); }
  // king
  const rl = rankList();
  const top = rl[0];
  king = top && rl.length >= 2 && top.lv >= 3 && (!rl[1] || top.lv > rl[1].lv || top.coins > rl[1].coins) ? top.id : null;
  // snapshots 10 Hz
  snapT -= dt;
  if (snapT <= 0) { snapT = .1; sendSnap(rl); }
  lbT -= dt;
  if (lbT <= 0) { lbT = 1; sendBoard(rl); }
}
function sendSnap(rl) {
  const t = Date.now();
  const P = [...players.values()].filter(online).map(p => [p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.dir.toFixed(2), Math.ceil(p.hp), stat(p).maxHp, p.lv, (p.alive ? 1 : 0) | (t < p.prot ? 2 : 0) | (p.shieldT > 0 ? 4 : 0) | (p.dashT > 0 ? 8 : 0) | (king === p.id ? 16 : 0), p.wpn, p.arm]);
  const M = [...mons.values()].map(m => [m.id, m.type, +m.x.toFixed(2), +m.z.toFixed(2), +m.dir.toFixed(2), Math.ceil(m.hp), m.max]);
  const J = projs.map(p => [p.id, p.kind, +p.x.toFixed(2), +p.z.toFixed(2)]);
  const K = [...picks.values()].map(k => [k.id, k.kind, k.val, +k.x.toFixed(2), +k.z.toFixed(2)]);
  const base = { t: 's', tm: t, P, M, J, K, ev: evq.splice(0), zr: +zoneR().toFixed(2), ph: round.phase, left: round.phase === 'play' ? Math.max(0, Math.round((round.endsAt - t) / 1000)) : null };
  const rankOf = new Map(rl.map((p, i) => [p.id, i + 1]));
  for (const c of conns) {
    if (!c.open) continue;
    if (c.admin) { c.send({ ...base, me: undefined }); continue; }
    const p = c.pid && players.get(c.pid); if (!p) continue;
    const nowS = t / 1000, cds = {};
    for (const k in SKILLS) cds[k] = Math.max(0, +((p.cds[k] || 0) - nowS).toFixed(1));
    base.me = { xp: p.xp, need: xpNeed(p.lv), coins: p.coins, wpn: p.wpn, arm: p.arm, kills: p.kills, deaths: p.deaths, streak: p.streak, rank: rankOf.get(p.id), n: rl.length, cds, atk: stat(p).atk, def: Math.round(stat(p).def * 100), respawn: p.alive ? 0 : Math.max(0, Math.ceil((p.respawnAt - t) / 1000)), bounty: king === p.id ? bountyOf(p) : 0, safe: t - p.lastHurt > 4000 };
    c.send(base);
  }
}
function sendBoard(rl) {
  broadcast({ t: 'lb', king, list: rl.map(p => [p.id, p.name, p.lv, p.coins, p.kills, p.deaths, p.best, p.wpn, p.arm]) });
}
function endRound() {
  const rl = rankList();
  round.phase = 'end'; round.final = rl.slice(0, 10).map(p => ({ name: p.name, lv: p.lv, coins: p.coins, kills: p.kills, deaths: p.deaths }));
  broadcast({ t: 'end', top: round.final });
  setTimeout(() => { if (round.phase === 'end') { round.phase = 'free'; broadcast({ t: 'msg', s: '자유 대전으로 돌아왔어요.' }); } }, 30000);
}

/* ======================= connections ======================= */
function onConnect(c) {
  conns.add(c);
  c.onclose = () => {
    conns.delete(c);
    if (c.pid) { const p = players.get(c.pid); if (p && p.c === c) { p.c = null; p.offAt = Date.now(); p.mx = p.mz = 0; broadcast({ t: 'ro', gone: p.id, name: p.name }); } }
  };
  c.onmsg = msg => {
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'join' && !c.pid && !c.admin) {
      const tok = String(msg.tok || '');
      const old = tok && [...players.values()].find(p => p.tok === tok && !online(p));
      if (old) { old.c = c; c.pid = old.id; old.offAt = 0; c.send({ t: 'welcome', id: old.id, name: old.name, tok, R, obs: OBS, skills: SKILLS, upg: UPG, gearN: GEARN, armN: ARMN, ph: round.phase, resumed: true }); broadcast({ t: 'ro', joined: old.id, name: old.name }); return; }
      let name = cleanName(msg.name);
      if (!name) return c.send({ t: 'err', s: '이름을 적어 주세요.' });
      const code = String(msg.code || '').trim();
      if (gate && ![-1, 0, 1].some(d => clearCode(name, kstYmd(d)) === code)) return c.send({ t: 'err', s: '입장 코드가 맞지 않아요. 옥정섬 SOS를 클리어한 화면의 이름과 코드를 그대로 적어 주세요.' });
      const same = [...players.values()].find(p => p.name === name && !online(p));
      if (same) players.delete(same.id);
      if ([...players.values()].some(p => p.name === name)) { let i = 2; while ([...players.values()].some(p => p.name === name + i)) i++; name = name + i; }
      if ([...players.values()].filter(online).length >= 40) return c.send({ t: 'err', s: '아레나가 가득 찼어요 (40명).' });
      const p = newPlayer(c, name); p.tok = crypto.randomBytes(8).toString('hex'); players.set(p.id, p); c.pid = p.id;
      c.send({ t: 'welcome', id: p.id, name, tok: p.tok, R, obs: OBS, skills: SKILLS, upg: UPG, gearN: GEARN, armN: ARMN, ph: round.phase });
      broadcast({ t: 'ro', joined: p.id, name });
      return;
    }
    if (msg.t === 'admin') {
      if (msg.key !== ADMIN_KEY) return c.send({ t: 'err', s: '관리자 비밀번호가 틀렸어요.' });
      c.admin = true; c.send({ t: 'adminok', R, obs: OBS, gate, ph: round.phase, addr: addresses() }); sendBoard(rankList());
      return;
    }
    if (c.admin && msg.t === 'cmd') return adminCmd(c, msg);
    const p = c.pid && players.get(c.pid); if (!p) return;
    p.lastIn = Date.now();
    if (msg.t === 'in') { const mx = +msg.mx || 0, mz = +msg.mz || 0, l = Math.hypot(mx, mz); p.mx = l > 1 ? mx / l : mx; p.mz = l > 1 ? mz / l : mz; }
    else if (msg.t === 'sk') useSkill(p, String(msg.id));
    else if (msg.t === 'up') upgrade(p, msg.w === 'arm' ? 'arm' : 'wpn');
    else if (msg.t === 'emo') { const e = ['좋아!', '도와줘!', '1등 잡자!', 'ㅋㅋㅋ', '미안!', '고마워!'][msg.i | 0]; if (e && (!p.emoT || Date.now() - p.emoT > 2500)) { p.emoT = Date.now(); ev({ k: 'emo', id: p.id, s: e }); } }
  };
}
function adminCmd(c, msg) {
  if (msg.c === 'start') {
    const min = Math.max(2, Math.min(30, +msg.min || 10));
    for (const p of players.values()) resetPlayer(p);
    mons.clear(); projs.length = 0; picks.clear(); pending.length = 0;
    round.phase = 'play'; round.len = min * 60; round.endsAt = Date.now() + min * 60000;
    broadcast({ t: 'round', s: `${min}분 결승 라운드 시작! 모두 Lv 1부터 다시 시작해요. 마지막에는 바람의 벽이 좁혀져요.` });
  } else if (msg.c === 'stop') { if (round.phase === 'play') endRound(); }
  else if (msg.c === 'free') { round.phase = 'free'; broadcast({ t: 'msg', s: '자유 대전 모드예요.' }); }
  else if (msg.c === 'reset') { for (const p of players.values()) resetPlayer(p); mons.clear(); picks.clear(); broadcast({ t: 'msg', s: '선생님이 모두의 기록을 초기화했어요.' }); }
  else if (msg.c === 'gate') { gate = !!msg.on; c.send({ t: 'adminok', R, obs: OBS, gate, ph: round.phase, addr: addresses() }); }
  else if (msg.c === 'kick') { const p = players.get(+msg.id); if (p && p.c) { p.c.send({ t: 'err', s: '선생님이 퇴장시켰어요.' }); setTimeout(() => p.c.close(), 200); } }
  else if (msg.c === 'dbg' && process.env.ARENA_TEST) { const p = players.get(+msg.id); if (p) Object.assign(p, msg.set); }
  else if (msg.c === 'code') { c.send({ t: 'code', name: cleanName(msg.name), code: clearCode(cleanName(msg.name), kstYmd(0)) }); }
}
function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  return out;
}

/* ======================= loop & start ======================= */
let last = Date.now();
setInterval(() => { const now = Date.now(), dt = Math.min(.1, (now - last) / 1000); last = now; try { step(dt); } catch (e) { console.error(e); } }, TICK * 1000);
server.listen(PORT, () => {
  const addr = addresses();
  console.log('\n  옥정섬 SOS · 클리어 아레나 서버가 켜졌어요!\n');
  console.log('  학생 접속 주소 (같은 와이파이):');
  for (const a of addr) console.log('    ' + a);
  if (!addr.length) console.log(`    http://localhost:${PORT}`);
  console.log('\n  선생님 관리·TV 화면: 위 주소 뒤에 /admin  →  비밀번호: ' + ADMIN_KEY);
  console.log('  (끄려면 이 창에서 Ctrl + C)\n');
});
module.exports = { clearCode, kstYmd };
