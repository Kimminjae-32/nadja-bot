// 실험체 × 무기군 후보 데이터
//
// 「저쪽 신사분이 주신 겁니다」와 실험체 랜덤 배정은 실험체 이름이 아니라 "실험체 + 무기군" 조합을
// 하나의 후보로 다룬다. 예) 단검 재키 / 양손검 재키 / 도끼 재키 / 쌍검 재키 는 서로 다른 후보다.
// 알렉스는 예외로 무기군을 나누지 않고 하나의 후보로만 취급한다.
//
// 후보 ID: "실험체코드:무기코드" (예: "1:15" = 단검 재키). 알렉스는 "27"처럼 실험체 코드만 쓴다.
// 무기 코드는 공식 Open API의 무기 숙련도 코드(WeaponType)와 같다.
//
// 데이터 출처
//  - 기본값: 공식 데이터(CharacterMastery)를 검증해 아래 SNAPSHOT에 내장해 둔 값 (2026-11 기준, 91명)
//  - 실행 중: 서버가 시작되면 공식 Open API /v1/data/CharacterMastery 를 다시 받아 검증한 뒤 캐시 파일에 저장한다.
//    API가 실패하면 캐시 → 내장 값 순서로 사용하므로 추첨은 끊기지 않는다.

const fs = require('fs');
const path = require('path');
const { CHAR_CODE } = require('./constants');

const CACHE_PATH = path.join(process.cwd(), 'character-weapons.cache.json');

// 무기 숙련도 코드 → { key: 공식 영문 키, name: 한국어 이름 }
const WEAPON_TYPES = {
    1:  { key: 'Glove',         name: '글러브' },
    2:  { key: 'Tonfa',         name: '톤파' },
    3:  { key: 'Bat',           name: '방망이' },
    4:  { key: 'Whip',          name: '채찍' },
    5:  { key: 'HighAngleFire', name: '투척' },
    6:  { key: 'DirectFire',    name: '암기' },
    7:  { key: 'Bow',           name: '활' },
    8:  { key: 'CrossBow',      name: '석궁' },
    9:  { key: 'Pistol',        name: '권총' },
    10: { key: 'AssaultRifle',  name: '돌격 소총' },
    11: { key: 'SniperRifle',   name: '저격총' },
    13: { key: 'Hammer',        name: '망치' },
    14: { key: 'Axe',           name: '도끼' },
    15: { key: 'OneHandSword',  name: '단검' },
    16: { key: 'TwoHandSword',  name: '양손검' },
    18: { key: 'DualSword',     name: '쌍검' },
    19: { key: 'Spear',         name: '창' },
    20: { key: 'Nunchaku',      name: '쌍절곤' },
    21: { key: 'Rapier',        name: '레이피어' },
    22: { key: 'Guitar',        name: '기타' },
    23: { key: 'Camera',        name: '카메라' },
    24: { key: 'Arcana',        name: '아르카나' },
    25: { key: 'VFArm',         name: 'VF의수' },
};
const WEAPON_ID_BY_KEY = Object.fromEntries(Object.entries(WEAPON_TYPES).map(([id, w]) => [w.key, Number(id)]));

// 무기군을 나누지 않는 실험체 (실험체 이름 기준)
const NO_SPLIT = new Set(['알렉스']);

