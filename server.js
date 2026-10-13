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
  if (p === '/' || p === '' || p === '/2' || p === '/2/') p = '/index.html';
  if (p === '/admin' || p === '/tv' || p === '/admin2' || p === '/tv2') p = '/admin.html';
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
        if (fin) { const s = this.frag.toString('utf8'); this.frag = null; let msg; try { msg = JSON.parse(s); } catch (e) { continue; } if (this.onmsg) { try { this.onmsg(msg); } catch (e) { console.error('msg error', e); } } }
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
  const room = (req.url || '').startsWith('/ws2') ? ROOMS.coop : ROOMS.battle;
  room.onConnect(new Conn(sock));
});
setInterval(() => { for (const r of Object.values(ROOMS)) for (const c of r.conns) { if (!c.alive) { c.close(); continue; } c.alive = false; c.ping(); } }, 20000);

/* ======================= game constants ======================= */
const R = 62;                          // island radius
const TICK = 1 / 20;
const MAXLV = 15;
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
  golem: { hp: 220, spd: 2.2, dmg: 24, xp: 80, coins: [30, 44], r: 1.5, aggro: 12, lv: 7 },
  weasel: { hp: 28, spd: 6.6, dmg: 7, xp: 18, coins: [6, 9], r: .55, aggro: 16, lv: 2, beh: 'dart' },       // 빠름: 휙휙 돌진
  flower: { hp: 44, spd: .7, dmg: 12, xp: 24, coins: [8, 12], r: .8, aggro: 15, lv: 3, beh: 'ranged' },     // 멀리서 매연탄
  crab: { hp: 150, spd: 2.4, dmg: 15, xp: 36, coins: [12, 18], r: 1, aggro: 11, lv: 4, beh: 'armor' },     // 단단함(피해 40% 덜 받음)
  bat: { hp: 22, spd: 8, dmg: 6, xp: 12, coins: [4, 6], r: .5, aggro: 18, lv: 5, beh: 'swarm' },           // 떼로 다님
  turtle: { hp: 230, spd: 1.1, dmg: 48, xp: 62, coins: [22, 32], r: 1.4, aggro: 10, lv: 6, beh: 'heavy' }  // 느리지만 한 방
};
const BOSS = { hp0: 5000, hpPer: 9000, spd: 2.5, r: 2.6, melee: 60, whirl: 80, bolt: 55, coins: 80, pool: 900 };   // HP = hp0 + hpPer × 접속 인원
const GEARN = ['맨손', '스패너', '토크 렌치', '돌풍 해머', '태풍 블레이드'];
const ARMN = ['작업복', '작업 조끼', '방풍 재킷', '탄소섬유 슈트', '태풍 갑옷'];
const BOOTN = ['맨발', '운동화', '방수 장화', '바람 부츠'];
const HELMN = ['맨머리', '안전모', '고글 헬멧', '정비반장 헬멧'];
/* 바람상회 (island centre): buy any higher tier directly. price[t] = cost of tier t */
const SHOP = {
  wpn: { label: '무기', names: GEARN, price: [0, 60, 150, 280, 450], parts: [0, 0, 1, 3, 5], eff: '공격 +5' },
  arm: { label: '갑옷', names: ARMN, price: [0, 60, 150, 280, 450], parts: [0, 0, 1, 3, 5], eff: '체력 +22 · 받는 피해 −6%' },
  boot: { label: '신발', names: BOOTN, price: [0, 50, 120, 220], parts: [0, 0, 1, 2], eff: '이동 속도 +7%' },
  helm: { label: '모자', names: HELMN, price: [0, 50, 120, 220], parts: [0, 0, 1, 2], eff: '스킬 대기 −8%' }
};
const SLOTN = { wpn: GEARN, arm: ARMN, boot: BOOTN, helm: HELMN };
const SHOP_BATTLE = Object.fromEntries(Object.entries(SHOP).map(([k, v]) => [k, { ...v, parts: v.parts.map(() => 0) }]));
const POT = { price: 25, max: 3, heal: .45, cd: 4 };
const SHOP_R = 9;                      // must stand this close to the centre to buy
const UPG = [60, 120, 200, 300];       // legacy (old clients)
const ARENA_SALT = 'oksland-arena';            // 1부 아레나 코드 (2부 아레나는 + '-2')
/* ---- teams ---- */
const TEAMS = [{ n: '바람', c: '#3FB6FF' }, { n: '태양', c: '#FFA51F' }, { n: '바다', c: '#22CFA0' }, { n: '번개', c: '#B57BFF' }];
const BLESS_MS = 60000;                                         // team buff after the gauge fills
const teamScore = t => t.tasks * 3 + t.kills + t.lvups * 10;
/* ---- tasks (Among Us style stations) ---- */
const TASK_CD = 45000, TASK_WRONG_CD = 8000, TASK_R = 3;
const TASKN = { wires: '전선 연결', nacelle: '나셀 돌리기', order: '부품 순서', quiz: '바람 퀴즈' };
const STATIONS = [];
(function () { const types = ['wires', 'nacelle', 'order', 'quiz', 'wires', 'nacelle', 'order', 'quiz'];
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + Math.PI / 8, d = i % 2 ? 46 : 25; STATIONS.push({ id: i, x: +(Math.cos(a) * d).toFixed(1), z: +(Math.sin(a) * d).toFixed(1), type: types[i] }); } })();
const PARTS = ['날개', '회전축·기어', '발전기', '전선'];
const QUIZ = [
  ['낮에 바닷가에서 부는 바람은?', '해풍 (바다 → 육지)', '육풍 (육지 → 바다)', '바람이 안 분다'],
  ['밤에 바닷가에서 부는 바람은?', '육풍 (육지 → 바다)', '해풍 (바다 → 육지)', '바람이 안 분다'],
  ['바람을 만드는 에너지는 어디서 왔을까?', '태양', '달', '지구 자석'],
  ['풍력발전기의 에너지 전환 순서는?', '바람 → 회전 → 전기', '전기 → 회전 → 바람', '열 → 빛 → 전기'],
  ['큰 풍력발전기 날개를 돌리는 주된 힘은?', '양력', '항력(미는 힘)', '중력'],
  ['풍속이 2배가 되면 바람의 동력은?', '8배', '2배', '4배'],
  ['날개 길이가 2배가 되면 회전 면적은?', '4배', '2배', '8배'],
  ['풍속이 25 m/s를 넘는 태풍이 오면 발전기는?', '멈춘다 (날개 보호)', '최대로 발전한다', '날개를 더 빨리 돌린다'],
  ['발전기가 멈춘 동안 꼭 필요한 곳에 전기를 보내는 것은?', '배터리 (ESS)', '선풍기', '풍향계'],
  ['나셀(발전기 머리)은 어느 쪽을 봐야 할까?', '바람이 불어오는 쪽', '바람이 불어 가는 쪽', '상관없다'],
  ['큰 발전용 풍력발전기 날개는 보통 몇 장일까?', '3장', '2장', '12장'],
  ['풍력발전기 자리를 정할 때 따지지 않아도 되는 것은?', '학교 급식 메뉴', '주민 소음·그림자', '철새 길목'],
  ['발전을 시작하는 풍속(컷인)에 가까운 것은?', '약 3 m/s', '약 30 m/s', '0 m/s'],
  ['수직축 풍력발전기의 장점은?', '바람 방향과 상관없이 돈다', '효율이 가장 높다', '날개가 필요 없다'],
  ['선풍기와 풍력발전기의 관계는?', '에너지 전환 방향이 반대', '완전히 같은 기계', '아무 관계 없다']
];

