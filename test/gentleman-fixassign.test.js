// 관리자가 배정을 고치는 기능(팀원 교환·개인 재추첨)과 그 팀만 다시 공지하는 동작을 확인한다
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadja-fx-'));
const origCwd = process.cwd();
process.chdir(workDir);
process.env.DEV_TOKEN = 'fx-dev';
process.env.GENTLEMAN_MOCK_DISCORD = '1';

const discord = require(path.join(origCwd, 'gentleman-discord.js'));
const W = require(path.join(origCwd, 'character-weapons.js'));
const db = require(path.join(origCwd, 'db.js'));
const web = require(path.join(origCwd, 'server.js'));
const PORT = 3600 + Math.floor(Math.random() * 80);
const B = `http://localhost:${PORT}`;
let server;

// 특정 팀의 전송만 실패시키기 위해 감싼다
const realSend = discord.sendWithRetry;
let failTeams = new Set();
discord.sendWithRetry = async (ev, payload, meta) => {
    if (failTeams.has(Number(meta?.teamNum))) return { ok: false, error: '일부러 실패시킨 전송' };
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
const fixes = () => discord.getMockOutbox(ctx.EV).filter(m => m.kind === 'gift-fix');
const raw = () => JSON.parse(fs.readFileSync(path.join(workDir, 'nadja-events.json'), 'utf-8')).events[ctx.EV].gentleman;

async function makeEvent({ type = 'normal' } = {}) {
    const c = await post('/api/gentleman/dev/create', { devToken: 'fx-dev', memberCount: 16, teamSize: 4, type });
    ctx.EV = c.data.eventId; ctx.AD = c.data.adminToken;
    ctx.A = (p, b = {}) => post(`/api/gentleman/admin/${p}`, { event: ctx.EV, token: ctx.AD, ...b });
    ctx.Aget = (p) => get(`/api/gentleman/admin/${p}?event=${ctx.EV}&token=${ctx.AD}`);
    // 고를 수 있는 실험체 목록 (질의 문자열이 더 붙는다)
    ctx.choicesOf = (teamNum, memberToken) =>
        get(`/api/gentleman/admin/assignments/choices?event=${ctx.EV}&token=${ctx.AD}`
            + `&teamNum=${teamNum}&memberToken=${encodeURIComponent(memberToken)}`);
    await ctx.A('start');
    await post('/api/gentleman/dev/auto-pick', { devToken: 'fx-dev', event: ctx.EV });
}

test('준비 — 교환·배정과 공지를 마친다', async () => {
    await makeEvent();
    const r = await ctx.A('finalize');
    assert.strictEqual(r.data.allPublished, true, r.data.publishError ?? '');
});

test('공지 전에는 참가자별 배정을 보여주지 않는다', async () => {
    // 별도 이벤트로 공지 전 상태를 만든다
    const keep = { EV: ctx.EV, AD: ctx.AD, A: ctx.A, Aget: ctx.Aget };
    await makeEvent();
    await ctx.A('finalize');                       // 자동 공지까지 되므로 공지 기록을 지워 상태를 흉내 낸다

    const before = await ctx.Aget('assignments');
    assert.strictEqual(before.data.available, true, '공지가 끝났으면 볼 수 있다');

    Object.assign(ctx, keep);                      // 원래 이벤트로 되돌린다
});

test('관리자 화면에 팀별 배정이 내려온다', async () => {
    const r = await ctx.Aget('assignments');
    assert.strictEqual(r.data.available, true);
    assert.strictEqual(r.data.editable, true, r.data.reason ?? '');
    assert.strictEqual(r.data.teams.length, 4);

    const t1 = r.data.teams.find(t => t.teamNum === 1);
    assert.strictEqual(t1.members.length, 4);
    for (const m of t1.members) {
        assert.ok(m.token && m.nickname, '참가자 정보가 있어야 한다');
        assert.ok(m.displayName, '실험체 표시 이름이 있어야 한다');
        assert.strictEqual(m.source, null, '처음에는 관리자 재배정 표시가 없다');
    }
    ctx.t1 = t1;
    ctx.t2 = r.data.teams.find(t => t.teamNum === 2);
});

// ── 1. 팀원끼리 교환 ──────────────────────────────────
test('1. 같은 팀 두 사람의 실험체를 맞바꾼다', async () => {
    const [a, b] = ctx.t1.members;
    const before = { a: a.character, b: b.character };

    const r = await ctx.A('assignments/swap', { teamNum: 1, tokenA: a.token, tokenB: b.token });
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.republished, true, r.data.publishError ?? '');

    const after = (await ctx.Aget('assignments')).data.teams.find(t => t.teamNum === 1);
    const na = after.members.find(m => m.token === a.token);
    const nb = after.members.find(m => m.token === b.token);
    assert.strictEqual(na.character, before.b, 'A가 B의 실험체를 받아야 한다');
    assert.strictEqual(nb.character, before.a, 'B가 A의 실험체를 받아야 한다');

    // 무기군·표시 이름도 함께 옮겨가야 한다
    assert.strictEqual(na.displayName, W.describe(before.b).displayName);
    assert.strictEqual(na.weaponName,  W.describe(before.b).weaponName);
    assert.strictEqual(na.source, null, '교환은 보내온 팀이 그대로이므로 출처를 바꾸지 않는다');
});

