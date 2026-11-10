// 「저쪽 신사분이 주신 겁니다」 — 전용 API
//
// 권한 규칙
//  - /api/gentleman/admin/*  : 이벤트 관리자 토큰 필요
//  - /api/gentleman/me/*     : 참가자 본인의 cancel_token 필요 (다른 팀·다른 사람 조작 불가)
//  - /api/gentleman/dev/*    : 개발자 토큰 + 테스트 이벤트 전용 (운영 데이터 접근 불가)
//
// 비공개 보장: 결과를 공지하기 전에는 어떤 응답에도 개인별 배정과 선물 출처를 담지 않는다.

const express = require('express');
const path = require('path');
const db = require('./db');
const D = require('./gentleman-draft');
const V = require('./gentleman-vote');
const discord = require('./gentleman-discord');
const { TEAM_NAMES } = require('./constants');

let card = null;
try { card = require('./gentleman-card'); }
catch (e) { console.warn('[gentleman] 이미지 모듈을 불러오지 못했습니다. 결과 이미지 없이 동작합니다:', e.message); }

const router = express.Router();
const teamName = n => TEAM_NAMES[Number(n) - 1] ?? `${n}팀`;
const WEB_URL = () => process.env.WEB_URL || 'http://localhost:3000';

// ── 인증 보조 ────────────────────────────────────────
function requireAdmin(req, res, next) {
    const event = req.body?.event ?? req.query?.event;
    const token = req.body?.token ?? req.query?.token;
    if (!db.verifyAdmin(event, token)) return res.status(403).json({ error: '관리자 권한이 필요해요.' });
    req.eventId = event;
    req.event = db.getEvent(event);
    next();
}

// 참가자 본인 확인 — 토큰이 해당 이벤트의 참가자여야 한다
function requireParticipant(req, res, next) {
    const event = req.body?.event ?? req.query?.event;
    const token = req.body?.token ?? req.query?.token;
    const p = db.getByToken(token);
    if (!p || p.event_id !== event) return res.status(403).json({ error: '참가 정보를 확인할 수 없어요. 신청 링크로 다시 들어와주세요.' });
    req.eventId = event;
    req.event = db.getEvent(event);
    req.me = p;
    next();
}

const DEV_TOKEN = () => process.env.DEV_TOKEN || 'nadja-dev-2026';
// 개발자 API는 테스트 이벤트에만 허용한다. 운영 이벤트를 건드릴 수 없게 막는 것이 핵심이다.
function requireDevTestEvent(req, res, next) {
    const devToken = req.body?.devToken ?? req.query?.devToken;
    if (devToken !== DEV_TOKEN()) return res.status(403).json({ error: '개발자 권한이 필요해요.' });
    const eventId = req.body?.event ?? req.query?.event;
    if (eventId) {
        const ev = db.getEvent(eventId);
        if (!ev) return res.status(404).json({ error: '이벤트를 찾을 수 없어요.' });
        if (!ev.isTestEvent) return res.status(403).json({ error: '테스트 이벤트에서만 사용할 수 있어요. 운영 데이터는 시뮬레이터로 조작할 수 없습니다.' });
        req.event = ev;
        req.eventId = eventId;
    }
    next();
}

// 공통 응답 도우미
const fail = (res, r, code = 400) => res.status(code).json({ error: r.error });

/**
 * 메시지를 보내고, 보낸 메시지 ID를 이벤트에 바로 기록한다.
 * 같은 안내를 여러 번 보내거나 이벤트를 초기화해도 ID가 덮어써지지 않아 모집 종료 시 모두 지울 수 있다.
 */
async function sendTracked(ev, payload, meta) {
    const sent = await discord.sendWithRetry(ev, payload, meta);
    if (sent.ok && sent.messageId && ev?.id) {
        db.withGentleman(ev.id, (g, e) => {
            e.gentlemanSentMessages = [...new Set([...(e.gentlemanSentMessages ?? []), sent.messageId])];
            return {};
        });
    }
    return sent;
}

// 실험체 초상화 주소를 만들기 위한 이름 매핑 (비밀 정보가 아니라 누구나 받을 수 있다)
router.get('/chars', (req, res) => {
    const { CHAR_EN, DAK_VER } = require('./constants');
    res.json({ charEn: CHAR_EN, dakVer: DAK_VER });
});

