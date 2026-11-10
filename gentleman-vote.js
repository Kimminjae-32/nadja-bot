// 「저쪽 신사분이 주신 겁니다」 — 불행상 투표
//
// 투표를 시작하는 순간의 참가자·팀·실험체 배정을 스냅샷으로 저장한다.
// 이후 팀 구성이 바뀌어도 진행 중인 투표의 후보와 자격은 변하지 않는다.
//
// 비밀 보장: 투표가 마감되기 전에는 어떤 API도 득표수나 투표 내역을 돌려주지 않는다.
// 관리자에게도 "누가 투표를 마쳤는지"까지만 공개한다.

const W = require('./character-weapons');

const STATUS = { NONE: 'none', OPEN: 'open', CLOSED: 'closed', CANCELLED: 'cancelled' };

const now = () => Date.now();

/**
 * 투표를 시작한다. 우승팀 소속은 후보에서 빠지지만 투표는 할 수 있다.
 * @param assignments 드래프트 배정 결과 (참가자별 실험체와 선물한 팀)
 */
function openVote(participants, assignments, winnerTeam) {
    if (winnerTeam == null) return { error: '우승팀을 먼저 지정해야 투표를 시작할 수 있어요.' };
    if (!assignments)       return { error: '실험체 배정이 끝나야 투표를 시작할 수 있어요.' };

    const charOf = {};        // 참가자 토큰 → { character, fromTeam }
    for (const [teamNum, a] of Object.entries(assignments)) {
        for (const m of a.members) charOf[m.token] = { character: m.character, fromTeam: a.from, teamNum: Number(teamNum) };
    }

    // 이번 회차에 실험체를 배정받은 사람만 대상이다. 팀 미지정(실제 진행에서 빠진) 참가자는 후보·투표권 모두 없다.
    const inRound = p => p.team_num && charOf[p.cancel_token];

    // 후보: 이번 회차 참가자 중 우승팀을 제외한 사람
    const candidates = participants
        .filter(p => inRound(p) && p.team_num !== winnerTeam)
        .map(p => {
            const character = charOf[p.cancel_token]?.character ?? null;
            const info = character != null ? W.describe(character) : null;
            return {
                token:       p.cancel_token,
                nickname:    p.discord_nickname,
                teamNum:     p.team_num,
                character,                                  // 후보 ID (예: "1:15")
                characterName: info?.characterName ?? null,
                weaponName:  info?.weaponName ?? null,
                displayName: info?.displayName ?? null,
                fromTeam:    charOf[p.cancel_token]?.fromTeam ?? null,
            };
        });

    // 투표권: 이번 회차 참가자 전원 (우승팀 포함)
    const voters = participants
        .filter(inRound)
        .map(p => ({ token: p.cancel_token, nickname: p.discord_nickname, teamNum: p.team_num }));

    if (!candidates.length) return { error: '투표 후보가 없어요. 우승팀 외에 참가자가 있어야 합니다.' };

    return {
        success: true,
        vote: {
            status: STATUS.OPEN,
            openedAt: now(),
            closedAt: null,
            winnerTeam,
            snapshot: { candidates, voters },
            votes: {},                 // 투표자 토큰 → 후보 토큰
            messageId: null,
            remindMessageIds: [],
        },
    };
}

const isVoter    = (vote, token) => vote.snapshot.voters.some(v => v.token === token);
const isCandidate = (vote, token) => vote.snapshot.candidates.some(c => c.token === token);

/**
 * 투표하거나 대상을 바꾼다. 한 번 제출한 표를 완전히 철회할 수는 없다.
 */
function castVote(vote, voterToken, candidateToken) {
    if (!vote || vote.status !== STATUS.OPEN) return { error: '지금은 투표할 수 없어요.' };
    if (!isVoter(vote, voterToken))           return { error: '이번 투표에 참여할 자격이 없어요.' };
    if (!isCandidate(vote, candidateToken))   return { error: '투표할 수 없는 대상이에요.' };
    if (voterToken === candidateToken)        return { error: '자신에게는 투표할 수 없어요.' };

    const changed = vote.votes[voterToken] != null && vote.votes[voterToken] !== candidateToken;
    vote.votes[voterToken] = candidateToken;
    return { success: true, changed, myVote: candidateToken };
}