test('2. 다른 팀 사람과는 교환할 수 없다', async () => {
    const a = ctx.t1.members[0], other = ctx.t2.members[0];
    const r = await ctx.A('assignments/swap', { teamNum: 1, tokenA: a.token, tokenB: other.token });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /같은 팀/);
});

test('2-1. 같은 사람끼리는 교환할 수 없다', async () => {
    const a = ctx.t1.members[0];
    const r = await ctx.A('assignments/swap', { teamNum: 1, tokenA: a.token, tokenB: a.token });
    assert.strictEqual(r.status, 400);
});

test('교환해도 다른 팀의 배정은 그대로다', async () => {
    const t2 = (await ctx.Aget('assignments')).data.teams.find(t => t.teamNum === 2);
    assert.deepStrictEqual(t2.members.map(m => m.character), ctx.t2.members.map(m => m.character));
});

// ── 2. 실험체 직접 변경 ──────────────────────────────
test('3. 고를 수 있는 실험체 목록을 받는다 — 목록만 봐서는 아무것도 바뀌지 않는다', async () => {
    const teams = (await ctx.Aget('assignments')).data.teams;
    const t1 = teams.find(t => t.teamNum === 1);
    const target = t1.members[2];
    ctx.target = target;
    ctx.beforeAll = JSON.stringify(teams);

    const r = await ctx.choicesOf(1, target.token);
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.nickname, target.nickname);
    assert.strictEqual(r.data.current.character, target.character, '현재 실험체를 따로 알려줘야 한다');
    assert.ok(r.data.choices.length > 50, `고를 수 있는 실험체가 ${r.data.choices.length}개뿐이다`);

    for (const c of r.data.choices) {
        assert.ok(c.character && c.displayName && c.characterName, '표시에 필요한 정보가 있어야 한다');
    }
    ctx.choices = r.data.choices;

    const now = JSON.stringify((await ctx.Aget('assignments')).data.teams);
    assert.strictEqual(now, ctx.beforeAll, '목록을 보는 것만으로 배정이 바뀌면 안 된다');
});

test('4. 현재 실험체는 고를 수 있는 목록에 들어가지 않는다', () => {
    assert.ok(!ctx.choices.some(c => c.character === ctx.target.character),
        '자기 실험체가 후보에 들어 있다');
});

test('7. 고르기만 하고 확정하지 않으면 기존 배정이 유지된다', async () => {
    await ctx.choicesOf(1, ctx.target.token);
    const now = JSON.stringify((await ctx.Aget('assignments')).data.teams);
    assert.strictEqual(now, ctx.beforeAll);
});

