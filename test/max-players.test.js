// 모집 중에 모집 정원만 바꾸는 기능을 확인한다
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadja-cap-'));
const origCwd = process.cwd();
process.chdir(workDir);
process.env.DEV_TOKEN = 'cap-dev';
process.env.GENTLEMAN_MOCK_DISCORD = '1';

const web = require(path.join(origCwd, 'server.js'));
const PORT = 3700 + Math.floor(Math.random() * 80);
const B = `http://localhost:${PORT}`;
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

test('준비 — 테스트 이벤트를 만든다', async () => {
    const c = await post('/api/gentleman/dev/create', { devToken: 'cap-dev', memberCount: 2, teamSize: 4, type: 'normal' });
    ctx.EV = c.data.eventId; ctx.AD = c.data.adminToken;
    ctx.cap  = n => post('/api/admin/max-players', { event: ctx.EV, token: ctx.AD, maxPlayers: n });
    ctx.join = n => post('/join', { event: ctx.EV, discord_nickname: '유저' + n, ingame_nickname: 'u' + n, position: '전사' });
    ctx.data = async () => (await get(`/api/admin/data?event=${ctx.EV}&token=${ctx.AD}`)).data;
    ctx.count = async () => (await ctx.data()).participants.length;
    assert.strictEqual(await ctx.count(), 2);
});

test('모집 정원을 정하면 저장되고 신청을 그만큼만 받는다', async () => {
    const r = await ctx.cap(8);
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual((await ctx.data()).event.maxPlayers, 8);

    for (let i = await ctx.count(); i < 8; i++) {
        const j = await ctx.join(i);
        assert.ok(!j.data.error, `${i}번 신청 실패: ${j.data.error}`);
    }
    assert.strictEqual(await ctx.count(), 8);

    const over = await ctx.join(99);
    assert.strictEqual(over.status, 409);
    assert.match(over.data.error, /모두 찼어요/);
});

test('모집 중에 정원을 늘리면 바로 추가 신청을 받는다', async () => {
    assert.ok((await ctx.cap(16)).data.success);
    for (let i = 10; i <= 17; i++) {
        const j = await ctx.join(i);
        assert.ok(!j.data.error, `${i}번 신청 실패: ${j.data.error}`);
    }
    assert.strictEqual(await ctx.count(), 16);
    assert.strictEqual((await ctx.join(98)).status, 409, '새 정원까지 차면 다시 막힌다');
});

test('정원을 바꿔도 신청자와 팀 수는 그대로다', async () => {
    const before = await ctx.data();
    assert.ok((await ctx.cap(32)).data.success);
    const after = await ctx.data();

    assert.strictEqual(after.participants.length, before.participants.length);
    assert.strictEqual(after.event.teamCount, before.event.teamCount);
    assert.deepStrictEqual(
        after.participants.map(p => p.cancel_token),
        before.participants.map(p => p.cancel_token),
        '참가자 토큰이 그대로 남아야 한다');
});

test('이미 신청한 인원보다 적은 정원으로는 줄일 수 없다', async () => {
    const n = await ctx.count();
    const r = await ctx.cap(n - 1);
    assert.ok(r.data.error);
    assert.match(r.data.error, /적게 줄일 수 없어요/);
    assert.strictEqual((await ctx.data()).event.maxPlayers, 32, '거부됐으니 값이 그대로다');

    const same = await ctx.cap(n);
    assert.ok(same.data.success, '신청 인원과 같은 값은 허용한다');
});

test('허용 범위를 벗어난 값은 거부한다', async () => {
    for (const bad of [33, 1, 0, -5, 'abc', null]) {
        const r = await ctx.cap(bad);
        assert.ok(r.data.error, `${bad}이(가) 통과됐다`);
    }
});

test('관리자 토큰이 없으면 바꿀 수 없다', async () => {
    const r = await post('/api/admin/max-players', { event: ctx.EV, token: 'wrong', maxPlayers: 20 });
    assert.strictEqual(r.status, 403);
});

test('바뀐 정원은 저장 파일에 남아 서버를 다시 읽어도 유지된다', async () => {
    const n = await ctx.count();
    assert.ok((await ctx.cap(n + 4)).data.success);
    const raw = JSON.parse(fs.readFileSync(path.join(workDir, 'nadja-events.json'), 'utf-8'));
    assert.strictEqual(raw.events[ctx.EV].maxPlayers, n + 4);
});

test('신청 정보 수정은 정원이 가득 차 있어도 막지 않는다', async () => {
    assert.ok((await ctx.cap(await ctx.count())).data.success);   // 딱 맞게 채운다
    const me = (await ctx.data()).participants[0];
    const r = await post('/join', {
        event: ctx.EV, token: me.cancel_token,
        discord_nickname: '이름바꿈', ingame_nickname: 'renamed', position: '탱커',
    });
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.updated, true);
});
