const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, StringSelectMenuBuilder } = require('discord.js');
const fs = require('fs');
require('dotenv').config();

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers] 
});

const DATA_PATH = './recruits.json';
let allRecruits = new Map();
let activeUserRecruits = new Map();

// 데이터 로드/저장
function loadData() {
    try {
        if (fs.existsSync(DATA_PATH)) {
            const fileData = fs.readFileSync(DATA_PATH, 'utf-8');
            const parsed = JSON.parse(fileData);
            allRecruits = new Map(Object.entries(parsed.allRecruits));
            activeUserRecruits = new Map(Object.entries(parsed.activeUserRecruits));
            console.log('✅ 데이터를 불러왔습니다.');
        }
    } catch (e) { console.error('데이터 로드 실패:', e); }
}

function saveData() {
    try {
        const data = {
            allRecruits: Object.fromEntries(allRecruits),
            activeUserRecruits: Object.fromEntries(activeUserRecruits)
        };
        fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    } catch (e) { console.error('데이터 저장 실패:', e); }
}

loadData();

function calculateDeleteDelay(startTimeStr, durationHours) {
    const now = new Date();
    let targetTime = new Date(now);
    const timeMatches = startTimeStr.match(/\d+/g);
    if (timeMatches && timeMatches.length >= 1) {
        let hours = parseInt(timeMatches[0]);
        let minutes = timeMatches[1] ? parseInt(timeMatches[1]) : 0;
        if ((startTimeStr.includes('오후') || startTimeStr.includes('저녁') || startTimeStr.includes('밤')) && hours < 12) hours += 12;
        targetTime.setHours(hours, minutes, 0, 0);
        if (targetTime < now) targetTime.setDate(now.getDate() + 1);
    } else { targetTime = now; }
    return (targetTime.getTime() + (durationHours * 60 * 60 * 1000)) - now.getTime();
}

function createRecruitEmbed(data) {
    const list = data.participants.filter(id => !data.fixedTeam1.includes(id) && !data.fixedTeam2.includes(id))
                 .map(id => `<@${id}>`).join('\n') || '없음';
    const colors = { '일반': 0x00FF00, '랭크': 0x5865F2, '내전': 0xFF0000 };
    
    const embed = new EmbedBuilder()
        .setTitle(`🎮 [${data.gameType} / ${data.mapType}] 구인 중`)
        .addFields(
            { name: '⏰ 시작 시간', value: data.time, inline: true },
            { name: '👥 인원', value: `${data.participants.length} / ${data.maxPlayers}`, inline: true },
            { name: '👑 모집자', value: `<@${data.creatorId}>`, inline: true },
            { name: '📝 대기 명단', value: list }
        )
        .setDescription(`**${data.time}** 기준 ${data.durationHours}시간 뒤 자동 삭제됩니다.`)
        .setColor(colors[data.gameType] || 0x000000);

    const t1Display = data.team1.map(id => data.fixedTeam1.includes(id) ? `<@${id}> 📌` : `<@${id}>`).join('\n') || '비어있음';
    const t2Display = data.team2.map(id => data.fixedTeam2.includes(id) ? `<@${id}> 📌` : `<@${id}>`).join('\n') || '비어있음';

    embed.addFields(
        { name: '🟦 1팀', value: t1Display, inline: true },
        { name: '🟥 2팀', value: t2Display, inline: true }
    );
    return embed;
}

