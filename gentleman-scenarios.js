// 「저쪽 신사분이 주신 겁니다」 — 1인 테스트용 자동 시나리오
//
// 시뮬레이터에서 버튼 하나로 실행한다. 실제 관리자 API를 HTTP로 그대로 호출해서
// 운영과 같은 경로(팀 배정 → 드래프트 → 배정 → 결과 이미지 → 투표 → 지급)를 검증한다.
// 테스트 이벤트(isTestEvent)만 만들고 다루므로 운영 데이터에는 영향이 없다.
//
// A: 무기군별 실험체 후보   B: 32명 모집 후 16명 진행   C: 16명 기준 팀 수 변경 (4·5·6·8팀 × 랜덤·티어)

const db = require('./db');
const D = require('./gentleman-draft');
const W = require('./character-weapons');
const discord = require('./gentleman-discord');
const { TIERS } = require('./constants');

const TEST_PREFIX = 'simtest_';
const TIER_NAMES = TIERS.filter(t => t.value > 0).map(t => t.name);

// 테스트 이벤트를 만든다. 팀은 배정하지 않는다 (시나리오가 관리자 API로 직접 배정한다).
function createTestEvent({ memberCount, mapType = '코발트', teamCount = 2, type = 'prize', label = 'sc' }) {
    const eventId = `${TEST_PREFIX}${label}_${Date.now().toString(36)}`;
    const adminToken = db.createEvent(eventId, 'sim-guild', 'sim-channel', 'sim-admin', teamCount, '내전', mapType);
    db.withGentleman(eventId, (g, ev) => { ev.isTestEvent = true; ev.simCreatedAt = Date.now(); return {}; });
    db.setMaxPlayers(eventId, memberCount);
    for (let i = 1; i <= memberCount; i++) {
        const tier = TIER_NAMES[(i * 7) % TIER_NAMES.length];          // 티어를 고르게 섞어 둔다
        const tok = db.addParticipant(eventId, `simuser${i}`, `테스터${i}`, `sim_${i}`, '전사', tier, [], 1000 + i * 37);
        db.markDummy(tok);
    }
    db.setGentleman(eventId, D.createState({ type }));
    return { eventId, adminToken };
}

// 실제 서버 API를 호출하는 도우미
function makeClient(base, eventId, adminToken, devToken) {
    const post = async (path, body = {}) => {
        const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const get = async path => {
        const res = await fetch(base + path);
        return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const q = `event=${encodeURIComponent(eventId)}&token=${encodeURIComponent(adminToken)}`;
    return {
        admin:   (p, b) => post(`/api/admin/${p}`, { event: eventId, token: adminToken, ...b }),
        adminGet: p => get(`/api/admin/${p}${p.includes('?') ? '&' : '?'}${q}`),
        gm:      (p, b) => post(`/api/gentleman/admin/${p}`, { event: eventId, token: adminToken, ...b }),
        gmGet:    p => get(`/api/gentleman/admin/${p}?${q}`),
        dev:     (p, b) => post(`/api/gentleman/dev/${p}`, { devToken, event: eventId, ...b }),
    };
}

// 단계 기록기 — 실패해도 나머지 단계는 계속 진행하고, 결과를 모두 돌려준다
function makeRecorder() {
    const steps = [];
    const check = (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail: String(detail ?? '') }); return !!ok; };
    const must = (name, ok, detail) => { if (!check(name, ok, detail)) throw new Error(`${name} 실패${detail ? ` — ${detail}` : ''}`); };
    return { steps, check, must };
}

const sizesOf = participants => {
    const by = {};
    for (const p of participants) if (p.team_num) by[p.team_num] = (by[p.team_num] ?? 0) + 1;
    return Object.keys(by).map(Number).sort((a, b) => a - b).map(t => by[t]);
};