test('3-1. 고른 실험체를 적용하면 그 사람만 바뀌고 출처가 관리자 재배정이 된다', async () => {
    ctx.chosen = ctx.choices[7];                        // 관리자가 직접 고른 셈
    const r = await ctx.A('assignments/set', {
        teamNum: 1, memberToken: ctx.target.token, character: ctx.chosen.character,
    });
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.republished, true, r.data.publishError ?? '');

    const t1 = (await ctx.Aget('assignments')).data.teams.find(t => t.teamNum === 1);
    const me = t1.members.find(m => m.token === ctx.target.token);
    assert.strictEqual(me.character, ctx.chosen.character, '고른 그대로 들어가야 한다');
    assert.strictEqual(me.source, 'admin', '관리자 재배정 표시가 붙어야 한다');
    assert.strictEqual(me.displayName, ctx.chosen.displayName);
});

test('3-2. 같은 실험체라도 무기군이 다르면 고를 수 있다', async () => {
    const t1 = (await ctx.Aget('assignments')).data.teams.find(t => t.teamNum === 1);
    const other = t1.members.find(m => m.token !== ctx.target.token && m.character != null);
    const 그사람실험체 = W.describe(other.character);

    const r = await ctx.choicesOf(1, ctx.target.token);
    const 같은실험체 = r.data.choices.filter(c => c.characterName === 그사람실험체.characterName);

    // 그 사람이 쓰는 조합은 빠지고, 같은 실험체의 다른 무기군은 남아 있어야 한다
    assert.ok(!r.data.choices.some(c => c.character === other.character), '쓰이는 조합이 남아 있다');
    const 무기군수 = W.allCandidates().filter(c => c.characterName === 그사람실험체.characterName).length;
    if (무기군수 > 1) {
        assert.ok(같은실험체.length > 0,
            `${그사람실험체.characterName}의 다른 무기군이 모두 빠졌다`);
    }
});

test('4. 같은 팀 다른 참가자의 실험체는 그대로다', async () => {
    const before = JSON.parse(ctx.beforeAll).find(t => t.teamNum === 1);
    const after  = (await ctx.Aget('assignments')).data.teams.find(t => t.teamNum === 1);
    for (const m of before.members) {
        if (m.token === ctx.target.token) continue;
        const now = after.members.find(x => x.token === m.token);
        assert.strictEqual(now.character, m.character, `${m.nickname}의 배정이 바뀌었다`);
        assert.strictEqual(now.source, null);
    }
});

test('4-1. 다른 팀의 배정도 그대로다', async () => {
    const before = JSON.parse(ctx.beforeAll).filter(t => t.teamNum !== 1);
    const after  = (await ctx.Aget('assignments')).data.teams.filter(t => t.teamNum !== 1);
    assert.deepStrictEqual(
        after.map(t => t.members.map(m => m.character)),
        before.map(t => t.members.map(m => m.character)));
});

test('5. 이미 쓰이고 있는 실험체·무기군은 고를 수 없다', async () => {
    const teams = (await ctx.Aget('assignments')).data.teams;
    const used = new Set();
    for (const t of teams) {
        for (const m of t.members) if (m.character != null) used.add(m.character);
        for (const l of t.leftover) used.add(l.character);
    }
    const target = teams.find(t => t.teamNum === 3).members[0];
    const r = await ctx.choicesOf(3, target.token);
    assert.ok(r.data.success, r.data.error);

    // 모든 팀의 배정과 미배정을 통틀어 쓰이는 조합은 하나도 들어 있으면 안 된다
    const 겹침 = r.data.choices.filter(c => used.has(c.character));
    assert.deepStrictEqual(겹침, [], `쓰이는 조합이 들어 있다: ${겹침.map(c => c.displayName).join(', ')}`);

    // 서버가 막는지도 확인한다 (화면을 거치지 않고 직접 보내는 경우)
    const 남의것 = teams.find(t => t.teamNum === 2).members[0].character;
    const bad = await ctx.A('assignments/set', { teamNum: 3, memberToken: target.token, character: 남의것 });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.data.error, /다른 참가자에게 배정된/);
});