/* ======================= map ======================= */
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const OBS_ALL = [];
(function buildMap() {
  const r = rng(20261012); const OBS = OBS_ALL;
  OBS.push([0, 0, 3.2, 'forge']);
  for (const t of STATIONS) OBS.push([t.x, t.z, .9, 'station']);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + .3; OBS.push([Math.cos(a) * 38, Math.sin(a) * 38, 1.1, 'turbine']); }
  let tries = 0;
  while (OBS.length < 70 && tries++ < 4000) {
    const a = r() * Math.PI * 2, d = 9 + Math.sqrt(r()) * (R - 14), x = Math.cos(a) * d, z = Math.sin(a) * d;
    const kind = r() < .55 ? 'tree' : 'rock', rad = kind === 'tree' ? .7 + r() * .3 : .9 + r() * 1.4;
    if (OBS.some(o => Math.hypot(o[0] - x, o[1] - z) < o[2] + rad + 3)) continue;
    if (STATIONS.some(t => Math.hypot(t.x - x, t.z - z) < rad + 4.5)) continue;
    OBS.push([+x.toFixed(2), +z.toFixed(2), +rad.toFixed(2), kind]);
  }
})();
const OBS_BATTLE = OBS_ALL.filter(o => o[3] !== 'station');
function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  return out;
}
function kstYmd(offsetDays = 0) { return new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10).replace(/-/g, ''); }
function clearCode(name, ymd, salt = ARENA_SALT) {
  const s = String(name).replace(/\s+/g, '') + '|' + ymd + '|' + salt;
  let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return String(1000 + (h % 9000));
}

/* ======================= one arena room (1부 대결 / 2부 협동) ======================= */
function makeRoom(MODE) {
const COOP = MODE === 'coop';
const SALT = COOP ? ARENA_SALT + '-2' : ARENA_SALT;
const OBS = COOP ? OBS_ALL : OBS_BATTLE;
const SHOPX = COOP ? SHOP : SHOP_BATTLE;
const STN = COOP ? STATIONS : [];
const teamSt = TEAMS.map(() => ({ pts: 0, lvups: 0, tasks: 0, kills: 0, buffUntil: 0 }));
let teamsOn = COOP;
const blessed = p => teamsOn && p.team != null && teamSt[p.team].buffUntil > Date.now();
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
  atk: Math.round((10 + (p.lv - 1) * 4 + p.wpn * 5) * (blessed(p) ? 1.3 : 1)),
  def: 1 - (1 - p.arm * .06) * (blessed(p) ? .8 : 1),
  cdr: (p.helm || 0) * .08,
  spd: 7.6 * (1 + (p.lv - 1) * .04) * (1 + (p.boot || 0) * .07) * (p.dashT > 0 ? 1.8 : 1) * (blessed(p) ? 1.1 : 1)
});
function newPlayer(c, name) {
  const [x, z] = freeSpot(10);
  const p = { id: nextId++, c, name, x, z, dir: 0, mx: 0, mz: 0, lv: 1, xp: 0, coins: 0, wpn: 0, arm: 0, boot: 0, helm: 0, pot: 1, potAt: 0, team: pickTeam(), tcd: {}, task: null, tasks: 0, parts: 0, hp: 100, kills: 0, deaths: 0, streak: 0, best: 0,
    alive: true, respawnAt: 0, prot: Date.now() + 3000, cds: {}, dashT: 0, shieldT: 0, lastHurt: 0, dmgBy: new Map(), joined: Date.now(), lastIn: Date.now() };
  p.hp = stat(p).maxHp;
  return p;
}
function resetPlayer(p) {
  p.lv = 1; p.xp = 0; p.coins = 0; p.wpn = 0; p.arm = 0; p.boot = 0; p.helm = 0; p.pot = 1; p.potAt = 0; p.tcd = {}; p.task = null; p.tasks = 0; p.parts = 0; p.kills = 0; p.deaths = 0; p.streak = 0; p.best = 0; p.cds = {}; p.dashT = 0; p.shieldT = 0;
  const [x, z] = freeSpot(10); p.x = x; p.z = z; p.alive = true; p.prot = Date.now() + 3000; p.hp = stat(p).maxHp; p.dmgBy.clear();
}

