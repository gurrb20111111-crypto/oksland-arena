/* 교실 서버 안내소 (2026-11-02)
 * 아이폰(iSH) 같은 교실 서버는 학교 와이파이(DHCP)라 IP가 자꾸 바뀜.
 * → 교실 서버가 켜져 있는 동안 자기 현재 IP를 Render(안내소)에 30~45초마다 알리고,
 *   학생이 늘 쓰던 Render 주소(QR·게임 버튼)로 들어오면 안내소가 교실 서버로 넘겨 줌.
 *   교실 서버가 꺼지면(알림이 끊기면) 2분 안에 자동으로 Render에서 그대로 진행.
 *
 * 역할
 *   안내소(hub)  : Render에서 돌 때(RENDER 환경 변수) 또는 HUB_MODE=hub
 *   교실(local)  : 그 밖(아이폰 iSH, 선생님 PC). ANNOUNCE=0 이면 알리지 않음
 *
 * 환경 변수
 *   HUB_URL  안내소 주소 (기본 https://oksland-arena.onrender.com)
 *   HUB_KEY  안내소와 교실 서버가 같이 쓰는 비밀 열쇠. 교실 서버는 이 값을 정해야 알리기 시작함(= Render의 ADMIN_KEY).
 *            안내소는 HUB_KEY가 없으면 ADMIN_KEY로 확인. 서명(HMAC)에만 쓰고 그대로 보내지 않음
 *   LAN_IP   교실 서버 IP를 자동으로 못 찾을 때 직접 적기
 *   ROUTE    0 이면 교실 서버를 켜도 처음엔 학생을 넘기지 않음(/hub 화면에서 켤 수 있음)
 */
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const dgram = require('dgram');