// 드래프트 전 과정을 자동으로 진행하고 결과 이미지까지 만든다
async function runDraftToPublish(c, rec, label) {
    const start = await c.gm('start');
    rec.must(`${label}드래프트 시작`, start.data.success, start.data.error ?? `팀당 후보 ${start.data.perTeam}개 · ${start.data.teamCount}팀`);
    const pick = await c.dev('auto-pick');
    rec.must(`${label}전 팀 실험체 4개 선택·확정`, pick.data.success, pick.data.error ?? `${pick.data.teams?.length}팀 확정`);
    const fin = await c.gm('finalize');
    rec.must(`${label}선물 교환·참가자별 배정`, fin.data.success, fin.data.error ?? `순서 ${fin.data.order?.join('→')}`);
    discord.clearMockOutbox(c.eventId);
    const pub = await c.gm('publish');
    const okResults = (pub.data.results ?? []).filter(r => r.ok);
    rec.must(`${label}팀별 결과 이미지 전송`, pub.data.success && !pub.data.failed?.length, pub.data.error ?? `${okResults.length}건 성공`);
    return { start: start.data, publish: pub.data };
}

// 배정 결과와 결과 이미지를 대조한다 — 팀 인원수 = 배정된 참가자 수 = 이미지에 담긴 참가자 수
function verifyAssignments(eventId, rec, label) {
    const ev = db.getEvent(eventId);
    const participants = db.getParticipants(eventId);
    const g = ev.gentleman;
    const outbox = discord.getMockOutbox(eventId).filter(m => m.kind === 'gift-result');
    let allOk = true, detail = [];
    for (const t of D.teamNumbers(participants)) {
        const members = participants.filter(p => p.team_num === t).length;
        const a = g.assignments?.[t];
        const img = outbox.find(m => m.teamNum === t);
        const assigned = a?.members.filter(m => m.character).length ?? 0;
        const ok = a && a.members.length === members && assigned === members && img?.files?.[0]?.bytes > 0;
        if (!ok) allOk = false;
        detail.push(`${t}팀 ${members}명/배정 ${assigned}/이미지 ${img?.files?.[0]?.bytes ? 'O' : 'X'}`);
    }
    rec.check(`${label}결과 이미지 참가자 수 = 팀 인원`, allOk, detail.join(', '));
    return g;
}

