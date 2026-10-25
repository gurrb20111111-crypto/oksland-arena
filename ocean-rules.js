/* ===== 물빛섬 전력 관제실 (/ocean) — 게임 규칙·바다 시뮬레이션 =====
   ocean.js(서버)가 불러 씀. 화면과 상관없는 순수한 계산만 여기에 둠 → node로 바로 시험 가능.
   하루(24시간) = 실제 240초(1시간 = 10초). 수치는 수업용으로 단순화한 값. */
(function () {
'use strict';

const SEC_PER_H = (typeof process !== 'undefined' && process.env && +process.env.OCEAN_SEC_PER_H) || 10;   // 게임 1시간 = 실제 10초 (시험할 때만 환경 변수로 빠르게)
const SAMPLE_H = 0.5;                      // 그래프 점 간격(시간)
const ROLES = ['tidal', 'stream', 'wave', 'otec'];
const ROLE_NAME = { tidal: '조력', stream: '조류', wave: '파력', otec: '온도차·전력망' };

/* 장치 크기 */
const CAP = { tidal: 10, stream: 4, wave: 3, otecGross: 2.6, otecPump: 1.2, battMWh: 20, battMW: 8, dieselMax: 6, dieselMin: 2 };
const LAKE_MAX = 1.0;                      // 물빛호 수위가 이보다 높으면 둘레 마을 침수 위험
const STREAM_LIMIT = 3.1;                  // 물살이 이보다 빠르면 위험(브레이크)
const WAVE_ALARM = 4.2, WAVE_CLEAR = 3.8;  // 폭풍 경보 / 해제 파고
const GRACE_H = 0.45;                      // 경보 뒤 이 시간 안에 조치 안 하면 고장(약 4.5초)

/* 시간대별 섬 전력 수요(MW), 0시~23시 */
const DEMAND = {
  summer: [5.0, 4.6, 4.4, 4.3, 4.4, 4.8, 5.6, 6.6, 7.4, 8.0, 8.6, 9.2, 9.6, 10.0, 10.2, 10.0, 9.6, 9.2, 9.4, 9.6, 9.0, 7.8, 6.6, 5.6],
  winter: [6.0, 5.6, 5.4, 5.3, 5.4, 6.0, 7.0, 8.2, 8.6, 8.4, 8.0, 7.8, 7.6, 7.4, 7.4, 7.6, 8.2, 9.4, 10.4, 10.6, 10.0, 9.0, 7.8, 6.8],
  autumn: [4.4, 4.1, 3.9, 3.8, 3.9, 4.2, 4.9, 5.8, 6.4, 6.8, 7.2, 7.6, 7.8, 8.0, 8.1, 8.0, 7.8, 7.6, 7.9, 8.2, 7.7, 6.7, 5.7, 4.9]
};

/* 작전 3개 (모든 모둠이 같은 바다 → 기록을 견줄 수 있음) */
const ROUNDS = [
  { key: 'r1', title: '여름 사리날', sub: '7월 · 사리(밀물·썰물 차가 가장 큰 날)', season: 'summer', hour0: 6,
    tideA: 2.4, vmax: 3.0, lowAt: 7.0, waveBase: 1.4, storm: null, ts: 27, lake0: 0, batt0: 0.85, fuel: 34,
    target: 0.75, extra: null,
    faults: [{ p: 'stream', at: 4.5 }, { p: 'tidal', at: 10.5 }, { p: 'otec', at: 15 }, { p: 'wave', at: 19.5 }],
    brief: '여름 사리날이에요. 밀물·썰물 차가 크고 물살도 빨라요. 네 발전소가 모두 일할 수 있는 날! 바다 에너지로 섬 전기의 75% 이상을 만들어 봐요.' },
  { key: 'r2', title: '겨울 폭풍 밤', sub: '1월 · 낮 12시부터 다음 날 낮 12시까지', season: 'winter', hour0: 12,
    tideA: 1.8, vmax: 2.4, lowAt: 13.5, waveBase: 2.3, storm: { at: 8.5, w: 2.4, peak: 3.6, cur: 0.9 }, ts: 9, lake0: 0.3, batt0: 0.55, fuel: 62,
    target: 0.6, extra: null,
    faults: [{ p: 'tidal', at: 3 }, { p: 'stream', at: 15.5 }, { p: 'wave', at: 19 }],
    brief: '겨울이라 파도는 세지만 표층 바닷물이 차가워요. 저녁엔 난방 때문에 전기를 많이 써요. 밤에 폭풍이 온다는 예보! 바다 에너지 60% 이상, 정전 없이 버텨요.' },
  { key: 'r3', title: '조금날 · 여객선 결항', sub: '9월 · 조금(밀물·썰물 차가 가장 작은 날)', season: 'autumn', hour0: 6,
    tideA: 1.15, vmax: 1.5, lowAt: 9.0, waveBase: 1.7, storm: null, ts: 24, lake0: -0.2, batt0: 0.7, fuel: 74,
    target: 0.5, extra: { from: 14, to: 17, mw: 1.5, label: '보건소 응급 수술' },
    faults: [{ p: 'wave', at: 3.5 }, { p: 'otec', at: 9 }, { p: 'tidal', at: 16 }, { p: 'stream', at: 21 }],
    brief: '조금날이라 밀물·썰물 차가 작아요. 여객선이 못 와서 디젤 연료도 넉넉하지 않아요. 오후엔 보건소 응급 수술이 있어요! 디젤을 꼭 필요할 때만 켜서 정전 없이, 바다 에너지 50% 이상!' }
];

const FAULT = {
  tidal: '수문 앞에 떠밀려 온 쓰레기가 걸렸어요',
  stream: '날개에 따개비가 잔뜩 붙었어요',
  wave: '소금기 때문에 공기 밸브가 녹슬었어요',
  otec: '냉수관 입구에 해파리 떼가 몰렸어요'
};
const FIX_TAPS = 6;

/* 작전 뒤 회의 퀴즈: 역할마다 작전별 1문제 (a = 정답 번호) */
const QUIZ = {
  tidal: [
    { q: '조력발전에서 전기를 많이 만들려면 무엇이 커야 할까요?', o: ['바다와 물빛호의 높이 차(낙차)', '파도의 높이', '바닷물의 온도 차', '바람의 세기'], a: 0, why: '물이 높은 곳에서 낮은 곳으로 떨어지는 높이 차가 클수록 터빈이 세게 돌아요.' },
    { q: '물빛섬 조력발전소(창조식)는 언제 전기를 만드나요?', o: ['썰물 때 호수 물이 바다로 나갈 때', '밀물 때 바닷물이 호수로 들어올 때', '하루 종일 똑같이', '비가 올 때만'], a: 1, why: '시화호처럼 밀물 때 바다가 호수보다 높아지면 그 물이 터빈을 지나 들어오며 발전해요. 썰물 땐 수문으로 물을 빼 두어요.' },
    { q: '조금날 조력발전이 줄어든 까닭은?', o: ['바닷물이 차가워서', '밀물·썰물 높이 차가 작아서', '바람이 불지 않아서', '물빛호가 말라서'], a: 1, why: '조금날은 달과 해가 끌어당기는 힘이 엇갈려 밀물·썰물 차가 작아요. 낙차가 작으니 전기도 적어요.' }
  ],
  stream: [
    { q: '조류 발전기를 세우기 가장 좋은 곳은?', o: ['넓고 잔잔한 바다', '물살이 빠른 좁은 물길', '깊이 1,000 m 바다 밑', '호숫가'], a: 1, why: '울돌목처럼 좁은 물길에선 물살이 빨라져요. 물살이 빠를수록 출력이 크게 늘어요.' },
    { q: '물살 속도가 2배가 되면 조류 발전 출력은 대략 몇 배?', o: ['2배', '4배', '8배', '그대로'], a: 2, why: '출력은 속도의 세제곱에 비례해요. 2 × 2 × 2 = 8배!' },
    { q: '조류 발전이 하루에 네 번쯤 멈추는 까닭은?', o: ['물고기가 지나가서', '물 흐름이 바뀌는 정조 때 물살이 거의 없어서', '밤이 되어서', '배터리가 가득 차서'], a: 1, why: '밀물에서 썰물로(또는 반대로) 바뀌는 순간엔 물살이 멈춰요. 하루에 밀물·썰물이 두 번씩이라 네 번쯤 멈춰요.' }
  ],
  wave: [
    { q: '진동수주형 파력발전에서 터빈을 돌리는 것은?', o: ['바닷물이 직접', '물기둥이 오르내리며 밀고 당기는 공기', '햇빛', '바닷물 속 소금'], a: 1, why: '파도에 물기둥이 오르내리면 방 안 공기가 압축·팽창하며 드나들어요. 그 공기가 터빈을 돌려요.' },
    { q: '폭풍 때 안전 밸브를 연 까닭은?', o: ['전기를 더 많이 만들려고', '너무 센 공기 흐름에서 터빈을 지키려고', '물고기를 들여보내려고', '파도를 더 크게 만들려고'], a: 1, why: '파도가 너무 높으면 공기 흐름이 지나치게 세져 터빈이 망가질 수 있어요. 밸브로 공기를 빼서 지켜요.' },
    { q: '웰스 터빈의 좋은 점은?', o: ['공기가 들어올 때도 나갈 때도 같은 방향으로 돈다', '바람이 없어도 돈다', '물속에서만 돈다', '전기를 쓰지 않아도 빛이 난다'], a: 0, why: '공기가 드나드는 방향이 계속 바뀌어도 한 방향으로 돌아서 낭비 없이 전기를 만들어요.' }
  ],
  otec: [
    { q: '해수 온도차 발전에 암모니아를 쓰는 까닭은?', o: ['따뜻한 표층 바닷물로도 끓어서', '바닷물보다 무거워서', '불이 잘 붙어서', '색이 예뻐서'], a: 0, why: '암모니아는 약 −33 ℃에서 끓어요. 25 ℃ 바닷물로도 끓어 가스가 되어 터빈을 돌려요.' },
    { q: '겨울 밤에 온도차 발전기를 끈 까닭은?', o: ['고장이 나서', '표층 바닷물이 차가워 깊은 바닷물과 온도 차가 작아서', '밤이라 어두워서', '파도가 높아서'], a: 1, why: '온도 차가 약 20 ℃ 이상이어야 해요. 겨울엔 차이가 작아 펌프 전기가 더 들어서 오히려 손해예요.' },
    { q: '디젤 발전기를 꼭 필요할 때만 켜야 하는 까닭은?', o: ['소리가 커서', '연료가 한정되고, 켜 두면 최소 출력만큼 연료를 계속 써서', '바다 에너지가 더 비싸서', '디젤은 밤에만 돌아서'], a: 1, why: '섬은 배로 연료를 실어 와요. 켜 두기만 해도 연료가 줄고 온실가스가 나와요. 바다 에너지와 배터리로 먼저 버텨요.' }
  ]
};

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;

/* ---------- 바다 상태 (시각 함수) ---------- */
function clockOf(R, h) { return (R.hour0 + h) % 24; }
function seaAt(R, h) { const c = R.hour0 + h; return -R.tideA * Math.cos(2 * Math.PI * (c - R.lowAt) / 12.42); }
function stormF(R, h) { if (!R.storm) return 0; const x = (h - R.storm.at) / R.storm.w; return Math.exp(-x * x); }
function currentAt(R, h) {   // + = 밀물(바다 → 섬 안쪽), − = 썰물
  const c = R.hour0 + h; let v = R.vmax * Math.sin(2 * Math.PI * (c - R.lowAt) / 12.42);
  if (R.storm) v += Math.sign(v) * R.storm.cur * stormF(R, h);
  return v;
}
function waveAt(R, h) { return Math.max(0.3, R.waveBase + 0.35 * Math.sin(2 * Math.PI * h / 5.3) + 0.2 * Math.sin(2 * Math.PI * h / 2.1 + 1) + (R.storm ? R.storm.peak * stormF(R, h) : 0)); }
function surfaceTemp(R, h) { const c = clockOf(R, h); return R.ts + 0.6 * Math.sin(2 * Math.PI * (c - 9) / 24); }
function demandAt(R, h) {
  const c = clockOf(R, h), a = DEMAND[R.season], i = Math.floor(c), f = c - i;
  let d = a[i] * (1 - f) + a[(i + 1) % 24] * f;
  if (R.extra && c >= R.extra.from && c < R.extra.to) d += R.extra.mw;
  return d;
}

/* ---------- 모둠 ---------- */
function newTeam(id, name) {
  return { id, name, members: [], phase: 'lobby', round: 0, started: false, t0: 0, tEnd: 0,
    setup: { stream: '', wave: '', otec: '' }, ready: {}, sim: null, results: [], quiz: null, clear: false, ver: 0 };
}
function memberOf(T, id) { return T.members.find(m => m.id === id); }
function join(T, p) {
  let m = memberOf(T, p.id);
  if (!m) { m = { id: p.id, name: p.name, roles: [], on: true, offAt: 0 }; T.members.push(m); }
  m.on = true; m.offAt = 0; m.name = p.name;
  if (T.started) fillRoles(T);
  return m;
}
function onlineMembers(T) { return T.members.filter(m => m.on); }
function holders(T, role) { return T.members.filter(m => m.roles.includes(role)); }
function canCtl(T, id, role) { const m = memberOf(T, id); return !!m && m.roles.includes(role); }
function pickRole(T, id, role) {
  if (!ROLES.includes(role)) return { err: '없는 역할이에요.' };
  const m = memberOf(T, id); if (!m) return { err: '모둠에 없어요.' };
  if (T.phase !== 'lobby') return { err: '역할은 출발 전에만 고를 수 있어요.' };
  if (m.roles[0] === role) { m.roles = []; return { ev: [] }; }
  m.roles = [role];
  return { ev: [] };
}
/* 빈 역할은 접속 중인 친구 가운데 역할이 가장 적은 사람에게. 끊긴 지 오래된 친구의 역할도 넘김 */
function fillRoles(T, now) {
  const on = onlineMembers(T); if (!on.length) return false;
  let changed = false;
  if (now) for (const m of T.members) if (!m.on && m.offAt && now - m.offAt > 90000 && m.roles.length) {
    for (const r of m.roles) if (!holders(T, r).some(x => x.on && x !== m)) { const tgt = on.slice().sort((a, b) => a.roles.length - b.roles.length)[0]; tgt.roles.push(r); }
    m.roles = []; changed = true;
  }
  for (const r of ROLES) if (!holders(T, r).length) { const tgt = on.slice().sort((a, b) => a.roles.length - b.roles.length)[0]; tgt.roles.push(r); changed = true; }
  for (const m of on) if (!m.roles.length) {   // 5번째 친구부터는 도우미(같은 장치를 같이 운전)
    const cnt = ROLES.map(r => [r, holders(T, r).length]).sort((a, b) => a[1] - b[1]);
    m.roles.push(cnt[0][0]); changed = true;
  }
  return changed;
}

function start(T, now) {
  if (T.started) return [];
  T.started = true; T.t0 = now; fillRoles(T);
  return enterBrief(T, 0);
}
function enterBrief(T, round) {
  T.round = round; T.phase = 'brief'; T.ready = {}; T.sim = null; T.quiz = null;
  if (round === 0) T.setup = { stream: '', wave: '', otec: '' };
  T.ver++;
  return [{ k: 'brief', r: round }];
}
function onSetup(T, id, key, val) {
  if (T.phase !== 'brief') return { err: '지금은 장비를 바꿀 수 없어요.' };
  const OPT = { stream: ['one', 'bi'], wave: ['plain', 'wells'], otec: ['water', 'nh3'] };
  if (!OPT[key] || !OPT[key].includes(val)) return { err: '없는 장비예요.' };
  if (!canCtl(T, id, key)) return { err: ROLE_NAME[key] + ' 담당이 고를 수 있어요.' };
  T.setup[key] = val; T.ver++;
  return { ev: [{ k: 'setup', key, val, by: id }] };
}
function setupMissing(T) { return ['stream', 'wave', 'otec'].filter(k => !T.setup[k]); }
function onReady(T, id, now) {
  if (T.phase !== 'brief') return { ev: [] };
  T.ready[id] = !T.ready[id]; T.ver++;
  const on = onlineMembers(T);
  if (on.length && on.every(m => T.ready[m.id]) && !setupMissing(T).length) return { ev: beginRun(T, now) };
  return { ev: [] };
}
function beginRun(T, now) {
  const R = ROUNDS[T.round];
  for (const k of setupMissing(T)) T.setup[k] = k === 'stream' ? 'one' : k === 'wave' ? 'plain' : 'nh3';
  T.phase = 'run'; T.ver++;
  T.sim = { h: 0, last: now, lake: R.lake0, batt: R.batt0 * CAP.battMWh, fuel: R.fuel, batt0: R.batt0 * CAP.battMWh,
    tidal: { mode: 'close', lock: 0 }, stream: { facing: 1, turning: 0, brake: false, alarm: 0, broken: 0 },
    wave: { valve: false, alarm: 0, broken: 0 }, otec: { pump: 0 }, diesel: { on: false, warm: 0 },
    fault: {}, faultsDone: 0, out: { tidal: 0, stream: 0, wave: 0, otec: 0, diesel: 0, batt: 0, unmet: 0, curtail: 0, demand: 0 },
    acc: { demand: 0, unmet: 0, diesel: 0, curtail: 0, gen: { tidal: 0, stream: 0, wave: 0, otec: 0 } },
    hist: [], nextSample: 0, blackout: false, blackMin: 0, accidents: [], fuelWarn: false, actions: 0 };
  T.sim.out.demand = demandAt(R, 0);
  sample(T, R);
  return [{ k: 'run', r: T.round }];
}

/* ---------- 조작 ---------- */
function onCtl(T, id, dev, val) {
  if (T.phase !== 'run') return { err: '작전 중에만 조작할 수 있어요.' };
  const S = T.sim, R = ROUNDS[T.round], ev = [];
  const role = dev === 'diesel' ? 'otec' : dev;
  if (!canCtl(T, id, role)) return { err: ROLE_NAME[role] + ' 담당이 조작해요.' };
  S.actions++;
  if (dev === 'tidal') {
    if (!['close', 'turbine', 'gate'].includes(val)) return { err: '?' };
    if (S.tidal.lock > 0 && val !== 'close') return { err: '침수 위험 점검 중이에요. 잠깐만 기다려요.' };
    S.tidal.mode = val;
  } else if (dev === 'stream') {
    if (val === 'turn') { if (T.setup.stream === 'bi') return { err: '양방향 터빈은 돌릴 필요가 없어요.' }; if (S.stream.turning > 0) return { ev: [] }; S.stream.turning = 0.3; S.stream.facing *= -1; }
    else if (val === 'brake') S.stream.brake = true;
    else if (val === 'release') { if (Math.abs(currentAt(R, S.h)) > STREAM_LIMIT) return { err: '아직 물살이 너무 빨라요!' }; S.stream.brake = false; }
    else return { err: '?' };
  } else if (dev === 'wave') {
    if (val === 'open') S.wave.valve = true;
    else if (val === 'close') { if (waveAt(R, S.h) > WAVE_ALARM) return { err: '아직 파도가 너무 높아요!' }; S.wave.valve = false; }
    else return { err: '?' };
  } else if (dev === 'otec') {
    const p = clamp(Math.round(+val * 20) / 20, 0, 1); if (!Number.isFinite(p)) return { err: '?' };
    S.otec.pump = p;
  } else if (dev === 'diesel') {
    if (val === 'on') { if (S.fuel <= 0) return { err: '연료가 없어요.' }; if (!S.diesel.on) { S.diesel.on = true; S.diesel.warm = 0.5; ev.push({ k: 'diesel', on: 1 }); } }
    else if (val === 'off') { if (S.diesel.on) { S.diesel.on = false; S.diesel.warm = 0; ev.push({ k: 'diesel', on: 0 }); } }
    else return { err: '?' };
  } else return { err: '?' };
  T.ver++;
  return { ev };
}
function onFix(T, id, dev) {
  if (T.phase !== 'run') return { ev: [] };
  const S = T.sim, f = S.fault[dev];
  if (!canCtl(T, id, dev)) return { err: ROLE_NAME[dev] + ' 담당이 고쳐요.' };
  const broken = (dev === 'stream' && S.stream.broken > 0) || (dev === 'wave' && S.wave.broken > 0);
  if (broken) { const o = S[dev]; o.broken = Math.max(0, o.broken - 0.22); T.ver++; return { ev: o.broken === 0 ? [{ k: 'repaired', p: dev }] : [] }; }
  if (!f) return { ev: [] };
  f.got++; T.ver++;
  if (f.got >= FIX_TAPS) { delete S.fault[dev]; S.faultsDone++; return { ev: [{ k: 'fixed', p: dev }] }; }
  return { ev: [] };
}

/* ---------- 시뮬레이션 한 걸음 ---------- */
function plantPower(T, R, S, h, dt, ev) {
  const P = { tidal: 0, stream: 0, wave: 0, otec: 0 };
  // 조력 (창조식: 바다가 호수보다 높을 때 터빈으로 들여보내며 발전)
  const sea = seaAt(R, h), head = sea - S.lake;
  if (S.tidal.lock > 0) { S.tidal.lock = Math.max(0, S.tidal.lock - dt); S.tidal.mode = 'close'; }
  if (S.tidal.mode === 'turbine' && head > 0.2) {
    P.tidal = CAP.tidal * Math.min(1, Math.pow(head / 2.5, 1.5));
    S.lake += 0.28 * Math.sqrt(head) * dt;
  } else if (S.tidal.mode === 'gate') {
    S.lake += (sea - S.lake) * Math.min(1, 1.2 * dt);
  }
  if (S.lake > LAKE_MAX) {
    S.lake = LAKE_MAX - 0.02; S.tidal.mode = 'close'; S.tidal.lock = 1;
    S.accidents.push({ p: 'tidal', h, s: '물빛호가 넘칠 뻔해서 수문을 1시간 잠갔어요' });
    ev.push({ k: 'acc', p: 'tidal' });
  }
  // 조류 (출력 ∝ 속도³, 한 방향 터빈은 물살 방향에 맞춰 돌려야 함)
  const v = currentAt(R, h), sp = Math.abs(v);
  if (S.stream.turning > 0) S.stream.turning = Math.max(0, S.stream.turning - dt);
  if (sp > STREAM_LIMIT && !S.stream.brake && !S.stream.broken) {
    if (!S.stream.alarm) { S.stream.alarm = GRACE_H; ev.push({ k: 'alarm', p: 'stream' }); }
    else { S.stream.alarm -= dt; if (S.stream.alarm <= 0) { S.stream.alarm = 0; S.stream.broken = 1; S.accidents.push({ p: 'stream', h, s: '너무 빠른 물살에 날개가 상했어요' }); ev.push({ k: 'acc', p: 'stream' }); } }
  } else if (S.stream.alarm && (S.stream.brake || sp <= STREAM_LIMIT)) S.stream.alarm = 0;
  const aligned = T.setup.stream === 'bi' || Math.sign(v) === S.stream.facing;
  if (!S.stream.brake && !S.stream.broken && !S.stream.turning && aligned && sp >= 0.6)
    P.stream = CAP.stream * Math.min(1, Math.pow(sp / 2.5, 3)) * (T.setup.stream === 'bi' ? 0.95 : 1);
  // 파력 (진동수주형: 출력 ∝ 파고², 웰스 터빈은 공기가 드나들 때 모두 돎)
  const H = waveAt(R, h);
  if (H > WAVE_ALARM && !S.wave.valve && !S.wave.broken) {
    if (!S.wave.alarm) { S.wave.alarm = GRACE_H; ev.push({ k: 'alarm', p: 'wave' }); }
    else { S.wave.alarm -= dt; if (S.wave.alarm <= 0) { S.wave.alarm = 0; S.wave.broken = 1; S.accidents.push({ p: 'wave', h, s: '폭풍 파도의 센 공기에 터빈이 상했어요' }); ev.push({ k: 'acc', p: 'wave' }); } }
  } else if (S.wave.alarm && (S.wave.valve || H <= WAVE_ALARM)) S.wave.alarm = 0;
  if (!S.wave.valve && !S.wave.broken) P.wave = CAP.wave * Math.min(1, Math.pow(H / 3, 2)) * (T.setup.wave === 'wells' ? 1 : 0.5);
  // 온도차 (암모니아만 끓음, 펌프 전기는 빼야 함)
  const dT = surfaceTemp(R, h) - 5, f = clamp((dT - 12) / 10, 0, 1.2), p = S.otec.pump;
  const gross = T.setup.otec === 'nh3' ? CAP.otecGross * f * (1 - Math.exp(-3 * p)) : 0;
  P.otec = gross - CAP.otecPump * p * p;
  // 고장: 고칠 때까지 40%만
  for (const k of ROLES) if (S.fault[k] && P[k] > 0) P[k] *= 0.4;
  return P;
}
function stepSim(T, dt) {
  const R = ROUNDS[T.round], S = T.sim, ev = [];
  const h = S.h + dt / 2;
  for (const F of R.faults) if (S.h < F.at && S.h + dt >= F.at && !S.fault[F.p]) { S.fault[F.p] = { got: 0, need: FIX_TAPS }; ev.push({ k: 'fault', p: F.p }); }
  const P = plantPower(T, R, S, h, dt, ev);
  const demand = demandAt(R, h), ocean = P.tidal + P.stream + P.wave + P.otec;
  // 디젤: 켜 두면 최소 2 MW, 부족한 만큼 최대 6 MW까지 (켜고 0.5시간 예열)
  let diesel = 0;
  if (S.diesel.on) {
    if (S.diesel.warm > 0) { S.diesel.warm = Math.max(0, S.diesel.warm - dt); if (S.diesel.warm === 0) ev.push({ k: 'dieselReady' }); }
    else diesel = clamp(demand - ocean, CAP.dieselMin, CAP.dieselMax);
    if (diesel * dt > S.fuel) { diesel = S.fuel / dt; }
    S.fuel = Math.max(0, S.fuel - diesel * dt);
    if (S.fuel <= 0 && S.diesel.on) { S.diesel.on = false; ev.push({ k: 'fuelOut' }); }
  }
  if (!S.fuelWarn && S.fuel < R.fuel * 0.2) { S.fuelWarn = true; ev.push({ k: 'fuelLow' }); }
  let net = ocean + diesel - demand, batt = 0, unmet = 0, curtail = 0;
  if (net >= 0) { const c = Math.min(net, CAP.battMW, (CAP.battMWh - S.batt) / dt); batt = c; S.batt += c * dt; curtail = net - c; }
  else { const d = Math.min(-net, CAP.battMW, S.batt / dt); batt = -d; S.batt -= d * dt; unmet = -net - d; }
  S.batt = clamp(S.batt, 0, CAP.battMWh);
  const black = unmet > 0.05;
  if (black && !S.blackout) ev.push({ k: 'black', on: 1 }); else if (!black && S.blackout) ev.push({ k: 'black', on: 0 });
  S.blackout = black; if (black) S.blackMin += dt * 60;
  S.out = { tidal: P.tidal, stream: P.stream, wave: P.wave, otec: P.otec, diesel, batt, unmet, curtail, demand };
  S.acc.demand += demand * dt; S.acc.unmet += unmet * dt; S.acc.diesel += diesel * dt; S.acc.curtail += curtail * dt;
  for (const k of ROLES) S.acc.gen[k] += P[k] * dt;
  S.h += dt;
  while (S.h >= S.nextSample - 1e-9 && S.nextSample <= 24) sample(T, R);
  return ev;
}
function sample(T, R) {
  const S = T.sim, o = S.out;
  S.hist.push([r1(S.nextSample), r2(o.demand), r2(o.tidal), r2(o.stream), r2(o.wave), r2(o.otec), r2(o.diesel), Math.round(S.batt / CAP.battMWh * 100), r2(o.unmet)]);
  S.lastSample = S.hist[S.hist.length - 1];
  S.nextSample = r1(S.nextSample + SAMPLE_H);
}
function tick(T, now) {
  const ev = [];
  if (T.phase !== 'run' || !T.sim) return ev;
  const S = T.sim;
  if (!onlineMembers(T).length) { S.last = now; return ev; }   // 모두 나가면 멈춤
  let dt = Math.min(5, (now - S.last) / 1000) / SEC_PER_H; S.last = now;
  while (dt > 1e-6 && S.h < 24) { const d = Math.min(0.05, dt, 24 - S.h); ev.push(...stepSim(T, d)); dt -= d; }
  if (S.h >= 24 - 1e-6) ev.push(...endRun(T, now));
  return ev;
}
function endRun(T, now) {
  const R = ROUNDS[T.round], S = T.sim, A = S.acc;
  const served = A.demand - A.unmet, battDrop = Math.max(0, S.batt0 - S.batt);
  const share = A.demand ? clamp((served - A.diesel - battDrop) / A.demand, 0, 1) : 0;
  const res = { r: T.round, share: r2(share), blackMin: Math.round(S.blackMin), diesel: r1(A.diesel), fuelLeft: r1(S.fuel), curtail: r1(A.curtail), demand: r1(A.demand),
    gen: Object.fromEntries(ROLES.map(k => [k, r1(A.gen[k])])), accidents: S.accidents.map(a => a.s), faultsDone: S.faultsDone, hist: S.hist,
    star: [S.blackMin < 1, share >= R.target, false], target: R.target };
  T.results[T.round] = res;
  T.phase = 'quiz'; T.ver++;
  // 회의 퀴즈: 접속한 친구마다 자기 역할 문제 1개 (역할이 겹치면 다른 역할 문제)
  const used = new Set(); T.quiz = { ask: {}, ans: {}, first: {} };
  for (const m of onlineMembers(T)) {
    let role = m.roles.find(r => !used.has(r)) || m.roles[0] || ROLES.find(r => !used.has(r)) || 'tidal';
    used.add(role); T.quiz.ask[m.id] = role;
  }
  return [{ k: 'end', r: T.round }];
}
function onQuiz(T, id, a) {
  if (T.phase !== 'quiz' || !T.quiz) return { ev: [] };
  const role = T.quiz.ask[id]; if (!role) { T.quiz.ask[id] = 'tidal'; }
  const Q = QUIZ[T.quiz.ask[id]][T.round];
  if (T.quiz.ans[id] && T.quiz.ans[id].ok) return { ev: [] };
  const ok = (a | 0) === Q.a;
  if (!(id in T.quiz.first)) T.quiz.first[id] = ok;
  T.quiz.ans[id] = { a: a | 0, ok }; T.ver++;
  const ev = [{ k: 'qa', by: id, ok }];
  const ids = Object.keys(T.quiz.ask).map(Number);
  if (ids.every(i => T.quiz.ans[i] && T.quiz.ans[i].ok)) {
    const res = T.results[T.round]; res.star[2] = ids.every(i => T.quiz.first[i]);
    res.quiz = ids.map(i => ({ id: i, role: T.quiz.ask[i], first: T.quiz.first[i] }));
    T.phase = 'result'; T.ver++; ev.push({ k: 'result', r: T.round });
  }
  return { ev };
}
function onNext(T, now) {
  if (T.phase !== 'result') return [];
  if (T.round < ROUNDS.length - 1) return enterBrief(T, T.round + 1);
  T.phase = 'clear'; T.clear = true; T.tEnd = now; T.ver++;
  return [{ k: 'clear' }];
}
/* 관리자: 지금 단계를 넘기기 */
function skip(T, now) {
  if (!T.started) return start(T, now);
  if (T.phase === 'brief') return beginRun(T, now);
  if (T.phase === 'run') { while (T.sim.h < 24) stepSim(T, Math.min(0.05, 24 - T.sim.h)); return endRun(T, now); }
  if (T.phase === 'quiz') { const res = T.results[T.round]; res.quiz = []; T.phase = 'result'; T.ver++; return [{ k: 'result', r: T.round }]; }
  if (T.phase === 'result') return onNext(T, now);
  return [];
}
function stars(T) { return T.results.reduce((a, r) => a + (r ? r.star.filter(Boolean).length : 0), 0); }

/* ---------- 화면에 보낼 상태 (작게) ---------- */
function liveView(T) {
  const S = T.sim; if (!S) return null;
  const R = ROUNDS[T.round], h = S.h, o = S.out;
  return { h: r2(h), clock: r2(clockOf(R, h)), sea: r2(seaAt(R, h)), lake: r2(S.lake), cur: r2(currentAt(R, h)), wave: r2(waveAt(R, h)), ts: r1(surfaceTemp(R, h)),
    batt: r1(S.batt), fuel: r1(S.fuel), out: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)])),
    tidal: { mode: S.tidal.mode, lock: S.tidal.lock > 0 ? 1 : 0 }, stream: { facing: S.stream.facing, turning: S.stream.turning > 0 ? 1 : 0, brake: S.stream.brake ? 1 : 0, alarm: S.stream.alarm > 0 ? 1 : 0, broken: S.stream.broken > 0 ? r2(S.stream.broken) : 0 },
    wave: { valve: S.wave.valve ? 1 : 0, alarm: S.wave.alarm > 0 ? 1 : 0, broken: S.wave.broken > 0 ? r2(S.wave.broken) : 0 }, otec: { pump: S.otec.pump },
    diesel: { on: S.diesel.on ? 1 : 0, warm: S.diesel.warm > 0 ? 1 : 0 }, fault: Object.fromEntries(Object.entries(S.fault).map(([k, f]) => [k, f.got])),
    black: S.blackout ? 1 : 0, blackMin: Math.round(S.blackMin), share: r2(liveShare(T)), acc: S.accidents.length };
}
function liveShare(T) {
  const S = T.sim, A = S.acc; if (!A.demand) return 0;
  return clamp((A.demand - A.unmet - A.diesel - Math.max(0, S.batt0 - S.batt)) / A.demand, 0, 1);
}
function view(T, withHist) {
  const v = { id: T.id, name: T.name, phase: T.phase, round: T.round, started: T.started, t0: T.t0, tEnd: T.tEnd, clear: T.clear, setup: T.setup, ready: T.ready,
    members: T.members.map(m => ({ id: m.id, name: m.name, roles: m.roles, on: m.on })), stars: stars(T),
    results: T.results.map(r => r && Object.assign({}, r, { hist: withHist ? r.hist : undefined })),
    quiz: T.quiz ? { ask: T.quiz.ask, ans: T.quiz.ans } : null, live: T.phase === 'run' ? liveView(T) : null };
  if (withHist && T.sim) v.hist = T.sim.hist;
  return v;
}

const API = { SEC_PER_H, ROLES, ROLE_NAME, ROUNDS, CAP, QUIZ, FAULT, FIX_TAPS, LAKE_MAX, STREAM_LIMIT, WAVE_ALARM, WAVE_CLEAR, STAR_MAX: ROUNDS.length * 3,
  seaAt, currentAt, waveAt, surfaceTemp, demandAt, clockOf,
  DEMAND, newTeam, memberOf, join, pickRole, fillRoles, start, onSetup, onReady, onCtl, onFix, onQuiz, onNext, skip, tick, stepSim, beginRun, endRun, view, liveView, stars, onlineMembers };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else window.OceanRules = API;   // 학생 화면도 같은 계산(예보 그래프)을 씀
})();
