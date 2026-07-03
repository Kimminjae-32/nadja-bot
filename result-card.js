const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs   = require('fs');

const LOCAL_TTF = path.join(__dirname, 'NanumGothic.ttf');
const FONT_DL_URL = 'https://github.com/google/fonts/raw/main/ofl/nanumgothic/NanumGothic-Regular.ttf';

function tryLoad(fp) {
    if (!fs.existsSync(fp)) return false;
    try {
        const buf = fs.readFileSync(fp);
        const ok = GlobalFonts.register(buf, 'CardFont');
        if (ok) return true;
        console.warn('[result-card] register 반환 false:', fp);
    } catch (e) {
        console.warn('[result-card] register 예외:', fp, e.message);
    }
    return false;
}

function loadFontSync() {
    const candidates = [
        path.join(__dirname, 'node_modules/@fontsource/nanum-gothic/files/nanum-gothic-all-400-normal.woff2'),
        path.join(__dirname, 'node_modules/@fontsource/nanum-gothic/files/nanum-gothic-korean-400-normal.woff2'),
        '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
        '/usr/share/fonts/truetype/noto/NotoSansCJKkr-Regular.otf',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        LOCAL_TTF,
    ];
    for (const fp of candidates) {
        if (tryLoad(fp)) {
            console.log('[result-card] 폰트 로드:', fp);
            return true;
        }
    }
    return false;
}

let fontLoaded = false;

async function initialize() {
    GlobalFonts.loadSystemFonts();
    fontLoaded = loadFontSync();

    if (!fontLoaded) {
        try {
            console.log('[result-card] 폰트 없음 — 다운로드 시도:', FONT_DL_URL);
            const res = await fetch(FONT_DL_URL, { signal: AbortSignal.timeout(15000) });
            if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                fs.writeFileSync(LOCAL_TTF, buf);
                fontLoaded = GlobalFonts.register(buf, 'CardFont');
                if (fontLoaded) console.log('[result-card] 폰트 다운로드 성공');
            }
        } catch (e) {
            console.warn('[result-card] 다운로드 실패:', e.message);
        }
    }

    const families = GlobalFonts.families;
    console.log('[result-card] fontLoaded=%s, families=%d개:', fontLoaded, families?.length,
        families?.slice(0, 5));
}

const initPromise = initialize();

// ---------------------------------------------------------------------------

const TIER_URLS = {
    '아이언':       'https://cdn.dak.gg/er/images/tier/full/1.png',
    '브론즈':       'https://cdn.dak.gg/er/images/tier/full/2.png',
    '실버':         'https://cdn.dak.gg/er/images/tier/full/3.png',
    '골드':         'https://cdn.dak.gg/er/images/tier/full/4.png',
    '플래티넘':     'https://cdn.dak.gg/er/images/tier/full/5.png',
    '다이아몬드':   'https://cdn.dak.gg/er/images/tier/full/6.png',
    '메테오라이트': 'https://cdn.dak.gg/er/images/tier/full/63.png',
    '미스릴':       'https://cdn.dak.gg/er/images/tier/full/66.png',
    '데미갓':       'https://cdn.dak.gg/er/images/tier/full/7.png',
    '이터니티':     'https://cdn.dak.gg/er/images/tier/full/8.png',
};

const POS_FILES = {
    '탱커':        'tank',
    '전사':        'warrior',
    '암살자':      'assassin',
    '스킬 딜러':   'skill',
    '원거리 딜러': 'range',
    '지원가':      'support',
};

const TEAM_COLORS = ['#3498db','#e74c3c','#2ecc71','#f1c40f','#9b59b6','#e67e22','#95a5a6','#1abc9c'];

const imgCache = new Map();
async function cachedImg(key, src) {
    if (imgCache.has(key)) return imgCache.get(key);
    try {
        let img;
        if (typeof src === 'string' && src.startsWith('http')) {
            const res = await fetch(src);
            if (!res.ok) return null;
            img = await loadImage(Buffer.from(await res.arrayBuffer()));
        } else {
            img = await loadImage(src);
        }
        imgCache.set(key, img);
        return img;
    } catch { return null; }
}

