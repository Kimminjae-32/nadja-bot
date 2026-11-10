// 실험체 교환에 이어 디스코드 공지가 자동으로 나가는지 확인한다
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadja-ap-'));
const origCwd = process.cwd();
process.chdir(workDir);
process.env.DEV_TOKEN = 'ap-dev';
process.env.GENTLEMAN_MOCK_DISCORD = '1';

const discord = require(path.join(origCwd, 'gentleman-discord.js'));
const web = require(path.join(origCwd, 'server.js'));
const PORT = 3500 + Math.floor(Math.random() * 120);
const B = `http://localhost:${PORT}`;
let server;

// 특정 팀의 전송만 실패시키기 위해 원래 함수를 감싼다
const realSend = discord.sendWithRetry;
let failTeams = new Set();
discord.sendWithRetry = async (ev, payload, meta) => {
    if (meta?.kind === 'gift-result' && failTeams.has(Number(meta.teamNum)))
        return { ok: false, error: '일부러 실패시킨 전송' };
    return realSend(ev, payload, meta);
};

test.before(() => { server = web.start(PORT); });
test.after(() => {
    discord.sendWithRetry = realSend;
    try { server?.close?.(); } catch {}
    process.chdir(origCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
const get = (p) => fetch(B + p).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));

const ctx = {};
const mockCards = () => discord.getMockOutbox(ctx.EV).filter(m => m.kind === 'gift-result');

test('준비 — 4개 팀이 모두 확정한 상태를 만든다', async () => {
    const c = await post('/api/gentleman/dev/create', { devToken: 'ap-dev', memberCount: 16, teamSize: 4, type: 'prize' });
    ctx.EV = c.data.eventId; ctx.AD = c.data.adminToken;
    ctx.A = (p, b = {}) => post(`/api/gentleman/admin/${p}`, { event: ctx.EV, token: ctx.AD, ...b });
    ctx.state = async () => (await get(`/api/gentleman/admin/state?event=${ctx.EV}&token=${ctx.AD}`)).data;

    await ctx.A('start');
    await post('/api/gentleman/dev/auto-pick', { devToken: 'ap-dev', event: ctx.EV });
    const s = await ctx.state();
    assert.strictEqual(s.allConfirmed, true);
    assert.strictEqual(s.exchangeReady, false);
    assert.strictEqual(s.resultsPublished, false);
});

test('교환 버튼 한 번으로 배정과 공지가 함께 끝난다', async () => {
    const r = await ctx.A('finalize');
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.published, true, '공지가 함께 나가야 한다');
    assert.strictEqual(r.data.allPublished, true);
    assert.strictEqual(r.data.failed.length, 0);
    assert.ok(Array.isArray(r.data.order), '교환 순서가 정해져야 한다');

    const s = await ctx.state();
    assert.strictEqual(s.exchangeReady, true);
    assert.strictEqual(s.resultsPublished, true);
    assert.strictEqual(s.phase, 'published');
    ctx.assignments = JSON.stringify((await ctx.state()).summary);
});

test('팀마다 결과 이미지가 정확히 한 번씩, 팀 번호 순서대로 올라간다', () => {
    const cards = mockCards();
    assert.strictEqual(cards.length, 4, `${cards.length}건이 올라갔다`);

    const byTeam = cards.map(m => m.teamNum).sort((a, b) => a - b);
    assert.deepStrictEqual(byTeam, [1, 2, 3, 4], '팀마다 한 번씩이어야 한다');

    // 보관함은 최신 항목이 앞이므로 뒤집으면 보낸 순서가 된다
    assert.deepStrictEqual([...cards].reverse().map(m => m.teamNum), [1, 2, 3, 4], '팀 번호 순서로 보내야 한다');
    for (const m of cards) {
        assert.ok(m.files?.[0]?.bytes > 1000, `${m.teamNum}팀 이미지가 비었다`);
        assert.match(m.content, /보내온 실험체입니다/, '문구가 실험체 표현이어야 한다');
        assert.ok(!/선물/.test(m.content), `'선물' 표현이 남아 있다: ${m.content}`);
    }
});

