const {
    Client, GatewayIntentBits, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    Events
} = require('discord.js');
const fs   = require('fs');
const cron = require('node-cron');
require('dotenv').config();

const db        = require('./db');
const webServer = require('./server');
const { TEAM_EMOJIS, TEAM_NAMES, CHARACTERS, CHAR_CODE } = require('./constants');
const poke = require('./pokemon');
const schedule = require('./schedule');
webServer.start(Number(process.env.WEB_PORT) || 3000);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers
    ]
});
webServer.setClient(client);
webServer.setCloseCallback(async (msgId) => {
    const data = allRecruits.get(msgId);
    if (!data) return;
    try {
        await deleteMessage(msgId, data.channelId);
    } catch (e) { /* 무시 */ }
    await webServer.deleteEventRole(msgId).catch(() => null);
    db.archiveEvent(msgId, 'closed');
    allRecruits.delete(msgId);
    activeUserRecruits.delete(`${data.guildId ?? 'dm'}_${data.creatorId}`);
    saveData();
});

const DATA_PATH = './recruits.json';

// channelId를 알면 직접 접근, 모르면 전체 스캔 (하위 호환)
async function deleteMessage(msgId, channelId) {
    if (channelId) {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch) { const m = await ch.messages.fetch(msgId).catch(() => null); if (m) await m.delete().catch(() => null); return; }
    }
    for (const [, guild] of client.guilds.cache) {
        for (const [, ch] of guild.channels.cache.filter(c => c.isTextBased())) {
            const m = await ch.messages.fetch(msgId).catch(() => null);
            if (m) { await m.delete().catch(() => null); return; }
        }
    }
}

let allRecruits        = new Map();
let activeUserRecruits = new Map();
let pendingLumia       = new Map();

function loadData() {
    try {
        if (fs.existsSync(DATA_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
            allRecruits        = new Map(Object.entries(parsed.allRecruits        || {}));
            activeUserRecruits = new Map(Object.entries(parsed.activeUserRecruits || {}));
            for (const [, data] of allRecruits) {
                if (!data.teamCount) data.teamCount = 2;
                if (!data.teams) data.teams = [data.team1 || [], data.team2 || []];
                if (!data.createdAt) data.createdAt = Date.now();
            }
        }
    } catch (e) { console.error('데이터 로드 실패:', e); }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_PATH, JSON.stringify({
            allRecruits:        Object.fromEntries(allRecruits),
            activeUserRecruits: Object.fromEntries(activeUserRecruits)
        }, null, 2));
    } catch (e) { console.error('데이터 저장 실패:', e); }
}


loadData();
webServer.setRecruitMap(allRecruits);
webServer.setActiveUserMap(activeUserRecruits);
webServer.setSaveDataFn(saveData);
webServer.setCreateEmbedFn(createRecruitEmbed);


function getCharName(code) {
    return CHAR_CODE[code] || `실험체(${code})`;
}

// =====================================================
// 오늘의 포켓몬
// =====================================================
function pokeColor(p) {
    return p.isMythical ? 0xE91E63 : p.isLegendary ? 0xF1C40F : 0x5865F2;
}

// state: null(대기) | 'caught' | 'fled' | 'released'
// 결과 문구는 임베드 위 본문에 표시 (포획 확률 포함)
// 포획 확률 표기 — 게임 공식대로라 소수점이 나올 수 있어 정수면 정수로만 표시
function pokeChanceText(p) {
    return Number.isInteger(p.chance) ? `${p.chance}%` : `${p.chance.toFixed(1)}%`;
}

function pokeContent(p, state) {
    const lines = {
        caught:   `🎉 앗! ${p.name}(을)를 포획했다!`,
        fled:     `❌ 앗! ${p.name}(이)가 도망가버렸다...`,
        released: `👋 ${p.name}(을)를 놓아주었다.`,
    };
    if (!state) return `🎁 야생의 **${p.name}**(이)가 나타났다! (포획 확률: **${pokeChanceText(p)}**)`;
    return state === 'released' ? lines[state] : `${lines[state]} (포획 확률: **${pokeChanceText(p)}**)`;
}

