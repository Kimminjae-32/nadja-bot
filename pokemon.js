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

const ko = (list, key = 'name') => list?.find(x => x.language?.name === 'ko')?.[key] ?? null;

// ── PokeAPI ─────────────────────────────────────────
async function typeNameKo(enName) {
    if (_typeKo.has(enName)) return _typeKo.get(enName);
    try {
        const d = await (await fetch(`${API}/type/${enName}`)).json();
        const name = ko(d.names) ?? enName;
        _typeKo.set(enName, name);
        return name;
    } catch { return enName; }
}

async function fetchPokemon(dexNo) {
    if (_cache.has(dexNo)) return _cache.get(dexNo);

    const [species, poke] = await Promise.all([
        fetch(`${API}/pokemon-species/${dexNo}`).then(r => r.json()),
        fetch(`${API}/pokemon/${dexNo}`).then(r => r.json()),
    ]);

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

// 포획 확률 (%) — 게임의 capture_rate를 5~90% 로 환산, 전설/환상은 추가 페널티
function catchChance(info) {
    let pct = 5 + (info.captureRate / 255) * 85;
    if (info.isLegendary) pct *= 0.35;
    if (info.isMythical)  pct *= 0.45;
    return Math.max(3, Math.min(90, Math.round(pct)));
}

// 오늘의 포켓몬 (도감 설명도 날짜별로 하나 고정)
async function getDailyPokemon(userId) {
    const date  = todayKST();
    const dexNo = (hash(`${userId}_${date}`) % MAX_DEX) + 1;
    const info  = await fetchPokemon(dexNo);
    const idx   = info.flavors.length ? hash(`${userId}_${date}_flavor`) % info.flavors.length : 0;
    return { ...info, date, flavor: info.flavors[idx] ?? null, chance: catchChance(info) };
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

// 포획 시도 — { result: 'caught'|'fled'|'already', chance, roll }
function tryCatch(userId, info) {
    const data = load();
    const u    = getUser(data, userId);
    const date = todayKST();
    if (u.daily[date]) return { result: 'already', previous: u.daily[date] };

    const chance = catchChance(info);
    const roll   = Math.random() * 100;
    const ok     = roll < chance;

    u.daily[date] = ok ? 'caught' : 'fled';
    if (ok) {
        const rec = (u.caught[info.dexNo] ??= { name: info.name, count: 0, firstAt: date });
        rec.name = info.name;
        rec.count++;
    }
    save(data);
    return { result: ok ? 'caught' : 'fled', chance, roll: Math.round(roll * 10) / 10 };
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
    catchChance, todayKST, MAX_DEX,
};
