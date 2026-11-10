// 「저쪽 신사분이 주신 겁니다」 — 결과 이미지
// 기존 result-card.js의 폰트 로딩·이미지 캐시·둥근 사각형 유틸을 그대로 재사용한다.

const { createCanvas } = require('@napi-rs/canvas');
const { CHAR_EN, DAK_VER } = require('./constants');
const rc = require('./result-card');
const W = require('./character-weapons');

const TEAM_COLORS = ['#3498db', '#e74c3c', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#95a5a6', '#1abc9c'];
const BG = '#0f0f1a', CARD = '#1a1a2e', LINE = '#2a2a4a', TEXT = '#e0e0f0', MUTED = '#8888aa';

const teamColor = n => TEAM_COLORS[(Number(n) - 1) % TEAM_COLORS.length] || '#5865F2';
// 값은 후보 ID("1:15")·표시 이름("단검 재키")·실험체 이름 모두 받는다
// 함수 안에 캔버스 너비 변수 W가 있어 모듈이 가려진다. 별칭으로 안전하게 쓴다.
const describeChar = value => W.describe(value);
const charKey = value => CHAR_EN[describeChar(value)?.characterName];
const charUrl = value => {
    const en = charKey(value);
    return en ? `https://cdn.dak.gg/assets/er/game-assets/${DAK_VER}/CharResult_${en}_S000.png` : null;
};
const weaponIconUrl = key => `https://cdn.dak.gg/assets/er/game-assets/${DAK_VER}/Ico_Ability_${key}.png`;

// 무기군 배지 — 같은 초상화라도 다른 후보임을 한눈에 구분하게 한다
async function drawWeaponBadge(ctx, F, x, y, info, size) {
    if (!info?.weaponName) return;
    const icon = await rc.cachedImg(`weapon_${info.weaponKey}`, weaponIconUrl(info.weaponKey));
    ctx.font = `bold ${size}px ${F}`;
    const pad = Math.round(size * 0.45), iconS = Math.round(size * 1.25);
    const textW = ctx.measureText(info.weaponName).width;
    const bw = pad * 2 + (icon ? iconS + pad * 0.6 : 0) + textW, bh = iconS + pad;
    ctx.fillStyle = 'rgba(10,10,20,0.78)';
    rc.roundedRect(ctx, x, y, bw, bh, bh / 2); ctx.fill();
    let tx = x + pad;
    if (icon) { ctx.drawImage(icon, tx, y + (bh - iconS) / 2, iconS, iconS); tx += iconS + pad * 0.6; }
    ctx.fillStyle = '#ffd479';
    ctx.textBaseline = 'middle';
    ctx.fillText(info.weaponName, tx, y + bh / 2 + 1);
    ctx.textBaseline = 'alphabetic';
}

// 실험체 초상화 타일 하나를 그린다 (이미지가 없어도 자리와 이름은 유지된다)
async function drawCharTile(ctx, F, x, y, w, h, value, { dim = false, label = null, color = LINE } = {}) {
    ctx.fillStyle = CARD;
    rc.roundedRect(ctx, x, y, w, h, 8); ctx.fill();

    const info = value != null ? describeChar(value) : null;
    const name = info?.characterName ?? null;
    const img = name ? await rc.cachedImg(`result_${charKey(value)}`, charUrl(value)) : null;
    ctx.save();
    rc.roundedRect(ctx, x, y, w, h, 8); ctx.clip();
    if (img) {
        ctx.globalAlpha = dim ? 0.35 : 1;
        ctx.drawImage(img, x, y, w, h);
        ctx.globalAlpha = 1;
    }
    const grad = ctx.createLinearGradient(0, y + h - h * 0.45, 0, y + h);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.88)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y + h - h * 0.45, w, h * 0.45);

    ctx.font = `bold ${Math.round(h * 0.13)}px ${F}`;
    ctx.fillStyle = dim ? MUTED : '#ffffff';
    ctx.fillText(rc.fitText(ctx, name || '없음', w - 20), x + 12, y + h - 14);
    if (label) {
        ctx.font = `${Math.round(h * 0.1)}px ${F}`;
        ctx.fillStyle = '#ff9f9f';
        ctx.fillText(rc.fitText(ctx, label, w - 20), x + 12, y + h - 14 - Math.round(h * 0.16));
    }
    ctx.restore();
    await drawWeaponBadge(ctx, F, x + 10, y + 10, info, Math.round(h * 0.085));

    ctx.strokeStyle = color;
    ctx.lineWidth = dim ? 1.5 : 3;
    rc.roundedRect(ctx, x, y, w, h, 8); ctx.stroke();
}