function buildPokeEmbed(displayName, p, state) {
    const rarity = p.isMythical ? ' ☁️ **환상의 포켓몬!**' : p.isLegendary ? ' 👑 **전설의 포켓몬!**' : '';
    const lines = [
        `짜잔! 오늘의 포켓몬은 전국도감 **${p.dexNo}**번의 **${p.name}** 입니다!${rarity}`,
        '',
        '**속성(타입)**',
        `이 포켓몬은 [${p.types.join(', ')}] 타입이고,`,
    ];
    if (p.flavor) lines.push('', '**도감 설명**', `*"${p.flavor}"*`, '', '...라는 특징을 가지고 있어요! ✨');

    const footers = {
        caught:   `🎒 포획 성공! (포획 확률: ${pokeChanceText(p)} · 포획률 ${p.captureRate})`,
        fled:     `🎒 포획 실패... (포획 확률: ${pokeChanceText(p)} · 포획률 ${p.captureRate})`,
        released: '👋 오늘은 그냥 보내줬어요',
    };

    const embed = new EmbedBuilder()
        .setTitle(`✨ ${displayName}의 오늘의 포켓몬!`)
        .setDescription(lines.join('\n'))
        .setColor(state === 'fled' ? 0x95A5A6 : pokeColor(p))
        .setFooter({ text: state ? footers[state] : 'Pokédex data provided by PokéAPI' })
        .setTimestamp();
    if (p.image) embed.setImage(p.image);
    return embed;
}