/* ======================= teams & tasks ======================= */
function teamCount(ti) { let n = 0; for (const p of players.values()) if (online(p) && p.team === ti) n++; return n; }
function pickTeam() { let best = 0, bn = 1e9; const order = [0, 1, 2, 3].sort(() => Math.random() - .5); for (const i of order) { const n = teamCount(i); if (n < bn) { bn = n; best = i; } } return best; }
const teamGoal = ti => 4 + 3 * Math.max(1, teamCount(ti));
const sameTeam = (a, b) => a && b && a !== b && (COOP || (teamsOn && a.team === b.team));
function shuffleTeams() {
  const list = [...players.values()].filter(online).sort(() => Math.random() - .5);
  list.forEach((p, i) => { p.team = i % 4; });
  for (const t of teamSt) Object.assign(t, { pts: 0, lvups: 0, tasks: 0, kills: 0, buffUntil: 0 });
}
const shuf = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function startTask(p) {
  if (!COOP || !p.alive || p.task) return;
  const now = Date.now();
  const st = STN.map(t => [t, Math.hypot(t.x - p.x, t.z - p.z)]).filter(([, d]) => d <= TASK_R).sort((a, b) => a[1] - b[1])[0];
  if (!st) return tell(p, '과제 기계 가까이 가야 해요.');
  const t = st[0];
  if ((p.tcd[t.id] || 0) > now) return tell(p, `이 기계는 ${Math.ceil((p.tcd[t.id] - now) / 1000)}초 뒤에 다시 할 수 있어요. 다른 기계를 찾아보세요!`);
  let q, ans;
  if (t.type === 'wires') { const right = shuf([0, 1, 2, 3]); q = { right }; ans = [0, 1, 2, 3].map(c => right.indexOf(c)); }
  else if (t.type === 'nacelle') { const wind = Math.floor(Math.random() * 8); q = { wind, start: (wind + 2 + Math.floor(Math.random() * 5)) % 8 }; ans = wind; }
  else if (t.type === 'order') { q = { parts: shuf(PARTS) }; ans = PARTS.join('|'); }
  else { const it = QUIZ[Math.floor(Math.random() * QUIZ.length)], opts = shuf(it.slice(1)); q = { q: it[0], o: opts }; ans = opts.indexOf(it[1]); }
  p.task = { sid: t.id, type: t.type, ans, at: now };
  p.c && p.c.send({ t: 'task', sid: t.id, type: t.type, name: TASKN[t.type], q });
}
function cancelTask(p, why) { if (!p.task) return; p.task = null; p.c && p.c.send({ t: 'tx', s: why || '' }); }
function answerTask(p, a) {
  const tk = p.task; if (!tk) return;
  const t = STATIONS[tk.sid], now = Date.now();
  if (!p.alive || Math.hypot(t.x - p.x, t.z - p.z) > TASK_R + .8) return cancelTask(p, '기계에서 멀어져서 과제가 취소됐어요.');
  let ok;
  if (tk.type === 'wires') ok = Array.isArray(a) && a.length === 4 && a.every((v, i) => v === tk.ans[i]);
  else if (tk.type === 'order') ok = Array.isArray(a) && a.join('|') === tk.ans;
  else ok = +a === tk.ans;
  p.task = null;
  if (!ok) { p.tcd[t.id] = now + TASK_WRONG_CD; p.c && p.c.send({ t: 'tres', ok: false, s: '앗, 틀렸어요! 8초 뒤에 다시 도전하거나 다른 기계로 가세요.' }); return; }
  p.tcd[t.id] = now + TASK_CD; p.tasks++; p.parts = (p.parts || 0) + 1; questTask();
  const xp = Math.round(xpNeed(p.lv) * .4); gainXp(p, xp); addCoins(p, 12);
  { const st = stat(p); p.hp = Math.min(st.maxHp, p.hp + st.maxHp * .25); }
  let tl = null;
  if (teamsOn) {
    const ts = teamSt[p.team]; ts.pts++; ts.tasks++;
    if (ts.pts >= teamGoal(p.team)) { ts.pts = 0; ts.lvups++; tl = p.team; ts.buffUntil = now + BLESS_MS;
      for (const q of players.values()) if (online(q) && q.team === p.team && q.lv < MAXLV) gainXp(q, xpNeed(q.lv) - q.xp);
      broadcast({ t: 'tlv', team: p.team, by: p.name, n: ts.lvups }); }
  }
  p.c && p.c.send({ t: 'tres', ok: true, xp, coins: 12, s: `과제 성공! 부품 ⚙+1 · 경험치 +${xp} · 코인 +12 · 체력 회복${teamsOn ? ' · 팀 게이지 +1' : ''}` });
  ev({ k: 'task', id: p.id, sid: t.id, team: p.team, tl });
}

/* ======================= helpers ======================= */
function broadcast(obj) { const s = JSON.stringify(obj); const buf = Buffer.from(s); for (const c of conns) if (c.open && (c.pid || c.admin)) c.raw(0x81, buf); }
const evq = [];
function ev(o) { evq.push(o); }

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
  if (v.task) cancelTask(v, '공격을 받아서 과제가 취소됐어요! 주변을 살피고 다시 하세요.');
  if (src && src.kind === 'p') { v.dmgBy.set(src.p.id, Date.now()); src.p.lastHurt = Date.now(); }
  ev({ k: 'hit', t: 'p', id: v.id, d, x: +v.x.toFixed(1), z: +v.z.toFixed(1) });
  if (v.hp <= 0) killPlayer(v, src);
}
function killPlayer(v, src) {
  if (v.task) cancelTask(v); v.hp = 0; v.alive = false; v.respawnAt = Date.now() + 5000; v.deaths++;
  const vLv = v.lv;
  const wasKing = king === v.id, bounty = wasKing ? bountyOf(v) : 0;
  // penalties: 30% coins dropped, one gear tier dropped, XP loss (may level down)
  const lost = Math.floor(v.coins * .3); v.coins -= lost;
  if (lost > 0) { const n = Math.min(6, Math.max(1, Math.ceil(lost / 15))); for (let i = 0; i < n; i++) dropPick('coin', Math.floor(lost / n) + (i < lost % n ? 1 : 0), v.x, v.z); }
  let gearLost = null;
  { // drop one tier of the best piece (weapon/armour first on ties)
    let best = null; for (const k of ['wpn', 'arm', 'boot', 'helm']) if ((v[k] || 0) > 0 && (!best || v[k] > v[best])) best = k;
    if (best) { dropPick(best, v[best], v.x, v.z); gearLost = SLOTN[best][v[best]]; v[best]--; }
  }
  let partLost = 0; if ((v.parts || 0) > 0) { v.parts--; partLost = 1; dropPick('part', 1, v.x, v.z); }
  const xpLoss = Math.round(xpNeed(v.lv) * .4); let lvDown = false;
  v.xp -= xpLoss; if (v.xp < 0) { if (v.lv > 1) { v.lv--; v.xp = Math.max(0, xpNeed(v.lv) + v.xp); lvDown = true; } else v.xp = 0; }
  v.streak = 0;
  let killer = null, helpers = [];
  if (src && src.kind === 'p' && src.p.id !== v.id) {
    killer = src.p; killer.kills++; if (teamsOn) teamSt[killer.team].kills++; killer.streak++; killer.best = Math.max(killer.best, killer.streak);
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
  if (v.c) v.c.send({ t: 'dead', by: killer ? killer.name : src && src.kind === 'm' ? src.m.type : src && src.kind === 'z' ? 'zone' : '?', lost, gearLost, partLost, lvDown, xpLoss, respawn: 5 });
}
function hurtMon(m, dmg, p) {
  if (m.dead) return;
  if (m.type === 'crab') dmg = Math.max(1, Math.round(dmg * .6));
  m.hp -= dmg; m.tgt = p.id; m.hitT = .15;
  if (m.type === 'boss') { m.dmgBy.set(p.id, (m.dmgBy.get(p.id) || 0) + dmg); m.seen.set(p.id, Date.now()); }
  ev({ k: 'hit', t: 'm', id: m.id, d: dmg, x: +m.x.toFixed(1), z: +m.z.toFixed(1) });
  if (m.hp <= 0 && m.type === 'boss') { m.dead = true; mons.delete(m.id); return bossDie(m, p); }
  if (m.hp <= 0) {
    m.dead = true; mons.delete(m.id);
    const def = MON[m.type];
    if (COOP) questKill();
    gainXp(p, def.xp); addCoins(p, def.coins[0] + Math.floor(Math.random() * (def.coins[1] - def.coins[0] + 1)));
    const r = Math.random(), gearP = { snail: .06, slime: .1, bee: .14, boar: .28, golem: .6, weasel: .1, flower: .14, crab: .25, bat: .05, turtle: .45 }[m.type] || .1;
    if (r < gearP) { const tier = Math.min(4, 1 + Math.floor(Math.random() * ({ snail: 1, slime: 1.6, bee: 2, boar: 3, golem: 4, weasel: 1.6, flower: 2, crab: 3, bat: 1, turtle: 3.6 }[m.type] || 1))); const sl = ['wpn', 'arm', 'wpn', 'arm', 'boot', 'helm'][Math.floor(Math.random() * 6)]; dropPick(sl, sl === 'boot' || sl === 'helm' ? Math.min(3, tier) : tier, m.x, m.z); }
    else if (r < gearP + .22) dropPick('heal', 30, m.x, m.z);
    ev({ k: 'mdie', id: m.id, x: +m.x.toFixed(1), z: +m.z.toFixed(1), by: p.id, type: m.type });
  }
}

/* ======================= targeting ======================= */
function enemiesNear(p, range) {
  const out = [];
  for (const q of players.values()) if (q !== p && q.alive && online(q) && Date.now() >= q.prot && !sameTeam(p, q)) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d <= range) out.push({ kind: 'p', o: q, d }); }
  for (const m of mons.values()) { const d = Math.hypot(m.x - p.x, m.z - p.z); if (d <= range + (m.type === 'boss' ? BOSS.r : MON[m.type].r) * .5) out.push({ kind: 'm', o: m, d }); }
  return out.sort((a, b) => a.d - b.d);
}
function hitTarget(p, t, dmg) { if (t.kind === 'p' && sameTeam(p, t.o)) return; if (t.kind === 'p') hurtPlayer(t.o, dmg, { kind: 'p', p }); else hurtMon(t.o, dmg, p); }

