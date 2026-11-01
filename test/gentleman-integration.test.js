// 「저쪽 신사분이 주신 겁니다」 통합 테스트
// 실제 Express 서버를 임시 포트로 띄우고 HTTP로 전 과정을 확인한다.
// 디스코드 전송은 Mock으로 처리되므로 토큰 없이도 돌아간다.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 테스트용 임시 작업 디렉터리에서 서버를 띄운다 (운영 데이터 파일과 섞이지 않게 한다)
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadja-gm-'));
const origCwd = process.cwd();
process.chdir(workDir);
process.env.DEV_TOKEN = 'test-dev-token';
process.env.GENTLEMAN_MOCK_DISCORD = '1';

const web = require(path.join(origCwd, 'server.js'));
const PORT = 3400 + Math.floor(Math.random() * 400);
const B = `http://localhost:${PORT}`;
const DEV = 'test-dev-token';
let server;

test.before(() => { server = web.start(PORT); });
test.after(() => {
    try { server?.close?.(); } catch {}
    process.chdir(origCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

const post = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
const get = (p) => fetch(B + p).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));

// 공용 상태 — 테스트가 순서대로 이어진다
const ctx = {};

test('테스트 이벤트를 만들면 참가자와 팀이 준비된다', async () => {
    const r = await post('/api/gentleman/dev/create', { devToken: DEV, memberCount: 16, teamSize: 4, type: 'prize' });
    assert.ok(r.data.success);
    assert.strictEqual(r.data.teamCount, 4);
    ctx.EV = r.data.eventId;
    ctx.ADM = r.data.adminToken;
    ctx.A = (p, b) => post(`/api/gentleman/admin/${p}`, { event: ctx.EV, token: ctx.ADM, ...b });
    ctx.Aget = (p) => get(`/api/gentleman/admin/${p}?event=${ctx.EV}&token=${ctx.ADM}`);
    ctx.P = (p, tok, b) => post(`/api/gentleman/me/${p}`, { event: ctx.EV, token: tok, ...b });
    ctx.Pget = (p, tok) => get(`/api/gentleman/me/${p}?event=${ctx.EV}&token=${tok}`);
    ctx.dev = (p, b) => post(`/api/gentleman/dev/${p}`, { devToken: DEV, event: ctx.EV, ...b });
    ctx.devg = (p) => get(`/api/gentleman/dev/${p}?devToken=${DEV}&event=${ctx.EV}`);
});

test('개발자 토큰이 틀리면 거부한다', async () => {
    const r = await post('/api/gentleman/dev/create', { devToken: 'wrong', memberCount: 8 });
    assert.strictEqual(r.status, 403);
});

test('관리자 토큰이 틀리면 관리자 API를 쓸 수 없다', async () => {
    const r = await post('/api/gentleman/admin/start', { event: ctx.EV, token: 'wrong-token' });
    assert.strictEqual(r.status, 403);
});

test('드래프트를 시작하면 팀마다 후보가 배정되고 안내 메시지가 나간다', async () => {
    const r = await ctx.A('start');
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.perTeam, 12);
    assert.ok(r.data.discord.ok);

    const out = await ctx.devg('outbox');
    const msg = out.data.messages.find(m => m.kind === 'draft-start');
    assert.ok(msg, '선택 안내 메시지가 기록돼야 한다');
    assert.ok(msg.buttons.includes('실험체 선택'), '선택 버튼이 포함돼야 한다');

    const actors = await ctx.devg('actors');
    ctx.members = actors.data.participants;
    ctx.team1 = ctx.members.filter(m => m.teamNum === 1);
});

test('한 팀에서는 한 명만 선택 권한을 가진다', async () => {
    const a = await ctx.P('lock', ctx.team1[0].token);
    const b = await ctx.P('lock', ctx.team1[1].token);
    assert.strictEqual(a.data.role, 'editor');
    assert.strictEqual(b.data.role, 'waiting');
});

