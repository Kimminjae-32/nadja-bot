// 디스코드 표시 이름이 그 서버의 별명을 따르는지 확인한다
const test = require('node:test');
const assert = require('node:assert');
const { fetchGuild, fetchDisplayNames } = require('../display-names');

/**
 * 가짜 디스코드 클라이언트를 만든다.
 * @param guilds {서버 ID: {멤버ID: 별명 또는 null}}  null이면 별명 없이 가입만 한 사람
 * @param users  {사용자 ID: {globalName, username}}
 */
function makeClient(guilds, users = {}, opts = {}) {
    const calls = { memberFetch: 0, userFetch: 0, guildFetch: 0 };

    const makeGuild = (gid) => ({
        id: gid,
        members: {
            async fetch({ user }) {
                calls.memberFetch++;
                if (opts.memberFetchThrows) throw new Error('조회 실패');
                const table = guilds[gid] ?? {};
                const out = new Map();
                for (const id of user) {
                    if (!(id in table)) continue;              // 서버에 없는 사람(나간 사람)
                    // 디스코드에서 displayName은 별명이 없으면 표시 이름으로 채워진다
                    const nick = table[id];
                    out.set(id, { displayName: nick ?? (users[id]?.globalName || users[id]?.username) });
                }
                return out;
            },
        },
    });

    return {
        calls,
        guilds: {
            cache: { get: (gid) => (opts.noCache ? undefined : (gid in guilds ? makeGuild(gid) : undefined)) },
            async fetch(gid) {
                calls.guildFetch++;
                if (!(gid in guilds)) throw new Error('서버 없음');
                return makeGuild(gid);
            },
        },
        users: {
            async fetch(id) {
                calls.userFetch++;
                if (!(id in users)) throw new Error('사용자 없음');
                return users[id];
            },
        },
    };
}

test('1. 서버 별명이 있으면 별명을 쓴다', async () => {
    const c = makeClient({ G1: { u1: '나쟈짱' } }, { u1: { globalName: '민재', username: 'minjae' } });
    const names = await fetchDisplayNames(c, 'G1', ['u1']);
    assert.strictEqual(names.get('u1'), '나쟈짱');
    assert.strictEqual(c.calls.userFetch, 0, '서버에서 찾았으면 계정을 또 조회하지 않는다');
});

test('2. 서버 별명이 없으면 디스코드 표시 이름을 쓴다', async () => {
    const c = makeClient({ G1: { u1: null } }, { u1: { globalName: '민재', username: 'minjae' } });
    const names = await fetchDisplayNames(c, 'G1', ['u1']);
    assert.strictEqual(names.get('u1'), '민재');
});

test('2-1. 표시 이름도 없으면 사용자 이름을 쓴다', async () => {
    const c = makeClient({ G1: { u1: null } }, { u1: { globalName: null, username: 'minjae' } });
    const names = await fetchDisplayNames(c, 'G1', ['u1']);
    assert.strictEqual(names.get('u1'), 'minjae');
});

test('3. 서버마다 별명이 다르면 그 모집의 서버 별명을 쓴다', async () => {
    const c = makeClient(
        { G1: { u1: '1서버별명' }, G2: { u1: '2서버별명' } },
        { u1: { globalName: '민재', username: 'minjae' } });

    assert.strictEqual((await fetchDisplayNames(c, 'G1', ['u1'])).get('u1'), '1서버별명');
    assert.strictEqual((await fetchDisplayNames(c, 'G2', ['u1'])).get('u1'), '2서버별명');
});

test('4. 모집 도중 별명을 바꾸면 다시 그릴 때 반영된다', async () => {
    const table = { G1: { u1: '예전별명' } };
    const c = makeClient(table, { u1: { username: 'minjae' } });
    assert.strictEqual((await fetchDisplayNames(c, 'G1', ['u1'])).get('u1'), '예전별명');

    table.G1.u1 = '바뀐별명';                       // 사용자가 서버 별명을 바꿨다
    assert.strictEqual((await fetchDisplayNames(c, 'G1', ['u1'])).get('u1'), '바뀐별명',
        '캐시된 옛 이름이 남으면 안 된다');
});

