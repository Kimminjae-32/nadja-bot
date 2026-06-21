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

    addParticipant(eventId, discordNick, ingameNick, position) {
        const data  = load();
        const token = crypto.randomBytes(8).toString('hex');
        data.participants[token] = {
            event_id:         eventId,
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

    eventExists(id) {
        return !!load().events[id];
    }
};