test('다른 팀 참가자는 남의 팀 선택을 바꿀 수 없다', async () => {
    const other = ctx.members.find(m => m.teamNum === 2);
    const st = await ctx.Pget('state', ctx.team1[0].token);
    // 2팀 사람이 1팀 후보를 보내도 자기 팀에만 적용된다
    const r = await ctx.P('picks', other.token, { picks: st.data.candidates.slice(0, 2), rev: 0 });
    const t1 = await ctx.Pget('state', ctx.team1[0].token);
    assert.strictEqual(t1.data.pickedCount, 0, '1팀 선택이 바뀌면 안 된다');
    assert.ok(r.data.error || r.data.success !== undefined);
});

test('선택은 자동 저장되고 오래된 요청은 거부한다', async () => {
    const st = await ctx.Pget('state', ctx.team1[0].token);
    ctx.cands = st.data.candidates;
    const ok = await ctx.P('picks', ctx.team1[0].token, { picks: ctx.cands.slice(0, 2), rev: st.data.rev });
    assert.ok(ok.data.success);
    assert.strictEqual(ok.data.rev, st.data.rev + 1);

    const stale = await ctx.P('picks', ctx.team1[0].token, { picks: ctx.cands.slice(4, 6), rev: st.data.rev });
    assert.strictEqual(stale.status, 409, '오래된 요청은 409로 거부한다');
});

test('대기자와 다른 팀에게 선택 내용이 새지 않는다', async () => {
    const wait = await ctx.Pget('state', ctx.team1[1].token);
    assert.deepStrictEqual(wait.data.picks, []);
    assert.strictEqual(wait.data.pickedCount, 2);

    const other = ctx.members.find(m => m.teamNum === 2);
    const view = await ctx.Pget('state', other.token);
    const text = JSON.stringify(view.data);
    assert.ok(!ctx.cands.some(c => text.includes(c)), '다른 팀 후보가 노출되면 안 된다');
});

test('연결이 끊기면 대기자에게 권한이 넘어간다', async () => {
    const r = await ctx.dev('simulate-disconnect', { teamNum: 1 });
    assert.ok(r.data.success);
    assert.ok(r.data.newHolder, '대기자가 권한을 이어받아야 한다');
});

test('관리자 강제 확정은 저장된 선택을 유지하고 부족분만 채운다', async () => {
    const r = await ctx.A('force-confirm', { teamNum: 1 });
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.picks.length, 4);
    assert.strictEqual(r.data.autoFilled.length, 2);
    assert.deepStrictEqual(r.data.picks.slice(0, 2), ctx.cands.slice(0, 2));
});

test('진행 중에는 관리자에게도 선택한 실험체를 보여주지 않는다', async () => {
    const s = await ctx.Aget('state');
    assert.strictEqual(s.data.assignments, null, '공지 전 배정은 비공개');
    const dump = await ctx.devg('dump');
    const picks = dump.data.gentleman.teams['1'].picks;
    assert.ok(!picks.some(c => JSON.stringify(s.data.summary).includes(c)), '요약에 실험체 이름이 없어야 한다');
});

test('확정 취소 후 다시 확정할 수 있다', async () => {
    const un = await ctx.A('unconfirm', { teamNum: 1 });
    assert.ok(un.data.success);
    const s = await ctx.Aget('state');
    assert.strictEqual(s.data.summary.teams.find(t => t.teamNum === 1).confirmed, false);
    await ctx.A('force-confirm', { teamNum: 1 });
});

test('확정된 팀이 있으면 재추첨을 거부한다', async () => {
    const r = await ctx.A('redraw');
    assert.ok(r.data.error);
    assert.match(r.data.error, /확정/);
});

test('전 팀 확정 후 원형 교환과 배정이 이뤄진다', async () => {
    await ctx.dev('auto-pick');
    const r = await ctx.A('finalize');
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.order.length, 4);

    const dump = await ctx.devg('dump');
    const asg = dump.data.gentleman.assignments;
    for (const t of [1, 2, 3, 4]) {
        assert.notStrictEqual(asg[t].from, t, '자기 팀 선물을 받으면 안 된다');
        assert.strictEqual(asg[t].members.length, 4);
        assert.ok(asg[t].members.every(m => m.character), '전원이 실험체를 받아야 한다');
    }
    ctx.assignments = asg;
});

