/* ===== 지열 정비대 (/geo) — 모둠 협동 서버 =====
   server.js에서 불러 씀. 아레나(1부·2부)와 따로 돌아감. 규칙은 geo-rules.js(class-game-kit에서 복사).
   통신량을 아끼려고: 위치는 같은 팀·같은 층 친구에게만, 초당 최대 6번. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const G = require('./geo-rules');

module.exports = function makeGeo({ ADMIN_KEY, PUB }) {
  const DIR = path.join(PUB, 'geo');
  const TEAM_N = 12, OFF_REASSIGN = 3 * 60000, OFF_FORGET = 40 * 60000, IDLE_KICK = 15 * 60000;
  const teams = new Map();             // 모둠 번호 → 팀
  const players = new Map();           // id → { id, tok, name, team, c, lv, a, on, offAt, actAt, gm }
  const admins = new Set();
  let nextId = 1, locked = false, code = newCode(), started = Date.now();
  let bytesOut = 0, msgsOut = 0;
  function newCode() { return String(1000 + crypto.randomInt(9000)); }
  function team(n) { if (!teams.has(n)) teams.set(n, G.newTeam(n, n + '모둠', crypto.randomInt(1 << 30))); return teams.get(n); }
  function send(p, obj) { if (p && p.c && p.c.open) { const s = JSON.stringify(obj); bytesOut += s.length + 2; msgsOut++; p.c.raw(0x81, Buffer.from(s)); } }
  function teamPlayers(T) { return T.members.map(m => players.get(m.id)).filter(p => p && p.c && p.c.open); }
  function toTeam(T, obj, except) { const s = JSON.stringify(obj), b = Buffer.from(s); for (const p of teamPlayers(T)) if (p !== except) { bytesOut += b.length + 2; msgsOut++; p.c.raw(0x81, b); } }
  function stateOf(T) { return G.view(T); }
  function pushEvents(T, ev) {
    if (!ev || !ev.length) { toTeam(T, { t: 'st', st: stateOf(T) }); return; }
    toTeam(T, { t: 'ev', e: ev, st: stateOf(T) });
    if (ev.some(e => e.k === 'start' || e.k === 'stage')) sendSeq(T);
  }
  function sendSeq(T) { for (const p of teamPlayers(T)) send(p, { t: 'seq', seq: G.seqFor(T, p.id), hand: G.handOf(T, p.id) }); }

  /* ---------- 정적 파일 (gzip, 메모리 캐시) ---------- */
  const cache = new Map();
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.webm': 'video/webm', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };
  function serve(req, res, f, longCache) {
    fs.stat(f, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('없는 페이지예요'); }
      const ext = path.extname(f).toLowerCase(), type = MIME[ext] || 'application/octet-stream', zipIt = /html|javascript|css|json|svg/.test(type);
      const hit = cache.get(f);
      const go = c => {
        const gz = zipIt && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
        const body = gz ? c.gz : c.buf;
        res.writeHead(200, Object.assign({ 'content-type': type, 'cache-control': longCache ? 'public, max-age=604800' : 'no-cache', 'content-length': body.length }, gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}));
        bytesOut += body.length; res.end(body);
      };
      if (hit && hit.mt === st.mtimeMs) return go(hit);
      fs.readFile(f, (e2, buf) => { if (e2) { res.writeHead(500); return res.end(); } const c = { buf, mt: st.mtimeMs, gz: zipIt ? zlib.gzipSync(buf, { level: 9 }) : null }; cache.set(f, c); go(c); });
    });
  }
  function http(req, res, p) {
    if (p === '/geo' || p === '/geo/') { serve(req, res, path.join(DIR, 'index.html')); return true; }
    if (p === '/geo/admin' || p === '/geo/tv') { serve(req, res, path.join(DIR, 'admin.html')); return true; }
    if (p.startsWith('/geo/')) { const f = path.normalize(path.join(DIR, p.slice(5))); if (!f.startsWith(DIR)) { res.writeHead(403); res.end(); return true; } serve(req, res, f, /\/assets\//.test(p)); return true; }
    return false;
  }

  /* ---------- 연결 ---------- */
  function onConnect(c) {
    c.geo = true;
    c.rate = 0; c.rateT = Date.now();
    c.onmsg = msg => {
      const now = Date.now();
      if (now - c.rateT > 1000) { c.rateT = now; c.rate = 0; }
      if (++c.rate > 60) return c.close();
      try { handle(c, msg, now); } catch (e) { console.error('geo msg', e); }
    };
    c.onclose = () => {
      admins.delete(c);
      const p = c.pid && players.get(c.pid); if (!p || p.c !== c) return;
      p.on = false; p.offAt = Date.now(); const T = teams.get(p.team);
      if (T) { const m = G.memberOf(T, p.id); if (m) { m.on = false; m.offAt = p.offAt; } toTeam(T, { t: 'st', st: stateOf(T) }); }
    };
  }
  const num = v => Number.isFinite(+v) ? +v : 0;
  function handle(c, msg, now) {
    if (msg.c === 'admin') return adminMsg(c, msg, now);
    if (msg.c === 'hi') return hello(c, msg, now);
    const p = c.pid && players.get(c.pid); if (!p || p.c !== c) return;
    const T = teams.get(p.team); if (!T) return;
    if (msg.c !== 'p') p.actAt = now;
    switch (msg.c) {
      case 'p': {   // 위치 [층, x, y, z, 방향, 고개, 상태비트, 도구]
        const a = Array.isArray(msg.a) ? msg.a.slice(0, 8).map(num) : null; if (!a) return;
        if (p.lastP && now - p.lastP < 120) return; p.lastP = now;
        if (a.some((v, i) => i && i < 4 && Math.abs(v) > 200)) return;
        p.a = a; p.lv = a[0] | 0; p.actAt = Math.max(p.actAt, now - 1);
        const out = JSON.stringify({ t: 'p', id: p.id, a }), b = Buffer.from(out);
        for (const q of teamPlayers(T)) if (q !== p && q.lv === p.lv) { bytesOut += b.length + 2; msgsOut++; q.c.raw(0x81, b); }
        return;
      }
      case 'd': {   // 땅 파기
        const d = { l: msg.l | 0, x: num(msg.x), y: num(msg.y), z: num(msg.z), r: Math.min(2, Math.max(0.3, num(msg.r))), m: msg.m | 0 };
        if (T.edits[d.l] && T.edits[d.l].length > 15000) return;
        const ev = G.onDig(T, p.id, d, now);
        toTeam(T, { t: 'd', by: p.id, d }, p);
        if (ev.length) pushEvents(T, ev);
        return;
      }
      case 'pl': { const r = G.onPlace(T, p.id, { l: msg.l | 0, k: String(msg.k), x: num(msg.x), y: num(msg.y), z: num(msg.z) }, now); if (r.err) return send(p, { t: 'err', s: r.err }); return pushEvents(T, r.ev); }
      case 'act': { const r = G.onAct(T, p.id, { id: String(msg.id), h: String(msg.h || ''), l: msg.l | 0, pos: msg.pos ? { x: num(msg.pos.x), y: num(msg.pos.y), z: num(msg.pos.z) } : null }, now); if (msg.id === 'reach') p.lv = msg.l | 0; if (r.err) return send(p, { t: 'err', s: r.err }); return pushEvents(T, r.ev); }
      case 'pn': { const r = G.onPanel(T, p.id, String(msg.r), now); if (r.err) return send(p, { t: 'err', s: r.err }); return pushEvents(T, r.ev); }
      case 'cd': { const r = G.onCard(T, p.id, String(msg.card), msg.slot | 0, now); if (r.err) return send(p, { t: 'err', s: r.err }); pushEvents(T, r.ev); return sendSeq(T); }
      case 'qa': { const r = G.onQuiz(T, p.id, String(msg.r), msg.a | 0, now); if (r.err) return send(p, { t: 'err', s: r.err }); return pushEvents(T, r.ev); }
      case 'role': { if (T.started) return; const r = G.pickRole(T, p.id, String(msg.r)); if (r.err) return send(p, { t: 'err', s: r.err }); return pushEvents(T, []); }
      case 'go': { if (T.started) return; const ev = G.start(T, now); return pushEvents(T, ev); }
      case 'pg': { const pg = { l: msg.l | 0, x: num(msg.x), y: num(msg.y), z: num(msg.z), k: String(msg.k || '').slice(0, 12) }; return toTeam(T, { t: 'pg', by: p.id, pg }); }
      case 'fx': {   // 냉각기 분사·드릴 불꽃 같은 효과 (같은 층 친구에게만)
        if (p.lastFx && now - p.lastFx < 150) return; p.lastFx = now;
        const fx = { k: String(msg.k || '').slice(0, 8), l: msg.l | 0, x: num(msg.x), y: num(msg.y), z: num(msg.z), dx: num(msg.dx), dy: num(msg.dy), dz: num(msg.dz) };
        const out = JSON.stringify({ t: 'fx', by: p.id, fx }), b = Buffer.from(out);
        for (const q of teamPlayers(T)) if (q !== p && q.lv === fx.l) { bytesOut += b.length + 2; msgsOut++; q.c.raw(0x81, b); }
        return;
      }
      case 'say': { const i = msg.i | 0; if (i >= 0 && i < 12) toTeam(T, { t: 'say', by: p.id, i }); return; }
    }
  }
  function hello(c, msg, now) {
    const name = String(msg.name || '').replace(/[<>&"]/g, '').trim().slice(0, 10), tn = msg.team | 0, code_ = String(msg.code || '').trim();
    const gm = ADMIN_KEY && code_ === ADMIN_KEY;
    // 다시 접속 (토큰)
    let p = msg.tok ? [...players.values()].find(q => q.tok === msg.tok) : null;
    if (p && locked && !p.gm) return c.send({ t: 'err', s: '지금은 닫혀 있어요. 선생님이 열어 주면 들어올 수 있어요.', fatal: true });
    if (!p) {
      if (!name) return c.send({ t: 'err', s: '이름을 적어 주세요.' });
      if (!(tn >= 1 && tn <= TEAM_N)) return c.send({ t: 'err', s: '모둠 번호(1~' + TEAM_N + ')를 골라 주세요.' });
      if (locked && !gm) return c.send({ t: 'err', s: '지금은 닫혀 있어요. 선생님이 열어 주면 들어올 수 있어요.', fatal: true });
      if (!gm && code_ !== code) return c.send({ t: 'err', s: '입장 코드가 맞지 않아요. TV 화면의 네 자리 숫자를 적어 주세요.' });
      // 새로고침: 같은 모둠·같은 이름이고 접속이 끊긴 사람이면 그 자리로
      p = [...players.values()].find(q => q.team === tn && q.name === name && !(q.c && q.c.open));
      if (!p) {
        const T = team(tn);
        if (T.members.filter(m => m.on).length >= 6) return c.send({ t: 'err', s: '이 모둠은 이미 6명이에요. 다른 모둠 번호를 골라 주세요.' });
        p = { id: nextId++, tok: crypto.randomBytes(9).toString('base64url'), name, team: tn, lv: 0, a: null, gm };
        players.set(p.id, p);
      }
    }
    if (p.c && p.c !== c && p.c.open) { try { p.c.send({ t: 'err', s: '다른 기기에서 같은 이름으로 들어왔어요.', fatal: true }); p.c.onclose = null; p.c.close(); } catch (e) { /* */ } }
    p.c = c; c.pid = p.id; p.on = true; p.offAt = 0; p.actAt = now;
    const T = team(p.team);
    G.join(T, { id: p.id, name: p.name });
    c.send({ t: 'w', id: p.id, tok: p.tok, name: p.name, gm: !!p.gm, st: stateOf(T), seq: G.seqFor(T, p.id), hand: G.handOf(T, p.id), edits: T.edits, places: T.places,
      mates: teamPlayers(T).filter(q => q !== p && q.a).map(q => ({ id: q.id, a: q.a })) });
    toTeam(T, { t: 'st', st: stateOf(T) }, p);
  }

  /* ---------- 관리(TV) 화면 ---------- */
  function adminMsg(c, msg, now) {
    if (String(msg.key || '') !== ADMIN_KEY) return c.send({ t: 'err', s: '관리자 비밀번호가 틀렸어요.' });
    if (!admins.has(c)) { admins.add(c); c.onclose = (prev => () => { admins.delete(c); if (prev) prev(); })(c.onclose); }
    const T = msg.team ? teams.get(msg.team | 0) : null;
    switch (msg.op) {
      case 'code': code = newCode(); break;
      case 'lock': locked = !!msg.on; break;
      case 'kickall': locked = true; for (const p of players.values()) if (!p.gm && p.c && p.c.open) { p.c.send({ t: 'err', s: '수업이 끝났어요. 수고했어요!', fatal: true }); p.c.close(); } players.clear(); teams.clear(); break;
      case 'resetTeam': if (T) { const fresh = G.newTeam(T.id, T.name, crypto.randomInt(1 << 30)); fresh.members = T.members.map(m => Object.assign(m, { lv: 0 })); teams.set(T.id, fresh); for (const p of teamPlayers(fresh)) { p.lv = 0; p.c.send({ t: 'reset' }); } } break;
      case 'skip': if (T && T.started && !T.clear) { const S = G.STAGES[T.stage]; let ev = []; for (const t of S.tasks) if (!T.done[t.id]) { T.done[t.id] = now; T.doneBy[t.id] = null; } T.stageT[T.stage] = now; if (T.stage < G.STAGES.length - 1) { T.stage++; T.unlocked = Math.max(T.unlocked, G.STAGES[T.stage].lv); ev = [{ k: 'stage', s: T.stage, skip: true }]; } else { T.clear = true; T.tEnd = now; ev = [{ k: 'clear' }]; } pushEvents(T, ev); } break;
      case 'start': if (T && !T.started) pushEvents(T, G.start(T, now)); break;
      case 'resetAll': for (const p of players.values()) if (p.c && p.c.open) p.c.send({ t: 'reset' }); teams.clear(); for (const p of players.values()) { const T2 = team(p.team); G.join(T2, { id: p.id, name: p.name }); } break;
    }
    adminSnap(c, now);
  }
  function adminSnap(c, now) {
    const list = [...teams.values()].filter(T => T.members.length).sort((a, b) => a.id - b.id).map(T => {
      const v = G.view(T);
      v.members.forEach(m => { const p = players.get(m.id); m.depth = p && p.a ? G.depthAt(p.a[0], p.a[2]) : 0; m.lv = p ? p.lv : 0; });
      return v;
    });
    c.send({ t: 'admin', code, locked, teams: list, now, up: now - started, kb: Math.round(bytesOut / 1024), msgs: msgsOut, stages: G.STAGES.map(s => ({ title: s.title, n: s.tasks.length })), starMax: G.STAR_MAX });
  }

  /* ---------- 1초마다 ---------- */
  setInterval(() => {
    const now = Date.now();
    for (const T of teams.values()) {
      const ev = G.tick(T, now); if (ev.length) pushEvents(T, ev);
      // 오래 끊긴 친구의 역할은 접속 중인 친구에게 넘김
      if (T.started) {
        let moved = false;
        for (const m of T.members) if (!m.on && m.roles.length && m.offAt && now - m.offAt > OFF_REASSIGN && T.members.some(x => x.on)) { moved = true; }
        if (moved) { const before = JSON.stringify(T.members.map(m => m.roles)); G.fillRoles(T); if (JSON.stringify(T.members.map(m => m.roles)) !== before) { pushEvents(T, [{ k: 'roles' }]); sendSeq(T); } }
      }
    }
    for (const p of players.values()) {
      if (!p.on && p.offAt && now - p.offAt > OFF_FORGET) { players.delete(p.id); const T = teams.get(p.team); if (T) { T.members = T.members.filter(m => m.id !== p.id); if (!T.members.length) teams.delete(T.id); } }
      else if (p.on && !p.gm && now - p.actAt > IDLE_KICK && p.c) { p.c.send({ t: 'err', s: '오랫동안 움직임이 없어서 나갔어요. 다시 들어오면 이어서 할 수 있어요.', fatal: true }); p.c.close(); }
    }
  }, 1000);
  setInterval(() => { const now = Date.now(); for (const c of admins) adminSnap(c, now); }, 2000);
  // 연결 유지 (20초마다 확인)
  setInterval(() => { for (const p of players.values()) if (p.c && p.c.open) { if (p.c.alive === false) { p.c.close(); continue; } p.c.alive = false; p.c.ping(); } for (const c of admins) { if (c.alive === false) { c.close(); continue; } c.alive = false; c.ping(); } }, 20000);

  return { http, onConnect, stats: () => ({ teams: teams.size, players: players.size, kb: Math.round(bytesOut / 1024) }) };
};