// ── 관리자: 상태 조회 ────────────────────────────────
router.get('/admin/state', requireAdmin, (req, res) => {
    const ev = req.event;
    const participants = db.getParticipants(req.eventId);
    const g = ev.gentleman ?? null;

    const summary = g ? D.adminSummary(g, participants) : null;
    const teams = D.teamNumbers(participants);

    res.json({
        exists: !!g,
        round: g?.round ?? 0,
        roundId: g?.roundId ?? null,
        type: g?.type ?? 'normal',
        phase: g?.phase ?? D.PHASE.IDLE,
        teamsLocked: !!g && [D.PHASE.DRAFTING, D.PHASE.ASSIGNED, D.PHASE.PUBLISHED].includes(g.phase),
        summary,
        teamCount: teams.length,
        participantCount: participants.length,
        bannedCount: (ev.bannedCharacters ?? []).length,
        resultsPublished: !!g?.resultsPublished,
        exchangeReady: !!g?.assignments,        // 선물 교환·배정이 끝났는지 (결과 공지 가능 여부)
        allConfirmed: !!summary?.allConfirmed,
        teamMessages: g?.teamMessages ?? {},
        // 상품 회차
        winnerTeam: g?.winnerTeam ?? null,
        winnerPublished: !!g?.winnerPublished,
        vote: g?.vote ? V.adminProgress(g.vote) : { status: 'none' },
        unlucky: g?.unlucky ? { winners: g.unlucky.winners, published: !!g.unlucky.published } : null,
        payouts: g?.payouts ?? {},
        isTestEvent: !!ev.isTestEvent,
        // 결과 공지 뒤에만 배정 내용을 관리자에게 보여준다
        assignments: g?.resultsPublished ? g.assignments : null,
    });
});

// ── 관리자: 회차 준비와 유형 ─────────────────────────
router.post('/admin/setup', requireAdmin, (req, res) => {
    const { type } = req.body;
    if (!['normal', 'prize'].includes(type)) return res.status(400).json({ error: '회차 유형이 올바르지 않아요.' });

    const r = db.withGentleman(req.eventId, (g, ev, participants, setState) => {
        if (!g) { setState({ ...D.createState({ type }) }); return { success: true, created: true }; }

        // 상품 결과가 하나라도 공개됐으면 유형을 바꿀 수 없다
        if (g.winnerPublished || g.unlucky?.published) return { error: '이미 공개된 수상 결과가 있어 유형을 바꿀 수 없어요.' };
        if (g.type === type) return { success: true, unchanged: true };

        g.type = type;
        if (type === 'normal') {        // 상품 관련 상태를 모두 비운다
            g.winnerTeam = null; g.winnerPublished = false; g.winnerMessageId = null;
            g.vote = null; g.unlucky = null; g.payouts = {};
        }
        return { success: true };
    });
    if (r.error) return fail(res, r);
    res.json(r);
});

// ── 관리자: 드래프트 시작 ────────────────────────────
router.post('/admin/start', requireAdmin, async (req, res) => {
    const confirmReset = !!req.body.confirmReset;
    const r = db.withGentleman(req.eventId, (g, ev, participants, setState) => {
        let state = g ?? D.createState();
        if (state.phase === D.PHASE.DRAFTING) return { error: '이미 드래프트가 진행 중이에요.' };

        // 이미 한 바퀴 돌린 회차라면 새 회차를 만들어 처음부터 시작한다.
        // 이전 회차의 선택·배정·공지·투표·수상·지급 기록은 모두 비운다.
        const finished = !!state.assignments
            || state.phase === D.PHASE.ASSIGNED
            || state.phase === D.PHASE.PUBLISHED
            || state.phase === D.PHASE.CLOSED;
        if (finished) {
            if (!confirmReset) {
                return {
                    error: '이전 회차 기록이 남아 있어요. 새 회차로 시작하려면 확인이 필요해요.',
                    needsReset: true,
                    wouldClear: {
                        round: state.round ?? 1,
                        publishedTeams: Object.keys(state.teamMessages ?? {}).length,
                        hasWinner: state.winnerTeam != null,
                        voteStatus: state.vote?.status ?? 'none',
                        unluckyPublished: !!state.unlucky?.published,
                        pendingPayouts: Object.values(state.payouts ?? {}).filter(v => v === 'pending').length,
                    },
                };
            }
            // 이미 올린 디스코드 메시지는 지우지 않되, 나중에 정리할 수 있게 ID만 보관해 둔다
            ev.gentlemanSentMessages = collectMessageIds(ev);
            state = D.createState({ round: (state.round ?? 1) + 1, type: state.type ?? 'normal' });
            setState(state);
        }

        const started = D.startDraft(state, participants, ev.bannedCharacters ?? []);
        if (started.error) return { error: started.error };
        setState(state);
        return { success: true, perTeam: started.perTeam, teamCount: started.teamCount, round: state.round, reset: finished };
    });
    if (r.error) return res.status(400).json(r);     // needsReset 정보를 함께 돌려준다

    // 참가자에게 선택 페이지로 가는 버튼을 보낸다
    const ev = db.getEvent(req.eventId);
    const sent = await sendDraftMessage(ev);
    db.withGentleman(req.eventId, g => { if (g) g.draftMessageId = sent.messageId ?? null; });
    res.json({ ...r, discord: sent });
});

