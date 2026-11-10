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
