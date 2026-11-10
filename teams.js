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
const MAX_TEAMS = 8;                  // 팀 이름·색이 8팀까지 있다 (관리자가 직접 정할 수 있는 최대 팀 수)
const MIN_TEAM_SIZE = 2;              // 팀전에서 한 팀 최소 인원 — 1명 팀은 만들지 않는다

// 티어 이름 → 점수 (constants.TIERS의 value를 그대로 사용)
const TIER_VALUE = Object.fromEntries(TIERS.map(t => [t.name, t.value]));
const TIER_NAME_BY_VALUE = Object.fromEntries(TIERS.map(t => [t.value, t.name]));
const MAX_TIER_VALUE = Math.max(...TIERS.map(t => t.value));

// 한 팀 최대 인원 — 론울프는 1인 1팀
function maxTeamSize(ev) {
    if (ev?.gameType === '론울프') return 1;
    return MAX_TEAM_SIZE[ev?.mapType] ?? DEFAULT_MAX_TEAM_SIZE;
}

// 한 팀 최소 인원 — 론울프만 1명
function minTeamSize(ev) {
    return ev?.gameType === '론울프' ? 1 : MIN_TEAM_SIZE;
}

// 인원을 팀 수에 최대한 균등하게 나눈다 — 앞쪽 팀부터 1명씩 더 받는다. 예) 16명 · 5팀 → 4/3/3/3/3
function evenSizes(count, teamCount) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    const t = Math.max(0, Math.floor(Number(teamCount) || 0));
    if (!n || !t) return [];
    const base = Math.floor(n / t), rest = n % t;
    return Array.from({ length: t }, (_, i) => base + (i < rest ? 1 : 0));
}

/**
 * 이 인원으로 가능한 팀 수 범위 — 최대 인원을 넘지 않고, 최소 인원보다 작은 팀이 생기지 않는 범위.
 * @returns { min, max } (불가능하면 min > max)
 */
function teamCountRange(count, ev) {
    const n = Math.max(0, Number(count) || 0);
    const maxSize = maxTeamSize(ev), minSize = minTeamSize(ev);
    const cap = ev?.gameType === '론울프' ? n : MAX_TEAMS;
    return { min: Math.max(1, Math.ceil(n / maxSize)), max: Math.min(cap, Math.floor(n / minSize)) };
}

/**
 * 팀 구성 계획 — 관리자가 팀 수를 정했으면 그 값을 그대로 쓰고, 아니면 기존 자동 결정을 쓴다.
 * 정한 팀 수로 균등하게 나눌 수 없으면 팀 수를 바꾸지 않고 이유와 가능한 범위를 돌려준다.
 * @returns { sizes, teamCount, manual } 또는 { error, range, manual }
 */
