// 실제 진행 인원 · 팀 수 직접 지정 · 균등 분배 테스트
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadja-tp-'));
const origCwd = process.cwd();
process.chdir(workDir);

const t = require(path.join(origCwd, 'teams.js'));
const db = require(path.join(origCwd, 'db.js'));

test.after(() => {
    process.chdir(origCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

const COBALT = { gameType: '내전', mapType: '코발트', teamCount: 2 };
const LUMIA  = { gameType: '내전', mapType: '루미아 섬', teamCount: 4 };

test('관리자가 정한 팀 수에 인원 차이 1명 이내로 균등 분배한다', () => {
    const cases = {
        '16:4': '4/4/4/4', '16:5': '4/3/3/3/3', '16:6': '3/3/3/3/2/2', '16:8': '2/2/2/2/2/2/2/2',
        '12:4': '3/3/3/3', '8:4': '2/2/2/2',
    };
    for (const [k, expect] of Object.entries(cases)) {
        const [n, teams] = k.split(':').map(Number);
        const p = t.planTeams(n, COBALT, teams);
        assert.ok(!p.error, p.error);
        assert.strictEqual(p.sizes.join('/'), expect, k);
    }
});

test('불가능한 팀 수는 바꾸지 않고 이유와 가능한 범위를 알려준다', () => {
    const tooFew = t.planTeams(16, COBALT, 3);
    assert.match(tooFew.error, /최대 4명/);
    assert.deepStrictEqual(tooFew.range, { min: 4, max: 8 });
    const tooMany = t.planTeams(16, COBALT, 9);
    assert.match(tooMany.error, /최소 2명/);
    // 루미아 섬은 한 팀 최대 3명
    assert.match(t.planTeams(16, LUMIA, 4).error, /최대 3명/);
    assert.strictEqual(t.planTeams(16, LUMIA, 6).sizes.join('/'), '3/3/3/3/2/2');
});

function makeEvent(id, n, mapType = '코발트') {
    db.createEvent(id, 'g', 'ch', 'u', 2, '내전', mapType);
    const tokens = [];
    for (let i = 0; i < n; i++) tokens.push(db.addParticipant(id, `d${i}`, `유저${i}`, `ig${i}`, '전사', '골드', [], 1000 + i));
    return tokens;
}
const sizesOf = id => {
    const by = {};
    for (const p of db.getParticipants(id)) if (p.team_num) by[p.team_num] = (by[p.team_num] ?? 0) + 1;
    return Object.keys(by).sort((a, b) => a - b).map(k => by[k]).join('/');
};

test('32명 중 16명만 선택하면 16명만 배정되고 나머지는 신청이 유지된 채 팀 미지정이다', () => {
    const tokens = makeEvent('ev32', 32);
    const chosen = tokens.slice(0, 16);
    db.setActiveParticipants('ev32', chosen);
    db.setManualTeamCount('ev32', 4);

    for (const mode of ['random', 'tier', 'random']) {
        const r = db.assignTeams('ev32', mode);
        assert.ok(!r.error, r.error);
        assert.strictEqual(sizesOf('ev32'), '4/4/4/4');
        assert.strictEqual(db.getEvent('ev32').teamCount, 4, '팀 수가 마음대로 바뀌면 안 된다');
    }
    const ps = db.getParticipants('ev32');
    assert.strictEqual(ps.length, 32, '신청 기록은 그대로');
    assert.ok(ps.filter(p => !chosen.includes(p.cancel_token)).every(p => !p.team_num && p.active === false));
});

test('팀 수를 줄이면 없어진 팀 번호가 참가자에게 남지 않는다', () => {
    const tokens = makeEvent('evShrink', 16);
    db.setManualTeamCount('evShrink', 8);
    db.assignTeams('evShrink', 'random');
    assert.strictEqual(sizesOf('evShrink'), '2/2/2/2/2/2/2/2');
    const r = db.setManualTeamCount('evShrink', 4);
    assert.strictEqual(r.cleared, 8);
    assert.ok(db.getParticipants('evShrink').every(p => !p.team_num || p.team_num <= 4));
    db.assignTeams('evShrink', 'tier');
    assert.strictEqual(sizesOf('evShrink'), '4/4/4/4');
    assert.strictEqual(tokens.length, 16);
});

test('불가능한 팀 수로 배정하면 아무것도 바꾸지 않는다', () => {
    makeEvent('evBad', 16);
    db.setManualTeamCount('evBad', 4);
    db.assignTeams('evBad', 'random');
    const before = sizesOf('evBad');
    db.setManualTeamCount('evBad', 3);
    const r = db.assignTeams('evBad', 'random');
    assert.match(r.error, /가능한 팀 수: 4~8팀/);
    assert.strictEqual(db.getEvent('evBad').teamCount, 3, '관리자가 정한 팀 수는 그대로 둔다');
    // 3팀으로 줄일 때 4팀 참가자는 미지정이 됐고, 그 외 배정은 그대로다
    assert.notStrictEqual(sizesOf('evBad'), '');
    assert.ok(before.startsWith(sizesOf('evBad').split('/')[0]));
});

test('수동 배정은 없는 팀 번호를 거부하고, 팀에 넣은 사람은 진행 인원이 된다', () => {
    const tokens = makeEvent('evManual', 6);
    db.setActiveParticipants('evManual', tokens.slice(0, 4));
    db.setManualTeamCount('evManual', 2);
    assert.match(db.assignTeam(tokens[0], 3).error, /3팀은 없어요/);
    assert.ok(db.assignTeam(tokens[5], 2).success);
    assert.strictEqual(db.getByToken(tokens[5]).active, true);
});

test('진행 인원 선택과 팀 수는 저장 파일에 남아 다시 읽어도 유지된다', () => {
    const tokens = makeEvent('evPersist', 10);
    db.setActiveParticipants('evPersist', tokens.slice(0, 8));
    db.setManualTeamCount('evPersist', 4);
    const raw = JSON.parse(fs.readFileSync(path.join(workDir, 'nadja-events.json'), 'utf-8'));
    assert.strictEqual(raw.events.evPersist.teamCount, 4);
    assert.strictEqual(raw.events.evPersist.teamCountManual, true);
    assert.strictEqual(Object.values(raw.participants).filter(p => p.event_id === 'evPersist' && p.active).length, 8);
});
