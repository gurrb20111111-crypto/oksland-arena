/* ===== 물빛섬 전력 관제실 (/ocean) — 모둠 협동 서버 =====
   server.js에서 불러 씀. 아레나·지열 정비대와 따로 돌아감. 규칙·바다 계산은 ocean-rules.js.
   통신량을 아끼려고: 작전 중에는 1초에 한 번 작은 상태(약 0.6KB)만 보내고, 그래프는 새 점만 보냄. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const G = require('./ocean-rules');

module.exports = function makeOcean({ ADMIN_KEY, PUB }) {
  const DIR = path.join(PUB, 'ocean');
  const TEAM_N = 12, OFF_FORGET = 40 * 60000, IDLE_KICK = 15 * 60000;
  const teams = new Map(), players = new Map(), admins = new Set();
  let nextId = 1, locked = false, code = newCode(), started = Date.now(), bytesOut = 0;
  function newCode() { return String(1000 + crypto.randomInt(9000)); }
  function team(n) { if (!teams.has(n)) teams.set(n, G.newTeam(n, n + '모둠')); return teams.get(n); }
  function rawTo(p, b) { if (p && p.c && p.c.open) { bytesOut += b.length + 2; p.c.raw(0x81, b); } }
  function send(p, obj) { rawTo(p, Buffer.from(JSON.stringify(obj))); }
  function teamPlayers(T) { return T.members.map(m => players.get(m.id)).filter(p => p && p.c && p.c.open); }
  function toTeam(T, obj, except) { const b = Buffer.from(JSON.stringify(obj)); for (const p of teamPlayers(T)) if (p !== except) rawTo(p, b); }
  function push(T, ev) {
    const big = ev && ev.some(e => ['end', 'result', 'clear', 'brief', 'run'].includes(e.k));
    toTeam(T, ev && ev.length ? { t: 'ev', e: ev, st: G.view(T, big) } : { t: 'st', st: G.view(T, false) });
  }

  /* ---------- 정적 파일 (gzip, 메모리 캐시) ---------- */
  const cache = new Map();
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  function serve(req, res, f) {
    fs.stat(f, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('없는 페이지예요'); }
      const type = MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', zipIt = /html|javascript|css|json|svg/.test(type);
      const go = c => {
        const gz = zipIt && /\bgzip\b/.test(req.headers['accept-encoding'] || ''), body = gz ? c.gz : c.buf;
        res.writeHead(200, Object.assign({ 'content-type': type, 'cache-control': 'no-cache', 'content-length': body.length }, gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}));
        bytesOut += body.length; res.end(body);
      };
      const hit = cache.get(f); if (hit && hit.mt === st.mtimeMs) return go(hit);
      fs.readFile(f, (e2, buf) => { if (e2) { res.writeHead(500); return res.end(); } const c = { buf, mt: st.mtimeMs, gz: zipIt ? zlib.gzipSync(buf, { level: 9 }) : null }; cache.set(f, c); go(c); });
    });
  }
  function http(req, res, p) {
    if (p === '/ocean' || p === '/ocean/') { serve(req, res, path.join(DIR, 'index.html')); return true; }
    if (p === '/ocean/rules.js') { serve(req, res, path.join(__dirname, 'ocean-rules.js')); return true; }
    if (p === '/ocean/admin' || p === '/ocean/tv') { serve(req, res, path.join(DIR, 'admin.html')); return true; }
    if (p.startsWith('/ocean/')) { const f = path.normalize(path.join(DIR, p.slice(7))); if (!f.startsWith(DIR)) { res.writeHead(403); res.end(); return true; } serve(req, res, f); return true; }
    return false;
  }

  /* ---------- 연결 ---------- */
  function onConnect(c) {
    c.rate = 0; c.rateT = Date.now();
    c.onmsg = msg => {
      const now = Date.now();
      if (now - c.rateT > 1000) { c.rateT = now; c.rate = 0; }
      if (++c.rate > 40) return;
      try { handle(c, msg, now); } catch (e) { console.error('ocean msg', e); }
    };
    c.onclose = () => {
      admins.delete(c);
      const p = c.pid && players.get(c.pid); if (!p || p.c !== c) return;
      p.on = false; p.offAt = Date.now(); const T = teams.get(p.team);
      if (T) { const m = G.memberOf(T, p.id); if (m) { m.on = false; m.offAt = p.offAt; } push(T, []); }
    };
  }
  function reply(p, T, r) { if (r.err) return send(p, { t: 'err', s: r.err }); push(T, r.ev || []); }
  function handle(c, msg, now) {
    if (msg.c === 'admin') return adminMsg(c, msg, now);
    if (msg.c === 'hi') return hello(c, msg, now);
    const p = c.pid && players.get(c.pid); if (!p || p.c !== c) return;
    const T = teams.get(p.team); if (!T) return;
    p.actAt = now;
    switch (msg.c) {
      case 'role': return reply(p, T, G.pickRole(T, p.id, String(msg.r)));
      case 'go': if (!T.started) push(T, G.start(T, now)); return;
      case 'setup': return reply(p, T, G.onSetup(T, p.id, String(msg.k), String(msg.v)));
      case 'ready': return reply(p, T, G.onReady(T, p.id, now));
      case 'ctl': { const r = G.onCtl(T, p.id, String(msg.d), msg.d === 'otec' ? +msg.v : String(msg.v)); if (r.err) return send(p, { t: 'err', s: r.err }); if (r.ev.length) push(T, r.ev); else liveTo(T); return; }
      case 'fix': { const r = G.onFix(T, p.id, String(msg.d)); if (r.err) return send(p, { t: 'err', s: r.err }); if (r.ev.length) push(T, r.ev); else liveTo(T); return; }
      case 'qa': return reply(p, T, G.onQuiz(T, p.id, msg.a | 0));
      case 'next': push(T, G.onNext(T, now)); return;
      case 'say': { const i = msg.i | 0; if (i >= 0 && i < 12) { if (p.lastSay && now - p.lastSay < 1500) return; p.lastSay = now; toTeam(T, { t: 'say', by: p.id, i }); } return; }
    }
  }
  function liveTo(T, smp) { const lv = G.liveView(T); if (!lv) return; const o = { t: 'lv', lv }; if (smp) o.smp = smp; toTeam(T, o); }
  function hello(c, msg, now) {
    const name = String(msg.name || '').replace(/[<>&"]/g, '').trim().slice(0, 10), tn = msg.team | 0, code_ = String(msg.code || '').trim();
    const gm = !!ADMIN_KEY && code_ === ADMIN_KEY;
    let p = msg.tok ? [...players.values()].find(q => q.tok === msg.tok) : null;
    if (p && locked && !p.gm) return c.send({ t: 'err', s: '지금은 닫혀 있어요. 선생님이 열어 주면 들어올 수 있어요.', fatal: true });
    if (!p) {
      if (!name) return c.send({ t: 'err', s: '이름을 적어 주세요.' });
      if (!(tn >= 1 && tn <= TEAM_N)) return c.send({ t: 'err', s: '모둠 번호(1~' + TEAM_N + ')를 골라 주세요.' });
      if (locked && !gm) return c.send({ t: 'err', s: '지금은 닫혀 있어요. 선생님이 열어 주면 들어올 수 있어요.', fatal: true });
      if (!gm && code_ !== code) return c.send({ t: 'err', s: '입장 코드가 맞지 않아요. TV 화면의 네 자리 숫자를 적어 주세요.' });
      p = [...players.values()].find(q => q.team === tn && q.name === name && !(q.c && q.c.open));
      if (!p) {
        const T = team(tn);
        if (G.onlineMembers(T).length >= 6) return c.send({ t: 'err', s: '이 모둠은 이미 6명이에요. 다른 모둠 번호를 골라 주세요.' });
        p = { id: nextId++, tok: crypto.randomBytes(9).toString('base64url'), name, team: tn, gm };
        players.set(p.id, p);
      }
    }
    if (p.c && p.c !== c && p.c.open) { try { p.c.send({ t: 'err', s: '다른 기기에서 같은 이름으로 들어왔어요.', fatal: true }); p.c.onclose = null; p.c.close(); } catch (e) { /* */ } }
    p.c = c; c.pid = p.id; p.on = true; p.offAt = 0; p.actAt = now;
    const T = team(p.team);
    G.join(T, { id: p.id, name: p.name });
    c.send({ t: 'w', id: p.id, tok: p.tok, name: p.name, gm: !!p.gm, st: G.view(T, true), rules: { rounds: G.ROUNDS.map(R => ({ title: R.title, sub: R.sub, brief: R.brief, target: R.target, fuel: R.fuel, extra: R.extra, season: R.season, hour0: R.hour0 })), quiz: G.QUIZ, fault: G.FAULT, cap: G.CAP, fixTaps: G.FIX_TAPS, lakeMax: G.LAKE_MAX, streamLimit: G.STREAM_LIMIT, waveAlarm: G.WAVE_ALARM, waveClear: G.WAVE_CLEAR, secPerH: G.SEC_PER_H } });
    push(T, []);
  }

  /* ---------- 관리(TV) 화면 ---------- */
  function adminMsg(c, msg, now) {
    if (!ADMIN_KEY || String(msg.key || '') !== ADMIN_KEY) return c.send({ t: 'err', s: '관리자 비밀번호가 틀렸어요.' });
    if (!admins.has(c)) { admins.add(c); const prev = c.onclose; c.onclose = () => { admins.delete(c); if (prev) prev(); }; }
    const T = msg.team ? teams.get(msg.team | 0) : null;
    switch (msg.op) {
      case 'code': code = newCode(); break;
      case 'lock': locked = !!msg.on; break;
      case 'kickall': locked = true; for (const p of players.values()) if (!p.gm && p.c && p.c.open) { p.c.send({ t: 'err', s: '수업이 끝났어요. 수고했어요!', fatal: true }); p.c.close(); } players.clear(); teams.clear(); break;
      case 'skip': if (T) push(T, G.skip(T, now)); break;
      case 'startAll': for (const T2 of teams.values()) if (!T2.started && G.onlineMembers(T2).length) push(T2, G.start(T2, now)); break;
      case 'resetTeam': if (T) { const fresh = G.newTeam(T.id, T.name); fresh.members = T.members.map(m => Object.assign(m, { roles: [] })); teams.set(T.id, fresh); for (const p of teamPlayers(fresh)) send(p, { t: 'reset' }); push(fresh, []); } break;
    }
    adminSnap(c, now);
  }
  function adminSnap(c, now) {
    const list = [...teams.values()].filter(T => T.members.length).sort((a, b) => a.id - b.id).map(T => {
      const lv = T.phase === 'run' ? G.liveView(T) : null;
      return { id: T.id, name: T.name, phase: T.phase, round: T.round, started: T.started, t0: T.t0, tEnd: T.tEnd, clear: T.clear, stars: G.stars(T),
        members: T.members.map(m => ({ name: m.name, roles: m.roles, on: m.on })),
        live: lv && { clock: lv.clock, share: lv.share, batt: lv.batt, fuel: lv.fuel, black: lv.black, blackMin: lv.blackMin, out: lv.out, diesel: lv.diesel.on },
        results: T.results.map(r => r && { share: r.share, blackMin: r.blackMin, star: r.star, diesel: r.diesel, gen: r.gen }) };
    });
    let oceanMWh = 0; for (const T of teams.values()) { for (const r of T.results) if (r) for (const k of G.ROLES) oceanMWh += Math.max(0, r.gen[k]); }
    c.send({ t: 'admin', code, locked, teams: list, now, up: now - started, kb: Math.round(bytesOut / 1024), starMax: G.STAR_MAX, rounds: G.ROUNDS.map(R => ({ title: R.title, target: R.target })), oceanMWh: Math.round(oceanMWh) });
  }

  /* ---------- 0.5초마다 계산, 1초마다 상태 보내기 ---------- */
  let tickN = 0;
  setInterval(() => {
    const now = Date.now(); tickN++;
    for (const T of teams.values()) {
      if (T.phase !== 'run') continue;
      const before = T.sim.hist.length;
      const ev = G.tick(T, now);
      if (ev.length) push(T, ev);
      if (T.phase === 'run') { const smp = T.sim.hist.length > before ? T.sim.hist.slice(before) : null; if (smp || tickN % 2 === 0) liveTo(T, smp); }
      if (T.started && G.fillRoles(T, now)) push(T, [{ k: 'roles' }]);
    }
  }, 500);
  setInterval(() => {
    const now = Date.now();
    for (const p of players.values()) {
      if (!p.on && p.offAt && now - p.offAt > OFF_FORGET) { players.delete(p.id); const T = teams.get(p.team); if (T) { T.members = T.members.filter(m => m.id !== p.id); if (!T.members.length) teams.delete(T.id); } }
      else if (p.on && !p.gm && now - p.actAt > IDLE_KICK && p.c) { p.c.send({ t: 'err', s: '오랫동안 움직임이 없어서 나갔어요. 다시 들어오면 이어서 할 수 있어요.', fatal: true }); p.c.close(); }
    }
    for (const T of teams.values()) if (T.started && T.phase !== 'run' && G.fillRoles(T, now)) push(T, [{ k: 'roles' }]);
    for (const c of admins) adminSnap(c, now);
  }, 2000);
  setInterval(() => { for (const p of players.values()) if (p.c && p.c.open) { if (p.c.alive === false) { p.c.close(); continue; } p.c.alive = false; p.c.ping(); } for (const c of admins) { if (c.alive === false) { c.close(); continue; } c.alive = false; c.ping(); } }, 20000);

  return { http, onConnect, stats: () => ({ teams: teams.size, players: players.size, kb: Math.round(bytesOut / 1024) }) };
};