async function sendDraftMessage(ev) {
    const url = `${WEB_URL()}/gentleman?event=${ev.id}`;
    let components = [], embeds = [];
    try {
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        embeds = [new EmbedBuilder()
            .setTitle('저쪽 신사분이 주신 겁니다')
            .setDescription([
                '팀마다 실험체 **4명**을 골라 다른 팀에 선물하는 이벤트입니다.',
                '아래 버튼을 눌러 우리 팀 후보 중에서 선물할 실험체를 골라주세요.',
                '',
                '한 팀에서 한 번에 한 명만 수정할 수 있고, 선택은 자동으로 저장됩니다.',
            ].join('\n'))
            .setColor(0xE94560)
            .setTimestamp()];
        components = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`gmSelect_${ev.id}`).setLabel('실험체 선택').setStyle(ButtonStyle.Primary),
        )];
    } catch {
        embeds = [{ data: { title: '저쪽 신사분이 주신 겁니다' } }];
        components = [{ components: [{ label: '실험체 선택' }] }];
    }
    return sendTracked(ev, { embeds, components, content: null }, { kind: 'draft-start' });
}

// ── 관리자: 진행 제어 ────────────────────────────────
router.post('/admin/force-release', requireAdmin, (req, res) => {
    const teamNum = Number(req.body.teamNum);
    const r = db.withGentleman(req.eventId, g => {
        const team = g?.teams?.[teamNum];
        if (!team) return { error: '팀을 찾을 수 없어요.' };
        D.forceReleaseLock(team);
        return { success: true };
    });
    r.error ? fail(res, r) : res.json(r);
});

router.post('/admin/force-confirm', requireAdmin, (req, res) => {
    const teamNum = Number(req.body.teamNum);
    const r = db.withGentleman(req.eventId, g => {
        const team = g?.teams?.[teamNum];
        if (!team) return { error: '팀을 찾을 수 없어요.' };
        return D.forceConfirmTeam(team);
    });
    r.error ? fail(res, r) : res.json(r);
});

router.post('/admin/unconfirm', requireAdmin, (req, res) => {
    const teamNum = Number(req.body.teamNum);
    const r = db.withGentleman(req.eventId, g => {
        if (g?.assignments) return { error: '이미 배정이 끝나서 확정을 취소할 수 없어요.' };
        const team = g?.teams?.[teamNum];
        if (!team) return { error: '팀을 찾을 수 없어요.' };
        return D.unconfirmTeam(team);
    });
    r.error ? fail(res, r) : res.json(r);
});

router.post('/admin/redraw', requireAdmin, (req, res) => {
    const r = db.withGentleman(req.eventId, (g, ev, participants, setState) => {
        if (!g) return { error: '드래프트가 시작되지 않았어요.' };
        if (g.assignments) return { error: '이미 배정이 끝나 재추첨할 수 없어요.' };
        const confirmed = Object.entries(g.teams).filter(([, t]) => t.confirmed).map(([n]) => n);
        if (confirmed.length) return { error: `확정된 팀이 있어 재추첨할 수 없어요. 먼저 ${confirmed.join(', ')}팀의 확정을 취소해주세요.` };

        const started = D.startDraft(g, participants, ev.bannedCharacters ?? []);
        if (started.error) return { error: started.error };
        setState(g);
        return { success: true, perTeam: started.perTeam };
    });
    r.error ? fail(res, r) : res.json(r);
});

// 전 팀 확정 → 원형 교환과 배정 (결과는 공지 전까지 비공개)
router.post('/admin/finalize', requireAdmin, (req, res) => {
    const r = db.withGentleman(req.eventId, (g, ev, participants) => {
        if (!g) return { error: '드래프트가 시작되지 않았어요.' };
        const fin = D.finalizeAssignments(g, participants);
        return fin.error ? { error: fin.error } : { success: true, already: !!fin.already, order: g.exchange.order };
    });
    r.error ? fail(res, r) : res.json(r);
});

