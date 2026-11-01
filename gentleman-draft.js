// 「저쪽 신사분이 주신 겁니다」 — 실험체 선물 드래프트 핵심 로직
//
// 흐름: 드래프트 시작(팀별 후보 추첨) → 팀마다 4명 선택 후 확정 → 전 팀 확정 시 원형 교환
//       → 받은 실험체를 팀원에게 무작위 배정 → 관리자가 결과 공지
//
// 이 파일은 순수 로직만 담당한다. 저장은 db.withGentleman 트랜잭션 안에서 호출하는 쪽이 처리한다.

const { CHARACTERS } = require('./constants');

const PICKS_PER_TEAM     = 4;                 // 팀마다 선물할 실험체 수
const DEFAULT_CANDIDATES = 12;                // 팀당 기본 후보 수
const MIN_CANDIDATES     = 4;                 // 이보다 적으면 드래프트를 시작할 수 없다
const LOCK_TTL_MS        = 90 * 1000;         // 선택 권한 유지 시간 (연결 신호가 끊기면 만료)

// 단계: idle(시작 전) → drafting(선택 중) → assigned(배정 완료) → published(결과 공지) → closed(드래프트 종료)
const PHASE = { IDLE: 'idle', DRAFTING: 'drafting', ASSIGNED: 'assigned', PUBLISHED: 'published', CLOSED: 'closed' };

const shuffle = arr => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

const now = () => Date.now();

// 참가자 목록에서 실제로 팀에 배정된 팀 번호들을 추려낸다
function teamNumbers(participants) {
    return [...new Set(participants.filter(p => p.team_num).map(p => p.team_num))].sort((a, b) => a - b);
}

function membersOfTeam(participants, teamNum) {
    return participants.filter(p => p.team_num === teamNum);
}

// ── 상태 생성 ────────────────────────────────────────
function createState({ round = 1, type = 'normal' } = {}) {
    return {
        round,
        type,                       // 'normal'(일반 회차) | 'prize'(상품 회차)
        phase: PHASE.IDLE,
        createdAt: now(),
        teams: {},                  // 팀별 후보·선택·확정·잠금 상태
        exchange: null,             // { 주는 팀: 받는 팀 }
        assignments: null,          // 공개 전까지 참가자에게 노출하지 않는다
        teamMessages: {},           // 팀별 디스코드 결과 메시지 기록
        draftMessageId: null,
        resultsPublished: false,
        // 상품 회차 전용
        winnerTeam: null,
        winnerPublished: false,
        winnerMessageId: null,
        vote: null,
        unlucky: null,
        payouts: {},                // 참가자 토큰 → 'pending' | 'done'
    };
}

/**
 * 팀당 후보 수를 계산한다.
 * 전체 실험체가 부족하면 모든 팀이 같은 수를 받도록 줄인다.
 */
function candidateCount(availableCount, teamCount) {
    if (teamCount <= 0) return 0;
    return Math.min(DEFAULT_CANDIDATES, Math.floor(availableCount / teamCount));
}

/**
 * 드래프트를 시작한다. 팀마다 서로 겹치지 않는 후보를 무작위로 배정한다.
 * @returns { error } 또는 { state, perTeam, teamCount }
 */
function startDraft(state, participants, bannedCharacters = [], charPool = CHARACTERS) {
    const teams = teamNumbers(participants);
    if (teams.length < 2) return { error: '팀이 2팀 이상이어야 드래프트를 시작할 수 있어요.' };

    const banned    = new Set(bannedCharacters);
    const available = charPool.filter(c => !banned.has(c));
    const perTeam   = candidateCount(available.length, teams.length);

    if (perTeam < MIN_CANDIDATES) {
        return {
            error: `후보가 팀당 ${perTeam}명뿐이라 시작할 수 없어요. `
                 + `(사용 가능한 실험체 ${available.length}명 ÷ ${teams.length}팀, 최소 ${MIN_CANDIDATES}명 필요) `
                 + `밴을 줄이거나 팀 수를 줄여주세요.`,
        };
    }

    const pool = shuffle(available);
    let cursor = 0;
    state.teams = {};
    for (const t of teams) {
        state.teams[t] = {
            candidates: pool.slice(cursor, cursor + perTeam),
            picks: [],
            rev: 0,                 // 저장할 때마다 증가한다. 오래된 요청을 걸러내는 데 쓴다.
            confirmed: false,
            confirmedAt: null,
            autoFilled: [],         // 강제 확정으로 채워진 실험체
            lock: null,             // { token, nickname, expiresAt }
            waiting: [],            // 선택 권한 대기열 (토큰 목록)
        };
        cursor += perTeam;
    }
    state.phase            = PHASE.DRAFTING;
    state.exchange         = null;
    state.assignments      = null;
    state.resultsPublished = false;
    state.teamMessages     = {};
    state.startedAt        = now();
    return { state, perTeam, teamCount: teams.length };
}

// ── 선택 권한(잠금) ──────────────────────────────────
function lockExpired(team) {
    return !team.lock || team.lock.expiresAt <= now();
}

