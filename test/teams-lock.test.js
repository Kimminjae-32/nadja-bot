// 팀 고정(잠금) 기능 테스트 — 고정한 참가자는 다시 섞어도 그 팀에 남아야 한다
const test = require('node:test');
const assert = require('node:assert');
const t = require('../teams');

const LUMIA  = { gameType: '내전', mapType: '루미아 섬', teamCount: 8 };
const COBALT = { gameType: '내전', mapType: '코발트', teamCount: 2 };

// teamSizes 모양대로 참가자를 만들고 팀을 배정해 둔다
function seeded(teamSizes, tier = null) {
    const list = [];
    let i = 0;
    teamSizes.forEach((size, idx) => {
        for (let k = 0; k < size; k++) {
            i += 1;
            list.push({ cancel_token: `t${i}`, discord_nickname: `유저${i}`, team_num: idx + 1, tier, mmr: 0, locked: false });
        }
    });
    return list;
}

const lockedOf = list => list.filter(p => p.locked);
const teamOf = (teams, token) => teams.findIndex(team => team.some(p => p.cancel_token === token)) + 1;

function runAssign(list, ev, mode = 'random') {
    const locked = list.filter(p => p.locked && p.team_num);
    let sizes = t.getTeamDistribution(list.length, ev);
    if (locked.length) {
        const maxLockedTeam = Math.max(...locked.map(p => p.team_num));
        while (sizes.length < maxLockedTeam) sizes.push(0);
        sizes = t.adjustSizesForLocks(sizes, t.countLockedByTeam(locked), t.maxTeamSize(ev));
    }
    const teams = mode === 'tier' ? t.distributeByTier(list, sizes, locked) : t.distributeRandom(list, sizes, locked);
    return { teams, sizes, locked };
}

test('고정한 참가자는 여러 번 섞어도 같은 팀에 남는다', () => {
    for (const mode of ['random', 'tier']) {
        const list = seeded([4, 4, 4, 4]);
        list[0].locked = true;                       // 1팀 유저1
        list[5].locked = true;                       // 2팀 유저6
        list[10].locked = true;                      // 3팀 유저11

        for (let i = 0; i < 30; i++) {
            const { teams } = runAssign(list, LUMIA, mode);
            assert.strictEqual(teamOf(teams, 't1'), 1, `${mode}: 유저1은 1팀에 남아야 한다`);
            assert.strictEqual(teamOf(teams, 't6'), 2, `${mode}: 유저6은 2팀에 남아야 한다`);
            assert.strictEqual(teamOf(teams, 't11'), 3, `${mode}: 유저11은 3팀에 남아야 한다`);
        }
    }
});

test('고정하지 않은 참가자는 실제로 섞인다', () => {
    const list = seeded([4, 4, 4, 4]);
    list[0].locked = true;
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
        const { teams } = runAssign(list, LUMIA, 'random');
        seen.add(teamOf(teams, 't2'));               // 고정하지 않은 유저2
    }
    assert.ok(seen.size > 1, '고정하지 않은 참가자는 팀이 바뀌어야 한다');
});

test('고정이 있어도 전원 배정되고 중복이 없다', () => {
    for (const mode of ['random', 'tier']) {
        const list = seeded([3, 3, 3, 3, 3, 3, 3]);  // 21명
        [0, 1, 4, 9, 14, 20].forEach(i => { list[i].locked = true; });

        const { teams, sizes } = runAssign(list, LUMIA, mode);
        const flat = teams.flat();
        assert.strictEqual(flat.length, list.length, `${mode}: 전원 배정`);
        assert.strictEqual(new Set(flat.map(p => p.cancel_token)).size, list.length, `${mode}: 중복 없음`);
        assert.ok(t.validateTeamDistribution(teams, list, LUMIA, sizes), `${mode}: 검증 통과`);
    }
});

test('고정이 있어도 한 팀 최대 인원을 넘지 않는다', () => {
    for (const mode of ['random', 'tier']) {
        // 1팀에 3명을 모두 고정한 상태로 다시 섞는다
        const list = seeded([3, 3, 3, 3, 3, 3, 3]);
        list.filter(p => p.team_num === 1).forEach(p => { p.locked = true; });

        const { teams } = runAssign(list, LUMIA, mode);
        assert.ok(Math.max(...teams.map(x => x.length)) <= 3, `${mode}: 루미아에서 4명 팀이 생기면 안 된다`);
        assert.strictEqual(teams[0].length, 3, `${mode}: 고정된 1팀은 3명 그대로`);
    }
});

test('코발트에서도 고정을 지키면서 4명 상한을 넘지 않는다', () => {
    const list = seeded([4, 4]);
    list[0].locked = true;
    list[1].locked = true;
    for (let i = 0; i < 20; i++) {
        const { teams } = runAssign(list, COBALT, 'random');
        assert.ok(Math.max(...teams.map(x => x.length)) <= 4, '5명 팀이 생기면 안 된다');
        assert.strictEqual(teamOf(teams, 't1'), 1);
        assert.strictEqual(teamOf(teams, 't2'), 1);
    }
});

test('전원 고정이면 팀 구성이 그대로 유지된다', () => {
    const list = seeded([4, 4, 4, 4]);
    list.forEach(p => { p.locked = true; });
    const { teams } = runAssign(list, LUMIA, 'random');
    for (const p of list) assert.strictEqual(teamOf(teams, p.cancel_token), p.team_num);
});

test('고정이 없으면 기존 동작과 같다', () => {
    const list = seeded([3, 3, 3, 3, 3, 3, 3]);
    const { teams, sizes } = runAssign(list, LUMIA, 'random');
    assert.strictEqual(sizes.length, 7);
    assert.ok(sizes.every(x => x === 3));
    assert.ok(t.validateTeamDistribution(teams, list, LUMIA, sizes));
});

test('고정 인원이 몰려도 목표 인원이 최대치를 넘지 않게 조정된다', () => {
    // 1팀에 3명 고정 + 전체 10명 → 루미아 기준 4팀이 필요하다
    const sizes = t.adjustSizesForLocks([3, 3, 2, 2], { 1: 3 }, 3);
    assert.strictEqual(sizes.reduce((a, b) => a + b, 0), 10, '총 인원은 유지된다');
    assert.ok(sizes[0] >= 3, '고정 인원만큼 자리를 확보한다');
    assert.ok(Math.max(...sizes) <= 3, '최대 인원을 넘지 않는다');
});

test('티어 고정 배정도 실력 쏠림을 줄인다', () => {
    const V = Object.fromEntries(require('../constants').TIERS.map(x => [x.name, x.value]));
    const list = [
        ...seeded([3], '이터니티'),
        ...seeded([3], '골드').map(p => ({ ...p, cancel_token: p.cancel_token + 'b', team_num: 2 })),
        ...seeded([3], '아이언').map(p => ({ ...p, cancel_token: p.cancel_token + 'c', team_num: 3 })),
    ];
    list[0].locked = true;                            // 최상위 한 명만 1팀 고정

    let maxGap = 0;
    for (let i = 0; i < 50; i++) {
        const { teams } = runAssign(list, LUMIA, 'tier');
        const sums = teams.map(team => team.reduce((s, p) => s + (V[p.tier] ?? 0), 0));
        maxGap = Math.max(maxGap, Math.max(...sums) - Math.min(...sums));
    }
    // 고정 때문에 완전 균등은 불가능하지만 한쪽에 몰리지는 않아야 한다
    assert.ok(maxGap <= V['이터니티'], `티어 합계 차이가 ${maxGap}로 너무 크다`);
});