// ── 관리자: 결과 공지 ────────────────────────────────
router.post('/admin/publish', requireAdmin, async (req, res) => {
    const only = req.body.teamNum != null ? Number(req.body.teamNum) : null;   // 특정 팀만 재게시
    const ev = db.getEvent(req.eventId);
    const g = ev?.gentleman;
    if (!g?.assignments) return res.status(400).json({ error: '아직 배정이 끝나지 않았어요.' });

    const participants = db.getParticipants(req.eventId);
    const targets = only != null ? [only] : D.teamNumbers(participants);
    const results = [];

    for (const t of targets) {
        const a = g.assignments[t];
        if (!a) { results.push({ teamNum: t, ok: false, error: '배정 정보가 없어요.' }); continue; }

        // 이미 성공한 팀은 전체 공지에서 건너뛴다 (중복 전송 방지)
        if (only == null && g.teamMessages?.[t]?.ok) { results.push({ teamNum: t, ok: true, skipped: true }); continue; }

        let files = [];
        if (card) {
            try {
                const buf = await card.generateGiftCard(t, a, teamName(t));
                files = [{ name: `gentleman-team${t}.png`, buffer: buf }];
            } catch (e) {
                console.error(`[gentleman] ${t}팀 결과 이미지 생성 실패:`, e.message);
            }
        }
        const content = `**${teamName(t)}** · ${a.from}팀이 보내온 선물입니다!`;   // 멘션은 넣지 않는다
        const sent = await sendTracked(ev, { content, files }, { kind: 'gift-result', teamNum: t });
        results.push({ teamNum: t, ...sent });
    }

    db.withGentleman(req.eventId, gg => {
        if (!gg) return {};
        for (const r of results) {
            if (r.skipped) continue;
            gg.teamMessages[r.teamNum] = { ok: !!r.ok, messageId: r.messageId ?? null, error: r.error ?? null, at: Date.now() };
        }
        if (results.some(r => r.ok)) { gg.resultsPublished = true; gg.phase = D.PHASE.PUBLISHED; }
        return {};
    });

    res.json({ success: true, results, failed: results.filter(r => !r.ok) });
});

// 드래프트 종료 — 이 시점부터 팀 구성을 다시 바꿀 수 있다
router.post('/admin/close-draft', requireAdmin, (req, res) => {
    const r = db.withGentleman(req.eventId, g => {
        if (!g) return { error: '드래프트가 시작되지 않았어요.' };
        g.phase = D.PHASE.CLOSED;
        for (const team of Object.values(g.teams)) { team.lock = null; team.waiting = []; }
        return { success: true };
    });
    r.error ? fail(res, r) : res.json(r);
});

// ── 관리자: 우승팀 ───────────────────────────────────
router.post('/admin/winner', requireAdmin, (req, res) => {
    const teamNum = req.body.teamNum == null ? null : Number(req.body.teamNum);
    const r = db.withGentleman(req.eventId, (g, ev, participants) => {
        if (!g) return { error: '이벤트가 시작되지 않았어요.' };
        if (g.type !== 'prize') return { error: '상품 회차에서만 우승팀을 정할 수 있어요.' };
        if (g.winnerPublished) return { error: '이미 우승팀을 공개해서 바꿀 수 없어요.' };
        if (g.vote && g.vote.status === V.STATUS.OPEN) return { error: '투표가 진행 중이에요. 투표를 취소한 뒤 우승팀을 바꿔주세요.' };
        if (teamNum != null && !D.teamNumbers(participants).includes(teamNum)) return { error: '그런 팀이 없어요.' };
        g.winnerTeam = teamNum;
        return { success: true, winnerTeam: teamNum };
    });
    r.error ? fail(res, r) : res.json(r);
});

// 토너먼트 우승팀 가져오기
router.get('/admin/winner/suggest', requireAdmin, (req, res) => {
    const t = db.getTournament(req.eventId);
    res.json({ champion: t?.champion ?? null, status: t?.status ?? null });
});

