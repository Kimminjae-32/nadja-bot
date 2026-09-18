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
    // 이벤트 생성 — admin_token, team_count, gameType, mapType 포함
    createEvent(id, guildId, channelId, createdBy, teamCount, gameType, mapType) {
        const data = load();
        if (!data.events[id]) {
            const adminToken = crypto.randomBytes(12).toString('hex');
            data.events[id] = { id, guildId, channelId, createdBy, teamCount: teamCount || 2, gameType: gameType || '내전', mapType: mapType || null, adminToken, createdAt: Date.now() };
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
    addParticipant(eventId, discordId, discordNick, ingameNick, position, tier, mainCharacters, mmr) {
        const data = load();
        if (discordId) {
            const existing = Object.values(data.participants).find(
                p => p.event_id === eventId && p.discord_id === discordId
            );
            if (existing) {
                Object.assign(existing, { discord_nickname: discordNick, ingame_nickname: ingameNick, position, tier: tier || null, main_characters: mainCharacters || [], mmr: mmr || null });
                save(data);
                return existing.cancel_token;
            }
        }
        const token = crypto.randomBytes(8).toString('hex');
        data.participants[token] = {
            event_id: eventId, discord_id: discordId || null,
            discord_nickname: discordNick, ingame_nickname: ingameNick,
            position, tier: tier || null, main_characters: mainCharacters || [], mmr: mmr || null,
            team_num: null, cancel_token: token, submitted_at: Date.now()
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

    updateByToken(token, discordNick, ingameNick, position, tier, mainCharacters, mmr) {
        const data = load();
        if (data.participants[token]) {
            Object.assign(data.participants[token], { discord_nickname: discordNick, ingame_nickname: ingameNick, position, tier: tier || null, main_characters: mainCharacters || [], mmr: mmr || null });
            save(data);
        }
    },

    assignTeam(token, teamNum) {
        const data = load();
        if (data.participants[token]) { data.participants[token].team_num = teamNum; save(data); }
    },

    // 관리자가 참가자 티어 수정 (허위 신고 정정용)
    setTier(token, tier) {
        const data = load();
        if (data.participants[token]) { data.participants[token].tier = tier || null; save(data); }
    },

    shuffleTeams(eventId, teamCount) {
        const data = load();
        const list = Object.values(data.participants).filter(p => p.event_id === eventId);
        const shuffled = [...list].sort(() => Math.random() - 0.5);
        shuffled.forEach((p, i) => { data.participants[p.cancel_token].team_num = (i % teamCount) + 1; });
        save(data);
    },

    // MMR 기준 스네이크 드래프트 배정 — 상위권이 각 팀에 고루 분배
    // 예) 6명 2팀: 1위→팀1, 2위→팀2, 3위→팀2, 4위→팀1, 5위→팀1, 6위→팀2
    shuffleByTier(eventId, teamCount) {
        const data = load();
        const list = Object.values(data.participants).filter(p => p.event_id === eventId);
        const numTeams = teamCount || 2;
        // MMR 내림차순 정렬, 동점은 랜덤
        const sorted = [...list].sort((a, b) => (b.mmr || 0) - (a.mmr || 0) || Math.random() - 0.5);
        // 스네이크 드래프트: 0→1→...→N-1→N-1→...→1→0→0→...
        let teamIdx = 0, dir = 1;
        for (const p of sorted) {
            data.participants[p.cancel_token].team_num = teamIdx + 1;
            const next = teamIdx + dir;
            if (next >= numTeams)      { dir = -1; }
            else if (next < 0)         { dir = 1; }
            teamIdx += dir;
        }
        save(data);
    },

    // 참가자 임시 역할 (roleId=null 이면 해제)
    setEventRole(eventId, roleId, roleName) {
        const data = load();
        if (data.events[eventId]) {
            data.events[eventId].roleId   = roleId || null;
            data.events[eventId].roleName = roleName || null;
            save(data);
        }
    },

    // 테스트용 더미 참가자 표시
    markDummy(token) {
        const data = load();
        if (data.participants[token]) { data.participants[token].is_dummy = true; save(data); }
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
            status: remaining.length === 0 ? 'completed' : 'in_progress',
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

    updateEventGameType(eventId, gameType) {
        const data = load();
        if (data.events[eventId]) { data.events[eventId].gameType = gameType; save(data); }
    },

    updateEventTeamCount(eventId, teamCount) {
        const data = load();
        if (data.events[eventId]) { data.events[eventId].teamCount = teamCount; save(data); }
    },

    updateEventMapType(eventId, mapType) {
        const data = load();
        if (data.events[eventId]) { data.events[eventId].mapType = mapType || null; save(data); }
    },

    updateEventCreator(eventId, newCreatorId) {
        const data = load();
        if (data.events[eventId]) { data.events[eventId].createdBy = newCreatorId; save(data); }
    },

    rotateAdminToken(eventId) {
        const data = load();
        if (!data.events[eventId]) return null;
        const newToken = crypto.randomBytes(12).toString('hex');
        data.events[eventId].adminToken = newToken;
        save(data);
        return newToken;
    },

    resetTeamAssignments(eventId) {
        const data = load();
        Object.values(data.participants)
            .filter(p => p.event_id === eventId)
            .forEach(p => { p.team_num = null; });
        save(data);
    },

    getAllEvents() {
        return Object.values(load().events);
    },

    setRule(eventId, rule) {
        const data = load();
        if (data.events[eventId]) { data.events[eventId].rule = rule || null; save(data); }
    },

    getRule(eventId) {
        return load().events[eventId]?.rule || null;
    },

    // ── 토너먼트 (싱글 엘리미네이션) ────────────────────
    // rounds[r][i] = { teamA, teamB, winner, chars }  (teamX = 팀 번호 | null=부전승)
    // 라운드 r의 i번 경기는 r-1 라운드 2i, 2i+1번 경기 승자끼리 붙음
    startTournament(eventId) {
        const data = load();
        const ev = data.events[eventId];
        if (!ev) return null;
        const teamNums = [...new Set(
            Object.values(data.participants).filter(p => p.event_id === eventId && p.team_num).map(p => p.team_num)
        )].sort((a, b) => a - b);
        if (teamNums.length < 2) return null;

        const seeds = [...teamNums].sort(() => Math.random() - 0.5);
        let size = 1; while (size < seeds.length) size *= 2;
        // 1라운드: i번 경기 = seeds[i] vs seeds[size-1-i] → 부전승이 한 경기에 하나만 생김
        const first = Array.from({ length: size / 2 }, (_, i) => ({
            teamA: seeds[i] ?? null, teamB: seeds[size - 1 - i] ?? null, winner: null, chars: null,
        }));
        const rounds = [first];
        for (let n = size / 2; n > 1; n /= 2) {
            rounds.push(Array.from({ length: n / 2 }, () => ({ teamA: null, teamB: null, winner: null, chars: null })));
        }
        ev.tournament = { status: 'in_progress', rounds, champion: null, startedAt: Date.now() };
        propagateTournament(ev.tournament);
        save(data);
        return ev.tournament;
    },

    getTournament(eventId) {
        return load().events[eventId]?.tournament || null;
    },

    setMatchWinner(eventId, round, idx, teamNum) {
        const data = load();
        const t = data.events[eventId]?.tournament;
        const m = t?.rounds[round]?.[idx];
        if (!m) return { error: '경기를 찾을 수 없어요.' };
        if (teamNum !== null && teamNum !== m.teamA && teamNum !== m.teamB) return { error: '해당 경기의 팀이 아니에요.' };
        m.winner = teamNum;
        propagateTournament(t);
        save(data);
        return { success: true, tournament: t };
    },

    setMatchChars(eventId, round, idx, chars) {
        const data = load();
        const m = data.events[eventId]?.tournament?.rounds[round]?.[idx];
        if (!m) return null;
        m.chars = chars;
        save(data);
        return m;
    },

    resetTournament(eventId) {
        const data = load();
        if (data.events[eventId]) { delete data.events[eventId].tournament; save(data); }
    },
};

// 부전승 자동 처리 + 다음 라운드 대진 갱신 + 우승팀 판정
function propagateTournament(t) {
    for (let r = 0; r < t.rounds.length; r++) {
        for (let i = 0; i < t.rounds[r].length; i++) {
            const m = t.rounds[r][i];
            if (r > 0) {
                const a = t.rounds[r - 1][2 * i], b = t.rounds[r - 1][2 * i + 1];
                const na = a?.winner ?? null, nb = b?.winner ?? null;
                if (na !== m.teamA || nb !== m.teamB) { m.teamA = na; m.teamB = nb; m.chars = null; }
                // 대진이 아직 안 정해졌거나 승자가 대진에 없으면 승자 무효
                if (m.teamA === null || m.teamB === null || (m.winner !== m.teamA && m.winner !== m.teamB)) m.winner = null;
            }
            // 부전승: 한쪽만 있으면 자동 진출 (1라운드에서만 발생)
            if (r === 0) {
                if (m.teamA !== null && m.teamB === null) m.winner = m.teamA;
                else if (m.teamB !== null && m.teamA === null) m.winner = m.teamB;
            }
        }
    }
    const final = t.rounds[t.rounds.length - 1][0];
    t.champion = final.winner;
    t.status = final.winner !== null ? 'completed' : 'in_progress';
}
