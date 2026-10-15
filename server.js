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
const R = 62;
const MON_CAP = +process.env.MON_CAP || 55, MON_PER = +process.env.MON_PER || 2.8;   // 몬스터 최대 수 · 학생 1명당 몬스터 (2026-10-15 렉 때문에 다시 절반으로)
const VIEW_R = 40;   // 학생 화면에는 40m 안 몬스터만 자세히 보냄(통신량·태블릿 부담 줄이기), 먼 몬스터는 미니맵 점만                          // island radius
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
  turtle: { hp: 230, spd: 1.1, dmg: 48, xp: 62, coins: [22, 32], r: 1.4, aggro: 10, lv: 6, beh: 'heavy' },  // 느리지만 한 방
  wolf: { hp: 70, spd: 10.2, dmg: 11, xp: 30, coins: [10, 15], r: .75, aggro: 22, lv: 3, beh: 'runner' }   // 아주 빠름: 2마리씩, 물고 빠지기
};
/* 몬스터 레벨: 근처 학생 레벨을 따라 올라감(체력·공격·속도·보상 증가). 25%는 원래 레벨 그대로(약한 몬스터) */
const MON_MAXLV = MAXLV + 3;
function monLevelUp(m, lv) { const d = MON[m.type], g = Math.max(0, lv - d.lv); m.lv = d.lv + g; m.hp = m.max = Math.round(d.hp * (1 + .22 * g)); m.dmg = Math.round(d.dmg * (1 + .12 * g)); m.spdMul = 1 + .02 * g; m.rw = 1 + .18 * g; }
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
const SHOPS = [{ n: '동', x: 33, z: 0 }, { n: '서', x: -33, z: 0 }, { n: '남', x: 0, z: 33 }, { n: '북', x: 0, z: -33 }];   // 바람상회 4곳
const SHOP_R = 5.5;                    // must stand this close to a shop to buy
const nearShop = p => SHOPS.some(s => Math.hypot(p.x - s.x, p.z - s.z) <= SHOP_R && (p.y || 0) < 1);
const SHRINE_R = 7;                    // 섬 가운데 바람의 신전 (전직)
const JOBS = {
  warrior: { n: '바람 검사', ic: '🗡', d: '체력 +30% · 받는 피해 −10% · 바람 펀치 +30% · 세게 밀쳐냄' },
  archer: { n: '돌풍 궁수', ic: '🏹', d: '바람 펀치가 멀리(9m) 날아가는 화살 · 이동 속도 +8%' },
  mage: { n: '번개 마법사', ic: '🔮', d: '스킬 피해 +35% · 스킬 대기 −15% · 체력 −10%' },
  healer: { n: '치유 정령사', ic: '💚', d: '재충전이 주변 친구도 회복 · 체력 회복 2배 · 바람 펀치 −10%' }
};
/* 직업 전용 스킬: 1번(질주)·3번(돌풍 대포)·6번(낙뢰) 자리를 바꿈. 상성: 검사 > 궁수 > 마법사 > 검사 (상대에게 피해 +20%) */
const JSK = {
  warrior: { dash: { n: '돌진 베기', ic: '⚔', cd: 7, d: '앞으로 7m 돌진, 처음 부딪힌 적에게 피해 + 0.8초 기절' }, cannon: { n: '대지 가르기', ic: '⛰', cd: 8, d: '앞쪽 7m 일직선 피해 + 2초 둔화' }, thunder: { n: '대지의 분노', ic: '💥', cd: 22, d: '앞으로 뛰어올라 내려찍기: 주변 큰 피해 + 1초 기절 (뛰는 동안 기절·둔화 안 걸림)' } },
  archer: { dash: { n: '구르기', ic: '🌀', cd: 5, d: '움직이는 쪽으로 5m 구르기, 구르는 동안 무적' }, cannon: { n: '관통 화살', ic: '➶', cd: 6, d: '18m 꿰뚫는 화살: 맞은 모두 피해 + 1.5초 둔화 (조준이 중요!)' }, thunder: { n: '화살비', ic: '☔', cd: 20, d: '앞쪽 지점에 0.9초 뒤 화살비 3번: 피해 + 둔화 (빨간 원을 보고 피할 수 있음)' } },
  mage: { dash: { n: '점멸', ic: '✦', cd: 9, d: '보는 쪽으로 6.5m 순간이동' }, cannon: { n: '바람 속박', ic: '⛓', cd: 8, d: '14m 구슬: 처음 맞은 적 피해 + 1.5초 묶기(못 움직임)' }, thunder: { n: '번개 폭풍', ic: '⚡', cd: 22, d: '0.6초 뒤 내 주변 6.5m 큰 피해 + 0.6초 기절' } },
  healer: { dash: { n: '치유의 바람', ic: '✚', cd: 9, d: '나와 주변 7m 친구 체력 25% 회복 + 기절·묶기·둔화 풀기' }, cannon: { n: '생명 흡수 구슬', ic: '◉', cd: 7, d: '15m 구슬: 피해 + 둔화, 준 피해의 60%만큼 내 체력 회복' }, thunder: { n: '수호의 바람', ic: '🛡', cd: 24, d: '나와 주변 8m 친구에게 4초 보호막(받는 피해 −60%) + 기절·둔화 면역' } }
};
const COUNTER = { warrior: 'archer', archer: 'mage', mage: 'warrior' };   // 앞이 뒤에게 강함
for (const k in JOBS) { JOBS[k].sk = JSK[k]; JOBS[k].beats = COUNTER[k] || null; JOBS[k].weak = Object.keys(COUNTER).find(x => COUNTER[x] === k) || null; }
const JOBK = [null, 'warrior', 'archer', 'mage', 'healer'];
const JOB_LV = 5, JOB_CHANGE = 100;
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


/* ======================= 돌풍 발전기 (풍력 문제를 맞히면 원하는 방향으로 세찬 바람 + 바람 화살) ======================= */
const GUST = { r: 3.6, quiz: 15000, pick: 8000, life: 12000, len: 26, w: 9, push: 4.4, cdP: 60000, arrowEvery: .65, arrowSpd: 20, wrongHp: .2 };
const GQ = [   // [문제, 정답, 오답, 오답, 오답] — 옥정섬 SOS 퀘스트·지식 카드 내용
  ['바람이 생기는 가장 근본적인 까닭은?', '태양이 땅과 바다를 고르게 데우지 못해서', '지구가 커다란 자석이라서', '달이 바닷물을 당겨서', '구름이 움직이면서 공기를 끌고 가서'],
  ['낮에 바닷가에서 부는 바람은?', '해풍 (바다 → 육지)', '육풍 (육지 → 바다)', '바람이 전혀 안 분다', '하늘에서 땅으로 분다'],
  ['밤에 바닷가에서 부는 바람은?', '육풍 (육지 → 바다)', '해풍 (바다 → 육지)', '바람이 전혀 안 분다', '땅에서 하늘로 분다'],
  ['육지와 바다 중 빨리 데워지고 빨리 식는 쪽은?', '육지', '바다', '둘이 똑같다', '날마다 다르다'],
  ['낮에 햇볕을 받은 육지 위 공기는 어떻게 될까?', '데워져서 위로 올라간다', '차가워져서 가라앉는다', '그 자리에 멈춘다', '바다 밑으로 들어간다'],
  ['"태양이 없다면 바람은?"에 대한 답으로 알맞은 것은?', '거의 생기지 않는다', '지금보다 세게 분다', '지금과 똑같이 분다', '육풍만 분다'],
  ['풍력발전기의 에너지 전환으로 알맞은 것은?', '바람의 운동 에너지 → 회전 운동 에너지 → 전기 에너지', '전기 에너지 → 회전 운동 에너지 → 바람', '열에너지 → 빛에너지 → 전기 에너지', '위치 에너지 → 소리 에너지 → 전기 에너지'],
  ['선풍기의 에너지 전환은?', '전기 → 회전 → 바람', '바람 → 회전 → 전기', '빛 → 열 → 바람', '바람 → 열 → 빛'],
  ['나셀 속에서 힘이 전달되는 순서는?', '날개 → 회전축 → 기어 → 발전기 → 전선', '발전기 → 날개 → 기어 → 전선 → 회전축', '전선 → 기어 → 날개 → 회전축 → 발전기', '기어 → 전선 → 날개 → 발전기 → 회전축'],
  ['나셀 속 기어가 하는 일은?', '느린 회전을 빠르게 바꿔 발전기에 전해 준다', '전기를 저장한다', '바람 방향을 잰다', '날개를 멈추게만 한다'],
  ['나셀(발전기 머리)은 어느 쪽을 향해야 할까?', '바람이 불어오는 쪽', '바람이 불어 가는 쪽', '언제나 북쪽', '아무 쪽이나 상관없다'],
  ['나셀을 바람이 불어오는 쪽으로 돌리는 것을 무엇이라고 할까?', '요(yaw) 제어', '컷아웃', '양력', '설비이용률'],
  ['기어 없이 날개가 발전기를 바로 돌리는 방식은?', '직결식', '수직축식', '부유식', '항력식'],
  ['평평한 판이나 컵처럼 바람이 "미는 힘"은?', '항력', '양력', '중력', '자기력'],
  ['큰 풍력발전기 날개를 빠르게 돌리는 주된 힘은?', '양력', '항력', '중력', '마찰력'],
  ['비행기 날개 모양에서 양력이 생기는 까닭은?', '날개 위아래의 압력 차이', '날개가 무거워서', '바람이 날개 뒤를 밀어서', '날개 색이 진해서'],
  ['큰 풍력발전기 날개의 단면 모양은?', '비행기 날개 모양', '평평한 판', '컵 모양', '동그란 공 모양'],
  ['날개가 2장인 발전기의 약점은?', '균형이 덜 맞아 흔들림과 소음이 크다', '너무 무거워 돌지 않는다', '바람을 전혀 못 받는다', '전기가 반대로 흐른다'],
  ['날개가 12장인 풍차에 알맞은 쓰임은?', '느리지만 힘이 세서 물을 퍼 올리는 풍차', '가장 빠르게 도는 대형 발전기', '해상풍력 발전', '비행기 프로펠러'],
  ['큰 발전용 풍력발전기의 날개는 대부분 몇 장일까?', '3장', '2장', '12장', '1장'],
  ['풍속이 2배가 되면 바람의 동력은 몇 배?', '8배', '2배', '4배', '16배'],
  ['풍속이 3배가 되면 바람의 동력은 몇 배?', '27배', '9배', '3배', '6배'],
  ['날개 길이가 2배가 되면 바람 받는 면적은 몇 배?', '4배', '2배', '8배', '그대로'],
  ['날개 길이가 2배가 되면 발전량은 대략 몇 배?', '4배', '8배', '2배', '16배'],
  ['P = ½ρAv³ 에서 세제곱(³)이 붙은 v는 무엇일까?', '풍속', '날개 무게', '공기 온도', '날개 수'],
  ['바람이 너무 셀 때 발전기를 일부러 멈추는 것을 무엇이라고 할까?', '컷아웃', '컷인', '요 제어', '양력'],
  ['발전을 시작하는 풍속(컷인)에 가장 가까운 것은?', '약 3 m/s', '약 30 m/s', '0 m/s', '약 100 m/s'],
  ['풍속이 25 m/s를 넘는 태풍이 오면 발전기는?', '멈춘다 (날개와 설비 보호)', '최대로 발전한다', '날개를 더 빨리 돌린다', '나셀을 바람 반대로 돌려 계속 발전한다'],
  ['정격 출력을 넘는 센 바람에서 출력을 일정하게 지키는 방법은?', '날개 각도를 조절한다', '날개를 하나 뗀다', '기어를 뺀다', '전선을 끊는다'],
  ['발전기가 멈춘 동안 보건소 같은 곳에 전기를 보내 주는 것은?', '배터리 (ESS)', '선풍기', '풍향계', '나셀'],
  ['풍력발전기 자리를 고를 때 따지지 않아도 되는 것은?', '학교 급식 메뉴', '주민 소음·그림자', '철새가 다니는 길', '송전선과 길'],
  ['학교 옥상이 대형 풍력발전기 자리로 알맞지 않은 까닭은?', '건물에 막혀 바람이 약하고 들쭉날쭉해서', '햇빛이 너무 강해서', '옥상이 너무 넓어서', '바람이 언제나 일정해서'],
  ['수직축 풍력발전기의 장점은?', '바람 방향과 상관없이 돈다', '효율이 가장 높다', '날개가 필요 없다', '바람이 없어도 돈다'],
  ['깊은 바다에 세우는 해상풍력은 어떻게 고정할까?', '물에 띄우고 줄로 고정한다 (부유식)', '바닥까지 기둥을 박는다', '배 위에 올려 둔다', '하늘에 매단다'],
  ['해상풍력으로 만든 전기는 어떻게 육지로 올까?', '해저 케이블', '무선 전파', '배에 실어서', '비행기로 날라서'],
  ['바다에 세운 풍력발전기가 특히 조심해야 하는 것은?', '소금기에 의한 부식', '모래 폭풍', '눈사태', '산불'],
  ['디젤 발전기와 비교한 풍력발전의 장점은?', '돌아가는 동안 연료를 태우지 않아 이산화탄소·매연이 없다', '바람이 없을 때 가장 많이 발전한다', '소음과 그림자가 전혀 없다', '밤에만 발전한다'],
  ['"설비이용률"의 뜻으로 알맞은 것은?', '최대로 돌았을 때와 비교한 실제 전기량의 비율', '발전기가 돌 수 있었던 시간', '날개 수의 비율', '바람이 불어오는 방향'],
  ['"가동률"의 뜻으로 알맞은 것은?', '발전기가 돌 수 있었던 시간의 비율', '최대 출력과 비교한 실제 전기량', '날개 길이의 비율', '배터리 남은 양'],
  ['풍력발전기의 소음은 거리와 어떤 관계일까?', '멀어질수록 빠르게 줄어든다', '가까울수록 작아진다', '거리와 상관없다', '밤에만 생긴다'],
  ['풍력발전기의 "그림자 깜빡임"이 잘 생기는 때는?', '해가 낮게 떠 있을 때', '한낮 해가 머리 위에 있을 때', '비 오는 날', '바람이 없는 날']
];

