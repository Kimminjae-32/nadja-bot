// 「저쪽 신사분이 주신 겁니다」 — 1인 테스트용 시뮬레이터 API
//
// 모든 경로는 개발자 토큰을 요구하며, isTestEvent 표시가 붙은 테스트 이벤트에서만 동작한다.
// 운영 이벤트는 이 API로 절대 조작할 수 없고, 디스코드 전송도 Mock으로만 처리된다.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const D = require('./gentleman-draft');
const V = require('./gentleman-vote');
const discord = require('./gentleman-discord');

const router = express.Router();
const DEV_TOKEN = () => process.env.DEV_TOKEN || 'nadja-dev-2026';

function requireDev(req, res, next) {
    const t = req.body?.devToken ?? req.query?.devToken;
    if (t !== DEV_TOKEN()) return res.status(403).json({ error: '개발자 권한이 필요해요.' });
    next();
}

// 테스트 이벤트만 허용 — 운영 데이터와 완전히 격리한다
function requireTestEvent(req, res, next) {
    const eventId = req.body?.event ?? req.query?.event;
    const ev = db.getEvent(eventId);
    if (!ev) return res.status(404).json({ error: '테스트 이벤트를 찾을 수 없어요.' });
    if (!ev.isTestEvent) return res.status(403).json({ error: '운영 이벤트는 시뮬레이터로 조작할 수 없어요.' });
    req.event = ev;
    req.eventId = eventId;
    next();
}

const TEST_PREFIX = 'simtest_';

// ── 테스트 이벤트 만들기 ─────────────────────────────
router.post('/create', requireDev, (req, res) => {
    const memberCount = Math.max(2, Math.min(64, Number(req.body.memberCount) || 16));
    const teamSize    = Math.max(1, Math.min(4, Number(req.body.teamSize) || 4));
    const type        = req.body.type === 'prize' ? 'prize' : 'normal';

    const teamCount = Math.ceil(memberCount / teamSize);
    const eventId   = `${TEST_PREFIX}${Date.now().toString(36)}`;
    const adminToken = db.createEvent(eventId, 'sim-guild', 'sim-channel', 'sim-admin', teamCount, '내전', '코발트');

    // 테스트 표시를 남겨 운영 데이터와 구분한다
    db.withGentleman(eventId, (g, ev) => { ev.isTestEvent = true; ev.simCreatedAt = Date.now(); return {}; });

    for (let i = 1; i <= memberCount; i++) {
        const tok = db.addParticipant(eventId, `simuser${i}`, `테스터${i}`, `sim_${i}`, '전사', null, [], 0);
        db.markDummy(tok);
    }
    // 팀 크기에 맞춰 순서대로 배정한다 (시뮬레이션은 결과 예측이 쉬운 편이 낫다)
    db.getParticipants(eventId).forEach((p, i) => db.assignTeam(p.cancel_token, Math.floor(i / teamSize) + 1));
    db.setGentleman(eventId, D.createState({ type }));

    res.json({ success: true, eventId, adminToken, memberCount, teamSize, teamCount, type });
});

// 테스트 이벤트 목록
router.get('/events', requireDev, (req, res) => {
    const rows = db.getAllEvents().filter(e => e.isTestEvent).map(e => {
        const ps = db.getParticipants(e.id);
        return {
            eventId: e.id, adminToken: e.adminToken, createdAt: e.simCreatedAt ?? e.createdAt,
            participantCount: ps.length, teamCount: new Set(ps.filter(p => p.team_num).map(p => p.team_num)).size,
            round: e.gentleman?.round ?? 0, phase: e.gentleman?.phase ?? 'idle', type: e.gentleman?.type ?? 'normal',
        };
    }).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ events: rows });
});

// 테스트 이벤트 삭제 (운영 이벤트는 지워지지 않는다)
router.post('/delete', requireDev, requireTestEvent, (req, res) => {
    db.deleteEvent(req.eventId);
    discord.clearMockOutbox(req.eventId);
    res.json({ success: true });
});

router.post('/delete-all', requireDev, (req, res) => {
    const ids = db.getAllEvents().filter(e => e.isTestEvent).map(e => e.id);
    for (const id of ids) { db.deleteEvent(id); discord.clearMockOutbox(id); }
    res.json({ success: true, removed: ids.length });
});

// ── 관점 전환에 필요한 정보 ──────────────────────────
// 각 참가자의 개인 링크 토큰을 알려준다. 테스트 이벤트 한정이므로 비밀 노출 문제가 없다.
router.get('/actors', requireDev, requireTestEvent, (req, res) => {
    const g = req.event.gentleman;
    const rows = db.getParticipants(req.eventId).map(p => {
        const team = g?.teams?.[p.team_num];
        return {
            token: p.cancel_token,
            nickname: p.discord_nickname,
            teamNum: p.team_num,
            isEditor: !!team?.lock && team.lock.token === p.cancel_token,
            teamConfirmed: !!team?.confirmed,
            voted: g?.vote?.votes ? g.vote.votes[p.cancel_token] != null : false,
        };
    });
    res.json({
        eventId: req.eventId,
        adminToken: req.event.adminToken,
        participants: rows,
        selectUrl: `/gentleman?event=${req.eventId}`,
        voteUrl: `/gentleman-vote?event=${req.eventId}`,
        adminUrl: `/admin?event=${req.eventId}&token=${req.event.adminToken}`,
    });
});

// ── 시나리오 자동 실행 ───────────────────────────────
// 여러 참가자 역할을 대신 수행해 한 사람이 전 과정을 시험할 수 있게 한다.