test('5-1. 같은 실험체라도 무기군이 다르면 다른 후보로 본다', () => {
    const 재키 = W.allCandidates().filter(c => c.characterName === '재키');
    assert.ok(재키.length > 1, '재키는 무기군이 여러 개다');
    assert.strictEqual(new Set(재키.map(c => c.id)).size, 재키.length, '무기군마다 다른 ID여야 한다');
    const 알렉스 = W.allCandidates().filter(c => c.characterName === '알렉스');
    assert.strictEqual(알렉스.length, 1, '알렉스는 하나로 처리한다');
});

test('6. 밴한 실험체는 고를 수 없다', async () => {
    // 전부 밴하면 고를 수 있는 실험체가 없어야 한다
    const teams = (await ctx.Aget('assignments')).data.teams;
    const target = teams.find(t => t.teamNum === 4).members[0];

    const all = [...new Set(W.allCandidates().map(c => c.characterName))];
    db.setBannedCharacters(ctx.EV, all);                       // 전부 밴한다

    const none = await ctx.choicesOf(4, target.token);
    assert.strictEqual(none.data.choices.length, 0);
    assert.match(none.data.reason, /고를 수 있는 실험체가 없어요/);

    // 하나만 풀어 주면 그 실험체만 나와야 한다
    db.setBannedCharacters(ctx.EV, all.filter(n => n !== '재키'));
    const ok = await ctx.choicesOf(4, target.token);
    assert.ok(ok.data.choices.length > 0, ok.data.reason ?? '');
    assert.ok(ok.data.choices.every(c => c.characterName === '재키'),
        '밴하지 않은 실험체만 나와야 한다');

    // 밴된 실험체를 직접 보내도 막는다
    const 밴된후보 = W.allCandidates().find(c => c.characterName !== '재키');
    const bad = await ctx.A('assignments/set', { teamNum: 4, memberToken: target.token, character: 밴된후보.id });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.data.error, /밴된/);

    db.setBannedCharacters(ctx.EV, []);                        // 원래대로
});

// ── 3. 재공지 ────────────────────────────────────────
test('9. 수정한 팀만 다시 공지한다', async () => {
    const before = fixes().length;
    const t3 = (await ctx.Aget('assignments')).data.teams.find(t => t.teamNum === 3);
    const [a, b] = t3.members;

    const r = await ctx.A('assignments/swap', { teamNum: 3, tokenA: a.token, tokenB: b.token });
    assert.ok(r.data.success, r.data.error);

    const sent = fixes().slice(0, fixes().length - before);
    assert.strictEqual(sent.length, 1, '한 건만 올라가야 한다');
    assert.strictEqual(sent[0].teamNum, 3);
    assert.match(sent[0].content, /실험체 배정 수정 안내/);
    assert.ok(sent[0].files?.[0]?.bytes > 1000, '수정된 결과 이미지가 붙어야 한다');
    assert.ok(!/<@/.test(sent[0].content), '멘션이 들어가면 안 된다');
});

test('11. 수정 공지에 이전 결과와 헷갈리지 않도록 안내가 들어간다', () => {
    const last = fixes()[0];
    assert.match(last.content, /이전 결과 대신 아래 수정된 결과를 기준으로/);
});

test('10. 공지에 실패해도 수정 내용은 남고, 그 팀만 다시 보낼 수 있다', async () => {
    const t2 = (await ctx.Aget('assignments')).data.teams.find(t => t.teamNum === 2);
    const [a, b] = t2.members;
    const before = { a: a.character, b: b.character };

    failTeams = new Set([2]);
    const r = await ctx.A('assignments/swap', { teamNum: 2, tokenA: a.token, tokenB: b.token });
    assert.ok(r.data.success, '수정 자체는 성공해야 한다');
    assert.strictEqual(r.data.republished, false);
    assert.ok(r.data.publishError);

    // 전송에 실패해도 바뀐 배정은 저장돼 있어야 한다
    const after = (await ctx.Aget('assignments')).data.teams.find(t => t.teamNum === 2);
    assert.strictEqual(after.members.find(m => m.token === a.token).character, before.b);

    failTeams = new Set();
    const count = fixes().length;
    const retry = await ctx.A('assignments/republish', { teamNum: 2 });
    assert.ok(retry.data.success, retry.data.error);
    assert.strictEqual(fixes().length, count + 1, '다시 보내기로 한 건만 올라가야 한다');
    assert.strictEqual(fixes()[0].teamNum, 2);
});