/* ======================= climbable structures (height) ======================= */
// 사각 발판(plat)은 바닥부터 h까지 꽉 찬 덩어리, 계단(stairs)·사다리(ladder)는 h0→h1로 올라가는 경사(dir 쪽으로 높아짐)
const STRUCTS = [
  { kind: 'tower', name: '전망대', plat: [17, 23, -23, -17, 5], ramps: [[19, 21, -17, -9, 0, 5, '-z', 'stairs'], [23, 24.3, -20.6, -19.4, 0, 5, '-x', 'ladder']] },
  { kind: 'deck', name: '정비 데크', plat: [-26, -17, 15, 21, 3.2], ramps: [[-17, -11, 16, 18, 0, 3.2, '-x', 'stairs'], [-27.3, -26, 17.4, 18.6, 0, 3.2, '+x', 'ladder']] },
  { kind: 'plateau', name: '바위 고원', plat: [-6, 6, 46, 54, 2.6], ramps: [[-1.5, 1.5, 39, 46, 0, 2.6, '+z', 'stairs'], [6, 7.3, 49.4, 50.6, 0, 2.6, '-x', 'ladder']] },
  { kind: 'watch', name: '감시탑', plat: [-33, -29, -33, -29, 6.5], ramps: [[-29, -27.7, -31.6, -30.4, 0, 6.5, '-x', 'ladder']] },
  { kind: 'crate', name: '컨테이너', plat: [-2, 2, -25, -19, 2.6], ramps: [[-6, -2, -23, -21, 0, 2.6, '+x', 'stairs']] },
  { kind: 'crate2', name: '높은 컨테이너', plat: [2, 6, -25, -19, 5.2], ramps: [[1.2, 2, -22.6, -21.4, 2.6, 5.2, '+x', 'ladder']] }
];
const SURF = [];
for (const st of STRUCTS) { const [x0, x1, z0, z1, h] = st.plat; SURF.push({ x0, x1, z0, z1, h0: h, h1: h, step: .7 }); for (const [a0, a1, b0, b1, h0, h1, dir, k] of st.ramps) SURF.push({ x0: a0, x1: a1, z0: b0, z1: b1, h0, h1, dir, step: k === 'ladder' ? 2.6 : .7, ladder: k === 'ladder' }); }
function surfH(s, x, z) { if (!s.dir) return s.h1; const t = Math.max(0, Math.min(1, s.dir === '+x' ? (x - s.x0) / (s.x1 - s.x0) : s.dir === '-x' ? (s.x1 - x) / (s.x1 - s.x0) : s.dir === '+z' ? (z - s.z0) / (s.z1 - s.z0) : (s.z1 - z) / (s.z1 - s.z0))); return s.h0 + (s.h1 - s.h0) * t; }
function floorAt(x, z, y, extra = 0) { let f = 0; for (const s of SURF) if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) { const h = surfH(s, x, z); if (h <= y + Math.max(s.step, extra) && h > f) f = h; } return f; }
function blockedAt(x, z, y, rad, extra = 0) { for (const s of SURF) if (x >= s.x0 - rad && x <= s.x1 + rad && z >= s.z0 - rad && z <= s.z1 + rad) { const h = surfH(s, Math.max(s.x0, Math.min(s.x1, x)), Math.max(s.z0, Math.min(s.z1, z))); if (h > y + Math.max(s.step, extra)) return true; } return false; }
const inLadder = (x, z) => SURF.some(s => s.ladder && x >= s.x0 - .45 && x <= s.x1 + .45 && z >= s.z0 - .05 && z <= s.z1 + .05);
const onStruct = (x, z, pad = 0) => SURF.some(s => x >= s.x0 - pad && x <= s.x1 + pad && z >= s.z0 - pad && z <= s.z1 + pad);
function moveY(e, nx, nz, rad, dt) {   // walls, floors, falling
  const y = e.y || 0; let tx = nx, tz = nz; const lad = inLadder(e.x, e.z), ex = lad ? 3 : 0, r2 = lad ? .05 : rad;
  if (blockedAt(tx, tz, y, r2, ex)) { if (!blockedAt(nx, e.z, y, r2, ex)) tz = e.z; else if (!blockedAt(e.x, nz, y, r2, ex)) tx = e.x; else { tx = e.x; tz = e.z; } }
  e.x = tx; e.z = tz;
  const f = floorAt(e.x, e.z, y, ex);
  if (f >= y - .02) { e.y = f; e.vy = 0; } else { e.vy = (e.vy || 0) - 28 * dt; e.y = Math.max(f, y + e.vy * dt); if (e.y <= f) { e.y = f; e.vy = 0; } }
}
const FLYERS = new Set(['bee', 'bat']);
const dyOk = (a, b, lim = 1.8) => Math.abs((a.y || 0) - (b.y || 0)) <= lim;

/* ======================= map ======================= */
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const OBS_ALL = [];
(function buildMap() {
  const r = rng(20261012); const OBS = OBS_ALL;
  OBS.push([0, 0, 3.4, 'shrine']);
  for (const sp of SHOPS) OBS.push([sp.x, sp.z, 2.2, 'shop']);
  for (const t of STATIONS) OBS.push([t.x, t.z, .9, 'station']);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + .3; OBS.push([Math.cos(a) * 38, Math.sin(a) * 38, 1.1, 'turbine']); }
  let tries = 0;
  while (OBS.length < 70 && tries++ < 4000) {
    const a = r() * Math.PI * 2, d = 9 + Math.sqrt(r()) * (R - 14), x = Math.cos(a) * d, z = Math.sin(a) * d;
    const kind = r() < .55 ? 'tree' : 'rock', rad = kind === 'tree' ? .7 + r() * .3 : .9 + r() * 1.4;
    if (OBS.some(o => Math.hypot(o[0] - x, o[1] - z) < o[2] + rad + 3)) continue;
    if (STATIONS.some(t => Math.hypot(t.x - x, t.z - z) < rad + 4.5)) continue;
    if (onStruct(x, z, rad + 2.5)) continue;
    OBS.push([+x.toFixed(2), +z.toFixed(2), +rad.toFixed(2), kind]);
  }
})();
const OBS_BATTLE = OBS_ALL.filter(o => o[3] !== 'station');
const GTS = OBS_ALL.filter(o => o[3] === 'turbine').map((o, i) => ({ id: i, x: o[0], z: o[1] }));   // 섬의 풍력발전기 6기 = 돌풍 발전기
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
const blessed = p => teamsOn && !!teamSt[p.team] && teamSt[p.team].buffUntil > Date.now();
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
    if (onStruct(x, z, 1.5)) continue;
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
let gate = true, locked = false;
const IDLE_MS = 5 * 60 * 1000;   // 5분 동안 아무 조작이 없으면 자동으로 내보냄 (수업 끝나고 창을 안 닫은 학생)
function zoneR() {
  if (round.phase !== 'play') return R;
  const total = round.len, left = (round.endsAt - Date.now()) / 1000, shrink = Math.min(150, total * .4);
  if (left > shrink) return R;
  const k = 1 - Math.max(0, left) / shrink;
  return R - (R - 14) * k;
}

const online = p => !!(p.c && p.c.open);
const stat = p => ({
  maxHp: Math.round((100 + (p.lv - 1) * 15 + p.arm * 22) * (p.job === 'warrior' ? 1.3 : p.job === 'mage' ? .9 : 1)),
  atk: Math.round((10 + (p.lv - 1) * 4 + p.wpn * 5) * (blessed(p) ? 1.3 : 1)),
  def: 1 - (1 - p.arm * .06) * (blessed(p) ? .8 : 1) * (p.job === 'warrior' ? .9 : 1),
  cdr: 1 - (1 - (p.helm || 0) * .08) * (p.job === 'mage' ? .85 : 1),
  skillMul: p.job === 'mage' ? 1.35 : 1,
  spd: 7.6 * (1 + (Math.min(p.lv, MAXLV) - 1) * .04) * (p.gm ? 1.15 : 1) * (p.job === 'archer' ? 1.08 : 1) * (1 + (p.boot || 0) * .07) * (p.dashT > 0 ? 1.8 : 1) * (blessed(p) ? 1.1 : 1)
});
function newPlayer(c, name) {
  const [x, z] = freeSpot(10);
  const p = { id: nextId++, c, name, x, z, y: 0, vy: 0, dir: 0, mx: 0, mz: 0, lv: 1, xp: 0, coins: 0, wpn: 0, arm: 0, boot: 0, helm: 0, pot: 1, potAt: 0, team: pickTeam(), tcd: {}, task: null, tasks: 0, parts: 0, hp: 100, kills: 0, deaths: 0, streak: 0, best: 0,
    alive: true, respawnAt: 0, prot: Date.now() + 3000, cds: {}, dashT: 0, shieldT: 0, lastHurt: 0, dmgBy: new Map(), joined: Date.now(), lastIn: Date.now() };
  p.hp = stat(p).maxHp;
  return p;
}
/* 운영자(선생님): 관리자 비밀번호로 입장 → Lv 100, 최고 장비, 순위·보스 인원 계산에서 빠짐 */
const GM_LV = 100;
function bye(p, s) {   // 내보내기: 학생 화면은 다시 연결하지 않고 입장 화면으로 돌아감
  if (chest && chest.opener === p.id) chest.opener = null;
  if (p.task) cancelTask(p);
  const c = p.c; p.c = null; players.delete(p.id); broadcast({ t: 'ro', gone: p.id, name: p.name });
  if (c) { c.pid = null; c.send({ t: 'bye', s }); setTimeout(() => { try { c.close(); } catch (e) { /* already closed */ } }, 300); }
}
function applyGM(p) { p.gm = true; p.lv = GM_LV; p.xp = 0; p.team = -1; p.wpn = 4; p.arm = 4; p.boot = 3; p.helm = 3; p.pot = 3; p.coins = 9999; p.parts = 99; p.hp = stat(p).maxHp; }
const live = () => [...players.values()].filter(p => online(p) && !p.gm);
function resetPlayer(p) {
  p.lv = 1; p.xp = 0; p.shopUntil = 0; p.shopCdUntil = 0; p.catchUp = 0; p.gustCd = 0; p.gq = null; p.coins = 0; p.wpn = 0; p.arm = 0; p.boot = 0; p.helm = 0; p.pot = 1; p.potAt = 0; p.tcd = {}; p.task = null; p.tasks = 0; p.parts = 0; p.kills = 0; p.deaths = 0; p.streak = 0; p.best = 0; p.cds = {}; p.dashT = 0; p.shieldT = 0;
  const [x, z] = freeSpot(10); p.x = x; p.z = z; p.y = 0; p.vy = 0; p.alive = true; p.prot = Date.now() + 3000; p.hp = stat(p).maxHp; p.dmgBy.clear();
  if (p.gm) applyGM(p);
}

