// 모집 종료·만료 시 이벤트가 보낸 디스코드 메시지를 모두 지우는지 확인한다
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadja-cl-'));
const origCwd = process.cwd();
process.chdir(workDir);
process.env.DEV_TOKEN = 'cleanup-dev';
process.env.GENTLEMAN_MOCK_DISCORD = '1';

const db = require(path.join(origCwd, 'db.js'));
const routes = require(path.join(origCwd, 'gentleman-routes.js'));
const discord = require(path.join(origCwd, 'gentleman-discord.js'));

test.after(() => {
    process.chdir(origCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

test('이벤트가 보낸 메시지 ID를 빠짐없이 모은다', () => {
    const EV = 'ev-collect';
    db.createEvent(EV, 'g', 'ch', 'u', 2, '내전', '코발트');
    db.setGentleman(EV, {
        round: 1, type: 'prize', phase: 'published',
        draftMessageId: 'm-draft',
        winnerMessageId: 'm-winner',
        teamMessages: { 1: { ok: true, messageId: 'm-team1' }, 2: { ok: true, messageId: 'm-team2' } },
        vote: { messageId: 'm-vote', remindMessageIds: ['m-remind1', 'm-remind2'] },
        unlucky: { messageId: 'm-unlucky' },
        teams: {}, payouts: {},
    });

    const ids = routes.collectMessageIds(db.getEvent(EV));
    for (const id of ['m-draft', 'm-winner', 'm-team1', 'm-team2', 'm-vote', 'm-remind1', 'm-remind2', 'm-unlucky']) {
        assert.ok(ids.includes(id), `${id}가 빠졌다`);
    }
    assert.strictEqual(ids.length, 8, '중복 없이 8건이어야 한다');
});

test('이벤트가 없거나 보낸 메시지가 없으면 빈 목록을 돌려준다', () => {
    assert.deepStrictEqual(routes.collectMessageIds(null), []);
    db.createEvent('ev-empty', 'g', 'ch', 'u', 2, '내전', '코발트');
    assert.deepStrictEqual(routes.collectMessageIds(db.getEvent('ev-empty')), []);
});

test('모집 종료 시 보낸 메시지를 모두 삭제한다', async () => {
    const EV = 'ev-cleanup';
    db.createEvent(EV, 'g', 'ch', 'u', 2, '내전', '코발트');
    db.setGentleman(EV, {
        round: 1, type: 'normal', phase: 'published',
        draftMessageId: 'd1',
        teamMessages: { 1: { ok: true, messageId: 't1' }, 2: { ok: true, messageId: 't2' } },
        teams: {}, payouts: {},
    });
    discord.clearMockOutbox();

    const r = await routes.cleanupMessages(EV);
    assert.strictEqual(r.deleted, 3, '3건을 지워야 한다');

    const log = discord.getMockOutbox().find(m => m.kind === 'delete-messages');
    assert.ok(log, '삭제 기록이 남아야 한다');
});

test('다음 회차로 넘어가도 이전 회차 메시지 ID가 보존된다', async () => {
    const EV = 'ev-rounds';
    db.createEvent(EV, 'g', 'ch', 'u', 2, '내전', '코발트');
    // 참가자가 있어야 다음 회차 처리가 가능하다
    for (let i = 0; i < 4; i++) {
        const tok = db.addParticipant(EV, `d${i}`, `유저${i}`, `ig${i}`, '전사', null, [], 0);
        db.assignTeam(tok, (i % 2) + 1);
    }
    db.setGentleman(EV, {
        round: 1, type: 'normal', phase: 'closed',
        draftMessageId: 'r1-draft',
        teamMessages: { 1: { ok: true, messageId: 'r1-t1' } },
        teams: {}, payouts: {},
    });

    // 라우터를 거치지 않고 같은 로직으로 보존 동작을 확인한다
    const ev = db.getEvent(EV);
    const kept = routes.collectMessageIds(ev);
    db.withGentleman(EV, (g, e) => { e.gentlemanSentMessages = kept; return {}; });
    db.setGentleman(EV, { round: 2, type: 'normal', phase: 'idle', teams: {}, payouts: {}, teamMessages: {} });

    const after = routes.collectMessageIds(db.getEvent(EV));
    assert.ok(after.includes('r1-draft'), '이전 회차 안내 메시지가 보존돼야 한다');
    assert.ok(after.includes('r1-t1'), '이전 회차 결과 메시지가 보존돼야 한다');

    discord.clearMockOutbox();
    const r = await routes.cleanupMessages(EV);
    assert.strictEqual(r.deleted, 2, '다음 회차에서도 이전 메시지를 지울 수 있어야 한다');
});
