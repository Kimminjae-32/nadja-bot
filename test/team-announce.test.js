// 팀 구성 공지 — 팀원 이름 · 티어 이미지를 모집 채널에 올리고, 바뀌면 같은 메시지를 고쳐 쓰는지 확인한다
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadja-ta-'));
const origCwd = process.cwd();
process.chdir(workDir);
process.env.DEV_TOKEN = 'ta-dev';

const db = require(path.join(origCwd, 'db.js'));
const discord = require(path.join(origCwd, 'gentleman-discord.js'));
const ta = require(path.join(origCwd, 'team-announce.js'));
const web = require(path.join(origCwd, 'server.js'));
const PORT = 3600 + Math.floor(Math.random() * 80);
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

/** 1인 테스트 모드와 같은 방식으로 테스트 이벤트를 만든다 (디스코드 전송은 Mock) */
async function makeEvent(memberCount, teamSize = 4) {
    const c = await post('/api/gentleman/dev/create', { devToken: 'ta-dev', memberCount, teamSize });
    assert.ok(c.data.success, c.data.error);
    const EV = c.data.eventId, AD = c.data.adminToken;
    return {
        EV, AD,
        send: (b = {}) => post('/api/admin/send-discord', { event: EV, token: AD, ...b }),
        plan: async () => (await get(`/api/admin/team-plan?event=${EV}&token=${AD}`)).data,
        cards: () => discord.getMockOutbox(EV).filter(m => m.kind === ta.KIND),
        people: () => db.getParticipants(EV),
    };
}

/** PNG 이미지의 가로 · 세로 */
function pngSize(dataUrl) {
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    assert.strictEqual(buf.toString('ascii', 1, 4), 'PNG');
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ── 1~4. 인원 · 팀 수별 공지 ────────────────────────────
for (const [members, teams] of [[8, 2], [16, 4], [24, 6], [32, 8]]) {
    test(`${members}명 / ${teams}팀 구성을 미리 보고 공지한다`, async () => {
        const e = await makeEvent(members, 4);
        const pv = await e.send({ dryRun: true });
        assert.strictEqual(pv.status, 200, pv.data.error);
        assert.strictEqual(pv.data.teams.length, teams);
        assert.strictEqual(pv.data.total, members);
        assert.ok(pv.data.teams.every(t => t.members.length === 4));
        assert.strictEqual(pv.data.mode, 'new');
        assert.strictEqual(pv.data.mock, true);
        assert.ok(pv.data.preview, '미리 보기 이미지가 있어야 한다');
        const { w, h } = pngSize(pv.data.preview);
        assert.ok(w >= 800 && w <= 2900 && h >= 300, `이미지 크기 ${w}×${h}`);
        assert.strictEqual(e.cards().length, 0, '미리 보기는 보내지 않는다');

        const r = await e.send({ expectSignature: pv.data.signature });
        assert.strictEqual(r.status, 200, r.data.error);
        assert.ok(r.data.success && r.data.mock && r.data.image);
        assert.strictEqual(r.data.teamCount, teams);
        const cards = e.cards();
        assert.strictEqual(cards.length, 1);
        assert.strictEqual(cards[0].files[0].name, 'teams.png');
        assert.ok(cards[0].files[0].bytes > 1000);
        assert.strictEqual(r.data.announce.announced, true);
        assert.strictEqual(r.data.announce.stale, false);
    });
}

// ── 5 · 7. 이름과 티어, 티어 미설정 ─────────────────────
test('참가자 이름과 티어를 보여주고, 티어가 없으면 티어 미설정으로 둔다', async () => {
    const e = await make8();
    const ps = e.people();
    await post('/api/admin/tier', { event: e.EV, token: e.AD, cancel_token: ps[0].cancel_token, tier: '미스릴' });
    await post('/api/admin/tier', { event: e.EV, token: e.AD, cancel_token: ps[1].cancel_token, tier: '다이아몬드' });
    const pv = (await e.send({ dryRun: true })).data;
    const all = pv.teams.flatMap(t => t.members);
    assert.deepStrictEqual(all.slice(0, 2), [{ name: '테스터1', tier: '미스릴' }, { name: '테스터2', tier: '다이아몬드' }]);
    assert.strictEqual(all[2].tier, null);
    assert.strictEqual(pv.noTierCount, 6);
    assert.strictEqual(ta.UNSET_TIER, '티어 미설정');

    // 이미지 생성이 안 될 때 쓰는 글자 공지에도 '티어 미설정'이 들어간다
    const { generateTeamRosterCard, UNSET_TIER_LABEL } = require(path.join(origCwd, 'result-card.js'));
    assert.strictEqual(UNSET_TIER_LABEL, '티어 미설정');
    const png = await generateTeamRosterCard([{ teamNum: 1, members: [{ name: '아주아주아주긴서버별명입니다아주긴이름', tier: null }, { name: 'A', tier: '메테오라이트' }] }]);
    assert.ok(png.length > 1000);
});

async function make8() { return makeEvent(8, 4); }

// ── 티어 엠블럼 ─────────────────────────────────────────
const rc = require(path.join(origCwd, 'result-card.js'));
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const ALL_TIERS = ['아이언', '브론즈', '실버', '골드', '플래티넘', '다이아몬드', '메테오라이트', '미스릴', '데미갓', '이터니티'];

/** 엠블럼 대신 쓸 단색 그림 (실제 엠블럼과 같은 290×370 비율) — 그려진 위치 · 크기를 픽셀로 찾을 수 있다 */
async function fakeEmblem() {
    const c = createCanvas(290, 370);
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000'; g.fillRect(0, 0, 290, 370);
    return loadImage(c.toBuffer('image/png'));
}

/** 카드 이미지에서 빨간 사각형(엠블럼)마다 위치 · 크기, 그리고 같은 줄 글자의 오른쪽 끝을 찾는다 */
async function scanEmblems(png) {
    const img = await loadImage(png);
    const c = createCanvas(img.width, img.height);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, img.width, img.height);
    const at = (x, y) => data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
    const isRed = p => p[0] > 200 && p[1] < 40 && p[2] < 40;
    const isText = p => p[0] > 150 && p[1] > 150 && p[2] > 150;
    const boxes = [];
    const seen = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (seen[y * width + x] || !isRed(at(x, y))) continue;
        let x2 = x; while (x2 + 1 < width && isRed(at(x2 + 1, y))) x2++;
        let y2 = y; while (y2 + 1 < height && isRed(at(x, y2 + 1))) y2++;
        for (let yy = y; yy <= y2; yy++) for (let xx = x; xx <= x2; xx++) seen[yy * width + xx] = 1;
        // 같은 줄(엠블럼 높이 안)에서 엠블럼 왼쪽에 있는 글자의 오른쪽 끝
        let textRight = -1;
        for (let yy = y; yy <= y2; yy++) for (let xx = Math.max(0, x - 700); xx < x; xx++) if (isText(at(xx, yy))) textRight = Math.max(textRight, xx);
        boxes.push({ x, y, w: x2 - x + 1, h: y2 - y + 1, textRight });
    }
    return boxes;
}

