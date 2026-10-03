// 팀 분배 공통 로직 — 팀 수 결정, 팀당 최대 인원 제한, 티어 밸런스 배정, 검증
// 팀을 만드는 모든 경로(자동 배정 / 팀 섞기(티어) / 수동 배정)가 이 파일을 거친다.

const { TIERS } = require('./constants');

// 맵·모드별 한 팀 최대 인원 (여기 한 곳에서만 관리)
const MAX_TEAM_SIZE = {
    '루미아 섬':       3,
    '코발트':          4,
    '코발트 토너먼트': 4,
};
const DEFAULT_MAX_TEAM_SIZE = 4;
const LUMIA_MAX_TEAMS = 8;            // 루미아 섬은 최대 8팀 (기존 규칙)

// 티어 이름 → 점수 (constants.TIERS의 value를 그대로 사용)
const TIER_VALUE = Object.fromEntries(TIERS.map(t => [t.name, t.value]));
const TIER_NAME_BY_VALUE = Object.fromEntries(TIERS.map(t => [t.value, t.name]));
const MAX_TIER_VALUE = Math.max(...TIERS.map(t => t.value));

// 한 팀 최대 인원 — 론울프는 1인 1팀
function maxTeamSize(ev) {
    if (ev?.gameType === '론울프') return 1;
    return MAX_TEAM_SIZE[ev?.mapType] ?? DEFAULT_MAX_TEAM_SIZE;
}

// 티어 점수 — 티어(0~10)가 기준, 같은 티어 안에서는 MMR로 미세 조정
// 티어 미설정(null)은 상·하위 어느 쪽으로도 쏠리지 않도록 호출 측에서 평균값을 넘겨준다.
function tierScore(p, fallbackValue) {
    const v = (p.tier != null && TIER_VALUE[p.tier] != null)
        ? TIER_VALUE[p.tier]
        : (Number.isFinite(fallbackValue) ? fallbackValue : MAX_TIER_VALUE / 2);
    const mmr = Number.isFinite(p.mmr) ? Math.max(0, Math.min(10000, p.mmr)) : 0;
    return v * 100 + mmr / 100;          // 티어가 절대 우선, MMR은 같은 티어 내 보정
}

// 티어가 설정된 참가자들의 평균 티어 값 (미설정자 대체용)
function averageTierValue(list) {
    const vals = list.map(p => TIER_VALUE[p.tier]).filter(v => Number.isFinite(v));
    if (!vals.length) return MAX_TIER_VALUE / 2;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * 참가 인원과 모드로 팀별 목표 인원을 결정한다.
 * - 모든 팀 인원이 같아지는 조합이 있으면 그것을 우선 (팀 수가 많은 쪽)
 * - 불가능하면 팀 간 인원 차이가 1명을 넘지 않도록 나눈다
 * - 빈 팀은 만들지 않고, 어떤 팀도 최대 인원을 넘지 않는다
 * @returns number[] 예) 21명 루미아 → [3,3,3,3,3,3,3]
 */
function getTeamDistribution(participantCount, ev) {
    const count = Math.max(0, Number(participantCount) || 0);
    if (!count) return [];

    const maxSize = maxTeamSize(ev);
    if (maxSize === 1) return Array(count).fill(1);          // 론울프

    const isLumia = ev?.mapType === '루미아 섬' && ev?.gameType !== '론울프';
    const minTeams = Math.ceil(count / maxSize);             // 최대 인원을 지키려면 최소 이만큼 필요

    let teamCount;
    if (isLumia) {
        // 1) 모든 팀 인원이 같아지는 조합을 찾되, 팀 인원이 큰 쪽(3명)부터 우선한다
        //    예) 21명 → 3명씩 7팀 / 16명 → 3명씩은 안 나누어떨어지므로 2명씩 8팀
        let equal = null;
        for (let size = maxSize; size >= 2; size--) {
            if (count % size !== 0) continue;
            const t = count / size;
            if (t >= 1 && t <= LUMIA_MAX_TEAMS) { equal = t; break; }
        }
        // 2) 딱 나누어떨어지지 않으면 최대 인원을 지키는 최소 팀 수 (팀 간 차이는 1명 이하)
        teamCount = equal ?? Math.max(minTeams, 1);
    } else {
        // 코발트 계열은 기존 팀 수를 유지하되, 인원이 넘치면 최대 인원을 지키도록 팀을 늘린다
        const base = Math.max(1, Number(ev?.teamCount) || 2);
        teamCount = Math.max(base, minTeams);
    }
    teamCount = Math.max(1, Math.min(teamCount, count));     // 빈 팀 금지

    const base = Math.floor(count / teamCount);
    const rest = count % teamCount;                          // 앞쪽 rest개 팀이 1명 더
    return Array.from({ length: teamCount }, (_, i) => base + (i < rest ? 1 : 0));
}

// 사람이 읽을 수 있는 분배 설명 — 예) "21명 · 7팀 × 3명" / "17명 · 6팀 (3/3/3/3/3/2)"
function describeDistribution(sizes, count) {
    if (!sizes.length) return `${count || 0}명 · 배정할 참가자가 없어요`;
    const uniform = sizes.every(s => s === sizes[0]);
    return uniform
        ? `${count}명 · ${sizes.length}팀 × ${sizes[0]}명`
        : `${count}명 · ${sizes.length}팀 (${sizes.join('/')})`;
}

