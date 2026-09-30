// 구인 일정(날짜·시간) 파싱 및 만료 계산 — 항상 한국 시간(UTC+9) 기준
// 서버 로컬 타임존과 무관하게 동작하도록 Date.UTC + 오프셋으로만 계산한다.

const KST_OFFSET_MS   = 9 * 60 * 60 * 1000;
const EXPIRE_AFTER_MS = 3 * 60 * 60 * 1000;   // 게임 시작 + 3시간 후 자동 삭제
const LEGACY_HOURS    = 24;                   // 일정이 없는 구버전 데이터 fallback

const DATE_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const TIME_KO_RE = /^(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분?)?$/;

const DATE_HINT = '날짜는 `YYYY-MM-DD` 형식으로 입력해주세요. (예: `2026-10-02`)';
const TIME_HINT = '시간은 `HH:mm` 형식으로 입력해주세요. (예: `20:00`)';

// 한국 시간 기준 각 구성요소
function kstParts(ms = Date.now()) {
    const d = new Date(ms + KST_OFFSET_MS);
    return {
        year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
        hour: d.getUTCHours(), minute: d.getUTCMinutes(),
    };
}

// 한국 시간 y-m-d h:mm → UTC epoch ms
function kstToEpoch(y, m, d, hh, mm) {
    return Date.UTC(y, m - 1, d, hh, mm, 0, 0) - KST_OFFSET_MS;
}

// 'YYYY-MM-DD' → { y, m, d } | { error }
function parseDate(raw) {
    const s = String(raw ?? '').trim();
    const m = DATE_RE.exec(s);
    if (!m) return { error: `\`${s}\` 은(는) 올바른 날짜가 아니에요.\n${DATE_HINT}` };
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // 실제 존재하는 날짜인지 확인 (2026-13-99, 2026-02-30 등 차단)
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== mo || probe.getUTCDate() !== d)
        return { error: `\`${s}\` 은(는) 존재하지 않는 날짜예요.\n${DATE_HINT}` };
    return { y, m: mo, d };
}

// 'HH:mm' (또는 'H시 m분') → { hh, mm } | { error }
function parseTime(raw) {
    const s = String(raw ?? '').trim();
    const m = TIME_RE.exec(s) || TIME_KO_RE.exec(s);
    if (!m) return { error: `\`${s}\` 은(는) 올바른 시간이 아니에요.\n${TIME_HINT}` };
    const hh = Number(m[1]), mm = Number(m[2] ?? 0);
    if (hh > 23 || mm > 59)
        return { error: `\`${s}\` 은(는) 올바른 시간이 아니에요. (0~23시, 0~59분)\n${TIME_HINT}` };
    return { hh, mm };
}

// 표시용 문자열 (한국 시간 고정)
function formatKST(ms, opts) {
    return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', ...opts }).format(new Date(ms));
}
const formatDateLabel = ms => formatKST(ms, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
// 환경(ICU)에 따라 'PM'으로 나오는 경우가 있어 오전/오후는 직접 조립
function formatTimeLabel(ms) {
    const { hour, minute } = kstParts(ms);
    const ampm = hour < 12 ? '오전' : '오후';
    return `${ampm} ${hour % 12 || 12}:${String(minute).padStart(2, '0')}`;
}

/**
 * 구인 일정 계산.
 * @returns { eventAt, expiresAt, timeLabel } | { error } | null (일정 미입력)
 */
function buildSchedule(dateStr, timeStr, now = Date.now()) {
    const hasDate = !!String(dateStr ?? '').trim();
    const hasTime = !!String(timeStr ?? '').trim();
    if (!hasDate && !hasTime) return null;                     // 일정 없음 → 기존 방식

    if (!hasTime) return { error: `시작 시간을 함께 입력해주세요.\n${TIME_HINT}` };

    const t = parseTime(timeStr);
    if (t.error) return { error: t.error };

    let y, m, d;
    if (hasDate) {
        const dt = parseDate(dateStr);
        if (dt.error) return { error: dt.error };
        ({ y, m, d } = dt);
    } else {
        const p = kstParts(now);                               // 날짜 미입력 → 오늘(한국 시간)
        [y, m, d] = [p.year, p.month, p.day];
    }

    const eventAt = kstToEpoch(y, m, d, t.hh, t.mm);
    if (eventAt <= now) {
        return { error: `⚠️ 이미 지난 날짜와 시간은 선택할 수 없어요.\n입력한 일정: **${formatDateLabel(eventAt)} ${formatTimeLabel(eventAt)}**`
            + (hasDate ? '' : '\n다른 날이라면 `날짜` 옵션도 함께 입력해주세요. (예: `2026-10-02`)') };
    }

    return {
        eventAt,
        expiresAt: eventAt + EXPIRE_AFTER_MS,
        timeLabel: `${formatDateLabel(eventAt)} ${formatTimeLabel(eventAt)}`,
    };
}

// 구인 데이터의 만료 시각 — 신규는 expiresAt, 구버전은 createdAt + durationHours(기본 24h)
function resolveExpiresAt(data) {
    if (!data) return null;
    if (Number.isFinite(data.expiresAt)) return data.expiresAt;
    if (Number.isFinite(data.eventAt))   return data.eventAt + EXPIRE_AFTER_MS;
    if (Number.isFinite(data.createdAt)) return data.createdAt + (data.durationHours || LEGACY_HOURS) * 60 * 60 * 1000;
    return null;   // 판단 불가 → 삭제하지 않음
}

module.exports = {
    buildSchedule, resolveExpiresAt,
    formatDateLabel, formatTimeLabel, kstParts,
    KST_OFFSET_MS, EXPIRE_AFTER_MS, LEGACY_HOURS, DATE_HINT, TIME_HINT,
};