test('티어 엠블럼은 모두 같은 크기 · 원본 비율로 이름 오른쪽에 겹치지 않게 그린다', async () => {
    const red = await fakeEmblem();
    const longName = '나쟈봇테스트용아주아주긴서버별명입니다정말로길어요';
    for (const n of [2, 4, 6, 8]) {
        const teams = Array.from({ length: n }, (_, i) => ({
            teamNum: i + 1,
            members: Array.from({ length: 4 }, (_, j) => ({ name: j === 0 ? longName : `참가자${i}-${j}`, tier: ALL_TIERS[(i * 4 + j) % 10] })),
        }));
        const png = await rc.generateTeamRosterCard(teams, { loadEmblem: async () => red });
        const boxes = await scanEmblems(png);
        assert.strictEqual(boxes.length, n * 4, `${n}팀: 엠블럼 ${n * 4}개`);
        const { w, h } = boxes[0];
        assert.ok(boxes.every(b => Math.abs(b.w - w) <= 1 && Math.abs(b.h - h) <= 1), `${n}팀: 엠블럼 크기가 모두 같아야 한다`);
        assert.ok(Math.abs(w / h - 290 / 370) < 0.03, `${n}팀: 원본 비율 유지 (${w}×${h})`);
        assert.ok(h >= 60, `엠블럼 높이 ${h}`);
        for (const b of boxes) assert.ok(b.textRight < b.x - 10, `${n}팀: 이름(${b.textRight})이 엠블럼(${b.x})과 겹친다`);
    }
});

