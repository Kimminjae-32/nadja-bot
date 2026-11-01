// 「저쪽 신사분이 주신 겁니다」 — 결과 이미지
// 기존 result-card.js의 폰트 로딩·이미지 캐시·둥근 사각형 유틸을 그대로 재사용한다.

const { createCanvas } = require('@napi-rs/canvas');
const { CHAR_EN, DAK_VER } = require('./constants');
const rc = require('./result-card');

const TEAM_COLORS = ['#3498db', '#e74c3c', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#95a5a6', '#1abc9c'];
const BG = '#0f0f1a', CARD = '#1a1a2e', LINE = '#2a2a4a', TEXT = '#e0e0f0', MUTED = '#8888aa';

const teamColor = n => TEAM_COLORS[(Number(n) - 1) % TEAM_COLORS.length] || '#5865F2';
const charUrl = name => {
    const en = CHAR_EN[name];
    return en ? `https://cdn.dak.gg/assets/er/game-assets/${DAK_VER}/CharResult_${en}_S000.png` : null;
};

// 실험체 초상화 타일 하나를 그린다 (이미지가 없어도 자리와 이름은 유지된다)
async function drawCharTile(ctx, F, x, y, w, h, name, { dim = false, label = null, color = LINE } = {}) {
    ctx.fillStyle = CARD;
    rc.roundedRect(ctx, x, y, w, h, 8); ctx.fill();

    const img = name ? await rc.cachedImg(`result_${CHAR_EN[name]}`, charUrl(name)) : null;
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
    const HEAD_H = 150, NAME_H = 46, FOOT_H = assignment.leftover.length ? 150 : PAD;
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

        const SW = 108, SH = 86;
        // 동기로 그리기 전에 이미지를 미리 받아 캐시에 넣는다
        await Promise.all(assignment.leftover.map(n => rc.cachedImg(`result_${CHAR_EN[n]}`, charUrl(n))));
        assignment.leftover.forEach((name, k) => {
            drawCharTileSync(ctx, F, PAD + k * (SW + 10), fy + 38, SW, SH, name);
        });
    }
    return canvas.toBuffer('image/png');
}

// 미배정 칸은 이미 캐시된 이미지만 쓰므로 동기로 그린다
function drawCharTileSync(ctx, F, x, y, w, h, name) {
    ctx.fillStyle = CARD;
    rc.roundedRect(ctx, x, y, w, h, 6); ctx.fill();
    const img = rc.peekImg(`result_${CHAR_EN[name]}`);
    ctx.save();
    rc.roundedRect(ctx, x, y, w, h, 6); ctx.clip();
    if (img) { ctx.globalAlpha = 0.3; ctx.drawImage(img, x, y, w, h); ctx.globalAlpha = 1; }
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x, y + h - 26, w, 26);
    ctx.font = `16px ${F}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(rc.fitText(ctx, name, w - 12), x + 6, y + h - 8);
    ctx.restore();
    ctx.strokeStyle = LINE; ctx.lineWidth = 1.5;
    rc.roundedRect(ctx, x, y, w, h, 6); ctx.stroke();
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
        const cx = PAD + (i % cols) * (AV + GAP);
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
        const cx = PAD + (i % cols) * (TILE_W + GAP);
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
