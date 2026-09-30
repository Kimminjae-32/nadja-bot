// 오늘의 포켓몬 — PokeAPI (https://pokeapi.co) 한국어 데이터 사용
// 뽑기는 "사용자 + 날짜(한국 시간)" 해시로 정해지므로 같은 날에는 언제 실행해도 같은 포켓몬이 나옴
// 포획 기록은 pokedex.json 에 저장

const fs = require('fs');

const API      = 'https://pokeapi.co/api/v2';
const MAX_DEX  = 1025;              // 전국도감 마지막 번호 (2026-09 기준)
const DB_PATH  = './pokedex.json';

const _cache  = new Map();          // dexNo → 포켓몬 정보
const _typeKo = new Map();          // 영문 타입명 → 한국어

// ── 유틸 ────────────────────────────────────────────
// 한국 시간 기준 오늘 날짜 (YYYY-MM-DD)
function todayKST() {
    return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 문자열 → 32bit 해시 (FNV-1a)
function hash(str) {
    let h = 0x811c9dc5;
    for (const ch of str) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

// ── 공통 HTTP 유틸 ──────────────────────────────────
// PokeAPI 호출은 전부 이 함수를 거친다. 실패 시 콘솔에 원인을 상세히 남기고,
// 일시적인 오류(429/5xx/네트워크/타임아웃)는 1초 → 2초 간격으로 최대 3회까지 재시도한다.
const TIMEOUT_MS   = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY  = [1000, 2000];              // 1차 실패 후 1초, 2차 실패 후 2초
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function logFail(kind, url, attempt, extra) {
    console.error(`[PokeAPI] ${kind}`);
    console.error(`URL: ${url}`);
    console.error(`Attempt: ${attempt}/${MAX_ATTEMPTS}`);
    for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null && v !== '') console.error(`${k}: ${v}`);
    }
}

async function fetchJson(url) {
    let lastErr = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
        let res;
        try {
            res = await fetch(url, { signal: ac.signal, headers: { 'accept': 'application/json' } });
        } catch (e) {
            clearTimeout(timer);
            const timedOut = e.name === 'AbortError' || e.name === 'TimeoutError';
            lastErr = new Error(timedOut ? `PokeAPI timeout ${TIMEOUT_MS}ms | ${url}` : `PokeAPI fetch failed | ${url} | ${e.message}`);
            lastErr.cause = e;
            logFail(timedOut ? '요청 타임아웃' : '네트워크 오류(fetch failed)', url, attempt, {
                Error: e.message,
                Cause: e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : undefined,
                Code: e.cause?.code || e.code,          // ENOTFOUND / ECONNREFUSED / ETIMEDOUT 등
                Timeout: timedOut ? `${TIMEOUT_MS}ms 초과` : undefined,
                Stack: e.stack?.split('\n').slice(0, 3).join(' | '),
            });
            if (attempt < MAX_ATTEMPTS) { await sleep(RETRY_DELAY[attempt - 1]); continue; }
            throw lastErr;
        }
        clearTimeout(timer);

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            const retriable = RETRY_STATUS.has(res.status);
            lastErr = new Error(`PokeAPI HTTP ${res.status} ${res.statusText} | ${url} | ${body.slice(0, 300)}`);
            logFail('요청 실패(HTTP 오류)', url, attempt, {
                Status: res.status,
                StatusText: res.statusText,
                Retriable: retriable ? '예 (재시도함)' : '아니오 (즉시 중단)',
                Body: body.slice(0, 300),
            });
            // 400/404 처럼 재시도해도 결과가 같은 오류는 바로 중단
            if (!retriable || attempt === MAX_ATTEMPTS) throw lastErr;
            await sleep(RETRY_DELAY[attempt - 1]);
            continue;
        }

        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch (e) {
            const err = new Error(`PokeAPI JSON 파싱 실패 | ${url} | ${e.message}`);
            err.cause = e;
            logFail('JSON 파싱 실패', url, attempt, {
                Status: res.status,
                ContentType: res.headers.get('content-type'),
                Error: e.message,
                Body: text.slice(0, 300),
            });
            throw err;   // 응답은 정상 수신했으므로 재시도하지 않음
        }
    }
    throw lastErr ?? new Error(`PokeAPI 요청 실패 | ${url}`);
}