test('엠블럼을 받지 못한 참가자만 티어 이름 글자로 대신하고, 카드는 끝까지 만든다', async () => {
    const red = await fakeEmblem();
    const failed = new Set(['미스릴', '골드']);
    const loadEmblem = async t => { if (failed.has(t)) throw new Error('다운로드 실패'); return red; };
    const teams = [
        { teamNum: 1, members: ALL_TIERS.slice(0, 5).map((t, i) => ({ name: `A${i}`, tier: t })) },
        { teamNum: 2, members: [...ALL_TIERS.slice(5), '언랭크', null].map((t, i) => ({ name: `B${i}`, tier: t })) },
    ];
    const report = {};
    const png = await rc.generateTeamRosterCard(teams, { loadEmblem, report });
    const boxes = await scanEmblems(png);
    // 10개 티어 중 실패한 2개 → 엠블럼 8개. 언랭크 · 티어 미설정은 엠블럼 없이 글자
    assert.strictEqual(boxes.length, 8);
    // 미리 보기에서 관리자에게 알릴 수 있도록 실패한 티어를 알려준다 (언랭크는 원래 엠블럼이 없으므로 포함하지 않음)
    assert.deepStrictEqual(report.missingEmblems.sort(), ['골드', '미스릴']);

    // 모든 엠블럼이 실패해도(타임아웃 포함) 이미지는 만들어진다
    const none = await rc.generateTeamRosterCard(teams, { loadEmblem: () => new Promise(r => setTimeout(() => r(null), 10)) });
    assert.strictEqual((await scanEmblems(none)).length, 0);
});

test('언랭크와 티어 미설정은 엠블럼 없이 글자로 표시한다', async () => {
    assert.strictEqual(rc.TIER_URLS['언랭크'], undefined, '언랭크는 엠블럼 주소가 없다');
    assert.strictEqual(await rc.loadTierEmblem('언랭크'), null);
    assert.strictEqual(await rc.loadTierEmblem(null), null);
    assert.ok(ALL_TIERS.every(t => rc.TIER_URLS[t]), '아이언~이터니티는 엠블럼 주소가 있다');
});

test('실제 엠블럼 이미지(아이언~이터니티)를 받아 그린다', async (t) => {
    const imgs = await Promise.all(ALL_TIERS.map(tier => rc.loadTierEmblem(tier, 8000)));
    if (imgs.every(i => !i)) return t.skip('dak.gg에 연결할 수 없어 건너뜀');
    imgs.forEach((img, i) => {
        assert.ok(img, `${ALL_TIERS[i]} 엠블럼을 받지 못했다`);
        assert.ok(Math.abs(img.width / img.height - 290 / 370) < 0.05, `${ALL_TIERS[i]} 비율 ${img.width}×${img.height}`);
    });
    const png = await rc.generateTeamRosterCard([{ teamNum: 1, members: ALL_TIERS.slice(0, 5).map((tier, i) => ({ name: `가${i}`, tier })) },
        { teamNum: 2, members: ALL_TIERS.slice(5).map((tier, i) => ({ name: `나${i}`, tier })) }]);
    assert.ok(png.length > 20000, '엠블럼이 들어간 이미지');
});

test('관리자가 미리 본 이미지와 디스코드에 보낸 이미지가 같다', async () => {
    const e = await make8();
    await post('/api/admin/tier', { event: e.EV, token: e.AD, cancel_token: e.people()[0].cancel_token, tier: '미스릴' });
    const pv = (await e.send({ dryRun: true })).data;
    const r = await e.send({ expectSignature: pv.signature });
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(r.data.samePreview, true);
    assert.strictEqual(e.cards()[0].files[0].dataUrl, pv.preview, '미리 보기와 전송 이미지가 바이트 단위로 같아야 한다');
});

test('미리 보기에서 취소하면 아무것도 보내지 않는다', async () => {
    const e = await make8();
    await e.send({ dryRun: true });                        // 미리 보기만 열고 닫는다
    assert.strictEqual(e.cards().length, 0);
    assert.strictEqual(db.getEvent(e.EV).teamAnnounce, undefined);
});

// ── 6. 서버 별명 우선 ───────────────────────────────────
test('이름은 서버 별명 → 표시 이름 → 사용자 이름 → 신청 이름 순으로 정한다', async () => {
    const guild = {
        members: {
            async fetch({ user }) {
                const table = { u1: '서버별명', u2: null };               // u2는 별명이 없음 → 표시 이름
                const out = new Map();
                for (const id of user) if (id in table) out.set(id, { displayName: table[id] ?? '전역표시이름' });
                return out;
            },
        },
    };
    const client = {
        guilds: { cache: { get: id => (id === 'g1' ? guild : undefined) }, fetch: async () => { throw new Error('없음'); } },
        users: { fetch: async id => (id === 'u3' ? { globalName: null, username: 'user_three' } : null) },
    };
    const ev = { id: 'real', guildId: 'g1', channelId: 'c1' };          // 운영 이벤트처럼 (Mock 아님)
    const members = [
        { cancel_token: 'a', discord_id: 'u1', discord_nickname: '신청이름1' },
        { cancel_token: 'b', discord_id: 'u2', discord_nickname: '신청이름2' },
        { cancel_token: 'c', discord_id: 'u3', discord_nickname: '신청이름3' },
        { cancel_token: 'd', discord_id: 'u4', discord_nickname: '신청이름4' },   // 어디서도 못 찾음
        { cancel_token: 'e', discord_id: null, discord_nickname: '신청이름5' },   // 디스코드 계정 모름
    ];
    discord.setClient(client);
    try {
        const names = await ta.resolveNames(client, ev, members);
        assert.deepStrictEqual([...names.values()], ['서버별명', '전역표시이름', 'user_three', '신청이름4', '신청이름5']);
    } finally {
        discord.setClient(null);
    }
});