// 특정 팀의 선택을 자동으로 채우고 확정까지 진행한다
router.post('/auto-pick', requireDev, requireTestEvent, (req, res) => {
    const teams = req.body.teams ?? null;        // 생략하면 전체 팀
    const confirm = req.body.confirm !== false;
    const r = db.withGentleman(req.eventId, (g, ev, participants) => {
        if (!g?.teams || !Object.keys(g.teams).length) return { error: '드래프트를 먼저 시작해주세요.' };
        const done = [];
        for (const t of D.teamNumbers(participants)) {
            if (teams && !teams.includes(t)) continue;
            const team = g.teams[t];
            if (!team || team.confirmed) continue;
            const member = participants.find(p => p.team_num === t);
            D.forceReleaseLock(team);
            D.acquireLock(team, member.cancel_token, member.discord_nickname);
            D.savePicks(team, member.cancel_token, D.shuffle(team.candidates).slice(0, D.PICKS_PER_TEAM), team.rev);
            if (confirm) D.confirmTeam(team, member.cancel_token);
            else D.releaseLock(team, member.cancel_token);
            done.push(t);
        }
        return { success: true, teams: done };
    });
    r.error ? res.status(400).json(r) : res.json(r);
});

// 연결이 끊긴 상황을 흉내 낸다 (권한 만료 → 대기자에게 이전)
router.post('/simulate-disconnect', requireDev, requireTestEvent, (req, res) => {
    const teamNum = Number(req.body.teamNum);
    const r = db.withGentleman(req.eventId, g => {
        const team = g?.teams?.[teamNum];
        if (!team) return { error: '팀을 찾을 수 없어요.' };
        if (!team.lock) return { error: '그 팀에는 선택 중인 사람이 없어요.' };
        const before = team.lock.nickname;
        team.lock.expiresAt = Date.now() - 1;        // 90초가 지난 것처럼 만든다
        D.reapLock(team);
        return { success: true, disconnected: before, newHolder: team.lock?.nickname ?? null };
    });
    r.error ? res.status(400).json(r) : res.json(r);
});

// 여러 참가자 명의로 한 번에 투표한다
router.post('/auto-vote', requireDev, requireTestEvent, (req, res) => {
    const mode = req.body.mode ?? 'random';       // random | tie(공동 1등) | none(0표)
    const r = db.withGentleman(req.eventId, g => {
        if (g?.vote?.status !== V.STATUS.OPEN) return { error: '열려 있는 투표가 없어요.' };
        if (mode === 'none') return { success: true, cast: 0 };

        const { voters, candidates } = g.vote.snapshot;
        let cast = 0;
        if (mode === 'tie' && candidates.length >= 2) {
            // 앞의 두 후보에게 같은 수만큼 몰아줘 공동 1등을 만든다
            const eligible = voters.filter(v => v.token !== candidates[0].token && v.token !== candidates[1].token);
            const half = Math.min(2, Math.floor(eligible.length / 2));
            for (let i = 0; i < half; i++)        { if (V.castVote(g.vote, eligible[i].token, candidates[0].token).success) cast++; }
            for (let i = half; i < half * 2; i++) { if (V.castVote(g.vote, eligible[i].token, candidates[1].token).success) cast++; }
        } else {
            for (const v of voters) {
                const pick = candidates.filter(c => c.token !== v.token);
                if (!pick.length) continue;
                const target = pick[Math.floor(Math.random() * pick.length)];
                if (V.castVote(g.vote, v.token, target.token).success) cast++;
            }
        }
        return { success: true, cast, mode };
    });
    r.error ? res.status(400).json(r) : res.json(r);
});

// ── 자동 시나리오 (A 무기군 · B 32명 중 16명 · C 팀 수 변경) ──
// 실제 관리자 API를 같은 서버에 HTTP로 호출해서 운영과 같은 경로를 검증한다.
router.post('/scenario/:name', requireDev, async (req, res) => {
    const { runScenario } = require('./gentleman-scenarios');
    const base = `http://127.0.0.1:${req.socket.localPort}`;
    try {
        const r = await runScenario(req.params.name, { base, devToken: req.body.devToken });
        r.error ? res.status(400).json(r) : res.json(r);
    } catch (e) {
        res.status(500).json({ error: `시나리오 실행 중 오류: ${e.message}` });
    }
});

// ── Mock 디스코드 보관함 ─────────────────────────────
router.get('/outbox', requireDev, (req, res) => {
    res.json({ messages: discord.getMockOutbox(req.query.event || null) });
});

router.post('/outbox/clear', requireDev, (req, res) => {
    discord.clearMockOutbox(req.body.event || null);
    res.json({ success: true });
});

// ── 상태 덤프 (오류 확인용) ──────────────────────────
router.get('/dump', requireDev, requireTestEvent, (req, res) => {
    const g = req.event.gentleman;
    const participants = db.getParticipants(req.eventId);
    res.json({
        event: { id: req.event.id, teamCount: req.event.teamCount, bannedCharacters: req.event.bannedCharacters ?? [] },
        participants: participants.map(p => ({ token: p.cancel_token, nickname: p.discord_nickname, team: p.team_num })),
        gentleman: g ?? null,                      // 테스트 이벤트라 전체를 그대로 보여준다
        summary: g ? D.adminSummary(g, participants) : null,
    });
});

router.get('/page', requireDev, (req, res) => res.sendFile(path.join(__dirname, 'public', 'gentleman-sim.html')));

module.exports = { router, TEST_PREFIX };
