// 사용자에게 보이는 문구에서 '선물' 표현이 사라졌는지 확인한다
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf-8');

// 주석 줄은 뺀다. 내부 주석의 표현까지 바꿀 필요는 없다.
function visibleLines(src) {
    return src.split('\n').filter(line => {
        const t = line.trim();
        return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

const FILES = [
    'public/gentleman.html',
    'public/gentleman-vote.html',
    'public/admin.html',
    'gentleman-card.js',
    'gentleman-routes.js',
    'server.js',
];

for (const f of FILES) {
    test(`${f}에 보이는 '선물' 표현이 없다`, () => {
        const hits = visibleLines(read(f)).filter(l => l.includes('선물'));
        assert.deepStrictEqual(hits, [], `남은 문구:\n${hits.join('\n')}`);
    });
}

test('이벤트 제목은 그대로 유지한다', () => {
    for (const f of ['public/gentleman.html', 'public/gentleman-vote.html']) {
        assert.ok(read(f).includes('저쪽 신사분이 주신 겁니다'), `${f}에서 제목이 사라졌다`);
    }
});

test('내부 데이터 키와 API 이름은 바꾸지 않았다', () => {
    const routes = read('gentleman-routes.js');
    // 기존 기록과의 호환을 위해 그대로 두어야 하는 것들
    assert.match(routes, /kind: 'gift-result'/, '메시지 종류 키가 바뀌었다');
    assert.match(routes, /teamMessages/, '공지 기록 키가 바뀌었다');
    assert.match(routes, /generateGiftCard/, '이미지 생성 함수 이름이 바뀌었다');
    assert.match(routes, /router\.post\('\/admin\/finalize'/, '교환 API 경로가 바뀌었다');
    assert.match(routes, /router\.post\('\/admin\/publish'/, '공지 API 경로가 바뀌었다');
});

test('관리자 화면의 교환 버튼이 하나로 합쳐졌다', () => {
    const admin = read('public/admin.html');
    assert.match(admin, /실험체 교환·배정 및 공지/, '합쳐진 버튼이 없다');
    assert.ok(!/>선물 교환·배정</.test(admin), '예전 교환 버튼이 남아 있다');
    assert.ok(!/>실험체 결과 공지</.test(admin), '예전 공지 버튼이 남아 있다');
    assert.match(admin, /gmRepublish/, '팀 지정 재게시 기능이 사라졌다');
});

test('진행 단계 이름이 바뀐 흐름에 맞다', () => {
    const admin = read('public/admin.html');
    assert.match(admin, /data-step="draft"[\s\S]{0,80}실험체 선택/);
    assert.match(admin, /data-step="assign"[\s\S]{0,80}실험체 교환·배정/);
    assert.match(admin, /data-step="publish"[\s\S]{0,80}결과 자동 공지/);
    assert.match(admin, /data-step="close"[\s\S]{0,80}드래프트 종료/);
});

test('배정 수정의 팀 선택 드롭다운이 실제로 동작하도록 연결돼 있다', () => {
    const admin = read('public/admin.html');
    // 드롭다운에 바꿈 처리가 없으면 1팀에서 넘어갈 수 없다
    assert.match(admin, /id="gm-fix-team"[^>]*onchange="gmFixPickTeam\(/,
        '팀 선택 드롭다운에 change 처리가 없다');
    assert.match(admin, /function gmFixPickTeam/, 'gmFixPickTeam 함수가 없다');

    const i = admin.indexOf('function gmFixPickTeam');
    const body = admin.slice(i, admin.indexOf('\nfunction ', i + 10));
    assert.match(body, /fixTeam\s*=/, '고른 팀을 반영하지 않는다');
    assert.match(body, /fixSel\s*=\s*\[\]/, '이전 팀에서 고른 사람을 놓지 않는다');
    assert.match(body, /fixRenderList\(\)/, '목록을 다시 그리지 않는다');
});

test('새로고침이 관리자가 고른 팀을 되돌리지 않는다', () => {
    const admin = read('public/admin.html');
    const i = admin.indexOf('async function gmFixLoad');
    const body = admin.slice(i, admin.indexOf('\n/** 드롭다운에서', i));
    // 그 팀이 아직 있으면 fixTeam을 건드리지 않아야 한다
    assert.match(body, /if \(!r\.teams\.some\(t => t\.teamNum === fixTeam\)\) fixTeam =/,
        '고른 팀이 남아 있을 때도 덮어쓰고 있다');
});

test('배정 수정은 팀원 교환과 실험체 변경 두 가지만 제공한다', () => {
    const admin = read('public/admin.html');
    assert.match(admin, /id="gm-fix-swap"[^>]*>팀원끼리 교환</);
    assert.match(admin, /id="gm-fix-change"[^>]*>실험체 변경</);
    // 무작위 재추첨은 더 이상 쓰지 않는다
    assert.ok(!/gm-fix-reroll/.test(admin), '예전 재추첨 버튼이 남아 있다');
    assert.ok(!/gmFixReroll/.test(admin), '예전 재추첨 함수가 남아 있다');
    assert.ok(!/assignments\/reroll/.test(admin), '예전 재추첨 API를 아직 부른다');
});

test('서버에도 재추첨 경로가 남아 있지 않다', () => {
    const routes = read('gentleman-routes.js');
    assert.ok(!/assignments\/reroll/.test(routes), '예전 재추첨 경로가 남아 있다');
    assert.match(routes, /router\.get\('\/admin\/assignments\/choices'/, '실험체 목록 조회가 없다');
    assert.match(routes, /router\.post\('\/admin\/assignments\/set'/, '실험체 변경 적용이 없다');
    assert.match(routes, /router\.post\('\/admin\/assignments\/swap'/, '팀원 교환이 사라졌다');
});

test('실험체 고르는 창이 검색과 초상화를 갖춘다', () => {
    const admin = read('public/admin.html');
    assert.match(admin, /id="pick-q"/, '검색 칸이 없다');
    assert.match(admin, /data-find=/, '검색에 쓸 값이 없다');
    assert.match(admin, /charImg\(c\.characterName/, '초상화를 쓰지 않는다');
    assert.match(admin, /class="pick-wp">\$\{esc\(c\.weaponName/, '무기군을 보여주지 않는다');
    // 고를 때 목록을 다시 만들면 이미지가 깜빡인다
    const i = admin.indexOf('function fixChoose');
    const body = admin.slice(i, admin.indexOf('\nfunction ', i + 10));
    assert.ok(!/innerHTML/.test(body), '고를 때 목록을 다시 만든다');
});