// ── 8. 팀 미지정 제외 ───────────────────────────────────
test('팀 미지정 참가자는 공지에서 빠진다', async () => {
    const e = await make8();
    const out = e.people()[0];
    await post('/api/admin/assign', { event: e.EV, token: e.AD, cancel_token: out.cancel_token, team_num: '' });
    const pv = (await e.send({ dryRun: true })).data;
    assert.strictEqual(pv.total, 7);
    assert.strictEqual(pv.excludedCount, 1);
    assert.ok(!pv.teams.flatMap(t => t.members).some(m => m.name === out.discord_nickname));
    // 기존 팀 번호와 배정은 그대로다
    assert.deepStrictEqual(pv.teams.map(t => t.members.length), [3, 4]);
});

test('팀 배정이 없거나 빈 팀이 있으면 공지하지 않는다', async () => {
    const e = await make8();
    for (const p of e.people().filter(p => p.team_num === 2))
        await post('/api/admin/assign', { event: e.EV, token: e.AD, cancel_token: p.cancel_token, team_num: '' });
    let r = await e.send({ dryRun: true });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /2팀에 아무도 없어요/);
    assert.strictEqual((await e.plan()).announce.problem, r.data.error);

    for (const p of e.people())
        await post('/api/admin/assign', { event: e.EV, token: e.AD, cancel_token: p.cancel_token, team_num: '' });
    r = await e.send({});
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /팀 배정을 먼저/);
    assert.strictEqual(e.cards().length, 0);
});

// ── 9. 공지 뒤 변경 → 안내 → 같은 메시지를 고쳐서 다시 공지 ──
test('공지 뒤 팀을 바꾸면 안내가 뜨고, 다시 공지하면 같은 메시지를 고친다', async () => {
    const e = await make8();
    const first = await e.send({});
    assert.ok(first.data.success);
    const msgId = db.getEvent(e.EV).teamAnnounce.messageId;
    assert.strictEqual((await e.plan()).announce.stale, false);

    // 팀원 맞바꾸기 (팀이 꽉 차 있으므로 한 명을 잠시 팀 미지정으로 뺀 뒤 옮긴다 — 관리자 화면에서 끌어 옮길 때와 같다)
    const p = e.people().find(x => x.team_num === 1);
    const q = e.people().find(x => x.team_num === 2);
    for (const [who, team] of [[q, ''], [p, 2], [q, 1]]) {
        const a = await post('/api/admin/assign', { event: e.EV, token: e.AD, cancel_token: who.cancel_token, team_num: team });
        assert.ok(a.data.success, a.data.error);
    }
    assert.strictEqual((await e.plan()).announce.stale, true, '팀 이동 뒤 안내가 떠야 한다');

    const pv = (await e.send({ dryRun: true })).data;
    assert.strictEqual(pv.mode, 'edit');
    const again = await e.send({ expectSignature: pv.signature });
    assert.ok(again.data.success, again.data.error);
    assert.strictEqual(again.data.edited, true);
    assert.strictEqual(db.getEvent(e.EV).teamAnnounce.messageId, msgId, '같은 메시지를 고쳐 쓴다');
    assert.strictEqual(e.cards().length, 1, '새 메시지는 올라가지 않는다');
    assert.strictEqual(e.cards()[0].edits, 1);
    assert.strictEqual((await e.plan()).announce.stale, false);

    // 티어 수정도 변경으로 본다
    await post('/api/admin/tier', { event: e.EV, token: e.AD, cancel_token: p.cancel_token, tier: '골드' });
    assert.strictEqual((await e.plan()).announce.stale, true, '티어 수정 뒤 안내가 떠야 한다');
});

