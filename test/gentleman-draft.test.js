// 「저쪽 신사분이 주신 겁니다」 드래프트 로직 테스트
const test = require('node:test');
const assert = require('node:assert');
const D = require('../gentleman-draft');
const { CHARACTERS } = require('../constants');

// 참가자 n명을 teamCount개 팀에 고르게 넣어 만든다
function makeParticipants(teamSizes) {
    const list = [];
    let i = 0;
    teamSizes.forEach((size, idx) => {
        for (let k = 0; k < size; k++) {
            i += 1;
            list.push({ cancel_token: `tok${i}`, discord_nickname: `유저${i}`, team_num: idx + 1, event_id: 'ev' });
        }
    });
    return list;
}

const freshDraft = (teamSizes, banned = []) => {
    const participants = makeParticipants(teamSizes);
    const state = D.createState();
    const r = D.startDraft(state, participants, banned);
    return { state, participants, r };
};

test('팀당 후보 수를 min(12, 전체÷팀수)로 계산한다', () => {
    assert.strictEqual(D.candidateCount(88, 4), 12);      // 넉넉하면 12명
    assert.strictEqual(D.candidateCount(88, 8), 11);      // 88 / 8 = 11
    assert.strictEqual(D.candidateCount(20, 4), 5);
    assert.strictEqual(D.candidateCount(10, 4), 2);       // 최소치 미만
});

test('드래프트를 시작하면 팀마다 후보가 생기고 서로 겹치지 않는다', () => {
    const { state, r } = freshDraft([4, 4, 4, 4]);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.teamCount, 4);
    assert.strictEqual(r.perTeam, 12);

    const all = [];
    for (const t of [1, 2, 3, 4]) {
        assert.strictEqual(state.teams[t].candidates.length, 12);
        all.push(...state.teams[t].candidates);
    }
    assert.strictEqual(new Set(all).size, all.length, '팀 간 후보가 중복되면 안 된다');
    assert.strictEqual(state.phase, D.PHASE.DRAFTING);
});

test('밴 목록의 실험체는 후보에서 제외된다', () => {
    const banned = CHARACTERS.slice(0, 10);
    const { state } = freshDraft([4, 4], banned);
    const all = [...state.teams[1].candidates, ...state.teams[2].candidates];
    for (const b of banned) assert.ok(!all.includes(b), `밴된 ${b}가 후보에 있으면 안 된다`);
});

test('후보가 팀당 4명 미만이면 시작을 거부한다', () => {
    const participants = makeParticipants([2, 2, 2, 2]);
    const state = D.createState();
    const pool = CHARACTERS.slice(0, 12);                  // 12명 ÷ 4팀 = 3명
    const r = D.startDraft(state, participants, [], pool);
    assert.ok(r.error, '거부해야 한다');
    assert.match(r.error, /시작할 수 없어요/);
});

test('팀이 1팀뿐이면 시작할 수 없다', () => {
    const { r } = freshDraft([4]);
    assert.ok(r.error);
});

test('선택 권한은 한 명만 가지고, 나머지는 대기 상태가 된다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    assert.strictEqual(D.acquireLock(team, 'tok1', '유저1').role, 'editor');
    assert.strictEqual(D.acquireLock(team, 'tok2', '유저2').role, 'waiting');
    assert.strictEqual(D.acquireLock(team, 'tok1', '유저1').role, 'editor');   // 재요청은 연장
});

test('권한을 반납하면 먼저 대기한 사람에게 넘어간다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    D.acquireLock(team, 'tok2', '유저2');
    D.acquireLock(team, 'tok3', '유저3');
    D.releaseLock(team, 'tok1');
    assert.strictEqual(team.lock.token, 'tok2', '먼저 대기한 유저2가 받아야 한다');
});

test('90초 동안 신호가 없으면 권한이 만료되고 대기자에게 넘어간다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    D.acquireLock(team, 'tok2', '유저2');
    team.lock.expiresAt = Date.now() - 1;                  // 만료 상황을 만든다
    D.reapLock(team);
    assert.strictEqual(team.lock.token, 'tok2');
});

test('관리자가 권한을 강제 해제하면 대기열도 비운다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    D.acquireLock(team, 'tok2', '유저2');
    D.forceReleaseLock(team);
    assert.strictEqual(team.lock, null);
    assert.strictEqual(team.waiting.length, 0);
});

test('권한 없는 사람의 저장은 거부한다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    const r = D.savePicks(team, 'tok2', team.candidates.slice(0, 2), 0);
    assert.ok(r.error);
    assert.strictEqual(r.code, 'no_lock');
});

