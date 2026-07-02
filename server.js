const express = require('express');
const path    = require('path');
const db      = require('./db');
const { CHARACTERS, POS_EMOJI, TEAM_EMOJIS, TEAM_NAMES, TIERS } = require('./constants');
const VALID_TIERS = TIERS.map(t => t.name);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));

let discordClient        = null;
let closeRecruitCallback = null;
let recruitMap           = null;
let activeUserMap        = null;
let saveDataFn           = null;
let createEmbedFn        = null;

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
    const { event, token, discord_id, discord_nickname, ingame_nickname, position, tier } = req.body;
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

    const validTier = tier && VALID_TIERS.includes(tier) ? tier : null;

    if (token) {
        const existing = db.getByToken(token);
        if (!existing || existing.event_id !== event)
            return res.status(403).json({ error: '유효하지 않은 수정 토큰입니다.' });
        db.updateByToken(token, discord_nickname.trim(), ingame_nickname.trim(), position, validTier);
        return res.json({ success: true, cancel_token: token, updated: true });
    }
    const cancel_token = db.addParticipant(event, discord_id || null, discord_nickname.trim(), ingame_nickname.trim(), position, validTier);
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
app.post('/api/admin/draft/start', async (req, res) => {
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

    // 팀장에게 픽 링크 DM 자동 전송
    if (discordClient) {
        for (const captain of state.captains) {
            const participant = db.getByToken(captain.participantToken);
            if (!participant?.discord_id) continue;
            const link = captainLinks.find(l => l.teamNum === captain.teamNum);
            try {
                const user = await discordClient.users.fetch(participant.discord_id);
                await user.send(
                    `🎯 **[팀경매] ${captain.teamNum}팀 팀장으로 지정됐어요!**\n` +
                    `아래 링크에서 팀원을 픽해주세요:\n${link.draftUrl}`
                );
            } catch (_) { /* DM 차단 등 — 무시 */ }
        }
    }

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

        const TIER_EMOJI_MAP = {'언랭크':'⬜','아이언':'🔩','브론즈':'🥉','실버':'🥈','골드':'🥇','플래티넘':'💎','다이아몬드':'💠','메테오라이트':'☄️','미스릴':'✨','데미갓':'⚔️','이터니티':'👑'};
        for (let i = 1; i <= teamCount; i++) {
            const team = teams[i];
            if (!team.length) continue;
            const lines = team.map(p => {
                const tier = p.tier ? ` ${TIER_EMOJI_MAP[p.tier]||''}${p.tier}` : '';
                const pos  = p.position ? `\n└ ${POS_EMOJI[p.position]||''}${p.position}` : '';
                return `**${p.discord_nickname}**${tier} (${p.ingame_nickname})${pos}`;
            });
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

// POST /api/admin/change-map — 맵 변경 + Discord embed 업데이트
app.post('/api/admin/change-map', async (req, res) => {
    const { event, token, newMap, perTeam, maxPlayers: newMax } = req.body;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });

    const recruit = recruitMap?.get(event);
    if (!recruit) return res.json({ error: '봇 재시작 후에는 맵 변경이 불가해요. 봇이 실행 중인지 확인해주세요.' });

    let newTeamCount;
    if (newMap === '루미아 섬') {
        const pt = Math.max(1, parseInt(perTeam) || 3);
        const mp = Math.max(pt, parseInt(newMax) || 24);
        newTeamCount = Math.floor(mp / pt);
        if (newTeamCount < 2 || newTeamCount > 8)
            return res.json({ error: `팀 수는 2~8이어야 해요. (현재 ${newTeamCount}팀)` });
        recruit.gameType  = '내전';
        recruit.mapType   = '루미아 섬';
        recruit.maxPlayers = newTeamCount * pt;
        recruit.teamCount  = newTeamCount;
        recruit.teams      = Array.from({ length: newTeamCount }, () => []);
        recruit.team1 = []; recruit.team2 = [];
        db.updateEventGameType(event, '내전');
        db.updateEventTeamCount(event, newTeamCount);
    } else if (newMap === '코발트') {
        newTeamCount = 2;
        recruit.gameType  = '내전';
        recruit.mapType   = '코발트';
        recruit.maxPlayers = 8;
        recruit.teamCount  = 2;
        recruit.teams      = [[], []]; recruit.team1 = []; recruit.team2 = [];
        db.updateEventGameType(event, '내전');
        db.updateEventTeamCount(event, 2);
    } else if (newMap === '론울프') {
        const mp = Math.min(18, Math.max(2, parseInt(newMax) || 18));
        newTeamCount = mp;
        recruit.gameType  = '론울프';
        recruit.mapType   = '루미아 섬';
        recruit.maxPlayers = mp;
        recruit.teamCount  = mp;
        recruit.teams      = Array.from({ length: mp }, () => []);
        db.updateEventGameType(event, '론울프');
        db.updateEventTeamCount(event, mp);
    } else {
        return res.json({ error: '알 수 없는 맵 타입.' });
    }

    saveDataFn?.();

    if (discordClient && recruit.channelId && createEmbedFn) {
        try {
            const ch = await discordClient.channels.fetch(recruit.channelId).catch(() => null);
            const msg = ch ? await ch.messages.fetch(event).catch(() => null) : null;
            if (msg) await msg.edit({ embeds: [await createEmbedFn(recruit)] });
        } catch (e) { console.error('맵 변경 embed 업데이트 실패:', e); }
    }

    res.json({ success: true, gameType: recruit.gameType, mapType: recruit.mapType, teamCount: newTeamCount });
});

// GET /api/admin/voice-channels?event=&token= — 서버 음성 채널 목록
app.get('/api/admin/voice-channels', async (req, res) => {
    const { event, token } = req.query;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    if (!discordClient) return res.json({ channels: [] });

    const ev = db.getEvent(event);
    if (!ev?.guildId) return res.json({ channels: [] });

    try {
        const guild = discordClient.guilds.cache.get(ev.guildId)
            || await discordClient.guilds.fetch(ev.guildId).catch(() => null);
        if (!guild) return res.json({ channels: [] });
        const channels = guild.channels.cache
            .filter(c => c.type === 2)  // GuildVoice = 2
            .map(c => ({ id: c.id, name: c.name }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
        res.json({ channels });
    } catch (e) {
        res.json({ channels: [] });
    }
});

// POST /api/admin/move-voices — 팀별 음성 채널 이동
app.post('/api/admin/move-voices', async (req, res) => {
    const { event, token, assignments } = req.body;
    // assignments: [{ teamNum: 1, channelId: 'xxx' }, ...]
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    if (!discordClient) return res.status(500).json({ error: '봇이 연결되지 않았어요.' });

    const ev = db.getEvent(event);
    if (!ev?.guildId) return res.status(404).json({ error: '서버 정보가 없어요.' });

    const guild = discordClient.guilds.cache.get(ev.guildId)
        || await discordClient.guilds.fetch(ev.guildId).catch(() => null);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없어요.' });

    const assignMap = {};
    for (const a of assignments) assignMap[a.teamNum] = a.channelId;

    // 원래 채널 기록 (아직 없으면 첫 번째 참가자 채널로 저장)
    const recruit = recruitMap?.get(event);
    if (recruit && !recruit.originalVoiceChannelId) {
        const allP = db.getParticipants(event);
        for (const p of allP) {
            if (!p.discord_id) continue;
            const vs = guild.voiceStates.cache.get(p.discord_id);
            if (vs?.channelId) {
                recruit.originalVoiceChannelId = vs.channelId;
                saveDataFn?.();
                break;
            }
        }
    }

    const participants = db.getParticipants(event);
    let moved = 0;
    const errors = [];
    for (const p of participants) {
        if (!p.discord_id || !p.team_num) continue;
        const channelId = assignMap[p.team_num];
        if (!channelId) continue;
        const vs = guild.voiceStates.cache.get(p.discord_id);
        if (vs?.channelId) {
            try {
                await vs.setChannel(channelId);
                moved++;
            } catch (e) {
                errors.push(`${p.discord_nickname}: ${e.message}`);
                console.error(`[move-voices] ${p.discord_nickname} 이동 실패:`, e.message);
            }
        }
    }
    if (errors.length) console.error('[move-voices] 일부 실패:', errors);
    res.json({ success: true, moved, failed: errors.length });
});

// POST /api/admin/return-voices — 원래 채널로 복구
app.post('/api/admin/return-voices', async (req, res) => {
    const { event, token } = req.body;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });
    if (!discordClient) return res.status(500).json({ error: '봇이 연결되지 않았어요.' });

    const recruit = recruitMap?.get(event);
    if (!recruit?.originalVoiceChannelId)
        return res.status(400).json({ error: '이동 기록이 없어요. 먼저 방 이동을 실행해주세요.' });

    const ev = db.getEvent(event);
    if (!ev?.guildId) return res.status(404).json({ error: '서버 정보가 없어요.' });

    const guild = discordClient.guilds.cache.get(ev.guildId)
        || await discordClient.guilds.fetch(ev.guildId).catch(() => null);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없어요.' });

    const participants = db.getParticipants(event);
    let moved = 0;
    for (const p of participants) {
        if (!p.discord_id) continue;
        const vs = guild.voiceStates.cache.get(p.discord_id);
        if (vs?.channelId) {
            await vs.setChannel(recruit.originalVoiceChannelId).catch(e =>
                console.error(`[return-voices] ${p.discord_nickname} 복구 실패:`, e.message)
            );
            moved++;
        }
    }
    res.json({ success: true, moved });
});

// POST /api/admin/transfer-host — 방장 양도
app.post('/api/admin/transfer-host', async (req, res) => {
    const { event, token, newHostDiscordId } = req.body;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: 'Unauthorized' });

    const ev = db.getEvent(event);
    db.updateEventCreator(event, newHostDiscordId);

    const recruit = recruitMap?.get(event);
    if (recruit && activeUserMap) {
        const guildId = recruit.guildId ?? 'dm';
        activeUserMap.delete(`${guildId}_${recruit.creatorId}`);
        recruit.creatorId = newHostDiscordId;
        activeUserMap.set(`${guildId}_${newHostDiscordId}`, event);
        saveDataFn?.();
    }

    if (discordClient && recruit?.channelId && createEmbedFn) {
        try {
            const ch = await discordClient.channels.fetch(recruit.channelId).catch(() => null);
            const msg = ch ? await ch.messages.fetch(event).catch(() => null) : null;
            if (msg) await msg.edit({ embeds: [await createEmbedFn(recruit)] });
        } catch (e) { console.error('방장 양도 embed 업데이트 실패:', e); }
    }

    // 새 방장에게 관리자 링크 DM 전송
    let dmSent = false;
    if (discordClient && ev?.adminToken) {
        try {
            const BASE = process.env.WEB_URL || 'http://localhost:3000';
            const adminUrl = `${BASE}/admin?event=${event}&token=${ev.adminToken}`;
            const user = await discordClient.users.fetch(newHostDiscordId).catch(() => null);
            if (user) {
                await user.send(`👑 **내전 방장으로 지정됐어요!**\n관리자 페이지: ${adminUrl}`);
                dmSent = true;
            }
        } catch (_) { /* DM 차단 무시 */ }
    }

    res.json({ success: true, dmSent });
});

module.exports = {
    start(port) {
        app.listen(port, () => console.log(`[웹] 포트 ${port} 에서 실행 중`));
    },
    setClient(client)          { discordClient = client; },
    setCloseCallback(fn)       { closeRecruitCallback = fn; },
    setRecruitMap(map)         { recruitMap = map; },
    setActiveUserMap(map)      { activeUserMap = map; },
    setSaveDataFn(fn)          { saveDataFn = fn; },
    setCreateEmbedFn(fn)       { createEmbedFn = fn; },
};
