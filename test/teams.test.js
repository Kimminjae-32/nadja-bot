// 팀 분배 로직 회귀 테스트 (기존 기능 보호용)
const test = require('node:test');
const assert = require('node:assert');
const t = require('../teams');

const LUMIA  = { gameType: '내전', mapType: '루미아 섬', teamCount: 8 };
const COBALT = { gameType: '내전', mapType: '코발트', teamCount: 2 };
const TOUR   = { gameType: '내전', mapType: '코발트 토너먼트', teamCount: 4 };
const LONE   = { gameType: '론울프', mapType: '루미아 섬' };

const mk = (n, tier = null) => Array.from({ length: n }, (_, i) => ({
    cancel_token: `t${i}_${Math.random().toString(36).slice(2, 7)}`,
    discord_nickname: `유저${i}`, tier, mmr: 0,
}));

test('루미아 섬은 인원에 맞춰 팀 수를 정하고 한 팀 3명을 넘지 않는다', () => {
    const cases = { 16: 8, 17: 6, 20: 7, 21: 7, 24: 8, 18: 6, 12: 4, 6: 2 };
    for (const [n, expectTeams] of Object.entries(cases)) {
        const sizes = t.getTeamDistribution(Number(n), LUMIA);
        assert.strictEqual(sizes.length, expectTeams, `${n}명 → ${expectTeams}팀`);
        assert.strictEqual(sizes.reduce((a, b) => a + b, 0), Number(n), '전원 배정');
        assert.ok(Math.max(...sizes) <= 3, `${n}명: 3명 초과 팀이 없어야 한다`);
        assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${n}명: 팀 간 차이는 1명 이하`);
        assert.ok(sizes.every(s => s > 0), '빈 팀 금지');
    }
});

test('코발트는 한 팀 4명을 넘지 않는다', () => {
    for (const n of [4, 7, 8, 9, 12, 20, 33]) {
        const sizes = t.getTeamDistribution(n, COBALT);
        assert.ok(Math.max(...sizes) <= 4, `${n}명: 5명 팀이 생기면 안 된다`);
        assert.strictEqual(sizes.reduce((a, b) => a + b, 0), n);
    }
});

test('코발트 토너먼트의 기존 팀 수를 유지한다', () => {
    assert.deepStrictEqual(t.getTeamDistribution(16, TOUR), [4, 4, 4, 4]);
});

test('론울프는 1인 1팀이다', () => {
    assert.deepStrictEqual(t.getTeamDistribution(5, LONE), [1, 1, 1, 1, 1]);
});

test('실제 배정에서도 최대 인원을 넘지 않고 검증을 통과한다', () => {
    for (const n of [13, 16, 17, 20, 21, 24]) {
        const ps = mk(n);
        const sizes = t.getTeamDistribution(n, LUMIA);
        for (const teams of [t.distributeRandom(ps, sizes), t.distributeByTier(ps, sizes)]) {
            assert.ok(Math.max(...teams.map(x => x.length)) <= 3, `${n}명: 3명 초과 팀`);
            assert.ok(t.validateTeamDistribution(teams, ps, LUMIA, sizes), `${n}명: 검증 실패`);
        }
    }
});

test('티어 배정은 팀 간 실력 차를 좁히면서도 매번 다른 조합을 만든다', () => {
    const sample = [...mk(7, '이터니티'), ...mk(7, '골드'), ...mk(7, '아이언')];
    const sizes = t.getTeamDistribution(21, LUMIA);
    const V = Object.fromEntries(require('../constants').TIERS.map(x => [x.name, x.value]));

    let maxGap = 0;
    const combos = new Set();
    for (let i = 0; i < 100; i++) {
        const teams = t.distributeByTier(sample, sizes);
        const sums = teams.map(team => team.reduce((s, p) => s + V[p.tier], 0));
        maxGap = Math.max(maxGap, Math.max(...sums) - Math.min(...sums));
        combos.add(teams.map(x => x.map(p => p.discord_nickname).sort().join('+')).sort().join('|'));
    }
    assert.ok(maxGap <= 3, `팀 간 티어 합계 차이가 ${maxGap}로 너무 크다`);
    assert.ok(combos.size > 20, `조합이 ${combos.size}가지뿐 — 무작위성이 부족하다`);
});

test('티어 미설정자가 있어도 오류 없이 배정된다', () => {
    const mixed = [...mk(5, '다이아몬드'), ...mk(5), ...mk(5, '브론즈')];
    const sizes = t.getTeamDistribution(15, LUMIA);
    const teams = t.distributeByTier(mixed, sizes);
    assert.strictEqual(teams.flat().length, 15);
    assert.ok(t.validateTeamDistribution(teams, mixed, LUMIA, sizes));
});

test('검증 함수가 중복·누락·초과를 잡아낸다', () => {
    const ps = mk(6);
    const sizes = t.getTeamDistribution(6, LUMIA);
    const good = t.distributeRandom(ps, sizes);
    assert.ok(t.validateTeamDistribution(good, ps, LUMIA, sizes));

    // 아래 세 건은 일부러 잘못된 결과를 넣어 검증이 걸러내는지 본다 (콘솔에 오류 로그가 남는다)
    assert.ok(!t.validateTeamDistribution([[...ps]], ps, LUMIA, [6]), '최대 인원 초과를 잡아야 한다');
    assert.ok(!t.validateTeamDistribution([[ps[0]], [ps[0]]], ps, LUMIA, [1, 1]), '중복 배정을 잡아야 한다');
    assert.ok(!t.validateTeamDistribution([good[0], []], ps, LUMIA, sizes), '빈 팀을 잡아야 한다');
});
