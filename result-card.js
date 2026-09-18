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
const { CHAR_EN, DAK_VER } = require('./constants');

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

    const CARD_W  = 500;
    const ROW_H   = 78;
    const HDR_H   = 64;
    const PAD     = 22;
    const ICON_SZ = 34;
    const TITLE_H = 58;

    const COLS = Math.min(teamCount, 2);   // 최대 2열 → 카드 충분히 넓게
    const ROWS = Math.ceil(teamCount / COLS);

    const maxPlayers = Math.max(...Array.from({ length: teamCount }, (_, i) => (teamMap[i + 1] || []).length), 0);
    const CARD_H = HDR_H + ROW_H * (maxPlayers || 1) + 2;

    const W = COLS * CARD_W + (COLS + 1) * PAD;
    const H = TITLE_H + PAD + ROWS * (CARD_H + PAD);

    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    ctx.fillStyle = '#0f0f1a';
    ctx.fillRect(0, 0, W, H);

    ctx.font      = `bold 26px ${F}`;
    ctx.fillStyle = '#e0e0f0';
    ctx.fillText(`팀 배정 결과 · 총 ${totalCount}명`, PAD, TITLE_H - 14);

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
        ctx.font      = `bold 24px ${F}`;
        ctx.fillText(`${t}팀  (${players.length}명)`, cx + 16, cy + HDR_H / 2 + 9);

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

            // 티어 아이콘 먼저 그려서 닉네임 maxW 계산에 반영
            let tierW = 0;
            if (p.tier && TIER_URLS[p.tier]) {
                const tierImg = await cachedImg(`tier_${p.tier}`, TIER_URLS[p.tier]);
                if (tierImg) {
                    const tierH = ROW_H - 10;
                    tierW = Math.round(tierH * tierImg.width / tierImg.height);
                    ctx.drawImage(tierImg, cx + CARD_W - tierW - 10, mid - tierH / 2, tierW, tierH);
                }
            }

            ctx.fillStyle = '#e0e0f0';
            ctx.font      = `20px ${F}`;
            const nickMaxW = CARD_W - (lx - cx) - tierW - 22;
            ctx.fillText(fitText(ctx, p.discord_nickname, nickMaxW), lx, mid + 7);
        }
    }

    return canvas.toBuffer('image/png');
}