test('한 번 더 눌러도 다시 보내지 않는다', async () => {
    const before = mockCards().length;
    const r = await ctx.A('finalize');
    assert.strictEqual(r.data.already, true, '배정은 이미 끝나 있어야 한다');
    assert.ok(r.data.results.every(x => x.skipped), '모든 팀을 건너뛰어야 한다');
    assert.strictEqual(mockCards().length, before, '메시지가 더 올라갔다');
});

test('동시에 눌러도 한 번만 처리된다', async () => {
    const before = mockCards().length;
    const [a, b] = await Promise.all([ctx.A('finalize'), ctx.A('finalize')]);
    assert.ok([a.status, b.status].every(s => s === 200 || s === 409));
    assert.strictEqual(mockCards().length, before, '동시 실행으로 메시지가 더 올라갔다');
});

test('팀 지정 재게시는 그대로 동작한다', async () => {
    const before = mockCards().length;
    const r = await ctx.A('publish', { teamNum: 2 });
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.results.length, 1);
    assert.strictEqual(r.data.results[0].teamNum, 2);
    assert.strictEqual(r.data.results[0].ok, true);
    assert.strictEqual(mockCards().length, before + 1, '지정한 팀만 한 번 더 올라가야 한다');
});

// ── 전송이 실패하는 경우 ──────────────────────────────
test('일부 팀 전송이 실패하면 공지 완료로 표시하지 않는다', async () => {
    const c = await post('/api/gentleman/dev/create', { devToken: 'ap-dev', memberCount: 16, teamSize: 4, type: 'normal' });
    ctx.EV = c.data.eventId; ctx.AD = c.data.adminToken;
    ctx.A = (p, b = {}) => post(`/api/gentleman/admin/${p}`, { event: ctx.EV, token: ctx.AD, ...b });
    ctx.state = async () => (await get(`/api/gentleman/admin/state?event=${ctx.EV}&token=${ctx.AD}`)).data;

    await ctx.A('start');
    await post('/api/gentleman/dev/auto-pick', { devToken: 'ap-dev', event: ctx.EV });

    failTeams = new Set([2, 4]);
    const r = await ctx.A('finalize');
    assert.ok(r.data.success);
    assert.strictEqual(r.data.allPublished, false, '일부 실패면 완료가 아니다');
    assert.strictEqual(r.data.failed.length, 2);

    const s = await ctx.state();
    assert.strictEqual(s.exchangeReady, true, '배정은 끝나 있어야 한다');
    assert.strictEqual(s.resultsPublished, false, '공지 완료로 표시하면 안 된다');
    assert.notStrictEqual(s.phase, 'published');
    assert.strictEqual(s.teamMessages[1].ok, true);
    assert.strictEqual(s.teamMessages[2].ok, false);
    assert.strictEqual(s.teamMessages[4].ok, false);

    // 실패해도 배정 결과는 그대로 남는다
    const raw = JSON.parse(fs.readFileSync(path.join(workDir, 'nadja-events.json'), 'utf-8'));
    ctx.savedAssign = JSON.stringify(raw.events[ctx.EV].gentleman.assignments);
    assert.ok(ctx.savedAssign.length > 10);
});

test('다시 보내면 실패한 팀만 보내고 배정 결과는 그대로다', async () => {
    const before = mockCards().length;
    failTeams = new Set();                      // 이번에는 성공하게 둔다

    const r = await ctx.A('publish');
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.allPublished, true);

    const sent = r.data.results.filter(x => !x.skipped).map(x => x.teamNum).sort();
    assert.deepStrictEqual(sent, [2, 4], '실패했던 팀만 다시 보내야 한다');
    assert.strictEqual(mockCards().length, before + 2, '성공한 팀까지 또 보냈다');

    const raw = JSON.parse(fs.readFileSync(path.join(workDir, 'nadja-events.json'), 'utf-8'));
    assert.strictEqual(JSON.stringify(raw.events[ctx.EV].gentleman.assignments), ctx.savedAssign,
        '재시도로 배정 결과가 바뀌면 안 된다');
    assert.strictEqual(raw.events[ctx.EV].gentleman.resultsPublished, true, '완료 여부가 저장돼야 한다');
});

test('공지가 모두 끝난 뒤 교환을 다시 눌러도 아무것도 보내지 않는다', async () => {
    const before = mockCards().length;
    const r = await ctx.A('finalize');
    assert.strictEqual(r.data.already, true);
    assert.strictEqual(mockCards().length, before);
});
