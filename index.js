const {
    Client, GatewayIntentBits, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    Events, StringSelectMenuBuilder, ChannelType
} = require('discord.js');
const fs   = require('fs');
const cron = require('node-cron');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers
    ]
});

const DATA_PATH       = './recruits.json';
const MATCH_DATA_PATH = './matches.json';

let allRecruits        = new Map();
let activeUserRecruits = new Map();
let moveProgress       = new Map();
let pendingLumia       = new Map();
let matchHistory       = [];

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

function loadMatches() {
    try {
        if (fs.existsSync(MATCH_DATA_PATH)) {
            matchHistory = JSON.parse(fs.readFileSync(MATCH_DATA_PATH, 'utf-8'));
        }
    } catch (e) { console.error('매치 데이터 로드 실패:', e); }
}

function saveMatches() {
    try {
        fs.writeFileSync(MATCH_DATA_PATH, JSON.stringify(matchHistory, null, 2));
    } catch (e) { console.error('매치 데이터 저장 실패:', e); }
}

loadData();
loadMatches();

const TEAM_EMOJIS = ['🟦','🟥','🟩','🟨','🟪','🟧','⬜','🟫','🔵','🔴','🟢','🟡','🟠','⚪','🔶','🔷','🔸','🔹'];
const TEAM_NAMES  = ['1팀','2팀','3팀','4팀','5팀','6팀','7팀','8팀','9팀','10팀','11팀','12팀','13팀','14팀','15팀','16팀','17팀','18팀'];

const CHARACTERS = [
    'JP','가넷','나딘','나타폰','니아','니키','다니엘','다르코','데비','마를렌',
    '띠아','라우라','레녹스','레니','레온','로지','루크','르노어','리 다이린',
    '리오','마르티나','마이','마커스','매그너스','미르카','바냐','바바라',
    '버니스','블레어','비앙카','비형','샬럿','셀린','쇼우','쇼이치','수아',
    '스텔라','아디나','아비게일','아야','아이솔','아이린','아르다','알론소',
    '에스텔','엘레나','요한','유민','이렘','이리','일레븐','재키','제이크',
    '조이','준','카밀로','카셀','카티야','클로에','키아라','타지','테오도르',
    '티나','펜리르','펠릭스','프리야','피오라','하비','헤이즈','현우','혜진',
    '히스이','시셀라','야니코','알렉상드르','리베카','야도','에단','아드리안',
    '권술사','미마'
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

    let rows;
    if (gameType === '내전') {
        rows = [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`join_${msgId}`).setLabel('참가').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`leave_${msgId}`).setLabel('취소').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`shuffle_${msgId}`).setLabel('팀 섞기(자동)').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`charRandom_${msgId}`).setLabel('실험체 랜덤').setStyle(ButtonStyle.Success),
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

// MMR 조회
async function fetchMMR(userNum) {
    try {
        const res  = await fetch(`https://open-api.bser.io/v2/rank/user/${userNum}/0`, { headers: { 'x-api-key': process.env.ER_API_KEY } });
        const data = await res.json();
        if (data.code !== 200 || !data.ranks?.length) return null;
        const rank = data.ranks.find(r => r.matchingTeamMode === 3) || data.ranks[0];
        return rank?.mmr || null;
    } catch { return null; }
}