/* ======================= actions ======================= */
function useSkill(p, id) {
  const sk = SKILLS[id]; if (!sk || !p.alive || p.lv < sk.lv) return;
  const now = Date.now() / 1000;
  if ((p.cds[id] || 0) > now) return;
  p.cds[id] = now + sk.cd * (id === 'punch' ? 1 : 1 - stat(p).cdr);
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
const tell = (p, s) => p.c && p.c.send({ t: 'msg', s });
function shopCheck(p) {
  if (!p.alive) return false;
  if (Math.hypot(p.x, p.z) > SHOP_R) { tell(p, '섬 가운데 <b>바람상회</b>에 가야 살 수 있어요.'); return false; }
  if (Date.now() - p.lastHurt < 4000) { tell(p, '싸우는 중에는 살 수 없어요. 4초만 숨으세요!'); return false; }
  return true;
}
function buy(p, slot, tier) {
  const it = SHOPX[slot]; tier = Math.floor(+tier);
  if (!it || !(tier >= 1 && tier < it.price.length)) return;
  const cur = p[slot] || 0;
  if (tier <= cur) return tell(p, '이미 그보다 좋은 장비를 갖고 있어요.');
  if (!shopCheck(p)) return;
  const cost = it.price[tier], need = it.parts[tier] || 0;
  if ((p.parts || 0) < need) return tell(p, `<b>부품 ⚙ ${need}개</b>가 필요해요 (지금 ${p.parts || 0}개). 과제 기계에서 과제를 하면 부품을 받아요!`);
  if (p.coins < cost) return tell(p, `코인이 모자라요 (${cost}코인 필요)`);
  p.coins -= cost; p.parts -= need; p[slot] = tier; if (slot === 'arm') p.hp += (tier - cur) * 22;
  tell(p, `<b>${it.names[tier]}</b>을(를) 샀어요! −${cost}코인`);
  ev({ k: 'fx', s: 'upg', id: p.id, x: p.x, z: p.z });
}
function buyPot(p) {
  if (p.pot >= POT.max) return tell(p, `회복 음료는 ${POT.max}개까지 가질 수 있어요.`);
  if (!shopCheck(p)) return;
  if (p.coins < POT.price) return tell(p, `코인이 모자라요 (${POT.price}코인 필요)`);
  p.coins -= POT.price; p.pot++; tell(p, `회복 음료를 샀어요! (${p.pot}/${POT.max}) −${POT.price}코인`);
}
function drinkPot(p) {
  if (!p.alive || p.pot <= 0) return;
  const now = Date.now(); if (now < p.potAt) return;
  const st = stat(p); if (p.hp >= st.maxHp) return tell(p, '체력이 이미 가득해요.');
  p.pot--; p.potAt = now + POT.cd * 1000; p.hp = Math.min(st.maxHp, p.hp + st.maxHp * POT.heal);
  ev({ k: 'fx', s: 'heal', id: p.id, x: p.x, z: p.z });
}
function upgrade(p, what) { buy(p, what, (p[what] || 0) + 1); }   // legacy 'up' message

/* ======================= raid boss: 태풍 마수 돌개 ======================= */
let boss = null, bossCd = 0, bossChk = 0;
const bossStrikes = [];
function spawnBoss(why) {
  if (boss && !boss.dead) return;
  const n = Math.max(1, [...players.values()].filter(online).length), max = BOSS.hp0 + BOSS.hpPer * n;
  let x = 0, z = -20; for (let i = 0; i < 30; i++) { const a = Math.random() * 6.28, d = 14 + Math.random() * 20; x = Math.cos(a) * d; z = Math.sin(a) * d; if (!OBS.some(o => Math.hypot(o[0] - x, o[1] - z) < o[2] + 4)) break; }
  const id = nextId++;
  boss = { id, type: 'boss', x, z, hp: max, max, dir: 0, wT: 0, atkCd: 2, hitT: 0, tgt: null, whT: 6, btT: 9, sum: 0, enr: false, dmgBy: new Map(), seen: new Map(), born: Date.now() };
  mons.set(id, boss);
  broadcast({ t: 'boss', s: 'spawn', hp: max, why });
}
function bossDie(m, killer) {
  const now = Date.now(), list = [...m.dmgBy.entries()].filter(([id]) => players.has(id)).map(([id, d]) => [players.get(id), d]);
  const tot = list.reduce((a, [, d]) => a + d, 0) || 1;
  list.sort((a, b) => b[1] - a[1]);
  for (const [p, d] of list) {
    const share = d / tot, c = BOSS.coins + Math.round(BOSS.pool * share) + (p === killer ? 50 : 0);
    addCoins(p, c); if (p.lv < MAXLV) gainXp(p, xpNeed(p.lv) - p.xp); if (COOP) p.parts = (p.parts || 0) + 3;
    if (p.alive) p.hp = stat(p).maxHp;
    p.c && p.c.send({ t: 'msg', s: `<b>태풍 마수 돌개</b> 토벌! 기여 ${Math.round(share * 100)}% → 코인 +${c} · 레벨 업${COOP ? ' · 부품 ⚙+3' : ''}` });
  }
  for (let i = 0; i < 8; i++) dropPick(i < 4 ? 'heal' : 'coin', i < 4 ? 30 : 25, m.x, m.z);
  broadcast({ t: 'boss', s: 'die', by: killer.name, n: list.length, top: list.slice(0, 3).map(([p, d]) => [p.name, Math.round(d / tot * 100)]) });
  ev({ k: 'fx', s: 'bossdie', x: +m.x.toFixed(1), z: +m.z.toFixed(1) });
  boss = null; bossCd = now + 240000;
  if (COOP && quest.stage === 3) questAdvance();
}
function bossAI(m, dt, alive, now) {
  const enr = m.hp < m.max * .3; if (enr && !m.enr) { m.enr = true; broadcast({ t: 'boss', s: 'enrage' }); }
  // summons at 60% / 30%
  const sumAt = [.6, .3]; if (m.sum < 2 && m.hp < m.max * sumAt[m.sum]) { m.sum++; for (let i = 0; i < 4; i++) { const a = i / 4 * 6.28, type = i % 2 ? 'bat' : 'weasel', id = nextId++, d = MON[type]; mons.set(id, { id, type, x: m.x + Math.cos(a) * 4, z: m.z + Math.sin(a) * 4, hp: d.hp, max: d.hp, dir: a, wT: 0, atkCd: 1, tgt: null, hitT: 0 }); } broadcast({ t: 'boss', s: 'summon' }); }
  // target: biggest recent contributor nearby, else nearest
  let tgt = null, best = -1;
  for (const p of alive) { if (now < p.prot) continue; const d = Math.hypot(p.x - m.x, p.z - m.z); if (d > 45) continue; const sc = (m.dmgBy.get(p.id) || 0) * (now - (m.seen.get(p.id) || 0) < 8000 ? 1 : 0) + (45 - d) * 3; if (sc > best) { best = sc; tgt = p; } }
  const spd = BOSS.spd * (enr ? 1.35 : 1);
  if (tgt) { const d = Math.hypot(tgt.x - m.x, tgt.z - m.z); m.dir = Math.atan2(tgt.x - m.x, tgt.z - m.z); if (d > BOSS.r + 1) { const nx = m.x + Math.sin(m.dir) * spd * dt, nz = m.z + Math.cos(m.dir) * spd * dt; [m.x, m.z] = collide(nx, nz, BOSS.r * .6); } }
  else { m.wT -= dt; if (m.wT <= 0) { m.wT = 3; m.dir = Math.atan2(-m.x, -m.z) + (Math.random() - .5); } const nx = m.x + Math.sin(m.dir) * spd * .4 * dt, nz = m.z + Math.cos(m.dir) * spd * .4 * dt; [m.x, m.z] = collide(nx, nz, BOSS.r * .6); }
  m.atkCd -= dt; m.whT -= dt; m.btT -= dt;
  if (m.atkCd <= 0) { const near = alive.filter(p => now >= p.prot && Math.hypot(p.x - m.x, p.z - m.z) < BOSS.r + 1.8); if (near.length) { m.atkCd = enr ? 1.2 : 1.6; for (const p of near) hurtPlayer(p, BOSS.melee, { kind: 'm', m }); ev({ k: 'fx', s: 'slam', x: +m.x.toFixed(1), z: +m.z.toFixed(1), r: BOSS.r + 1.8 }); } }
  if (m.whT <= 0 && tgt) { m.whT = enr ? 5 : 7; const r = 7.5; ev({ k: 'fx', s: 'warn', x: +m.x.toFixed(1), z: +m.z.toFixed(1), r, t: 1.3 }); bossStrikes.push({ at: now + 1300, x: m.x, z: m.z, r, dmg: BOSS.whirl, kb: 5, fx: 'whirl' }); }
  if (m.btT <= 0 && tgt) { m.btT = enr ? 7 : 10; const ts = alive.filter(p => now >= p.prot && Math.hypot(p.x - m.x, p.z - m.z) < 32).sort(() => Math.random() - .5).slice(0, enr ? 7 : 5);
    for (const p of ts) { const x = p.x + (Math.random() - .5) * 2, z = p.z + (Math.random() - .5) * 2; ev({ k: 'fx', s: 'warn', x: +x.toFixed(1), z: +z.toFixed(1), r: 3, t: 1.4 }); bossStrikes.push({ at: now + 1400, x, z, r: 3, dmg: BOSS.bolt, fx: 'thunder' }); } }
}
function tickBossStrikes(now, alive) {
  for (let i = bossStrikes.length - 1; i >= 0; i--) {
    const s = bossStrikes[i]; if (now < s.at) continue; bossStrikes.splice(i, 1);
    ev({ k: 'fx', s: s.fx, x: +s.x.toFixed(1), z: +s.z.toFixed(1), r: s.r });
    const src = boss ? { kind: 'm', m: boss } : { kind: 'm', m: { type: 'boss' } };
    for (const p of alive) { const d = Math.hypot(p.x - s.x, p.z - s.z); if (d > s.r || now < p.prot) continue; if (s.kb && d > .1) { [p.x, p.z] = collide(p.x + (p.x - s.x) / d * s.kb, p.z + (p.z - s.z) / d * s.kb, .45); } hurtPlayer(p, s.dmg, src); }
  }
}
/* ======================= 2부 협동 퀘스트 (다같이) ======================= */
const QSTAGES = [null, { n: '발전기 수리', d: '과제 기계에서 과제를 다 함께 해내세요' }, { n: '매연 정화', d: '섬의 매연 몬스터를 다 함께 정화하세요' }, { n: '태풍 마수 토벌', d: '태풍 마수 돌개를 모두 힘을 합쳐 쓰러뜨리세요!' }, { n: '옥정섬 완전 복구!', d: '축하해요! 자유롭게 사냥하고 장비를 모으세요' }];
const quest = { stage: 1, prog: 0, goal: 10 };
function questGoal() { const n = Math.max(1, [...players.values()].filter(online).length); return quest.stage === 1 ? Math.max(8, n * 2) : quest.stage === 2 ? Math.max(15, n * 4) : 1; }
function questReset() { quest.stage = 1; quest.prog = 0; }
function questAdvance() {
  for (const p of players.values()) if (online(p)) { if (p.lv < MAXLV) gainXp(p, xpNeed(p.lv) - p.xp); addCoins(p, 40); p.parts = (p.parts || 0) + 1; }
  const done = QSTAGES[quest.stage].n; quest.stage = Math.min(4, quest.stage + 1); quest.prog = 0;
  broadcast({ t: 'quest', s: 'next', done, stage: quest.stage, name: QSTAGES[quest.stage].n, desc: QSTAGES[quest.stage].d });
  if (quest.stage === 3) setTimeout(() => spawnBoss('quest'), 4000);
}
function questTask() { if (COOP && quest.stage === 1) { quest.prog++; if (quest.prog >= questGoal()) questAdvance(); } }
function questKill() { if (quest.stage === 2) { quest.prog++; if (quest.prog >= questGoal()) questAdvance(); } }

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
    if (p.task) { const t = STATIONS[p.task.sid]; if (Math.hypot(t.x - p.x, t.z - p.z) > TASK_R + .8) cancelTask(p, '기계에서 멀어져서 과제가 취소됐어요.'); }
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
      else if (k.kind === 'part') { p.parts = (p.parts || 0) + k.val; p.c && p.c.send({ t: 'msg', s: '부품 ⚙ 1개를 주웠어요!' }); }
      else if (k.kind === 'heal') p.hp = Math.min(st.maxHp, p.hp + st.maxHp * .3);
      else if (SLOTN[k.kind]) {
        const cur = p[k.kind] || 0;
        if (k.val > cur) { p[k.kind] = k.val; p.c && p.c.send({ t: 'msg', s: `${SLOTN[k.kind][k.val]} 획득!` }); }
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
    const w = pool.map(([k, d]) => k === 'snail' ? Math.max(.6, 4 - avgLv * .4) : k === 'golem' || k === 'turtle' ? .6 + (avgLv - d.lv) * .25 : k === 'bat' ? 1 : 2);
    let r = Math.random() * w.reduce((a, b) => a + b, 0), type = pool[0][0];
    for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) { type = pool[i][0]; break; } }
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2, d = 8 + Math.random() * (zr - 12), x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (OBS.some(o => Math.hypot(o[0] - x, o[1] - z) < o[2] + 2)) continue;
      if (alive.some(p => Math.hypot(p.x - x, p.z - z) < 11)) continue;
      const def = MON[type];
      for (let k = 0; k < (def.beh === 'swarm' ? 3 : 1); k++) { const id = nextId++; mons.set(id, { id, type, x: x + k * .9, z: z + (k % 2) * .9, hp: def.hp, max: def.hp, dir: Math.random() * 6.28, wT: 0, atkCd: 1, tgt: null, hitT: 0, cd2: 1 + Math.random() * 2 }); }
      break;
    }
  }
  // monsters move/attack
  for (const m of mons.values()) {
    if (m.type === 'boss') { bossAI(m, dt, alive, now); continue; }
    const def = MON[m.type];
    let tgt = null, td = def.aggro;
    for (const p of alive) { if (now < p.prot) continue; const d = Math.hypot(p.x - m.x, p.z - m.z); if (d < td || (m.tgt === p.id && d < def.aggro * 1.6)) { if (d < td || !tgt) { tgt = p; td = d; } } }
    let spd = def.spd; m.cd2 = (m.cd2 || 0) - dt;
    if (tgt) m.dir = Math.atan2(tgt.x - m.x, tgt.z - m.z) + (m.type === 'bee' || m.type === 'bat' ? Math.sin(now / 200 + m.id) * .6 : 0);
    else { spd *= .4; m.wT -= dt; if (m.wT <= 0) { m.wT = 2 + Math.random() * 3; m.dir = Math.random() * 6.28; } }
    if (def.beh === 'dart' && tgt) { if (m.dash > 0) { m.dash -= dt; spd = 15; } else if (td < 10 && m.cd2 <= 0) { m.dash = .4; m.cd2 = 2.6; } }
    if (def.beh === 'ranged' && tgt) { spd = td < 7 ? -def.spd * 1.5 : 0; if (td < 14 && m.cd2 <= 0) { m.cd2 = 2.6; const a = Math.atan2(tgt.x - m.x, tgt.z - m.z); projs.push({ id: nextId++, kind: 'spit', mon: true, x: m.x, z: m.z, dx: Math.sin(a), dz: Math.cos(a), spd: 13, life: 1.3, dmg: def.dmg, r: .7 }); } }
    if (def.beh === 'heavy') { if (m.wind > 0) { m.wind -= dt; spd = 0; if (m.wind <= 0) { const fx = m.x + Math.sin(m.dir) * 1.4, fz = m.z + Math.cos(m.dir) * 1.4; ev({ k: 'fx', s: 'slam', x: +fx.toFixed(1), z: +fz.toFixed(1), r: 2.8 }); for (const p of alive) if (now >= p.prot && Math.hypot(p.x - fx, p.z - fz) < 2.8) hurtPlayer(p, def.dmg, { kind: 'm', m }); m.atkCd = 2.4; } }
      else if (tgt && td < def.r + 1.6 && m.atkCd <= 0) { m.wind = 1.0; const fx = m.x + Math.sin(m.dir) * 1.4, fz = m.z + Math.cos(m.dir) * 1.4; ev({ k: 'fx', s: 'warn', x: +fx.toFixed(1), z: +fz.toFixed(1), r: 2.8, t: 1 }); } }
    if (spd < 0) { m.dir += Math.PI; spd = -spd; }
    const nx = m.x + Math.sin(m.dir) * spd * dt, nz = m.z + Math.cos(m.dir) * spd * dt;
    [m.x, m.z] = collide(nx, nz, def.r * .7);
    if (Math.hypot(m.x, m.z) > zr + 4) { m.dir += Math.PI; }
    m.atkCd -= dt;
    if (def.beh !== 'heavy' && def.beh !== 'ranged' && tgt && td < def.r + .6 && m.atkCd <= 0) { m.atkCd = 1.1; hurtPlayer(tgt, def.dmg, { kind: 'm', m }); }
  }
  tickBossStrikes(now, alive);
  // boss trigger (1부: 레벨이 높아지면 / 2부: 퀘스트 3단계)
  bossChk -= dt;
  if (bossChk <= 0) { bossChk = 5;
    const on = [...players.values()].filter(online);
    if (!COOP && !boss && now > bossCd && on.length >= 2 && on.filter(p => p.lv >= 10).length >= on.length * .5) spawnBoss('level');
    if (COOP && quest.stage === 3 && !boss && now > bossCd - 200000) spawnBoss('quest');
  }
  // projectiles
  for (let i = projs.length - 1; i >= 0; i--) {
    const pr = projs[i], owner = players.get(pr.by); pr.life -= dt;
    pr.x += pr.dx * pr.spd * dt; pr.z += pr.dz * pr.spd * dt;
    if (pr.mon) { let hit = false; for (const p of alive) if (now >= p.prot && Math.hypot(p.x - pr.x, p.z - pr.z) < pr.r + .45) { hurtPlayer(p, pr.dmg, { kind: 'm', m: { type: 'flower' } }); hit = true; break; } if (hit || pr.life <= 0) projs.splice(i, 1); continue; }
    if (!owner) { projs.splice(i, 1); continue; }
    if (pr.kind === 'cannon') {
      for (const t of enemiesNear({ x: pr.x, z: pr.z, id: -1 }, pr.r + .6)) { if (t.kind === 'p' && t.o.id === pr.by) continue; const key = t.kind + t.o.id; if (pr.hit.has(key)) continue; pr.hit.add(key); hitTarget(owner, t, pr.dmg); }
    } else {
      pr.tick -= dt;
      if (pr.tick <= 0) { pr.tick = .3; for (const t of enemiesNear({ x: pr.x, z: pr.z, id: -1 }, pr.r)) { if (t.kind === 'p' && t.o.id === pr.by) continue; hitTarget(owner, t, pr.dmg); if (t.kind === 'm' && t.o.type !== 'boss') { t.o.x += (pr.x - t.o.x) * .15; t.o.z += (pr.z - t.o.z) * .15; } } }
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
  king = !COOP && top && rl.length >= 2 && top.lv >= 3 && (!rl[1] || top.lv > rl[1].lv || top.coins > rl[1].coins) ? top.id : null;
  // snapshots 10 Hz
  snapT -= dt;
  if (snapT <= 0) { snapT = .1; sendSnap(rl); }
  lbT -= dt;
  if (lbT <= 0) { lbT = 1; sendBoard(rl); }
}
function sendSnap(rl) {
  const t = Date.now();
  const P = [...players.values()].filter(online).map(p => [p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.dir.toFixed(2), Math.ceil(p.hp), stat(p).maxHp, p.lv, (p.alive ? 1 : 0) | (t < p.prot ? 2 : 0) | (p.shieldT > 0 ? 4 : 0) | (p.dashT > 0 ? 8 : 0) | (king === p.id ? 16 : 0) | (p.task ? 32 : 0) | (blessed(p) ? 64 : 0), p.wpn, p.arm, p.team]);
  const M = [...mons.values()].map(m => [m.id, m.type, +m.x.toFixed(2), +m.z.toFixed(2), +m.dir.toFixed(2), Math.ceil(m.hp), m.max]);
  const J = projs.map(p => [p.id, p.kind, +p.x.toFixed(2), +p.z.toFixed(2)]);
  const K = [...picks.values()].map(k => [k.id, k.kind, k.val, +k.x.toFixed(2), +k.z.toFixed(2)]);
  const base = { t: 's', tm: t, P, M, J, K, ev: evq.splice(0), zr: +zoneR().toFixed(2), ph: round.phase, q: COOP ? [quest.stage, quest.prog, questGoal()] : null, bs: boss ? [boss.id, Math.ceil(boss.hp), boss.max, boss.enr ? 1 : 0] : null, left: round.phase === 'play' ? Math.max(0, Math.round((round.endsAt - t) / 1000)) : null };
  const rankOf = new Map(rl.map((p, i) => [p.id, i + 1]));
  for (const c of conns) {
    if (!c.open) continue;
    if (c.admin) { c.send({ ...base, me: undefined }); continue; }
    const p = c.pid && players.get(c.pid); if (!p) continue;
    const nowS = t / 1000, cds = {};
    for (const k in SKILLS) cds[k] = Math.max(0, +((p.cds[k] || 0) - nowS).toFixed(1));
    base.me = { xp: p.xp, need: xpNeed(p.lv), coins: p.coins, wpn: p.wpn, arm: p.arm, boot: p.boot, helm: p.helm, pot: p.pot, potCd: Math.max(0, Math.ceil((p.potAt - t) / 1000)), spdB: p.boot * 7, cdr: p.helm * 8, kills: p.kills, deaths: p.deaths, streak: p.streak, rank: rankOf.get(p.id), n: rl.length, cds, atk: stat(p).atk, def: Math.round(stat(p).def * 100), respawn: p.alive ? 0 : Math.max(0, Math.ceil((p.respawnAt - t) / 1000)), bounty: king === p.id ? bountyOf(p) : 0, safe: t - p.lastHurt > 4000, tcd: STN.map(s => Math.max(0, Math.ceil(((p.tcd[s.id] || 0) - t) / 1000))), team: p.team, tasks: p.tasks, parts: p.parts || 0, bless: blessed(p) ? Math.ceil((teamSt[p.team].buffUntil - t) / 1000) : 0 };
    c.send(base);
  }
}
function sendBoard(rl) {
  broadcast({ t: 'lb', king, teamsOn, teams: teamSt.map((s, i) => ({ pts: s.pts, lvups: s.lvups, tasks: s.tasks, kills: s.kills, score: teamScore(s), bless: Math.max(0, Math.ceil((s.buffUntil - Date.now()) / 1000)), goal: teamGoal(i), n: teamCount(i) })), list: rl.map(p => [p.id, p.name, p.lv, p.coins, p.kills, p.deaths, p.best, p.wpn, p.arm, p.team, p.tasks, p.parts || 0]) });
}
function endRound() {
  const rl = rankList();
  round.phase = 'end'; round.final = rl.slice(0, 10).map(p => ({ name: p.name, lv: p.lv, coins: p.coins, kills: p.kills, deaths: p.deaths }));
  const tr = teamsOn ? TEAMS.map((T, i) => ({ i, n: T.n, c: T.c, score: teamScore(teamSt[i]), tasks: teamSt[i].tasks, kills: teamSt[i].kills, lvups: teamSt[i].lvups })).filter(t => teamCount(t.i) > 0).sort((a, b) => b.score - a.score) : null;
  round.teamFinal = tr;
  broadcast({ t: 'end', top: round.final, teams: tr });
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
      if (old) { old.c = c; c.pid = old.id; old.offAt = 0; c.send({ t: 'welcome', id: old.id, name: old.name, tok, R, obs: OBS, skills: SKILLS, upg: UPG, gearN: GEARN, armN: ARMN, shop: SHOPX, pot: POT, mode: MODE, qst: COOP ? QSTAGES : null, shopR: SHOP_R, teams: TEAMS, teamsOn, stations: STN, taskN: TASKN, taskR: TASK_R, ph: round.phase, resumed: true }); broadcast({ t: 'ro', joined: old.id, name: old.name }); return; }
      let name = cleanName(msg.name);
      if (!name) return c.send({ t: 'err', s: '이름을 적어 주세요.' });
      const code = String(msg.code || '').trim();
      if (gate && code !== ADMIN_KEY && ![-1, 0, 1].some(d => clearCode(name, kstYmd(d), SALT) === code)) return c.send({ t: 'err', s: '입장 코드가 맞지 않아요. 옥정섬 SOS를 클리어한 화면의 이름과 코드를 그대로 적어 주세요.' });
      const same = [...players.values()].find(p => p.name === name && !online(p));
      if (same) players.delete(same.id);
      if ([...players.values()].some(p => p.name === name)) { let i = 2; while ([...players.values()].some(p => p.name === name + i)) i++; name = name + i; }
      if ([...players.values()].filter(online).length >= 40) return c.send({ t: 'err', s: '아레나가 가득 찼어요 (40명).' });
      const p = newPlayer(c, name); p.tok = crypto.randomBytes(8).toString('hex'); players.set(p.id, p); c.pid = p.id;
      c.send({ t: 'welcome', id: p.id, name, tok: p.tok, R, obs: OBS, skills: SKILLS, upg: UPG, gearN: GEARN, armN: ARMN, shop: SHOPX, pot: POT, mode: MODE, qst: COOP ? QSTAGES : null, shopR: SHOP_R, teams: TEAMS, teamsOn, stations: STN, taskN: TASKN, taskR: TASK_R, ph: round.phase });
      broadcast({ t: 'ro', joined: p.id, name });
      return;
    }
    if (msg.t === 'admin') {
      if (msg.key !== ADMIN_KEY) return c.send({ t: 'err', s: '관리자 비밀번호가 틀렸어요.' });
      c.admin = true; c.send({ t: 'adminok', R, obs: OBS, gate, teamsOn, teams: TEAMS, stations: STN, mode: MODE, ph: round.phase, addr: addresses() }); sendBoard(rankList());
      return;
    }
    if (c.admin && msg.t === 'cmd') return adminCmd(c, msg);
    const p = c.pid && players.get(c.pid); if (!p) return;
    p.lastIn = Date.now();
    if (msg.t === 'in') { const mx = +msg.mx || 0, mz = +msg.mz || 0, l = Math.hypot(mx, mz); p.mx = l > 1 ? mx / l : mx; p.mz = l > 1 ? mz / l : mz; }
    else if (msg.t === 'sk') useSkill(p, String(msg.id));
    else if (msg.t === 'up') upgrade(p, msg.w === 'arm' ? 'arm' : 'wpn');
    else if (msg.t === 'buy') { if (msg.s === 'pot') buyPot(p); else if (SHOPX[msg.s]) buy(p, msg.s, msg.v); }
    else if (msg.t === 'pot') drinkPot(p);
    else if (msg.t === 'task') startTask(p);
    else if (msg.t === 'ans') answerTask(p, msg.a);
    else if (msg.t === 'tcancel') cancelTask(p);
    else if (msg.t === 'emo') { const e = ['좋아!', '도와줘!', '1등 잡자!', 'ㅋㅋㅋ', '미안!', '고마워!'][msg.i | 0]; if (e && (!p.emoT || Date.now() - p.emoT > 2500)) { p.emoT = Date.now(); ev({ k: 'emo', id: p.id, s: e }); } }
  };
}
function adminCmd(c, msg) {
  if (msg.c === 'start') {
    const min = Math.max(2, Math.min(30, +msg.min || 10));
    for (const p of players.values()) resetPlayer(p);
    for (const t of teamSt) Object.assign(t, { pts: 0, lvups: 0, tasks: 0, kills: 0, buffUntil: 0 });
    mons.clear(); projs.length = 0; picks.clear(); pending.length = 0; boss = null; bossStrikes.length = 0; bossCd = 0; if (COOP) questReset();
    round.phase = 'play'; round.len = min * 60; round.endsAt = Date.now() + min * 60000;
    broadcast({ t: 'round', s: `${min}분 결승 라운드 시작! 모두 Lv 1부터 다시 시작해요. 마지막에는 바람의 벽이 좁혀져요.` });
  } else if (msg.c === 'stop') { if (round.phase === 'play') endRound(); }
  else if (msg.c === 'free') { round.phase = 'free'; broadcast({ t: 'msg', s: '자유 대전 모드예요.' }); }
  else if (msg.c === 'reset') { boss = null; bossStrikes.length = 0; if (COOP) questReset(); for (const p of players.values()) resetPlayer(p); for (const t of teamSt) Object.assign(t, { pts: 0, lvups: 0, tasks: 0, kills: 0, buffUntil: 0 }); mons.clear(); picks.clear(); broadcast({ t: 'msg', s: '선생님이 모두의 기록을 초기화했어요.' }); }
  else if (msg.c === 'boss') { bossCd = 0; spawnBoss('teacher'); }
  else if (msg.c === 'qreset') { questReset(); broadcast({ t: 'quest', s: 'reset', stage: 1, name: QSTAGES[1].n, desc: QSTAGES[1].d }); }
  else if (msg.c === 'qnext') { if (COOP && quest.stage < 4) questAdvance(); }
  else if (msg.c === 'shuffle') { shuffleTeams(); broadcast({ t: 'teams', teamsOn, mine: null, s: '선생님이 팀을 새로 나눴어요!' }); for (const p of players.values()) if (online(p)) p.c.send({ t: 'myteam', team: p.team }); }
  else if (msg.c === 'teams') { teamsOn = !!msg.on; broadcast({ t: 'teams', teamsOn, s: teamsOn ? '팀전이 켜졌어요! 같은 팀끼리는 공격되지 않아요.' : '팀전이 꺼졌어요. 이제 모두가 적이에요!' }); c.send({ t: 'adminok', R, obs: OBS, gate, teamsOn, ph: round.phase, addr: addresses() }); }
  else if (msg.c === 'gate') { gate = !!msg.on; c.send({ t: 'adminok', R, obs: OBS, gate, ph: round.phase, addr: addresses() }); }
  else if (msg.c === 'kick') { const p = players.get(+msg.id); if (p && p.c) { p.c.send({ t: 'err', s: '선생님이 퇴장시켰어요.' }); setTimeout(() => p.c.close(), 200); } }
  else if (msg.c === 'spawn' && process.env.ARENA_TEST && MON[msg.type]) { const d = MON[msg.type], id = nextId++; mons.set(id, { id, type: msg.type, x: +msg.x, z: +msg.z, hp: d.hp, max: d.hp, dir: 0, wT: 0, atkCd: 1, tgt: null, hitT: 0, cd2: 2 }); }
  else if (msg.c === 'dbg' && process.env.ARENA_TEST) { const p = players.get(+msg.id); if (p) Object.assign(p, msg.set); }
  else if (msg.c === 'code') { c.send({ t: 'code', name: cleanName(msg.name), code: clearCode(cleanName(msg.name), kstYmd(0), SALT) }); }
}
return { onConnect, step, conns, MODE };
}
const ROOMS = { battle: makeRoom('battle'), coop: makeRoom('coop') };

/* ======================= loop & start ======================= */
let last = Date.now();
setInterval(() => { const now = Date.now(), dt = Math.min(.1, (now - last) / 1000); last = now; for (const r of Object.values(ROOMS)) { try { r.step(dt); } catch (e) { console.error(r.MODE, e); } } }, TICK * 1000);
process.on('uncaughtException', e => console.error('uncaught', e));
server.listen(PORT, () => {
  const addr = addresses();
  console.log('\n  옥정섬 SOS · 클리어 아레나 서버가 켜졌어요!\n');
  console.log('  학생 접속 주소 (같은 와이파이):');
  for (const a of addr) console.log('    ' + a);
  if (!addr.length) console.log(`    http://localhost:${PORT}`);
  console.log('\n  선생님 관리·TV 화면: 위 주소 뒤에 /admin  →  비밀번호: ' + ADMIN_KEY);
  console.log('  (끄려면 이 창에서 Ctrl + C)\n');
});
module.exports = { clearCode, kstYmd, ROOMS };