test('오래된 요청(rev 불일치)은 최신 선택을 덮어쓰지 못한다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    D.savePicks(team, 'tok1', team.candidates.slice(0, 2), 0);     // rev 1
    const late = D.savePicks(team, 'tok1', team.candidates.slice(4, 5), 0);  // 낡은 rev
    assert.strictEqual(late.code, 'stale');
    assert.strictEqual(team.picks.length, 2, '최신 선택이 유지돼야 한다');
});

test('4명을 넘겨 보내도 4명까지만 저장된다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    D.savePicks(team, 'tok1', team.candidates.slice(0, 8), 0);
    assert.strictEqual(team.picks.length, 4);
});

test('후보에 없는 실험체와 중복은 걸러낸다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    const c = team.candidates;
    D.savePicks(team, 'tok1', [c[0], c[0], '존재하지않는실험체', c[1]], 0);
    assert.deepStrictEqual(team.picks, [c[0], c[1]]);
});

test('4명을 채워야 확정할 수 있다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    D.savePicks(team, 'tok1', team.candidates.slice(0, 3), 0);
    assert.ok(D.confirmTeam(team, 'tok1').error, '3명으로는 확정 불가');

    D.savePicks(team, 'tok1', team.candidates.slice(0, 4), 1);
    assert.ok(D.confirmTeam(team, 'tok1').success);
    assert.strictEqual(team.confirmed, true);
    assert.strictEqual(team.lock, null, '확정하면 권한을 회수한다');
});

test('강제 확정은 저장된 선택을 유지하고 부족분만 채운다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    D.savePicks(team, 'tok1', team.candidates.slice(0, 2), 0);
    const kept = [...team.picks];

    const r = D.forceConfirmTeam(team);
    assert.ok(r.success);
    assert.strictEqual(team.picks.length, 4);
    assert.deepStrictEqual(team.picks.slice(0, 2), kept, '기존 선택은 그대로여야 한다');
    assert.strictEqual(r.autoFilled.length, 2);
    for (const c of r.autoFilled) assert.ok(team.candidates.includes(c), '자동 추가도 후보 안에서 골라야 한다');
    assert.strictEqual(team.lock, null, '권한을 즉시 회수한다');
});

test('강제 확정 뒤 도착한 수정 요청은 반영되지 않는다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    D.savePicks(team, 'tok1', team.candidates.slice(0, 2), 0);
    D.forceConfirmTeam(team);
    const before = [...team.picks];
    const late = D.savePicks(team, 'tok1', team.candidates.slice(5, 9), team.rev);
    assert.ok(late.error);
    assert.deepStrictEqual(team.picks, before);
});