router.post('/admin/winner/publish', requireAdmin, async (req, res) => {
    const ev = db.getEvent(req.eventId);
    const g = ev?.gentleman;
    if (g?.type !== 'prize') return res.status(400).json({ error: '상품 회차가 아니에요.' });
    if (g.winnerTeam == null) return res.status(400).json({ error: '우승팀을 먼저 지정해주세요.' });

    const participants = db.getParticipants(req.eventId);
    const members = participants.filter(p => p.team_num === g.winnerTeam);
    const withAvatar = [];
    for (const m of members) {
        withAvatar.push({ nickname: m.discord_nickname, avatarUrl: await discord.avatarUrl(m.discord_id), discordId: m.discord_id });
    }

    let files = [];
    if (card) {
        try {
            const buf = await card.generateWinnerCard(g.winnerTeam, teamName(g.winnerTeam), withAvatar);
            files = [{ name: 'gentleman-winner.png', buffer: buf }];
        } catch (e) { console.error('[gentleman] 우승팀 이미지 생성 실패:', e.message); }
    }
    const mentions = withAvatar.filter(m => m.discordId).map(m => `<@${m.discordId}>`).join(' ');
    const content = `축하합니다! **${teamName(g.winnerTeam)}**이 이번 「저쪽 신사분이 주신 겁니다」의 주인공입니다!\n${mentions}`;
    const sent = await sendTracked(ev, { content, files }, { kind: 'winner' });

    db.withGentleman(req.eventId, gg => {
        if (!gg) return {};
        if (sent.ok) {
            gg.winnerPublished = true;
            gg.winnerMessageId = sent.messageId;
            for (const m of members) gg.payouts[m.cancel_token] ??= 'pending';
        }
        return {};
    });
    sent.ok ? res.json({ success: true, messageId: sent.messageId }) : res.status(500).json({ error: sent.error });
});

// ── 관리자: 투표 ─────────────────────────────────────
router.post('/admin/vote/open', requireAdmin, async (req, res) => {
    const r = db.withGentleman(req.eventId, (g, ev, participants) => {
        if (g?.type !== 'prize') return { error: '상품 회차에서만 투표할 수 있어요.' };
        if (g.vote?.status === V.STATUS.OPEN) return { error: '이미 투표가 진행 중이에요.' };
        if (g.unlucky?.published) return { error: '이미 불행상 결과를 공개했어요.' };
        const opened = V.openVote(participants, g.assignments, g.winnerTeam);
        if (opened.error) return { error: opened.error };
        g.vote = opened.vote;
        g.unlucky = null;
        return { success: true, candidateCount: opened.vote.snapshot.candidates.length, voterCount: opened.vote.snapshot.voters.length };
    });
    if (r.error) return fail(res, r);

    const ev = db.getEvent(req.eventId);
    const sent = await sendVoteMessage(ev, r.voterCount);
    db.withGentleman(req.eventId, g => { if (g?.vote) g.vote.messageId = sent.messageId ?? null; });
    res.json({ ...r, discord: sent });
});

async function sendVoteMessage(ev, voterCount, remind = false, votedCount = 0) {
    let embeds = [], components = [];
    try {
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        embeds = [new EmbedBuilder()
            .setTitle(remind ? '불행상 투표가 진행 중입니다' : '불행상 투표를 시작합니다')
            .setDescription(remind
                ? `아직 투표하지 않으셨다면 참여해주세요.\n현재 ${votedCount} / ${voterCount}명이 투표를 마쳤습니다.`
                : '가장 불운한 실험체를 받은 참가자에게 한 표를 주세요.\n투표는 익명이며, 마감 전까지 언제든 바꿀 수 있습니다.')
            .setColor(0xE94560)
            .setTimestamp()];
        components = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`gmVote_${ev.id}`).setLabel('불행상 투표하기').setStyle(ButtonStyle.Danger),
        )];
    } catch {
        embeds = [{ data: { title: remind ? '불행상 투표가 진행 중입니다' : '불행상 투표를 시작합니다' } }];
        components = [{ components: [{ label: '불행상 투표하기' }] }];
    }
    return sendTracked(ev, { embeds, components }, { kind: remind ? 'vote-remind' : 'vote-open' });
}

router.post('/admin/vote/remind', requireAdmin, async (req, res) => {
    const ev = db.getEvent(req.eventId);
    const g = ev?.gentleman;
    if (g?.vote?.status !== V.STATUS.OPEN) return res.status(400).json({ error: '진행 중인 투표가 없어요.' });
    const p = V.adminProgress(g.vote);
    const sent = await sendVoteMessage(ev, p.totalVoters, true, p.votedCount);
    db.withGentleman(req.eventId, gg => { if (gg?.vote && sent.messageId) gg.vote.remindMessageIds.push(sent.messageId); });
    res.json({ success: !!sent.ok, ...sent });
});

router.post('/admin/vote/close', requireAdmin, async (req, res) => {
    const r = db.withGentleman(req.eventId, g => {
        if (!g?.vote) return { error: '진행 중인 투표가 없어요.' };
        const closed = V.closeVote(g.vote);
        return closed.error ? { error: closed.error } : { success: true, tally: closed.tally };
    });
    if (r.error) return fail(res, r);

    const ev = db.getEvent(req.eventId);
    const ids = [ev.gentleman.vote.messageId, ...(ev.gentleman.vote.remindMessageIds ?? [])].filter(Boolean);
    for (const id of ids) await discord.disableButtons(ev, id);
    res.json(r);
});