// 만료된 잠금을 정리하고 대기자에게 권한을 넘긴다
function reapLock(team) {
    if (team.lock && team.lock.expiresAt <= now()) team.lock = null;
    if (!team.lock && team.waiting.length) {
        const next = team.waiting.shift();
        team.lock = { token: next.token, nickname: next.nickname, expiresAt: now() + LOCK_TTL_MS };
    }
}

/**
 * 선택 권한을 요청한다. 이미 다른 사람이 쥐고 있으면 대기열에 넣는다.
 * @returns { role: 'editor' | 'waiting', holder }
 */
function acquireLock(team, token, nickname) {
    reapLock(team);
    if (team.confirmed) return { role: 'locked', holder: null };

    if (!team.lock) {
        team.waiting = team.waiting.filter(w => w.token !== token);
        team.lock = { token, nickname, expiresAt: now() + LOCK_TTL_MS };
        return { role: 'editor', holder: team.lock };
    }
    if (team.lock.token === token) {
        team.lock.expiresAt = now() + LOCK_TTL_MS;          // 연결 유지 신호
        return { role: 'editor', holder: team.lock };
    }
    if (!team.waiting.some(w => w.token === token)) team.waiting.push({ token, nickname, at: now() });
    return { role: 'waiting', holder: team.lock };
}

// 권한을 반납한다. 대기자가 있으면 즉시 넘긴다.
function releaseLock(team, token) {
    if (team.lock?.token === token) team.lock = null;
    team.waiting = team.waiting.filter(w => w.token !== token);
    reapLock(team);
    return true;
}

// 관리자 강제 해제
function forceReleaseLock(team) {
    team.lock = null;
    team.waiting = [];
    reapLock(team);
    return true;
}

// ── 선택 저장 ────────────────────────────────────────
/**
 * 선택 내용을 저장한다. 권한 보유자만 가능하며, 오래된 요청(baseRev 불일치)은 거부한다.
 */
function savePicks(team, token, picks, baseRev) {
    reapLock(team);
    if (team.confirmed)                 return { error: '이미 확정된 팀이에요.', code: 'confirmed', rev: team.rev, picks: team.picks };
    if (!team.lock || team.lock.token !== token)
        return { error: '선택 권한이 없어요. 화면을 새로고침해주세요.', code: 'no_lock', rev: team.rev, picks: team.picks };
    if (baseRev != null && baseRev !== team.rev)
        return { error: '다른 변경이 먼저 저장됐어요. 최신 상태를 불러옵니다.', code: 'stale', rev: team.rev, picks: team.picks };

    const seen = new Set();
    const valid = [];
    for (const c of Array.isArray(picks) ? picks : []) {
        if (!team.candidates.includes(c) || seen.has(c)) continue;
        seen.add(c);
        valid.push(c);
        if (valid.length >= PICKS_PER_TEAM) break;
    }

    team.picks = valid;
    team.rev += 1;
    team.lock.expiresAt = now() + LOCK_TTL_MS;              // 저장도 연결 유지 신호로 본다
    return { success: true, rev: team.rev, picks: team.picks };
}

/**
 * 선택을 최종 확정한다. 정확히 4명이어야 한다.
 */
function confirmTeam(team, token) {
    reapLock(team);
    if (team.confirmed) return { error: '이미 확정됐어요.' };
    if (!team.lock || team.lock.token !== token) return { error: '선택 권한이 없어요.' };
    if (team.picks.length !== PICKS_PER_TEAM)
        return { error: `${PICKS_PER_TEAM}명을 모두 선택해야 확정할 수 있어요. (현재 ${team.picks.length}명)` };

    team.confirmed   = true;
    team.confirmedAt = now();
    team.lock        = null;
    team.waiting     = [];
    return { success: true, picks: team.picks };
}

/**
 * 관리자 강제 확정. 저장된 선택은 유지하고 부족한 만큼 남은 후보에서 무작위로 채운다.
 */
function forceConfirmTeam(team) {
    if (team.confirmed) return { error: '이미 확정된 팀이에요.' };

    const rest   = team.candidates.filter(c => !team.picks.includes(c));
    const needed = PICKS_PER_TEAM - team.picks.length;
    const added  = shuffle(rest).slice(0, needed);

    team.picks       = [...team.picks, ...added];
    team.autoFilled  = added;
    team.confirmed   = true;
    team.confirmedAt = now();
    team.lock        = null;      // 권한 즉시 회수 — 이후 들어오는 저장 요청은 거부된다
    team.waiting     = [];
    team.rev        += 1;
    return { success: true, picks: team.picks, autoFilled: added };
}

// 확정 취소 — 선택한 실험체는 그대로 두고 다시 수정할 수 있게 한다
function unconfirmTeam(team) {
    if (!team.confirmed) return { error: '확정되지 않은 팀이에요.' };
    team.confirmed   = false;
    team.confirmedAt = null;
    team.autoFilled  = [];
    team.rev        += 1;
    return { success: true };
}

