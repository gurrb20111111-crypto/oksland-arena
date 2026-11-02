/* 이 기기에서 아레나가 몇 명까지 버티는지 재기 (2026-11-02)
 * 실행: node bench.js        (아이폰 iSH: sh start-ish.sh bench)
 *  - 수업용 서버는 먼저 꺼 주세요(Ctrl + C). 이 시험은 3999번 칸에 따로 서버를 켜요.
 *  - 가짜 학생(봇)을 5명 → 10명 → … 늘리며 20초씩 돌리고, 서버의 CPU·멈칫·몬스터 %를 적어요.
 *  - 봇도 같은 기기에서 돌아서 실제보다 조금 박하게(안전하게) 나와요.
 *  - 다 하는 데 약 2~3분. 끝나면 표 + "약 N명까지 여유" 한 줄이 나와요 → 화면을 찍어 두세요.
 * 다른 숫자로: BENCH_STEPS=10,20,30 BENCH_SECS=30 node bench.js
 * 외부 패키지 없음(Node 18 이상). 봇은 WebSocket을 직접 짜서 씀(iSH의 Node에는 내장 WebSocket이 없을 수 있음).
 */
'use strict';
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const PORT = +process.env.BENCH_PORT || 3999;
const STEPS = (process.env.BENCH_STEPS || '5,10,15,20,25,30,35').split(',').map(Number).filter(n => n > 0);
const SECS = +process.env.BENCH_SECS || 20, WARM = 6;

/* ---------- 서버 켜기 ---------- */
const env = Object.assign({}, process.env, { PORT: String(PORT), BENCH: '1', ADMIN_KEY: crypto.randomBytes(8).toString('hex'), ANNOUNCE: '0' });
delete env.HUB_KEY;
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let samples = [], buf = '';
srv.stdout.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.startsWith('[bench] ')) { try { samples.push(Object.assign({ at: Date.now() }, JSON.parse(line.slice(8)))); } catch (e) { /* */ } } }
});
srv.stderr.on('data', d => process.stderr.write(d));
srv.on('exit', c => { if (!done) { console.log('\n  시험 서버가 멈췄어요 (코드 ' + c + ')'); process.exit(1); } });

/* ---------- 가벼운 봇 (WebSocket 직접) ---------- */
function clearCode(name) {
  const ymd = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const s = name + '|' + ymd + '|oksland-arena'; let h = 2166136261;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return String(1000 + (h % 9000));
}
function frame(op, payload) {
  const len = payload.length, mask = crypto.randomBytes(4);
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, 0x80 | len]);
  else { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  const body = Buffer.from(payload); for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}
const bots = [];
function addBot(i) {
  const name = '봇' + i, sock = net.connect(PORT, '127.0.0.1');
  const b = { sock, ok: false, buf: Buffer.alloc(0), skip: 0, hs: false };
  const send = o => { if (b.ok && !sock.destroyed) sock.write(frame(1, Buffer.from(JSON.stringify(o)))); };
  sock.on('connect', () => sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  sock.on('data', d => {
    if (!b.hs) { const s = d.toString('latin1'), e = s.indexOf('\r\n\r\n'); if (e < 0) return; b.hs = b.ok = true; d = d.subarray(e + 4); send({ t: 'join', name, code: clearCode(name) }); }
    b.buf = b.buf.length ? Buffer.concat([b.buf, d]) : d;
    // 받은 화면 정보는 읽지 않고 건너뜀 — 연결 확인(ping)에만 답함
    for (;;) {
      if (b.skip) { const n = Math.min(b.skip, b.buf.length); b.skip -= n; b.buf = b.buf.subarray(n); if (b.skip) return; }
      if (b.buf.length < 2) return;
      const op = b.buf[0] & 15; let len = b.buf[1] & 127, off = 2;
      if (len === 126) { if (b.buf.length < 4) return; len = b.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.buf.length < 10) return; len = b.buf.readUInt32BE(6); off = 10; }
      b.buf = b.buf.subarray(off);
      if (op === 9) { if (b.buf.length < len) { b.skip = len; continue; } sock.write(frame(10, b.buf.subarray(0, len))); b.buf = b.buf.subarray(len); continue; }
      b.skip = len;
    }
  });
  sock.on('error', () => {});
  let a = Math.random() * 6.28;
  b.t1 = setInterval(() => { a += (Math.random() - .5) * 1.2; send({ t: 'in', mx: Math.cos(a), mz: Math.sin(a) }); }, 250);
  b.t2 = setInterval(() => send({ t: 'sk', id: 'punch' }), 500 + Math.random() * 300);
  bots.push(b);
}

/* ---------- 단계별로 재기 ---------- */
let done = false;
const wait = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, n) => String(s).padStart(n);
(async () => {
  console.log('\n  아레나 버티기 시험을 시작해요 (단계마다 ' + SECS + '초, 다 하면 약 ' + Math.ceil(STEPS.length * SECS / 60) + '분)\n');
  await wait(3000);
  const rows = [];
  for (const n of STEPS) {
    while (bots.length < n) addBot(bots.length);
    await wait(WARM * 1000); const from = Date.now();
    await wait((SECS - WARM) * 1000);
    const S = samples.filter(x => x.at >= from);
    if (!S.length) { console.log('  측정값이 없어요'); continue; }
    const avg = k => Math.round(S.reduce((a, x) => a + x[k], 0) / S.length);
    const lags = S.map(x => x.lag).sort((a, b) => a - b), lag90 = lags[Math.floor(lags.length * .9)];
    const r = { n, joined: S[S.length - 1].n, cpu: avg('cpu'), lag: lag90, scale: Math.min(...S.map(x => x.scale)), mons: avg('mons') };
    r.v = r.lag <= 100 && r.scale >= 100 ? '여유' : r.lag <= 250 && r.scale >= 60 ? '버팀' : '버거움';
    rows.push(r);
    console.log(`  학생 ${pad(n, 2)}명 (들어옴 ${pad(r.joined, 2)}) · CPU ${pad(r.cpu, 3)}% · 멈칫 ${pad(r.lag, 4)}ms · 몬스터 ${pad(r.scale, 3)}% (${r.mons}마리) → ${r.v}`);
    if (r.v === '버거움' && r.scale <= 40) break;
  }
  done = true;
  const ok = rows.filter(r => r.v === '여유').pop(), hold = rows.filter(r => r.v !== '버거움').pop();
  console.log('\n  ── 결과 ──');
  console.log(`  ${ok ? `약 ${ok.n}명까지 여유` : '5명부터 버거움'}${hold && hold !== ok ? `, 약 ${hold.n}명까지 버팀(몬스터를 줄여서)` : ''}`);
  console.log('  (봇도 이 기기에서 돌아서 실제 수업보다 조금 박하게 나와요. 이 화면을 찍어 두세요.)\n');
  for (const b of bots) { clearInterval(b.t1); clearInterval(b.t2); b.sock.destroy(); }
  srv.kill(); setTimeout(() => process.exit(0), 300);
})();
process.on('SIGINT', () => { done = true; srv.kill(); process.exit(0); });
