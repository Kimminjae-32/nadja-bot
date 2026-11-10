// 선택 화면의 깜빡임 원인이 다시 들어오지 않도록 정적 파일 내용을 검사한다.
// (브라우저 없이 확인할 수 있는 조건만 다룬다)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'gentleman.html'), 'utf-8');

// 선택자에 붙은 선언 블록을 꺼낸다
function ruleOf(selector) {
    const i = html.indexOf(selector + '{');
    if (i < 0) return null;
    return html.slice(i + selector.length + 1, html.indexOf('}', i));
}
function keyframesOf(name) {
    const i = html.indexOf('@keyframes ' + name + '{');
    if (i < 0) return null;
    let depth = 0, j = i + ('@keyframes ' + name).length;
    for (; j < html.length; j++) {
        if (html[j] === '{') depth++;
        else if (html[j] === '}' && --depth === 0) break;
    }
    return html.slice(i, j + 1);
}

test('기본 카드에는 등장 애니메이션이 붙어 있지 않다', () => {
    // .char에 animation이 남아 있으면 클래스가 바뀔 때마다 등장 연출이 다시 재생된다
    const base = ruleOf('.char');
    assert.ok(base, '.char 규칙을 찾을 수 없다');
    assert.ok(!/animation\s*:/.test(base), `.char에 animation이 남아 있다: ${base.trim()}`);
});

test('등장 애니메이션은 .enter가 있을 때만 재생된다', () => {
    const enter = ruleOf('.char.enter');
    assert.ok(enter, '.char.enter 규칙이 없다');
    assert.match(enter, /animation:\s*cardIn/);
    assert.match(enter, /animation-delay:var\(--d/, '지연은 CSS 변수로 받아야 한다');
});

test('등장 연출은 오른쪽에서 왼쪽으로 움직인다', () => {
    const kf = keyframesOf('cardIn');
    assert.ok(kf, 'cardIn 키프레임이 없다');
    const m = kf.match(/translateX\((\d+)px\)/);
    assert.ok(m, '시작 위치에 translateX가 없다');
    assert.ok(Number(m[1]) > 0, '시작 위치가 오른쪽(양수)이어야 한다');
    assert.match(kf, /from\{opacity:0|0%\{opacity:0/, '투명한 상태에서 시작해야 한다');
});

test('선택 강조 애니메이션은 투명도를 건드리지 않는다', () => {
    const kf = keyframesOf('bumpPop');
    assert.ok(kf, 'bumpPop 키프레임이 없다');
    assert.ok(!/opacity/.test(kf), `선택 강조가 투명도를 바꾼다: ${kf}`);
    assert.match(kf, /transform:scale/, '크기 변화는 있어야 한다');
});

test('선택 강조는 등장 연출의 지연값을 물려받지 않는다', () => {
    const bump = ruleOf('.char.bump');
    assert.ok(bump, '.char.bump 규칙이 없다');
    assert.match(bump, /animation-delay:\s*0/, '지연을 0으로 고정해야 한다');
    assert.ok(!/popIn/.test(bump), '투명도를 0에서 시작하는 popIn을 쓰면 안 된다');
});

test('등장 연출이 끝나면 .enter를 떼는 코드가 있다', () => {
    assert.match(html, /function settleCards/, 'settleCards 함수가 없다');
    assert.match(html, /classList\.remove\('enter'\)/, '.enter를 떼지 않는다');
    // 격자를 그린 뒤 반드시 호출해야 한다
    assert.match(html, /settleCards\(grid\)/, '격자 렌더링 뒤 호출이 없다');
});

test('초상화는 지연 로딩하지 않는다', () => {
    // loading="lazy"는 스크롤할 때 이미지가 뒤늦게 나타나 깜빡이는 것처럼 보인다
    assert.ok(!/class="portrait"[^>]*loading="lazy"/.test(html), '초상화에 lazy 로딩이 남아 있다');
});

test('카드를 고를 때 서버에 저장하지 않는다', () => {
    const i = html.indexOf('function toggle(');
    assert.ok(i > 0, 'toggle 함수가 없다');
    const body = html.slice(i, html.indexOf('\nfunction ', i + 10));
    assert.ok(!/api\(|fetch\(/.test(body), `toggle에서 서버를 호출한다: ${body}`);
    assert.ok(!/innerHTML/.test(body), 'toggle에서 DOM을 다시 만든다');
});

test('움직임 줄이기 설정을 지원한다', () => {
    assert.match(html, /@media \(prefers-reduced-motion:\s*reduce\)/);
});