client.on(Events.InteractionCreate, async interaction => {
    // 1. 명령어 처리
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === '구인') {
            let gameType = interaction.options.getString('유형');
            let map = interaction.options.getString('맵');
            const timeStr = interaction.options.getString('시간') || '즉시';
            const duration = interaction.options.getInteger('종료시간') || 4;
            if (gameType === '랭크') map = '루미아 섬';

            const user = interaction.user;
            if (activeUserRecruits.has(user.id)) {
                const oldMsgId = activeUserRecruits.get(user.id);
                const oldMsg = await interaction.channel.messages.fetch(oldMsgId).catch(() => null);
                if (oldMsg) await oldMsg.delete().catch(() => null);
            }

            const maxPlayers = (gameType === '내전') ? 8 : (map === '코발트' ? 4 : 3);
            const newRecruit = { 
                creatorId: user.id, participants: [user.id], gameType, mapType: map, 
                time: timeStr, durationHours: duration, maxPlayers, team1: [], team2: [], fixedTeam1: [], fixedTeam2: [] 
            };

            const response = await interaction.reply({ 
                embeds: [createRecruitEmbed(newRecruit)],
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('join_temp').setLabel('참가').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('fix1_temp').setLabel('1팀 고정').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId('fix2_temp').setLabel('2팀 고정').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId('leave_temp').setLabel('취소').setStyle(ButtonStyle.Danger)
                    )
                ],
                withResponse: true 
            });

            const msgId = response.resource.message.id;
            allRecruits.set(msgId, newRecruit);
            activeUserRecruits.set(user.id, msgId);
            saveData();

            const rows = [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`join_${msgId}`).setLabel('참가').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`fix1_${msgId}`).setLabel('1팀 고정').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`fix2_${msgId}`).setLabel('2팀 고정').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`leave_${msgId}`).setLabel('취소').setStyle(ButtonStyle.Danger)
                ),
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`shuffle_${msgId}`).setLabel('팀 섞기').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`transfer_${msgId}`).setLabel('방장 양도').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`return_${msgId}`).setLabel('원래대로').setStyle(ButtonStyle.Secondary)
                )
            ];

            await interaction.editReply({ components: rows });

            setTimeout(async () => {
                if (allRecruits.has(msgId)) {
                    const targetMsg = await interaction.channel.messages.fetch(msgId).catch(() => null);
                    if (targetMsg) await targetMsg.delete().catch(() => null);
                    allRecruits.delete(msgId);
                    activeUserRecruits.delete(newRecruit.creatorId);
                    saveData();
                }
            }, calculateDeleteDelay(timeStr, duration));
        }

        if (interaction.commandName === '사용법') {
            const helpEmbed = new EmbedBuilder()
                .setTitle('📖 나쟈 봇 구인 가이드')
                .setColor(0x00AE86)
                .addFields(
                    { name: '🚀 시작', value: '`/구인` 명령어로 파티 모집을 시작합니다.' },
                    { name: '📌 팀 고정', value: '`1팀 고정` 혹은 `2팀 고정` 버튼을 누르면 팀 섞기 시 해당 자리에 고정됩니다 (📌 표시).' },
                    { name: '🎲 팀 섞기', value: '모집자가 고정 인원을 제외한 나머지 대기 명단을 랜덤으로 배정합니다.' },
                    { name: '👑 방장 양도', value: '`방장 양도` 버튼을 눌러 다른 참가자에게 모집자 권한을 넘길 수 있습니다.' },
                    { name: '⏰ 자동 삭제', value: '입력하신 **시작 시간**을 기준으로 4시간(기본) 후에 구인글이 삭제됩니다.' },
                    { name: '🔔 알림', value: '참가자가 발생하면 모집자에게 DM 알림이 전송됩니다.' }
                );
            await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
        }
    }

    // 2. 버튼 처리
    if (interaction.isButton()) {
        const [action, targetMsgId] = interaction.customId.split('_');
        const data = allRecruits.get(targetMsgId);
        if (!data) return;

        if (action === 'transfer') {
            if (interaction.user.id !== data.creatorId) return await interaction.reply({ content: '방장만 양도할 수 있습니다.', ephemeral: true });
            const others = data.participants.filter(id => id !== data.creatorId);
            if (others.length === 0) return await interaction.reply({ content: '양도할 다른 참가자가 없습니다.', ephemeral: true });

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`selectTransfer_${targetMsgId}`)
                .setPlaceholder('새로운 방장을 선택하세요')
                .addOptions(await Promise.all(others.map(async id => {
                    const user = await client.users.fetch(id);
                    return { label: user.username, value: id };
                })));

            await interaction.reply({ content: '누구에게 양도할까요?', components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
            return;
        }

        await interaction.deferUpdate();

        if (action === 'join') {
            if (data.participants.length < data.maxPlayers && !data.participants.includes(interaction.user.id)) {
                data.participants.push(interaction.user.id);
                try {
                    const creator = await client.users.fetch(data.creatorId);
                    await creator.send(`🔔 **${interaction.user.username}**님이 참가했습니다!`);
                } catch (e) {}
            }
        } 
        else if (action === 'fix1' || action === 'fix2') {
            if (!data.participants.includes(interaction.user.id)) return;
            data.fixedTeam1 = data.fixedTeam1.filter(id => id !== interaction.user.id);
            data.fixedTeam2 = data.fixedTeam2.filter(id => id !== interaction.user.id);
            if (action === 'fix1') data.fixedTeam1.push(interaction.user.id);
            else data.fixedTeam2.push(interaction.user.id);
        }
        else if (action === 'leave') {
            if (interaction.user.id === data.creatorId) {
                allRecruits.delete(targetMsgId);
                activeUserRecruits.delete(data.creatorId);
                saveData();
                return await interaction.message.delete().catch(() => null);
            }
            data.participants = data.participants.filter(id => id !== interaction.user.id);
            data.fixedTeam1 = data.fixedTeam1.filter(id => id !== interaction.user.id);
            data.fixedTeam2 = data.fixedTeam2.filter(id => id !== interaction.user.id);
        }
        else if (action === 'shuffle') {
            if (interaction.user.id !== data.creatorId) return;
            const unfixed = data.participants.filter(id => !data.fixedTeam1.includes(id) && !data.fixedTeam2.includes(id));
            const shuffled = unfixed.sort(() => Math.random() - 0.5);
            data.team1 = [...data.fixedTeam1];
            data.team2 = [...data.fixedTeam2];
            shuffled.forEach(id => {
                if (data.team1.length <= data.team2.length && data.team1.length < (data.maxPlayers / 2)) data.team1.push(id);
                else data.team2.push(id);
            });
        }
        saveData();
        await interaction.message.edit({ embeds: [createRecruitEmbed(data)] });
    }

    // 3. 선택 메뉴 처리
    if (interaction.isStringSelectMenu()) {
        const [action, targetMsgId] = interaction.customId.split('_');
        const data = allRecruits.get(targetMsgId);
        if (!data || action !== 'selectTransfer') return;

        const newOwnerId = interaction.values[0];
        activeUserRecruits.delete(data.creatorId);
        data.creatorId = newOwnerId;
        activeUserRecruits.set(newOwnerId, targetMsgId);
        
        saveData();
        const targetMsg = await interaction.channel.messages.fetch(targetMsgId).catch(() => null);
        if (targetMsg) await targetMsg.edit({ embeds: [createRecruitEmbed(data)] });

        await interaction.update({ content: `<@${newOwnerId}>님에게 방장을 양도했습니다!`, components: [], ephemeral: true });
    }
});

client.login(process.env.TOKEN);