test('5. 서버를 나간 사람은 계정 이름으로 보여준다', async () => {
    const c = makeClient({ G1: { u1: '남은사람' } },
        { u1: { username: 'a' }, u2: { globalName: '나간사람', username: 'gone' } });
    const names = await fetchDisplayNames(c, 'G1', ['u1', 'u2']);
    assert.strictEqual(names.get('u1'), '남은사람');
    assert.strictEqual(names.get('u2'), '나간사람');
});

test('5-1. 계정 조회까지 실패하면 멘션으로 둔다', async () => {
    const c = makeClient({ G1: {} }, {});
    const names = await fetchDisplayNames(c, 'G1', ['u9']);
    assert.strictEqual(names.get('u9'), '<@u9>', '누구인지 알아볼 수 있어야 한다');
});

test('6. 봇이 서버를 못 찾아도 계정 이름으로 채운다', async () => {
    const c = makeClient({}, { u1: { globalName: '민재', username: 'minjae' } });
    const names = await fetchDisplayNames(c, '없는서버', ['u1']);
    assert.strictEqual(names.get('u1'), '민재');
});

test('6-1. 캐시에 없으면 서버를 받아 와서 조회한다', async () => {
    const c = makeClient({ G1: { u1: '별명' } }, {}, { noCache: true });
    const names = await fetchDisplayNames(c, 'G1', ['u1']);
    assert.strictEqual(names.get('u1'), '별명');
    assert.strictEqual(c.calls.guildFetch, 1, '봇 재시작 후처럼 캐시가 비면 받아 와야 한다');
});

test('서버 조회가 실패해도 이름을 비우지 않는다', async () => {
    const c = makeClient({ G1: { u1: '별명' } }, { u1: { username: 'minjae' } }, { memberFetchThrows: true });
    const names = await fetchDisplayNames(c, 'G1', ['u1']);
    assert.strictEqual(names.get('u1'), 'minjae');
});

test('여러 명을 한 번의 요청으로 가져온다', async () => {
    const c = makeClient({ G1: { a: 'A', b: 'B', c: 'C', d: 'D' } });
    const names = await fetchDisplayNames(c, 'G1', ['a', 'b', 'c', 'd']);
    assert.strictEqual(names.size, 4);
    assert.strictEqual(c.calls.memberFetch, 1, '인원수만큼 요청을 보내면 안 된다');
});

test('같은 사람이 여러 번 들어와도 한 번만 조회한다', async () => {
    const c = makeClient({ G1: { a: 'A' } });
    const names = await fetchDisplayNames(c, 'G1', ['a', 'a', 'a']);
    assert.strictEqual(names.size, 1);
    assert.strictEqual(c.calls.memberFetch, 1);
});

test('DM이나 빈 목록은 조회하지 않는다', async () => {
    const c = makeClient({ G1: { a: 'A' } });
    assert.strictEqual((await fetchDisplayNames(c, 'dm', [])).size, 0);
    assert.strictEqual((await fetchDisplayNames(c, 'G1', [])).size, 0);
    assert.strictEqual(c.calls.memberFetch, 0);
    assert.strictEqual(await fetchGuild(c, 'dm'), null, 'DM은 서버가 없다');
    assert.strictEqual(await fetchGuild(null, 'G1'), null, '봇이 없으면 조회하지 않는다');
});

test('빈 값이 섞여 있어도 걸러낸다', async () => {
    const c = makeClient({ G1: { a: 'A' } });
    const names = await fetchDisplayNames(c, 'G1', ['a', null, undefined, '']);
    assert.strictEqual(names.size, 1);
    assert.strictEqual(names.get('a'), 'A');
});