const ko = (list, key = 'name') => list?.find(x => x.language?.name === 'ko')?.[key] ?? null;

// ── PokeAPI ─────────────────────────────────────────
async function typeNameKo(enName) {
    if (_typeKo.has(enName)) return _typeKo.get(enName);
    try {
        const d = await fetchJson(`${API}/type/${enName}`);
        const name = ko(d.names) ?? enName;
        _typeKo.set(enName, name);
        return name;
    } catch (e) {
        // 타입 이름은 부가 정보이므로 기능 전체를 실패시키지 않고 영문명으로 표시
        console.warn(`[PokeAPI] 타입 이름 조회 실패 (영문명으로 대체): ${enName} — ${e.message}`);
        return enName;
    }
}

async function fetchPokemon(dexNo) {
    if (_cache.has(dexNo)) return _cache.get(dexNo);

    const [species, poke] = await Promise.all([
        fetchJson(`${API}/pokemon-species/${dexNo}`),
        fetchJson(`${API}/pokemon/${dexNo}`),
    ]);

    // 예상과 다른 응답 구조도 원인을 알 수 있게 확인
    if (!Array.isArray(species?.flavor_text_entries) || !Array.isArray(poke?.types)) {
        console.error('[PokeAPI] 예상하지 못한 응답 구조');
        console.error(`dexNo: ${dexNo}`);
        console.error(`species keys: ${species ? Object.keys(species).slice(0, 10).join(', ') : 'null'}`);
        console.error(`pokemon keys: ${poke ? Object.keys(poke).slice(0, 10).join(', ') : 'null'}`);
        throw new Error(`PokeAPI 응답 구조 이상 | dexNo=${dexNo}`);
    }

    // 한국어 도감 설명 (없으면 영어 폴백)
    const hasKo = species.flavor_text_entries.some(f => f.language.name === 'ko');
    const flavors = species.flavor_text_entries
        .filter(f => f.language.name === (hasKo ? 'ko' : 'en'))
        .map(f => f.flavor_text.replace(/[\n\f\r­]+/g, ' ').replace(/\s+/g, ' ').trim());

    const types = await Promise.all(poke.types.map(t => typeNameKo(t.type.name)));

    const info = {
        dexNo,
        name:   ko(species.names) ?? poke.name,
        genus:  ko(species.genera, 'genus'),
        flavors: [...new Set(flavors)],
        types,
        image:  poke.sprites?.other?.['official-artwork']?.front_default
                ?? poke.sprites?.front_default ?? null,
        captureRate: species.capture_rate ?? 45,   // 0~255 (클수록 잘 잡힘)
        isLegendary: !!species.is_legendary,
        isMythical:  !!species.is_mythical,
    };
    _cache.set(dexNo, info);
    return info;
}

// 포획 판정 — 본가 게임(3~4세대) 공식을 그대로 사용
//   a = (3·maxHP - 2·curHP) × 포획률 × 볼 보정 / (3·maxHP) × 상태이상 보정
//   b = 1048560 / √√(16711680 / a)          (흔들림 판정값)
//   4번의 흔들림을 모두 통과하면 포획 성공 → 확률 = (b / 65536)^4
// 야생 조우 직후 상황을 가정해 체력 만피 · 몬스터볼(×1) · 상태이상 없음으로 계산한다.
const BALL_BONUS   = 1;      // 몬스터볼
const STATUS_BONUS = 1;      // 상태이상 없음
const SHAKES       = 4;