module.exports = function makeHub({ ADMIN_KEY, PORT, PUB }) {
  const MODE = (process.env.HUB_MODE || (process.env.RENDER ? 'hub' : 'local')).toLowerCase();
  const KEY = process.env.HUB_KEY || ADMIN_KEY;
  const HUB_URL = (process.env.HUB_URL || 'https://oksland-arena.onrender.com').replace(/\/+$/, '');
  const FRESH = 120e3, EVERY = 40e3;
  const sign = (s) => crypto.createHmac('sha256', KEY).update(s).digest('hex');
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const isPrivate = ip => /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(ip) && ip.split('.').every(n => +n <= 255);

  /* ---------- 공통: 작은 도구 ---------- */
  function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
  function body(req, cb) {
    let s = '', bad = false;
    req.on('data', d => { s += d; if (s.length > 4096) { bad = true; req.destroy(); } });
    req.on('end', () => { if (bad) return cb(null); try { cb(JSON.parse(s || '{}')); } catch (e) { cb(null); } });
  }
  function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
  function adminOk(k) { return typeof k === 'string' && k.length > 0 && same(k, ADMIN_KEY); }
  function servePage(res) {
    fs.readFile(path.join(PUB, 'hub.html'), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(buf);
    });
  }

  /* =================== 안내소 (Render) =================== */
  let rec = null;           // { url, ip, port, route, at, ts, from }
  let lastTs = 0;
  // 서명이 틀린 요청이 1분에 너무 많으면(서버 보호) 잠깐 거절. 학교 공인 IP는 학생과 같아서 IP별로 막지 않음
  // → 대신 열쇠를 12자 이상으로 강제해 맞히기가 사실상 불가능하게 함
  let badMin = 0, badN = 0;
  const flooded = () => { const m = Math.floor(Date.now() / 60e3); if (m !== badMin) { badMin = m; badN = 0; } return badN > 120; };
  let holdUntil = 0;   // Render 안내 화면에서 '멈추기'를 누르면 1시간 동안 교실 서버가 다시 켜도 넘기지 않음
  const live = () => !!(rec && rec.route && Date.now() - rec.at < FRESH && Date.now() > holdUntil);

  function bouncePage(target) {
    const t = JSON.stringify(target).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>교실 서버로 이동</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0E1A24;color:#EAF4F4;font:17px/1.6 system-ui,-apple-system,'Apple SD Gothic Neo',sans-serif}
.c{max-width:420px;padding:28px 22px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#A9C2C6;margin:6px 0}
a.b{display:block;margin:14px 0 0;padding:14px;border-radius:12px;background:#2BC4B0;color:#06231F;font-weight:800;text-decoration:none}
a.s{background:#22384A;color:#EAF4F4;font-weight:600}#more{display:none}
</style></head><body><div class="c"><h1 id="h">교실 서버로 이동하는 중…</h1><p id="msg">선생님의 교실 서버(같은 와이파이)로 연결해요.</p>
<div id="more"><a class="b" id="go" href="#">교실 서버로 다시 시도</a><a class="b s" id="stay" href="#">클라우드 서버에서 그대로 하기</a>
<p style="font-size:14px">교실 서버가 안 열리면 학교 와이파이에 연결됐는지 확인하고, 그래도 안 되면 클라우드 서버로 들어가요.</p></div></div>
<script>
var T=${t}+location.hash, K='hubBounce';
var s=location.pathname+location.search; s+=(location.search?'&':'?')+'stay=1'+location.hash;
document.getElementById('go').href=T; document.getElementById('stay').href=s;
var last=0; try{last=+sessionStorage.getItem(K)||0}catch(e){}
if(Date.now()-last<20000){document.getElementById('h').textContent='교실 서버가 안 열렸나요?';document.getElementById('msg').textContent='아래에서 골라 주세요.';document.getElementById('more').style.display='block';}
else{try{sessionStorage.setItem(K,String(Date.now()))}catch(e){}location.href=T;setTimeout(function(){document.getElementById('more').style.display='block'},4000);}
</script></body></html>`;
  }

  function hubHttp(req, res, p) {
    if (p === '/hub/announce' && req.method === 'POST') {
      const ip = clientIp(req);
      if (flooded()) return json(res, 429, { ok: false, err: '잠시 뒤 다시.' }), true;
      body(req, m => {
        if (!m) return json(res, 400, { ok: false });
        if (KEY.length < 12) return json(res, 403, { ok: false, weak: true, err: 'Render의 열쇠가 너무 짧아요. Render Environment에 HUB_KEY(12자 이상)를 따로 정해 주세요.' });
        const lan = String(m.ip || ''), port = +m.port, ts = +m.ts, route = !!m.route;
        const okSig = typeof m.sig === 'string' && same(m.sig, sign(`${lan}|${port}|${route ? 1 : 0}|${ts}`));
        if (!okSig) { badN++; if (badN === 20) console.log(`[hub] 틀린 열쇠 알림이 많아요 (마지막: ${ip})`); return json(res, 403, { ok: false, err: '열쇠(HUB_KEY)가 Render의 열쇠와 달라요.' }); }
        if (Math.abs(Date.now() - ts) > 120e3 || ts <= lastTs) return json(res, 400, { ok: false, err: '시계가 맞지 않거나 오래된 알림이에요.' });
        if (!isPrivate(lan) || !(port > 0 && port < 65536)) return json(res, 400, { ok: false, err: '학교 안 주소(192.168.x.x 등)만 받아요.' });
        lastTs = ts;
        const url = `http://${lan}:${port}`;
        if (!rec || rec.url !== url || rec.route !== route) console.log(`[hub] 교실 서버 ${route ? '안내 켬' : '안내 끔'} → ${url}`);
        rec = { url, ip: lan, port, route, at: Date.now(), ts, from: ip };
        json(res, 200, { ok: true, url, route });
      });
      return true;
    }
    if (p === '/hub/status' && req.method === 'POST') {
      body(req, m => {
        if (!m || !adminOk(m.key)) return json(res, 403, { ok: false });
        if (m.off) { holdUntil = Date.now() + 3600e3; console.log('[hub] 안내 화면에서 1시간 멈춤'); }
        if (m.resume) { holdUntil = 0; console.log('[hub] 안내 다시 켬'); }
        json(res, 200, { ok: true, mode: 'hub', live: live(), held: holdUntil > Date.now() ? Math.ceil((holdUntil - Date.now()) / 60e3) : 0, rec: rec && { url: rec.url, route: rec.route, ago: Math.round((Date.now() - rec.at) / 1000), from: rec.from } });
      });
      return true;
    }
    if (p === '/hub' || p === '/hub/') { servePage(res); return true; }
    if (p === '/hub/unstay') { res.writeHead(302, { location: '/', 'set-cookie': 'hubstay=; Path=/; Max-Age=0; Secure; SameSite=Lax' }); res.end(); return true; }

    // 학생·TV가 페이지를 열 때(문서 이동만) 교실 서버로 넘기기
    if (req.method !== 'GET' || !live() || p === '/healthz' || p.startsWith('/hub')) return false;
    const nav = req.headers['sec-fetch-mode'] ? req.headers['sec-fetch-mode'] === 'navigate' : /text\/html/.test(req.headers.accept || '');
    if (!nav) return false;
    const q = (req.url || '').split('?')[1] || '';
    if (/(^|&)stay=1(&|$)/.test(q)) { res.setHeader('set-cookie', 'hubstay=1; Path=/; Max-Age=7200; Secure; SameSite=Lax'); return false; }
    if (/(^|;\s*)hubstay=1/.test(req.headers.cookie || '')) return false;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(bouncePage(rec.url + (req.url || '/')));
    return true;
  }

  /* =================== 교실 서버 (아이폰 iSH 등) =================== */
  const st = { ip: null, route: process.env.ROUTE !== '0', ok: null, err: '', at: 0, url: '' };
  // 열쇠(HUB_KEY)를 따로 정했을 때만 알림 — 선생님 PC에서 아무 설정 없이 켜면 예전처럼 혼자 돌아감
  const announceOn = MODE === 'local' && process.env.ANNOUNCE !== '0' && !!process.env.HUB_KEY;

  function lanFromInterfaces() {
    try { for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) return a.address; } catch (e) { /* iSH는 여기서 못 읽는 경우가 많음 */ }
    return null;
  }
  // 바깥으로 UDP '연결'만 해 보고(패킷은 안 보냄) 내 쪽 주소를 읽음 — iSH에서도 실제 와이파이 IP가 나옴
  function lanFromUdp(cb) {
    let done = false; const fin = v => { if (done) return; done = true; try { s.close(); } catch (e) { /* */ } cb(v); };
    const s = dgram.createSocket('udp4');
    s.on('error', () => fin(null));
    try { s.connect(53, '1.1.1.1', () => { try { const a = s.address().address; fin(isPrivate(a) ? a : null); } catch (e) { fin(null); } }); } catch (e) { fin(null); }
    setTimeout(() => fin(null), 1500);
  }
  function detectIp(cb) {
    if (process.env.LAN_IP) return cb(process.env.LAN_IP);
    const a = lanFromInterfaces(); if (a) return cb(a);
    lanFromUdp(cb);
  }

  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });   // iSH는 TLS 연결이 느려서 한 번 연 연결을 계속 씀
  function post(route, cb) {
    const ip = st.ip; if (!ip) return cb && cb(false, '교실 서버 IP를 못 찾았어요');
    const ts = Date.now(), m = { ip, port: PORT, ts, route, sig: sign(`${ip}|${PORT}|${route ? 1 : 0}|${ts}`) };
    const u = new URL(HUB_URL + '/hub/announce'), lib = u.protocol === 'http:' ? http : https;
    const data = JSON.stringify(m);
    const req = lib.request(u, { method: 'POST', agent: u.protocol === 'https:' ? agent : undefined, timeout: 70e3, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let s = ''; res.on('data', d => { s += d; }); res.on('end', () => { let r = {}; try { r = JSON.parse(s); } catch (e) { /* */ } cb && cb(res.statusCode === 200 && r.ok, r.err || ('응답 ' + res.statusCode), res.statusCode); });
    });
    req.on('timeout', () => req.destroy(new Error('시간 초과(Render가 깨어나는 중일 수 있어요)')));
    req.on('error', e => cb && cb(false, e.message));
    req.end(data);
  }
  function tick() {
    detectIp(ip => {
      if (ip !== st.ip) { console.log(ip ? `[hub] 교실 서버 주소: http://${ip}:${PORT}` : '[hub] 와이파이 IP를 못 찾았어요 → 아이폰 설정 > Wi-Fi > (i)의 IP를 ish.env의 LAN_IP에 적어 주세요'); st.ip = ip; }
      st.url = ip ? `http://${ip}:${PORT}` : '';
      if (st.stop) return;
      post(st.route, (ok, err, code) => {
        if (code === 403) { st.stop = true; console.log('[hub] 열쇠가 맞지 않아 알리기를 멈췄어요 → ish.env의 HUB_KEY를 Render의 ADMIN_KEY와 똑같이 고친 뒤 다시 켜 주세요'); }
        if (ok !== st.ok) console.log(ok ? `[hub] 안내소(${HUB_URL}) 연결됨 — 학생은 Render 주소 그대로 쓰면 이 서버로 와요${st.route ? '' : ' (지금은 안내 꺼짐)'}` : `[hub] 안내소에 못 알렸어요: ${err}`);
        st.ok = ok; st.err = ok ? '' : err; st.at = Date.now();
      });
    });
  }
  function localHttp(req, res, p) {
    if (p === '/hub' || p === '/hub/') { servePage(res); return true; }
    if (p === '/hub/status' && req.method === 'POST') {
      body(req, m => {
        if (!m || !adminOk(m.key)) return json(res, 403, { ok: false });
        if (typeof m.route === 'boolean') setRoute(m.route, m.route ? '' : '선생님이 껐어요');
        if (m.moveAll && hooks.moveAll) hooks.moveAll();
        const ld = hooks.load ? hooks.load() : null;
        json(res, 200, { ok: true, mode: 'local', why: st.why, load: ld, announce: announceOn, stopped: !!st.stop, hub: HUB_URL, url: st.url, route: st.route, linked: st.ok, err: st.err, ago: st.at ? Math.round((Date.now() - st.at) / 1000) : null });
      });
      return true;
    }
    return false;
  }

  const hooks = {};   // server.js가 채움: load() → 부하 상태, moveAll() → 학생 모두 Render로
  function setRoute(v, why) {
    if (st.route === v) return;
    st.route = v; st.why = why || '';
    console.log(`[hub] 학생 넘기기 ${v ? '켬' : '끔'}${why ? ' — ' + why : ''}`);
    if (announceOn && !st.stop) tick();
  }
  function start() {
    if (!announceOn) return;
    if (KEY.length < 12) { st.stop = true; st.err = 'HUB_KEY가 너무 짧아요(12자 이상)'; console.log('[hub] HUB_KEY는 12자 이상이어야 해요 → 안내소에 알리지 않아요 (교실 주소로 직접 접속은 돼요)'); return; }
    tick(); setInterval(tick, EVERY).unref();
    let quitting = false;
    const bye = () => {
      if (quitting) process.exit(0); quitting = true;
      console.log('\n  끄는 중… 안내소에 "교실 서버 꺼짐"을 알려요(최대 3초)');
      post(false, () => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
  }

  return {
    MODE, HUB_URL, announceOn, st, hooks, setRoute,
    http: MODE === 'hub' ? hubHttp : localHttp,
    start,
    detectIp,
  };
};