// 실험체 코드 → 사용 가능한 무기 코드 (공식 CharacterMastery 기준, 게임 내 순서)
const SNAPSHOT = {
    1: [15, 16, 14, 18],   // 재키
    2: [9, 10, 11],        // 아야
    3: [21, 16, 19],       // 피오라
    4: [13, 3],            // 매그너스
    5: [5, 6],             // 자히르
    6: [7, 8],             // 나딘
    7: [1, 2],             // 현우
    8: [22],               // 하트
    9: [10, 9],            // 아이솔
    10: [1, 20],           // 리 다이린
    11: [16, 18],          // 유키
    12: [7, 6],            // 혜진
    13: [15, 19],          // 쇼우
    14: [21],              // 키아라
    15: [5, 6],            // 시셀라
    16: [9],               // 실비아
    17: [5],               // 아드리아나
    18: [15],              // 쇼이치
    19: [6, 24],           // 엠마
    20: [4],               // 레녹스
    21: [9],               // 로지
    22: [3],               // 루크
    23: [15, 18],          // 캐시
    24: [21, 3],           // 아델라
    25: [11],              // 버니스
    26: [9],               // 바바라
    27: [2, 16, 6, 9],     // 알렉스 (후보는 하나로만 만든다)
    28: [13, 3],           // 수아
    29: [1, 2],            // 레온
    30: [13],              // 일레븐
    31: [7],               // 리오
    32: [5],               // 윌리엄
    33: [1],               // 니키
    34: [23],              // 나타폰
    35: [1, 2],            // 얀
    36: [5],               // 이바
    37: [15],              // 다니엘
    38: [9],               // 제니
    39: [18, 21],          // 카밀로
    40: [6],               // 클로에
    41: [24],              // 요한
    42: [24],              // 비앙카
    43: [5],               // 셀린
    44: [25],              // 에키온
    45: [4],               // 마이
    46: [16],              // 에이든
    47: [4],               // 라우라
    48: [3],               // 띠아
    49: [19],              // 펠릭스
    50: [21],              // 엘레나
    51: [22],              // 프리야
    52: [24],              // 아디나
    53: [14, 13],          // 마커스
    54: [8],               // 칼라
    55: [14],              // 에스텔
    56: [20],              // 피올로
    57: [23],              // 마르티나
    58: [10],              // 헤이즈
    59: [2],               // 아이작
    60: [6],               // 타지아
    61: [5],               // 이렘
    62: [11],              // 테오도르
    63: [15],              // 이안
    64: [24],              // 바냐
    65: [16],              // 데비&마를렌
    66: [24],              // 아르다
    67: [14],              // 아비게일
    68: [1],               // 알론소
    69: [9],               // 레니
    70: [6],               // 츠바메
    71: [14],              // 케네스
    72: [11],              // 카티야
    73: [24],              // 샬럿
    74: [3],               // 다르코
    75: [22],              // 르노어
    76: [3],               // 가넷
    77: [24],              // 유민
    78: [16],              // 히스이
    79: [8],               // 유스티나
    80: [19],              // 이슈트반
    81: [9],               // 니아
    82: [21],              // 슈린
    83: [6],               // 헨리
    84: [18],              // 블레어
    85: [13],              // 미르카
    86: [1],               // 펜리르
    87: [24],              // 코렐라인
    88: [3],               // 비형
    89: [9],               // 크레이버
    90: [11],              // 루치아
    91: [16],              // 세레스
};

let current = { source: 'snapshot', fetchedAt: null, weapons: SNAPSHOT };

/**
 * 무기 데이터 검증 — 알려진 실험체·무기 코드만 남긴다.
 * 내장 데이터에 있는 실험체가 하나라도 빠지면 잘못된 응답으로 보고 null을 돌려준다.
 */
function validateWeapons(weapons) {
    if (!weapons || typeof weapons !== 'object') return null;
    const out = {};
    for (const [code, list] of Object.entries(weapons)) {
        if (!CHAR_CODE[code] || !Array.isArray(list)) continue;
        const valid = [...new Set(list.map(Number).filter(w => WEAPON_TYPES[w]))];
        if (valid.length) out[code] = valid;
    }
    const missing = Object.keys(SNAPSHOT).filter(code => !out[code]);
    if (missing.length) return null;
    return out;
}

// 캐시 파일이 있으면 먼저 불러온다 (서버를 다시 켜도 마지막으로 검증한 데이터를 쓴다)
try {
    if (fs.existsSync(CACHE_PATH)) {
        const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
        const checked = validateWeapons(cached.weapons);
        if (checked) current = { source: 'cache', fetchedAt: cached.fetchedAt ?? null, weapons: checked };
    }
} catch (e) {
    console.warn('[weapons] 캐시를 읽지 못해 내장 데이터를 씁니다:', e.message);
}

/**
 * 공식 Open API에서 실험체별 무기군을 다시 받아 검증한다.
 * 성공하면 캐시 파일에 저장하고, 실패하면 기존 데이터를 그대로 둔다.
 */
async function refreshFromApi({ apiKey = process.env.ER_API_KEY, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) return { ok: false, reason: 'ER_API_KEY 없음' };
    try {
        const res = await fetchImpl('https://open-api.bser.io/v1/data/CharacterMastery', {
            headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(8000),
        });
        const body = await res.json();
        const rows = Array.isArray(body?.data) ? body.data : [];
        const weapons = {};
        const unknownKeys = new Set();
        for (const row of rows) {
            const code = row.characterCode ?? row.code;
            const keys = [row.weapon1, row.weapon2, row.weapon3, row.weapon4].filter(k => k && k !== 'None');
            for (const k of keys) if (!WEAPON_ID_BY_KEY[k]) unknownKeys.add(k);
            weapons[code] = keys.map(k => WEAPON_ID_BY_KEY[k]).filter(Boolean);
        }
        if (unknownKeys.size) console.warn('[weapons] 알 수 없는 무기군 키는 제외합니다:', [...unknownKeys].join(', '));
        const checked = validateWeapons(weapons);
        if (!checked) return { ok: false, reason: '응답 검증 실패 (실험체 누락)' };

        const fetchedAt = Date.now();
        current = { source: 'api', fetchedAt, weapons: checked };
        try { fs.writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt, weapons: checked }, null, 2)); }
        catch (e) { console.warn('[weapons] 캐시 저장 실패:', e.message); }
        return { ok: true, count: Object.keys(checked).length };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