function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
}

function roundedRect(ctx, x, y, w, h, r, topOnly = false) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    if (topOnly) {
        ctx.lineTo(x + w, y + h);
        ctx.lineTo(x, y + h);
    } else {
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
    }
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

async function generateResultCard(teamMap, teamCount, totalCount) {
    await initPromise;

    const F = fontLoaded ? '"CardFont",sans-serif' : 'sans-serif';

    const CARD_W  = 380;
    const ROW_H   = 60;
    const HDR_H   = 52;
    const PAD     = 18;
    const ICON_SZ = 30;
    const TITLE_H = 50;

    const COLS = Math.min(teamCount, 4);
    const ROWS = Math.ceil(teamCount / COLS);

    const maxPlayers = Math.max(...Array.from({ length: teamCount }, (_, i) => (teamMap[i + 1] || []).length), 0);
    const CARD_H = HDR_H + ROW_H * (maxPlayers || 1) + 2;

    const W = COLS * CARD_W + (COLS + 1) * PAD;
    const H = TITLE_H + PAD + ROWS * (CARD_H + PAD);

    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    ctx.fillStyle = '#0f0f1a';
    ctx.fillRect(0, 0, W, H);

    ctx.font      = `bold 22px ${F}`;
    ctx.fillStyle = '#e0e0f0';
    ctx.fillText(`팟 배정 결과 · 총 ${totalCount}명`, PAD, TITLE_H - 12);

    for (let t = 1; t <= teamCount; t++) {
        const col     = (t - 1) % COLS;
        const row     = Math.floor((t - 1) / COLS);
        const cx      = PAD + col * (CARD_W + PAD);
        const cy      = TITLE_H + PAD + row * (CARD_H + PAD);
        const color   = TEAM_COLORS[(t - 1) % TEAM_COLORS.length];
        const players = teamMap[t] || [];

        ctx.fillStyle = '#1a1a2e';
        roundedRect(ctx, cx, cy, CARD_W, CARD_H, 10);
        ctx.fill();

        ctx.fillStyle = color;
        roundedRect(ctx, cx, cy, CARD_W, HDR_H, 10, true);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font      = `bold 20px ${F}`;
        ctx.fillText(`${t}팀  (${players.length}명)`, cx + 14, cy + HDR_H / 2 + 7);

        for (let i = 0; i < players.length; i++) {
            const p   = players[i];
            const ry  = cy + HDR_H + i * ROW_H;
            const mid = ry + ROW_H / 2;

            if (i % 2 === 1) {
                ctx.fillStyle = 'rgba(255,255,255,0.04)';
                ctx.fillRect(cx, ry, CARD_W, ROW_H);
            }

            let lx = cx + 8;

            if (p.position && POS_FILES[p.position]) {
                const fp = path.join(__dirname, 'public', 'icons', `${POS_FILES[p.position]}.png`);
                const posImg = await cachedImg(`pos_${p.position}`, fp);
                if (posImg) ctx.drawImage(posImg, lx, mid - ICON_SZ / 2, ICON_SZ, ICON_SZ);
                lx += ICON_SZ + 6;
            } else {
                lx += 6;
            }

            ctx.fillStyle = '#e0e0f0';
            ctx.font      = `17px ${F}`;
            const nickMaxW = CARD_W - (lx - cx) - ICON_SZ - 22;
            ctx.fillText(fitText(ctx, p.discord_nickname, nickMaxW), lx, mid + 5);

            if (p.tier && TIER_URLS[p.tier]) {
                const tierImg = await cachedImg(`tier_${p.tier}`, TIER_URLS[p.tier]);
                if (tierImg) ctx.drawImage(tierImg, cx + CARD_W - ICON_SZ - 8, mid - ICON_SZ / 2, ICON_SZ, ICON_SZ);
            }
        }
    }

    return canvas.toBuffer('image/png');
}

module.exports = { generateResultCard };