/**
 * 참가자에게 보여줄 투표 화면 정보. 다른 사람의 선택과 득표수는 담지 않는다.
 */
function voterView(vote, voterToken) {
    if (!vote || vote.status === STATUS.NONE)      return { error: '진행 중인 투표가 없어요.' };
    if (vote.status === STATUS.CANCELLED)          return { error: '취소된 투표예요.' };
    if (!isVoter(vote, voterToken))                return { error: '이번 투표에 참여할 자격이 없어요.' };

    return {
        status: vote.status,
        closed: vote.status === STATUS.CLOSED,
        myVote: vote.votes[voterToken] ?? null,
        // 자기 자신은 후보 목록에서 빼서 보여준다
        candidates: vote.snapshot.candidates.filter(c => c.token !== voterToken),
        votedCount: Object.keys(vote.votes).length,
        totalVoters: vote.snapshot.voters.length,
    };
}

/**
 * 관리자용 진행 상황. 마감 전에는 득표수를 절대 포함하지 않는다.
 */
function adminProgress(vote) {
    if (!vote || vote.status === STATUS.NONE) return { status: STATUS.NONE };
    const voted = new Set(Object.keys(vote.votes));
    return {
        status: vote.status,
        winnerTeam: vote.winnerTeam,
        totalVoters: vote.snapshot.voters.length,
        votedCount: voted.size,
        voters: vote.snapshot.voters.map(v => ({ nickname: v.nickname, teamNum: v.teamNum, voted: voted.has(v.token) })),
        candidateCount: vote.snapshot.candidates.length,
        // 마감된 뒤에만 집계를 넘긴다
        tally: vote.status === STATUS.CLOSED ? tallyVote(vote) : null,
    };
}

/**
 * 득표 집계. 0표 후보도 포함하며 동점은 같은 순위로 매긴다.
 */
function tallyVote(vote) {
    const counts = Object.fromEntries(vote.snapshot.candidates.map(c => [c.token, 0]));
    for (const target of Object.values(vote.votes)) {
        if (counts[target] != null) counts[target] += 1;
    }
    const rows = vote.snapshot.candidates
        .map(c => ({ ...c, votes: counts[c.token] }))
        .sort((a, b) => b.votes - a.votes || a.nickname.localeCompare(b.nickname, 'ko'));

    let rank = 0, prev = null, seen = 0;
    for (const r of rows) {
        seen += 1;
        if (r.votes !== prev) { rank = seen; prev = r.votes; }
        r.rank = rank;
    }
    const top = rows.length ? rows[0].votes : 0;
    return { rows, totalVotes: Object.keys(vote.votes).length, topVotes: top, winners: top > 0 ? rows.filter(r => r.votes === top) : [] };
}

function closeVote(vote) {
    if (!vote || vote.status !== STATUS.OPEN) return { error: '열려 있는 투표가 없어요.' };
    vote.status   = STATUS.CLOSED;
    vote.closedAt = now();
    return { success: true, tally: tallyVote(vote) };
}

function reopenVote(vote, unluckyPublished) {
    if (!vote || vote.status !== STATUS.CLOSED) return { error: '마감된 투표가 없어요.' };
    if (unluckyPublished) return { error: '이미 불행상 결과를 공개해서 다시 열 수 없어요.' };
    vote.status   = STATUS.OPEN;
    vote.closedAt = null;
    return { success: true };   // 기존 표는 그대로 유지한다
}

function cancelVote(vote) {
    if (!vote || vote.status === STATUS.NONE) return { error: '취소할 투표가 없어요.' };
    vote.status    = STATUS.CANCELLED;
    vote.votes     = {};        // 표를 모두 삭제한다
    vote.closedAt  = now();
    return { success: true };
}

module.exports = {
    STATUS, openVote, castVote, voterView, adminProgress,
    tallyVote, closeVote, reopenVote, cancelVote, isVoter, isCandidate,
};
