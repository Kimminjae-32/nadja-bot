const fs     = require('fs');
const crypto = require('crypto');

const DB_PATH = './nadja-events.json';

function load() {
    try {
        if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    } catch (e) {}
    return { events: {}, participants: {} };
}

function save(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

module.exports = {
    // 이벤트 생성 — admin_token, team_count, gameType 포함
    createEvent(id, guildId, channelId, createdBy, teamCount, gameType) {
        const data = load();
        if (!data.events[id]) {
            const adminToken = crypto.randomBytes(12).toString('hex');
            data.events[id] = { id, guildId, channelId, createdBy, teamCount: teamCount || 2, gameType: gameType || '내전', adminToken, createdAt: Date.now() };
            save(data);
        }
        return data.events[id].adminToken;
    },

    // 이벤트 + 해당 이벤트의 참가자 전체 삭제
    deleteEvent(id) {
        const data = load();
        delete data.events[id];
        Object.keys(data.participants).forEach(k => {
            if (data.participants[k].event_id === id) delete data.participants[k];
        });
        save(data);
    },

    getEvent(id) {
        return load().events[id] || null;
    },

    verifyAdmin(eventId, adminToken) {
        const ev = load().events[eventId];
        return ev?.adminToken === adminToken;
    },

    // discord_id 중복 시 업데이트
    addParticipant(eventId, discordId, discordNick, ingameNick, position) {
        const data = load();
        if (discordId) {
            const existing = Object.values(data.participants).find(
                p => p.event_id === eventId && p.discord_id === discordId
            );
            if (existing) {
                Object.assign(existing, { discord_nickname: discordNick, ingame_nickname: ingameNick, position });
                save(data);
                return existing.cancel_token;
            }
        }
        const token = crypto.randomBytes(8).toString('hex');
        data.participants[token] = {
            event_id: eventId, discord_id: discordId || null,
            discord_nickname: discordNick, ingame_nickname: ingameNick,
            position, team_num: null, cancel_token: token, submitted_at: Date.now()
        };
        save(data);
        return token;
    },

    getParticipants(eventId) {
        return Object.values(load().participants)
            .filter(p => p.event_id === eventId)
            .sort((a, b) => a.submitted_at - b.submitted_at);
    },

    getByToken(token)        { return load().participants[token] || null; },
    getByDiscordId(eventId, discordId) {
        return Object.values(load().participants).find(
            p => p.event_id === eventId && p.discord_id === discordId
        ) || null;
    },

    updateByToken(token, discordNick, ingameNick, position) {
        const data = load();
        if (data.participants[token]) {
            Object.assign(data.participants[token], { discord_nickname: discordNick, ingame_nickname: ingameNick, position });
            save(data);
        }
    },

    assignTeam(token, teamNum) {
        const data = load();
        if (data.participants[token]) { data.participants[token].team_num = teamNum; save(data); }
    },

    shuffleTeams(eventId, teamCount) {
        const data = load();
        const list = Object.values(data.participants).filter(p => p.event_id === eventId);
        const shuffled = [...list].sort(() => Math.random() - 0.5);
        shuffled.forEach((p, i) => { data.participants[p.cancel_token].team_num = (i % teamCount) + 1; });
        save(data);
    },

    deleteByToken(token) {
        const data = load(); delete data.participants[token]; save(data);
    },

    deleteByDiscordId(eventId, discordId) {
        const data = load();
        const token = Object.keys(data.participants).find(
            k => data.participants[k].event_id === eventId && data.participants[k].discord_id === discordId
        );
        if (token) { delete data.participants[token]; save(data); return true; }
        return false;
    },

    eventExists(id) { return !!load().events[id]; },

    // ── 드래프트 ──────────────────────────────────
    startDraft(eventId, captainAssignments) {
        // captainAssignments: [{ teamNum, participantToken }, ...]
        const data = load();
        const ev = data.events[eventId];
        if (!ev) return null;

        const all = Object.values(data.participants).filter(p => p.event_id === eventId);
        const captainSet = new Set(captainAssignments.map(c => c.participantToken));

        const captains = captainAssignments.map(({ teamNum, participantToken }) => ({
            teamNum,
            participantToken,
            captainToken: crypto.randomBytes(10).toString('hex'),
            discordNickname: data.participants[participantToken]?.discord_nickname || '',
        }));

        // 팀장은 즉시 해당 팀으로 배정
        for (const { teamNum, participantToken } of captainAssignments) {
            if (data.participants[participantToken]) data.participants[participantToken].team_num = teamNum;
        }

        // 남은 참가자 (팀장 제외)
        const remaining = all.filter(p => !captainSet.has(p.cancel_token)).map(p => p.cancel_token);
        const teamNums  = captains.map(c => c.teamNum).sort((a, b) => a - b);
        const turnOrder = Array.from({ length: remaining.length }, (_, i) => teamNums[i % teamNums.length]);

        ev.draftState = {
            status: 'in_progress',
            captains,
            turnOrder,
            currentTurnIndex: 0,
            remainingTokens: remaining,
            picks: [],
        };
        save(data);
        return ev.draftState;
    },

    getDraftState(eventId) {
        return load().events[eventId]?.draftState || null;
    },

    recordDraftPick(eventId, captainToken, participantToken) {
        const data = load();
        const ev = data.events[eventId];
        if (!ev?.draftState || ev.draftState.status !== 'in_progress') return { error: 'Not in progress' };
        const draft = ev.draftState;

        const captain = draft.captains.find(c => c.captainToken === captainToken);
        if (!captain) return { error: 'Invalid token' };
        if (captain.teamNum !== draft.turnOrder[draft.currentTurnIndex]) return { error: 'Not your turn' };
        if (!draft.remainingTokens.includes(participantToken)) return { error: 'Invalid participant' };

        const p = data.participants[participantToken];
        if (!p) return { error: 'Participant not found' };

        p.team_num = captain.teamNum;
        draft.remainingTokens = draft.remainingTokens.filter(t => t !== participantToken);
        draft.picks.push({ teamNum: captain.teamNum, participantToken, discordNickname: p.discord_nickname, ingameNickname: p.ingame_nickname });
        draft.currentTurnIndex++;

        if (draft.currentTurnIndex >= draft.turnOrder.length || draft.remainingTokens.length === 0) {
            draft.status = 'completed';
        }
        save(data);
        return { success: true, done: draft.status === 'completed' };
    },

    getCaptainByToken(eventId, captainToken) {
        const ev = load().events[eventId];
        return ev?.draftState?.captains.find(c => c.captainToken === captainToken) || null;
    },

    // ── 밴픽 ──────────────────────────────────────
    setBannedCharacters(eventId, bannedList) {
        const data = load();
        if (data.events[eventId]) { data.events[eventId].bannedCharacters = bannedList; save(data); }
    },

    getBannedCharacters(eventId) {
        return load().events[eventId]?.bannedCharacters || [];
    },
};
