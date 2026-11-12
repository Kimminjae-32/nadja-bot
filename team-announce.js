// 팀 구성 공지 — 팀 배정 결과(팀원 이름 · 티어)를 모집 채널에 이미지로 알린다
//
// - 팀 미지정 참가자는 공지에 넣지 않는다.
// - 이름은 그 서버의 별명 → 디스코드 표시 이름 → 사용자 이름 → 신청할 때 적은 이름 순으로 정한다.
// - 다시 공지하면 예전에 보낸 공지 메시지를 고쳐서 갱신한다. 고칠 수 없으면(지워짐 등) 관리자에게 묻고 새로 보낸다.
// - 공지한 뒤 팀원이 바뀌었는지는 공지할 때 남긴 서명(signature)과 지금 구성을 비교해서 안다.
// - 실험체 드래프트 · 불행상 투표 공지(event.gentleman)와는 따로 event.teamAnnounce에 기록한다.

const db = require('./db');
const discord = require('./gentleman-discord');
const { fetchDisplayNames } = require('./display-names');

let card = null;
try { card = require('./result-card'); } catch { /* canvas가 없으면 글자 공지로 대신한다 */ }

const UNSET_TIER = '티어 미설정';
const KIND = 'team-announce';

/** 지금 팀 구성: 1팀부터 팀 수만큼, 팀 미지정은 따로 */
function roster(ev, participants) {
    const teamCount = ev?.teamCount || 2;
    const teams = [];
    for (let t = 1; t <= teamCount; t++) {
        teams.push({ teamNum: t, members: participants.filter(p => p.team_num === t) });
    }
    const excluded = participants.filter(p => !p.team_num || p.team_num > teamCount);
    return {
        teamCount,
        teams,
        assignedCount: teams.reduce((s, t) => s + t.members.length, 0),
        excludedCount: excluded.length,
        activeUnassignedCount: excluded.filter(db.isActive).length,   // 실제 진행 인원인데 팀이 없는 사람
        noTierCount: teams.reduce((s, t) => s + t.members.filter(p => !p.tier).length, 0),
    };
}

/** 공지 내용이 바뀌는 변경(팀 이동 · 티어 · 이름)이 있었는지 비교하기 위한 서명 */
function signatureOf(r) {
    return JSON.stringify(r.teams.map(t => [t.teamNum, t.members.map(p => [p.cancel_token, p.tier || '', p.discord_nickname || '', p.discord_id || ''])]));
}

/** 공지할 수 없는 이유 (없으면 null) */
function problemOf(r, participantCount) {
    if (!participantCount) return '참가자가 없어요.';
    if (!r.assignedCount) return '팀 배정을 먼저 해주세요.';
    const empty = r.teams.filter(t => !t.members.length).map(t => `${t.teamNum}팀`);
    if (empty.length) return `${empty.join(', ')}에 아무도 없어요. 팀 구성을 마친 뒤 공지해주세요.`;
    return null;
}

/** 관리자 화면에 보여줄 공지 상태 */
function status(ev, participants) {
    const r = roster(ev, participants);
    const prev = ev?.teamAnnounce ?? null;
    return {
        announced: !!prev?.messageId,
        at: prev?.at ?? null,
        count: prev?.count ?? 0,
        stale: !!prev?.messageId && prev.signature !== signatureOf(r),
        problem: problemOf(r, participants.length),
    };
}

/** 실제 디스코드 대신 Mock 보관함에 기록하는 경우 (테스트 이벤트 · 봇 없음 · 환경 변수) */
const isMock = ev => discord.isMockMode(ev);

/**
 * 표시 이름을 정한다. 서버 별명 → 디스코드 표시 이름 → 사용자 이름 (display-names.js),
 * 디스코드 계정을 모르거나 끝내 찾지 못하면 신청할 때 적은 이름을 쓴다.
 * @returns Map<cancel_token, 이름>
 */