// ---------------------------------------------------------------------------
// 토너먼트 대진표 이미지 — 좌/우 절반이 가운데 결승으로 모이는 형태
// tournament: db.startTournament() 구조, teamMap: { [teamNum]: [participant...] }
// ---------------------------------------------------------------------------
async function generateBracketCard(tournament, teamMap) {
    await initPromise;
    const F = fontLoaded ? '"CardFont",sans-serif' : 'sans-serif';

    const rounds = tournament.rounds;
    const R      = rounds.length;
    // 디스코드 임베드는 가로 폭 기준으로 축소되므로 가로를 좁게, 글자를 크게
    const BOX_W = 150, BOX_H = 66, GAP = 46, LEAF_H = 96, PAD = 24, TITLE_H = 72;
    const CH_W  = 170, CH_H = 96;

    // 슬롯 위치: pos[r][m][s] = { x, y, side }  (s: 0=teamA, 1=teamB)
    const leavesPerHalf = rounds[0].length;           // 반쪽 리프 수 = 1라운드 경기 수 (R≥2), R=1이면 1
    const halfLeaves = R === 1 ? 1 : leavesPerHalf;
    const tp = tournament.thirdPlace || null;
    const TP_H = tp ? 150 : 0;   // 3·4위전 영역 높이
    const H = TITLE_H + PAD + halfLeaves * LEAF_H + PAD + TP_H;
    const colW = BOX_W + GAP;
    const W = PAD * 2 + 2 * R * colW + CH_W;
    const midX = W / 2;
    const colX = (r, side) => side === 'L' ? PAD + r * colW : W - PAD - r * colW - BOX_W;

    const pos = rounds.map(ms => ms.map(() => [null, null]));
    for (let r = 0; r < R; r++) {
        const cnt = rounds[r].length;
        for (let m = 0; m < cnt; m++) {
            for (let s = 0; s < 2; s++) {
                let side, y;
                if (r === R - 1) side = s === 0 ? 'L' : 'R';
                else side = m < cnt / 2 ? 'L' : 'R';
                if (r === 0) {
                    const startM = R === 1 ? 0 : (side === 'L' ? 0 : cnt / 2);
                    const leaf = R === 1 ? 0 : (m - startM) * 2 + s;
                    y = TITLE_H + PAD + (leaf + 0.5) * LEAF_H;
                } else {
                    const src = pos[r - 1][2 * m + s];
                    y = (src[0].y + src[1].y) / 2;
                }
                pos[r][m][s] = { x: colX(r, side), y, side };
            }
        }
    }
    const finalA = pos[R - 1][0][0], finalB = pos[R - 1][0][1];
    const champY = (finalA.y + finalB.y) / 2;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f0f1a';
    ctx.fillRect(0, 0, W, H);

    ctx.font = `bold 32px ${F}`;
    ctx.fillStyle = '#e0e0f0';
    ctx.textAlign = 'center';
    ctx.fillText(tournament.status === 'completed' ? `코발트 토너먼트 결과` : '코발트 토너먼트 대진표', W / 2, 48);
    ctx.textAlign = 'left';

    const teamColor = tn => TEAM_COLORS[(tn - 1) % TEAM_COLORS.length];

    // ── 연결선 ──
    ctx.lineWidth = 2;
    for (let r = 1; r < R; r++) {
        for (let m = 0; m < rounds[r].length; m++) {
            for (let s = 0; s < 2; s++) {
                const dst = pos[r][m][s];
                const srcMatch = rounds[r - 1][2 * m + s];
                const srcs = pos[r - 1][2 * m + s];
                const dir = dst.side === 'L' ? 1 : -1;
                const edge = p => p.side === 'L' ? p.x + BOX_W : p.x;
                const jx = edge(srcs[0]) + dir * GAP / 2;
                for (let k = 0; k < 2; k++) {
                    const src = srcs[k];
                    const team = k === 0 ? srcMatch.teamA : srcMatch.teamB;
                    const won = team !== null && srcMatch.winner === team;
                    ctx.strokeStyle = won ? teamColor(team) : '#3a3a55';
                    ctx.lineWidth = won ? 3 : 2;
                    ctx.beginPath();
                    ctx.moveTo(edge(src), src.y);
                    ctx.lineTo(jx, src.y);
                    ctx.lineTo(jx, dst.y);
                    ctx.lineTo(dst.side === 'L' ? dst.x : dst.x + BOX_W, dst.y);
                    ctx.stroke();
                }
            }
        }
    }
    // 결승 슬롯 → 우승 박스
    const final = rounds[R - 1][0];
    for (const [slot, team] of [[finalA, final.teamA], [finalB, final.teamB]]) {
        const won = team !== null && final.winner === team;
        ctx.strokeStyle = won ? teamColor(team) : '#3a3a55';
        ctx.lineWidth = won ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(slot.side === 'L' ? slot.x + BOX_W : slot.x, slot.y);
        ctx.lineTo(slot.side === 'L' ? midX - CH_W / 2 : midX + CH_W / 2, champY);
        ctx.stroke();
    }

    // ── 슬롯 박스 ──
    const drawSlot = (p, team, match, r) => {
        const x = p.x, y = p.y - BOX_H / 2;
        const decided = match.winner !== null;
        const isWinner = team !== null && match.winner === team;
        const isLoser  = decided && team !== null && !isWinner;
        ctx.fillStyle = '#1a1a2e';
        roundedRect(ctx, x, y, BOX_W, BOX_H, 8); ctx.fill();
        ctx.lineWidth = isWinner ? 3 : 1.5;
        ctx.strokeStyle = team === null ? '#2a2a4a' : (isLoser ? '#3a3a55' : teamColor(team));
        roundedRect(ctx, x, y, BOX_W, BOX_H, 8); ctx.stroke();
        ctx.textAlign = 'center';
        if (team === null) {
            ctx.fillStyle = '#55556a';
            ctx.font = `22px ${F}`;
            ctx.fillText(r === 0 ? '부전승' : '미정', x + BOX_W / 2, p.y + 8);
        } else {
            ctx.fillStyle = isLoser ? '#6a6a80' : '#ffffff';
            ctx.font = `bold 30px ${F}`;
            ctx.fillText(`${team}팀`, x + BOX_W / 2, p.y + 11);
        }
        ctx.textAlign = 'left';
    };
    for (let r = 0; r < R; r++)
        for (let m = 0; m < rounds[r].length; m++) {
            drawSlot(pos[r][m][0], rounds[r][m].teamA, rounds[r][m], r);
            drawSlot(pos[r][m][1], rounds[r][m].teamB, rounds[r][m], r);
        }

    // ── 우승 박스 ──
    const champ = tournament.champion;
    const cx = midX - CH_W / 2, cy = champY - CH_H / 2;
    ctx.fillStyle = '#1a1a2e';
    roundedRect(ctx, cx, cy, CH_W, CH_H, 10); ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = champ !== null ? '#f1c40f' : '#3a3a55';
    roundedRect(ctx, cx, cy, CH_W, CH_H, 10); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = champ !== null ? '#f1c40f' : '#55556a';
    ctx.font = `bold 20px ${F}`;
    ctx.fillText('우승', midX, cy + 30);
    ctx.fillStyle = champ !== null ? '#ffffff' : '#55556a';
    ctx.font = `bold 34px ${F}`;
    ctx.fillText(champ !== null ? `${champ}팀` : '미정', midX, cy + 72);
    ctx.textAlign = 'left';

    // ── 3·4위전 (준결승 패자전) ──
    if (tp) {
        const ty = H - TP_H + 10;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#9a9ab5';
        ctx.font = `bold 18px ${F}`;
        ctx.fillText('3·4위전', midX, ty + 14);
        const gap = 30;
        const ax = midX - gap / 2 - BOX_W, bx = midX + gap / 2;
        const by = ty + 28;
        const fakeMatch = { teamA: tp.teamA, teamB: tp.teamB, winner: tp.winner };
        drawSlot({ x: ax, y: by + BOX_H / 2 }, tp.teamA, fakeMatch, 1);
        drawSlot({ x: bx, y: by + BOX_H / 2 }, tp.teamB, fakeMatch, 1);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#6a6a80';
        ctx.font = `bold 16px ${F}`;
        ctx.fillText('vs', midX, by + BOX_H / 2 + 6);
        ctx.fillStyle = tp.winner !== null ? '#cd7f32' : '#55556a';
        ctx.font = `bold 20px ${F}`;
        ctx.fillText(tp.winner !== null ? `3위  ${tp.winner}팀` : '3위  미정', midX, by + BOX_H + 32);
        ctx.textAlign = 'left';
    }

    return canvas.toBuffer('image/png');
}

