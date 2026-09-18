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
const { TEAM_EMOJIS, TEAM_NAMES, CHARACTERS } = require('./constants');
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
    db.deleteEvent(msgId);
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


// =====================================================
// 실험체 코드 → 이름 매핑 (API characterCode 기준)
// =====================================================
const CHARACTER_MAP = {
    1:'재키', 2:'아야', 3:'요한', 4:'혜진', 5:'다니엘',
    6:'피오라', 7:'리오', 8:'현우', 9:'자크', 10:'에스텔',
    11:'마이', 12:'니아', 13:'론', 14:'레니', 15:'카셀',
    16:'루크', 17:'이리', 18:'로지', 19:'나딘', 20:'블레어',
    21:'알론소', 22:'수아', 23:'마커스', 24:'제이크', 25:'셀린',
    26:'리베카', 27:'클로에', 28:'쇼우', 29:'카밀로', 30:'마를렌',
    31:'키아라', 32:'바냐', 33:'이렘', 34:'스텔라', 35:'잭키',
    36:'레녹스', 37:'매그너스', 38:'가넷', 39:'쇼이치', 40:'프리야',
    41:'유민', 42:'아이솔', 43:'니키', 44:'버니스', 45:'타지',
    46:'조이', 47:'바바라', 48:'티나', 49:'준', 50:'펠릭스',
    51:'아비게일', 52:'데비', 53:'아디나', 54:'하비', 55:'리 다이린',
    56:'마르티나', 57:'테오도르', 58:'비앙카', 59:'카티야', 60:'야도',
    61:'히스이', 62:'일레븐', 63:'나타폰', 64:'펜리르', 65:'레온',
    66:'라우라', 67:'알렉상드르', 68:'루크', 69:'르노어', 70:'띠아',
    71:'야니코', 72:'헤이즈', 73:'시셀라', 74:'아르다', 75:'아이린',
    76:'에단', 77:'권술사', 78:'아드리안', 79:'미마', 80:'JP',
    81:'샬럿', 82:'미르카', 83:'비형'
};

function getCharName(code) {
    return CHARACTER_MAP[code] || `실험체(${code})`;
}

// =====================================================
// 임베드 생성 (async - 닉네임 직접 조회)
// =====================================================
async function createRecruitEmbed(data) {
    const colors = { '일반': 0x00FF00, '랭크': 0x5865F2, '내전': 0xFF0000, '론울프': 0xFF8C00 };
    const teamCount = data.teamCount || 2;
    const teams     = data.teams || Array.from({ length: teamCount }, () => []);

    const nameCache = new Map();
    const getName = async (id) => {
        if (nameCache.has(id)) return nameCache.get(id);
        const u = await client.users.fetch(id).catch(() => null);
        const name = u ? (u.globalName || u.username) : id;
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
        .addFields(
            { name: '⏰ 시작 시간', value: data.time,                                         inline: true },
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
async function createRecruit(interaction, { gameType, mapType, maxPlayers, teamCount, timeStr, duration, description, isGeneric }) {
    const user    = interaction.user;
    const guildId = interaction.guildId ?? 'dm';
    const rKey    = `${guildId}_${user.id}`;  // 서버별 유일 키

    if (activeUserRecruits.has(rKey)) {
        const oldMsgId = activeUserRecruits.get(rKey);
        const oldData  = allRecruits.get(oldMsgId);
        await deleteMessage(oldMsgId, oldData?.channelId).catch(() => null);
        await webServer.deleteEventRole(oldMsgId).catch(() => null);
        db.deleteEvent(oldMsgId);
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
        await msg.edit({ components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`join_${msgId}`).setLabel('참가/취소').setStyle(ButtonStyle.Primary)
            )
        ]}).catch(() => null);
    }
}

// pendingLumia 만료 (5분)
setInterval(() => {
    const now = Date.now();
    for (const [userId, p] of pendingLumia) {
        if (now - p.createdAt > 5 * 60 * 1000) pendingLumia.delete(userId);
    }
}, 60 * 1000);