function planTeams(count, ev, manualTeamCount = null) {
    const n = Math.max(0, Number(count) || 0);
    if (manualTeamCount == null) {
        const sizes = getTeamDistribution(n, ev);
        return { sizes, teamCount: sizes.length, manual: false };
    }
    const t = Math.floor(Number(manualTeamCount));
    const range = teamCountRange(n, ev);
    const maxSize = maxTeamSize(ev), minSize = minTeamSize(ev);
    if (!n) return { sizes: [], teamCount: t, manual: true };
    if (!Number.isFinite(t) || t < 1) return { error: '팀 수가 올바르지 않아요.', range, manual: true };
    const sizes = evenSizes(n, t);
    const rangeText = range.min <= range.max ? `${range.min}~${range.max}팀` : '없음';
    if (Math.max(...sizes) > maxSize)
        return { error: `${n}명을 ${t}팀으로 나누면 한 팀이 ${Math.max(...sizes)}명이 되어 최대 ${maxSize}명을 넘어요. 가능한 팀 수: ${rangeText}`, range, manual: true };
    if (Math.min(...sizes) < minSize)
        return { error: `${n}명을 ${t}팀으로 나누면 ${Math.min(...sizes)}명뿐인 팀이 생겨요. 한 팀은 최소 ${minSize}명이어야 해요. 가능한 팀 수: ${rangeText}`, range, manual: true };
    if (t > MAX_TEAMS && ev?.gameType !== '론울프')
        return { error: `팀은 최대 ${MAX_TEAMS}팀까지 만들 수 있어요. 가능한 팀 수: ${rangeText}`, range, manual: true };
    return { sizes, teamCount: t, manual: true };
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

/**
 * 고정(잠금)된 참가자를 반영해 팀별 목표 인원을 다시 맞춘다.
 * 고정 인원이 많은 팀은 그만큼 자리를 확보하고, 남는 인원은 다른 팀에서 덜어낸다.
 * @param sizes 고정을 고려하지 않은 기본 목표 인원
 * @param lockedCounts { 팀번호: 고정 인원수 }
 */
function adjustSizesForLocks(sizes, lockedCounts, maxSize) {
    const target = [...sizes];
    const total = sizes.reduce((a, b) => a + b, 0);
    const lockedOf = i => lockedCounts[i + 1] ?? 0;

    // 1) 고정 인원보다 목표가 작은 팀은 고정 인원만큼 올린다
    for (let i = 0; i < target.length; i++) target[i] = Math.max(target[i], lockedOf(i));

    // 2) 총합이 넘치면 여유가 있는 팀(목표 > 고정)에서 가장 큰 팀부터 하나씩 덜어낸다
    const sum = () => target.reduce((a, b) => a + b, 0);
    let guard = target.length * maxSize + 10;
    while (sum() > total && guard-- > 0) {
        let pick = -1;
        for (let i = 0; i < target.length; i++) {
            if (target[i] <= lockedOf(i)) continue;
            if (pick < 0 || target[i] > target[pick]) pick = i;
        }
        if (pick < 0) break;
        target[pick] -= 1;
    }
    // 3) 모자라면 최대 인원에 여유가 있는 팀 중 가장 작은 팀부터 채운다
    guard = target.length * maxSize + 10;
    while (sum() < total && guard-- > 0) {
        let pick = -1;
        for (let i = 0; i < target.length; i++) {
            if (target[i] >= maxSize) continue;
            if (pick < 0 || target[i] < target[pick]) pick = i;
        }
        if (pick < 0) break;
        target[pick] += 1;
    }
    return target;
}

// 사람이 읽을 수 있는 분배 설명 — 예) "21명 · 7팀 × 3명" / "17명 · 6팀 (3/3/3/3/3/2)"
function describeDistribution(sizes, count) {
    if (!sizes.length) return `${count || 0}명 · 배정할 참가자가 없어요`;
    const uniform = sizes.every(s => s === sizes[0]);
    return uniform
        ? `${count}명 · ${sizes.length}팀 × ${sizes[0]}명`
        : `${count}명 · ${sizes.length}팀 (${sizes.join('/')})`;
}

// Fisher-Yates — sort(() => Math.random() - 0.5)는 순서가 고르게 섞이지 않는다
const shuffled = arr => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

// 목표 인원에 맞춰 무작위 배정
function distributeRandom(participants, sizes, locked = []) {
    const teams = sizes.map(() => []);
    const lockedSet = new Set(locked.map(p => p.cancel_token));

    // 고정된 참가자는 원래 팀에 먼저 넣는다
    for (const p of locked) {
        const i = p.team_num - 1;
        if (teams[i]) teams[i].push(p);
    }
    const pool = shuffled(participants.filter(p => !lockedSet.has(p.cancel_token)));
    let idx = 0;
    for (let t = 0; t < sizes.length; t++) {
        while (teams[t].length < sizes[t] && idx < pool.length) teams[t].push(pool[idx++]);
    }
    // 목표를 채우고도 남은 사람은 자리가 있는 팀에 넣는다 (고정 때문에 생길 수 있다)
    while (idx < pool.length) {
        const t = teams.reduce((best, team, i) => team.length < teams[best].length ? i : best, 0);
        teams[t].push(pool[idx++]);
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
function distributeByTier(participants, sizes, locked = []) {
    const avg = averageTierValue(participants);
    const lockedSet = new Set(locked.map(p => p.cancel_token));
    const scored = shuffled(participants.filter(p => !lockedSet.has(p.cancel_token)))
        .map(p => ({ p, score: tierScore(p, avg) }))
        .sort((a, b) => b.score - a.score);       // 동점은 위에서 섞인 순서 유지

    const teams = sizes.map(() => []);
    const sums  = sizes.map(() => 0);

    // 고정된 참가자를 먼저 배치하고 그 실력도 팀 합계에 반영한다
    for (const p of locked) {
        const i = p.team_num - 1;
        if (!teams[i]) continue;
        teams[i].push(p);
        sums[i] += tierScore(p, avg);
    }

    for (const { p, score } of scored) {
        let best = [], bestSum = Infinity;
        for (let t = 0; t < teams.length; t++) {
            if (teams[t].length >= sizes[t]) continue;        // 목표 인원 초과 금지
            if (sums[t] < bestSum - 1e-9) { bestSum = sums[t]; best = [t]; }
            else if (Math.abs(sums[t] - bestSum) <= 1e-9) best.push(t);
        }
        if (!best.length) {
            // 고정 인원 때문에 목표가 꽉 찼다면 최대 인원에 여유가 있는 팀 중 가장 약한 팀에 넣는다
            let fallback = -1;
            for (let t = 0; t < teams.length; t++) {
                if (fallback < 0 || sums[t] < sums[fallback]) fallback = t;
            }
            if (fallback < 0) break;
            teams[fallback].push(p);
            sums[fallback] += score;
            continue;
        }
        const pick = best[Math.floor(Math.random() * best.length)];
        teams[pick].push(p);
        sums[pick] += score;
    }
    return teams;
}

// 고정된 참가자 목록에서 팀별 고정 인원수를 센다
function countLockedByTeam(locked) {
    const counts = {};
    for (const p of locked) if (p.team_num) counts[p.team_num] = (counts[p.team_num] ?? 0) + 1;
    return counts;
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
        if (sizes && team.length < sizes[i]) errors.push(`${i + 1}팀 인원 ${team.length}명 — 목표 ${sizes[i]}명 미달`);
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
    MAX_TEAM_SIZE, LUMIA_MAX_TEAMS, MAX_TEAMS, MIN_TEAM_SIZE, TIER_VALUE, TIER_NAME_BY_VALUE,
    maxTeamSize, minTeamSize, evenSizes, teamCountRange, planTeams, tierScore, averageTierValue, teamAverageTier,
    getTeamDistribution, describeDistribution, adjustSizesForLocks, countLockedByTeam,
    distributeRandom, distributeByTier, validateTeamDistribution,
};