async function fetchUserNum(nickname) {
    try {
        const res  = await fetch(`https://open-api.bser.io/v1/user/nickname?query=${encodeURIComponent(nickname)}`, { headers: { 'x-api-key': process.env.ER_API_KEY } });
        const data = await res.json();
        return data.code === 200 ? data.user?.userNum : null;
    } catch { return null; }
}

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
            const 유형    = interaction.options.getString('유형');
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
                    if (teamCount > 18) return await interaction.reply({ content: '❌ 팀 수가 너무 많아요 (최대 18팀).', ephemeral: true });
                    return await createRecruit(interaction, {
                        gameType: '내전', mapType: '루미아 섬',
                        maxPlayers, teamCount, timeStr, duration
                    });
                }

                const teamCountUp   = Math.ceil(maxPlayers / perTeam);
                const teamCountDown = Math.floor(maxPlayers / perTeam);
                const leftover      = maxPlayers - teamCountDown * perTeam;
                const adjustedMax   = teamCountDown * perTeam;

                if (teamCountUp > 18) return await interaction.reply({ content: '❌ 팀 수가 너무 많아요 (최대 18팀).', ephemeral: true });

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
                        { name: '📊 팀 MMR 밸런스',   value: 'API 키 발급 후 자동 활성화\n팀 섞기 후 각 팀 평균 MMR 표시.' },
                        { name: '🏆 /내전결과',        value: 'API 키 발급 후 사용 가능\n내전 결과를 기록합니다.' },
                        { name: '🔍 /전적',            value: '/전적 [닉네임] 으로 이터널 리턴 전적을 확인합니다.' },
                        { name: '🃏 /추천실험체',      value: '/추천실험체 [닉네임] 으로 가장 많이 쓴 실험체 TOP3를 확인합니다.' },
                        { name: '🏆 /랭킹',            value: '서버 내 멤버들의 MMR 순위를 보여줍니다.\n※ 디스코드 닉네임 = 이터널 리턴 닉네임인 경우만 표시.' }
                    )],
                ephemeral: true
            });
        }

        // /전적
        if (interaction.commandName === '전적') {
            const nickname = interaction.options.getString('닉네임');
            await interaction.deferReply();
            try {
                const ER_API_KEY = process.env.ER_API_KEY;
                const BASE_URL   = 'https://open-api.bser.io';
                if (!ER_API_KEY) return await interaction.editReply({ content: '⚠️ API 키가 설정되지 않았어요.' });

                const userRes  = await fetch(`${BASE_URL}/v1/user/nickname?query=${encodeURIComponent(nickname)}`, { headers: { 'x-api-key': ER_API_KEY } });
                const userData = await userRes.json();
                if (userData.code !== 200 || !userData.user) return await interaction.editReply({ content: `❌ **${nickname}** 닉네임을 찾을 수 없어요.` });

                const { userNum, nickname: realNick } = userData.user;

                // 현재 시즌 ID 조회 (/v1/data/Season)
                let seasonId = 0;
                try {
                    const seasonRes  = await fetch(`${BASE_URL}/v1/data/Season`, { headers: { 'x-api-key': ER_API_KEY } });
                    const seasonData = await seasonRes.json();
                    const seasons = seasonData.data?.Season ?? seasonData.Season ?? [];
                    const current = seasons.find(s => s.isCurrent) ?? seasons.at(-1);
                    if (current?.seasonID) seasonId = current.seasonID;
                    console.log(`[전적] season raw:`, JSON.stringify(seasonData).slice(0, 300));
                } catch (e) { console.log('[전적] season fetch failed:', e.message); }

                // stats + 모드별 rank(1/2/3) 병렬 요청
                const [statsRes, rank1Res, rank2Res, rank3Res] = await Promise.all([
                    fetch(`${BASE_URL}/v1/user/stats/${userNum}/${seasonId}`,   { headers: { 'x-api-key': ER_API_KEY } }),
                    fetch(`${BASE_URL}/v1/rank/${userNum}/${seasonId}/1`,        { headers: { 'x-api-key': ER_API_KEY } }),
                    fetch(`${BASE_URL}/v1/rank/${userNum}/${seasonId}/2`,        { headers: { 'x-api-key': ER_API_KEY } }),
                    fetch(`${BASE_URL}/v1/rank/${userNum}/${seasonId}/3`,        { headers: { 'x-api-key': ER_API_KEY } }),
                ]);
                const [statsData, rank1Data, rank2Data, rank3Data] = await Promise.all([
                    statsRes.json(), rank1Res.json(), rank2Res.json(), rank3Res.json()
                ]);
                console.log(`[전적] ${realNick} seasonId=${seasonId} stats.code=${statsData.code} len=${statsData.userStats?.length ?? 'null'}`);
                console.log(`[전적] rank1 raw:`, JSON.stringify(rank1Data).slice(0, 200));
                if (statsData.code !== 200) console.log('[전적] stats raw:', JSON.stringify(statsData).slice(0, 300));

                // 모드별 rank 맵 구성 (응답 구조가 확인되면 정리 예정)
                const rankRaw = { 1: rank1Data, 2: rank2Data, 3: rank3Data };
                const rankMap = {};
                for (const [mode, rd] of Object.entries(rankRaw)) {
                    const entry = rd.userRank ?? rd.rank ?? (rd.userRanks ?? rd.ranks ?? [])[0];
                    if (entry?.mmr) rankMap[mode] = entry;
                }

                const modeNames = { 1: '솔로', 2: '듀오', 3: '스쿼드' };
                const modeEmoji = { 1: '🟣', 2: '🟢', 3: '🟡' };

                const embed = new EmbedBuilder()
                    .setTitle(`🔍 ${realNick}의 이터널 리턴 전적`)
                    .setColor(0x00AE86)
                    .setURL(`https://er.dakgg.io/player/${encodeURIComponent(realNick)}`)
                    .setTimestamp()
                    .setFooter({ text: 'Eternal Return Open API' });

                if (statsData.code === 200 && statsData.userStats?.length) {
                    for (const stat of statsData.userStats) {
                        const games = stat.totalGames || 0;
                        if (games === 0) continue;
                        const mode  = modeNames[stat.matchingTeamMode] || `모드${stat.matchingTeamMode}`;
                        const emoji = modeEmoji[stat.matchingTeamMode] || '⚪';
                        const wins  = stat.totalWins || 0;
                        const top3  = stat.top3      || 0;
                        const winRate   = ((wins / games) * 100).toFixed(1);
                        const top3Rate  = ((top3 / games) * 100).toFixed(1);
                        const avgKills  = (stat.totalKills / games).toFixed(2);
                        const avgDamage = Math.round((stat.damageToPlayer || 0) / games).toLocaleString();
                        let rankInfo = '';
                        const r = rankMap[stat.matchingTeamMode];
                        if (r?.mmr) rankInfo = `\n🏅 MMR: **${r.mmr}** | 랭킹: **${r.rank ?? '?'}위**`;
                        embed.addFields({
                            name: `${emoji} ${mode}`,
                            value: `📊 **${games}판** | 🥇 ${wins}승 (${winRate}%) | 🏆 TOP3: ${top3}회 (${top3Rate}%)\n⚔️ 평균 킬: **${avgKills}** | 💥 평균 딜량: **${avgDamage}**${rankInfo}`,
                            inline: false
                        });
                    }
                }

                // 전적 없지만 랭크 데이터는 있으면 MMR만 표시
                if (!embed.data.fields?.length && Object.keys(rankMap).length) {
                    for (const [modeKey, r] of Object.entries(rankMap)) {
                        const mode  = modeNames[modeKey] || `모드${modeKey}`;
                        const emoji = modeEmoji[modeKey] || '⚪';
                        embed.addFields({
                            name: `${emoji} ${mode}`,
                            value: `🏅 MMR: **${r.mmr}** | 랭킹: **${r.rank ?? '?'}위**\n📊 이번 시즌 상세 전적 없음`,
                            inline: false
                        });
                    }
                }

                if (!embed.data.fields?.length) return await interaction.editReply({ content: `📭 **${realNick}**님의 전적 데이터가 없어요.` });
                await interaction.editReply({ embeds: [embed] });
            } catch (err) {
                console.error('전적 조회 오류:', err);
                await interaction.editReply({ content: '⚠️ 전적 조회 중 오류가 발생했어요.' });
            }
        }

        // /내전결과
        // /추천실험체
        if (interaction.commandName === '추천실험체') {
            const nickname = interaction.options.getString('닉네임');
            const modeFilter = interaction.options.getString('모드') ? parseInt(interaction.options.getString('모드')) : null;
            await interaction.deferReply();

            try {
                const ER_API_KEY = process.env.ER_API_KEY;
                const BASE_URL   = 'https://open-api.bser.io';
                if (!ER_API_KEY) return await interaction.editReply({ content: '⚠️ API 키가 설정되지 않았어요.' });

                const userRes  = await fetch(`${BASE_URL}/v1/user/nickname?query=${encodeURIComponent(nickname)}`, { headers: { 'x-api-key': ER_API_KEY } });
                const userData = await userRes.json();
                if (userData.code !== 200 || !userData.user) return await interaction.editReply({ content: `❌ **${nickname}** 닉네임을 찾을 수 없어요.` });

                const { userNum, nickname: realNick } = userData.user;

                const statsRes  = await fetch(`${BASE_URL}/v1/user/stats/${userNum}/0`, { headers: { 'x-api-key': ER_API_KEY } });
                const statsData = await statsRes.json();
                if (statsData.code !== 200 || !statsData.userStats?.length) return await interaction.editReply({ content: `📭 **${realNick}**님의 데이터가 없어요.` });

                const modeNames = { 1: '솔로', 2: '듀오', 3: '스쿼드' };

                // 모드 필터링 후 characterStats 합산
                const charUsageMap = new Map();
                for (const stat of statsData.userStats) {
                    if (modeFilter && stat.matchingTeamMode !== modeFilter) continue;
                    for (const cs of (stat.characterStats || [])) {
                        const prev = charUsageMap.get(cs.characterCode) || { usages: 0, wins: 0, top3: 0, games: 0 };
                        charUsageMap.set(cs.characterCode, {
                            usages: prev.usages + (cs.usages || cs.totalGames || 0),
                            wins:   prev.wins   + (cs.wins   || 0),
                            top3:   prev.top3   + (cs.top3   || 0),
                            games:  prev.games  + (cs.totalGames || cs.usages || 0)
                        });
                    }
                }

                if (charUsageMap.size === 0) return await interaction.editReply({ content: `📭 **${realNick}**님의 실험체 데이터가 없어요.` });

                // 사용 횟수 기준 정렬 후 TOP3
                const sorted = [...charUsageMap.entries()].sort((a, b) => b[1].usages - a[1].usages).slice(0, 3);

                const modeStr = modeFilter ? modeNames[modeFilter] : '전체';
                const embed = new EmbedBuilder()
                    .setTitle(`🃏 ${realNick}의 추천 실험체 TOP3 (${modeStr})`)
                    .setColor(0x9B59B6)
                    .setURL(`https://er.dakgg.io/player/${encodeURIComponent(realNick)}`)
                    .setTimestamp();

                const medals = ['🥇', '🥈', '🥉'];
                sorted.forEach(([code, s], i) => {
                    const name     = getCharName(code);
                    const winRate  = s.games > 0 ? ((s.wins / s.games) * 100).toFixed(1) : '0.0';
                    const top3Rate = s.games > 0 ? ((s.top3 / s.games) * 100).toFixed(1) : '0.0';
                    embed.addFields({
                        name:  `${medals[i]} ${name}`,
                        value: `📊 **${s.usages}판** | 🥇 승률 ${winRate}% | 🏆 TOP3 ${top3Rate}%`,
                        inline: false
                    });
                });

                await interaction.editReply({ embeds: [embed] });
            } catch (err) {
                console.error('추천실험체 오류:', err);
                await interaction.editReply({ content: '⚠️ 조회 중 오류가 발생했어요.' });
            }
        }

        // /랭킹 (서버 내 유저 MMR 순위)
        if (interaction.commandName === '랭킹') {
            const modeOption = interaction.options.getString('모드') ?? '3';
            const teamMode   = parseInt(modeOption);
            const modeNames  = { 1: '솔로', 2: '듀오', 3: '스쿼드' };
            await interaction.deferReply();

            try {
                const ER_API_KEY = process.env.ER_API_KEY;
                const BASE_URL   = 'https://open-api.bser.io';
                if (!ER_API_KEY) return await interaction.editReply({ content: '⚠️ API 키가 설정되지 않았어요.' });

                // 서버 멤버 전체 순회하며 MMR 조회
                const guild   = interaction.guild;
                const members = await guild.members.fetch();
                const results = [];

                await interaction.editReply({ content: `🔍 서버 멤버 MMR 조회 중... (시간이 걸릴 수 있어요)` });

                for (const [, member] of members) {
                    if (member.user.bot) continue;
                    const uname = member.user.username;

                    // 닉네임으로 userNum 조회
                    const userRes = await fetch(`${BASE_URL}/v1/user/nickname?query=${encodeURIComponent(uname)}`, { headers: { 'x-api-key': ER_API_KEY } }).catch(() => null);
                    if (!userRes) continue;
                    const userData = await userRes.json().catch(() => null);
                    if (!userData || userData.code !== 200 || !userData.user) continue;

                    const userNum = userData.user.userNum;
                    const realNick = userData.user.nickname;

                    // MMR 조회
                    const rankRes = await fetch(`${BASE_URL}/v2/rank/user/${userNum}/0`, { headers: { 'x-api-key': ER_API_KEY } }).catch(() => null);
                    if (!rankRes) continue;
                    const rankData = await rankRes.json().catch(() => null);
                    if (!rankData || rankData.code !== 200 || !rankData.ranks?.length) continue;

                    const modeRank = rankData.ranks.find(r => r.matchingTeamMode === teamMode);
                    if (!modeRank?.mmr) continue;

                    results.push({ nickname: realNick, mmr: modeRank.mmr, rank: modeRank.rank });

                    // API 속도 제한 방지
                    await new Promise(r => setTimeout(r, 600));
                }

                if (results.length === 0) {
                    return await interaction.editReply({ content: `📭 이터널 리턴 계정과 연결된 서버 멤버를 찾지 못했어요.
디스코드 닉네임과 이터널 리턴 닉네임이 같아야 조회돼요.` });
                }

                // MMR 높은 순 정렬
                results.sort((a, b) => b.mmr - a.mmr);

                const medals = ['🥇', '🥈', '🥉'];
                const lines  = results.map((r, i) => {
                    const medal = medals[i] || `**${i + 1}.**`;
                    return `${medal} **${r.nickname}** — MMR: ${r.mmr} (랭킹 ${r.rank ?? '?'}위)`;
                });

                const embed = new EmbedBuilder()
                    .setTitle(`🏆 서버 MMR 랭킹 (${modeNames[teamMode]})`)
                    .setColor(0xFFD700)
                    .setDescription(lines.join('\n'))
                    .setTimestamp()
                    .setFooter({ text: '디스코드 닉네임 = 이터널 리턴 닉네임인 유저만 표시됩니다.' });

                await interaction.editReply({ content: null, embeds: [embed] });
            } catch (err) {
                console.error('랭킹 오류:', err);
                await interaction.editReply({ content: '⚠️ 랭킹 조회 중 오류가 발생했어요.' });
            }
        }

        if (interaction.commandName === '내전결과') {
            if (!process.env.ER_API_KEY) return await interaction.reply({ content: '⚠️ API 키가 설정되지 않았어요.', ephemeral: true });
            const msgId = activeUserRecruits.get(interaction.user.id);
            const data  = msgId ? allRecruits.get(msgId) : null;
            if (!data || (data.gameType !== '내전' && data.gameType !== '론울프')) return await interaction.reply({ content: '❌ 진행 중인 내전이 없어요.', ephemeral: true });
            if (data.creatorId !== interaction.user.id) return await interaction.reply({ content: '❌ 방장만 결과를 입력할 수 있어요.', ephemeral: true });

            const winTeamIdx = interaction.options.getInteger('승팀') - 1;
            const teams      = data.teams || [data.team1, data.team2];
            if (winTeamIdx >= teams.length || !teams[winTeamIdx]?.length) return await interaction.reply({ content: `❌ ${winTeamIdx + 1}팀이 존재하지 않아요.`, ephemeral: true });

            await interaction.deferReply();
            const teamNicknames = await Promise.all(teams.map(async team =>
                await Promise.all(team.map(async id => {
                    const u = await client.users.fetch(id).catch(() => null);
                    return u?.username || id;
                }))
            ));

            matchHistory.push({ date: new Date().toISOString(), gameType: data.gameType, mapType: data.mapType, teams: teamNicknames, winTeam: winTeamIdx, creatorId: data.creatorId });
            saveMatches();

            const embed = new EmbedBuilder()
                .setTitle(`🏆 내전 결과 기록 [${data.gameType} / ${data.mapType}]`)
                .setColor(0xFFD700)
                .setTimestamp();

            teams.forEach((_, i) => {
                embed.addFields({ name: `${TEAM_EMOJIS[i]} ${TEAM_NAMES[i]} ${i === winTeamIdx ? '🏆 승리' : '패배'}`, value: teamNicknames[i].join(', ') || '없음', inline: false });
            });
            embed.setFooter({ text: `총 ${matchHistory.length}번째 내전 기록` });
            await interaction.editReply({ embeds: [embed] });
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
            const shuffled  = [...data.participants].sort(() => Math.random() - 0.5);
            data.teams = Array.from({ length: teamCount }, () => []);
            shuffled.forEach((id, i) => data.teams[i % teamCount].push(id));
            data.team1 = data.teams[0] || [];
            data.team2 = data.teams[1] || [];
            saveData();
            await interaction.deferUpdate();

            // 임베드 업데이트
            await interaction.message.edit({ embeds: [await createRecruitEmbed(data)] }).catch(() => null);

            if (process.env.ER_API_KEY) {
                try {
                    const teamMMRs = await Promise.all(data.teams.map(async team => {
                        const mmrs = await Promise.all(team.map(async id => {
                            const u = await client.users.fetch(id).catch(() => null);
                            if (!u) return null;
                            const userNum = await fetchUserNum(u.username);
                            if (!userNum) return null;
                            return await fetchMMR(userNum);
                        }));
                        const valid = mmrs.filter(m => m !== null);
                        return valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null;
                    }));
                    if (teamMMRs.some(m => m !== null)) {
                        const embed = new EmbedBuilder().setTitle('📊 팀 MMR 밸런스').setColor(0x00AE86);
                        teamMMRs.forEach((mmr, i) => embed.addFields({ name: `${TEAM_EMOJIS[i]} ${TEAM_NAMES[i]}`, value: mmr ? `평균 MMR: **${mmr}**` : '정보 없음', inline: true }));
                        await interaction.followUp({ embeds: [embed], ephemeral: true });
                    }
                } catch (e) { console.error('MMR 조회 오류:', e); }
            }
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
                    { label: '참가자 킥',     value: 'kick',      description: '참가자를 제외합니다' },
                    { label: '방장 양도',     value: 'transfer',  description: '방장 권한을 양도합니다' },
                    { label: '방 이동',       value: 'move',      description: '팀별로 음성 채널을 이동합니다' },
                    { label: '원래대로',      value: 'return',    description: '모든 참가자를 원래 채널로 복구합니다' },
                    { label: '맵 변경',       value: 'changeMap', description: '맵/모드를 변경합니다' },
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
        // 참가 / 취소
        else if (action === 'join' || action === 'leave') {
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

            if (selected === 'manual') {
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
                        new ButtonBuilder().setCustomId(`join_${targetMsgId}`).setLabel('참가').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`leave_${targetMsgId}`).setLabel('취소').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`shuffle_${targetMsgId}`).setLabel('팀 섞기(자동)').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`charRandom_${targetMsgId}`).setLabel('실험체 랜덤').setStyle(ButtonStyle.Success),
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