// ---------------------------------------------------------------------------
// 실험체 배정 카드 — 인게임 캐릭터 선택창처럼 일러스트 + 왼쪽 아래 이름
// groups: [{ label, color, chars: ['재키', ...] }]
// ---------------------------------------------------------------------------
async function generateCharPoolCard(title, groups) {
    await initPromise;
    const F = fontLoaded ? '"CardFont",sans-serif' : 'sans-serif';

    const TILE_W = 138, TILE_H = 186, GAP = 10, PAD = 24, TITLE_H = 64, GROUP_HDR = 44, GROUP_GAP = 26;
    const maxChars = Math.max(...groups.map(g => g.chars.length), 1);
    const COLS = Math.min(maxChars, 6);
    const W = PAD * 2 + COLS * TILE_W + (COLS - 1) * GAP;
    const groupH = g => GROUP_HDR + Math.ceil(g.chars.length / COLS) * (TILE_H + GAP);
    const H = TITLE_H + groups.reduce((h, g) => h + groupH(g) + GROUP_GAP, 0) + PAD - GROUP_GAP;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f0f1a';
    ctx.fillRect(0, 0, W, H);

    ctx.font = `bold 26px ${F}`;
    ctx.fillStyle = '#e0e0f0';
    ctx.fillText(title, PAD, TITLE_H - 22);

    let y = TITLE_H;
    for (const g of groups) {
        // 그룹 헤더 (팀 색상 바 + 라벨)
        ctx.fillStyle = g.color || '#8888aa';
        ctx.fillRect(PAD, y + 8, 6, 24);
        ctx.font = `bold 22px ${F}`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`${g.label}  (${g.chars.length}개)`, PAD + 16, y + 28);
        y += GROUP_HDR;

        for (let i = 0; i < g.chars.length; i++) {
            const name = g.chars[i];
            const tx = PAD + (i % COLS) * (TILE_W + GAP);
            const ty = y + Math.floor(i / COLS) * (TILE_H + GAP);

            // 타일 배경
            ctx.fillStyle = '#1a1a2e';
            roundedRect(ctx, tx, ty, TILE_W, TILE_H, 6); ctx.fill();

            // 일러스트 (CharProfile 138×186 — 타일과 동일 비율)
            const en = CHAR_EN[name];
            const img = en ? await cachedImg(`profile_${en}`, `https://cdn.dak.gg/assets/er/game-assets/${DAK_VER}/CharProfile_${en}_S000.png`) : null;
            ctx.save();
            roundedRect(ctx, tx, ty, TILE_W, TILE_H, 6); ctx.clip();
            if (img) ctx.drawImage(img, tx, ty, TILE_W, TILE_H);
            // 하단 그라데이션 + 이름
            const grad = ctx.createLinearGradient(0, ty + TILE_H - 60, 0, ty + TILE_H);
            grad.addColorStop(0, 'rgba(0,0,0,0)');
            grad.addColorStop(1, 'rgba(0,0,0,0.85)');
            ctx.fillStyle = grad;
            ctx.fillRect(tx, ty + TILE_H - 60, TILE_W, 60);
            ctx.font = `bold 16px ${F}`;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(fitText(ctx, name, TILE_W - 16), tx + 8, ty + TILE_H - 10);
            ctx.restore();

            // 테두리 (팀 색상)
            ctx.strokeStyle = g.color || '#2a2a4a';
            ctx.lineWidth = 2;
            roundedRect(ctx, tx, ty, TILE_W, TILE_H, 6); ctx.stroke();
        }
        y += Math.ceil(g.chars.length / COLS) * (TILE_H + GAP) + GROUP_GAP;
    }

    return canvas.toBuffer('image/png');
}

module.exports = { generateResultCard, generateBracketCard, generateCharPoolCard };
