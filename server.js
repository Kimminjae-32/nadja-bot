const express = require('express');
const path    = require('path');
const db      = require('./db');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const VALID_POSITIONS = ['탱커', '전사', '암살자', '스킬 딜러', '원거리 딜러', '지원가'];

function errorPage(msg) {
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>오류</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f0f1a;color:#e0e0f0;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}.box{text-align:center;padding:2rem;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px}h2{color:#e94560;margin-bottom:.5rem}</style>
    </head><body><div class="box"><h2>⚠️ 오류</h2><p>${msg}</p></div></body></html>`;
}

// GET /join?event=MSGID[&token=CANCEL_TOKEN]
app.get('/join', (req, res) => {
    const { event } = req.query;
    if (!event || !db.eventExists(event)) {
        return res.status(404).send(errorPage('존재하지 않는 내전입니다.'));
    }
    res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

// POST /join
app.post('/join', (req, res) => {
    const { event, token, discord_id, discord_nickname, ingame_nickname, position } = req.body;

    if (!event || !discord_nickname?.trim() || !ingame_nickname?.trim() || !position) {
        return res.status(400).json({ error: '모든 항목을 입력해주세요.' });
    }
    if (!VALID_POSITIONS.includes(position)) {
        return res.status(400).json({ error: '올바른 포지션을 선택해주세요.' });
    }
    if (!db.eventExists(event)) {
        return res.status(404).json({ error: '존재하지 않는 내전입니다.' });
    }

    if (token) {
        const existing = db.getByToken(token);
        if (!existing || existing.event_id !== event) {
            return res.status(403).json({ error: '유효하지 않은 수정 토큰입니다.' });
        }
        db.updateByToken(token, discord_nickname.trim(), ingame_nickname.trim(), position);
        return res.json({ success: true, cancel_token: token, updated: true });
    }

    const cancel_token = db.addParticipant(event, discord_id || null, discord_nickname.trim(), ingame_nickname.trim(), position);
    res.json({ success: true, cancel_token, updated: false });
});

// GET /api/participant?token=TOKEN
app.get('/api/participant', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: '토큰이 필요합니다.' });
    const p = db.getByToken(token);
    if (!p) return res.status(404).json({ error: '참가 정보를 찾을 수 없습니다.' });
    res.json(p);
});

// GET /cancel?token=TOKEN
app.get('/cancel', (req, res) => {
    const { token } = req.query;
    if (!token || !db.getByToken(token)) {
        return res.status(404).send(errorPage('이미 취소되었거나 존재하지 않는 참가 정보입니다.'));
    }
    res.sendFile(path.join(__dirname, 'public', 'cancel.html'));
});

// POST /cancel
app.post('/cancel', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: '토큰이 없습니다.' });
    const p = db.getByToken(token);
    if (!p) return res.status(404).json({ error: '이미 취소된 참가 정보입니다.' });
    db.deleteByToken(token);
    res.json({ success: true });
});

module.exports = {
    start(port) {
        app.listen(port, () => console.log(`[웹] 포트 ${port} 에서 실행 중`));
    }
};
