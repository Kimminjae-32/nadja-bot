const Database = require('better-sqlite3');
const crypto   = require('crypto');

const db = new Database('./nadja.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS events (
        id         TEXT PRIMARY KEY,
        guild_id   TEXT,
        channel_id TEXT,
        created_by TEXT,
        created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS participants (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id         TEXT    NOT NULL,
        discord_nickname TEXT    NOT NULL,
        ingame_nickname  TEXT    NOT NULL,
        position         TEXT    NOT NULL,
        cancel_token     TEXT    UNIQUE NOT NULL,
        submitted_at     INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );
`);

const stmts = {
    createEvent:     db.prepare('INSERT OR IGNORE INTO events (id, guild_id, channel_id, created_by) VALUES (?, ?, ?, ?)'),
    addParticipant:  db.prepare('INSERT INTO participants (event_id, discord_nickname, ingame_nickname, position, cancel_token) VALUES (?, ?, ?, ?, ?)'),
    getParticipants: db.prepare('SELECT * FROM participants WHERE event_id = ? ORDER BY submitted_at ASC'),
    getByToken:      db.prepare('SELECT * FROM participants WHERE cancel_token = ?'),
    updateByToken:   db.prepare('UPDATE participants SET discord_nickname = ?, ingame_nickname = ?, position = ? WHERE cancel_token = ?'),
    deleteByToken:   db.prepare('DELETE FROM participants WHERE cancel_token = ?'),
    eventExists:     db.prepare('SELECT 1 FROM events WHERE id = ?'),
};

module.exports = {
    createEvent: (id, guildId, channelId, createdBy) =>
        stmts.createEvent.run(id, guildId, channelId, createdBy),

    addParticipant: (eventId, discordNick, ingameNick, position) => {
        const token = crypto.randomBytes(8).toString('hex');
        stmts.addParticipant.run(eventId, discordNick, ingameNick, position, token);
        return token;
    },

    getParticipants: (eventId) => stmts.getParticipants.all(eventId),

    getByToken:    (token)                              => stmts.getByToken.get(token),
    updateByToken: (token, discordNick, ingameNick, pos) => stmts.updateByToken.run(discordNick, ingameNick, pos, token),
    deleteByToken: (token)                              => stmts.deleteByToken.run(token),
    eventExists:   (id)                                 => !!stmts.eventExists.get(id),
};