router.post('/admin/vote/reopen', requireAdmin, (req, res) => {
    const r = db.withGentleman(req.eventId, g => {
        if (!g?.vote) return { error: '투표가 없어요.' };
        return V.reopenVote(g.vote, !!g.unlucky?.published);
    });
    r.error ? fail(res, r) : res.json(r);
});

router.post('/admin/vote/cancel', requireAdmin, async (req, res) => {
    const notify = !!req.body.notify;
    const r = db.withGentleman(req.eventId, g => {
        if (!g?.vote) return { error: '취소할 투표가 없어요.' };
        if (g.unlucky?.published) return { error: '이미 결과를 공개해서 취소할 수 없어요.' };
        const c = V.cancelVote(g.vote);
        if (c.error) return { error: c.error };
        g.unlucky = null;
        return { success: true };
    });
    if (r.error) return fail(res, r);

    const ev = db.getEvent(req.eventId);
    const ids = [ev.gentleman.vote.messageId, ...(ev.gentleman.vote.remindMessageIds ?? [])].filter(Boolean);
    for (const id of ids) await discord.disableButtons(ev, id);
    if (notify) await sendTracked(ev, { content: '불행상 투표가 취소되었습니다. 다시 열리면 안내드릴게요.' }, { kind: 'vote-cancel' });
    res.json({ success: true, notified: notify });
});

// 불행상 결과 공지
router.post('/admin/unlucky/publish', requireAdmin, async (req, res) => {
    const ev = db.getEvent(req.eventId);
    const g = ev?.gentleman;
    if (!g?.vote || g.vote.status !== V.STATUS.CLOSED) return res.status(400).json({ error: '투표를 먼저 마감해주세요.' });

    const tally = V.tallyVote(g.vote);
    if (!tally.winners.length) {
        db.withGentleman(req.eventId, gg => { if (gg) gg.unlucky = { winners: [], published: true, votes: 0, at: Date.now() }; });
        return res.json({ success: true, noWinner: true, message: '0표로 마감되어 수상자가 없습니다. 결과 메시지는 보내지 않았어요.' });
    }

    const winners = tally.winners.map(w => ({ token: w.token, nickname: w.nickname, character: w.character, displayName: w.displayName ?? null, weaponName: w.weaponName ?? null, fromTeam: w.fromTeam, votes: w.votes }));
    let files = [];
    if (card) {
        try { files = [{ name: 'gentleman-unlucky.png', buffer: await card.generateUnluckyCard(winners) }]; }
        catch (e) { console.error('[gentleman] 불행상 이미지 생성 실패:', e.message); }
    }

    const participants = db.getParticipants(req.eventId);
    const mentions = winners
        .map(w => participants.find(p => p.cancel_token === w.token)?.discord_id)
        .filter(Boolean).map(id => `<@${id}>`).join(' ');
    const title = winners.length > 1 ? '공동 불행상 수상자를 발표합니다!' : '불행상 수상자를 발표합니다!';
    const content = `${title}\n저쪽 신사분의 선물이 조금 가혹했네요. 위로의 박수를 보냅니다.\n${mentions}`;
    const sent = await sendTracked(ev, { content, files }, { kind: 'unlucky' });

    db.withGentleman(req.eventId, gg => {
        if (!gg) return {};
        if (sent.ok) {
            gg.unlucky = { winners, published: true, votes: tally.topVotes, messageId: sent.messageId, at: Date.now() };
            for (const w of winners) gg.payouts[w.token] ??= 'pending';
        }
        return {};
    });
    sent.ok ? res.json({ success: true, winners }) : res.status(500).json({ error: sent.error });
});

// ── 관리자: 상품 지급 상태 ───────────────────────────
router.post('/admin/payout', requireAdmin, (req, res) => {
    const { participantToken, status } = req.body;
    if (!['pending', 'done'].includes(status)) return res.status(400).json({ error: '상태 값이 올바르지 않아요.' });

    const r = db.withGentleman(req.eventId, (g, ev, participants) => {
        if (!g) return { error: '이벤트가 없어요.' };
        const isWinnerMember = g.winnerPublished && participants.some(p => p.cancel_token === participantToken && p.team_num === g.winnerTeam);
        const isUnluckyWinner = g.unlucky?.published && g.unlucky.winners.some(w => w.token === participantToken);
        if (!isWinnerMember && !isUnluckyWinner)
            return { error: '해당 부문의 결과를 디스코드에 공개한 뒤에만 지급 상태를 바꿀 수 있어요.' };
        g.payouts[participantToken] = status;
        return { success: true };
    });
    r.error ? fail(res, r) : res.json(r);
});

