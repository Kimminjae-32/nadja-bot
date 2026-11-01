// 「저쪽 신사분이 주신 겁니다」 불행상 투표 테스트
const test = require('node:test');
const assert = require('node:assert');
const V = require('../gentleman-vote');

// 4팀 × 3명 = 12명, 배정 결과까지 갖춘 상황을 만든다
function fixture() {
    const participants = [];
    let i = 0;
    for (let t = 1; t <= 4; t++) {
        for (let k = 0; k < 3; k++) {
            i += 1;
            participants.push({ cancel_token: `t${i}`, discord_nickname: `유저${i}`, team_num: t, event_id: 'ev' });
        }
    }
    const assignments = {};
    for (let t = 1; t <= 4; t++) {
        const from = t === 1 ? 4 : t - 1;
        const members = participants.filter(p => p.team_num === t)
            .map((p, idx) => ({ token: p.cancel_token, nickname: p.discord_nickname, character: `실험체${t}-${idx}` }));
        assignments[t] = { from, received: [...members.map(m => m.character), `남은${t}`], members, leftover: [`남은${t}`] };
    }
    return { participants, assignments };
}

const openFixture = (winnerTeam = 1) => {
    const { participants, assignments } = fixture();
    const r = V.openVote(participants, assignments, winnerTeam);
    return { ...r, participants, assignments };
};

test('우승팀을 정하지 않으면 투표를 시작할 수 없다', () => {
    const { participants, assignments } = fixture();
    assert.ok(V.openVote(participants, assignments, null).error);
});

test('실험체 배정이 끝나지 않으면 투표를 시작할 수 없다', () => {
    const { participants } = fixture();
    assert.ok(V.openVote(participants, null, 1).error);
});

test('우승팀 참가자는 후보에서 빠지지만 투표권은 가진다', () => {
    const { vote } = openFixture(1);
    assert.strictEqual(vote.snapshot.candidates.length, 9, '12명 중 우승팀 3명 제외');
    assert.ok(vote.snapshot.candidates.every(c => c.teamNum !== 1));
    assert.strictEqual(vote.snapshot.voters.length, 12, '우승팀도 투표할 수 있다');
});

test('팀 미지정 참가자는 후보와 투표 대상에서 모두 빠진다', () => {
    const { participants, assignments } = fixture();
    participants.push({ cancel_token: 'none1', discord_nickname: '미지정', team_num: null, event_id: 'ev' });
    const { vote } = V.openVote(participants, assignments, 1);
    assert.ok(!vote.snapshot.candidates.some(c => c.token === 'none1'));
    assert.ok(!vote.snapshot.voters.some(v => v.token === 'none1'));
});

test('후보 카드에 배정 실험체와 선물한 팀이 담긴다', () => {
    const { vote } = openFixture(1);
    const c = vote.snapshot.candidates[0];
    assert.ok(c.character, '배정 실험체가 있어야 한다');
    assert.ok(c.fromTeam, '선물한 팀이 있어야 한다');
});

test('자기 자신에게는 투표할 수 없다', () => {
    const { vote } = openFixture(1);
    const me = vote.snapshot.candidates[0].token;
    assert.ok(V.castVote(vote, me, me).error);
});

test('같은 팀의 다른 사람에게는 투표할 수 있다', () => {
    const { vote } = openFixture(1);
    const sameTeam = vote.snapshot.candidates.filter(c => c.teamNum === 2);
    assert.ok(V.castVote(vote, sameTeam[0].token, sameTeam[1].token).success);
});

test('우승팀 참가자도 투표할 수 있다', () => {
    const { vote } = openFixture(1);
    const winner = vote.snapshot.voters.find(v => v.teamNum === 1);
    assert.ok(V.castVote(vote, winner.token, vote.snapshot.candidates[0].token).success);
});

test('투표 자격이 없는 사람과 후보가 아닌 대상은 거부한다', () => {
    const { vote } = openFixture(1);
    assert.ok(V.castVote(vote, '없는사람', vote.snapshot.candidates[0].token).error);
    assert.ok(V.castVote(vote, vote.snapshot.voters[0].token, '없는후보').error);
});

test('한 사람은 한 표만 가지며, 다시 투표하면 대상이 바뀐다', () => {
    const { vote } = openFixture(1);
    const voter = vote.snapshot.voters.find(v => v.teamNum === 1).token;
    const [a, b] = vote.snapshot.candidates;

    V.castVote(vote, voter, a.token);
    const second = V.castVote(vote, voter, b.token);
    assert.ok(second.changed, '변경으로 처리돼야 한다');
    assert.strictEqual(Object.keys(vote.votes).length, 1, '표가 늘어나면 안 된다');
    assert.strictEqual(vote.votes[voter], b.token);
});