// ── 시나리오 A — 무기군별 실험체 랜덤 ─────────────────
async function scenarioWeapons(c, rec) {
    // 1) 후보 전체 목록
    const all = W.allCandidates();
    const ids = all.map(x => x.id);
    rec.must('1. 후보 전체 목록 생성', all.length > 0 && new Set(ids).size === ids.length,
        `실험체 ${new Set(all.map(x => x.characterName)).size}명 → 후보 ${all.length}개 (ID 중복 없음) · 데이터 ${W.status().source}`);

    // 2) 재키 무기군
    const jackie = all.filter(x => x.characterName === '재키').map(x => x.displayName);
    const expectJackie = ['단검 재키', '양손검 재키', '도끼 재키', '쌍검 재키'];
    rec.check('2. 재키 무기군별 후보 존재', expectJackie.every(n => jackie.includes(n)) && jackie.length === 4, jackie.join(', '));

    // 3) 알렉스는 하나
    const alex = all.filter(x => x.characterName === '알렉스');
    rec.check('3. 알렉스는 후보 하나', alex.length === 1 && alex[0].displayName === '알렉스', alex.map(x => `${x.id} ${x.displayName}`).join(', '));

    // 4) 같은 실험체의 다른 무기군이 별도 후보로 함께 뽑히는지 (8팀 × 12개 추첨을 반복)
    let found = null;
    for (let i = 0; i < 30 && !found; i++) {
        const ps = Array.from({ length: 16 }, (_, k) => ({ cancel_token: `x${k}`, discord_nickname: `x${k}`, team_num: (k % 8) + 1 }));
        const st = D.createState();
        const r = D.startDraft(st, ps, []);
        if (r.error) break;
        const drawn = Object.values(st.teams).flatMap(t => t.candidates);
        if (new Set(drawn).size !== drawn.length) { found = { dup: true }; break; }
        const byChar = {};
        for (const id of drawn) (byChar[W.describe(id).characterName] ??= []).push(W.describe(id).displayName);
        const multi = Object.entries(byChar).find(([, list]) => list.length >= 2);
        if (multi) found = { name: multi[0], list: multi[1] };
    }
    rec.check('4. 같은 실험체의 다른 무기군이 별도 후보로 추첨됨', found && !found.dup, found?.dup ? '같은 ID가 두 번 뽑힘' : found ? found.list.join(' / ') : '30회 동안 발견 못 함');

    // 5) 재키 밴 → 모든 재키 무기군 제외
    const ban = await c.admin('char-ban', { character: '재키', action: 'ban' });
    const poolNoJackie = W.candidatePool(['재키']);
    rec.must('5. 재키 밴 후 재키 무기군 전부 제외', ban.data.success && !poolNoJackie.some(x => x.characterName === '재키'),
        `밴 목록: ${(ban.data.bannedCharacters ?? []).join(', ')} · 남은 후보 ${poolNoJackie.length}개`);

    // 6) 팀별 12개 후보 추첨 (16명 · 4팀)
    await c.admin('team-count', { teamCount: 4 });
    const sh = await c.admin('shuffle');
    rec.must('6-1. 16명 4팀 배정', sh.data.success, sh.data.error ?? (sh.data.sizes ?? []).join('/'));
    const st = await runDraftToPublish(c, rec, '6-2. ');
    const g0 = db.getEvent(c.eventId).gentleman;
    const cands = Object.values(g0.teams).flatMap(t => t.candidates);
    rec.check('6-3. 팀별 후보 12개 · 팀 간 중복 없음',
        Object.values(g0.teams).every(t => t.candidates.length === 12) && new Set(cands).size === cands.length,
        `${Object.keys(g0.teams).length}팀 × ${st.start.perTeam}개`);
    rec.check('6-4. 추첨된 후보에 재키 없음', !cands.some(id => W.describe(id).characterName === '재키'), `후보 ${cands.length}개 확인`);

    // 7) 선택·선물 배정·결과 이미지까지 무기군 정보 보존
    const g = verifyAssignments(c.eventId, rec, '7-1. ');
    const members = Object.values(g.assignments).flatMap(a => a.members);
    const lostWeapon = members.filter(m => {
        const info = W.describe(m.character);
        return info.characterName !== '알렉스' && (!info.weaponName || m.weaponName !== info.weaponName || m.displayName !== info.displayName);
    });
    const sample = members.slice(0, 4).map(m => `${m.nickname}: ${m.displayName}`).join(', ');
    rec.check('7-2. 배정 결과에 무기군 정보 보존', !lostWeapon.length, lostWeapon.length ? `무기군 누락 ${lostWeapon.length}명` : sample);
    const picksOk = Object.values(g.teams).every(t => t.picks.every(id => W.describe(id).id === id));
    rec.check('7-3. 팀 선택값이 실험체+무기군 ID로 저장됨', picksOk, Object.values(g.teams)[0].picks.map(id => W.describe(id).displayName).join(', '));

    // 투표 후보에도 무기군이 따라가는지
    await c.gm('winner', { teamNum: 1 });
    await c.gm('winner/publish');
    const vo = await c.gm('vote/open');
    const snap = db.getEvent(c.eventId).gentleman.vote?.snapshot;
    rec.check('7-4. 불행상 투표 후보에 무기군 표시', vo.data.success && snap?.candidates.every(x => x.displayName),
        vo.data.error ?? snap?.candidates.slice(0, 3).map(x => `${x.nickname}: ${x.displayName}`).join(', '));
    await c.dev('auto-vote', { mode: 'random' });
    await c.gm('vote/close');
    discord.clearMockOutbox(c.eventId);
    const un = await c.gm('unlucky/publish');
    const unImg = discord.getMockOutbox(c.eventId).find(m => m.kind === 'unlucky');
    rec.check('7-5. 불행상 결과 이미지 생성', un.data.success && (un.data.noWinner || unImg?.files?.[0]?.bytes > 0),
        un.data.error ?? (un.data.winners ?? []).map(w => `${w.nickname}: ${w.displayName}`).join(', '));
}

