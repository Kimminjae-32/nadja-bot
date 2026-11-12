// 「저쪽 신사분이 주신 겁니다」 — 디스코드 전송
//
// 테스트 이벤트이거나 봇 클라이언트가 없으면 실제로 보내지 않고 Mock 보관함에 기록한다.
// 덕분에 토큰 없이 로컬에서도 메시지 내용·버튼·멘션·이미지 생성을 확인할 수 있다.

const MOCK_LIMIT = 200;
const mockOutbox = [];              // 최근 Mock 메시지 (테스트 시뮬레이터에서 조회한다)

let discordClient = null;
const setClient = c => { discordClient = c; };

const isMockMode = (ev) => !discordClient || !!ev?.isTestEvent || process.env.GENTLEMAN_MOCK_DISCORD === '1';

function pushMock(entry) {
    const row = { id: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), ...entry };
    mockOutbox.unshift(row);
    if (mockOutbox.length > MOCK_LIMIT) mockOutbox.length = MOCK_LIMIT;
    return row;
}

const getMockOutbox = (eventId) => eventId ? mockOutbox.filter(m => m.eventId === eventId) : [...mockOutbox];
const clearMockOutbox = (eventId) => {
    for (let i = mockOutbox.length - 1; i >= 0; i--) {
        if (!eventId || mockOutbox[i].eventId === eventId) mockOutbox.splice(i, 1);
    }
};

/**
 * 메시지를 보낸다. Mock 모드에서는 보관함에 기록하고 가짜 메시지 ID를 돌려준다.
 * @param payload { content, embeds, files: [{name, buffer}], components }
 * @returns { ok, messageId } | { ok: false, error }
 */
async function send(ev, payload, meta = {}) {
    if (isMockMode(ev)) {
        const row = pushMock({
            eventId: ev?.id ?? null,
            channelId: ev?.channelId ?? null,
            kind: meta.kind ?? 'message',
            teamNum: meta.teamNum ?? null,
            content: payload.content ?? '',
            embedTitle: payload.embeds?.[0]?.data?.title ?? payload.embedTitle ?? null,
            buttons: (payload.components ?? []).flatMap(r => (r.components ?? []).map(c => c.data?.label ?? c.label)),
            files: (payload.files ?? []).map(f => ({ name: f.name, bytes: f.buffer?.length ?? 0, dataUrl: f.buffer ? `data:image/png;base64,${f.buffer.toString('base64')}` : null })),
            mock: true,
        });
        return { ok: true, messageId: row.id, mock: true };
    }

    try {
        const { AttachmentBuilder } = require('discord.js');
        const channel = await discordClient.channels.fetch(ev.channelId);
        if (!channel) throw new Error('채널을 찾을 수 없습니다.');
        const msg = await channel.send({
            content: payload.content,
            embeds: payload.embeds ?? [],
            components: payload.components ?? [],
            files: (payload.files ?? []).map(f => new AttachmentBuilder(f.buffer, { name: f.name })),
        });
        return { ok: true, messageId: msg.id };
    } catch (e) {
        console.error(`[gentleman-discord] 전송 실패 (${meta.kind ?? 'message'}${meta.teamNum ? ` · ${meta.teamNum}팀` : ''}):`, e.message);
        return { ok: false, error: e.message };
    }
}

/**
 * 이미 보낸 메시지의 내용을 바꾼다. (팀 구성 공지 갱신 등)
 * 첨부 이미지는 새 것으로 교체한다. 메시지가 지워졌거나 수정할 수 없으면 { ok: false }.
 * Mock 모드에서는 보관함에 남은 그 메시지를 고친다. 보관함에서 지워졌으면 지워진 메시지로 본다.
 */
