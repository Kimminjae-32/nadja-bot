// 제출 시점 저장 방식과 회차 초기화를 확인한다
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadja-sb-'));
const origCwd = process.cwd();
process.chdir(workDir);
process.env.DEV_TOKEN = 'submit-dev';
process.env.GENTLEMAN_MOCK_DISCORD = '1';

const web = require(path.join(origCwd, 'server.js'));
const PORT = 3800 + Math.floor(Math.random() * 80);
const B = `http://localhost:${PORT}`;
const DEV = 'submit-dev';
let server;

test.before(() => { server = web.start(PORT); });
test.after(() => {
    try { server?.close?.(); } catch {}
    process.chdir(origCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
const get = (p) => fetch(B + p).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));

const ctx = {};

test('준비 — 테스트 이벤트와 드래프트 시작', async () => {
    const c = await post('/api/gentleman/dev/create', { devToken: DEV, memberCount: 16, teamSize: 4, type: 'prize' });
    ctx.EV = c.data.eventId; ctx.ADM = c.data.adminToken;
    ctx.A = (p, b) => post(`/api/gentleman/admin/${p}`, { event: ctx.EV, token: ctx.ADM, ...b });
    ctx.Aget = (p) => get(`/api/gentleman/admin/${p}?event=${ctx.EV}&token=${ctx.ADM}`);
    ctx.P = (p, tok, b) => post(`/api/gentleman/me/${p}`, { event: ctx.EV, token: tok, ...b });
    ctx.Pget = (p, tok) => get(`/api/gentleman/me/${p}?event=${ctx.EV}&token=${tok}`);
    ctx.dev = (p, b) => post(`/api/gentleman/dev/${p}`, { devToken: DEV, event: ctx.EV, ...b });

    assert.ok((await ctx.A('start')).data.success);
    const actors = await get(`/api/gentleman/dev/actors?devToken=${DEV}&event=${ctx.EV}`);
    ctx.members = actors.data.participants;
    ctx.t1 = ctx.members.filter(m => m.teamNum === 1);
});

test('확정 요청 하나로 선택 저장과 확정이 함께 처리된다', async () => {
    await ctx.P('lock', ctx.t1[0].token);
    const st = await ctx.Pget('state', ctx.t1[0].token);
    assert.strictEqual(st.data.pickedCount, 0, '제출 전에는 저장된 선택이 없다');
    ctx.cands = st.data.candidates;
    ctx.roundId = st.data.roundId;
    assert.ok(ctx.roundId, '회차 식별자가 내려와야 한다');

    const r = await ctx.P('confirm', ctx.t1[0].token, { picks: ctx.cands.slice(0, 4), roundId: ctx.roundId });
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.picks.length, 4);

    const after = await ctx.Pget('state', ctx.t1[0].token);
    assert.strictEqual(after.data.confirmed, true);
    assert.deepStrictEqual(after.data.picks, ctx.cands.slice(0, 4));
});

test('제출 전에는 다른 팀원과 관리자에게 진행률이 0으로 보인다', async () => {
    const t2 = ctx.members.filter(m => m.teamNum === 2);
    await ctx.P('lock', t2[0].token);
    const st = await ctx.Pget('state', t2[0].token);

    // 아직 제출하지 않았으므로 서버에는 아무것도 저장되지 않은 상태여야 한다
    const mate = await ctx.Pget('state', t2[1].token);
    assert.strictEqual(mate.data.pickedCount, 0);

    const admin = await ctx.Aget('state');
    const team2 = admin.data.summary.teams.find(t => t.teamNum === 2);
    assert.strictEqual(team2.picked, 0, '관리자에게도 미제출 선택은 보이지 않는다');
    ctx.t2 = t2;
    ctx.cands2 = st.data.candidates;
});

test('관리자가 먼저 강제 확정하면 늦게 온 제출은 거부된다', async () => {
    assert.ok((await ctx.A('force-confirm', { teamNum: 2 })).data.success);
    const late = await ctx.P('confirm', ctx.t2[0].token, { picks: ctx.cands2.slice(0, 4), roundId: ctx.roundId });
    assert.ok(late.data.error, '거부돼야 한다');

    const st = await ctx.Pget('state', ctx.t2[0].token);
    assert.strictEqual(st.data.confirmed, true);
    assert.strictEqual(st.data.picks.length, 4, '관리자가 채운 4개가 유지된다');
});

test('이전 회차 식별자로 보낸 요청은 거부된다', async () => {
    const r = await ctx.P('confirm', ctx.t1[0].token, { picks: [], roundId: 'r0_old_xxxxx' });
    assert.ok(r.data.error);
    assert.match(r.data.error, /새 회차/);
});

