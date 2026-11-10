// 결과 이미지의 미배정 실험체 칸이 눌리지 않고 개수에 맞게 그려지는지 확인한다
const test = require('node:test');
const assert = require('node:assert');
const card = require('../gentleman-card.js');
const W = require('../character-weapons.js');

const pool = W.allCandidates().map(c => (typeof c === 'string' ? c : c.id ?? c.value));
const NICK = ['가나다', '라마바사', '아자차', '카타파하'];

// PNG 머리말에서 가로·세로 크기를 읽는다
const sizeOf = buf => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

async function make(memberCount, leftoverCount) {
    const p = pool.slice(0, memberCount + leftoverCount);
    const buf = await card.generateGiftCard(1, {
        from: 2,
        members: Array.from({ length: memberCount }, (_, i) => ({
            nickname: NICK[i % NICK.length], character: p[i],
        })),
        leftover: p.slice(memberCount, memberCount + leftoverCount),
    }, '1팀 테스트');
    return { buf, ...sizeOf(buf) };
}

test('미배정이 1개여도 2개일 때와 같은 높이로 그려진다', async () => {
    const one = await make(4, 1);
    const two = await make(4, 2);
    assert.strictEqual(one.h, two.h, '한 줄에 들어가면 개수와 상관없이 높이가 같다');
    assert.strictEqual(one.w, two.w);
});

test('미배정이 있으면 캔버스 높이가 그만큼 늘어난다', async () => {
    const none = await make(4, 0);
    const one  = await make(4, 1);
    // 카드 높이 171 + 이름 46 + 제목 56 정도가 더해져야 한다
    assert.ok(one.h - none.h > 200, `늘어난 높이가 ${one.h - none.h}로 너무 작다`);
    assert.ok(one.h - none.h < 320, `늘어난 높이가 ${one.h - none.h}로 너무 크다`);
});

test('미배정 칸은 배정 카드와 같은 가로세로 비율이다', async () => {
    // 배정 카드 300x238, 미배정 칸은 그 72%인 216x171 — 비율 차이가 1% 미만이어야 한다
    const tile = 300 / 238;
    const left = Math.round(300 * 0.72) / Math.round(238 * 0.72);
    assert.ok(Math.abs(tile - left) / tile < 0.01, `비율 차이 ${Math.abs(tile - left)}`);
});

test('팀원이 2명이어도 미배정 칸이 잘리지 않는다', async () => {
    const r = await make(2, 2);
    // 캔버스 너비 안에 미배정 2개(216*2 + 간격 14 + 여백 56)가 들어가야 한다
    assert.ok(r.w >= 216 * 2 + 14 + 56, `너비 ${r.w}가 부족하다`);
    assert.ok(r.buf.length > 10000, '이미지가 비어 있다');
});

test('미배정이 한 줄을 넘으면 줄을 나눠 높이가 늘어난다', async () => {
    const oneRow  = await make(4, 2);
    const twoRows = await make(4, 8);
    assert.ok(twoRows.h > oneRow.h, '줄이 늘어나면 높이도 늘어나야 한다');
    assert.strictEqual(twoRows.w, oneRow.w, '너비는 팀원 수로만 정해진다');
});