test('배정을 다시 호출해도 재추첨되지 않는다', async () => {
    const r = await ctx.A('finalize');
    assert.ok(r.data.already);
    const dump = await ctx.devg('dump');
    assert.deepStrictEqual(dump.data.gentleman.assignments, ctx.assignments);
});

test('팀별 결과 이미지가 생성되고 멘션 없이 공지된다', async () => {
    const r = await ctx.A('publish');
    assert.ok(r.data.success);
    assert.strictEqual(r.data.failed.length, 0);

    const out = await ctx.devg('outbox');
    const gifts = out.data.messages.filter(m => m.kind === 'gift-result');
    assert.strictEqual(gifts.length, 4);
    assert.ok(gifts.every(m => m.files[0]?.bytes > 1000), '이미지가 실제로 만들어져야 한다');
    assert.ok(gifts.every(m => !m.content.includes('<@')), '팀별 결과에는 멘션을 넣지 않는다');
});

test('이미 올린 팀은 건너뛰고 특정 팀만 다시 올릴 수 있다', async () => {
    const all = await ctx.A('publish');
    assert.ok(all.data.results.every(r => r.skipped));
    const one = await ctx.A('publish', { teamNum: 2 });
    assert.ok(one.data.results[0].ok && !one.data.results[0].skipped);
});

test('우승팀을 지정하고 멘션과 함께 공지한다', async () => {
    assert.ok((await ctx.A('winner', { teamNum: 1 })).data.success);
    const r = await ctx.A('winner/publish');
    assert.ok(r.data.success, r.data.error);

    const out = await ctx.devg('outbox');
    const msg = out.data.messages.find(m => m.kind === 'winner');
    assert.ok(msg.content.includes('<@'), '우승팀 공지에는 멘션이 들어간다');
    assert.ok(msg.files[0]?.bytes > 1000);
});

test('우승팀은 후보에서 빠지지만 투표권은 유지된다', async () => {
    const r = await ctx.A('vote/open');
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.candidateCount, 12);
    assert.strictEqual(r.data.voterCount, 16);

    const winner = ctx.members.find(m => m.teamNum === 1);
    const v = await ctx.Pget('vote', winner.token);
    assert.ok(v.data.available);
    assert.ok(!v.data.candidates.some(c => c.teamNum === 1));
    ctx.winnerMember = winner;
});

test('투표 진행 중에는 관리자도 집계를 볼 수 없다', async () => {
    const target = (await ctx.Pget('vote', ctx.winnerMember.token)).data.candidates[0];
    await ctx.P('vote', ctx.winnerMember.token, { candidate: target.token });

    const s = await ctx.Aget('state');
    assert.strictEqual(s.data.vote.tally, null);
    assert.ok(!JSON.stringify(s.data.vote).includes(target.token), '응답에 투표 대상이 담기면 안 된다');
    assert.strictEqual(s.data.vote.votedCount, 1);
    ctx.target = target;
});

test('자기 자신에게는 투표할 수 없다', async () => {
    const r = await ctx.P('vote', ctx.target.token, { candidate: ctx.target.token });
    assert.ok(r.data.error);
});

test('마감하면 0표 후보까지 집계하고 공동 1등을 낸다', async () => {
    await ctx.dev('auto-vote', { mode: 'tie' });
    const r = await ctx.A('vote/close');
    assert.ok(r.data.success);
    assert.strictEqual(r.data.tally.rows.length, 12);
    assert.ok(r.data.tally.winners.length >= 1);
    ctx.tally = r.data.tally;
});