test('마감 전에는 관리자도 득표수와 투표 내역을 볼 수 없다', () => {
    const { vote } = openFixture(1);
    const voter = vote.snapshot.voters[0].token;
    const target = vote.snapshot.candidates.find(c => c.token !== voter);
    V.castVote(vote, voter, target.token);

    const p = V.adminProgress(vote);
    assert.strictEqual(p.tally, null, '마감 전 집계는 공개하지 않는다');
    assert.strictEqual(p.votedCount, 1);
    assert.ok(p.voters.some(v => v.voted), '누가 투표했는지는 알려준다');

    const text = JSON.stringify(p);
    assert.ok(!text.includes(target.token), '투표 대상이 응답에 담기면 안 된다');
});

test('참가자 화면에는 자기 표만 보이고 다른 사람 표는 보이지 않는다', () => {
    const { vote } = openFixture(1);
    const [v1, v2] = vote.snapshot.voters;
    const target = vote.snapshot.candidates.find(c => c.token !== v1.token && c.token !== v2.token);
    V.castVote(vote, v1.token, target.token);
    V.castVote(vote, v2.token, target.token);

    const view = V.voterView(vote, v1.token);
    assert.strictEqual(view.myVote, target.token);
    assert.ok(!view.candidates.some(c => c.token === v1.token), '후보 목록에서 자신은 빠진다');
    assert.strictEqual(view.candidates.filter(c => c.votes != null).length, 0, '후보별 득표수가 들어가면 안 된다');
    assert.ok(!('votes' in view), '전체 투표 내역이 들어가면 안 된다');
});

test('마감하면 0표 후보까지 포함해 순위를 집계하고 공동 1등을 함께 낸다', () => {
    const { vote } = openFixture(1);
    const cands = vote.snapshot.candidates;
    const voters = vote.snapshot.voters.filter(v => v.token !== cands[0].token && v.token !== cands[1].token);
    // 2명씩 두 후보에게 몰아줘 공동 1등을 만든다
    V.castVote(vote, voters[0].token, cands[0].token);
    V.castVote(vote, voters[1].token, cands[0].token);
    V.castVote(vote, voters[2].token, cands[1].token);
    V.castVote(vote, voters[3].token, cands[1].token);

    const r = V.closeVote(vote);
    assert.ok(r.success);
    assert.strictEqual(vote.status, V.STATUS.CLOSED);
    assert.strictEqual(r.tally.rows.length, cands.length, '0표 후보도 포함한다');
    assert.strictEqual(r.tally.winners.length, 2, '공동 1등');
    assert.strictEqual(r.tally.topVotes, 2);
    assert.strictEqual(r.tally.rows.filter(x => x.rank === 1).length, 2, '같은 순위로 표기한다');
});

test('0표로 마감하면 수상자가 없다', () => {
    const { vote } = openFixture(1);
    const r = V.closeVote(vote);
    assert.strictEqual(r.tally.totalVotes, 0);
    assert.strictEqual(r.tally.winners.length, 0, '0표면 수상자 없음');
});

test('마감 후에는 투표할 수 없다', () => {
    const { vote } = openFixture(1);
    V.closeVote(vote);
    const voter = vote.snapshot.voters[0].token;
    assert.ok(V.castVote(vote, voter, vote.snapshot.candidates[0].token).error);
});

test('결과 공개 전이면 투표를 다시 열 수 있고 기존 표는 유지된다', () => {
    const { vote } = openFixture(1);
    const voter = vote.snapshot.voters[0].token;
    const target = vote.snapshot.candidates.find(c => c.token !== voter);
    V.castVote(vote, voter, target.token);
    V.closeVote(vote);

    assert.ok(V.reopenVote(vote, false).success);
    assert.strictEqual(vote.status, V.STATUS.OPEN);
    assert.strictEqual(Object.keys(vote.votes).length, 1, '표가 유지돼야 한다');
});

test('불행상 결과를 공개한 뒤에는 투표를 다시 열 수 없다', () => {
    const { vote } = openFixture(1);
    V.closeVote(vote);
    assert.ok(V.reopenVote(vote, true).error);
});

test('투표를 취소하면 표가 모두 삭제된다', () => {
    const { vote } = openFixture(1);
    const voter = vote.snapshot.voters[0].token;
    V.castVote(vote, voter, vote.snapshot.candidates.find(c => c.token !== voter).token);
    assert.ok(V.cancelVote(vote).success);
    assert.strictEqual(vote.status, V.STATUS.CANCELLED);
    assert.deepStrictEqual(vote.votes, {});
    assert.ok(V.voterView(vote, voter).error, '취소된 투표는 열 수 없다');
});

test('투표 시작 시점의 후보가 스냅샷으로 보존되어 팀이 바뀌어도 유지된다', () => {
    const { vote, participants } = openFixture(1);
    const before = JSON.stringify(vote.snapshot.candidates);
    participants.forEach(p => { p.team_num = 1; });        // 이후 전원 1팀으로 옮겨도
    assert.strictEqual(JSON.stringify(vote.snapshot.candidates), before, '진행 중 투표 후보는 변하지 않는다');
});