// ── 시나리오 B — 32명 모집 후 16명 진행 ───────────────
async function scenarioRecruit32(c, rec) {
    const all = db.getParticipants(c.eventId);
    rec.must('1. 가상 참가자 32명 생성', all.length === 32, `신청 ${all.length}명`);

    const shuffled = D.shuffle(all.map(p => p.cancel_token));
    const chosen = shuffled.slice(0, 16), rest = shuffled.slice(16);
    const act = await c.admin('active', { activeTokens: chosen });
    rec.must('2. 실제 진행 참가자 16명 선택', act.data.success && act.data.activeCount === 16, act.data.error ?? `진행 ${act.data.activeCount}명 · 미참여 ${act.data.inactiveCount}명`);

    const tc = await c.admin('team-count', { teamCount: 4 });
    rec.must('3. 팀 수 4팀 설정', tc.data.success && tc.data.teamCount === 4, tc.data.error ?? `${tc.data.teamCount}팀`);

    const sh = await c.admin('shuffle');
    rec.must('4. 랜덤 배정 실행', sh.data.success, sh.data.error);
    const after = db.getParticipants(c.eventId);
    rec.check('5. 결과 4/4/4/4', sizesOf(after).join('/') === '4/4/4/4', sizesOf(after).join('/'));
    const restOk = rest.every(t => { const p = after.find(x => x.cancel_token === t); return p && !p.team_num; });
    rec.check('6. 나머지 16명은 팀 미지정 + 신청 유지', after.length === 32 && restOk,
        `신청 ${after.length}명 · 팀 미지정 ${after.filter(p => !p.team_num).length}명`);

    // 예외: 다시 자동 배정해도 32명이 배정되지 않는다
    const sh2 = await c.admin('shuffle-tier');
    const after2 = db.getParticipants(c.eventId);
    rec.check('6-1. 다시 배정해도 진행 인원 16명만 배정 (티어 균형)', sh2.data.success && after2.filter(p => p.team_num).length === 16 && sizesOf(after2).join('/') === '4/4/4/4',
        sh2.data.error ?? `배정 ${after2.filter(p => p.team_num).length}명 · ${sizesOf(after2).join('/')}`);

    // 7) 드래프트부터 상품 지급까지
    await runDraftToPublish(c, rec, '7-1. ');
    const blocked = await c.admin('shuffle');
    rec.check('7-2. 드래프트 중 팀 변경 차단', blocked.status === 409, blocked.data.error);
    verifyAssignments(c.eventId, rec, '7-3. ');
    await c.gm('winner', { teamNum: 1 });
    const wp = await c.gm('winner/publish');
    rec.check('7-4. 우승팀 공지', wp.data.success, wp.data.error);
    const vo = await c.gm('vote/open');
    rec.check('7-5. 투표 후보·투표권에서 팀 미지정 제외', vo.data.success && vo.data.candidateCount === 12 && vo.data.voterCount === 16,
        vo.data.error ?? `후보 ${vo.data.candidateCount}명 · 투표권 ${vo.data.voterCount}명`);
    const snap = db.getEvent(c.eventId).gentleman.vote.snapshot;
    rec.check('7-6. 미참여 16명이 후보에 없음', !snap.candidates.some(x => rest.includes(x.token)), '');
    await c.dev('auto-vote', { mode: 'random' });
    await c.gm('vote/close');
    const un = await c.gm('unlucky/publish');
    rec.check('7-7. 불행상 공지', un.data.success, un.data.error);
    const pays = await c.gmGet('payouts');
    for (const row of pays.data.rows ?? []) await c.gm('payout', { participantToken: row.token, status: 'done' });
    const pays2 = await c.gmGet('payouts');
    rec.check('7-8. 상품 지급 완료 처리', (pays2.data.rows ?? []).length > 0 && pays2.data.rows.every(r => r.status === 'done'),
        `${pays2.data.rows?.length ?? 0}명 지급 완료`);
    const cd = await c.gm('close-draft');
    rec.check('7-9. 드래프트 종료', cd.data.success, cd.data.error);

    // 8) 다음 회차 — 이전 미지정 참가자를 다시 선택
    const nr = await c.gm('next-round', { keepTeams: false, keepBans: true, type: 'prize' });
    rec.check('8-1. 다음 회차 시작', nr.data.success, nr.data.error ?? `${nr.data.round}회차`);
    const act2 = await c.admin('active', { activeTokens: rest });
    const sh3 = await c.admin('shuffle');
    const after3 = db.getParticipants(c.eventId);
    const assigned3 = after3.filter(p => p.team_num).map(p => p.cancel_token);
    rec.check('8-2. 이전 미지정 16명을 다시 선택해 배정', act2.data.success && sh3.data.success
        && assigned3.length === 16 && rest.every(t => assigned3.includes(t)) && sizesOf(after3).join('/') === '4/4/4/4',
        sh3.data.error ?? act2.data.error ?? `배정 ${assigned3.length}명 · ${sizesOf(after3).join('/')}`);
}