// 수상자와 지급 상태 목록
router.get('/admin/payouts', requireAdmin, (req, res) => {
    const g = req.event?.gentleman;
    const participants = db.getParticipants(req.eventId);
    const rows = [];
    if (g?.winnerPublished && g.winnerTeam != null) {
        for (const p of participants.filter(x => x.team_num === g.winnerTeam)) {
            rows.push({ kind: '우승', token: p.cancel_token, nickname: p.discord_nickname, status: g.payouts[p.cancel_token] ?? 'pending' });
        }
    }
    if (g?.unlucky?.published) {
        for (const w of g.unlucky.winners) {
            rows.push({ kind: '불행상', token: w.token, nickname: w.nickname, status: g.payouts[w.token] ?? 'pending' });
        }
    }
    res.json({ rows });
});

// ── 관리자: 다음 회차 ────────────────────────────────
router.post('/admin/next-round', requireAdmin, (req, res) => {
    const { keepTeams = true, keepBans = true, type = 'normal' } = req.body;
    const r = db.withGentleman(req.eventId, (g, ev, participants, setState) => {
        if (!g) return { error: '진행 중인 이벤트가 없어요.' };
        // 드래프트를 아직 종료하지 않았으면 넘어갈 수 없다 (결과를 공지한 뒤에도 종료 버튼을 눌러야 한다)
        if ([D.PHASE.DRAFTING, D.PHASE.ASSIGNED, D.PHASE.PUBLISHED].includes(g.phase))
            return { error: '실험체 드래프트를 먼저 종료해주세요. 관리자 화면의 드래프트 종료 버튼을 눌러주세요.' };
        if (g.vote?.status === V.STATUS.OPEN)
            return { error: '불행상 투표가 진행 중이에요. 마감하거나 취소한 뒤에 넘어가주세요.' };

        // 이전 회차에서 보낸 메시지 ID를 보관해 둔다 (모집 종료 시 함께 지우기 위함)
        ev.gentlemanSentMessages = collectMessageIds(ev);
        const next = D.createState({ round: (g.round ?? 1) + 1, type });
        setState(next);
        if (!keepBans) ev.bannedCharacters = [];
        return { success: true, round: next.round, keepTeams: !!keepTeams };
    });
    if (r.error) return fail(res, r);
    if (!req.body.keepTeams) db.resetTeamAssignments(req.eventId);   // 팀 재배정은 기존 기능으로 다시 하면 된다
    res.json(r);
});

// 이벤트 자체를 초기화 (관리자 수동 정리용)
router.post('/admin/reset', requireAdmin, (req, res) => {
    db.setGentleman(req.eventId, null);
    res.json({ success: true });
});

// ── 참가자 API ───────────────────────────────────────
router.get('/me/state', requireParticipant, (req, res) => {
    const g = req.event?.gentleman;
    if (!g || g.phase === D.PHASE.IDLE) return res.json({ started: false });
    if (!req.me.team_num) return res.json({ started: true, noTeam: true });

    const participants = db.getParticipants(req.eventId);
    const view = db.withGentleman(req.eventId, gg => {
        const team = gg?.teams?.[req.me.team_num];
        if (team) D.reapLock(team);                       // 만료된 권한을 정리한다
        return gg ? D.participantView(gg, req.me, participants) : { error: '상태를 불러올 수 없어요.' };
    });
    if (view.error) return res.json({ started: true, ...view });
    res.json({ started: true, nickname: req.me.discord_nickname, ...view });
});

// 선택 권한 요청 (연결 유지 신호를 겸한다)
router.post('/me/lock', requireParticipant, (req, res) => {
    const r = db.withGentleman(req.eventId, g => {
        const team = g?.teams?.[req.me.team_num];
        if (!team) return { error: '아직 드래프트가 시작되지 않았어요.' };
        const got = D.acquireLock(team, req.me.cancel_token, req.me.discord_nickname);
        return { success: true, role: got.role, holderNickname: got.holder?.token === req.me.cancel_token ? null : (got.holder?.nickname ?? null), rev: team.rev };
    });
    r.error ? fail(res, r) : res.json(r);
});

router.post('/me/unlock', requireParticipant, (req, res) => {
    const r = db.withGentleman(req.eventId, g => {
        const team = g?.teams?.[req.me.team_num];
        if (!team) return { error: '팀을 찾을 수 없어요.' };
        D.releaseLock(team, req.me.cancel_token);
        return { success: true };
    });
    r.error ? fail(res, r) : res.json(r);
});

