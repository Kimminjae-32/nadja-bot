const {
    Client, GatewayIntentBits, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    Events, StringSelectMenuBuilder, ChannelType
} = require('discord.js');
const fs   = require('fs');
const cron = require('node-cron');
require('dotenv').config();

const db        = require('./db');
const webServer = require('./server');
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
        for (const [, guild] of client.guilds.cache) {
            for (const [, channel] of guild.channels.cache.filter(c => c.isTextBased())) {
                const msg = await channel.messages.fetch(msgId).catch(() => null);
                if (msg) { await msg.delete().catch(() => null); break; }
            }
        }
    } catch (e) { /* 무시 */ }
    allRecruits.delete(msgId);
    activeUserRecruits.delete(data.creatorId);
    saveData();
});

const DATA_PATH       = './recruits.json';

let allRecruits        = new Map();
let activeUserRecruits = new Map();
let moveProgress       = new Map();
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

const TEAM_EMOJIS = ['🟦','🟥','🟩','🟨','🟪','🟧','⬜','🟫'];
const TEAM_NAMES  = ['1팀','2팀','3팀','4팀','5팀','6팀','7팀','8팀'];

const CHARACTERS = [
    '재키','아야','현우','매그너스','피오라','나딘','자히르','하트','아이솔','리 다이린','유키','혜진','쇼우','시셀라',
    '키아라','아드리아나','쇼이치','실비아','엘마','레녹스','로지','루크','캐시','아델라','버니스','바바라','알렉스','수아',
    '레온','일레븐','리오','윌리엄','니키','나타폰','안','이바','다니엘','제니','카밀로','클로에','요한','비앙카',
    '셀린','에키온','마이','에이든','라우라','띠아','펠릭스','엘레나','프리야','아디나','마커스','칼라','에스텔','피올로',
    '마르티나','헤이즈','아이작','타지아','이렘','테오도르','이안','바냐','데비&마를렌','아르다','아비게일','알론소','레니','초바메',
    '케네스','카티야','샬럿','다르코','르노어','가넷','유민','히스이','유스티나','아슈트반','니아','슈린','헨리','블레어',
    '미르카','펜리르','코렐라인','비형'
];

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

    const embed = new EmbedBuilder()
        .setTitle(`🎮 [${data.gameType} / ${data.mapType}] 구인 중`)
        .addFields(
            { name: '⏰ 시작 시간', value: data.time,                                         inline: true },
            { name: '👥 인원',      value: `${data.participants.length} / ${data.maxPlayers}`, inline: true },
            { name: '👑 모집자',    value: creatorName,                                        inline: true },
            { name: '📝 전체 참가자', value: participantsList }
        )
        .setColor(colors[data.gameType] || 0x000000)
        .setTimestamp();

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
async function createRecruit(interaction, { gameType, mapType, maxPlayers, teamCount, timeStr, duration }) {
    const user = interaction.user;

    if (activeUserRecruits.has(user.id)) {
        const oldMsgId = activeUserRecruits.get(user.id);
        const oldMsg   = await interaction.channel.messages.fetch(oldMsgId).catch(() => null);
        if (oldMsg) await oldMsg.delete().catch(() => null);
    }

    const newRecruit = {
        creatorId: user.id,
        participants: [user.id],
        gameType, mapType,
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
    activeUserRecruits.set(user.id, msgId);
    saveData();

    if (gameType === '내전') {
        db.createEvent(msgId, interaction.guildId ?? null, interaction.channelId ?? null, user.id, teamCount);
    }

    let rows;
    if (gameType === '내전') {
        rows = [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`join_${msgId}`).setLabel('참가/취소').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`shuffle_${msgId}`).setLabel('팀 섞기(자동)').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`manage_${msgId}`).setLabel('⚙️ 관리').setStyle(ButtonStyle.Secondary)
            )
        ];
    } else if (gameType === '론울프') {
        rows = [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`join_${msgId}`).setLabel('참가').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`leave_${msgId}`).setLabel('취소').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`charRandom_${msgId}`).setLabel('실험체 랜덤').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`manage_${msgId}`).setLabel('⚙️ 관리').setStyle(ButtonStyle.Secondary)
            )
        ];
    } else {
        rows = [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`join_${msgId}`).setLabel('참가').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`leave_${msgId}`).setLabel('취소').setStyle(ButtonStyle.Danger)
            )
        ];
    }

    await msg.edit({ components: rows }).catch(() => null);
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
            try {
                for (const [, guild] of client.guilds.cache) {
                    for (const [, channel] of guild.channels.cache.filter(c => c.isTextBased())) {
                        const msg = await channel.messages.fetch(msgId).catch(() => null);
                        if (msg) { await msg.delete().catch(() => null); break; }
                    }
                }
            } catch (e) { /* 무시 */ }
            allRecruits.delete(msgId);
            activeUserRecruits.delete(data.creatorId);
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
            const choice     = interaction.options.getString('유형');
            const [gameType, mapKey] = choice.split('_');
            const mapType    = mapKey === '루미아' ? '루미아 섬' : '코발트';
            const maxPlayers = mapType === '코발트' ? 4 : 3;
            await createRecruit(interaction, {
                gameType, mapType, maxPlayers, teamCount: 2,
                timeStr:  interaction.options.getString('시간')      || '즉시',
                duration: interaction.options.getInteger('종료시간') || 24
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

                pendingLumia.set(interaction.user.id, {
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
                    .setTitle('📖 나쟈 봇 구인 가이드')
                    .setColor(0x00AE86)
                    .addFields(
                        { name: '⚔️ /구인',          value: '일반(루미아): 3명\n랭크(루미아): 3명\n일반(코발트): 4명' },
                        { name: '🏝️ /내전 루미아 섬', value: '기본: 24명 / 3인팀 → 8팀\n팀당인원·최대인원 직접 입력 가능' },
                        { name: '🐺 /내전 론울프',    value: '1인 1팀 개인전\n최대 18명, 기본 18명' },
                        { name: '🌊 /내전 코발트',    value: '4vs4 고정 (자동 설정)' },
                        { name: '🎲 팀 섞기(자동)',    value: '참가자들을 랜덤으로 각 팀에 배정합니다.' },
                        { name: '🃏 실험체 랜덤',      value: '팀 배정 후 각 팀원에게 실험체를 랜덤으로 배정합니다.' },
                        { name: '✍️ 팀 설정(수동)',    value: '방장이 직접 1팀 멤버를 선택합니다. 나머지는 자동 배정.' },
                        { name: '👢 참가자 킥',        value: '방장이 특정 참가자를 구인에서 제외합니다.' },
                        { name: '🗺️ 맵 변경',          value: '론울프에서 루미아 섬/코발트로 변경 가능. 인원 유지.' },
                        { name: '🔊 방 이동',          value: '각 팀별로 이동할 음성 채널을 순서대로 선택합니다.' },
                        { name: '🗓️ /시즌',            value: '현재 이터널 리턴 시즌 정보 및 종료까지 남은 기간 표시.' },
                        { name: '🆓 /무료실험체',      value: '이번 주 무료 실험체 목록을 모드별로 표시합니다.' }
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
            const pending = pendingLumia.get(userId);
            if (!pending) return await interaction.update({ content: '⚠️ 시간이 초과됐어요 (5분). 다시 명령어를 입력해주세요.', components: [] });

            if (action === 'lumiaKeep') {
                pendingLumia.delete(userId);
                await interaction.update({ content: `✅ ${pending.teamCountUp}팀으로 구인을 시작합니다!`, components: [] });
                return await createRecruit(interaction, { gameType: '내전', mapType: '루미아 섬', maxPlayers: pending.maxPlayers, teamCount: pending.teamCountUp, timeStr: pending.timeStr, duration: pending.duration });
            }
            if (action === 'lumiaKick') {
                pendingLumia.delete(userId);
                await interaction.update({ content: `✅ ${pending.teamCountDown}팀(${pending.adjustedMax}명)으로 구인을 시작합니다!\n${pending.leftover}명은 취소 버튼으로 제외해주세요.`, components: [] });
                return await createRecruit(interaction, { gameType: '내전', mapType: '루미아 섬', maxPlayers: pending.adjustedMax, teamCount: pending.teamCountDown, timeStr: pending.timeStr, duration: pending.duration });
            }
        }

        const targetMsgId = parts[1];
        const data        = allRecruits.get(targetMsgId);
        if (!data) return;

        // 팀 섞기
        if (action === 'shuffle') {
            if (interaction.user.id !== data.creatorId) return await interaction.reply({ content: '방장만 가능합니다.', ephemeral: true });
            const teamCount = data.teamCount || 2;

            const webParticipants = db.getParticipants(targetMsgId);
            if (webParticipants.length >= 2) {
                await interaction.deferReply();
                const shuffled = [...webParticipants].sort(() => Math.random() - 0.5);
                const teams = Array.from({ length: teamCount }, () => []);
                shuffled.forEach((p, i) => teams[i % teamCount].push(p));

                const POS_EMOJI = { '탱커': '🛡️', '전사': '⚔️', '암살자': '🗡️', '스킬 딜러': '✨', '원거리 딜러': '🏹', '지원가': '💚' };
                const embed = new EmbedBuilder()
                    .setTitle('🎲 팀 배정 결과')
                    .setColor(0xFF0000)
                    .setFooter({ text: `총 ${webParticipants.length}명 참가` })
                    .setTimestamp();

                for (let i = 0; i < teamCount; i++) {
                    const team = teams[i];
                    if (!team.length) continue;
                    const lines = team.map(p =>
                        `${POS_EMOJI[p.position] || ''}**${p.discord_nickname}** (${p.ingame_nickname})\n└ ${p.position}`
                    );
                    embed.addFields({ name: `${TEAM_EMOJIS[i]} ${TEAM_NAMES[i]} (${team.length}명)`, value: lines.join('\n\n'), inline: true });
                }
                return await interaction.editReply({ embeds: [embed] });
            }

            // 웹 폼 참가자 없으면 기존 Discord 참가자로 섞기
            const shuffled = [...data.participants].sort(() => Math.random() - 0.5);
            data.teams = Array.from({ length: teamCount }, () => []);
            shuffled.forEach((id, i) => data.teams[i % teamCount].push(id));
            data.team1 = data.teams[0] || [];
            data.team2 = data.teams[1] || [];
            saveData();
            await interaction.deferUpdate();
            await interaction.message.edit({ embeds: [await createRecruitEmbed(data)] }).catch(() => null);
        }
        // 팀 설정 (수동)
        else if (action === 'manual') {
            if (interaction.user.id !== data.creatorId) return await interaction.reply({ content: '방장만 가능합니다.', ephemeral: true });
            const options = await Promise.all(data.participants.map(async id => {
                const u = await client.users.fetch(id);
                return { label: u.username, value: id };
            }));
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`setTeamManual_${targetMsgId}`)
                .setPlaceholder('1팀에 넣을 멤버를 선택하세요')
                .setMinValues(1).setMaxValues(Math.min(options.length, 25))
                .addOptions(options);
            return await interaction.reply({ content: '🟦 **1팀** 멤버를 골라주세요. 나머지는 자동으로 2팀에 배정됩니다.', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
        }
        // 실험체 랜덤
        else if (action === 'charRandom') {
            if (interaction.user.id !== data.creatorId) return await interaction.reply({ content: '방장만 가능합니다.', ephemeral: true });
            const shuffled = [...CHARACTERS].sort(() => Math.random() - 0.5);
            const embed = new EmbedBuilder().setTitle('🎲 실험체 랜덤 배정 결과').setColor(0x9B59B6).setTimestamp();

            if (data.gameType === '론울프') {
                const lines = await Promise.all(data.participants.map(async (id, i) => {
                    const u = await client.users.fetch(id).catch(() => null);
                    const name = u ? (u.globalName || u.username) : id;
                    return `${name}  →  **${shuffled[i % shuffled.length]}**`;
                }));
                const chunkSize = 10;
                for (let i = 0; i < lines.length; i += chunkSize) {
                    embed.addFields({ name: i === 0 ? '🐺 참가자' : '\u200b', value: lines.slice(i, i + chunkSize).join('\n'), inline: false });
                }
            } else {
                const teams = data.teams || [data.team1, data.team2];
                const teamCount = data.teamCount || 2;
                const hasTeamAssignment = teams.some(team => team && team.length > 0);
                if (!hasTeamAssignment) return await interaction.reply({ content: '⚠️ 먼저 팀을 섞어주세요!', ephemeral: true });

                let charIdx = 0;
                const assignMap = new Map();
                for (let i = 0; i < teamCount; i++) {
                    for (const id of (teams[i] || [])) {
                        assignMap.set(id, shuffled[charIdx % shuffled.length]);
                        charIdx++;
                    }
                }
                for (let i = 0; i < teamCount; i++) {
                    const team = teams[i] || [];
                    if (team.length === 0) continue;
                    const lines = await Promise.all(team.map(async id => {
                        const u = await client.users.fetch(id).catch(() => null);
                        const name = u ? (u.globalName || u.username) : id;
                        return `${name}  →  **${assignMap.get(id) || '?'}**`;
                    }));
                    embed.addFields({ name: `${TEAM_EMOJIS[i]} ${TEAM_NAMES[i]}`, value: lines.join('\n'), inline: false });
                }
            }
            return await interaction.reply({ embeds: [embed] });
        }
        // 참가자 킥
        else if (action === 'kick') {
            if (interaction.user.id !== data.creatorId) return await interaction.reply({ content: '방장만 가능합니다.', ephemeral: true });
            const others = data.participants.filter(id => id !== data.creatorId);
            if (others.length === 0) return await interaction.reply({ content: '킥할 참가자가 없습니다.', ephemeral: true });
            const options = await Promise.all(others.map(async id => {
                const u = await client.users.fetch(id);
                return { label: u.username, value: id };
            }));
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`selectKick_${targetMsgId}`)
                .setPlaceholder('제외할 참가자를 선택하세요')
                .setMinValues(1).setMaxValues(Math.min(options.length, 25))
                .addOptions(options);
            return await interaction.reply({ content: '👢 제외할 참가자를 선택하세요.', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
        }
        // 맵 변경
        else if (action === 'changeMap') {
            if (interaction.user.id !== data.creatorId) return await interaction.reply({ content: '방장만 가능합니다.', ephemeral: true });
            const choices = [
                { label: '🏝️ 루미아 섬 (내전)', value: '루미아 섬' },
                { label: '🌊 코발트 (내전 4vs4)', value: '코발트' },
                { label: '🐺 론울프 (개인전)', value: '론울프' },
            ].filter(c => !(data.gameType === '론울프' && c.value === '론울프')
                       && !(data.gameType === '내전' && data.mapType === '루미아 섬' && c.value === '루미아 섬')
                       && !(data.gameType === '내전' && data.mapType === '코발트' && c.value === '코발트'));
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`selectChangeMap_${targetMsgId}`)
                .setPlaceholder('변경할 맵을 선택하세요')
                .addOptions(choices);
            return await interaction.reply({
                content: `현재: **${data.gameType} / ${data.mapType}**\n변경할 맵을 선택해주세요. 인원은 그대로 유지됩니다.`,
                components: [new ActionRowBuilder().addComponents(menu)],
                ephemeral: true
            });
        }
        // 방장 양도
        else if (action === 'transfer') {
            if (interaction.user.id !== data.creatorId) return await interaction.reply({ content: '방장만 가능합니다.', ephemeral: true });
            const others = data.participants.filter(id => id !== data.creatorId);
            if (others.length === 0) return await interaction.reply({ content: '양도할 사람이 없습니다.', ephemeral: true });
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`selectTransfer_${targetMsgId}`)
                .setPlaceholder('새 방장 선택')
                .addOptions(await Promise.all(others.map(async id => {
                    const u = await client.users.fetch(id);
                    return { label: u.username, value: id };
                })));
            return await interaction.reply({ content: '누구에게 양도할까요?', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
        }
        // 방 이동
        else if (action === 'move') {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!member.voice.channel) return await interaction.reply({ content: '음성 채널에 먼저 접속해주세요.', ephemeral: true });
            data.originalVoiceChannelId = member.voice.channelId;
            const teamCount = data.teamCount || 2;
            moveProgress.set(targetMsgId, { step: 0, teamChannels: [], teamCount });
            const voiceChannels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).map(c => ({ label: c.name, value: c.id })).slice(0, 25);
            const menu = new StringSelectMenuBuilder().setCustomId(`selectMoveTeam_${targetMsgId}`).setPlaceholder(`${TEAM_EMOJIS[0]} ${TEAM_NAMES[0]} 이동 채널 선택`).addOptions(voiceChannels);
            return await interaction.reply({ content: `${TEAM_EMOJIS[0]} **${TEAM_NAMES[0]}**이 갈 채널을 골라주세요. (1/${teamCount})`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
        }
        // 원래대로 (방장 전용)
        else if (action === 'return') {
            if (interaction.user.id !== data.creatorId) return await interaction.reply({ content: '방장만 가능합니다.', ephemeral: true });
            if (!data.originalVoiceChannelId) return await interaction.reply({ content: '기록이 없습니다.', ephemeral: true });
            for (const id of data.participants) {
                const m = await interaction.guild.members.fetch(id).catch(() => null);
                if (m?.voice.channel) await m.voice.setChannel(data.originalVoiceChannelId).catch(() => null);
            }
            return await interaction.reply({ content: '✅ 모두 원래 채널로 복구했어요!', ephemeral: true });
        }
        // 관리 메뉴
        else if (action === 'manage') {
            if (interaction.user.id !== data.creatorId) return await interaction.reply({ content: '방장만 가능합니다.', ephemeral: true });
            const menuOptions = data.gameType === '내전'
                ? [
                    { label: '팀 설정(수동)', value: 'manual',    description: '방장이 직접 팀을 구성합니다' },
                    { label: '참가자 킥',    value: 'kick',      description: '참가자를 제외합니다' },
                    { label: '방장 양도',    value: 'transfer',  description: '방장 권한을 양도합니다' },
                    { label: '방 이동',      value: 'move',      description: '팀별로 음성 채널을 이동합니다' },
                    { label: '원래대로',     value: 'return',    description: '모든 참가자를 원래 채널로 복구합니다' },
                    { label: '맵 변경',      value: 'changeMap', description: '맵/모드를 변경합니다' },
                ]
                : [
                    { label: '참가자 킥',     value: 'kick',      description: '참가자를 제외합니다' },
                    { label: '방장 양도',     value: 'transfer',  description: '방장 권한을 양도합니다' },
                    { label: '맵 변경',       value: 'changeMap', description: '맵/모드를 변경합니다' },
                ];
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`selectManage_${targetMsgId}`)
                .setPlaceholder('관리 기능 선택')
                .addOptions(menuOptions);
            return await interaction.reply({ content: '⚙️ 관리 기능을 선택하세요:', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
        }
        // 참가/취소 (통합 버튼) / 론울프·구인 참가·취소
        else if (action === 'join' || action === 'leave') {
            const BASE = process.env.WEB_URL || 'http://localhost:3000';

            // ── 내전: 참가/취소 통합 버튼 ──
            if (data.gameType === '내전') {
                // 방장 클릭 → 웹 관리자 페이지 링크 제공
                if (interaction.user.id === data.creatorId) {
                    const ev = db.getEvent(targetMsgId);
                    if (ev) {
                        const adminUrl = `${BASE}/admin?event=${targetMsgId}&token=${ev.adminToken}`;
                        return await interaction.reply({
                            content: `🛠️ **내전 관리자 페이지** (방장 전용):\n${adminUrl}`,
                            ephemeral: true
                        });
                    }
                    return await interaction.reply({ content: '관리자 페이지를 불러올 수 없어요.', ephemeral: true });
                }
                // 이미 신청한 경우 → 취소
                const existing = db.getByDiscordId(targetMsgId, interaction.user.id);
                if (existing) {
                    db.deleteByDiscordId(targetMsgId, interaction.user.id);
                    return await interaction.reply({ content: '✅ 참가가 취소됐어요.', ephemeral: true });
                }
                // 미신청 → 웹 폼 링크 제공
                const webUrl = `${BASE}/join?event=${targetMsgId}&discord_id=${interaction.user.id}`;
                return await interaction.reply({
                    content: `아래 링크에서 참가 신청해주세요!\n${webUrl}`,
                    ephemeral: true
                });
            }

            // ── 구인 / 론울프: 기존 Discord 방식 ──
            await interaction.deferUpdate();
            if (action === 'join') {
                if (data.participants.length < data.maxPlayers && !data.participants.includes(interaction.user.id)) {
                    data.participants.push(interaction.user.id);
                    const creator = await client.users.fetch(data.creatorId);
                    creator.send(`🔔 **${interaction.user.username}**님이 참가했습니다! (${data.participants.length}/${data.maxPlayers})`).catch(() => null);
                    if (data.participants.length === data.maxPlayers) {
                        creator.send(`✅ 인원이 모두 찼습니다! (${data.maxPlayers}/${data.maxPlayers})`).catch(() => null);
                    }
                }
            } else {
                if (interaction.user.id === data.creatorId) {
                    allRecruits.delete(targetMsgId);
                    activeUserRecruits.delete(data.creatorId);
                    saveData();
                    return await interaction.message.delete().catch(() => null);
                }
                data.participants = data.participants.filter(id => id !== interaction.user.id);
                data.teams = (data.teams || []).map(team => team.filter(id => id !== interaction.user.id));
                data.team1 = data.team1.filter(id => id !== interaction.user.id);
                data.team2 = data.team2.filter(id => id !== interaction.user.id);
            }
            saveData();
            await interaction.message.edit({ embeds: [await createRecruitEmbed(data)] });
        }
    }

    // ──────────────────────────────────────────────
    // 셀렉트 메뉴 인터랙션
    // ──────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
        const [action, targetMsgId] = interaction.customId.split('_');
        const data = allRecruits.get(targetMsgId);
        if (!data) return;

        // 관리 메뉴 라우터
        if (action === 'selectManage') {
            if (interaction.user.id !== data.creatorId) return await interaction.update({ content: '방장만 가능합니다.', components: [] });
            const selected = interaction.values[0];

            if (selected === 'adminPage') {
                const ev = db.getEvent(targetMsgId);
                if (!ev) return await interaction.update({ content: '⚠️ 관리자 페이지 정보를 찾을 수 없어요.', components: [] });
                const BASE = process.env.WEB_URL || 'http://localhost:3000';
                const adminUrl = `${BASE}/admin?event=${targetMsgId}&token=${ev.adminToken}`;
                return await interaction.update({ content: `🛠️ **웹 관리자 페이지** (방장 전용):\n${adminUrl}`, components: [] });
            }
            else if (selected === 'manual') {
                const options = await Promise.all(data.participants.map(async id => {
                    const u = await client.users.fetch(id);
                    return { label: u.username, value: id };
                }));
                const menu = new StringSelectMenuBuilder()
                    .setCustomId(`setTeamManual_${targetMsgId}`)
                    .setPlaceholder('1팀에 넣을 멤버를 선택하세요')
                    .setMinValues(1).setMaxValues(Math.min(options.length, 25))
                    .addOptions(options);
                return await interaction.update({ content: '🟦 **1팀** 멤버를 골라주세요. 나머지는 자동으로 2팀에 배정됩니다.', components: [new ActionRowBuilder().addComponents(menu)] });
            }
            else if (selected === 'kick') {
                const others = data.participants.filter(id => id !== data.creatorId);
                if (others.length === 0) return await interaction.update({ content: '킥할 참가자가 없습니다.', components: [] });
                const options = await Promise.all(others.map(async id => {
                    const u = await client.users.fetch(id);
                    return { label: u.username, value: id };
                }));
                const menu = new StringSelectMenuBuilder()
                    .setCustomId(`selectKick_${targetMsgId}`)
                    .setPlaceholder('제외할 참가자를 선택하세요')
                    .setMinValues(1).setMaxValues(Math.min(options.length, 25))
                    .addOptions(options);
                return await interaction.update({ content: '👢 제외할 참가자를 선택하세요.', components: [new ActionRowBuilder().addComponents(menu)] });
            }
            else if (selected === 'transfer') {
                const others = data.participants.filter(id => id !== data.creatorId);
                if (others.length === 0) return await interaction.update({ content: '양도할 사람이 없습니다.', components: [] });
                const menu = new StringSelectMenuBuilder()
                    .setCustomId(`selectTransfer_${targetMsgId}`)
                    .setPlaceholder('새 방장 선택')
                    .addOptions(await Promise.all(others.map(async id => {
                        const u = await client.users.fetch(id);
                        return { label: u.username, value: id };
                    })));
                return await interaction.update({ content: '누구에게 양도할까요?', components: [new ActionRowBuilder().addComponents(menu)] });
            }
            else if (selected === 'move') {
                const member = await interaction.guild.members.fetch(interaction.user.id);
                if (!member.voice.channel) return await interaction.update({ content: '음성 채널에 먼저 접속해주세요.', components: [] });
                data.originalVoiceChannelId = member.voice.channelId;
                const teamCount = data.teamCount || 2;
                moveProgress.set(targetMsgId, { step: 0, teamChannels: [], teamCount });
                const voiceChannels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).map(c => ({ label: c.name, value: c.id })).slice(0, 25);
                const menu = new StringSelectMenuBuilder().setCustomId(`selectMoveTeam_${targetMsgId}`).setPlaceholder(`${TEAM_EMOJIS[0]} ${TEAM_NAMES[0]} 이동 채널 선택`).addOptions(voiceChannels);
                return await interaction.update({ content: `${TEAM_EMOJIS[0]} **${TEAM_NAMES[0]}**이 갈 채널을 골라주세요. (1/${teamCount})`, components: [new ActionRowBuilder().addComponents(menu)] });
            }
            else if (selected === 'return') {
                if (!data.originalVoiceChannelId) return await interaction.update({ content: '기록이 없습니다.', components: [] });
                for (const id of data.participants) {
                    const m = await interaction.guild.members.fetch(id).catch(() => null);
                    if (m?.voice.channel) await m.voice.setChannel(data.originalVoiceChannelId).catch(() => null);
                }
                return await interaction.update({ content: '✅ 모두 원래 채널로 복구했어요!', components: [] });
            }
            else if (selected === 'changeMap') {
                const choices = [
                    { label: '🏝️ 루미아 섬 (내전)', value: '루미아 섬' },
                    { label: '🌊 코발트 (내전 4vs4)', value: '코발트' },
                    { label: '🐺 론울프 (개인전)', value: '론울프' },
                ].filter(c => !(data.gameType === '론울프' && c.value === '론울프')
                           && !(data.gameType === '내전' && data.mapType === '루미아 섬' && c.value === '루미아 섬')
                           && !(data.gameType === '내전' && data.mapType === '코발트' && c.value === '코발트'));
                const menu = new StringSelectMenuBuilder()
                    .setCustomId(`selectChangeMap_${targetMsgId}`)
                    .setPlaceholder('변경할 맵을 선택하세요')
                    .addOptions(choices);
                return await interaction.update({ content: `현재: **${data.gameType} / ${data.mapType}**\n변경할 맵을 선택해주세요. 인원은 그대로 유지됩니다.`, components: [new ActionRowBuilder().addComponents(menu)] });
            }
            return;
        }
        // 수동 팀 배정
        if (action === 'setTeamManual') {
            const teamCount = data.teamCount || 2;
            data.teams    = Array.from({ length: teamCount }, () => []);
            data.teams[0] = interaction.values;
            data.teams[1] = data.participants.filter(id => !data.teams[0].includes(id));
            data.team1    = data.teams[0];
            data.team2    = data.teams[1];
            saveData();
            const targetMsg = await interaction.channel.messages.fetch(targetMsgId).catch(() => null);
            if (targetMsg) await targetMsg.edit({ embeds: [await createRecruitEmbed(data)] });
            return await interaction.update({ content: '✅ 팀 설정 완료!', components: [] });
        }
        // 킥 확정
        else if (action === 'selectKick') {
            const kickIds = interaction.values;
            data.participants = data.participants.filter(id => !kickIds.includes(id));
            data.teams = (data.teams || []).map(team => team.filter(id => !kickIds.includes(id)));
            data.team1 = data.team1.filter(id => !kickIds.includes(id));
            data.team2 = data.team2.filter(id => !kickIds.includes(id));
            saveData();
            for (const id of kickIds) {
                const u = await client.users.fetch(id).catch(() => null);
                if (u) u.send('👢 방장에 의해 구인에서 제외됐어요.').catch(() => null);
            }
            const targetMsg = await interaction.channel.messages.fetch(targetMsgId).catch(() => null);
            if (targetMsg) await targetMsg.edit({ embeds: [await createRecruitEmbed(data)] });
            const kickNames = await Promise.all(kickIds.map(async id => {
                const u = await client.users.fetch(id).catch(() => null);
                return u?.username || id;
            }));
            return await interaction.update({ content: `✅ ${kickNames.join(', ')}님을 제외했어요.`, components: [] });
        }
        // 맵 변경 확정
        else if (action === 'selectChangeMap') {
            const selected = interaction.values[0];
            if (selected === '루미아 섬') {
                data.gameType  = '내전';
                data.mapType   = '루미아 섬';
            } else if (selected === '코발트') {
                data.gameType  = '내전';
                data.mapType   = '코발트';
                if (data.maxPlayers > 8) data.maxPlayers = 8;
                data.teamCount = 2;
                data.teams     = [[], []];
            } else if (selected === '론울프') {
                data.gameType  = '론울프';
                data.mapType   = '루미아 섬';
                if (data.maxPlayers > 18) data.maxPlayers = 18;
                data.teamCount = data.maxPlayers;
                data.teams     = Array.from({ length: data.teamCount }, () => []);
            }
            saveData();

            // 변경된 gameType에 맞게 버튼도 업데이트
            let newRows;
            if (data.gameType === '내전') {
                newRows = [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`join_${targetMsgId}`).setLabel('참가/취소').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`shuffle_${targetMsgId}`).setLabel('팀 섞기(자동)').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`manage_${targetMsgId}`).setLabel('⚙️ 관리').setStyle(ButtonStyle.Secondary)
                    )
                ];
            } else if (data.gameType === '론울프') {
                newRows = [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`join_${targetMsgId}`).setLabel('참가').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`leave_${targetMsgId}`).setLabel('취소').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`charRandom_${targetMsgId}`).setLabel('실험체 랜덤').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`manage_${targetMsgId}`).setLabel('⚙️ 관리').setStyle(ButtonStyle.Secondary)
                    )
                ];
            }

            const targetMsg = await interaction.channel.messages.fetch(targetMsgId).catch(() => null);
            if (targetMsg) await targetMsg.edit({ embeds: [await createRecruitEmbed(data)], components: newRows });
            return await interaction.update({ content: `✅ **${data.gameType} / ${data.mapType}**으로 변경됐어요!`, components: [] });
        }
        // 방장 양도
        else if (action === 'selectTransfer') {
            activeUserRecruits.delete(data.creatorId);
            data.creatorId = interaction.values[0];
            activeUserRecruits.set(data.creatorId, targetMsgId);
            saveData();
            const targetMsg = await interaction.channel.messages.fetch(targetMsgId).catch(() => null);
            if (targetMsg) await targetMsg.edit({ embeds: [await createRecruitEmbed(data)] });
            return await interaction.update({ content: '👑 방장이 양도되었습니다.', components: [] });
        }
        // 팀별 방 이동
        else if (action === 'selectMoveTeam') {
            const progress = moveProgress.get(targetMsgId);
            if (!progress) return await interaction.update({ content: '⚠️ 다시 시도해주세요.', components: [] });
            progress.teamChannels.push(interaction.values[0]);
            progress.step++;
            if (progress.step < progress.teamCount) {
                const voiceChannels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).map(c => ({ label: c.name, value: c.id })).slice(0, 25);
                const menu = new StringSelectMenuBuilder().setCustomId(`selectMoveTeam_${targetMsgId}`).setPlaceholder(`${TEAM_EMOJIS[progress.step]} ${TEAM_NAMES[progress.step]} 이동 채널 선택`).addOptions(voiceChannels);
                return await interaction.update({ content: `${TEAM_EMOJIS[progress.step]} **${TEAM_NAMES[progress.step]}**이 갈 채널을 골라주세요. (${progress.step + 1}/${progress.teamCount})`, components: [new ActionRowBuilder().addComponents(menu)] });
            }
            const teams = data.teams || [data.team1, data.team2];
            for (let i = 0; i < progress.teamCount; i++) {
                for (const id of (teams[i] || [])) {
                    const m = await interaction.guild.members.fetch(id).catch(() => null);
                    if (m?.voice.channel) await m.voice.setChannel(progress.teamChannels[i]).catch(() => null);
                }
            }
            moveProgress.delete(targetMsgId);
            return await interaction.update({ content: '🚀 모든 팀 이동 완료!', components: [] });
        }
    }
});

client.login(process.env.TOKEN);
