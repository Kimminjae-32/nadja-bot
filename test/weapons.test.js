// 실험체 × 무기군 후보 테스트
const test = require('node:test');
const assert = require('node:assert');
const W = require('../character-weapons');
const D = require('../gentleman-draft');
const { CHAR_CODE, CHARACTERS } = require('../constants');

test('모든 실험체가 무기군 데이터를 가지고, 후보 ID는 겹치지 않는다', () => {
    for (const code of Object.keys(CHAR_CODE)) assert.ok(W.SNAPSHOT[code]?.length, `${CHAR_CODE[code]} 무기군 없음`);
    const all = W.allCandidates();
    const ids = all.map(c => c.id);
    assert.strictEqual(new Set(ids).size, ids.length, '후보 ID 중복');
    // 실험체 이름 목록과 코드 목록이 같은 실험체를 가리키는지
    assert.deepStrictEqual([...new Set(all.map(c => c.characterName))].sort(), [...CHARACTERS].sort());
});

test('재키는 무기군 4개로 나뉘고 알렉스는 하나만 있다', () => {
    const all = W.allCandidates();
    const jackie = all.filter(c => c.characterName === '재키');
    assert.deepStrictEqual(jackie.map(c => c.displayName), ['단검 재키', '양손검 재키', '도끼 재키', '쌍검 재키']);
    assert.deepStrictEqual(jackie.map(c => c.id), ['1:15', '1:16', '1:14', '1:18']);

    const alex = all.filter(c => c.characterName === '알렉스');
    assert.strictEqual(alex.length, 1);
    assert.strictEqual(alex[0].id, '27');
    assert.strictEqual(alex[0].weaponName, null);
});

test('무기군이 하나인 실험체는 후보도 하나다', () => {
    const hart = W.allCandidates().filter(c => c.characterName === '하트');
    assert.deepStrictEqual(hart.map(c => c.displayName), ['기타 하트']);
});

test('밴은 실험체 단위로 모든 무기군에 적용된다', () => {
    const pool = W.candidatePool(['재키', '피오라']);
    assert.ok(!pool.some(c => c.characterName === '재키' || c.characterName === '피오라'));
    assert.strictEqual(pool.length, W.allCandidates().length - 4 - 3);
});

test('후보 ID·표시 이름·이전 데이터의 실험체 이름을 모두 해석한다', () => {
    assert.strictEqual(W.describe('1:16').displayName, '양손검 재키');
    assert.strictEqual(W.describe('양손검 재키').id, '1:16');
    assert.strictEqual(W.describe('알렉스').id, '27');
    const legacy = W.describe('재키');               // 이전 회차에 저장된 이름만 있는 값
    assert.strictEqual(legacy.characterName, '재키');
    assert.strictEqual(legacy.weaponName, null);
});

test('드래프트 후보는 실험체+무기군 ID이며, 같은 실험체의 다른 무기군은 별도 후보다', () => {
    const ps = Array.from({ length: 16 }, (_, i) => ({ cancel_token: `t${i}`, discord_nickname: `u${i}`, team_num: (i % 8) + 1 }));
    let sawSplit = false;
    for (let k = 0; k < 30; k++) {
        const st = D.createState();
        const r = D.startDraft(st, ps, ['알렉스']);
        assert.ok(!r.error, r.error);
        const drawn = Object.values(st.teams).flatMap(t => t.candidates);
        assert.strictEqual(new Set(drawn).size, drawn.length, '같은 실험체+무기군이 두 번 뽑히면 안 된다');
        assert.ok(drawn.every(id => W.describe(id).id === id), '후보는 무기군 ID여야 한다');
        assert.ok(!drawn.includes('27'), '밴한 알렉스가 나오면 안 된다');
        const names = drawn.map(id => W.describe(id).characterName);
        if (names.length !== new Set(names).size) sawSplit = true;
    }
    assert.ok(sawSplit, '같은 실험체의 다른 무기군이 함께 뽑히는 경우가 있어야 한다');
});

test('배정 결과에 무기군 표시 정보가 함께 저장된다', () => {
    const ps = Array.from({ length: 8 }, (_, i) => ({ cancel_token: `t${i}`, discord_nickname: `u${i}`, team_num: (i % 2) + 1 }));
    const st = D.createState();
    D.startDraft(st, ps, []);
    for (const t of [1, 2]) {
        const team = st.teams[t];
        const m = ps.find(p => p.team_num === t);
        D.acquireLock(team, m.cancel_token, m.discord_nickname);
        D.savePicks(team, m.cancel_token, team.candidates.slice(0, 4), team.rev);
        D.confirmTeam(team, m.cancel_token);
    }
    const r = D.finalizeAssignments(st, ps);
    assert.ok(r.success);
    for (const a of Object.values(r.assignments)) {
        for (const m of a.members) assert.strictEqual(m.displayName, W.describe(m.character).displayName);
    }
});

test('공식 API 응답을 검증해서 쓰고, 이상한 응답이면 기존 데이터를 유지한다', async () => {
    const before = W.status();
    // 실험체가 빠진 응답 → 거부
    const partial = await W.refreshFromApi({
        apiKey: 'x',
        fetchImpl: async () => ({ json: async () => ({ data: [{ code: 1, weapon1: 'OneHandSword' }] }) }),
    });
    assert.strictEqual(partial.ok, false);
    assert.deepStrictEqual(W.status(), before);

    // 네트워크 오류 → 거부
    const failed = await W.refreshFromApi({ apiKey: 'x', fetchImpl: async () => { throw new Error('timeout'); } });
    assert.strictEqual(failed.ok, false);

    // 키가 없으면 시도하지 않는다
    assert.strictEqual((await W.refreshFromApi({ apiKey: '' })).ok, false);
});