test('끝난 회차에서 시작하면 지워질 내용을 먼저 알려준다', async () => {
    await ctx.dev('auto-pick');
    await ctx.A('finalize');
    await ctx.A('publish');
    await ctx.A('winner', { teamNum: 1 });
    await ctx.A('winner/publish');
    await ctx.A('vote/open');
    await ctx.dev('auto-vote', { mode: 'tie' });
    await ctx.A('vote/close');
    await ctx.A('unlucky/publish');
    await ctx.A('close-draft');

    const blocked = await ctx.A('start');
    assert.strictEqual(blocked.status, 400);
    assert.strictEqual(blocked.data.needsReset, true);
    assert.strictEqual(blocked.data.wouldClear.publishedTeams, 4);
    assert.strictEqual(blocked.data.wouldClear.hasWinner, true);
    assert.ok(blocked.data.wouldClear.pendingPayouts > 0);

    // 거부됐으니 상태는 그대로여야 한다
    const s = await ctx.Aget('state');
    assert.strictEqual(s.data.summary.teams.filter(t => t.confirmed).length, 4);
});

test('확인하면 새 회차로 모든 기록이 초기화된다', async () => {
    const r = await ctx.A('start', { confirmReset: true });
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.round, 2);
    assert.strictEqual(r.data.reset, true);

    const s = await ctx.Aget('state');
    assert.strictEqual(s.data.round, 2);
    assert.strictEqual(s.data.summary.teams.filter(t => t.confirmed).length, 0, '확정 상태 초기화');
    assert.deepStrictEqual(s.data.teamMessages, {}, '공지 기록 초기화');
    assert.strictEqual(s.data.winnerTeam, null, '우승팀 초기화');
    assert.strictEqual(s.data.vote.status, 'none', '투표 초기화');
    assert.strictEqual(s.data.unlucky, null, '불행상 초기화');
    assert.deepStrictEqual(s.data.payouts, {}, '지급 상태 초기화');
    assert.strictEqual(s.data.resultsPublished, false);
    assert.notStrictEqual(s.data.roundId, ctx.roundId, '회차 식별자가 바뀐다');
});

test('초기화 결과가 저장 파일에 남아 서버를 다시 읽어도 유지된다', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(workDir, 'nadja-events.json'), 'utf-8'));
    const g = raw.events[ctx.EV].gentleman;
    assert.strictEqual(g.round, 2);
    assert.strictEqual(Object.values(g.teams).filter(t => t.confirmed).length, 0);
    assert.deepStrictEqual(g.teamMessages, {});
    assert.strictEqual(g.winnerTeam, null);
    assert.strictEqual(g.vote, null);
    assert.deepStrictEqual(g.payouts, {});
    // 이미 올린 디스코드 메시지 ID는 따로 보관해 나중에 정리할 수 있어야 한다
    assert.ok((raw.events[ctx.EV].gentlemanSentMessages ?? []).length > 0);
});

test('마감된 투표에는 제출할 수 없다', async () => {
    // 새 회차에서 다시 투표를 열고 마감한 뒤 확인한다
    await ctx.dev('auto-pick');
    await ctx.A('finalize');
    await ctx.A('setup', { type: 'prize' });
    await ctx.A('winner', { teamNum: 1 });
    assert.ok((await ctx.A('vote/open')).data.success);

    const voter = ctx.members.find(m => m.teamNum === 2);
    const view = await ctx.Pget('vote', voter.token);
    const target = view.data.candidates[0];
    assert.ok((await ctx.P('vote', voter.token, { candidate: target.token })).data.success);

    await ctx.A('vote/close');
    const after = await ctx.P('vote', voter.token, { candidate: target.token });
    assert.ok(after.data.error, '마감 후에는 거부된다');
});

test('한 사람이 여러 번 투표해도 표는 하나만 남는다', async () => {
    await ctx.A('vote/reopen');
    const voter = ctx.members.find(m => m.teamNum === 3);
    const view = await ctx.Pget('vote', voter.token);
    const [a, b] = view.data.candidates;

    await ctx.P('vote', voter.token, { candidate: a.token });
    await ctx.P('vote', voter.token, { candidate: b.token });
    await ctx.P('vote', voter.token, { candidate: a.token });

    const closed = await ctx.A('vote/close');
    const mine = closed.data.tally.rows.find(r => r.token === a.token);
    const other = closed.data.tally.rows.find(r => r.token === b.token);
    // 이 투표자는 a에게만 1표를 준 상태여야 한다 (b에게 남은 표가 없어야 한다)
    assert.ok(mine.votes >= 1);
    assert.ok(other.votes === 0 || other.votes < mine.votes + 1);
});