test('불행상을 공지하면 수상자 멘션과 이미지가 나간다', async () => {
    const r = await ctx.A('unlucky/publish');
    assert.ok(r.data.success, r.data.error);
    if (!r.data.noWinner) {
        const out = await ctx.devg('outbox');
        const msg = out.data.messages.find(m => m.kind === 'unlucky');
        assert.ok(msg.content.includes('<@'));
        assert.ok(msg.files[0]?.bytes > 1000);
    }
});

test('결과를 공개한 뒤에는 투표를 다시 열 수 없다', async () => {
    const r = await ctx.A('vote/reopen');
    assert.ok(r.data.error);
});

test('공개된 수상자만 지급 상태를 바꿀 수 있다', async () => {
    const p = await ctx.Aget('payouts');
    assert.ok(p.data.rows.length > 0);
    const ok = await ctx.A('payout', { participantToken: p.data.rows[0].token, status: 'done' });
    assert.ok(ok.data.success);
    const bad = await ctx.A('payout', { participantToken: 'not-a-winner', status: 'done' });
    assert.ok(bad.data.error);
});

test('드래프트를 종료하지 않으면 다음 회차로 넘어갈 수 없다', async () => {
    const blocked = await ctx.A('next-round', { type: 'normal' });
    assert.ok(blocked.data.error);
    assert.match(blocked.data.error, /종료/);
});

test('다음 회차로 넘어가면 이전 기록이 초기화되고 옛 링크는 막힌다', async () => {
    await ctx.A('close-draft');
    const r = await ctx.A('next-round', { keepTeams: true, keepBans: true, type: 'normal' });
    assert.ok(r.data.success);
    assert.strictEqual(r.data.round, 2);

    const s = await ctx.Aget('state');
    assert.strictEqual(s.data.winnerTeam, null);
    assert.strictEqual(s.data.vote.status, 'none');
    assert.strictEqual(s.data.resultsPublished, false);

    const old = await ctx.Pget('vote', ctx.winnerMember.token);
    assert.ok(!old.data.available, '이전 회차 투표 링크는 쓸 수 없다');
});

test('서버를 다시 읽어도 저장된 상태가 유지된다', async () => {
    const dbPath = path.join(workDir, 'nadja-events.json');
    assert.ok(fs.existsSync(dbPath), '저장 파일이 있어야 한다');
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    assert.strictEqual(raw.events[ctx.EV].gentleman.round, 2, '회차가 파일에 남아야 한다');
    assert.ok(raw.events[ctx.EV].isTestEvent, '테스트 표시가 유지돼야 한다');
});

test('기존 기능이 그대로 동작한다 (회귀 확인)', async () => {
    // 참가자 조회·팀 배정 등 기존 관리자 API
    const data = await get(`/api/admin/data?event=${ctx.EV}&token=${ctx.ADM}`);
    assert.strictEqual(data.data.participants.length, 16);

    const shuffle = await post('/api/admin/shuffle', { event: ctx.EV, token: ctx.ADM });
    assert.ok(shuffle.data.success, '기존 자동 배정이 동작해야 한다');
    assert.ok(shuffle.data.sizes.every(s => s <= 4), '코발트 팀 인원 제한이 유지된다');

    const plan = await get(`/api/admin/team-plan?event=${ctx.EV}&token=${ctx.ADM}`);
    assert.ok(plan.data.count === 16);
});

test('테스트 이벤트는 삭제할 수 있고 운영 이벤트는 보호된다', async () => {
    // 운영 이벤트를 하나 만들어 시뮬레이터가 건드리지 못하는지 본다
    const db = require(path.join(origCwd, 'db.js'));
    db.createEvent('real-event-x', 'g', 'c', 'u', 2, '내전', '코발트');
    const blocked = await post('/api/gentleman/dev/delete', { devToken: DEV, event: 'real-event-x' });
    assert.strictEqual(blocked.status, 403, '운영 이벤트는 시뮬레이터로 삭제할 수 없다');
    assert.ok(db.getEvent('real-event-x'), '운영 이벤트가 남아 있어야 한다');

    const r = await ctx.dev('delete');
    assert.ok(r.data.success);
});