async function resolveNames(client, ev, members) {
    const names = new Map(members.map(p => [p.cancel_token, p.discord_nickname || '이름 없음']));
    if (!client || isMock(ev)) return names;
    const ids = members.map(p => p.discord_id).filter(Boolean);
    if (!ids.length) return names;
    try {
        const byId = await fetchDisplayNames(client, ev.guildId, ids);
        for (const p of members) {
            const n = p.discord_id ? byId.get(p.discord_id) : null;
            // 찾지 못하면 display-names는 멘션(<@id>)을 돌려주는데, 이미지에는 쓸 수 없으므로 적은 이름으로 둔다
            if (n && n !== `<@${p.discord_id}>`) names.set(p.cancel_token, n);
        }
    } catch (e) {
        console.warn('[team-announce] 이름 조회 실패, 신청 이름 사용:', e.message);
    }
    return names;
}

/** 공지에 들어갈 팀 목록 (이름 · 티어만) */
function cardTeams(r, names) {
    return r.teams.map(t => ({
        teamNum: t.teamNum,
        members: t.members.map(p => ({ name: names.get(p.cancel_token), tier: p.tier || null })),
    }));
}

// report를 넘기면 report.missingEmblems에 엠블럼을 받지 못해 글자로 대신한 티어가 들어간다
async function renderCard(teams, total, report) {
    if (!card?.generateTeamRosterCard) return null;
    try {
        return await card.generateTeamRosterCard(teams, { total, report });
    } catch (e) {
        console.error('[team-announce] 이미지 생성 실패, 글자 공지로 대신함:', e.message);
        return null;
    }
}

/** 디스코드 메시지 내용 — 이미지가 있으면 이미지, 없으면 팀별 글자 목록 */
function buildPayload(teams, total, image, edited) {
    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setFooter({ text: `${teams.length}팀 · 총 ${total}명${edited ? ' · 최신 구성으로 갱신됨' : ''}` })
        .setTimestamp();
    if (image) {
        embed.setImage('attachment://teams.png');
        return { embeds: [embed], files: [{ name: 'teams.png', buffer: image }], embedTitle: '팀 구성 결과' };
    }
    embed.setTitle('팀 구성 결과');
    for (const t of teams) {
        embed.addFields({
            name: `${t.teamNum}팀 (${t.members.length}명)`,
            value: t.members.map(m => `**${m.name}** · ${m.tier || UNSET_TIER}`).join('\n').slice(0, 1024),
            inline: true,
        });
    }
    return { embeds: [embed], files: [] };
}

// 같은 이벤트의 공지가 동시에 두 번 나가지 않게 막는다 (빠른 연속 클릭 · 창 두 개)
const busy = new Set();

// 관리자가 미리 본 이미지를 그대로 보낸다 — 다시 그리면 이름 조회 · 엠블럼 다운로드 결과가 달라질 수 있다
// eventId → { signature, image, teams, at }. 구성이 바뀌었거나 오래됐으면 새로 그린다
const previews = new Map();
const PREVIEW_TTL = 10 * 60 * 1000;
function takePreview(eventId, signature) {
    const p = previews.get(eventId);
    if (!p || p.signature !== signature || Date.now() - p.at > PREVIEW_TTL) return null;
    return p;
}

/**
 * 팀 구성 공지 (미리 보기 / 전송 / 갱신)
 * @param opts { dryRun, expectSignature, allowNew, client }
 * @returns { status, body }  — HTTP 응답으로 그대로 쓴다
 */