// 구인 자동 삭제 (1분마다)
cron.schedule('* * * * *', async () => {
    const now = Date.now();
    for (const [msgId, data] of allRecruits) {
        const expireMs = (data.durationHours || 24) * 60 * 60 * 1000;
        if (data.createdAt && now - data.createdAt > expireMs) {
            await deleteMessage(msgId, data.channelId).catch(() => null);
            await webServer.deleteEventRole(msgId).catch(() => null);
            db.deleteEvent(msgId);
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
            const timeStr     = interaction.options.getString('시간')      || '즉시';
            const duration    = interaction.options.getInteger('종료시간') || 24;
            const description = interaction.options.getString('설명') || null;

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
                    timeStr, duration, description, isGeneric: true
                });
            }

            // 이터널 리턴 프리셋 (일반/랭크 루미아, 일반 코발트)
            const [gameType, mapKey] = choice.split('_');
            const mapType    = mapKey === '루미아' ? '루미아 섬' : '코발트';
            const maxPlayers = mapType === '코발트' ? 4 : 3;
            await createRecruit(interaction, {
                gameType, mapType, maxPlayers, teamCount: 2,
                timeStr, duration, description, isGeneric: true
            });
        }

        // /내전
        if (interaction.commandName === '내전') {
            let 유형;
            try { 유형 = interaction.options.getSubcommand(); }
            catch { 유형 = interaction.options.getString('유형') ?? ''; }
            if (!유형) return;
            const timeStr  = interaction.options.getString('시간')      || '즉시';
            const duration = interaction.options.getInteger('종료시간') || 24;

            if (유형 === '코발트') {
                return await createRecruit(interaction, {
                    gameType: '내전', mapType: '코발트',
                    maxPlayers: 8, teamCount: 2, timeStr, duration
                });
            }

            if (유형 === '코발트토너먼트') {
                const maxPlayers = interaction.options.getInteger('최대인원') ?? 16;
                if (maxPlayers % 4 !== 0) return await interaction.reply({ content: '❌ 코발트 토너먼트는 4의 배수 인원만 가능해요 (8~32명).', ephemeral: true });
                return await createRecruit(interaction, {
                    gameType: '내전', mapType: '코발트 토너먼트',
                    maxPlayers, teamCount: maxPlayers / 4, timeStr, duration
                });
            }

            if (유형 === '론울프') {
                const maxPlayers = Math.min(interaction.options.getInteger('최대인원') ?? 18, 18);
                return await createRecruit(interaction, {
                    gameType: '론울프', mapType: '루미아 섬',
                    maxPlayers, teamCount: maxPlayers, timeStr, duration
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
                        maxPlayers, teamCount, timeStr, duration
                    });
                }

                const teamCountUp   = Math.ceil(maxPlayers / perTeam);
                const teamCountDown = Math.floor(maxPlayers / perTeam);
                const leftover      = maxPlayers - teamCountDown * perTeam;
                const adjustedMax   = teamCountDown * perTeam;

                if (teamCountUp > 8) return await interaction.reply({ content: '❌ 팀 수가 너무 많아요 (최대 8팀).', ephemeral: true });

                pendingLumia.set(`${interaction.guildId ?? 'dm'}_${interaction.user.id}`, {
                    maxPlayers, perTeam, timeStr, duration,
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
                        { name: '🆓 /무료실험체',       value: '이번 주 무료 실험체 목록 (모드별)' }
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
                return await createRecruit(interaction, { gameType: '내전', mapType: '루미아 섬', maxPlayers: pending.maxPlayers, teamCount: pending.teamCountUp, timeStr: pending.timeStr, duration: pending.duration });
            }
            if (action === 'lumiaKick') {
                pendingLumia.delete(lumiaKey);
                await interaction.update({ content: `✅ ${pending.teamCountDown}팀(${pending.adjustedMax}명)으로 구인을 시작합니다!\n${pending.leftover}명은 취소 버튼으로 제외해주세요.`, components: [] });
                return await createRecruit(interaction, { gameType: '내전', mapType: '루미아 섬', maxPlayers: pending.adjustedMax, teamCount: pending.teamCountDown, timeStr: pending.timeStr, duration: pending.duration });
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
