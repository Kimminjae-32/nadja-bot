const fs     = require('fs');
const crypto = require('crypto');

const DB_PATH = './nadja-events.json';

function load() {
    try {
        if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    } catch (e) {}
    return { events: {}, participants: {} };
}

function save(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

module.exports = {
    createEvent(id, guildId, channelId, createdBy) {
        const data = load();
        if (!data.events[id]) {
            data.events[id] = { id, guildId, channelId, createdBy, createdAt: Date.now() };
            save(data);
        }
    },

    // discord_id가 있으면 같은 이벤트에 중복 제출 시 업데이트
    addParticipant(eventId, discordId, discordNick, ingameNick, position) {
        const data = load();
        if (discordId) {
            const existing = Object.values(data.participants).find(
                p => p.event_id === eventId && p.discord_id === discordId
            );
            if (existing) {
                Object.assign(existing, { discord_nickname: discordNick, ingame_nickname: ingameNick, position });
                save(data);
                return existing.cancel_token;
            }
        }
        const token = crypto.randomBytes(8).toString('hex');
        data.participants[token] = {
            event_id:         eventId,
            discord_id:       discordId || null,
            discord_nickname: discordNick,
            ingame_nickname:  ingameNick,
            position,
            cancel_token:     token,
            submitted_at:     Date.now()
        };
        save(data);
        return token;
    },

    getParticipants(eventId) {
        const data = load();
        return Object.values(data.participants)
            .filter(p => p.event_id === eventId)
            .sort((a, b) => a.submitted_at - b.submitted_at);
    },

    getByToken(token) {
        return load().participants[token] || null;
    },

    getByDiscordId(eventId, discordId) {
        return Object.values(load().participants).find(
            p => p.event_id === eventId && p.discord_id === discordId
        ) || null;
    },

    updateByToken(token, discordNick, ingameNick, position) {
        const data = load();
        if (data.participants[token]) {
            Object.assign(data.participants[token], {
                discord_nickname: discordNick,
                ingame_nickname:  ingameNick,
                position
            });
            save(data);
        }
    },

    deleteByToken(token) {
        const data = load();
        delete data.participants[token];
        save(data);
    },

    deleteByDiscordId(eventId, discordId) {
        const data = load();
        const token = Object.keys(data.participants).find(
            k => data.participants[k].event_id === eventId && data.participants[k].discord_id === discordId
        );
        if (token) { delete data.participants[token]; save(data); return true; }
        return false;
    },

    eventExists(id) {
        return !!load().events[id];
    }
};