/* ======================= teams & tasks ======================= */
function teamCount(ti) { let n = 0; for (const p of players.values()) if (online(p) && !p.gm && p.team === ti) n++; return n; }
function pickTeam() { let best = 0, bn = 1e9; const order = [0, 1, 2, 3].sort(() => Math.random() - .5); for (const i of order) { const n = teamCount(i); if (n < bn) { bn = n; best = i; } } return best; }
const teamGoal = ti => 4 + 3 * Math.max(1, teamCount(ti));
const sameTeam = (a, b) => a && b && a !== b && (COOP || (teamsOn && a.team === b.team));
function shuffleTeams() {
  const list = live().sort(() => Math.random() - .5);
  list.forEach((p, i) => { p.team = i % 4; });
  for (const t of teamSt) Object.assign(t, { pts: 0, lvups: 0, tasks: 0, kills: 0, buffUntil: 0 });
}
const shuf = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function startTask(p) {
  if (p.shopUntil || p.gq != null) return tell(p, '상점이나 돌풍 발전기 문제를 푸는 중에는 할 수 없어요.');
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
/* ======================= 보물 상자 이벤트 ======================= */
const CHEST = { every: 150, fall: 6, life: 60, open: 3, r: 2.4 };

/* ---- 돌풍 발전기 ---- */
const gst = GTS.map(t => ({ ...t, solver: 0, qAns: -1, qUntil: 0, pickUntil: 0, active: null, lastQ: -1 }));
const DIRK = ['남', '남동', '동', '북동', '북', '북서', '서', '남서'];
const dirName = a => DIRK[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
function gustStart(p) {
  const now = Date.now();
  if (!p.alive || p.shopUntil || p.gq != null) return;
  const t = gst.find(g => Math.hypot(g.x - p.x, g.z - p.z) <= GUST.r && (p.y || 0) < 1); if (!t) return tell(p, '돌풍 발전기(섬의 풍력발전기) 가까이 가야 해요.');
  if (t.active) return tell(p, `이 발전기는 지금 돌고 있어요. ${Math.ceil((t.active.until - now) / 1000)}초 뒤에 다시 쓸 수 있어요.`);
  const sv = t.solver && players.get(t.solver); if (sv && sv.alive && online(sv)) return tell(p, `<b>${sv.name}</b>이(가) 이 발전기 문제를 풀고 있어요. 다른 발전기를 찾아보세요!`);
  if (now < (p.gustCd || 0)) return tell(p, `돌풍 발전기는 <b>${Math.ceil((p.gustCd - now) / 1000)}초</b> 뒤에 다시 돌릴 수 있어요. (친구들과 돌아가며!)`);
  if (p.task) cancelTask(p); if (chest && chest.opener === p.id) chest.opener = null;
  let qi; do { qi = Math.floor(Math.random() * GQ.length); } while (GQ.length > 1 && (qi === t.lastQ || qi === p.lastGq));
  t.lastQ = p.lastGq = qi; const it = GQ[qi], opts = shuf(it.slice(1));
  t.solver = p.id; t.qAns = opts.indexOf(it[1]); t.qUntil = now + GUST.quiz; t.pickUntil = 0; t.qText = it[1];
  p.gq = t.id; p.prot = t.qUntil; p.mx = p.mz = 0;
  if (p.c) p.c.send({ t: 'gq', s: 'q', tid: t.id, q: it[0], o: opts, secs: GUST.quiz / 1000, dbgA: process.env.ARENA_TEST ? t.qAns : undefined });
}
function gustRelease(t, p, cd) { t.solver = 0; t.qUntil = t.pickUntil = 0; if (p) { p.gq = null; p.prot = Date.now() + 800; if (cd) p.gustCd = Date.now() + cd; } }
function gustAnswer(p, a) {
  const t = p.gq != null && gst[p.gq]; if (!t || t.solver !== p.id || !t.qUntil) return;
  const now = Date.now();
  if (+a === t.qAns) {
    const xp = Math.round(xpNeed(p.lv) * .35); gainXpB(p, xp); addCoins(p, 10);
    t.qUntil = 0; t.pickUntil = now + GUST.pick; p.prot = t.pickUntil;
    if (p.c) p.c.send({ t: 'gq', s: 'ok', xp: Math.round(xp * xpBoost(p)), secs: GUST.pick / 1000, def: +p.dir.toFixed(2) });
    ev({ k: 'fx', s: 'gqok', id: p.id, x: +p.x.toFixed(1), z: +p.z.toFixed(1) });
  } else gustWrong(t, p, +a >= 0 ? 'wrong' : 'time');
}
function gustWrong(t, p, why) {
  const st = stat(p), d = Math.round(st.maxHp * GUST.wrongHp); p.hp = Math.max(1, p.hp - d);   // 틀리면 체력 20% (이걸로 쓰러지진 않음)
  if (p.c) p.c.send({ t: 'gq', s: 'no', why, right: t.qText, dmg: d, cd: GUST.cdP / 1000 });
  ev({ k: 'hit', t: 'p', id: p.id, d, x: +p.x.toFixed(1), z: +p.z.toFixed(1), kx: 0, kz: 0, big: 0 });
  gustRelease(t, p, GUST.cdP);
}
function gustFire(t, p, ang) {
  const now = Date.now(); if (!(isFinite(ang))) ang = p.dir || 0;
  t.active = { dir: ang, ux: Math.sin(ang), uz: Math.cos(ang), until: now + GUST.life, owner: p.id, team: p.team, nextArrow: now + 300, name: p.name };
  gustRelease(t, p, GUST.cdP);
  if (p.c) p.c.send({ t: 'gq', s: 'fire', cd: GUST.cdP / 1000 });
  broadcast({ t: 'msg', s: `🌪 <b>${p.name}</b>이(가) 돌풍 발전기를 돌렸어요! <b>${dirName(ang)}쪽</b>으로 세찬 바람과 바람 화살이 날아가요!` });
  ev({ k: 'fx', s: 'gust', x: t.x, z: t.z });
}
function gustAffects(g, e, isP) {   // 이 돌풍이 e를 미는지 (주인·같은 팀·2부 친구·보호 중·건물 위는 제외)
  if (isP) { if (COOP || e.gm || e.id === g.owner || Date.now() < e.prot || e.shopUntil || e.gq != null) return false; const o = players.get(g.owner); if (o && sameTeam(o, e)) return false; }
  if ((e.y || 0) > 1) return false;
  return true;
}
function gustPush(e, isP) {
  let gx = 0, gz = 0;
  for (const t of gst) { const g = t.active; if (!g) continue;
    const rx = e.x - t.x, rz = e.z - t.z, al = rx * g.ux + rz * g.uz, pe = Math.abs(-rx * g.uz + rz * g.ux);
    if (al < .5 || al > GUST.len || pe > GUST.w / 2 || !gustAffects(g, e, isP)) continue;
    const k = GUST.push * (1 - .45 * al / GUST.len); gx += g.ux * k; gz += g.uz * k; }
  return [gx, gz];
}
function tickGusts(now) {
  for (const t of gst) {
    if (t.solver) { const p = players.get(t.solver);
      if (!p || !p.alive || !online(p) || Math.hypot(t.x - p.x, t.z - p.z) > GUST.r + 1.5) { if (p && p.c) p.c.send({ t: 'gq', s: 'cancel' }); gustRelease(t, p, 15000); }
      else if (t.qUntil && now > t.qUntil) gustWrong(t, p, 'time');
      else if (t.pickUntil && now > t.pickUntil) gustFire(t, p, p.dir);
    }
    const g = t.active; if (!g) continue;
    if (now > g.until) { t.active = null; continue; }
    if (now >= g.nextArrow) { g.nextArrow = now + GUST.arrowEvery * 1000; const o = players.get(g.owner);
      if (o) { const off = (Math.random() - .5) * GUST.w * .75; projs.push({ id: nextId++, kind: 'warrow', by: o.id, x: t.x + g.ux * 1.6 - g.uz * off, z: t.z + g.uz * 1.6 + g.ux * off, y: 0, dx: g.ux, dz: g.uz, spd: GUST.arrowSpd, life: (GUST.len - 1.6) / GUST.arrowSpd, dmg: Math.round(12 + o.lv * 1.5), r: 1, kb: 1.2 }); } }
  }
}
let chest = null, chestT = 45;
function dropChest(why) {
  if (chest) return;
  let x = 0, z = 20, y = 0;
  if (Math.random() < .35) { const st = STRUCTS[Math.floor(Math.random() * STRUCTS.length)], [x0, x1, z0, z1, h] = st.plat; x = (x0 + x1) / 2; z = (z0 + z1) / 2; y = h; }
  else for (let i = 0; i < 40; i++) { const a = Math.random() * 6.28, d = 10 + Math.random() * (zoneR() * .8 - 10); x = Math.cos(a) * d; z = Math.sin(a) * d; if (OBS.some(o => Math.hypot(o[0] - x, o[1] - z) < o[2] + 2) || onStruct(x, z, 1.5) || SHOPS.some(q => Math.hypot(q.x - x, q.z - z) < 8)) continue; break; }
  const now = Date.now();
  chest = { id: nextId++, x: +x.toFixed(2), z: +z.toFixed(2), y, landAt: now + CHEST.fall * 1000, expireAt: now + (CHEST.fall + CHEST.life) * 1000, opener: null, openAt: 0 };
  broadcast({ t: 'chest', s: 'drop', x: chest.x, z: chest.z, y, high: y > 0, why });
}
function startOpen(p) {
  if (p.shopUntil || p.gq != null) return tell(p, '상점이나 돌풍 발전기 문제를 푸는 중에는 할 수 없어요.');
  const now = Date.now();
  if (!chest || now < chest.landAt || !p.alive) return;
  if (Math.hypot(p.x - chest.x, p.z - chest.z) > CHEST.r || Math.abs((p.y || 0) - chest.y) > 1.2) return tell(p, '보물 상자 가까이 가야 열 수 있어요.');
  if (chest.opener && chest.opener !== p.id && players.get(chest.opener) && players.get(chest.opener).alive) return tell(p, '다른 사람이 상자를 열고 있어요! 공격해서 막아 보세요.');
  chest.opener = p.id; chest.openAt = now; p.lastHurtAtOpen = p.lastHurt;
  ev({ k: 'fx', s: 'chestopen', id: p.id, x: chest.x, z: chest.z });
}
function tickChest(dt, now) {
  chestT -= dt;
  if (!chest && chestT <= 0) { chestT = CHEST.every; if (live().length) dropChest('auto'); }
  if (!chest) return;
  if (now > chest.expireAt) { broadcast({ t: 'chest', s: 'gone' }); chest = null; return; }
  if (chest.opener) {
    const p = players.get(chest.opener);
    const ok = p && p.alive && online(p) && Math.hypot(p.x - chest.x, p.z - chest.z) <= CHEST.r + .4 && p.lastHurt === p.lastHurtAtOpen;
    if (!ok) { if (p && p.c) p.c.send({ t: 'msg', s: '상자 열기가 끊겼어요! 다시 시도하세요.' }); chest.opener = null; return; }
    if (now - chest.openAt >= CHEST.open * 1000) {
      const coins = 90 + Math.floor(Math.random() * 61); addCoins(p, coins);
      const slots = ['wpn', 'arm', 'boot', 'helm'].filter(k => (p[k] || 0) < (k === 'wpn' || k === 'arm' ? 4 : 3)); let gear = null;
      if (slots.length) { const k = slots[Math.floor(Math.random() * slots.length)]; p[k] = (p[k] || 0) + 1; gear = SLOTN[k][p[k]]; if (k === 'arm') p.hp += 22; }
      p.pot = Math.min(POT.max, (p.pot || 0) + 1); if (COOP) p.parts = (p.parts || 0) + 3;
      p.hp = stat(p).maxHp;
      broadcast({ t: 'chest', s: 'open', by: p.name, id: p.id, coins, gear, x: chest.x, z: chest.z });
      ev({ k: 'fx', s: 'bossdie', x: chest.x, z: chest.z });
      chest = null;
    }
  }
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
  const xp = Math.round(xpNeed(p.lv) * .4); gainXpB(p, xp); addCoins(p, 12);
  { const st = stat(p); p.hp = Math.min(st.maxHp, p.hp + st.maxHp * .25); }
  let tl = null;
  if (teamsOn) {
    const ts = teamSt[p.team] || { pts: 0, tasks: 0 }; ts.pts++; ts.tasks++;
    if (teamSt[p.team] && ts.pts >= teamGoal(p.team)) { ts.pts = 0; ts.lvups++; tl = p.team; ts.buffUntil = now + BLESS_MS;
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
  return live().sort((a, b) => b.lv - a.lv || b.xp - a.xp || b.coins - a.coins || b.kills - a.kills);
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
function dropPick(kind, val, x, z, y = 0) {
  const id = nextId++;
  const a = Math.random() * Math.PI * 2, d = Math.random() * 1.6;
  let px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;[px, pz] = collide(px, pz, .3);
  const py = floorAt(px, pz, y + .3);
  picks.set(id, { id, kind, val, x: px, z: pz, y: py, ttl: kind === 'coin' ? 40 : 60 });
}

/* ======================= damage & death ======================= */
function hurtPlayer(v, dmg, src) {
  if (!v.alive || Date.now() < v.prot || v.shopUntil) return;
  if (src && src.kind === 'p' && src.p && !src.p.gm && !v.gm) { const g = src.p.lv - v.lv; if (g > 0) dmg *= Math.max(.6, 1 - .05 * g); else if (g < 0) dmg *= Math.min(1.5, 1 - .05 * g); if (src.p.job && COUNTER[src.p.job] === v.job) { dmg *= 1.2; src.ct = 1; } }   // 레벨 차이 보정 + 직업 상성
  const st = stat(v);
  let d = dmg * (1 - st.def) * (v.shieldT > 0 ? .4 : 1);
  d = Math.max(1, Math.round(d));
  v.hp -= d; v.lastHurt = Date.now();
  let kb = [0, 0];
  if (src && (src.kind === 'm' || src.kind === 'p') && v.hp > 0) { const sx = src.kind === 'm' ? (src.m && src.m.x != null ? src.m.x : null) : src.fx, sz = src.kind === 'm' ? (src.m && src.m.z != null ? src.m.z : null) : src.fz;
    const amt = src.kind === 'p' ? .7 * (src.kb || 1) : src.m && src.m.type === 'boss' ? 1.8 : (MON_HIT_KB[src.m && src.m.type] || .8); if (sx != null && !(Date.now() < (v.ccImmuneUntil || 0) && Date.now() >= (v.stunUntil || 0) && Date.now() >= (v.rootUntil || 0))) kb = knock(v, sx, sz, amt * (v.job === 'warrior' ? .6 : 1), .45); }
  if (v.task) cancelTask(v, '공격을 받아서 과제가 취소됐어요! 주변을 살피고 다시 하세요.');
  if (src && src.kind === 'p') { v.dmgBy.set(src.p.id, Date.now()); src.p.lastHurt = Date.now(); }
  ev({ k: 'hit', t: 'p', id: v.id, d, x: +v.x.toFixed(1), z: +v.z.toFixed(1), kx: kb[0], kz: kb[1], big: d >= 30 ? 1 : 0, ct: src && src.ct ? 1 : 0 });
  if (v.splash) { v.splash = false; if (v.hp > 0) return seaFall(v, src); }
  if (v.hp <= 0) killPlayer(v, src);
}
function killPlayer(v, src) {
  const kp = src && src.kind === 'p' && src.p && src.p.id !== v.id ? src.p : null, gap = kp ? kp.lv - v.lv : 0, soft = !!kp && !v.gm && !kp.gm && gap >= 5;   // 5레벨 이상 높은 사람에게 쓰러지면 손해를 줄여 줌
  v.shopUntil = 0; v.rush = null; v.stunUntil = v.rootUntil = v.slowUntil = 0; if (v.gq != null) { const gt = gst[v.gq]; if (gt && gt.solver === v.id) gustRelease(gt, v, 15000); v.gq = null; }
  if (v.task) cancelTask(v); v.hp = 0; v.alive = false; v.respawnAt = Date.now() + 5000; v.deaths++;
  const vLv = v.lv;
  const wasKing = king === v.id, bounty = wasKing ? bountyOf(v) : 0;
  // penalties: 30% coins dropped, one gear tier dropped, XP loss (may level down)
  const lost = v.gm ? 0 : Math.floor(v.coins * (soft ? .1 : .3)); v.coins -= lost;
  if (lost > 0) { const n = Math.min(6, Math.max(1, Math.ceil(lost / 15))); for (let i = 0; i < n; i++) dropPick('coin', Math.floor(lost / n) + (i < lost % n ? 1 : 0), v.x, v.z, v.y); }
  let gearLost = null;
  if (!v.gm && !soft) { // drop one tier of the best piece (weapon/armour first on ties)
    let best = null; for (const k of ['wpn', 'arm', 'boot', 'helm']) if ((v[k] || 0) > 0 && (!best || v[k] > v[best])) best = k;
    if (best) { dropPick(best, v[best], v.x, v.z, v.y); gearLost = SLOTN[best][v[best]]; v[best]--; }
  }
  let partLost = 0; if (!v.gm && !soft && (v.parts || 0) > 0) { v.parts--; partLost = 1; dropPick('part', 1, v.x, v.z, v.y); }
  const xpLoss = v.gm ? 0 : Math.round(xpNeed(v.lv) * (soft ? .15 : .4)); let lvDown = false;
  v.xp -= xpLoss; if (soft && v.xp < 0) v.xp = 0;   // 약자 보호: 레벨은 안 내려감
  if (!v.gm && v.xp < 0) { if (v.lv > 1) { v.lv--; v.xp = Math.max(0, xpNeed(v.lv) + v.xp); lvDown = true; } else v.xp = 0; }
  v.streak = 0;
  let killer = null, helpers = [];
  if (src && src.kind === 'p' && src.p.id !== v.id) {
    killer = src.p; killer.kills++; if (teamsOn && teamSt[killer.team]) teamSt[killer.team].kills++; killer.streak++; killer.best = Math.max(killer.best, killer.streak);
    if (soft) { gainXp(killer, 5); addCoins(killer, 2); }   // 약한 친구를 잡으면 보상이 거의 없음
    else { const up = gap <= -3 ? 1.5 : 1; gainXpB(killer, Math.round((20 + vLv * 8) * up)); addCoins(killer, Math.round((10 + vLv * 3) * up)); }   // 높은 레벨을 잡으면 역전 보너스
  }
  if (bounty) {
    const now = Date.now();
    helpers = [...v.dmgBy.entries()].filter(([id, t]) => now - t < 12000 && players.has(id) && id !== v.id).map(([id]) => players.get(id));
    if (killer && !helpers.includes(killer)) helpers.push(killer);
    if (helpers.length) { const share = Math.ceil(bounty / helpers.length); for (const h of helpers) { addCoins(h, share); gainXpB(h, 15); } }
  }
  v.dmgBy.clear();
  ev({ k: 'kill', v: v.id, a: killer ? killer.id : null, src: src && src.kind === 'm' ? src.m.type : src && src.kind === 'z' ? 'zone' : src && src.kind === 'sea' ? 'sea' : null, sea: v.seaKO ? 1 : 0, bounty, soft: soft ? 1 : 0, up: kp && gap <= -3 ? 1 : 0, helpers: helpers.map(h => h.id) });
  if (v.c) v.c.send({ t: 'dead', by: killer ? killer.name : src && src.kind === 'm' ? src.m.type : src && src.kind === 'z' ? 'zone' : src && src.kind === 'sea' ? 'sea' : '?', sea: v.seaKO ? 1 : 0, soft: soft ? 1 : 0, lost, gearLost, partLost, lvDown, xpLoss, respawn: 5 });
}
function hurtMon(m, dmg, p, kb = 1, fx, fz) {
  if (m.dead) return;
  if (m.type === 'crab') dmg = Math.max(1, Math.round(dmg * .6));
  m.hp -= dmg; m.tgt = p.id; m.hitT = .15;
  if (m.type !== 'boss' && m.hp > 0) { const amt = (MON_KB[m.type] || 1) * kb; knock(m, fx != null ? fx : p.x, fz != null ? fz : p.z, amt, MON[m.type].r * .6); if (m.ch) m.ch = null; m.stun = .25;
    if (m.splash) { m.splash = false; m.hp = 0; ev({ k: 'fx', s: 'splash', x: +m.x.toFixed(1), z: +m.z.toFixed(1), by: p.id }); } }
  if (m.type === 'boss') { m.dmgBy.set(p.id, (m.dmgBy.get(p.id) || 0) + dmg); m.seen.set(p.id, Date.now()); }
  ev({ k: 'hit', t: 'm', id: m.id, d: dmg, x: +m.x.toFixed(1), z: +m.z.toFixed(1) });
  if (m.hp <= 0 && m.type === 'boss') { m.dead = true; mons.delete(m.id); return bossDie(m, p); }
  if (m.hp <= 0) {
    m.dead = true; mons.delete(m.id);
    const def = MON[m.type];
    if (COOP) questKill();
    const rw = m.rw || 1; gainXpB(p, Math.round(def.xp * rw)); addCoins(p, Math.round((def.coins[0] + Math.floor(Math.random() * (def.coins[1] - def.coins[0] + 1))) * rw));
    const r = Math.random(), gearP = { snail: .06, slime: .1, bee: .14, boar: .28, golem: .6, weasel: .1, flower: .14, crab: .25, bat: .05, turtle: .45, wolf: .18 }[m.type] || .1;
    if (r < gearP) { const tier = Math.min(4, 1 + Math.floor(Math.random() * ({ snail: 1, slime: 1.6, bee: 2, boar: 3, golem: 4, weasel: 1.6, flower: 2, crab: 3, bat: 1, turtle: 3.6 }[m.type] || 1))); const sl = ['wpn', 'arm', 'wpn', 'arm', 'boot', 'helm'][Math.floor(Math.random() * 6)]; dropPick(sl, sl === 'boot' || sl === 'helm' ? Math.min(3, tier) : tier, m.x, m.z); }
    else if (r < gearP + .22) dropPick('heal', 30, m.x, m.z);
    ev({ k: 'mdie', id: m.id, x: +m.x.toFixed(1), z: +m.z.toFixed(1), by: p.id, type: m.type });
  }
}

/* ======================= targeting ======================= */
function enemiesNear(p, range, maxDy = Infinity) {
  const out = [];
  for (const q of players.values()) if (q !== p && q.alive && online(q) && Date.now() >= q.prot && !sameTeam(p, q) && dyOk(p, q, maxDy)) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d <= range) out.push({ kind: 'p', o: q, d }); }
  for (const m of mons.values()) { if (!FLYERS.has(m.type) && !dyOk(p, m, m.type === 'boss' ? 6 : maxDy)) continue; const d = Math.hypot(m.x - p.x, m.z - p.z); if (d <= range + (m.type === 'boss' ? BOSS.r : MON[m.type].r) * .5) out.push({ kind: 'm', o: m, d }); }
  return out.sort((a, b) => a.d - b.d);
}
function hitTarget(p, t, dmg, kb = 1, from) { if (t.kind === 'p' && sameTeam(p, t.o)) return; const fx = from ? from.x : p.x, fz = from ? from.z : p.z; if (t.kind === 'p') hurtPlayer(t.o, dmg, { kind: 'p', p, kb, fx, fz }); else hurtMon(t.o, dmg, p, kb, fx, fz); }
function knock(e, fx, fz, dist, rad) {   // 맞으면 뒤로 밀림 (벽·건물은 통과 못 함)
  if (!(dist > 0)) return [0, 0];
  let dx = e.x - fx, dz = e.z - fz, d = Math.hypot(dx, dz); if (d < .05) { const a = Math.random() * 6.28; dx = Math.sin(a); dz = Math.cos(a); d = 1; }
  if (Math.hypot(e.x, e.z) > BEACH) dist *= 1.8;   // 모래사장은 미끄러워서 더 멀리 밀려요
  const ox = e.x, oz = e.z; let nx = e.x + dx / d * dist, nz = e.z + dz / d * dist;
  if ((e.y || 0) < .5 && Math.hypot(nx, nz) > R - 1.15 && !(e.type && FLYERS.has(e.type))) e.splash = true;   // 바다로 밀려남
  if ((e.y || 0) < .5) [nx, nz] = collide(nx, nz, rad);
  if (!blockedAt(nx, nz, e.y || 0, rad * .8)) { e.x = nx; e.z = nz; const f = floorAt(nx, nz, (e.y || 0)); if (f < (e.y || 0)) e.vy = 0; }
  return [+(e.x - ox).toFixed(2), +(e.z - oz).toFixed(2)];
}
const BEACH = R - 7;   // 이 바깥(해변)에서 맞으면 1.8배 밀리고, 바다까지 밀리면 풍덩
function seaFall(v, src) {   // 학생이 바다에 빠짐: 1부 = 쓰러짐(민 사람이 처치), 2부·운영자 = 해변으로 건져 올림
  ev({ k: 'fx', s: 'splash', x: +v.x.toFixed(1), z: +v.z.toFixed(1) });
  if (COOP || v.gm) {
    const [x, z] = freeSpot(6); v.x = x; v.z = z; v.y = 0; v.vy = 0; v.mx = v.mz = 0; v.prot = Date.now() + 1500;
    if (!v.gm) v.hp = Math.max(1, Math.round(v.hp - stat(v).maxHp * .25));
    if (v.task) cancelTask(v); tell(v, v.gm ? '바다에 빠졌어요! (운영자는 손해 없음)' : '🌊 바다에 빠졌어요! 섬으로 건져 올렸어요. (체력 −25%)');
    ev({ k: 'spawn', id: v.id }); return;
  }
  let by = src && src.kind === 'p' ? src : null;
  if (!by) { const now = Date.now(); let best = null, bt = 0; for (const [id, t] of v.dmgBy) if (now - t < 6000 && t > bt && players.has(id)) { best = players.get(id); bt = t; } if (best) by = { kind: 'p', p: best }; }
  v.seaKO = true; killPlayer(v, by || { kind: 'sea' }); v.seaKO = false;
}
const MON_KB = { snail: 1.6, slime: 1.4, bee: 1.2, boar: .6, golem: .25, weasel: 1.6, flower: 1, crab: .5, bat: 1.8, turtle: .15, wolf: 1.3 };
const MON_HIT_KB = { boar: 1.8, golem: 1.6, turtle: 2.6, crab: 1.1 };

/* ======================= actions ======================= */
/* ---- 상태 이상(기절·묶기·둔화)과 직업 스킬 ---- */
function applyCC(t, fx, owner) {
  if (!fx) return; const now = Date.now(), e = t.o;
  if (t.kind === 'm') { if (e.dead || e.type === 'boss') { if (fx.slow && e.type === 'boss') { e.slowUntil = now + fx.slow[1] * 1000; e.slowMul = Math.max(fx.slow[0], .8); } return; }
    if (fx.stun || fx.root) e.stun = Math.max(e.stun || 0, fx.stun || fx.root); if (fx.slow) { e.slowUntil = now + fx.slow[1] * 1000; e.slowMul = fx.slow[0]; } return; }
  if (!e.alive || now < e.prot || e.shopUntil || e.gq != null) return;
  const immune = now < (e.ccImmuneUntil || 0);
  if (fx.stun && !immune) { e.stunUntil = Math.max(e.stunUntil || 0, now + fx.stun * 1000); e.ccImmuneUntil = e.stunUntil + 1500; if (e.task) cancelTask(e); ev({ k: 'fx', s: 'stun', id: e.id, x: +e.x.toFixed(1), z: +e.z.toFixed(1) }); }
  if (fx.root && !immune) { e.rootUntil = Math.max(e.rootUntil || 0, now + fx.root * 1000); e.ccImmuneUntil = e.rootUntil + 1500; ev({ k: 'fx', s: 'root', id: e.id, x: +e.x.toFixed(1), z: +e.z.toFixed(1) }); }
  if (fx.slow && !immune) { e.slowUntil = now + fx.slow[1] * 1000; e.slowMul = fx.slow[0]; }
}
function hitFx(owner, t, dmg, kb, from, fx) { hitTarget(owner, t, dmg, kb, from); if (t.kind === 'p' && sameTeam(owner, t.o)) return; applyCC(t, fx, owner); }
function aimAt(p, range, cone = .5) {   // 보는 쪽 ±약 29° 안의 가장 가까운 적을 살짝 겨눠 줌(조준 보조)
  let best = null, bd = 1e9;
  for (const t of enemiesNear(p, range, 3)) { const a = Math.atan2(t.o.x - p.x, t.o.z - p.z), da = Math.abs(((a - p.dir + Math.PI * 3) % (Math.PI * 2)) - Math.PI); if (da < cone && t.d < bd) { bd = t.d; best = a; } }
  return best == null ? p.dir : best;
}
const allies = (p, r) => [...players.values()].filter(q => q.alive && online(q) && (q === p || sameTeam(p, q)) && Math.hypot(q.x - p.x, q.z - p.z) <= r);
function startRush(p, ang, spd, secs, kind) { p.rush = { vx: Math.sin(ang) * spd, vz: Math.cos(ang) * spd, until: Date.now() + secs * 1000, kind }; p.dir = ang; p.mx = p.mz = 0; }
function endRush(p) { const r = p.rush; p.rush = null; if (!r) return; const st = stat(p);
  if (r.kind === 'leap') { for (const t of enemiesNear(p, 3.8, 2.4)) hitFx(p, t, Math.round(st.atk * 2.6), 2.4, p, { stun: 1 }); ev({ k: 'fx', s: 'slam', x: +p.x.toFixed(1), z: +p.z.toFixed(1), r: 3.8 }); } }
function tickRush(p, dt, now) {   // 돌진·구르기·도약: 짧고 빠른 이동 (벽은 못 뚫음)
  const r = p.rush; if (now >= r.until) return endRush(p);
  let nx = p.x + r.vx * dt, nz = p.z + r.vz * dt; if ((p.y || 0) < .5) [nx, nz] = collide(nx, nz, .45);
  if (blockedAt(nx, nz, p.y || 0, .36)) return endRush(p);
  moveY(p, nx, nz, .4, dt);
  if (r.kind === 'charge') { const t = enemiesNear(p, 1.5, 1.8)[0]; if (t) { hitFx(p, t, Math.round(stat(p).atk * 1.6), 1.6, p, { stun: .8 }); p.rush = null; } }
}
function jobSkill(p, id, st) {
  const now = Date.now(), j = p.job, mul = st.skillMul;
  if (j === 'warrior') {
    if (id === 'dash') { startRush(p, aimAt(p, 9), 26, .28, 'charge'); ev({ k: 'fx', s: 'dash', id: p.id, x: p.x, z: p.z }); }
    else if (id === 'cannon') { const a = aimAt(p, 7); p.dir = a; const ux = Math.sin(a), uz = Math.cos(a);
      for (const t of enemiesNear(p, 7.6, 2)) { const rx = t.o.x - p.x, rz = t.o.z - p.z, al = rx * ux + rz * uz, pe = Math.abs(-rx * uz + rz * ux); if (al > -.5 && al < 7.5 && pe < 1.6) hitFx(p, t, Math.round(st.atk * 1.8), 1.4, p, { slow: [.6, 2] }); }
      for (let i = 1; i <= 3; i++) ev({ k: 'fx', s: 'slam', x: +(p.x + ux * i * 2.2).toFixed(1), z: +(p.z + uz * i * 2.2).toFixed(1), r: 1.5 }); }
    else if (id === 'thunder') { p.ccImmuneUntil = Math.max(p.ccImmuneUntil || 0, now + 600); startRush(p, aimAt(p, 9), 22, .3, 'leap'); ev({ k: 'fx', s: 'job', id: p.id, job: 'warrior' }); }
  } else if (j === 'archer') {
    if (id === 'dash') { const ml = Math.hypot(p.mx, p.mz); const a = ml > .1 ? Math.atan2(p.mx, p.mz) : p.dir + Math.PI; startRush(p, a, 24, .22, 'roll'); p.prot = Math.max(p.prot, now + 300); ev({ k: 'fx', s: 'dash', id: p.id, x: p.x, z: p.z }); }
    else if (id === 'cannon') { const a = aimAt(p, 18, .35); p.dir = a; projs.push({ id: nextId++, kind: 'pierce', by: p.id, x: p.x, z: p.z, y: p.y || 0, dx: Math.sin(a), dz: Math.cos(a), spd: 34, life: 18 / 34, dmg: Math.round(st.atk * 2), hit: new Set(), r: .9, kb: 1.2, fx: { slow: [.7, 1.5] } }); }
    else if (id === 'thunder') { const a = aimAt(p, 13, .45); p.dir = a; const t = enemiesNear(p, 13, 3).find(t => Math.abs(((Math.atan2(t.o.x - p.x, t.o.z - p.z) - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < .45);
      const d = t ? Math.min(13, t.d) : 9, x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
      for (let k = 0; k < 3; k++) pending.push({ at: now + 900 + k * 450, by: p.id, x, z, r: 4, dmg: Math.round(st.atk * 1.1), fx: { slow: [.6, 1] }, look: 'rain' });
      ev({ k: 'fx', s: 'warn', x: +x.toFixed(1), z: +z.toFixed(1), r: 4, t: 1 }); }
  } else if (j === 'mage') {
    if (id === 'dash') { const a = p.dir, ox = p.x, oz = p.z; let x = p.x, z = p.z;
      for (let i = 1; i <= 13; i++) { let nx = ox + Math.sin(a) * i * .5, nz = oz + Math.cos(a) * i * .5; if ((p.y || 0) < .5) [nx, nz] = collide(nx, nz, .45); if (blockedAt(nx, nz, p.y || 0, .36)) break; x = nx; z = nz; }
      ev({ k: 'fx', s: 'blink', id: p.id, x: +ox.toFixed(1), z: +oz.toFixed(1), x2: +x.toFixed(1), z2: +z.toFixed(1) }); moveY(p, x, z, .4, .05); p.x = x; p.z = z; }
    else if (id === 'cannon') { const a = aimAt(p, 14, .35); p.dir = a; projs.push({ id: nextId++, kind: 'bind', by: p.id, x: p.x, z: p.z, y: p.y || 0, dx: Math.sin(a), dz: Math.cos(a), spd: 22, life: 14 / 22, dmg: Math.round(st.atk * 1.6 * mul), r: .9, kb: .5, fx: { root: 1.5 } }); }
    else if (id === 'thunder') { pending.push({ at: now + 600, by: p.id, x: p.x, z: p.z, r: 6.5, dmg: Math.round(st.atk * 3.2 * mul), fx: { stun: .6 }, follow: true }); ev({ k: 'fx', s: 'warn', x: +p.x.toFixed(1), z: +p.z.toFixed(1), r: 6.5, t: .6 }); }
  } else if (j === 'healer') {
    if (id === 'dash') { for (const q of allies(p, 7)) { const qs = stat(q); q.hp = Math.min(qs.maxHp, q.hp + qs.maxHp * .25); q.stunUntil = q.rootUntil = q.slowUntil = 0; ev({ k: 'fx', s: 'heal', id: q.id, x: q.x, z: q.z }); } }
    else if (id === 'cannon') { const a = aimAt(p, 15, .35); p.dir = a; projs.push({ id: nextId++, kind: 'pulse', by: p.id, x: p.x, z: p.z, y: p.y || 0, dx: Math.sin(a), dz: Math.cos(a), spd: 24, life: 15 / 24, dmg: Math.round(st.atk * 1.5), r: .9, kb: .8, fx: { slow: [.7, 1.5] }, leech: .6 }); }
    else if (id === 'thunder') { for (const q of allies(p, 8)) { q.shieldT = Math.max(q.shieldT || 0, 4); q.ccImmuneUntil = Math.max(q.ccImmuneUntil || 0, now + 4000); ev({ k: 'fx', s: 'shield', id: q.id, x: q.x, z: q.z }); } }
  }
}
function useSkill(p, id) {
  const sk = SKILLS[id]; if (!sk || !p.alive || p.lv < sk.lv) return;
  if (p.shopUntil || p.gq != null) return;   // 상점·문제 풀이 중(무적)에는 공격 못 함
  if (Date.now() < (p.stunUntil || 0) || p.rush) return;   // 기절·돌진 중에는 스킬 못 씀
  const now = Date.now() / 1000, js = p.job && JSK[p.job] && JSK[p.job][id];
  if ((p.cds[id] || 0) > now) return;
  p.cds[id] = now + (js ? js.cd : sk.cd) * (id === 'punch' ? 1 : 1 - stat(p).cdr);
  if (p.prot > Date.now() && id !== 'dash' && id !== 'heal' && id !== 'shield') p.prot = 0;   // attacking ends spawn protection
  const st = stat(p);
  if (js) { if (p.prot > Date.now() && id !== 'dash') p.prot = 0; return jobSkill(p, id, st); }
  if (id === 'punch') {
    if (p.job === 'archer') {
      const t = enemiesNear(p, 9, 3)[0], a = t ? Math.atan2(t.o.x - p.x, t.o.z - p.z) : p.dir; p.dir = a;
      projs.push({ id: nextId++, kind: 'arrow', by: p.id, x: p.x, z: p.z, y: p.y || 0, dx: Math.sin(a), dz: Math.cos(a), spd: 30, life: .34, dmg: Math.round(st.atk * .95), hit: new Set(), r: .8, one: true, kb: .8 });
    } else {
      const t = enemiesNear(p, 3.4, 1.8)[0], mul = p.job === 'warrior' ? 1.3 : p.job === 'healer' ? .9 : 1;
      if (t) { p.dir = Math.atan2(t.o.x - p.x, t.o.z - p.z); hitTarget(p, t, Math.round(st.atk * mul), p.job === 'warrior' ? 2 : 1.1); }
    }
    ev({ k: 'fx', s: 'punch', id: p.id, x: +p.x.toFixed(1), z: +p.z.toFixed(1), a: +p.dir.toFixed(2) });
  } else if (id === 'dash') { p.dashT = 2.5; ev({ k: 'fx', s: 'dash', id: p.id, x: p.x, z: p.z }); }
  else if (id === 'whirl') {
    for (const t of enemiesNear(p, 5.6, 2.2)) hitTarget(p, t, Math.round(st.atk * 1.5 * st.skillMul), 2.2);
    ev({ k: 'fx', s: 'whirl', id: p.id, x: p.x, z: p.z });
  } else if (id === 'cannon' || id === 'tornado') {
    const t = enemiesNear(p, 26)[0], a = t ? Math.atan2(t.o.x - p.x, t.o.z - p.z) : p.dir;
    p.dir = a;
    projs.push(id === 'cannon'
      ? { id: nextId++, kind: 'cannon', by: p.id, x: p.x, z: p.z, y: p.y || 0, dx: Math.sin(a), dz: Math.cos(a), spd: 26, life: 1.1, dmg: Math.round(st.atk * 2.2 * st.skillMul), hit: new Set(), r: 1, kb: 2 }
      : { id: nextId++, kind: 'tornado', by: p.id, x: p.x, z: p.z, y: p.y || 0, dx: Math.sin(a), dz: Math.cos(a), spd: 6, life: 2.8, dmg: Math.round(st.atk * .7 * st.skillMul), tick: 0, r: 2.6 });
  } else if (id === 'heal') {
    p.hp = Math.min(st.maxHp, p.hp + st.maxHp * .45); ev({ k: 'fx', s: 'heal', id: p.id, x: p.x, z: p.z });
    if (p.job === 'healer') for (const q of players.values()) if (q !== p && q.alive && online(q) && sameTeam(p, q) && Math.hypot(q.x - p.x, q.z - p.z) < 7) { const qs = stat(q); q.hp = Math.min(qs.maxHp, q.hp + qs.maxHp * .3); ev({ k: 'fx', s: 'heal', id: q.id, x: q.x, z: q.z }); }
  } else if (id === 'shield') { p.shieldT = 3; ev({ k: 'fx', s: 'shield', id: p.id, x: p.x, z: p.z }); }
  else if (id === 'thunder') {
    const t = enemiesNear(p, 18)[0]; const x = t ? t.o.x : p.x + Math.sin(p.dir) * 8, z = t ? t.o.z : p.z + Math.cos(p.dir) * 8;
    pending.push({ at: Date.now() + 800, by: p.id, x, z, r: 3.2, dmg: Math.round(st.atk * 3 * st.skillMul) });
    ev({ k: 'fx', s: 'warn', x: +x.toFixed(1), z: +z.toFixed(1), r: 3.2 });
  }
}
const tell = (p, s) => p.c && p.c.send({ t: 'msg', s });
/* ---- 안전 쇼핑: 상점에 들어가면 10초 동안 무적(대신 공격·과제·상자 불가), 10초 뒤 자동으로 나가고 10초 동안 다시 못 들어감 ---- */
const SHOP_SAFE = 10000, SHOP_CD = 10000;
function enterShop(p) {
  const now = Date.now();
  if (!p.alive || p.shopUntil || p.gq != null) return;
  if (!nearShop(p)) return tell(p, '동·서·남·북에 있는 <b>바람상회</b>(미니맵 노란 네모) 노란 원 안에서 상점에 들어갈 수 있어요.');
  if (now < (p.shopCdUntil || 0)) { const left = Math.ceil((p.shopCdUntil - now) / 1000); if (p.c) p.c.send({ t: 'shop', s: 'cd', left }); return tell(p, `상점은 <b>${left}초</b> 뒤에 다시 들어갈 수 있어요.`); }
  if (p.task) cancelTask(p);
  if (chest && chest.opener === p.id) chest.opener = null;
  p.shopUntil = now + SHOP_SAFE; p.prot = p.shopUntil; p.mx = p.mz = 0;
  if (p.c) p.c.send({ t: 'shop', s: 'in', secs: SHOP_SAFE / 1000 });
  ev({ k: 'fx', s: 'shopin', id: p.id, x: +p.x.toFixed(1), z: +p.z.toFixed(1) });
}
function exitShop(p, why) {
  if (!p.shopUntil) return;
  const now = Date.now(); p.shopUntil = 0; p.shopCdUntil = now + SHOP_CD; p.prot = p.alive ? now + 1000 : 0;   // 나온 뒤 1초만 숨 돌릴 틈
  if (p.c) p.c.send({ t: 'shop', s: 'out', why, cd: SHOP_CD / 1000 });
}
/* ---- 따라잡기: 늦게 온 친구·레벨 낮은 친구 돕기 ---- */
let lvAvg = 1;
const xpBoost = p => { if (p.gm) return 1; const g = lvAvg - p.lv; return g >= 1.5 ? Math.min(3, +(1 + .25 * g).toFixed(1)) : 1; };
const gainXpB = (p, n) => gainXp(p, Math.round(n * xpBoost(p)));
function catchUpStart(p) {   // 다른 친구들 평균 레벨의 60%로 시작 + 코인·기본 장비
  const others = live().filter(q => q !== p); if (others.length < 2) return;
  const avg = others.reduce((a, q) => a + q.lv, 0) / others.length, lv = Math.min(MAXLV, Math.floor(avg * .6));
  if (lv < 2) return;
  p.lv = lv; p.xp = 0; p.coins += (lv - 1) * 12; const g = Math.min(2, Math.floor(lv / 4)); p.wpn = Math.max(p.wpn, g); p.arm = Math.max(p.arm, g); p.hp = stat(p).maxHp; p.catchUp = lv;
}
function shopCheck(p) {
  if (!p.alive) return false;
  if (!nearShop(p)) { tell(p, '동·서·남·북에 있는 <b>바람상회</b>(미니맵 노란 네모)에 가야 살 수 있어요.'); return false; }
  if (!p.shopUntil) { tell(p, '<b>상점 버튼(B)</b>을 눌러 상점에 들어가야 살 수 있어요.'); return false; }
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
function changeJob(p, job) {
  if (!JOBS[job] || !p.alive) return;
  if (Math.hypot(p.x, p.z) > SHRINE_R + 1) return tell(p, '섬 가운데 <b>바람의 신전</b>에서 전직할 수 있어요.');
  if (p.lv < JOB_LV && !p.gm) return tell(p, `Lv ${JOB_LV}부터 전직할 수 있어요.`);
  if (p.job === job) return;
  if (p.job && !p.gm) { if (p.coins < JOB_CHANGE) return tell(p, `직업을 바꾸려면 ${JOB_CHANGE}코인이 필요해요.`); p.coins -= JOB_CHANGE; }
  const was = stat(p).maxHp; p.job = job; p.hp = Math.min(stat(p).maxHp, p.hp * stat(p).maxHp / was);
  tell(p, `${JOBS[job].ic} <b>${JOBS[job].n}</b>(으)로 전직했어요! ${JOBS[job].d}`);
  ev({ k: 'fx', s: 'job', id: p.id, x: +p.x.toFixed(1), z: +p.z.toFixed(1), job });
}

/* ======================= raid boss: 태풍 마수 돌개 ======================= */
let boss = null, bossCd = 0, bossChk = 0;
const bossStrikes = [];
function spawnBoss(why) {
  if (boss && !boss.dead) return;
  const n = Math.max(1, live().length), max = BOSS.hp0 + BOSS.hpPer * n;
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
  if (tgt) { const d = Math.hypot(tgt.x - m.x, tgt.z - m.z); m.dir = Math.atan2(tgt.x - m.x, tgt.z - m.z); if (d > BOSS.r + 1) { const nx = m.x + Math.sin(m.dir) * spd * dt, nz = m.z + Math.cos(m.dir) * spd * dt; const [cx, cz] = collide(nx, nz, BOSS.r * .6); if (!onStruct(cx, cz, BOSS.r * .7)) { m.x = cx; m.z = cz; } } }
  else { m.wT -= dt; if (m.wT <= 0) { m.wT = 3; m.dir = Math.atan2(-m.x, -m.z) + (Math.random() - .5); } const nx = m.x + Math.sin(m.dir) * spd * .4 * dt, nz = m.z + Math.cos(m.dir) * spd * .4 * dt; [m.x, m.z] = collide(nx, nz, BOSS.r * .6); }
  m.atkCd -= dt; m.whT -= dt; m.btT -= dt;
  if (m.atkCd <= 0) { const near = alive.filter(p => now >= p.prot && Math.hypot(p.x - m.x, p.z - m.z) < BOSS.r + 1.8 && (p.y || 0) < 6); if (near.length) { m.atkCd = enr ? 1.2 : 1.6; for (const p of near) hurtPlayer(p, BOSS.melee, { kind: 'm', m }); ev({ k: 'fx', s: 'slam', x: +m.x.toFixed(1), z: +m.z.toFixed(1), r: BOSS.r + 1.8 }); } }
  if (m.whT <= 0 && tgt) { m.whT = enr ? 5 : 7; const r = 7.5; ev({ k: 'fx', s: 'warn', x: +m.x.toFixed(1), z: +m.z.toFixed(1), r, t: 1.3 }); bossStrikes.push({ at: now + 1300, x: m.x, z: m.z, r, dmg: BOSS.whirl, kb: 5, fx: 'whirl', ground: true }); }
  if (m.btT <= 0 && tgt) { m.btT = enr ? 7 : 10; const ts = alive.filter(p => now >= p.prot && Math.hypot(p.x - m.x, p.z - m.z) < 32).sort(() => Math.random() - .5).slice(0, enr ? 7 : 5);
    for (const p of ts) { const x = p.x + (Math.random() - .5) * 2, z = p.z + (Math.random() - .5) * 2; ev({ k: 'fx', s: 'warn', x: +x.toFixed(1), z: +z.toFixed(1), r: 3, t: 1.4 }); bossStrikes.push({ at: now + 1400, x, z, r: 3, dmg: BOSS.bolt, fx: 'thunder' }); } }
}
function tickBossStrikes(now, alive) {
  for (let i = bossStrikes.length - 1; i >= 0; i--) {
    const s = bossStrikes[i]; if (now < s.at) continue; bossStrikes.splice(i, 1);
    ev({ k: 'fx', s: s.fx, x: +s.x.toFixed(1), z: +s.z.toFixed(1), r: s.r });
    const src = boss ? { kind: 'm', m: boss } : { kind: 'm', m: { type: 'boss' } };
    for (const p of alive) { const d = Math.hypot(p.x - s.x, p.z - s.z); if (d > s.r || now < p.prot || (s.ground && (p.y || 0) > 1.2)) continue; if (s.kb && d > .1) { const [kx, kz] = collide(p.x + (p.x - s.x) / d * s.kb, p.z + (p.z - s.z) / d * s.kb, .45); if (!blockedAt(kx, kz, p.y || 0, .4)) { p.x = kx; p.z = kz; } } hurtPlayer(p, s.dmg, src); }
  }
}
/* ======================= 2부 협동 퀘스트 (다같이) ======================= */
const QSTAGES = [null, { n: '발전기 수리', d: '과제 기계에서 과제를 다 함께 해내세요' }, { n: '매연 정화', d: '섬의 매연 몬스터를 다 함께 정화하세요' }, { n: '태풍 마수 토벌', d: '태풍 마수 돌개를 모두 힘을 합쳐 쓰러뜨리세요!' }, { n: '옥정섬 완전 복구!', d: '축하해요! 자유롭게 사냥하고 장비를 모으세요' }];
const quest = { stage: 1, prog: 0, goal: 10 };
function questGoal() { const n = Math.max(1, live().length); return quest.stage === 1 ? Math.max(8, n * 2) : quest.stage === 2 ? Math.max(15, n * 4) : 1; }
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
let monT = 0, lbT = 0, snapT = 0, snapN = 0;
function step(dt) {
  const now = Date.now();
  // round
  if (round.phase === 'play' && now >= round.endsAt) endRound();
  const zr = zoneR();
  // players
  for (const p of [...players.values()]) {
    if (!online(p)) { if (now - (p.offAt || now) > 180000) { players.delete(p.id); broadcast({ t: 'ro', gone: p.id, name: p.name }); } continue; }
    if (p.shopUntil && (now >= p.shopUntil || !p.alive || !nearShop(p))) exitShop(p, now >= p.shopUntil ? 'time' : 'left');
    if (!p.gm && now - (p.actAt || p.joined) > IDLE_MS) { bye(p, '5분 동안 움직이지 않아서 아레나에서 나왔어요. 다시 하려면 [입장하기]를 누르세요.'); continue; }
    if (!p.alive) {
      if (now >= p.respawnAt) { const [x, z] = freeSpot(10); p.x = x; p.z = z; p.y = 0; p.vy = 0; p.alive = true; p.prot = now + 3000; p.hp = stat(p).maxHp; ev({ k: 'spawn', id: p.id }); }
      continue;
    }
    p.dashT -= dt; p.shieldT -= dt;
    if (p.task) { const t = STATIONS[p.task.sid]; if (Math.hypot(t.x - p.x, t.z - p.z) > TASK_R + .8) cancelTask(p, '기계에서 멀어져서 과제가 취소됐어요.'); }
    const st = stat(p);
    if (p.rush) { tickRush(p, dt, now); continue; }
    const held = now < (p.stunUntil || 0) || now < (p.rootUntil || 0);
    const len = held ? 0 : Math.hypot(p.mx, p.mz), [gx, gz] = gustPush(p, true);
    if (len > .05 || gx || gz) {
      const k = Math.min(1, len), mv = len > .05 ? st.spd * k / len * (now < (p.slowUntil || 0) ? p.slowMul || .6 : 1) : 0; let nx = p.x + (p.mx * mv + gx) * dt, nz = p.z + (p.mz * mv + gz) * dt;
      if ((p.y || 0) < .5) [nx, nz] = collide(nx, nz, .45); else { const d = Math.hypot(nx, nz), lim = R - 1.2; if (d > lim) { nx *= lim / d; nz *= lim / d; } }
      moveY(p, nx, nz, .4, dt); if (len > .05) p.dir = Math.atan2(p.mx, p.mz);
    } else moveY(p, p.x, p.z, .4, dt);
    if (now - p.lastHurt > 5000 && p.hp < st.maxHp) p.hp = Math.min(st.maxHp, p.hp + st.maxHp * (p.job === 'healer' ? .08 : .04) * dt);
    if (p.hp > st.maxHp) p.hp = st.maxHp;
    if (Math.hypot(p.x, p.z) > zr) { p.zoneAcc = (p.zoneAcc || 0) + dt; if (p.zoneAcc > .5) { p.zoneAcc = 0; hurtPlayer(p, 6 + Math.round(st.maxHp * .03), { kind: 'z' }); } }
    // pickups
    for (const k of picks.values()) {
      if (Math.hypot(k.x - p.x, k.z - p.z) > 1.6 || Math.abs((k.y || 0) - (p.y || 0)) > 1.6) continue;
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
  { const lp = live(); lvAvg = lp.length ? lp.reduce((a, q) => a + q.lv, 0) / lp.length : 1; }
  const cap = Math.min(MON_CAP, 8 + Math.ceil(alive.length * MON_PER));   // 접속 인원에 따라 늘어남
  if (monT <= 0 && alive.length && mons.size < cap) {
    monT = .6;
    const studs = alive.filter(p => !p.gm), anchor = studs.length ? studs[Math.floor(Math.random() * studs.length)] : null;   // 한 학생 근처에, 그 학생 레벨에 맞는 몬스터
    const avgLv = anchor ? anchor.lv : alive.reduce((s, p) => s + p.lv, 0) / Math.max(1, alive.length);
    const pool = Object.entries(MON).filter(([, d]) => d.lv <= Math.max(2, avgLv + 2));
    const w = pool.map(([k, d]) => k === 'snail' ? Math.max(.6, 4 - avgLv * .4) : k === 'golem' || k === 'turtle' ? .6 + (avgLv - d.lv) * .25 : k === 'bat' ? 1 : k === 'wolf' ? 1.3 : 2);
    let r = Math.random() * w.reduce((a, b) => a + b, 0), type = pool[0][0];
    for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) { type = pool[i][0]; break; } }
    for (let i = 0; i < 20; i++) {
      let a = Math.random() * Math.PI * 2, d = 8 + Math.random() * (zr - 12), x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (anchor && i < 12) { const r2 = 13 + Math.random() * 15; x = anchor.x + Math.cos(a) * r2; z = anchor.z + Math.sin(a) * r2; if (Math.hypot(x, z) > zr - 4) continue; }
      if (OBS.some(o => Math.hypot(o[0] - x, o[1] - z) < o[2] + 2)) continue;
      if (onStruct(x, z, 1.5)) continue;
      if (SHOPS.some(sh => Math.hypot(sh.x - x, sh.z - z) < SHOP_R + 4)) continue;
      if (alive.some(p => Math.hypot(p.x - x, p.z - z) < 11)) continue;
      const def = MON[type];
      const weak = Math.random() < .25, mlv = weak || !anchor ? def.lv : Math.min(MON_MAXLV, Math.max(def.lv, anchor.lv + Math.floor(Math.random() * 4) - 1));
      for (let k = 0; k < (def.beh === 'swarm' ? 3 : def.beh === 'runner' ? 2 : 1); k++) { const id = nextId++; mons.set(id, { id, type, x: x + k * .9, z: z + (k % 2) * .9, hp: def.hp, max: def.hp, dir: Math.random() * 6.28, wT: 0, atkCd: 1, tgt: null, hitT: 0, cd2: 1 + Math.random() * 2 }); monLevelUp(mons.get(id), mlv); }
      break;
    }
  }
  // monsters move/attack
  for (const m of mons.values()) {
    if (m.type === 'boss') { bossAI(m, dt, alive, now); continue; }
    const def = MON[m.type];
    let tgt = null, td = def.aggro;
    for (const p of alive) { if (now < p.prot) continue; const d = Math.hypot(p.x - m.x, p.z - m.z); if (d < td || (m.tgt === p.id && d < def.aggro * 1.6)) { if (d < td || !tgt) { tgt = p; td = d; } } }
    let spd = def.spd * (m.spdMul || 1) * (m.slowUntil > now ? m.slowMul || .6 : 1); m.cd2 = (m.cd2 || 0) - dt; if (m.stun > 0) { m.stun -= dt; spd = 0; }
    if (tgt) m.dir = Math.atan2(tgt.x - m.x, tgt.z - m.z) + (m.type === 'bee' || m.type === 'bat' ? Math.sin(now / 200 + m.id) * .6 : 0);
    else { spd *= .4; m.wT -= dt; if (m.wT <= 0) { m.wT = 2 + Math.random() * 3; m.dir = Math.random() * 6.28; } }
    if (def.beh === 'runner' && tgt && m.flee > 0) { m.flee -= dt; m.dir = Math.atan2(m.x - tgt.x, m.z - tgt.z) + Math.sin(now / 300 + m.id) * .5; }   // 물고 빠지기
    if (def.beh === 'dart' && tgt) { if (m.dash > 0) { m.dash -= dt; spd = 15; } else if (td < 10 && m.cd2 <= 0) { m.dash = .4; m.cd2 = 2.6; } }
    if (def.beh === 'ranged' && tgt) { spd = td < 7 ? -def.spd * 1.5 : 0; if (td < 14 && m.cd2 <= 0) { m.cd2 = 2.6; const a = Math.atan2(tgt.x - m.x, tgt.z - m.z); projs.push({ id: nextId++, kind: 'spit', mon: true, x: m.x, z: m.z, y: m.y || 0, dx: Math.sin(a), dz: Math.cos(a), spd: 13, life: 1.3, dmg: (m.dmg || def.dmg), r: .7 }); } }
    if (def.beh === 'heavy') { if (m.wind > 0) { m.wind -= dt; spd = 0; if (m.wind <= 0) { const fx = m.x + Math.sin(m.dir) * 1.4, fz = m.z + Math.cos(m.dir) * 1.4; ev({ k: 'fx', s: 'slam', x: +fx.toFixed(1), z: +fz.toFixed(1), r: 2.8 }); for (const p of alive) if (now >= p.prot && Math.hypot(p.x - fx, p.z - fz) < 2.8 && dyOk(p, m, 1.6)) hurtPlayer(p, (m.dmg || def.dmg), { kind: 'm', m }); m.atkCd = 2.4; } }
      else if (tgt && td < def.r + 1.6 && m.atkCd <= 0) { m.wind = 1.0; const fx = m.x + Math.sin(m.dir) * 1.4, fz = m.z + Math.cos(m.dir) * 1.4; ev({ k: 'fx', s: 'warn', x: +fx.toFixed(1), z: +fz.toFixed(1), r: 2.8, t: 1 }); } }
    if (spd < 0) { m.dir += Math.PI; spd = -spd; }
    const [mgx, mgz] = gustPush(m, false);
    const nx = m.x + (Math.sin(m.dir) * spd + mgx) * dt, nz = m.z + (Math.cos(m.dir) * spd + mgz) * dt;
    const fly = FLYERS.has(m.type);
    let [cx, cz] = collide(nx, nz, def.r * .7);
    for (const sh of SHOPS) { const dx = cx - sh.x, dz = cz - sh.z, d = Math.hypot(dx, dz), lim = SHOP_R + def.r * .5; if (d < lim && d > 1e-3) { cx = sh.x + dx / d * lim; cz = sh.z + dz / d * lim; } }   // 몬스터는 상점 원 안에 못 들어와요
    if (fly) { m.x = cx; m.z = cz; m.y = tgt ? (tgt.y || 0) : 0; } else { const ox = m.x, oz = m.z; moveY(m, cx, cz, def.r * .6, dt); if (Math.hypot(m.x - ox, m.z - oz) < spd * dt * .2 && spd > .5) m.wT = 0; }
    if (Math.hypot(m.x, m.z) > zr + 4) { m.dir += Math.PI; }
    m.atkCd -= dt;
    if (def.beh !== 'heavy' && def.beh !== 'ranged' && tgt && !(m.stun > 0) && td < def.r + .6 && m.atkCd <= 0 && (fly || dyOk(m, tgt, 1.6))) { m.atkCd = 1.1; hurtPlayer(tgt, (m.dmg || def.dmg), { kind: 'm', m }); if (def.beh === 'runner') { m.flee = .9; m.atkCd = 1.4; } }
  }
  tickBossStrikes(now, alive);
  tickChest(dt, now); tickGusts(now);
  // boss trigger (1부: 레벨이 높아지면 / 2부: 퀘스트 3단계)
  bossChk -= dt;
  if (bossChk <= 0) { bossChk = 5;
    const on = live();
    if (!COOP && !boss && now > bossCd && on.length >= 2 && on.filter(p => p.lv >= 10).length >= on.length * .5) spawnBoss('level');
    if (COOP && quest.stage === 3 && !boss && now > bossCd - 200000) spawnBoss('quest');
  }
  // projectiles
  for (let i = projs.length - 1; i >= 0; i--) {
    const pr = projs[i], owner = players.get(pr.by); pr.life -= dt;
    pr.x += pr.dx * pr.spd * dt; pr.z += pr.dz * pr.spd * dt;
    if (pr.mon) { let hit = false; for (const p of alive) if (now >= p.prot && Math.hypot(p.x - pr.x, p.z - pr.z) < pr.r + .45) { hurtPlayer(p, pr.dmg, { kind: 'm', m: { type: 'flower' } }); hit = true; break; } if (hit || pr.life <= 0) projs.splice(i, 1); continue; }
    if (!owner) { projs.splice(i, 1); continue; }
    if (pr.kind === 'arrow' || pr.kind === 'warrow' || pr.kind === 'bind' || pr.kind === 'pulse') {
      const t = enemiesNear({ x: pr.x, z: pr.z, y: pr.y, id: -1, team: owner.team }, pr.r + .4, 3).find(t => !(t.kind === 'p' && (t.o.id === pr.by || sameTeam(owner, t.o))));
      if (t) { hitFx(owner, t, pr.dmg, pr.kb, { x: pr.x - pr.dx, z: pr.z - pr.dz }, pr.fx); if (pr.leech) { const os = stat(owner); owner.hp = Math.min(os.maxHp, owner.hp + pr.dmg * pr.leech); } if (pr.kind === 'bind' || pr.kind === 'pulse') ev({ k: 'fx', s: pr.kind, x: +pr.x.toFixed(1), z: +pr.z.toFixed(1) }); projs.splice(i, 1); continue; }
    } else if (pr.kind === 'cannon' || pr.kind === 'pierce') {
      for (const t of enemiesNear({ x: pr.x, z: pr.z, id: -1 }, pr.r + .6)) { if (t.kind === 'p' && t.o.id === pr.by) continue; const key = t.kind + t.o.id; if (pr.hit.has(key)) continue; pr.hit.add(key); hitFx(owner, t, pr.dmg, pr.kb || 1.5, { x: pr.x - pr.dx * 2, z: pr.z - pr.dz * 2 }, pr.fx); }
    } else {
      pr.tick -= dt;
      if (pr.tick <= 0) { pr.tick = .3; for (const t of enemiesNear({ x: pr.x, z: pr.z, id: -1 }, pr.r)) { if (t.kind === 'p' && t.o.id === pr.by) continue; hitTarget(owner, t, pr.dmg); if (t.kind === 'm' && t.o.type !== 'boss') { t.o.x += (pr.x - t.o.x) * .15; t.o.z += (pr.z - t.o.z) * .15; } } }
    }
    if (pr.life <= 0 || Math.hypot(pr.x, pr.z) > R + 4) projs.splice(i, 1);
  }
  // delayed strikes
  for (let i = pending.length - 1; i >= 0; i--) {
    const s = pending[i]; if (now < s.at) continue; pending.splice(i, 1);
    const owner = players.get(s.by); if (s.follow && owner) { s.x = owner.x; s.z = owner.z; }
    ev({ k: 'fx', s: s.look === 'rain' ? 'rain' : s.follow ? 'storm' : 'thunder', x: +s.x.toFixed(1), z: +s.z.toFixed(1), r: s.r });
    if (!owner || (s.follow && !owner.alive)) continue;
    for (const t of enemiesNear({ x: s.x, z: s.z, id: -1 }, s.r)) { if (t.kind === 'p' && t.o.id === s.by) continue; if (s.fx) hitFx(owner, t, s.dmg, 1, { x: s.x, z: s.z }, s.fx); else hitTarget(owner, t, s.dmg); }
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
const t0g = () => Date.now();
function sendSnap(rl) {
  const t = Date.now(); snapN++; const farTick = snapN % 5 === 0;
  const P = [...players.values()].filter(online).map(p => [p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.dir.toFixed(2), Math.ceil(p.hp), stat(p).maxHp, p.lv, (p.alive ? 1 : 0) | (t < p.prot && !p.shopUntil && p.gq == null ? 2 : 0) | (p.shopUntil ? 256 : 0) | (p.gq != null ? 512 : 0) | (t < (p.stunUntil || 0) || t < (p.rootUntil || 0) ? 1024 : 0) | (t < (p.slowUntil || 0) ? 2048 : 0) | (p.rush ? 4096 : 0) | (t < (p.stunUntil || 0) ? 8192 : 0) | (p.shieldT > 0 ? 4 : 0) | (p.dashT > 0 ? 8 : 0) | (king === p.id ? 16 : 0) | (p.task ? 32 : 0) | (blessed(p) ? 64 : 0) | (p.gm ? 128 : 0), p.wpn, p.arm, p.team, +(p.y || 0).toFixed(2), JOBK.indexOf(p.job || null)]);
  const M = [...mons.values()].map(m => [m.id, m.type, +m.x.toFixed(2), +m.z.toFixed(2), +m.dir.toFixed(2), Math.ceil(m.hp), m.max, FLYERS.has(m.type) ? 0 : +(m.y || 0).toFixed(2), m.lv || (MON[m.type] ? MON[m.type].lv : 20)]);
  const J = projs.map(p => [p.id, p.kind, +p.x.toFixed(2), +p.z.toFixed(2), +(p.y || 0).toFixed(1)]);
  const K = [...picks.values()].map(k => [k.id, k.kind, k.val, +k.x.toFixed(2), +k.z.toFixed(2), +(k.y || 0).toFixed(2)]);
  const base = { t: 's', tm: t, P, M, J, K, ev: evq.splice(0), zr: +zoneR().toFixed(2), ph: round.phase, q: COOP ? [quest.stage, quest.prog, questGoal()] : null, bs: boss ? [boss.id, Math.ceil(boss.hp), boss.max, boss.enr ? 1 : 0] : null, ch: chest ? [chest.x, chest.z, chest.y, t >= chest.landAt ? 1 : 0, chest.opener || 0, chest.opener ? Math.min(1, (t - chest.openAt) / (CHEST.open * 1000)) : 0, Math.max(0, Math.ceil(((t < chest.landAt ? chest.landAt : chest.expireAt) - t) / 1000))] : null, gt: gst.map(t => [t.id, t.active ? 2 : t.solver ? 1 : 0, t.active ? Math.ceil((t.active.until - t0g()) / 1000) : 0, t.active ? t.active.owner : t.solver, t.active ? +t.active.dir.toFixed(3) : 0, t.active ? t.active.team : -1]), left: round.phase === 'play' ? Math.max(0, Math.round((round.endsAt - t) / 1000)) : null };
  const rankOf = new Map(rl.map((p, i) => [p.id, i + 1]));
  for (const c of conns) {
    if (!c.open) continue;
    if (c.admin) { c.send({ ...base, M, MF: undefined, me: undefined }); continue; }
    const p = c.pid && players.get(c.pid); if (!p) continue;
    const near = [], far = farTick ? [] : null, seen = c.seenM || new Set(), nowSeen = new Set();
    for (const q of M) {
      const d2 = (q[2] - p.x) ** 2 + (q[3] - p.z) ** 2, r = seen.has(q[0]) ? VIEW_R + 6 : VIEW_R;   // 경계에서 깜빡이지 않게 6m 여유
      if (q[1] === 'boss' || d2 < r * r) { near.push(q); nowSeen.add(q[0]); } else if (far) far.push(Math.round(q[2]), Math.round(q[3]), q[1] === 'golem' || q[1] === 'boar' || q[1] === 'turtle' ? 1 : 0);
    }
    c.seenM = nowSeen; base.M = near; base.MF = far || undefined;
    const nowS = t / 1000, cds = {};
    for (const k in SKILLS) cds[k] = Math.max(0, +((p.cds[k] || 0) - nowS).toFixed(1));
    base.me = { xp: p.xp, need: xpNeed(p.lv), coins: p.coins, wpn: p.wpn, arm: p.arm, boot: p.boot, helm: p.helm, pot: p.pot, potCd: Math.max(0, Math.ceil((p.potAt - t) / 1000)), spdB: p.boot * 7, cdr: p.helm * 8, kills: p.kills, deaths: p.deaths, streak: p.streak, rank: p.gm ? '운영자' : rankOf.get(p.id), n: rl.length, gm: !!p.gm, job: p.job || null, cds, atk: stat(p).atk, def: Math.round(stat(p).def * 100), respawn: p.alive ? 0 : Math.max(0, Math.ceil((p.respawnAt - t) / 1000)), bounty: king === p.id ? bountyOf(p) : 0, safe: t - p.lastHurt > 4000, tcd: STN.map(s => Math.max(0, Math.ceil(((p.tcd[s.id] || 0) - t) / 1000))), team: p.team, tasks: p.tasks, parts: p.parts || 0, gcd: Math.max(0, Math.ceil(((p.gustCd || 0) - t) / 1000)), gq: p.gq != null ? 1 : 0, shop: p.shopUntil ? Math.max(0, Math.ceil((p.shopUntil - t) / 1000)) : 0, shopCd: Math.max(0, Math.ceil(((p.shopCdUntil || 0) - t) / 1000)), boost: xpBoost(p), catchUp: p.catchUp || 0, bless: blessed(p) ? Math.ceil((teamSt[p.team].buffUntil - t) / 1000) : 0 };
    c.send(base);
  }
}
function sendBoard(rl) {
  broadcast({ t: 'lb', king, teamsOn, teams: teamSt.map((s, i) => ({ pts: s.pts, lvups: s.lvups, tasks: s.tasks, kills: s.kills, score: teamScore(s), bless: Math.max(0, Math.ceil((s.buffUntil - Date.now()) / 1000)), goal: teamGoal(i), n: teamCount(i) })), list: [...rl, ...[...players.values()].filter(p => online(p) && p.gm)].map(p => [p.id, p.name, p.lv, p.coins, p.kills, p.deaths, p.best, p.wpn, p.arm, p.team, p.tasks, p.parts || 0, p.gm ? 1 : 0]) });
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
      if (old && locked && String(msg.code || '').trim() !== ADMIN_KEY && !old.gm) { players.delete(old.id); return c.send({ t: 'err', s: '지금은 아레나가 닫혀 있어요. 선생님이 열어 주면 들어올 수 있어요.' }); }
      if (old) { old.c = c; old.actAt = Date.now(); c.pid = old.id; old.offAt = 0; if (String(msg.code || '').trim() === ADMIN_KEY && !old.gm) applyGM(old); c.send({ t: 'welcome', id: old.id, name: old.name, tok, R, obs: OBS, skills: SKILLS, upg: UPG, gearN: GEARN, armN: ARMN, shop: SHOPX, pot: POT, mode: MODE, qst: COOP ? QSTAGES : null, shopR: SHOP_R, teams: TEAMS, teamsOn, structs: STRUCTS, shops: SHOPS, jobs: JOBS, jobLv: JOB_LV, jobCost: JOB_CHANGE, shrineR: SHRINE_R, gusts: GTS, gust: { r: GUST.r, len: GUST.len, w: GUST.w, push: GUST.push }, stations: STN, taskN: TASKN, taskR: TASK_R, ph: round.phase, resumed: true }); broadcast({ t: 'ro', joined: old.id, name: old.name }); return; }
      let name = cleanName(msg.name);
      if (!name) return c.send({ t: 'err', s: '이름을 적어 주세요.' });
      const code = String(msg.code || '').trim();
      if (locked && code !== ADMIN_KEY) return c.send({ t: 'err', s: '지금은 아레나가 닫혀 있어요. 선생님이 열어 주면 들어올 수 있어요.' });
      if (gate && code !== ADMIN_KEY && ![-1, 0, 1].some(d => clearCode(name, kstYmd(d), SALT) === code)) return c.send({ t: 'err', s: '입장 코드가 맞지 않아요. 옥정섬 SOS를 클리어한 화면의 이름과 코드를 그대로 적어 주세요.' });
      const same = [...players.values()].find(p => p.name === name && !online(p));
      if (same) players.delete(same.id);
      if ([...players.values()].some(p => p.name === name)) { let i = 2; while ([...players.values()].some(p => p.name === name + i)) i++; name = name + i; }
      if ([...players.values()].filter(online).length >= 40) return c.send({ t: 'err', s: '아레나가 가득 찼어요 (40명).' });
      const p = newPlayer(c, name); p.tok = crypto.randomBytes(8).toString('hex'); players.set(p.id, p); c.pid = p.id;
      if (code === ADMIN_KEY) applyGM(p); else catchUpStart(p);
      c.send({ t: 'welcome', id: p.id, name, tok: p.tok, R, obs: OBS, skills: SKILLS, upg: UPG, gearN: GEARN, armN: ARMN, shop: SHOPX, pot: POT, mode: MODE, qst: COOP ? QSTAGES : null, shopR: SHOP_R, teams: TEAMS, teamsOn, structs: STRUCTS, shops: SHOPS, jobs: JOBS, jobLv: JOB_LV, jobCost: JOB_CHANGE, shrineR: SHRINE_R, gusts: GTS, gust: { r: GUST.r, len: GUST.len, w: GUST.w, push: GUST.push }, stations: STN, taskN: TASKN, taskR: TASK_R, ph: round.phase });
      if (p.catchUp) tell(p, `🚀 <b>따라잡기 출발!</b> 친구들이 벌써 많이 컸어요. <b>Lv ${p.catchUp}</b>과 기본 장비로 시작해요. 레벨이 평균보다 낮으면 <b>경험치를 더 많이</b> 받아요!`);
      broadcast({ t: 'ro', joined: p.id, name });
      return;
    }
    if (msg.t === 'admin') {
      if (msg.key !== ADMIN_KEY) return c.send({ t: 'err', s: '관리자 비밀번호가 틀렸어요.' });
      c.admin = true; c.send({ t: 'adminok', R, obs: OBS, gate, locked, teamsOn, teams: TEAMS, stations: STN, structs: STRUCTS, shops: SHOPS, mode: MODE, ph: round.phase, addr: addresses() }); sendBoard(rankList());
      return;
    }
    if (c.admin && msg.t === 'cmd') return adminCmd(c, msg);
    const p = c.pid && players.get(c.pid); if (!p) return;
    p.lastIn = Date.now(); if (msg.t !== 'in' || msg.mx || msg.mz) p.actAt = p.lastIn;
    if (msg.t === 'in') { const mx = +msg.mx || 0, mz = +msg.mz || 0, l = Math.hypot(mx, mz); p.mx = l > 1 ? mx / l : mx; p.mz = l > 1 ? mz / l : mz; }
    else if (msg.t === 'sk') useSkill(p, String(msg.id));
    else if (msg.t === 'up') upgrade(p, msg.w === 'arm' ? 'arm' : 'wpn');
    else if (msg.t === 'shop') { if (msg.open) enterShop(p); else exitShop(p, 'close'); }
    else if (msg.t === 'buy') { if (msg.s === 'pot') buyPot(p); else if (SHOPX[msg.s]) buy(p, msg.s, msg.v); }
    else if (msg.t === 'pot') drinkPot(p);
    else if (msg.t === 'task') startTask(p);
    else if (msg.t === 'open') startOpen(p);
    else if (msg.t === 'gq') gustStart(p);
    else if (msg.t === 'gqa') gustAnswer(p, msg.a);
    else if (msg.t === 'gqd') { const t = p.gq != null && gst[p.gq]; if (t && t.solver === p.id && t.pickUntil) gustFire(t, p, +msg.d); }
    else if (msg.t === 'job') changeJob(p, String(msg.job));
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
    mons.clear(); projs.length = 0; picks.clear(); pending.length = 0; chest = null; chestT = 45; boss = null; bossStrikes.length = 0; bossCd = 0; if (COOP) questReset();
    round.phase = 'play'; round.len = min * 60; round.endsAt = Date.now() + min * 60000;
    broadcast({ t: 'round', s: `${min}분 결승 라운드 시작! 모두 Lv 1부터 다시 시작해요. 마지막에는 바람의 벽이 좁혀져요.` });
  } else if (msg.c === 'stop') { if (round.phase === 'play') endRound(); }
  else if (msg.c === 'free') { round.phase = 'free'; broadcast({ t: 'msg', s: '자유 대전 모드예요.' }); }
  else if (msg.c === 'reset') { boss = null; bossStrikes.length = 0; if (COOP) questReset(); for (const p of players.values()) resetPlayer(p); for (const t of teamSt) Object.assign(t, { pts: 0, lvups: 0, tasks: 0, kills: 0, buffUntil: 0 }); mons.clear(); picks.clear(); broadcast({ t: 'msg', s: '선생님이 모두의 기록을 초기화했어요.' }); }
  else if (msg.c === 'boss') { bossCd = 0; spawnBoss('teacher'); }
  else if (msg.c === 'chest') { if (chest) { broadcast({ t: 'chest', s: 'gone' }); chest = null; } dropChest('teacher'); }
  else if (msg.c === 'qreset') { questReset(); broadcast({ t: 'quest', s: 'reset', stage: 1, name: QSTAGES[1].n, desc: QSTAGES[1].d }); }
  else if (msg.c === 'qnext') { if (COOP && quest.stage < 4) questAdvance(); }
  else if (msg.c === 'shuffle') { shuffleTeams(); broadcast({ t: 'teams', teamsOn, mine: null, s: '선생님이 팀을 새로 나눴어요!' }); for (const p of players.values()) if (online(p)) p.c.send({ t: 'myteam', team: p.team }); }
  else if (msg.c === 'teams') { teamsOn = !!msg.on; broadcast({ t: 'teams', teamsOn, s: teamsOn ? '팀전이 켜졌어요! 같은 팀끼리는 공격되지 않아요.' : '팀전이 꺼졌어요. 이제 모두가 적이에요!' }); c.send({ t: 'adminok', R, obs: OBS, gate, locked, teamsOn, ph: round.phase, addr: addresses() }); }
  else if (msg.c === 'gate') { gate = !!msg.on; c.send({ t: 'adminok', R, obs: OBS, gate, locked, ph: round.phase, addr: addresses() }); }
  else if (msg.c === 'kick') { const p = players.get(+msg.id); if (p) bye(p, '선생님이 아레나에서 내보냈어요.'); }
  else if (msg.c === 'kickall') { let n = 0; for (const p of [...players.values()]) if (!p.gm) { bye(p, '수업이 끝났어요. 오늘도 수고했어요! 👋'); n++; } if (msg.lock) locked = true; c.send({ t: 'adminok', R, obs: OBS, gate, locked, ph: round.phase, addr: addresses(), kicked: n }); sendBoard(rankList()); }
  else if (msg.c === 'lock') { locked = !!msg.on; c.send({ t: 'adminok', R, obs: OBS, gate, locked, ph: round.phase, addr: addresses() }); }
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