test('미리 본 뒤 구성이 바뀌면 보내지 않고 다시 확인하게 한다', async () => {
    const e = await make8();
    const pv = (await e.send({ dryRun: true })).data;
    await post('/api/admin/tier', { event: e.EV, token: e.AD, cancel_token: e.people()[0].cancel_token, tier: '실버' });
    const r = await e.send({ expectSignature: pv.signature });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.data.changed, true);
    assert.strictEqual(e.cards().length, 0);
});

// ── 10. 중복 클릭 방지 ──────────────────────────────────
test('공지 버튼을 여러 번 눌러도 공지는 하나만 올라간다', async () => {
    const e = await make8();
    const results = await Promise.all(Array.from({ length: 5 }, () => e.send({})));
    const ok = results.filter(r => r.data.success);
    const busy = results.filter(r => r.status === 409 && r.data.busy);
    assert.ok(ok.length >= 1);
    assert.strictEqual(ok.length + busy.length, 5, JSON.stringify(results.map(r => r.data)));
    assert.strictEqual(e.cards().length, 1, '디스코드에는 메시지가 하나만 있어야 한다');
});

// ── 11. 전송 실패 · 기존 메시지 수정 불가 ───────────────
test('디스코드 전송이 실패하면 오류를 돌려주고 공지 기록을 남기지 않는다', async () => {
    const e = await make8();
    const realSend = discord.send;
    discord.send = async () => ({ ok: false, error: 'Missing Permissions' });
    try {
        const r = await e.send({});
        assert.strictEqual(r.status, 502);
        assert.match(r.data.error, /전송에 실패했어요.*Missing Permissions/);
    } finally {
        discord.send = realSend;
    }
    assert.strictEqual(db.getEvent(e.EV).teamAnnounce, undefined);
    assert.strictEqual((await e.plan()).announce.announced, false);
    // 다시 누르면 정상적으로 보내진다 (잠금이 풀려 있어야 한다)
    assert.ok((await e.send({})).data.success);
});

test('기존 공지를 고칠 수 없으면 먼저 알리고, 허락하면 새 공지를 보낸다', async () => {
    const e = await make8();
    await e.send({});
    const oldId = db.getEvent(e.EV).teamAnnounce.messageId;
    discord.clearMockOutbox(e.EV);                         // 공지 메시지가 지워진 상황

    const r = await e.send({});
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.data.needsNew, true);
    assert.strictEqual(e.cards().length, 0, '허락 전에는 보내지 않는다');

    const r2 = await e.send({ allowNew: true });
    assert.ok(r2.data.success, r2.data.error);
    assert.strictEqual(r2.data.replaced, true);
    assert.strictEqual(e.cards().length, 1);
    assert.notStrictEqual(db.getEvent(e.EV).teamAnnounce.messageId, oldId);
});

test('봇이 없는 운영 이벤트는 Mock으로 흘려보내지 않고 오류를 낸다', async () => {
    const EV = 'real_' + Date.now();
    const AD = db.createEvent(EV, 'g1', 'c1', 'host', 2, '내전', '코발트');
    for (let i = 0; i < 2; i++) db.assignTeam(db.addParticipant(EV, `id${i}`, `사람${i}`, `n${i}`, '전사', null, [], 0), i + 1);
    const r = await post('/api/admin/send-discord', { event: EV, token: AD });
    assert.strictEqual(r.status, 500);
    assert.match(r.data.error, /봇 클라이언트/);
    const bad = await post('/api/admin/send-discord', { event: EV, token: 'wrong' });
    assert.strictEqual(bad.status, 403);
});

// ── 12. 실험체 드래프트와 별개로 관리 ───────────────────
test('팀 구성 공지는 실험체 드래프트 상태와 공지 기록을 건드리지 않는다', async () => {
    const e = await make8();
    const A = (p, b = {}) => post(`/api/gentleman/admin/${p}`, { event: e.EV, token: e.AD, ...b });
    assert.ok((await A('start')).data.success);
    const before = JSON.stringify(db.getEvent(e.EV).gentleman);

    const r = await e.send({});
    assert.ok(r.data.success, r.data.error);
    assert.strictEqual(JSON.stringify(db.getEvent(e.EV).gentleman), before, '드래프트 상태가 그대로여야 한다');

    await post('/api/gentleman/dev/auto-pick', { devToken: 'ta-dev', event: e.EV });
    const s = (await get(`/api/gentleman/admin/state?event=${e.EV}&token=${e.AD}`)).data;
    assert.strictEqual(s.allConfirmed, true, '드래프트는 계속 진행된다');
    assert.ok(db.getEvent(e.EV).teamAnnounce.messageId, '팀 구성 공지 기록은 따로 남는다');
});