test('8. 수정 결과가 저장돼 서버를 다시 읽어도 유지된다', () => {
    const g = raw();
    const t1 = g.assignments[1];
    const fixed = t1.members.find(m => m.source === 'admin');
    assert.ok(fixed, '관리자 재배정 표시가 저장돼야 한다');
    assert.ok(fixed.character != null && fixed.displayName, '실험체 정보도 함께 저장돼야 한다');
    assert.ok(g.teamFixes, '수정 공지 기록이 저장돼야 한다');
    assert.strictEqual(g.teamFixes[3].ok, true);
});

// ── 4. 투표·수상과의 충돌 ────────────────────────────
test('12. 투표가 열려 있으면 배정을 고칠 수 없다', async () => {
    await makeEvent({ type: 'prize' });
    await ctx.A('finalize');
    await ctx.A('winner', { teamNum: 1 });
    assert.ok((await ctx.A('vote/open')).data.success);

    const t1 = (await ctx.Aget('assignments')).data.teams.find(t => t.teamNum === 1);
    const [a, b] = t1.members;
    const r = await ctx.A('assignments/swap', { teamNum: 1, tokenA: a.token, tokenB: b.token });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /투표를 취소한 뒤/);

    const view = await ctx.Aget('assignments');
    assert.strictEqual(view.data.editable, false);
    assert.strictEqual(view.data.voteOpen, true);
});

test('12-1. 투표를 취소하면 다시 고칠 수 있다', async () => {
    assert.ok((await ctx.A('vote/cancel')).data.success);
    const view = await ctx.Aget('assignments');
    assert.strictEqual(view.data.editable, true, view.data.reason ?? '');

    const t1 = view.data.teams.find(t => t.teamNum === 1);
    const [a, b] = t1.members;
    const r = await ctx.A('assignments/swap', { teamNum: 1, tokenA: a.token, tokenB: b.token });
    assert.ok(r.data.success, r.data.error);
});

test('12-2. 고친 배정이 새로 연 투표 후보에 반영된다', async () => {
    // 우승팀(1팀)은 투표 후보에서 빠지므로 다른 팀에서 고친다
    const t3 = (await ctx.Aget('assignments')).data.teams.find(t => t.teamNum === 3);
    const target = t3.members[0];
    const list = await ctx.choicesOf(3, target.token);
    assert.ok(list.data.success, list.data.error);
    const chosen = list.data.choices[0];
    const applied = await ctx.A('assignments/set', { teamNum: 3, memberToken: target.token, character: chosen.character });
    assert.ok(applied.data.success, applied.data.error);

    assert.ok((await ctx.A('vote/open')).data.success);
    const voter = (await get(`/api/gentleman/dev/actors?devToken=fx-dev&event=${ctx.EV}`)).data
        .participants.find(p => p.teamNum === 2);
    const view = await get(`/api/gentleman/me/vote?event=${ctx.EV}&token=${voter.token}`);

    const cand = view.data.candidates.find(c => c.token === target.token);
    assert.ok(cand, '수정한 참가자가 투표 후보에 있어야 한다');
    assert.strictEqual(cand.character, chosen.character, '새 배정이 후보에 반영돼야 한다');
});

test('수상 결과가 나온 뒤에는 배정을 고칠 수 없다', async () => {
    await post('/api/gentleman/dev/auto-vote', { devToken: 'fx-dev', event: ctx.EV, mode: 'tie' });
    await ctx.A('vote/close');
    assert.ok((await ctx.A('unlucky/publish')).data.success);

    const t1 = (await ctx.Aget('assignments')).data.teams.find(t => t.teamNum === 1);
    const [a, b] = t1.members;
    const r = await ctx.A('assignments/swap', { teamNum: 1, tokenA: a.token, tokenB: b.token });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /수상 결과가 이미 발표/);
});
