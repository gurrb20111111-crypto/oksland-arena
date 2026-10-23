/* ===== 지열 정비대 — 공유 임무 규칙 =====
   서버(oksland-arena/geo-rules.js로 복사)와 브라우저 '혼자 연습' 모드가 똑같이 씀.
   네트워크·화면 코드는 없음. 팀 상태를 바꾸고 보낼 알림(events) 목록만 돌려줌. */
(function (root) {
  'use strict';
  const ROLES = [
    { id: 'drill', name: '굴착 기사', ic: '⛏', col: '#F2A922', job: '드릴로 단단한 화강암·뜨거운 암반을 뚫어요. 드릴이 너무 뜨거워지면 잠깐 멈춰요.' },
    { id: 'geo', name: '지질 조사원', ic: '🔬', col: '#43B0E8', job: '스캐너로 바위 너머를 꿰뚫어 봐요. 고장 난 곳·광물·마그마 위치와 바위 온도를 혼자만 볼 수 있어요.' },
    { id: 'pipe', name: '배관 기사', ic: '🔧', col: '#F0643C', job: '새는 관을 막고, 막힌 관(스케일)을 청소해요. 지질 조사원이 찾아 준 곳으로 가야 해요.' },
    { id: 'safe', name: '안전 관리자', ic: '🦺', col: '#5FC95C', job: '작업등·환풍기를 설치하고 냉각기로 팀원과 드릴을 식혀요. 눈에 안 보이는 유독 가스를 혼자 볼 수 있어요.' }
  ];
  const RID = ROLES.map(r => r.id);
  const LV_SIZE = [40, 32, 40], LIFT = { x: 20, z: 20, r: 1.7 }, LAND_Y = 20;
  const DEPTH = [0, 400, 1000, 2000, 3000];
  const tempAt = depthM => 15 + 0.06 * depthM;           // 불씨섬(화산 지대) 지온 경사: 1 km마다 약 60 ℃
  const depthAt = (lv, y) => lv ? Math.round(DEPTH[lv] + (LAND_Y - y)) : 0;
  /* 막힌 승강기 통로(무너진 돌): 승강기 아래 수직 통로에 쌓인 덩어리. 덩어리 근처를 파면 치운 것으로 셈 */
  const plug = (n, y0 = 18.6) => Array.from({ length: n }, (_, i) => ({ x: LIFT.x, y: +(y0 - i * 1.2).toFixed(2), z: LIFT.z }));
  const LAYOUT = {
    1: { casing: { x: 29, z: 20 }, leaks: { a: { x: 29, y: 21.5, z: 20 }, b: { x: 29, y: 15.5, z: 20 } }, plug: plug(5), plugRock: 'sand' },
    2: { lightBox: { x0: 9, x1: 31, y0: 15, y1: 27, z0: 9, z1: 31 }, lightsNeed: 3, plug: plug(5), plugRock: 'granite', quartz: { x: 11.5, y: 22, z: 27.5 } },
    3: { casing: { x: 29, z: 20 }, clogs: { a: { x: 29, y: 22.4, z: 20 }, b: { x: 29, y: 18.0, z: 20 }, c: { x: 29, y: 14.6, z: 20 } }, gas: { x: 28, y: 18, z: 22, r: 4.6 }, plug: plug(3), plugRock: 'hot', sulfur: { x: 26.5, y: 15.5, z: 25.5 } },
    4: { room: { x0: 28.5, x1: 37, y0: 20, y1: 23.8, z0: 15, z1: 25 }, pump: { x: 32.8, y: 20, z: 20 },
      panels: { drill: { x: 36.4, y: 20.9, z: 20 }, geo: { x: 32.8, y: 20.9, z: 15.6 }, pipe: { x: 32.8, y: 20.9, z: 24.4 }, safe: { x: 29.2, y: 20.9, z: 23.6 } },
      lava: { x: 12, y: 5, z: 12, r: 6 }, obsidian: { x: 14.5, y: 10.5, z: 14.5 } }
  };
  const PLUG_RH = 2.1, PLUG_RV = 0.95, BONUS_R = 1.3, NEAR_FIX = 2.6;

  /* 단계와 과제. role이 null이면 누구나 */
  const STAGES = [
    { id: 0, lv: 0, title: '현장 도착 · 케냐 올카리아', goal: '발전소 현장을 둘러보며 세 곳을 찾고 승강기에 타요', tasks: [
      { id: 'hs_well', role: null, label: '생산정(뜨거운 물·증기가 올라오는 관) 찾기' },
      { id: 'hs_steam', role: null, label: '하얀 수증기 찾기' },
      { id: 'hs_life', role: null, label: '발전소 옆에 사는 야생 동물 찾기' }] },
    { id: 1, lv: 1, title: '지하 400 m · 지하수층', goal: '새는 생산정 관 두 곳을 막고, 무너진 승강기 통로를 치워요', tasks: [
      { id: 'reach1', role: null, label: '400 m 도착' },
      { id: 'temp1', role: 'geo', label: '바위 온도 기록' },
      { id: 'loc1a', role: 'geo', label: '새는 곳 ① 찾기 (스캐너)' }, { id: 'fix1a', role: 'pipe', label: '새는 곳 ① 막기', need: 'loc1a' },
      { id: 'loc1b', role: 'geo', label: '새는 곳 ② 찾기 (스캐너)' }, { id: 'fix1b', role: 'pipe', label: '새는 곳 ② 막기', need: 'loc1b' },
      { id: 'plug1', role: null, label: '무너진 모래·자갈 치우기 (승강기 아래)' }] },
    { id: 2, lv: 2, title: '지하 1,000 m · 화강암층', goal: '캄캄한 작업장을 밝히고, 화강암 덩어리를 드릴로 뚫어요', tasks: [
      { id: 'reach2', role: null, label: '1,000 m 도착' },
      { id: 'light2', role: 'safe', label: '작업등 3개 이상 설치' },
      { id: 'temp2', role: 'geo', label: '바위 온도 기록' },
      { id: 'plug2', role: 'drill', label: '화강암 덩어리 뚫기 (승강기 아래)' }] },
    { id: 3, lv: 3, title: '지하 2,000 m · 가스 구역', goal: '막힌 관 세 곳을 청소하고 유독 가스를 빼내요', tasks: [
      { id: 'reach3', role: null, label: '2,000 m 도착' },
      { id: 'temp3', role: 'geo', label: '바위 온도 기록' },
      { id: 'vent3', role: 'safe', label: '가스 구역에 환풍기 설치' },
      { id: 'clean3a', role: 'pipe', label: '스케일 청소 ①' }, { id: 'clean3b', role: 'pipe', label: '스케일 청소 ②' }, { id: 'clean3c', role: 'pipe', label: '스케일 청소 ③' },
      { id: 'plug3', role: 'drill', label: '뜨거운 암반 덩어리 뚫기 (승강기 아래)' }] },
    { id: 4, lv: 4, title: '지하 3,000 m · 저류층', goal: '펌프실까지 뚫고 들어가 네 명이 순서대로 펌프를 다시 돌려요', tasks: [
      { id: 'reach4', role: null, label: '3,000 m 도착' },
      { id: 'temp4', role: 'geo', label: '바위 온도 기록' },
      { id: 'room4', role: null, label: '펌프실 찾아 들어가기' },
      { id: 'pump4', role: 'all', label: '펌프 재가동 (순서대로 네 개의 판)' }] },
    { id: 5, lv: 0, title: '지상 · 발전소 다시 돌리기', goal: '발전소 연결도를 맞추고 역할별 보고를 마쳐요', tasks: [
      { id: 'reach0', role: null, label: '지상으로 돌아오기' },
      { id: 'board', role: 'all', label: '발전소 연결도 완성' },
      { id: 'quiz', role: 'all', label: '역할별 보고 (문제)' }] }
  ];
  const BONUS = [
    { id: 'quartz', lv: 2, label: '광물 표본: 석영', star: 1 },
    { id: 'sulfur', lv: 3, label: '광물 표본: 황 결정', star: 1 },
    { id: 'obsidian', lv: 4, label: '광물 표본: 흑요석', star: 1 },
    { id: 'magma', lv: 4, label: '마그마 온도 재기 (지질 조사원)', star: 1, role: 'geo' }
  ];
  const TASK = {}; STAGES.forEach(s => s.tasks.forEach(t => { TASK[t.id] = Object.assign({ stage: s.id }, t); }));
  const STAR_MAX = STAGES.length - 1 + BONUS.length + 1;   // 단계 1~5 + 보너스 4 + 보고 만점 1 = 10

  /* 발전소 연결도: 지열수의 길 */
  const BOARD = [
    { id: 'prod', name: '생산정', d: '땅속 뜨거운 물·증기를 끌어 올리는 관' },
    { id: 'sep', name: '증기 분리기', d: '올라온 뜨거운 물에서 증기만 골라내요' },
    { id: 'turb', name: '터빈·발전기', d: '증기가 터빈을 돌려 전기를 만들어요' },
    { id: 'cool', name: '냉각탑(복수기)', d: '터빈을 지난 증기를 식혀 물로 되돌려요' },
    { id: 'inj', name: '주입정', d: '식은 물을 다시 땅속 저류층으로 넣어요' }
  ];
  const BOARD_HAND = { drill: ['turb'], geo: ['prod', 'sep'], pipe: ['inj'], safe: ['cool'] };
  /* 역할별 보고 문제 */
  const QUIZ = {
    geo: { q: '우리 팀 기록: 400 m 39 ℃ · 1,000 m 75 ℃ · 2,000 m 135 ℃ · 3,000 m 195 ℃. 1 km 내려갈 때마다 바위 온도는 약 몇 ℃ 올랐나요?', o: ['약 15 ℃', '약 30 ℃', '약 60 ℃', '약 120 ℃'], a: 2,
      ex: '1,000 m에서 2,000 m로 1 km 내려갈 때 75 → 135 ℃, 약 60 ℃가 올랐어요(지온 경사). 보통 땅은 1 km마다 약 25~30 ℃인데, 화산 지대는 훨씬 빨리 뜨거워져서 지열 발전에 좋아요.' },
    pipe: { q: '발전에 쓰고 식은 물을 주입정으로 다시 땅속에 넣는 가장 큰 까닭은?', o: ['땅속 저류층의 물을 다시 채워 오래오래 쓰려고', '물을 버릴 곳이 없어서', '땅을 차갑게 얼리려고', '바닷물을 만들려고'], a: 0,
      ex: '뜨거운 물을 뽑기만 하면 저류층이 말라요. 식은 물을 되돌려 넣으면 땅속 열로 다시 데워져서 계속 쓸 수 있어요. 그래서 지열은 재생 에너지예요.' },
    safe: { q: '땅속에 물을 아주 높은 압력으로 많이 넣으면 생길 수 있는 문제는?', o: ['작은 지진이 생길 수 있다', '물이 얼어 버린다', '전기가 두 배로 늘어난다', '아무 일도 없다'], a: 0,
      ex: '2017년 포항 지진(규모 5.4)은 정부 조사단이 지열 발전 실험의 물 주입이 촉발한 지진이라고 결론 내렸어요. 그래서 땅속 상태를 살피며 조심스럽게 운영해야 해요.' },
    drill: { q: '지열 발전소를 짓기에 가장 좋은 곳은?', o: ['화산·온천이 있어 땅속 온도가 빨리 올라가는 곳', '바람이 센 바닷가', '햇빛이 강한 사막', '강물이 빠른 계곡'], a: 0,
      ex: '아이슬란드·케냐·인도네시아처럼 화산 지대(판의 경계 근처)는 얕은 곳에도 뜨거운 바위와 물이 있어서 지열 발전소가 많아요.' }
  };

  /* ---------- 팀 ---------- */
  function newTeam(id, name, seed) {
    return { id, name, seed: seed >>> 0, members: [], started: false, t0: 0, tEnd: 0, stage: 0, done: {}, doneBy: {}, stageT: {}, unlocked: 0,
      bonus: {}, plugs: { 1: [], 2: [], 3: [] }, lights2: 0, vent: false, edits: { 1: [], 2: [], 3: [], 4: [] }, places: { 1: [], 2: [], 3: [], 4: [] },
      seq: shuffle(RID.slice(), seed), seqPos: 0, seqT: 0, slots: [null, null, null, null, null], quiz: {}, quizFirst: {}, clear: false };
  }
  function shuffle(a, seed) { let s = (seed >>> 0) || 1; const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  const memberOf = (T, pid) => T.members.find(m => m.id === pid);
  const has = (T, pid, role) => { const m = memberOf(T, pid); return !!m && (role === null || role === 'all' || m.roles.includes(role)); };
  const online = T => T.members.filter(m => m.on);
  function holders(T, role) { return T.members.filter(m => m.roles.includes(role)); }
  /* 들어오기: 비어 있는 역할을 줌. 다 찼으면 역할이 2개인 친구에게서 하나 받음, 그래도 없으면 사람이 가장 적은 역할을 같이 맡음 */
  function join(T, p) {
    let m = memberOf(T, p.id);
    if (!m) { m = { id: p.id, name: p.name, roles: [], on: true, lv: 0 }; T.members.push(m); }
    m.on = true; m.offAt = 0; m.name = p.name;
    if (!m.roles.length) giveRole(T, m);
    return m;
  }
  function giveRole(T, m) {
    const free = RID.filter(r => !holders(T, r).length);
    if (free.length) { m.roles.push(free[0]); return; }
    const rich = T.members.filter(x => x !== m && x.roles.length > 1).sort((a, b) => b.roles.length - a.roles.length)[0];
    if (rich) { m.roles.push(rich.roles.pop()); return; }
    const few = RID.slice().sort((a, b) => holders(T, a).length - holders(T, b).length)[0];
    m.roles.push(few);
  }
  /* 시작 전 역할 고르기: 비어 있으면 가져오고, 내가 가진 것이면 내려놓음(마지막 하나는 못 내려놓음) */
  function pickRole(T, pid, role) {
    const m = memberOf(T, pid); if (!m || !RID.includes(role)) return { err: '역할을 고를 수 없어요.' };
    if (m.roles.includes(role)) { if (m.roles.length < 2) return { err: '역할이 하나뿐이면 내려놓을 수 없어요.' }; m.roles = m.roles.filter(r => r !== role); return { ok: true }; }
    const h = holders(T, role);
    if (h.length && T.members.length <= 4) {
      const owner = h[0]; if (owner.roles.length < 2) return { err: owner.name + ' 친구가 맡은 역할이에요. 서로 말로 정해서 바꿔요.' };
      owner.roles = owner.roles.filter(r => r !== role);
    }
    m.roles.push(role); return { ok: true };
  }
  /* 아무도 안 맡은 역할을 (접속 중인) 역할 적은 친구에게 나눠 줌 */
  function fillRoles(T) {
    const on = online(T).length ? online(T) : T.members;
    for (const r of RID) if (!holders(T, r).some(m => m.on)) {
      for (const m of T.members) if (!m.on) m.roles = m.roles.filter(x => x !== r);
      const tgt = on.slice().sort((a, b) => a.roles.length - b.roles.length)[0]; if (tgt && !tgt.roles.includes(r)) tgt.roles.push(r);
    }
  }
  function start(T, now) { if (T.started) return []; fillRoles(T); T.started = true; T.t0 = now; return [{ k: 'start' }].concat(enterStage(T, 0, now)); }
  function enterStage(T, s, now) { T.stage = s; T.unlocked = Math.max(T.unlocked, STAGES[s].lv); const ev = [{ k: 'stage', s }]; ev.push(...autoDone(T, now)); return ev; }
  function autoDone(T, now) {   // 단계에 들어올 때 이미 조건이 맞은 과제(예: 미리 뚫어 둔 통로)
    const ev = [];
    for (const n of [1, 2, 3]) if (T.stage === n && plugLeft(T, n) === 0) ev.push(...finish(T, 'plug' + n, null, now));
    if (T.stage === 2 && T.lights2 >= LAYOUT[2].lightsNeed) ev.push(...finish(T, 'light2', null, now));
    if (T.stage === 3 && T.vent) ev.push(...finish(T, 'vent3', null, now));
    for (const m of T.members) if (m.lv && T.stage === m.lv && STAGES[m.lv].tasks.some(t => t.id === 'reach' + m.lv)) ev.push(...finish(T, 'reach' + m.lv, m.id, now));
    return ev;
  }
  function plugLeft(T, n) { return LAYOUT[n].plug.length - T.plugs[n].length; }
  function finish(T, id, pid, now) {
    const t = TASK[id]; if (!t || T.done[id] || t.stage !== T.stage) return [];
    T.done[id] = now; T.doneBy[id] = pid;
    const ev = [{ k: 'done', id, by: pid }];
    const S = STAGES[T.stage];
    if (S.tasks.every(x => T.done[x.id])) {
      T.stageT[T.stage] = now;
      if (T.stage < STAGES.length - 1) ev.push(...enterStage(T, T.stage + 1, now));
      else { T.clear = true; T.tEnd = now; ev.push({ k: 'clear' }); }
    }
    return ev;
  }
  const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

  /* 땅 파기 기록 → 막힌 통로·광물 표본 판정 */
  function onDig(T, pid, d, now) {
    const lv = d.l; if (!(lv >= 1 && lv <= 4)) return [];
    T.edits[lv].push([+d.x.toFixed(2), +d.y.toFixed(2), +d.z.toFixed(2), +d.r.toFixed(2)]);
    const ev = [];
    const L = LAYOUT[lv];
    if (L.plug) L.plug.forEach((c, i) => {
      if (T.plugs[lv].includes(i)) return;
      const h = Math.hypot(d.x - c.x, d.z - c.z), v = Math.abs(d.y - c.y);
      if (h < PLUG_RH && v < PLUG_RV + d.r * 0.5) { T.plugs[lv].push(i); ev.push({ k: 'plug', lv, i, left: plugLeft(T, lv) }); }
    });
    if (T.stage === lv && plugLeft(T, lv) === 0 && L.plug) ev.push(...finish(T, 'plug' + lv, pid, now));
    for (const b of BONUS) if (b.lv === lv && !b.role && !T.bonus[b.id] && L[b.id] && d2(d, L[b.id]) < (BONUS_R + d.r) ** 2) { T.bonus[b.id] = pid; ev.push({ k: 'bonus', id: b.id, by: pid }); }
    return ev;
  }
  /* 작업등·환풍기 놓기 */
  function onPlace(T, pid, p, now) {
    const lv = p.l; if (!(lv >= 1 && lv <= 4) || !has(T, pid, 'safe')) return { err: '안전 관리자만 설치할 수 있어요.' };
    const mine = T.places[lv].filter(q => q.k === p.k).length;
    if (p.k === 'light' && T.places[lv].filter(q => q.k === 'light').length >= 12) return { err: '작업등은 한 층에 12개까지예요.' };
    if (p.k === 'fan' && mine >= 2) return { err: '환풍기는 한 층에 2개까지예요.' };
    if (p.k !== 'light' && p.k !== 'fan') return { err: '?' };
    const q = { k: p.k, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), by: pid };
    T.places[lv].push(q);
    const ev = [{ k: 'place', lv, q }];
    if (lv === 2 && p.k === 'light') { const B = LAYOUT[2].lightBox; if (p.x >= B.x0 && p.x <= B.x1 && p.y >= B.y0 && p.y <= B.y1 && p.z >= B.z0 && p.z <= B.z1) T.lights2++; if (T.lights2 >= LAYOUT[2].lightsNeed) ev.push(...finish(T, 'light2', pid, now)); }
    if (lv === 3 && p.k === 'fan') { const G = LAYOUT[3].gas; if (d2(p, G) < (G.r + 0.8) ** 2) { T.vent = true; ev.push({ k: 'vent' }); ev.push(...finish(T, 'vent3', pid, now)); } }
    return { ok: true, ev };
  }
  /* 과제 행동 (위치·역할 확인) */
  function onAct(T, pid, a, now) {
    const m = memberOf(T, pid); if (!m) return { err: '팀에 없어요.' };
    const id = a.id, t = TASK[id], pos = a.pos || {}, lv = a.l;
    if (id === 'hs') { const tid = 'hs_' + a.h; if (!TASK[tid]) return { err: '?' }; return { ok: true, ev: finish(T, tid, pid, now) }; }
    if (id === 'reach') { m.lv = lv; if (lv > T.unlocked) return { err: '아직 승강기가 그 깊이까지 못 가요.' }; return { ok: true, ev: finish(T, 'reach' + lv, pid, now) }; }
    if (id === 'magma') { if (!has(T, pid, 'geo')) return { err: '지질 조사원의 스캐너로만 잴 수 있어요.' }; if (T.bonus.magma) return { ok: true, ev: [] }; T.bonus.magma = pid; return { ok: true, ev: [{ k: 'bonus', id: 'magma', by: pid }] }; }
    if (!t) return { err: '알 수 없는 과제' };
    if (t.stage !== T.stage) return { err: t.stage > T.stage ? '아직 이 과제를 할 차례가 아니에요.' : '이미 끝난 단계예요.' };
    if (T.done[id]) return { ok: true, ev: [] };
    if (t.role && t.role !== 'all' && !has(T, pid, t.role)) { const r = ROLES.find(x => x.id === t.role); return { err: r.ic + ' ' + r.name + '만 할 수 있어요.' }; }
    if (t.need && !T.done[t.need]) return { err: '먼저 지질 조사원이 스캐너로 정확한 위치를 찾아야 해요.' };
    if (/^temp/.test(id)) return { ok: true, ev: finish(T, id, pid, now) };
    if (/^loc1|^fix1/.test(id)) { const L = LAYOUT[1].leaks[id.slice(-1)]; if (id.startsWith('fix') && d2(pos, L) > NEAR_FIX ** 2) return { err: '새는 곳에 더 가까이 가야 해요.' }; return { ok: true, ev: finish(T, id, pid, now) }; }
    if (/^clean3/.test(id)) { const L = LAYOUT[3].clogs[id.slice(-1)]; if (d2(pos, L) > NEAR_FIX ** 2) return { err: '막힌 곳에 더 가까이 가야 해요.' }; return { ok: true, ev: finish(T, id, pid, now) }; }
    if (id === 'room4') return { ok: true, ev: finish(T, id, pid, now) };
    return { err: '이 과제는 다른 방법으로 해요.' };
  }
  /* 펌프 재가동: 정해진 역할 순서대로 판을 눌러야 함. 25초 안에 */
  function onPanel(T, pid, role, now) {
    if (T.stage !== 4 || T.done.pump4) return { err: T.done.pump4 ? '펌프가 이미 돌아가요.' : '아직이에요.' };
    if (!T.done.room4) return { err: '먼저 펌프실에 들어가야 해요.' };
    if (!has(T, pid, role)) { const r = ROLES.find(x => x.id === role); return { err: r.ic + ' ' + r.name + '의 판이에요.' }; }
    if (T.seqPos && now - T.seqT > 25000) T.seqPos = 0;
    if (T.seq[T.seqPos] === role) {
      if (T.seqPos === 0) T.seqT = now;
      T.seqPos++;
      const ev = [{ k: 'panel', role, pos: T.seqPos, ok: true }];
      if (T.seqPos === 4) ev.push(...finish(T, 'pump4', pid, now));
      return { ok: true, ev };
    }
    T.seqPos = 0; return { ok: true, ev: [{ k: 'panel', role, pos: 0, ok: false }] };
  }
  function tick(T, now) { if (T.seqPos && T.seqPos < 4 && now - T.seqT > 25000) { T.seqPos = 0; return [{ k: 'panel', role: null, pos: 0, ok: false, timeout: true }]; } return []; }
  /* 연결도: 내 손에 있는 카드만 놓을 수 있음 */
  function handOf(T, pid) { const m = memberOf(T, pid); if (!m) return []; const all = [].concat(...m.roles.map(r => BOARD_HAND[r] || [])); return all.filter(c => !T.slots.includes(c)); }
  function onCard(T, pid, card, slot, now) {
    if (T.stage !== 5 || T.done.board) return { err: '아직이에요.' };
    if (!T.done.reach0) return { err: '먼저 지상으로 돌아와야 해요.' };
    const m = memberOf(T, pid); if (!m) return { err: '?' };
    if (slot === -1) { const i = T.slots.indexOf(card); if (i >= 0 && [].concat(...m.roles.map(r => BOARD_HAND[r])).includes(card)) T.slots[i] = null; return { ok: true, ev: [{ k: 'board' }] }; }
    if (!(slot >= 0 && slot < 5) || T.slots[slot]) return { err: '빈 칸에 놓아요.' };
    if (!handOf(T, pid).includes(card)) return { err: '내 카드가 아니에요.' };
    T.slots[slot] = card;
    const ev = [{ k: 'board' }];
    if (T.slots.every(Boolean)) {
      const wrong = T.slots.map((c, i) => c !== BOARD[i].id ? i : -1).filter(i => i >= 0);
      if (!wrong.length) ev.push(...finish(T, 'board', pid, now));
      else { ev.push({ k: 'boardWrong', wrong: wrong.slice() }); wrong.forEach(i => { T.slots[i] = null; }); }
    }
    return { ok: true, ev };
  }
  /* 역할별 보고: 그 역할을 맡은 사람이 답함. 틀리면 설명 보고 다시 */
  function onQuiz(T, pid, role, ans, now) {
    if (T.stage !== 5 || !T.done.board) return { err: '연결도를 먼저 완성해요.' };
    if (!has(T, pid, role)) return { err: '그 역할을 맡은 친구가 답해요.' };
    const Q = QUIZ[role]; if (!Q || T.quiz[role]) return { ok: true, ev: [] };
    const ok = ans === Q.a; if (T.quizFirst[role] == null) T.quizFirst[role] = ok;
    const ev = [{ k: 'qa', role, ok, by: pid }];
    if (ok) { T.quiz[role] = pid; if (RID.every(r => T.quiz[r])) ev.push(...finish(T, 'quiz', pid, now)); }
    return { ok: true, ev };
  }
  function stars(T) {
    let s = 0; for (let i = 1; i < STAGES.length; i++) if (T.stageT[i]) s++;
    s += BONUS.filter(b => T.bonus[b.id]).length;
    if (T.done.quiz && RID.every(r => T.quizFirst[r])) s++;
    return s;
  }
  /* 화면에 보낼 팀 상태 (편집 기록 제외) */
  function view(T) {
    return { id: T.id, name: T.name, started: T.started, t0: T.t0, tEnd: T.tEnd, stage: T.stage, done: T.done, doneBy: T.doneBy, stageT: T.stageT, unlocked: T.unlocked,
      bonus: T.bonus, plugs: T.plugs, lights2: T.lights2, vent: T.vent, seqPos: T.seqPos, slots: T.slots, quiz: T.quiz, clear: T.clear, stars: stars(T),
      members: T.members.map(m => ({ id: m.id, name: m.name, roles: m.roles, on: m.on, lv: m.lv || 0 })) };
  }
  function seqFor(T, pid) { return has(T, pid, 'geo') ? T.seq.slice() : null; }
  const API = { seqFor, ROLES, RID, LV_SIZE, LIFT, LAND_Y, DEPTH, LAYOUT, STAGES, TASK, BONUS, BOARD, BOARD_HAND, QUIZ, STAR_MAX, PLUG_RH, PLUG_RV, NEAR_FIX,
    tempAt, depthAt, newTeam, join, pickRole, fillRoles, start, onDig, onPlace, onAct, onPanel, onCard, onQuiz, tick, handOf, stars, view, has, memberOf, plugLeft };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.GEO = API;
})(typeof self !== 'undefined' ? self : this);