function pokeButtons(userId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pokeCatch_${userId}`).setLabel('포획하기').setEmoji('🎁').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`pokeRelease_${userId}`).setLabel('놓아주기').setEmoji('👋').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    );
}

function pokeDisplayName(interaction) {
    return interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
}

// =====================================================
// 임베드 생성 (async - 닉네임 직접 조회)
// =====================================================
// 일정 필드 — eventAt이 있으면 날짜/시간을 나눠서, 없으면 기존 '시작 시간' 한 줄
function scheduleFields(data) {
    if (!Number.isFinite(data.eventAt)) {
        return [{ name: '⏰ 시작 시간', value: data.time || '즉시', inline: true }];
    }
    const unix = Math.floor(data.eventAt / 1000);
    return [
        { name: '📅 진행 날짜', value: `${schedule.formatDateLabel(data.eventAt)}\n<t:${unix}:R>`, inline: true },
        { name: '⏰ 시작 시간', value: schedule.formatTimeLabel(data.eventAt), inline: true },
    ];
}

async function createRecruitEmbed(data) {
    const colors = { '일반': 0x00FF00, '랭크': 0x5865F2, '내전': 0xFF0000, '론울프': 0xFF8C00 };
    const teamCount = data.teamCount || 2;
    const teams     = data.teams || Array.from({ length: teamCount }, () => []);

    const nameCache = new Map();
    const getName = async (id) => {
        if (nameCache.has(id)) return nameCache.get(id);
        const u = await client.users.fetch(id).catch(() => null);
        // 표시 이름(별명·본명)이 아니라 디스코드 아이디(핸들)로 표기
        const name = u ? (u.username || u.globalName || id) : id;
        nameCache.set(id, name);
        return name;
    };

    const participantNames = await Promise.all(data.participants.map(getName));
    const participantsList = participantNames.join(', ') || '없음';
    const creatorName = await getName(data.creatorId);

    const title = data.mapType
        ? `🎮 [${data.gameType} / ${data.mapType}] 구인 중`
        : `🎮 [${data.gameType}] 구인 중`;
    const embed = new EmbedBuilder()
        .setTitle(title)
        .addFields(...scheduleFields(data),
            { name: '👥 인원',      value: `${data.participants.length} / ${data.maxPlayers}`, inline: true },
            { name: '👑 모집자',    value: creatorName,                                        inline: true },
            { name: '📝 전체 참가자', value: participantsList }
        )
        .setColor(colors[data.gameType] || 0x5865F2)
        .setTimestamp();
    if (data.description) embed.setDescription(`📝 ${data.description}`);

    // 내전만 팀 필드 표시 (론울프는 팀 개념 없음)
    if (data.gameType === '내전') {
        const hasAssignment = teams.some(t => t && t.length > 0);
        if (hasAssignment) {
            for (let i = 0; i < teamCount; i++) {
                const team = teams[i] || [];
                if (team.length === 0) continue;
                const names = await Promise.all(team.map(getName));
                embed.addFields({ name: `${TEAM_EMOJIS[i]} ${TEAM_NAMES[i]}`, value: names.join('\n'), inline: true });
            }
        }
    }

    return embed;
}

// =====================================================
// 구인 생성 공통 함수
// =====================================================
async function createRecruit(interaction, { gameType, mapType, maxPlayers, teamCount, timeStr, duration, description, isGeneric, eventAt, expiresAt }) {
    const user    = interaction.user;
    const guildId = interaction.guildId ?? 'dm';
    const rKey    = `${guildId}_${user.id}`;  // 서버별 유일 키

    if (activeUserRecruits.has(rKey)) {
        const oldMsgId = activeUserRecruits.get(rKey);
        const oldData  = allRecruits.get(oldMsgId);
        await deleteMessage(oldMsgId, oldData?.channelId).catch(() => null);
        await webServer.deleteEventRole(oldMsgId).catch(() => null);
        db.archiveEvent(oldMsgId, 'replaced');
        allRecruits.delete(oldMsgId);
    }

    const newRecruit = {
        creatorId: user.id,
        guildId,
        channelId: interaction.channelId,
        participants: [],
        gameType, mapType,
        description: description || null,
        isGeneric: !!isGeneric,
        time: timeStr,
        // 신규 구인은 실제 일정 기준 — eventAt(게임 시작) / expiresAt(시작 + 3시간)
        // 일정 미입력 시에만 기존 방식(createdAt + 24시간)으로 만료 시각을 계산해 둔다
        eventAt:   Number.isFinite(eventAt) ? eventAt : null,
        expiresAt: Number.isFinite(expiresAt)
            ? expiresAt
            : Date.now() + (duration || schedule.LEGACY_HOURS) * 60 * 60 * 1000,
        durationHours: duration,
        maxPlayers, teamCount,
        teams: Array.from({ length: teamCount }, () => []),
        team1: [], team2: [],
        originalVoiceChannelId: null,
        createdAt: Date.now()
    };

    const sendFn = interaction.replied || interaction.deferred
        ? (opts) => interaction.followUp({ ...opts, fetchReply: true })
        : (opts) => interaction.reply({ ...opts, withResponse: true }).then(r => r.resource?.message ?? r);

    let msg;
    try {
        msg = await sendFn({
            embeds: [await createRecruitEmbed(newRecruit)],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('join_temp').setLabel('참가').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('leave_temp').setLabel('취소').setStyle(ButtonStyle.Danger)
            )]
        });
    } catch (e) {
        console.error('구인 메시지 전송 실패:', e);
        return;
    }

    const msgId = msg.id;
    allRecruits.set(msgId, newRecruit);
    activeUserRecruits.set(rKey, msgId);
    saveData();

    if (isGeneric) {
        // 범용 구인 — 웹 폼/관리자 페이지 없이 버튼 토글로 참가 관리
        await msg.edit({ components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`gjoin_${msgId}`).setLabel('참가/취소').setStyle(ButtonStyle.Primary)
            )
        ]}).catch(() => null);
    } else {
        // 이터널 리턴 — DB 이벤트 생성 (웹 폼 참가 + 관리자 페이지 공통)
        db.createEvent(msgId, interaction.guildId ?? null, interaction.channelId ?? null, user.id, teamCount, gameType, mapType);
        db.setSchedule(msgId, newRecruit.eventAt, newRecruit.expiresAt);
        await msg.edit({ components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`join_${msgId}`).setLabel('참가/취소').setStyle(ButtonStyle.Primary)
            )
        ]}).catch(() => null);
    }
}

// 보관된 내전 복구 — 채널에 새 구인 메시지를 올리고 참가자·팀 배정을 그대로 되살림
webServer.setRestoreCallback(async (archiveId) => {
    const a = db.getArchive(archiveId);
    if (!a) return { error: '보관된 내전이 없어요.' };

    const ev = a.event;
    const channel = await client.channels.fetch(ev.channelId).catch(() => null);
    if (!channel) return { error: '원래 채널을 찾을 수 없어요. (채널이 삭제됐거나 봇이 접근할 수 없음)' };

    // 방장이 다른 구인을 진행 중이면 그것부터 정리
    const rKey = `${ev.guildId ?? 'dm'}_${ev.createdBy}`;
    if (activeUserRecruits.has(rKey)) {
        const oldId = activeUserRecruits.get(rKey);
        const oldData = allRecruits.get(oldId);
        await deleteMessage(oldId, oldData?.channelId).catch(() => null);
        await webServer.deleteEventRole(oldId).catch(() => null);
        db.archiveEvent(oldId, 'replaced');
        allRecruits.delete(oldId);
    }

    const restored = {
        creatorId: ev.createdBy,
        guildId:   ev.guildId ?? 'dm',
        channelId: ev.channelId,
        participants: a.participants.filter(p => p.discord_id).map(p => p.discord_id),
        gameType: ev.gameType,
        mapType:  ev.mapType,
        description: null,
        isGeneric: false,
        time: Number.isFinite(ev.eventAt) ? schedule.formatDateLabel(ev.eventAt) + ' ' + schedule.formatTimeLabel(ev.eventAt) : '복구됨',
        eventAt:   Number.isFinite(ev.eventAt) ? ev.eventAt : null,
        // 일정이 이미 지났으면 24시간 더 유지해서 바로 사라지지 않게 한다
        expiresAt: Number.isFinite(ev.expiresAt) && ev.expiresAt > Date.now()
            ? ev.expiresAt
            : Date.now() + schedule.LEGACY_HOURS * 60 * 60 * 1000,
        durationHours: schedule.LEGACY_HOURS,
        maxPlayers: (ev.teamCount || 2) * (ev.mapType === '루미아 섬' ? 3 : 4),
        teamCount: ev.teamCount || 2,
        teams: Array.from({ length: ev.teamCount || 2 }, () => []),
        team1: [], team2: [],
        originalVoiceChannelId: null,
        createdAt: Date.now(),
    };

    let msg;
    try {
        msg = await channel.send({
            embeds: [await createRecruitEmbed(restored)],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('join_temp').setLabel('참가').setStyle(ButtonStyle.Primary)
            )],
        });
    } catch (e) {
        return { error: '메시지 전송 실패: ' + e.message };
    }

    const newId = msg.id;
    const r = db.restoreArchive(archiveId, newId, ev.channelId, ev.guildId);
    if (!r) { await msg.delete().catch(() => null); return { error: '복구 중 오류가 발생했어요.' }; }

    allRecruits.set(newId, restored);
    activeUserRecruits.set(rKey, newId);
    db.setSchedule(newId, restored.eventAt, restored.expiresAt);
    saveData();

    await msg.edit({ components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`join_${newId}`).setLabel('참가/취소').setStyle(ButtonStyle.Primary)
    )]}).catch(() => null);

    const BASE = process.env.WEB_URL || 'http://localhost:3000';
    const adminUrl = `${BASE}/admin?event=${newId}&token=${r.adminToken}`;
    const creator = await client.users.fetch(ev.createdBy).catch(() => null);
    if (creator) creator.send(`♻️ 내전이 복구됐어요! 참가자 ${r.participantCount}명\n관리 페이지: ${adminUrl}`).catch(() => null);

    return { eventId: newId, adminUrl, participantCount: r.participantCount };
});

// pendingLumia 만료 (5분)
setInterval(() => {
    const now = Date.now();
    for (const [userId, p] of pendingLumia) {
        if (now - p.createdAt > 5 * 60 * 1000) pendingLumia.delete(userId);
    }
}, 60 * 1000);

// 보관함 정리 (매시 정각, 7일 경과분 삭제)
cron.schedule('0 * * * *', () => {
    const n = db.purgeArchives(db.ARCHIVE_DAYS);
    if (n) console.log(`[보관함] 기간 만료 ${n}건 삭제`);
});

// 구인 자동 삭제 (1분마다)
// 신규: expiresAt(게임 시작 + 3시간) / 구버전: createdAt + durationHours(기본 24시간)
cron.schedule('* * * * *', async () => {
    const now = Date.now();
    for (const [msgId, data] of allRecruits) {
        const expiresAt = schedule.resolveExpiresAt(data);
        if (!Number.isFinite(expiresAt) || now < expiresAt) continue;
        try {
            await deleteMessage(msgId, data.channelId).catch(() => null);
            await webServer.deleteEventRole(msgId).catch(() => null);
            db.archiveEvent(msgId, 'expired');
        } catch (e) {
            console.error(`[자동삭제] ${msgId} 정리 중 오류:`, e.message);
        } finally {
            // 메시지/DB/메모리 상태가 어긋나지 않도록 정리는 항상 수행
            allRecruits.delete(msgId);
            activeUserRecruits.delete(`${data.guildId ?? 'dm'}_${data.creatorId}`);
            saveData();
        }
    }
});




// =====================================================
// 이벤트 핸들러
// =====================================================
client.on(Events.InteractionCreate, async interaction => {

    if (interaction.isChatInputCommand()) {

        // /구인
        if (interaction.commandName === '구인') {
            const choice      = interaction.options.getString('유형');
            const description = interaction.options.getString('설명') || null;

            const sch = schedule.buildSchedule(interaction.options.getString('날짜'), interaction.options.getString('시간'));
            if (sch?.error) return await interaction.reply({ content: sch.error, ephemeral: true });
            const timeStr  = sch ? sch.timeLabel : '즉시';
            const duration = schedule.LEGACY_HOURS;
            const eventAt  = sch?.eventAt, expiresAt = sch?.expiresAt;

            // 기타(범용) 구인 — 게임 이름·인원 직접 입력, 웹 폼 없이 버튼 참가
            if (choice === '기타') {
                const gameName   = (interaction.options.getString('게임') || '').trim();
                const maxPlayers = interaction.options.getInteger('인원');
                if (!gameName || !maxPlayers) {
                    return await interaction.reply({ content: '❌ 다른 게임 구인은 `게임`과 `인원`을 함께 입력해주세요.\n예) `/구인 유형:🎮 다른 게임 구인 게임:발로란트 인원:5`', ephemeral: true });
                }
                if (maxPlayers < 1 || maxPlayers > 20) {
                    return await interaction.reply({ content: '❌ 인원은 1~20명 사이로 입력해주세요.', ephemeral: true });
                }
                return await createRecruit(interaction, {
                    gameType: gameName, mapType: null, maxPlayers, teamCount: 2,
                    timeStr, duration, description, isGeneric: true, eventAt, expiresAt
                });
            }

            // 이터널 리턴 프리셋 (일반/랭크 루미아, 일반 코발트)
            const [gameType, mapKey] = choice.split('_');
            const mapType    = mapKey === '루미아' ? '루미아 섬' : '코발트';
            const maxPlayers = mapType === '코발트' ? 4 : 3;
            await createRecruit(interaction, {
                gameType, mapType, maxPlayers, teamCount: 2,
                timeStr, duration, description, isGeneric: true, eventAt, expiresAt
            });
        }

        // /내전
        if (interaction.commandName === '내전') {
            let 유형;
            try { 유형 = interaction.options.getSubcommand(); }
            catch { 유형 = interaction.options.getString('유형') ?? ''; }
            if (!유형) return;
            const sch = schedule.buildSchedule(interaction.options.getString('날짜'), interaction.options.getString('시간'));
            if (sch?.error) return await interaction.reply({ content: sch.error, ephemeral: true });
            const timeStr  = sch ? sch.timeLabel : '즉시';
            const duration = schedule.LEGACY_HOURS;
            const eventAt  = sch?.eventAt, expiresAt = sch?.expiresAt;

            if (유형 === '코발트') {
                return await createRecruit(interaction, {
                    gameType: '내전', mapType: '코발트',
                    maxPlayers: 8, teamCount: 2, timeStr, duration, eventAt, expiresAt
                });
            }

            if (유형 === '코발트토너먼트') {
                const maxPlayers = interaction.options.getInteger('최대인원') ?? 16;
                if (maxPlayers % 4 !== 0) return await interaction.reply({ content: '❌ 코발트 토너먼트는 4의 배수 인원만 가능해요 (8~32명).', ephemeral: true });
                return await createRecruit(interaction, {
                    gameType: '내전', mapType: '코발트 토너먼트',
                    maxPlayers, teamCount: maxPlayers / 4, timeStr, duration, eventAt, expiresAt
                });
            }

            if (유형 === '론울프') {
                const maxPlayers = Math.min(interaction.options.getInteger('최대인원') ?? 18, 18);
                return await createRecruit(interaction, {
                    gameType: '론울프', mapType: '루미아 섬',
                    maxPlayers, teamCount: maxPlayers, timeStr, duration, eventAt, expiresAt
                });
            }

            if (유형 === '루미아') {
                const maxPlayers = interaction.options.getInteger('최대인원') ?? 24;
                const perTeam    = interaction.options.getInteger('팀당인원') ?? 3;
                const remainder  = maxPlayers % perTeam;

                if (remainder === 0) {
                    const teamCount = maxPlayers / perTeam;
                    if (teamCount > 8) return await interaction.reply({ content: '❌ 팀 수가 너무 많아요 (최대 8팀).', ephemeral: true });
                    return await createRecruit(interaction, {
                        gameType: '내전', mapType: '루미아 섬',
                        maxPlayers, teamCount, timeStr, duration, eventAt, expiresAt
                    });
                }

                const teamCountUp   = Math.ceil(maxPlayers / perTeam);
                const teamCountDown = Math.floor(maxPlayers / perTeam);
                const leftover      = maxPlayers - teamCountDown * perTeam;
                const adjustedMax   = teamCountDown * perTeam;

                if (teamCountUp > 8) return await interaction.reply({ content: '❌ 팀 수가 너무 많아요 (최대 8팀).', ephemeral: true });

                pendingLumia.set(`${interaction.guildId ?? 'dm'}_${interaction.user.id}`, {
                    maxPlayers, perTeam, timeStr, duration, eventAt, expiresAt,
                    teamCountUp, teamCountDown, leftover, adjustedMax,
                    createdAt: Date.now()
                });

                return await interaction.reply({
                    content: [
                        `⚠️ **${maxPlayers}명**은 **팀당 ${perTeam}명**으로 딱 나누어지지 않아요.`,
                        '',
                        '어떻게 진행할까요?',
                        `🔹 **부족한대로 진행**: ${teamCountUp}팀으로 시작 (일부 팀 인원 부족)`,
                        `🔹 **남는 인원 빼기**: ${teamCountDown}팀(${adjustedMax}명)으로 시작 (${leftover}명 제외)`,
                    ].join('\n'),
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`lumiaKeep_${interaction.user.id}`).setLabel(`부족한대로 진행 (${teamCountUp}팀)`).setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`lumiaKick_${interaction.user.id}`).setLabel(`${leftover}명 빼기 (${teamCountDown}팀)`).setStyle(ButtonStyle.Danger)
                    )],
                    ephemeral: true
                });
            }
        }

        // /사용법
        if (interaction.commandName === '사용법') {
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('📖 나쟈 봇 사용 가이드')
                    .setColor(0x00AE86)
                    .addFields(
                        { name: '⚔️ /구인',           value: '일반(루미아): 3명 / 랭크(루미아): 3명 / 일반(코발트): 4명\n🎮 기타 게임: `게임`·`인원`·`설명` 직접 입력 (발로란트·LoL 등, 버튼으로 참가)' },
                        { name: '🏝️ /내전 루미아 섬', value: '팀당인원·최대인원 자유 설정 (최대 8팀)' },
                        { name: '🐺 /내전 론울프',     value: '1인 1팀 개인전 · 최대 18명 · 포지션 불필요' },
                        { name: '🌊 /내전 코발트',     value: '4vs4 고정' },
                        { name: '🏆 /내전 코발트토너먼트', value: '4인 팀 × N팀 싱글 엘리미네이션 (8~32명) · 관리 페이지에서 대진표 진행' },
                        { name: '✅ 참가/취소 버튼',   value: '웹 폼 링크로 참가 신청\n닉네임·티어·포지션 입력 (론울프는 포지션 제외)\n이미 신청 시 취소 링크 안내' },
                        { name: '⚙️ 웹 관리 페이지',   value: '참가 신청 후 수정 페이지에서 접근 (방장 전용)\n• 자동/수동 팀 배정\n• 팀경매(드래프트)\n• 캐릭터 밴 · 실험체 랜덤 배정\n• 맵/모드 변경 (디스코드 메시지 자동 업데이트)\n• 음성 채널 이동 · 원래대로\n• 방장 양도\n• 디스코드 결과 전송 · 모집 종료' },
                        { name: '🗓️ /시즌',             value: '현재 시즌 정보 및 종료까지 남은 기간' },
                        { name: '🆓 /무료실험체',       value: '이번 주 무료 실험체 목록 (모드별)' },
                        { name: '🎁 /오늘의포켓몬',      value: '하루에 한 번 오늘의 포켓몬을 만나고 포획 도전 (버튼)' },
                        { name: '📕 /도감',             value: '지금까지 포획한 포켓몬 목록' }
                    )],
                ephemeral: true
            });
        }

        // /시즌
        if (interaction.commandName === '시즌') {
            await interaction.deferReply();
            try {
                const res  = await fetch('https://open-api.bser.io/v1/data/Season', { headers: { 'x-api-key': process.env.ER_API_KEY } });
                const json = await res.json();
                const seasons = Array.isArray(json.data) ? json.data : [];
                const current = seasons.find(s => s.isCurrent) ?? seasons.at(-1);
                if (!current) return await interaction.editReply({ content: '⚠️ 시즌 정보를 불러올 수 없어요.' });

                const now     = Date.now();
                const endMs   = new Date(current.seasonEnd).getTime();
                const daysLeft = Math.ceil((endMs - now) / (1000 * 60 * 60 * 24));
                const startStr = current.seasonStart?.slice(0, 10) ?? '?';
                const endStr   = current.seasonEnd?.slice(0, 10)   ?? '?';

                const embed = new EmbedBuilder()
                    .setTitle(`🗓️ 이터널 리턴 현재 시즌`)
                    .setColor(0x00AE86)
                    .addFields(
                        { name: '시즌',   value: current.seasonName ?? `Season ${current.seasonID}`, inline: true },
                        { name: '시작일', value: startStr, inline: true },
                        { name: '종료일', value: endStr,   inline: true },
                        { name: '남은 기간', value: daysLeft > 0 ? `⏳ **${daysLeft}일** 남음` : '⚠️ 시즌 종료됨', inline: false }
                    )
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            } catch (err) {
                console.error('시즌 조회 오류:', err);
                await interaction.editReply({ content: '⚠️ 시즌 정보 조회 중 오류가 발생했어요.' });
            }
        }

        // /무료실험체
        if (interaction.commandName === '무료실험체') {
            await interaction.deferReply();
            try {
                const ER_API_KEY = process.env.ER_API_KEY;
                const BASE_URL   = 'https://open-api.bser.io';
                const modeNames  = { 1: '솔로', 2: '듀오', 3: '스쿼드' };

                const results = await Promise.all([1, 2, 3].map(async mode => {
                    const res  = await fetch(`${BASE_URL}/v1/freeCharacters/${mode}`, { headers: { 'x-api-key': ER_API_KEY } });
                    const json = await res.json();
                    return { mode, chars: json.freeCharacters ?? [] };
                }));

                const embed = new EmbedBuilder()
                    .setTitle('🆓 이번 주 무료 실험체')
                    .setColor(0x9B59B6)
                    .setTimestamp();

                for (const { mode, chars } of results) {
                    if (!chars.length) continue;
                    const names = chars.map(c => getCharName(c.characterCode) ?? `#${c.characterCode}`).join(', ');
                    embed.addFields({ name: `${modeNames[mode]}`, value: names, inline: false });
                }

                if (!embed.data.fields?.length) return await interaction.editReply({ content: '📭 무료 실험체 정보를 불러올 수 없어요.' });
                await interaction.editReply({ embeds: [embed] });
            } catch (err) {
                console.error('무료실험체 오류:', err);
                await interaction.editReply({ content: '⚠️ 무료 실험체 조회 중 오류가 발생했어요.' });
            }
        }

        // /오늘의포켓몬
        if (interaction.commandName === '오늘의포켓몬') {
            await interaction.deferReply();
            const userId = interaction.user.id;
            // 실패 지점을 로그만 보고 구분할 수 있게 단계를 기록한다
            let stage = 'PokeAPI 조회';
            try {
                const p    = await poke.getDailyPokemon(userId);
                stage = '도감 기록 조회';
                const done = poke.todayResult(userId);   // 오늘 이미 시도했으면 그 결과
                stage = 'Discord 임베드 생성';
                const payload = {
                    content: pokeContent(p, done),
                    embeds: [buildPokeEmbed(pokeDisplayName(interaction), p, done)],
                    components: [pokeButtons(userId, !!done)],
                };
                stage = 'Discord 메시지 전송';
                await interaction.editReply(payload);
            } catch (err) {
                console.error(`[오늘의포켓몬] 실패 — 단계: ${stage} / user: ${userId}`);
                console.error(`Error: ${err.message}`);
                if (err.cause) console.error(`Cause: ${err.cause.code || err.cause.message || String(err.cause)}`);
                console.error(err.stack);
                await interaction.editReply({ content: '⚠️ 포켓몬 정보를 불러오지 못했어요. 잠시 후 다시 시도해주세요.' })
                    .catch(e2 => console.error('[오늘의포켓몬] 오류 응답 전송도 실패:', e2.message));
            }
        }

        // /도감
        if (interaction.commandName === '도감') {
            await interaction.deferReply({ ephemeral: true });
            try {
                const { total, entries } = poke.getPokedex(interaction.user.id);
                const embed = new EmbedBuilder()
                    .setTitle(`📕 ${pokeDisplayName(interaction)}의 포켓몬 도감`)
                    .setColor(0x5865F2)
                    .setFooter({ text: `${total} / ${poke.MAX_DEX} 종 포획` })
                    .setTimestamp();

                if (!total) {
                    embed.setDescription('아직 포획한 포켓몬이 없어요. `/오늘의포켓몬` 으로 도전해보세요!');
                } else {
                    // 필드 1024자 제한 때문에 나눠서 표시
                    const items = entries.map(e => `\`#${String(e.dexNo).padStart(4, '0')}\` ${e.name}${e.count > 1 ? ` ×${e.count}` : ''}`);
                    let buf = [], fieldNo = 0;
                    const flush = () => {
                        if (!buf.length) return;
                        embed.addFields({ name: fieldNo++ === 0 ? '포획한 포켓몬' : '​', value: buf.join('\n') });
                        buf = [];
                    };
                    for (const it of items) {
                        if (buf.join('\n').length + it.length + 1 > 1000) flush();
                        buf.push(it);
                    }
                    flush();
                }
                await interaction.editReply({ embeds: [embed] });
            } catch (err) {
                console.error('도감 오류:', err);
                await interaction.editReply({ content: '⚠️ 도감을 불러오지 못했어요.' });
            }
        }

    }

    // ──────────────────────────────────────────────
    // 버튼 인터랙션
    // ──────────────────────────────────────────────
    if (interaction.isButton()) {
        const parts  = interaction.customId.split('_');
        const action = parts[0];

        // lumia 분기 버튼
        if (action === 'lumiaKeep' || action === 'lumiaKick') {
            const userId  = parts[1];
            if (interaction.user.id !== userId) return;
            const lumiaKey = `${interaction.guildId ?? 'dm'}_${userId}`;
            const pending = pendingLumia.get(lumiaKey);
            if (!pending) return await interaction.update({ content: '⚠️ 시간이 초과됐어요 (5분). 다시 명령어를 입력해주세요.', components: [] });

            if (action === 'lumiaKeep') {
                pendingLumia.delete(lumiaKey);
                await interaction.update({ content: `✅ ${pending.teamCountUp}팀으로 구인을 시작합니다!`, components: [] });
                return await createRecruit(interaction, { gameType: '내전', mapType: '루미아 섬', maxPlayers: pending.maxPlayers, teamCount: pending.teamCountUp, timeStr: pending.timeStr, duration: pending.duration, eventAt: pending.eventAt, expiresAt: pending.expiresAt });
            }
            if (action === 'lumiaKick') {
                pendingLumia.delete(lumiaKey);
                await interaction.update({ content: `✅ ${pending.teamCountDown}팀(${pending.adjustedMax}명)으로 구인을 시작합니다!\n${pending.leftover}명은 취소 버튼으로 제외해주세요.`, components: [] });
                return await createRecruit(interaction, { gameType: '내전', mapType: '루미아 섬', maxPlayers: pending.adjustedMax, teamCount: pending.teamCountDown, timeStr: pending.timeStr, duration: pending.duration, eventAt: pending.eventAt, expiresAt: pending.expiresAt });
            }
        }

        // 오늘의 포켓몬 — 포획 / 놓아주기
        if (action === 'pokeCatch' || action === 'pokeRelease') {
            const ownerId = parts[1];
            if (interaction.user.id !== ownerId)
                return await interaction.reply({ content: '⚠️ 본인이 만난 포켓몬만 다룰 수 있어요. `/오늘의포켓몬` 으로 직접 만나보세요!', ephemeral: true });

            let stage = 'PokeAPI 조회';
            try {
                const p = await poke.getDailyPokemon(ownerId);
                stage = action === 'pokeCatch' ? '포획 판정' : '놓아주기 처리';
                const r = action === 'pokeCatch' ? poke.tryCatch(ownerId, p) : poke.release(ownerId);
                stage = 'Discord 메시지 갱신';
                const name = pokeDisplayName(interaction);
                if (r.result === 'already') {
                    await interaction.update({ content: pokeContent(p, r.previous), embeds: [buildPokeEmbed(name, p, r.previous)], components: [pokeButtons(ownerId, true)] });
                    return await interaction.followUp({ content: '⚠️ 오늘은 이미 시도했어요. 내일 다시 만나요!', ephemeral: true });
                }
                return await interaction.update({
                    content: pokeContent(p, r.result),
                    embeds: [buildPokeEmbed(name, p, r.result)],
                    components: [pokeButtons(ownerId, true)],
                });
            } catch (err) {
                console.error(`[포켓몬 버튼] 실패 — 단계: ${stage} / action: ${action} / user: ${ownerId}`);
                console.error(`Error: ${err.message}`);
                if (err.cause) console.error(`Cause: ${err.cause.code || err.cause.message || String(err.cause)}`);
                console.error(err.stack);
                return await interaction.reply({ content: '⚠️ 처리 중 오류가 발생했어요.', ephemeral: true }).catch(() => null);
            }
        }

        // 참가/취소 — 웹 폼 기반 (이터널 리턴)
        if (action === 'join' || action === 'leave') {
            const targetMsgId = parts[1];
            if (!allRecruits.get(targetMsgId)) return;
            const BASE = process.env.WEB_URL || 'http://localhost:3000';
            const existing = db.getByDiscordId(targetMsgId, interaction.user.id);
            if (existing) {
                return await interaction.reply({ content: `✅ 이미 참가 신청됐어요.\n수정/취소는 여기서: ${BASE}/cancel?token=${existing.cancel_token}`, ephemeral: true });
            }
            const webUrl = `${BASE}/join?event=${targetMsgId}&discord_id=${interaction.user.id}`;
            return await interaction.reply({ content: `아래 링크에서 참가 신청해주세요!\n${webUrl}`, ephemeral: true });
        }

        // 범용 구인 참가/취소 — 버튼 토글 (웹 폼 없음)
        if (action === 'gjoin') {
            const targetMsgId = parts[1];
            const data = allRecruits.get(targetMsgId);
            if (!data) return await interaction.reply({ content: '⚠️ 이미 종료된 구인이에요.', ephemeral: true });

            const uid = interaction.user.id;
            const idx = data.participants.indexOf(uid);
            let justJoined = false;
            if (idx === -1) {
                if (data.participants.length >= data.maxPlayers) {
                    return await interaction.reply({ content: '❌ 인원이 이미 다 찼어요.', ephemeral: true });
                }
                data.participants.push(uid);
                justJoined = true;
            } else {
                data.participants.splice(idx, 1);
            }
            saveData();

            await interaction.update({
                embeds: [await createRecruitEmbed(data)],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`gjoin_${targetMsgId}`).setLabel('참가/취소').setStyle(ButtonStyle.Primary)
                )]
            });

            // 인원이 다 차면 방장에게 DM 알림
            if (justJoined && data.participants.length === data.maxPlayers) {
                const creator = await client.users.fetch(data.creatorId).catch(() => null);
                if (creator) creator.send(`🎉 [${data.gameType}] 구인 인원이 다 찼어요! (${data.maxPlayers}명 모집 완료)`).catch(() => null);
            }
        }
    }

});

client.once(Events.ClientReady, () => {
    client.user.setActivity('/사용법 | 문의 @chapseon', { type: 4 });
});

client.login(process.env.TOKEN);