// 포획률(capture_rate 0~255) → { a, b, chance(%) , guaranteed }
function catchParams(captureRate) {
    const rate = Number.isFinite(captureRate) ? captureRate : 45;
    // 체력 만피이므로 (3H - 2H) / 3H = 1/3
    const a = Math.max(1, Math.floor((rate * BALL_BONUS) / 3) * STATUS_BONUS);
    if (a >= 255) return { a, b: 65536, chance: 100, guaranteed: true };
    const b = Math.floor(1048560 / Math.sqrt(Math.sqrt(16711680 / a)));
    const chance = Math.pow(b / 65536, SHAKES) * 100;
    return { a, b, chance: Math.round(chance * 10) / 10, guaranteed: false };
}

// 게임과 동일하게 16비트 난수로 4번 흔들림 판정
function shakeCheck(b) {
    for (let i = 0; i < SHAKES; i++) {
        if (Math.floor(Math.random() * 65536) >= b) return { ok: false, shakes: i };
    }
    return { ok: true, shakes: SHAKES };
}

function catchChance(captureRate) {
    return catchParams(captureRate).chance;
}

// 오늘의 포켓몬 (도감 설명도 날짜별로 하나 고정)
async function getDailyPokemon(userId) {
    const date  = todayKST();
    const dexNo = (hash(`${userId}_${date}`) % MAX_DEX) + 1;
    const info  = await fetchPokemon(dexNo);
    const idx   = info.flavors.length ? hash(`${userId}_${date}_flavor`) % info.flavors.length : 0;
    const cp = catchParams(info.captureRate);
    return { ...info, date, flavor: info.flavors[idx] ?? null, chance: cp.chance, captureRate: info.captureRate };
}

// ── 포획 기록 DB ────────────────────────────────────
// { users: { [userId]: { caught: { [dexNo]: { name, count, firstAt } }, daily: { [date]: 'caught'|'fled'|'released' } } } }
function load() {
    try {
        if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    } catch (e) { console.error('[pokedex] 로드 실패:', e.message); }
    return { users: {} };
}

function save(data) {
    try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('[pokedex] 저장 실패:', e.message); }
}

function getUser(data, userId) {
    return (data.users[userId] ??= { caught: {}, daily: {} });
}

// 오늘 이미 시도했는지 ('caught' | 'fled' | 'released' | null)
function todayResult(userId) {
    return getUser(load(), userId).daily[todayKST()] ?? null;
}

// 포획 시도 — { result: 'caught'|'fled'|'already', chance, shakes }
function tryCatch(userId, info) {
    const data = load();
    const u    = getUser(data, userId);
    const date = todayKST();
    if (u.daily[date]) return { result: 'already', previous: u.daily[date] };

    const cp = catchParams(info.captureRate);
    const { ok, shakes } = cp.guaranteed ? { ok: true, shakes: SHAKES } : shakeCheck(cp.b);

    u.daily[date] = ok ? 'caught' : 'fled';
    if (ok) {
        const rec = (u.caught[info.dexNo] ??= { name: info.name, count: 0, firstAt: date });
        rec.name = info.name;
        rec.count++;
    }
    save(data);
    return { result: ok ? 'caught' : 'fled', chance: cp.chance, shakes };
}

// 놓아주기 (오늘 시도 소진)
function release(userId) {
    const data = load();
    const u    = getUser(data, userId);
    const date = todayKST();
    if (u.daily[date]) return { result: 'already', previous: u.daily[date] };
    u.daily[date] = 'released';
    save(data);
    return { result: 'released' };
}

// 내 도감 — { total, entries: [{ dexNo, name, count, firstAt }] }
function getPokedex(userId) {
    const u = getUser(load(), userId);
    const entries = Object.entries(u.caught)
        .map(([dexNo, v]) => ({ dexNo: Number(dexNo), ...v }))
        .sort((a, b) => a.dexNo - b.dexNo);
    return { total: entries.length, entries };
}

module.exports = {
    getDailyPokemon, getPokedex, tryCatch, release, todayResult,
    catchChance, catchParams, todayKST, MAX_DEX,
};
