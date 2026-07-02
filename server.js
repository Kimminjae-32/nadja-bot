const express = require('express');
const path    = require('path');
const db      = require('./db');
const { CHARACTERS, POS_EMOJI, TEAM_EMOJIS, TEAM_NAMES } = require('./constants');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));

let discordClient      = null;
let closeRecruitCallback = null;

const VALID_POSITIONS = ['탱커', '전사', '암살자', '스킬 딜러', '원거리 딜러', '지원가'];

function errorPage(msg) {
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>오류</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f0f1a;color:#e0e0f0;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}.box{text-align:center;padding:2rem;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px}h2{color:#e94560;margin-bottom:.5rem}</style>
    </head><body><div class="box"><h2>⚠️ 오류</h2><p>${msg}</p></div></body></html>`;
}

// ── 참가 신청 ──────────────────────────────────
// GET /join?event=MSGID[&discord_id=ID][&token=TOKEN]
app.get('/join', (req, res) => {
    const { event, discord_id } = req.query;
    if (!event || !db.eventExists(event)) {
        return res.status(404).send(errorPage('존재하지 않는 내전입니다.'));
    }
    // 이미 신청한 경우 수정/취소 페이지로 리다이렉트
    if (discord_id) {
        const existing = db.getByDiscordId(event, discord_id);
        if (existing) return res.redirect(`/cancel?token=${existing.cancel_token}`);
    }
    res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

// GET /api/event-info?event=MSGID — 공개 이벤트 기본 정보
app.get('/api/event-info', (req, res) => {
    const ev = db.getEvent(req.query.event || '');
    if (!ev) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    res.json({ gameType: ev.gameType, mapType: ev.mapType });
});

// POST /join
app.post('/join', (req, res) => {
    const { event, token, discord_id, discord_nickname, ingame_nickname, position } = req.body;
    if (!event || !discord_nickname?.trim() || !ingame_nickname?.trim())
        return res.status(400).json({ error: '모든 항목을 입력해주세요.' });
    if (!db.eventExists(event))
        return res.status(404).json({ error: '존재하지 않는 내전입니다.' });

    const ev = db.getEvent(event);
    const isLonewolf = ev?.gameType === '론울프';

    if (!isLonewolf) {
        if (!position) return res.status(400).json({ error: '포지션을 선택해주세요.' });
        if (!VALID_POSITIONS.includes(position))
            return res.status(400).json({ error: '올바른 포지션을 선택해주세요.' });
    }

    if (token) {
        const existing = db.getByToken(token);
        if (!existing || existing.event_id !== event)
            return res.status(403).json({ error: '유효하지 않은 수정 토큰입니다.' });
        db.updateByToken(token, discord_nickname.trim(), ingame_nickname.trim(), position);
        return res.json({ success: true, cancel_token: token, updated: true });
    }
    const cancel_token = db.addParticipant(event, discord_id || null, discord_nickname.trim(), ingame_nickname.trim(), position);
    res.json({ success: true, cancel_token, updated: false });
});

// GET /api/participant?token=TOKEN
app.get('/api/participant', (req, res) => {
    const p = db.getByToken(req.query.token || '');
    p ? res.json(p) : res.status(404).json({ error: '참가 정보를 찾을 수 없습니다.' });
});

// ── 참가 취소/수정 ────────────────────────────
app.get('/cancel', (req, res) => {
    const { token } = req.query;
    if (!token || !db.getByToken(token))
        return res.status(404).send(errorPage('이미 취소되었거나 존재하지 않는 참가 정보입니다.'));
    res.sendFile(path.join(__dirname, 'public', 'cancel.html'));
});

app.post('/cancel', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: '토큰이 없습니다.' });
    const p = db.getByToken(token);
    if (!p) return res.status(404).json({ error: '이미 취소된 참가 정보입니다.' });
    db.deleteByToken(token);
    res.json({ success: true });
});

// ── 관리자 ────────────────────────────────────
// GET /admin?event=MSGID&token=ADMIN_TOKEN
app.get('/admin', (req, res) => {
    const { event, token } = req.query;
    if (!event || !token || !db.verifyAdmin(event, token))
        return res.status(403).send(errorPage('관리자 권한이 없거나 잘못된 링크입니다.'));
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// GET /api/admin/data?event=&token=
app.get('/api/admin/data', (req, res) => {
    const { event, token } = req.query;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    const ev = db.getEvent(event);
    const participants = db.getParticipants(event);
    res.json({ event: ev, participants });
});

// POST /api/admin/shuffle
app.post('/api/admin/shuffle', (req, res) => {
    const { event, token } = req.body;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    const ev = db.getEvent(event);
    db.shuffleTeams(event, ev.teamCount || 2);
    res.json({ success: true, participants: db.getParticipants(event) });
});

// POST /api/admin/assign  { event, token, cancel_token, team_num }
app.post('/api/admin/assign', (req, res) => {
    const { event, token, cancel_token, team_num } = req.body;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    db.assignTeam(cancel_token, team_num === '' ? null : Number(team_num));
    res.json({ success: true });
});

// POST /api/admin/remove  { event, token, cancel_token }
app.post('/api/admin/remove', (req, res) => {
    const { event, token, cancel_token } = req.body;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    db.deleteByToken(cancel_token);
    res.json({ success: true });
});

// POST /api/admin/random-chars  — 팀 배정된 참가자에게 실험체 랜덤 배정
app.post('/api/admin/random-chars', (req, res) => {
    const { event, token } = req.body;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    const participants = db.getParticipants(event);
    const assigned = participants.filter(p => p.team_num);
    if (!assigned.length) return res.status(400).json({ error: '팀 배정이 되어있지 않아요.' });

    const banned  = db.getBannedCharacters(event);
    const pool    = CHARACTERS.filter(c => !banned.includes(c));
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const assignments = assigned.map((p, i) => ({
        cancel_token:     p.cancel_token,
        discord_nickname: p.discord_nickname,
        ingame_nickname:  p.ingame_nickname,
        team_num:         p.team_num,
        character:        shuffled[i % shuffled.length]
    }));
    res.json({ success: true, assignments, bannedCount: banned.length });
});

// POST /api/admin/char-ban — 캐릭터 밴/밴취소
app.post('/api/admin/char-ban', (req, res) => {
    const { event, token, character, action } = req.body;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    const banned = db.getBannedCharacters(event);
    const newBanned = action === 'ban'
        ? [...new Set([...banned, character])]
        : banned.filter(c => c !== character);
    db.setBannedCharacters(event, newBanned);
    res.json({ success: true, bannedCharacters: newBanned });
});

// ── 드래프트 ───────────────────────────────────────────
// POST /api/admin/draft/start
app.post('/api/admin/draft/start', (req, res) => {
    const { event, token, captains } = req.body;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    const state = db.startDraft(event, captains);
    if (!state) return res.status(404).json({ error: '이벤트 없음' });
    const BASE = process.env.WEB_URL || 'http://localhost:3000';
    const captainLinks = state.captains.map(c => ({
        teamNum: c.teamNum,
        discordNickname: c.discordNickname,
        draftUrl: `${BASE}/draft/${event}/${c.captainToken}`,
    }));
    res.json({ success: true, captainLinks });
});

// GET /api/admin/draft/status
app.get('/api/admin/draft/status', (req, res) => {
    const { event, token } = req.query;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    const draft = db.getDraftState(event);
    if (!draft) return res.json({ status: 'idle' });
    const all = db.getParticipants(event);
    const remaining = all.filter(p => draft.remainingTokens.includes(p.cancel_token));
    const BASE = process.env.WEB_URL || 'http://localhost:3000';
    const captainLinks = draft.captains.map(c => ({
        teamNum: c.teamNum, discordNickname: c.discordNickname,
        draftUrl: `${BASE}/draft/${event}/${c.captainToken}`,
    }));
    res.json({
        status: draft.status,
        currentTeam: draft.turnOrder[draft.currentTurnIndex] ?? null,
        totalPicks: draft.turnOrder.length,
        donePicks: draft.currentTurnIndex,
        remaining, picks: draft.picks, captainLinks,
    });
});

// GET /draft/:eventId/:captainToken — 팀장 픽 페이지
app.get('/draft/:eventId/:captainToken', (req, res) => {
    const captain = db.getCaptainByToken(req.params.eventId, req.params.captainToken);
    if (!captain) return res.status(403).send(errorPage('유효하지 않은 링크입니다.'));
    res.sendFile(path.join(__dirname, 'public', 'draft.html'));
});

// GET /api/draft/:eventId/:captainToken — 팀장 픽 상태 조회
app.get('/api/draft/:eventId/:captainToken', (req, res) => {
    const { eventId, captainToken } = req.params;
    const captain = db.getCaptainByToken(eventId, captainToken);
    if (!captain) return res.status(403).json({ error: 'Invalid token' });
    const draft = db.getDraftState(eventId);
    if (!draft) return res.status(404).json({ error: 'No draft' });
    const all = db.getParticipants(eventId);
    const remaining = all.filter(p => draft.remainingTokens.includes(p.cancel_token));
    const currentTeam = draft.turnOrder[draft.currentTurnIndex] ?? null;
    res.json({
        myTeam: captain.teamNum,
        currentTeam,
        isMyTurn: captain.teamNum === currentTeam && draft.status === 'in_progress',
        status: draft.status,
        remaining,
        picks: draft.picks,
        captainName: captain.discordNickname,
    });
});

// POST /api/draft/:eventId/:captainToken/pick
app.post('/api/draft/:eventId/:captainToken/pick', (req, res) => {
    const { eventId, captainToken } = req.params;
    const { participantToken } = req.body;
    const result = db.recordDraftPick(eventId, captainToken, participantToken);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
});

// GET /api/is-admin?event=MSGID&discord_id=USER_ID
app.get('/api/is-admin', (req, res) => {
    const { event, discord_id } = req.query;
    if (!event || !discord_id) return res.json({ isAdmin: false });
    const ev = db.getEvent(event);
    if (!ev || ev.createdBy !== discord_id) return res.json({ isAdmin: false });
    res.json({ isAdmin: true, adminUrl: `/admin?event=${event}&token=${ev.adminToken}` });
});

// POST /api/admin/close  — 모집 종료 (Discord 메시지 삭제 + 데이터 정리)
app.post('/api/admin/close', async (req, res) => {
    const { event, token } = req.body;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    if (!closeRecruitCallback) return res.status(500).json({ error: '봇 콜백이 없습니다.' });
    await closeRecruitCallback(event);
    res.json({ success: true });
});

// POST /api/admin/send-discord  — 팀 배정 결과를 Discord 채널에 전송
app.post('/api/admin/send-discord', async (req, res) => {
    const { event, token } = req.body;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    if (!discordClient) return res.status(500).json({ error: '봇 클라이언트가 없습니다.' });

    const ev = db.getEvent(event);
    const participants = db.getParticipants(event);
    const teamCount = ev.teamCount || 2;

    const teams = {};
    for (let i = 1; i <= teamCount; i++) teams[i] = [];
    const unassigned = [];
    for (const p of participants) {
        if (p.team_num && teams[p.team_num]) teams[p.team_num].push(p);
        else unassigned.push(p);
    }

    try {
        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
            .setTitle('🎲 팀 배정 결과')
            .setColor(0xFF0000)
            .setFooter({ text: `총 ${participants.length}명` })
            .setTimestamp();

        for (let i = 1; i <= teamCount; i++) {
            const team = teams[i];
            if (!team.length) continue;
            const lines = team.map(p => `${POS_EMOJI[p.position]||''}**${p.discord_nickname}** (${p.ingame_nickname})\n└ ${p.position}`);
            embed.addFields({ name: `${TEAM_EMOJIS[i-1]} ${TEAM_NAMES[i-1]} (${team.length}명)`, value: lines.join('\n\n'), inline: true });
        }
        if (unassigned.length) {
            embed.addFields({ name: '❓ 미배정', value: unassigned.map(p => p.discord_nickname).join(', '), inline: false });
        }

        const channel = await discordClient.channels.fetch(ev.channelId).catch(() => null);
        if (!channel) return res.status(404).json({ error: '채널을 찾을 수 없습니다.' });
        await channel.send({ embeds: [embed] });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: '전송 실패: ' + e.message });
    }
});

module.exports = {
    start(port) {
        app.listen(port, () => console.log(`[웹] 포트 ${port} 에서 실행 중`));
    },
    setClient(client) {
        discordClient = client;
    },
    setCloseCallback(fn) {
        closeRecruitCallback = fn;
    }
};