router.post('/me/picks', requireParticipant, (req, res) => {
    const { picks, rev, roundId } = req.body;
    const r = db.withGentleman(req.eventId, g => {
        if (roundId && g?.roundId && roundId !== g.roundId)
            return { error: '새 회차가 시작됐어요. 화면을 새로고침해주세요.', code: 'stale_round' };
        const team = g?.teams?.[req.me.team_num];
        if (!team) return { error: '팀을 찾을 수 없어요.' };
        return D.savePicks(team, req.me.cancel_token, picks, rev);
    });
    if (r.error) return res.status(409).json(r);          // 충돌은 409로 알려 화면이 최신 상태를 다시 불러오게 한다
    res.json(r);
});

// 확정 — 고르는 동안에는 서버에 보내지 않으므로, 제출할 때 선택 내용을 함께 받아 저장하고 확정한다.
// 관리자가 먼저 강제 확정했다면 savePicks가 거부하므로 늦게 도착한 제출은 반영되지 않는다.
router.post('/me/confirm', requireParticipant, (req, res) => {
    const { picks, rev, roundId } = req.body;
    const r = db.withGentleman(req.eventId, g => {
        if (roundId && g?.roundId && roundId !== g.roundId)
            return { error: '새 회차가 시작됐어요. 화면을 새로고침해주세요.', code: 'stale_round' };
        const team = g?.teams?.[req.me.team_num];
        if (!team) return { error: '팀을 찾을 수 없어요.' };

        if (Array.isArray(picks)) {
            // rev는 넘기지 않는다. 고르는 동안 저장을 하지 않아 화면의 rev가 오래됐을 수 있고,
            // 권한과 확정 여부는 savePicks가 다시 검사한다.
            const saved = D.savePicks(team, req.me.cancel_token, picks, null);
            if (saved.error) return { error: saved.error };
        }
        const done = D.confirmTeam(team, req.me.cancel_token);
        return done.error ? { error: done.error } : { ...done, rev: team.rev };
    });
    r.error ? fail(res, r) : res.json(r);
});

// 투표 화면
router.get('/me/vote', requireParticipant, (req, res) => {
    const g = req.event?.gentleman;
    if (!g?.vote) return res.json({ available: false, error: '진행 중인 투표가 없어요.' });
    const view = V.voterView(g.vote, req.me.cancel_token);
    if (view.error) return res.json({ available: false, error: view.error });
    res.json({ available: true, nickname: req.me.discord_nickname, ...view });
});

router.post('/me/vote', requireParticipant, (req, res) => {
    const { candidate } = req.body;
    const r = db.withGentleman(req.eventId, g => {
        if (!g?.vote) return { error: '진행 중인 투표가 없어요.' };
        return V.castVote(g.vote, req.me.cancel_token, candidate);
    });
    r.error ? fail(res, r) : res.json(r);
});

/**
 * 이 이벤트가 디스코드에 올린 메시지 ID를 모두 모은다.
 * 회차가 바뀌어도 지워지지 않도록 sentMessages에 누적해 둔 것을 함께 본다.
 */
function collectMessageIds(ev) {
    const g = ev?.gentleman;
    const ids = [...(ev?.gentlemanSentMessages ?? [])];
    if (g) {
        ids.push(g.draftMessageId, g.winnerMessageId, g.vote?.messageId, g.unlucky?.messageId);
        ids.push(...(g.vote?.remindMessageIds ?? []));
        for (const m of Object.values(g.teamMessages ?? {})) ids.push(m?.messageId);
    }
    return [...new Set(ids.filter(Boolean))];
}

/** 모집 종료·자동 만료 시 이 이벤트가 보낸 메시지를 전부 지운다. */
async function cleanupMessages(eventId) {
    const ev = db.getEvent(eventId);
    if (!ev) return { deleted: 0, failed: 0 };
    const ids = collectMessageIds(ev);
    if (!ids.length) return { deleted: 0, failed: 0 };
    const r = await discord.deleteMessages(ev, ids);
    console.log(`[gentleman] ${eventId} 메시지 정리 — 삭제 ${r.deleted}건, 실패 ${r.failed}건`);
    return r;
}

// ── 페이지 ───────────────────────────────────────────
const page = f => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
router.get('/page/select', page('gentleman.html'));
router.get('/page/vote', page('gentleman-vote.html'));

module.exports = { router, requireDevTestEvent, sendDraftMessage, teamName, cleanupMessages, collectMessageIds };
