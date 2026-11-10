// 디스코드에 보여줄 사람 이름을 정한다.
// 같은 사람도 서버마다 별명이 다를 수 있으므로, 반드시 그 글이 올라간 서버를 기준으로 읽는다.

/** 모집이 올라간 서버를 가져온다. DM이거나 봇이 나간 서버면 null. */
async function fetchGuild(client, guildId) {
    if (!client || !guildId || guildId === 'dm') return null;
    return client.guilds.cache?.get(guildId)
        || await client.guilds.fetch(guildId).catch(() => null);
}

/**
 * 여러 사람의 표시 이름을 그 서버 기준으로 한 번에 가져온다.
 * 서버 별명 → 디스코드 표시 이름 → 사용자 이름 순으로 정해진다.
 * 서버를 나갔거나 조회에 실패하면 계정 정보만으로 이름을 만들고, 그것도 안 되면 멘션으로 둔다.
 *
 * 모집 글은 참가·취소 때마다 다시 그리므로, 인원수만큼 요청을 보내지 않도록
 * 서버 멤버는 한 번의 요청으로 묶어서 받는다.
 *
 * @returns Map<사용자 ID, 표시 이름>
 */
async function fetchDisplayNames(client, guildId, ids) {
    const unique = [...new Set((ids ?? []).filter(Boolean))];
    const names  = new Map();
    if (!unique.length) return names;

    const guild = await fetchGuild(client, guildId);
    if (guild) {
        // 캐시를 쓰지 않고 받아 와야 모집 도중 바꾼 별명이 바로 반영된다
        const members = await guild.members.fetch({ user: unique }).catch(() => null);
        if (members) {
            for (const [id, m] of members) {
                if (m?.displayName) names.set(id, m.displayName);
            }
        }
    }

    // 서버에서 찾지 못한 사람(나갔거나 조회 실패)은 계정 정보로 채운다
    for (const id of unique) {
        if (names.has(id)) continue;
        const user = await client?.users?.fetch(id).catch(() => null);
        // 끝내 못 찾으면 멘션으로 두어 누구인지는 알아볼 수 있게 한다
        names.set(id, user?.globalName || user?.username || `<@${id}>`);
    }
    return names;
}

module.exports = { fetchGuild, fetchDisplayNames };
