const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, StringSelectMenuBuilder, ChannelType } = require('discord.js');
const fs = require('fs');
require('dotenv').config();

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers] 
});

const DATA_PATH = './recruits.json';
let allRecruits = new Map();
let activeUserRecruits = new Map();

function loadData() {
    try {
        if (fs.existsSync(DATA_PATH)) {
            const fileData = fs.readFileSync(DATA_PATH, 'utf-8');
            const parsed = JSON.parse(fileData);
            allRecruits = new Map(Object.entries(parsed.allRecruits));
            activeUserRecruits = new Map(Object.entries(parsed.activeUserRecruits));
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

function createRecruitEmbed(data) {
    const participantsList = data.participants.map(id => `<@${id}>`).join(', ') || '없음';
    const colors = { '일반': 0x00FF00, '랭크': 0x5865F2, '내전': 0xFF0000 };
    
    const embed = new EmbedBuilder()
        .setTitle(`🎮 [${data.gameType} / ${data.mapType}] 구인 중`)
        .addFields(
            { name: '⏰ 시작 시간', value: data.time, inline: true },
            { name: '👥 인원', value: `${data.participants.length} / ${data.maxPlayers}`, inline: true },
            { name: '👑 모집자', value: `<@${data.creatorId}>`, inline: true },
            { name: '📝 전체 참가자', value: participantsList }
        )
        .setColor(colors[data.gameType] || 0x000000)
        .setTimestamp();

    const t1Display = data.team1.map(id => `<@${id}>`).join('\n') || '비어있음';
    const t2Display = data.team2.map(id => `<@${id}>`).join('\n') || '비어있음';

    embed.addFields(
        { name: '🟦 1팀', value: t1Display, inline: true },
        { name: '🟥 2팀', value: t2Display, inline: true }
    );
    return embed;
}

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === '구인') {
            const gameType = interaction.options.getString('유형');
            const map = interaction.options.getString('맵');
            const timeStr = interaction.options.getString('시간') || '즉시';
            const duration = interaction.options.getInteger('종료시간') || 4;

            const user = interaction.user;
            if (activeUserRecruits.has(user.id)) {
                const oldMsgId = activeUserRecruits.get(user.id);
                const oldMsg = await interaction.channel.messages.fetch(oldMsgId).catch(() => null);
                if (oldMsg) await oldMsg.delete().catch(() => null);
            }

            const maxPlayers = (gameType === '내전') ? 8 : (map === '코발트' ? 4 : 3);
            const newRecruit = { 
                creatorId: user.id, participants: [user.id], gameType, mapType: map, 
                time: timeStr, durationHours: duration, maxPlayers, team1: [], team2: [], 
                originalVoiceChannelId: null, team1TargetId: null 
            };

            const response = await interaction.reply({ 
                embeds: [createRecruitEmbed(newRecruit)],
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('join_temp').setLabel('참가').setStyle(ButtonStyle.Primary),
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
                    new ButtonBuilder().setCustomId(`leave_${msgId}`).setLabel('취소').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`shuffle_${msgId}`).setLabel('팀 섞기(자동)').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`manual_${msgId}`).setLabel('팀 설정(수동)').setStyle(ButtonStyle.Secondary)
                ),
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`transfer_${msgId}`).setLabel('방장 양도').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`move_${msgId}`).setLabel('방 이동').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`return_${msgId}`).setLabel('원래대로').setStyle(ButtonStyle.Secondary)
                )
            ];
            await interaction.editReply({ components: rows });
        }

        if (interaction.commandName === '사용법') {
            const helpEmbed = new EmbedBuilder()
                .setTitle('📖 나쟈 봇 구인 가이드')
                .setColor(0x00AE86)
                .addFields(
                    { name: '🎲 팀 섞기(자동)', value: '참가자들을 랜덤으로 1팀과 2팀에 배정합니다.' },
                    { name: '✍️ 팀 설정(수동)', value: '방장이 직접 1팀 멤버를 선택합니다. 나머지는 자동으로 2팀이 됩니다.' },
                    { name: '🔊 방 이동', value: '팀별로 이동할 음성 채널을 직접 선택하여 이동시킵니다.' }
                );
            await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
        }
    }

    if (interaction.isButton()) {
        const [action, targetMsgId] = interaction.customId.split('_');
        const data = allRecruits.get(targetMsgId);
        if (!data) return;

        // [자동] 팀 섞기
        if (action === 'shuffle') {
            if (interaction.user.id !== data.creatorId) return await interaction.reply({ content: '방장만 가능합니다.', ephemeral: true });
            const shuffled = [...data.participants].sort(() => Math.random() - 0.5);
            const mid = Math.ceil(shuffled.length / 2);
            data.team1 = shuffled.slice(0, mid);
            data.team2 = shuffled.slice(mid);
            await interaction.deferUpdate();
        } 
        // [수동] 팀 설정 메뉴 띄우기
        else if (action === 'manual') {
            if (interaction.user.id !== data.creatorId) return await interaction.reply({ content: '방장만 가능합니다.', ephemeral: true });
            const options = await Promise.all(data.participants.map(async id => {
                const user = await client.users.fetch(id);
                return { label: user.username, value: id };
            }));
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`setTeamManual_${targetMsgId}`)
                .setPlaceholder('1팀에 넣을 멤버를 선택하세요')
                .setMinValues(1)
                .setMaxValues(Math.min(options.length, 4))
                .addOptions(options);
            return await interaction.reply({ content: '🟦 **1팀** 멤버를 골라주세요.', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
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
                    const user = await client.users.fetch(id);
                    return { label: user.username, value: id };
                })));
            return await interaction.reply({ content: '누구에게 양도할까요?', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
        }
        // 방 이동 (이전 코드와 동일)
        else if (action === 'move') {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!member.voice.channel) return await interaction.reply({ content: '음성 채널에 먼저 접속해주세요.', ephemeral: true });
            data.originalVoiceChannelId = member.voice.channelId;
            const voiceChannels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice);
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`selectMove1_${targetMsgId}`)
                .setPlaceholder('1팀 이동 채널 선택')
                .addOptions(voiceChannels.map(c => ({ label: c.name, value: c.id })));
            return await interaction.reply({ content: '🟦 1팀이 갈 방을 골라주세요.', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
        }
        else if (action === 'return') {
            if (!data.originalVoiceChannelId) return await interaction.reply({ content: '기록이 없습니다.', ephemeral: true });
            for (const id of data.participants) {
                const m = await interaction.guild.members.fetch(id).catch(() => null);
                if (m && m.voice.channel) await m.voice.setChannel(data.originalVoiceChannelId);
            }
            return await interaction.reply({ content: '복구 완료!', ephemeral: true });
        }
        // 참가 / 취소
        else {
            await interaction.deferUpdate();
            if (action === 'join') {
                if (data.participants.length < data.maxPlayers && !data.participants.includes(interaction.user.id)) {
                    data.participants.push(interaction.user.id);
                    const creator = await client.users.fetch(data.creatorId);
                    creator.send(`🔔 **${interaction.user.username}**님이 참가했습니다!`).catch(() => null);
                }
            } else if (action === 'leave') {
                if (interaction.user.id === data.creatorId) {
                    allRecruits.delete(targetMsgId);
                    saveData();
                    return await interaction.message.delete().catch(() => null);
                }
                data.participants = data.participants.filter(id => id !== interaction.user.id);
                data.team1 = data.team1.filter(id => id !== interaction.user.id);
                data.team2 = data.team2.filter(id => id !== interaction.user.id);
            }
        }

        saveData();
        await interaction.message.edit({ embeds: [createRecruitEmbed(data)] });
    }

    if (interaction.isStringSelectMenu()) {
        const [action, targetMsgId] = interaction.customId.split('_');
        const data = allRecruits.get(targetMsgId);
        if (!data) return;

        // 수동 팀 배정 확정
        if (action === 'setTeamManual') {
            data.team1 = interaction.values;
            data.team2 = data.participants.filter(id => !data.team1.includes(id));
            saveData();
            const targetMsg = await interaction.channel.messages.fetch(targetMsgId).catch(() => null);
            if (targetMsg) await targetMsg.edit({ embeds: [createRecruitEmbed(data)] });
            return await interaction.update({ content: '✅ 팀 설정 완료!', components: [], ephemeral: true });
        }
        // 방장 양도 확정
        else if (action === 'selectTransfer') {
            activeUserRecruits.delete(data.creatorId);
            data.creatorId = interaction.values[0];
            activeUserRecruits.set(data.creatorId, targetMsgId);
            saveData();
            const targetMsg = await interaction.channel.messages.fetch(targetMsgId).catch(() => null);
            if (targetMsg) await targetMsg.edit({ embeds: [createRecruitEmbed(data)] });
            return await interaction.update({ content: '👑 방장이 양도되었습니다.', components: [], ephemeral: true });
        }
        // 방 이동 채널 선택 로직 (이전과 동일)
        else if (action === 'selectMove1') {
            data.team1TargetId = interaction.values[0];
            const voiceChannels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice && c.id !== data.team1TargetId);
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`selectMove2_${targetMsgId}`)
                .setPlaceholder('2팀 이동 채널 선택')
                .addOptions(voiceChannels.map(c => ({ label: c.name, value: c.id })));
            return await interaction.update({ content: '🟥 2팀이 갈 방을 골라주세요.', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
        }
        else if (action === 'selectMove2') {
            const team2Id = interaction.values[0];
            for (const id of data.team1) {
                const m = await interaction.guild.members.fetch(id).catch(() => null);
                if (m && m.voice.channel) await m.voice.setChannel(data.team1TargetId);
            }
            for (const id of data.team2) {
                const m = await interaction.guild.members.fetch(id).catch(() => null);
                if (m && m.voice.channel) await m.voice.setChannel(team2Id);
            }
            return await interaction.update({ content: '🚀 이동 완료!', components: [], ephemeral: true });
        }
    }
});

client.login(process.env.TOKEN);