async function edit(ev, messageId, payload, meta = {}) {
    if (!messageId) return { ok: false, error: '수정할 메시지가 없습니다.' };
    if (isMockMode(ev)) {
        const row = mockOutbox.find(m => m.id === messageId);
        if (!row) return { ok: false, error: '메시지를 찾을 수 없습니다.', mock: true };
        Object.assign(row, {
            content: payload.content ?? '',
            embedTitle: payload.embeds?.[0]?.data?.title ?? payload.embedTitle ?? null,
            files: (payload.files ?? []).map(f => ({ name: f.name, bytes: f.buffer?.length ?? 0, dataUrl: f.buffer ? `data:image/png;base64,${f.buffer.toString('base64')}` : null })),
            editedAt: Date.now(),
            edits: (row.edits ?? 0) + 1,
        });
        return { ok: true, messageId, mock: true, edited: true };
    }
    try {
        const { AttachmentBuilder } = require('discord.js');
        const channel = await discordClient.channels.fetch(ev.channelId);
        if (!channel) throw new Error('채널을 찾을 수 없습니다.');
        const msg = await channel.messages.fetch(messageId);
        await msg.edit({
            content: payload.content ?? null,
            embeds: payload.embeds ?? [],
            attachments: [],                              // 예전 이미지를 지우고 새 이미지로 바꾼다
            files: (payload.files ?? []).map(f => new AttachmentBuilder(f.buffer, { name: f.name })),
        });
        return { ok: true, messageId, edited: true };
    } catch (e) {
        console.error(`[gentleman-discord] 메시지 수정 실패 (${meta.kind ?? 'message'}):`, e.message);
        return { ok: false, error: e.message };
    }
}

/** 전송에 한 번 실패하면 짧게 쉬고 한 번 더 시도한다. */
async function sendWithRetry(ev, payload, meta = {}, retryDelayMs = 800) {
    const first = await send(ev, payload, meta);
    if (first.ok) return first;
    await new Promise(r => setTimeout(r, retryDelayMs));
    const second = await send(ev, payload, meta);
    if (second.ok) return { ...second, retried: true };
    return { ok: false, error: second.error, retried: true };
}

/** 이미 보낸 메시지의 버튼을 비활성화한다. (투표 마감 등) */
async function disableButtons(ev, messageId) {
    if (!messageId || isMockMode(ev)) {
        pushMock({ eventId: ev?.id ?? null, kind: 'disable-buttons', targetMessageId: messageId, content: '(버튼 비활성화)', mock: true });
        return { ok: true, mock: true };
    }
    try {
        const channel = await discordClient.channels.fetch(ev.channelId);
        const msg = await channel?.messages.fetch(messageId);
        if (!msg) return { ok: false, error: '메시지를 찾을 수 없습니다.' };
        const rows = msg.components.map(row => {
            const data = row.toJSON();
            data.components = data.components.map(c => ({ ...c, disabled: true }));
            return data;
        });
        await msg.edit({ components: rows });
        return { ok: true };
    } catch (e) {
        console.error('[gentleman-discord] 버튼 비활성화 실패:', e.message);
        return { ok: false, error: e.message };
    }
}

/** 디스코드 프로필 사진 주소 (Mock 모드나 조회 실패 시 null) */
async function avatarUrl(discordId) {
    if (!discordClient || !discordId) return null;
    try {
        const user = await discordClient.users.fetch(discordId);
        return user?.displayAvatarURL({ extension: 'png', size: 256 }) ?? null;
    } catch { return null; }
}

/**
 * 이 이벤트로 보낸 메시지를 한꺼번에 지운다. (모집 종료·자동 만료 시)
 * 지우지 못한 메시지가 있어도 나머지는 계속 지운다.
 */
async function deleteMessages(ev, messageIds) {
    const ids = [...new Set((messageIds ?? []).filter(Boolean))];
    if (!ids.length) return { deleted: 0, failed: 0 };
    if (isMockMode(ev)) {
        pushMock({ eventId: ev?.id ?? null, kind: 'delete-messages', content: `(메시지 ${ids.length}건 삭제)`, mock: true });
        return { deleted: ids.length, failed: 0, mock: true };
    }
    let deleted = 0, failed = 0;
    try {
        const channel = await discordClient.channels.fetch(ev.channelId).catch(() => null);
        if (!channel) return { deleted: 0, failed: ids.length };
        for (const id of ids) {
            try {
                const msg = await channel.messages.fetch(id).catch(() => null);
                if (msg) { await msg.delete(); deleted += 1; }
            } catch (e) {
                failed += 1;
                console.warn(`[gentleman-discord] 메시지 ${id} 삭제 실패: ${e.message}`);
            }
        }
    } catch (e) {
        console.error('[gentleman-discord] 메시지 정리 실패:', e.message);
    }
    return { deleted, failed };
}

module.exports = { setClient, send, edit, sendWithRetry, disableButtons, deleteMessages, avatarUrl, isMockMode, getMockOutbox, clearMockOutbox };