// ── 후보 만들기 ───────────────────────────────────────
function makeCandidate(characterCode, weaponType) {
    const characterName = CHAR_CODE[characterCode];
    if (!characterName) return null;
    if (NO_SPLIT.has(characterName) || weaponType == null) {
        return {
            id: String(characterCode), characterCode: Number(characterCode), characterName,
            weaponType: null, weaponKey: null, weaponName: null, displayName: characterName,
        };
    }
    const w = WEAPON_TYPES[weaponType];
    if (!w) return null;
    return {
        id: `${characterCode}:${weaponType}`,
        characterCode: Number(characterCode),
        characterName,
        weaponType: Number(weaponType),
        weaponKey: w.key,
        weaponName: w.name,
        displayName: `${w.name} ${characterName}`,
    };
}

/** 전체 후보 목록 (실험체 코드 순 → 게임 내 무기 순) */
function allCandidates() {
    const list = [];
    const codes = Object.keys(current.weapons).map(Number).sort((a, b) => a - b);
    for (const code of codes) {
        if (NO_SPLIT.has(CHAR_CODE[code])) { list.push(makeCandidate(code, null)); continue; }
        for (const w of current.weapons[code]) {
            const c = makeCandidate(code, w);
            if (c) list.push(c);
        }
    }
    return list;
}

/** 밴을 반영한 후보 목록 — 밴은 실험체 이름 단위라 그 실험체의 모든 무기군이 빠진다. */
function candidatePool(bannedCharacters = []) {
    const banned = new Set(bannedCharacters);
    return allCandidates().filter(c => !banned.has(c.characterName));
}

const CODE_BY_NAME = Object.fromEntries(Object.entries(CHAR_CODE).map(([code, name]) => [name, Number(code)]));

/**
 * 후보 ID(또는 표시 이름)를 후보 정보로 바꾼다.
 * 이전 버전에서 저장한 실험체 이름만 있는 값도 그대로 보여줄 수 있게 처리한다.
 */
function describe(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value.id != null ? describe(value.id) : null;
    const s = String(value);

    const m = /^(\d+)(?::(\d+))?$/.exec(s);
    if (m) {
        const c = makeCandidate(Number(m[1]), m[2] != null ? Number(m[2]) : null);
        if (c) return c;
    }
    // 표시 이름 ("단검 재키")
    for (const [wid, w] of Object.entries(WEAPON_TYPES)) {
        if (!s.startsWith(w.name + ' ')) continue;
        const name = s.slice(w.name.length + 1);
        const code = CODE_BY_NAME[name];
        if (code && !NO_SPLIT.has(name)) return makeCandidate(code, Number(wid));
    }
    // 실험체 이름만 있는 값 (이전 데이터 호환)
    if (CODE_BY_NAME[s]) {
        if (NO_SPLIT.has(s)) return makeCandidate(CODE_BY_NAME[s], null);
        return {
            id: s, characterCode: CODE_BY_NAME[s], characterName: s,
            weaponType: null, weaponKey: null, weaponName: null, displayName: s,
        };
    }
    return { id: s, characterCode: null, characterName: s, weaponType: null, weaponKey: null, weaponName: null, displayName: s };
}

/** 후보 ID 목록 → { id: 후보 정보 } (화면에 함께 내려보낼 때 쓴다) */
function infoMap(ids) {
    const out = {};
    for (const id of ids ?? []) if (id != null) out[id] = describe(id);
    return out;
}

function status() {
    return {
        source: current.source, fetchedAt: current.fetchedAt,
        characterCount: Object.keys(current.weapons).length, candidateCount: allCandidates().length,
    };
}

module.exports = {
    WEAPON_TYPES, WEAPON_ID_BY_KEY, NO_SPLIT, SNAPSHOT,
    allCandidates, candidatePool, describe, infoMap, makeCandidate,
    refreshFromApi, validateWeapons, status,
};