async function announce(eventId, opts = {}) {
    const ev = db.getEvent(eventId);
    if (!ev) return { status: 404, body: { error: '이벤트를 찾을 수 없어요.' } };
    if (!opts.dryRun && !opts.client && !ev.isTestEvent && process.env.GENTLEMAN_MOCK_DISCORD !== '1')
        return { status: 500, body: { error: '봇 클라이언트가 없습니다.' } };

    const participants = db.getParticipants(eventId);
    const r = roster(ev, participants);
    const problem = problemOf(r, participants.length);
    if (problem) return { status: 400, body: { error: problem } };
    const signature = signatureOf(r);

    // 예전 공지 메시지 (채널이 바뀌었으면 그 메시지는 고칠 수 없다)
    const prev = ev.teamAnnounce?.messageId && ev.teamAnnounce.channelId === ev.channelId ? ev.teamAnnounce : null;

    if (opts.dryRun) {
        const names = await resolveNames(opts.client, ev, r.teams.flatMap(t => t.members));
        const teams = cardTeams(r, names);
        const report = {};
        const image = await renderCard(teams, r.assignedCount, report);
        previews.set(eventId, { signature, image, teams, at: Date.now() });
        return {
            status: 200,
            body: {
                success: true, dryRun: true, signature,
                mode: prev ? 'edit' : 'new',
                unchanged: !!prev && prev.signature === signature,
                mock: isMock(ev),
                teams, total: r.assignedCount,
                excludedCount: r.excludedCount,
                activeUnassignedCount: r.activeUnassignedCount,
                noTierCount: r.noTierCount,
                missingEmblems: image ? (report.missingEmblems ?? []) : [],   // 엠블럼 대신 글자로 나간 티어
                preview: image ? `data:image/png;base64,${image.toString('base64')}` : null,
            },
        };
    }

    if (busy.has(eventId)) return { status: 409, body: { error: '팀 구성 공지를 보내는 중이에요. 잠시만 기다려주세요.', busy: true } };
    busy.add(eventId);
    try {
        if (opts.expectSignature && opts.expectSignature !== signature)
            return { status: 409, body: { error: '미리 보기를 연 뒤 팀 구성이 바뀌었어요. 최신 구성으로 다시 확인해주세요.', changed: true } };

        // 미리 본 구성 그대로면 미리 보기 이미지를 그대로 보낸다
        const shown = opts.expectSignature ? takePreview(eventId, signature) : null;
        let teams, image;
        if (shown) ({ teams, image } = shown);
        else {
            const names = await resolveNames(opts.client, ev, r.teams.flatMap(t => t.members));
            teams = cardTeams(r, names);
            image = await renderCard(teams, r.assignedCount);
        }

        let result = null, replaced = false, editError = null;
        if (prev) {
            result = await discord.edit(ev, prev.messageId, buildPayload(teams, r.assignedCount, image, true), { kind: KIND });
            if (!result.ok) {
                editError = result.error;
                // 기존 공지를 고칠 수 없으면 관리자에게 먼저 알리고, 허락을 받은 뒤에만 새로 보낸다
                if (!opts.allowNew) return { status: 409, body: { error: `기존 공지 메시지를 수정할 수 없어요. (${editError})`, needsNew: true } };
                result = null;
                replaced = true;
            }
        }
        if (!result) {
            result = await discord.send(ev, buildPayload(teams, r.assignedCount, image, false), { kind: KIND });
            if (!result.ok) return { status: 502, body: { error: `디스코드 전송에 실패했어요. (${result.error})` } };
        }

        const info = {
            messageId: result.messageId,
            channelId: ev.channelId,
            signature,
            at: Date.now(),
            count: (ev.teamAnnounce?.count ?? 0) + 1,
            mock: !!result.mock,
        };
        db.setTeamAnnounce(eventId, info);
        previews.delete(eventId);
        return {
            status: 200,
            body: {
                success: true,
                edited: !!result.edited, replaced, editError,
                mock: !!result.mock, image: !!image, samePreview: !!shown,
                total: r.assignedCount, teamCount: r.teams.length,
                announce: status(db.getEvent(eventId), db.getParticipants(eventId)),
            },
        };
    } finally {
        busy.delete(eventId);
    }
}

module.exports = { announce, status, roster, signatureOf, problemOf, resolveNames, UNSET_TIER, KIND };