const shuffled = arr => [...arr].sort(() => Math.random() - 0.5);

// 목표 인원에 맞춰 무작위 배정
function distributeRandom(participants, sizes) {
    const teams = sizes.map(() => []);
    const pool = shuffled(participants);
    let idx = 0;
    for (let t = 0; t < sizes.length; t++) {
        for (let n = 0; n < sizes[t] && idx < pool.length; n++) teams[t].push(pool[idx++]);
    }
    return teams;
}

/**
 * 티어 밸런스 배정 — 강한 참가자가 한 팀에 몰리지 않도록 분산한다.
 * 1) 티어 점수 내림차순 정렬, 같은 점수끼리는 무작위로 섞음
 * 2) 위에서부터 한 명씩, 아직 자리가 남은 팀 중 현재 티어 합계가 가장 낮은 팀에 넣음
 * 3) 합계가 같은 팀이 여러 개면 무작위로 고름
 * 같은 티어끼리 순서를 섞기 때문에 실행할 때마다 조합은 달라지지만, 팀 간 실력 차는 크게 벌어지지 않는다.
 */
function distributeByTier(participants, sizes) {
    const avg = averageTierValue(participants);
    const scored = shuffled(participants)
        .map(p => ({ p, score: tierScore(p, avg) }))
        .sort((a, b) => b.score - a.score);       // 동점은 위에서 섞인 순서 유지

    const teams = sizes.map(() => []);
    const sums  = sizes.map(() => 0);

    for (const { p, score } of scored) {
        let best = [], bestSum = Infinity;
        for (let t = 0; t < teams.length; t++) {
            if (teams[t].length >= sizes[t]) continue;        // 목표 인원 초과 금지
            if (sums[t] < bestSum - 1e-9) { bestSum = sums[t]; best = [t]; }
            else if (Math.abs(sums[t] - bestSum) <= 1e-9) best.push(t);
        }
        if (!best.length) break;                              // 자리가 없으면 중단 (검증에서 걸림)
        const pick = best[Math.floor(Math.random() * best.length)];
        teams[pick].push(p);
        sums[pick] += score;
    }
    return teams;
}

// 팀 평균 티어 — { value, name } (표시용)
function teamAverageTier(members, fallbackValue) {
    if (!members.length) return null;
    const avg = members.reduce((s, p) => {
        const v = TIER_VALUE[p.tier];
        return s + (Number.isFinite(v) ? v : (Number.isFinite(fallbackValue) ? fallbackValue : MAX_TIER_VALUE / 2));
    }, 0) / members.length;
    return { value: Math.round(avg * 10) / 10, name: TIER_NAME_BY_VALUE[Math.round(avg)] ?? '-' };
}

/**
 * 배정 결과 검증 — 문제가 있으면 원인을 콘솔에 자세히 남기고 false를 반환한다.
 */
function validateTeamDistribution(teams, participants, ev, sizes) {
    const errors = [];
    const maxSize = maxTeamSize(ev);
    const seen = new Map();

    teams.forEach((team, i) => {
        if (!team.length) errors.push(`${i + 1}팀이 비어 있습니다.`);
        if (team.length > maxSize) errors.push(`${i + 1}팀 인원 ${team.length}명 — ${ev?.mapType || ev?.gameType} 최대 ${maxSize}명 초과`);
        if (sizes && team.length > sizes[i]) errors.push(`${i + 1}팀 인원 ${team.length}명 — 목표 ${sizes[i]}명 초과`);
        for (const p of team) {
            const prev = seen.get(p.cancel_token);
            if (prev != null) errors.push(`${p.discord_nickname}(이)가 ${prev + 1}팀과 ${i + 1}팀에 중복 배정됐습니다.`);
            else seen.set(p.cancel_token, i);
        }
    });

    const missing = participants.filter(p => !seen.has(p.cancel_token));
    if (missing.length) errors.push(`배정되지 않은 참가자 ${missing.length}명: ${missing.map(p => p.discord_nickname).join(', ')}`);
    if (seen.size !== participants.length) errors.push(`참가자 수 불일치 — 전체 ${participants.length}명, 배정 ${seen.size}명`);

    if (errors.length) {
        console.error('[팀 배정 검증 실패]');
        console.error(`모드: ${ev?.gameType} / ${ev?.mapType} · 최대 ${maxSize}명 · 목표 ${sizes ? sizes.join('/') : '-'}`);
        console.error(`실제: ${teams.map(t => t.length).join('/')}`);
        for (const e of errors) console.error(` - ${e}`);
        return false;
    }
    return true;
}

module.exports = {
    MAX_TEAM_SIZE, LUMIA_MAX_TEAMS, TIER_VALUE, TIER_NAME_BY_VALUE,
    maxTeamSize, tierScore, averageTierValue, teamAverageTier,
    getTeamDistribution, describeDistribution,
    distributeRandom, distributeByTier, validateTeamDistribution,
};