/**
 * 팀별 선물 결과 이미지 — 참가자마다 배정된 실험체, 선물을 보낸 팀, 미배정 실험체를 담는다.
 * @param assignment { from, received, members: [{nickname, character}], leftover }
 */
async function generateGiftCard(teamNum, assignment, teamName) {
    const F = await rc.fontFamily();

    const TILE_W = 300, TILE_H = 238, GAP = 14, PAD = 28;
    const HEAD_H = 150, NAME_H = 46;
    // 미배정 칸도 배정 카드와 같은 비율로 그린다 (조금 작게)
    const LEFT_W = Math.round(TILE_W * 0.72), LEFT_H = Math.round(TILE_H * 0.72);
    const LEFT_HEAD = 56;                       // '미배정 실험체 · 사용 불가' 제목 높이
    const FOOT_H = assignment.leftover.length ? LEFT_HEAD + LEFT_H + NAME_H + PAD : PAD;
    const cols = Math.max(1, Math.min(assignment.members.length, 4));
    const rows = Math.ceil(assignment.members.length / cols);

    const W = PAD * 2 + cols * TILE_W + (cols - 1) * GAP;
    const H = HEAD_H + rows * (TILE_H + NAME_H + GAP) + FOOT_H;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

    // 머리말 — 팀 색 띠와 선물한 팀 안내
    const color = teamColor(teamNum);
    ctx.fillStyle = color; ctx.fillRect(0, 0, W, 8);
    ctx.font = `bold 40px ${F}`;
    ctx.fillStyle = TEXT;
    ctx.fillText(teamName || `${teamNum}팀`, PAD, 68);
    ctx.font = `bold 30px ${F}`;
    ctx.fillStyle = color;
    ctx.fillText(`${assignment.from}팀이 보내온 선물입니다!`, PAD, 112);

    let i = 0;
    for (const m of assignment.members) {
        const cx = PAD + (i % cols) * (TILE_W + GAP);
        const cy = HEAD_H + Math.floor(i / cols) * (TILE_H + NAME_H + GAP);
        await drawCharTile(ctx, F, cx, cy, TILE_W, TILE_H, m.character, { color });

        ctx.font = `bold 26px ${F}`;
        ctx.fillStyle = TEXT;
        ctx.textAlign = 'center';
        ctx.fillText(rc.fitText(ctx, m.nickname, TILE_W - 10), cx + TILE_W / 2, cy + TILE_H + 32);
        ctx.textAlign = 'left';
        i += 1;
    }

    // 미배정 실험체
    if (assignment.leftover.length) {
        const fy = H - FOOT_H + 10;
        ctx.strokeStyle = LINE; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD, fy - 6); ctx.lineTo(W - PAD, fy - 6); ctx.stroke();

        ctx.font = `bold 22px ${F}`;
        ctx.fillStyle = MUTED;
        ctx.fillText('미배정 실험체 · 사용 불가', PAD, fy + 24);

        // 배정 카드와 같은 방식으로 그린다. 이름은 카드 아래에 따로 적는다.
        const ty = fy + LEFT_HEAD - 10;
        for (let k = 0; k < assignment.leftover.length; k++) {
            const name = assignment.leftover[k];
            const cx = PAD + k * (LEFT_W + GAP);
            await drawCharTile(ctx, F, cx, ty, LEFT_W, LEFT_H, name, { dim: true, color: LINE });

            ctx.font = `20px ${F}`;
            ctx.fillStyle = MUTED;
            ctx.textAlign = 'center';
            ctx.fillText(rc.fitText(ctx, describeChar(name)?.displayName ?? String(name), LEFT_W - 10), cx + LEFT_W / 2, ty + LEFT_H + 28);
            ctx.textAlign = 'left';
        }
    }
    return canvas.toBuffer('image/png');
}

/** i번째 칸의 x 좌표 — 각 줄(마지막 줄 포함)을 캔버스 가운데에 맞춘다. */
function centeredX(W, i, count, cols, itemW, gap) {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, count - row * cols);
    const rowW = inRow * itemW + (inRow - 1) * gap;
    return (W - rowW) / 2 + (i % cols) * (itemW + gap);
}

/**
 * 우승팀 축하 이미지 — 팀원 닉네임과 디스코드 프로필 사진을 담는다. 실험체는 넣지 않는다.
 * @param members [{ nickname, avatarUrl }]
 */