// ── 원형 선물 교환 ───────────────────────────────────
/**
 * 팀 번호로 하나의 원형 순서를 만든다. 예) 1 → 4 → 2 → 6 → 3 → 5 → 1
 * 각 팀은 자기 바로 앞 팀이 고른 실험체를 받는다.
 * @returns { order: [...], giverOf: { 받는 팀: 주는 팀 }, receiverOf: { 주는 팀: 받는 팀 } }
 */
function buildExchange(teams) {
    const order = shuffle(teams);
    const giverOf = {}, receiverOf = {};
    for (let i = 0; i < order.length; i++) {
        const giver    = order[i];
        const receiver = order[(i + 1) % order.length];
        receiverOf[giver] = receiver;
        giverOf[receiver] = giver;
    }
    return { order, giverOf, receiverOf };
}

/**
 * 전 팀이 확정되면 교환 순서를 정하고 팀원에게 실험체를 배정한다.
 * 이미 배정된 상태라면 다시 추첨하지 않는다.
 */
function finalizeAssignments(state, participants) {
    const teams = teamNumbers(participants);
    if (!teams.length) return { error: '배정할 팀이 없어요.' };

    const notConfirmed = teams.filter(t => !state.teams[t]?.confirmed);
    if (notConfirmed.length) return { error: `아직 확정하지 않은 팀이 있어요: ${notConfirmed.join(', ')}팀` };

    if (state.assignments) return { success: true, already: true, assignments: state.assignments };

    const { order, giverOf } = buildExchange(teams);
    const assignments = {};

    for (const t of teams) {
        const giver    = giverOf[t];
        const received = [...(state.teams[giver]?.picks ?? [])];
        const members  = shuffle(membersOfTeam(participants, t));
        const pool     = shuffle(received);

        const assigned = members.map((m, i) => ({
            token:     m.cancel_token,
            nickname:  m.discord_nickname,
            character: pool[i] ?? null,          // 팀원이 4명보다 많으면 남는 사람은 없음 처리
        }));
        const used     = assigned.map(a => a.character).filter(Boolean);
        const leftover = pool.filter(c => !used.includes(c));

        assignments[t] = { from: giver, received, members: assigned, leftover };
    }

    state.exchange    = { order, giverOf };
    state.assignments = assignments;
    state.phase       = PHASE.ASSIGNED;
    state.assignedAt  = now();
    return { success: true, assignments, order };
}

// ── 조회용 요약 ──────────────────────────────────────
/**
 * 관리자 화면에 보여줄 요약. 드래프트 진행 중에는 어떤 실험체를 골랐는지 공개하지 않는다.
 */
function adminSummary(state, participants) {
    if (!state) return null;
    const teams = teamNumbers(participants);
    const list = teams.map(t => {
        const team = state.teams[t] ?? null;
        const expired = !team || lockExpired(team);
        return {
            teamNum:    t,
            memberCount: membersOfTeam(participants, t).length,
            picked:     team?.picks.length ?? 0,
            total:      PICKS_PER_TEAM,
            confirmed:  !!team?.confirmed,
            status:     !team ? '대기' : team.confirmed ? '확정 완료' : (!expired ? '선택 중' : '대기'),
            holder:     !team || expired ? null : (team.lock?.nickname ?? null),
            waiting:    team?.waiting.length ?? 0,
            candidateCount: team?.candidates.length ?? 0,
        };
    });
    return {
        round: state.round,
        type: state.type,
        phase: state.phase,
        teams: list,
        allConfirmed: list.length > 0 && list.every(t => t.confirmed),
        resultsPublished: !!state.resultsPublished,
        exchangeReady: !!state.assignments,
    };
}

/**
 * 참가자 화면에 보여줄 자기 팀 상태. 다른 팀 정보는 절대 포함하지 않는다.
 */
function participantView(state, participant, participants) {
    const t = participant.team_num;
    const team = state?.teams?.[t];
    if (!team) return { error: '아직 드래프트가 시작되지 않았어요.' };

    reapLock(team);
    const isEditor = !!team.lock && team.lock.token === participant.cancel_token;
    return {
        round: state.round,
        phase: state.phase,
        teamNum: t,
        candidates: team.candidates,
        picksRequired: PICKS_PER_TEAM,
        confirmed: team.confirmed,
        rev: team.rev,
        // 확정 전에는 권한자만 선택 내용을 본다. 대기자에게는 진행률만 알려준다.
        picks: (isEditor || team.confirmed) ? team.picks : [],
        pickedCount: team.picks.length,
        role: team.confirmed ? 'done' : (isEditor ? 'editor' : 'waiting'),
        holderNickname: isEditor ? null : (team.lock?.nickname ?? null),
        autoFilled: team.confirmed ? team.autoFilled : [],
        memberCount: membersOfTeam(participants, t).length,
    };
}

module.exports = {
    PICKS_PER_TEAM, DEFAULT_CANDIDATES, MIN_CANDIDATES, LOCK_TTL_MS, PHASE,
    createState, candidateCount, startDraft,
    acquireLock, releaseLock, forceReleaseLock, reapLock, lockExpired,
    savePicks, confirmTeam, forceConfirmTeam, unconfirmTeam,
    buildExchange, finalizeAssignments,
    adminSummary, participantView,
    teamNumbers, membersOfTeam, shuffle,
};