// ── 시나리오 C — 팀 수 변경 (16명) ────────────────────
async function scenarioTeamCounts(c, rec) {
    const cases = { 4: '4/4/4/4', 5: '4/3/3/3/3', 6: '3/3/3/3/2/2', 8: '2/2/2/2/2/2/2/2' };
    const all = db.getParticipants(c.eventId);
    for (const [t, expect] of Object.entries(cases)) {
        for (const mode of ['random', 'tier']) {
            const label = `${t}팀 · ${mode === 'tier' ? '티어 균형' : '랜덤'}`;
            const tc = await c.admin('team-count', { teamCount: Number(t) });
            if (!rec.check(`${label} — 팀 수 설정`, tc.data.success, tc.data.error)) continue;
            const sh = await c.admin(mode === 'tier' ? 'shuffle-tier' : 'shuffle');
            if (!rec.check(`${label} — 배정`, sh.data.success, sh.data.error)) continue;

            const ps = db.getParticipants(c.eventId);
            const sizes = sizesOf(ps);
            const tokens = ps.filter(p => p.team_num).map(p => p.cancel_token);
            const dup = tokens.length !== new Set(tokens).size;
            const missing = all.filter(p => !tokens.includes(p.cancel_token)).length;
            const over = Math.max(...sizes) > 4;
            const gap = Math.max(...sizes) - Math.min(...sizes);
            const strayTeam = ps.some(p => p.team_num && p.team_num > Number(t));
            rec.check(`${label} — 인원 ${expect}`, sizes.join('/') === expect && !dup && !missing && !over && gap <= 1 && !strayTeam,
                `결과 ${sizes.join('/')} · 중복 ${dup ? '있음' : '없음'} · 누락 ${missing}명 · 최대 ${Math.max(...sizes)}명 · 차이 ${gap}명`);

            // 드래프트·결과 이미지까지 진행해 이미지 속 참가자 수를 확인한다
            await runDraftToPublish(c, rec, `${label} — `);
            verifyAssignments(c.eventId, rec, `${label} — `);
            await c.gm('close-draft');
            await c.gm('reset');
            await c.gm('setup', { type: 'normal' });
        }
    }
    // 불가능한 팀 수는 팀 수를 바꾸지 않고 범위를 안내한다
    await c.admin('team-count', { teamCount: 3 });
    const bad = await c.admin('shuffle');
    rec.check('불가능한 팀 수(3팀) 안내', bad.status === 400 && /가능한 팀 수: 4~8팀/.test(bad.data.error ?? ''), bad.data.error);
}

const SCENARIOS = {
    weapons:   { title: '시나리오 A — 무기군별 실험체 랜덤', members: 16, run: scenarioWeapons },
    recruit32: { title: '시나리오 B — 32명 모집 후 16명 진행', members: 32, run: scenarioRecruit32 },
    teams:     { title: '시나리오 C — 팀 수 변경 (16명)',      members: 16, run: scenarioTeamCounts },
};

async function runScenario(name, { base, devToken }) {
    const sc = SCENARIOS[name];
    if (!sc) return { error: '알 수 없는 시나리오예요.' };
    const { eventId, adminToken } = createTestEvent({ memberCount: sc.members, label: name, type: name === 'teams' ? 'normal' : 'prize' });
    const c = { ...makeClient(base, eventId, adminToken, devToken), eventId };
    const rec = makeRecorder();
    const startedAt = Date.now();
    let fatal = null;
    try { await sc.run(c, rec); }
    catch (e) { fatal = e.message; }
    const failed = rec.steps.filter(s => !s.ok);
    return {
        success: !fatal && !failed.length,
        title: sc.title, eventId, adminToken,
        passed: rec.steps.length - failed.length, failed: failed.length,
        fatal, steps: rec.steps, ms: Date.now() - startedAt,
    };
}

module.exports = { runScenario, SCENARIOS, createTestEvent };