async function generateWinnerCard(teamNum, teamName, members) {
    const F = await rc.fontFamily();

    const AV = 180, GAP = 26, PAD = 44, HEAD_H = 190, NAME_H = 48;
    const cols = Math.max(1, Math.min(members.length, 4));
    const rows = Math.ceil(members.length / cols);
    const W = Math.max(760, PAD * 2 + cols * AV + (cols - 1) * GAP);
    const H = HEAD_H + rows * (AV + NAME_H + GAP) + PAD;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // 금빛 그러데이션 배경으로 축하 분위기를 낸다
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#2a2410');
    bg.addColorStop(0.45, BG);
    bg.addColorStop(1, BG);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f1c40f'; ctx.fillRect(0, 0, W, 10);

    ctx.textAlign = 'center';
    ctx.font = `bold 34px ${F}`;
    ctx.fillStyle = '#f1c40f';
    ctx.fillText('저쪽 신사분이 주신 겁니다 · 우승', W / 2, 74);
    ctx.font = `bold 56px ${F}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(teamName || `${teamNum}팀`, W / 2, 140);

    let i = 0;
    for (const m of members) {
        const cx = centeredX(W, i, members.length, cols, AV, GAP);
        const cy = HEAD_H + Math.floor(i / cols) * (AV + NAME_H + GAP);

        const img = m.avatarUrl ? await rc.cachedImg(`avatar_${m.avatarUrl}`, m.avatarUrl) : null;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx + AV / 2, cy + AV / 2, AV / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = CARD; ctx.fillRect(cx, cy, AV, AV);
        if (img) ctx.drawImage(img, cx, cy, AV, AV);
        ctx.restore();

        ctx.beginPath();
        ctx.arc(cx + AV / 2, cy + AV / 2, AV / 2, 0, Math.PI * 2);
        ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 4; ctx.stroke();

        ctx.font = `bold 26px ${F}`;
        ctx.fillStyle = TEXT;
        ctx.fillText(rc.fitText(ctx, m.nickname, AV + GAP), cx + AV / 2, cy + AV + 34);
        i += 1;
    }
    ctx.textAlign = 'left';
    return canvas.toBuffer('image/png');
}

/**
 * 불행상 이미지 — 공동 수상자를 한 장에 담는다. 전체 순위나 투표자 정보는 넣지 않는다.
 * @param winners [{ nickname, character, fromTeam, votes }]
 */
async function generateUnluckyCard(winners) {
    const F = await rc.fontFamily();

    const TILE_W = 300, TILE_H = 238, GAP = 16, PAD = 34, HEAD_H = 170, INFO_H = 86;
    const cols = Math.max(1, Math.min(winners.length, 3));
    const rows = Math.ceil(winners.length / cols);
    const W = Math.max(700, PAD * 2 + cols * TILE_W + (cols - 1) * GAP);
    const H = HEAD_H + rows * (TILE_H + INFO_H + GAP) + PAD;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#2a1020');
    bg.addColorStop(0.45, BG);
    bg.addColorStop(1, BG);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e94560'; ctx.fillRect(0, 0, W, 10);

    ctx.textAlign = 'center';
    ctx.font = `bold 50px ${F}`;
    ctx.fillStyle = '#e94560';
    ctx.fillText('불행상', W / 2, 78);
    ctx.font = `26px ${F}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(winners.length > 1 ? '가장 불운한 선물을 받은 분들입니다' : '가장 불운한 선물을 받은 분입니다', W / 2, 122);
    ctx.textAlign = 'left';

    let i = 0;
    for (const w of winners) {
        const cx = centeredX(W, i, winners.length, cols, TILE_W, GAP);
        const cy = HEAD_H + Math.floor(i / cols) * (TILE_H + INFO_H + GAP);
        await drawCharTile(ctx, F, cx, cy, TILE_W, TILE_H, w.character, { color: '#e94560' });

        ctx.textAlign = 'center';
        ctx.font = `bold 28px ${F}`;
        ctx.fillStyle = TEXT;
        ctx.fillText(rc.fitText(ctx, w.nickname, TILE_W - 10), cx + TILE_W / 2, cy + TILE_H + 34);
        ctx.font = `20px ${F}`;
        ctx.fillStyle = MUTED;
        ctx.fillText(`${w.fromTeam}팀의 선물 · ${w.votes}표`, cx + TILE_W / 2, cy + TILE_H + 64);
        ctx.textAlign = 'left';
        i += 1;
    }
    return canvas.toBuffer('image/png');
}

module.exports = { generateGiftCard, generateWinnerCard, generateUnluckyCard, teamColor };