test('확정을 취소하면 선택은 남고 다시 수정할 수 있다', () => {
    const { state } = freshDraft([3, 3]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    D.savePicks(team, 'tok1', team.candidates.slice(0, 4), 0);
    D.confirmTeam(team, 'tok1');
    const picks = [...team.picks];

    assert.ok(D.unconfirmTeam(team).success);
    assert.strictEqual(team.confirmed, false);
    assert.deepStrictEqual(team.picks, picks);
    assert.strictEqual(D.acquireLock(team, 'tok2', '유저2').role, 'editor');
});

// 전 팀 확정까지 진행시키는 보조 함수
function confirmAll(state, participants) {
    for (const t of D.teamNumbers(participants)) {
        const team = state.teams[t];
        const member = participants.find(p => p.team_num === t);
        D.acquireLock(team, member.cancel_token, member.discord_nickname);
        D.savePicks(team, member.cancel_token, team.candidates.slice(0, 4), team.rev);
        D.confirmTeam(team, member.cancel_token);
    }
}

test('원형 교환은 모든 팀이 한 번씩 주고받는 하나의 사이클이다', () => {
    for (const sizes of [[4, 4], [4, 4, 4], [3, 3, 3, 3], [2, 2, 2, 2, 2], [4, 4, 4, 4, 4, 4, 4]]) {
        const { state, participants } = freshDraft(sizes);
        confirmAll(state, participants);
        const r = D.finalizeAssignments(state, participants);
        assert.ok(r.success, r.error);

        const teams = D.teamNumbers(participants);
        const givers = Object.values(state.exchange.giverOf);
        assert.strictEqual(new Set(givers).size, teams.length, '주는 팀이 겹치면 안 된다');
        assert.strictEqual(state.exchange.order.length, teams.length, '모든 팀이 사이클에 포함돼야 한다');
        for (const t of teams) assert.notStrictEqual(state.exchange.giverOf[t], t, '자기 선물을 받으면 안 된다');

        // 사이클 한 바퀴로 전부 순회하는지 (1:1 맞교환으로 쪼개지지 않았는지)
        let cur = teams[0], steps = 0;
        const seen = new Set();
        do { seen.add(cur); cur = state.exchange.giverOf[cur]; steps += 1; } while (cur !== teams[0] && steps <= teams.length);
        assert.strictEqual(seen.size, teams.length, `${sizes.length}팀이 한 사이클이어야 한다`);
    }
});

test('받은 실험체를 팀원 수만큼 배정하고 나머지는 미배정으로 남긴다', () => {
    const { state, participants } = freshDraft([4, 3, 2, 4]);
    confirmAll(state, participants);
    D.finalizeAssignments(state, participants);

    const expect = { 1: 4, 2: 3, 3: 2, 4: 4 };
    for (const [t, size] of Object.entries(expect)) {
        const a = state.assignments[t];
        assert.strictEqual(a.members.length, size);
        assert.strictEqual(a.members.filter(m => m.character).length, size, `${t}팀 전원이 실험체를 받아야 한다`);
        assert.strictEqual(a.leftover.length, 4 - size, `${t}팀 미배정은 ${4 - size}명`);
        const chars = a.members.map(m => m.character);
        assert.strictEqual(new Set(chars).size, chars.length, '같은 실험체를 두 명이 받으면 안 된다');
        // 받은 실험체는 선물한 팀이 고른 것과 같아야 한다
        assert.deepStrictEqual([...a.received].sort(), [...state.teams[a.from].picks].sort());
        assert.deepStrictEqual([...chars, ...a.leftover].sort(), [...a.received].sort());
    }
});

test('확정하지 않은 팀이 있으면 배정하지 않는다', () => {
    const { state, participants } = freshDraft([4, 4]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    D.savePicks(team, 'tok1', team.candidates.slice(0, 4), 0);
    D.confirmTeam(team, 'tok1');
    const r = D.finalizeAssignments(state, participants);
    assert.ok(r.error);
    assert.match(r.error, /확정하지 않은 팀/);
});

test('배정은 한 번만 이뤄지고 다시 호출해도 결과가 바뀌지 않는다', () => {
    const { state, participants } = freshDraft([4, 4, 4]);
    confirmAll(state, participants);
    D.finalizeAssignments(state, participants);
    const snapshot = JSON.stringify(state.assignments);

    const again = D.finalizeAssignments(state, participants);
    assert.ok(again.already, '이미 배정됐음을 알려야 한다');
    assert.strictEqual(JSON.stringify(state.assignments), snapshot, '재추첨되면 안 된다');
});

test('관리자 요약에는 진행 중 선택한 실험체 이름이 들어가지 않는다', () => {
    const { state, participants } = freshDraft([4, 4]);
    const team = state.teams[1];
    D.acquireLock(team, 'tok1', '유저1');
    D.savePicks(team, 'tok1', team.candidates.slice(0, 3), 0);

    const s = D.adminSummary(state, participants);
    const text = JSON.stringify(s);
    for (const c of team.picks) assert.ok(!text.includes(c), `관리자 요약에 ${c}가 노출되면 안 된다`);
    assert.strictEqual(s.teams[0].picked, 3);
    assert.strictEqual(s.teams[0].status, '선택 중');
    assert.strictEqual(s.teams[0].holder, '유저1');
});

test('참가자 화면은 자기 팀 정보만 담고 대기자에게는 선택 내용을 숨긴다', () => {
    const { state, participants } = freshDraft([3, 3]);
    const team = state.teams[1];
    const [p1, p2] = participants.filter(p => p.team_num === 1);
    D.acquireLock(team, p1.cancel_token, p1.discord_nickname);
    D.savePicks(team, p1.cancel_token, team.candidates.slice(0, 3), 0);

    const editorView = D.participantView(state, p1, participants);
    assert.strictEqual(editorView.role, 'editor');
    assert.strictEqual(editorView.picks.length, 3);

    const waitView = D.participantView(state, p2, participants);
    assert.strictEqual(waitView.role, 'waiting');
    assert.deepStrictEqual(waitView.picks, [], '대기자에게는 선택 내용을 보여주지 않는다');
    assert.strictEqual(waitView.pickedCount, 3, '진행률은 알려준다');
    assert.strictEqual(waitView.holderNickname, p1.discord_nickname);

    // 다른 팀 후보가 섞여 들어가지 않는지
    // 후보 ID("27" 등)는 숫자라 문자열 포함 여부로 보면 타임스탬프와 겹칠 수 있다. 목록을 직접 비교한다.
    const shown = new Set([...waitView.candidates, ...Object.keys(waitView.candidateInfo), ...waitView.picks]);
    for (const c of state.teams[2].candidates) assert.ok(!shown.has(c), '다른 팀 후보가 노출되면 안 된다');
});
