const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
    new SlashCommandBuilder()
        .setName('구인')
        .setDescription('이터널 리턴 구인을 시작합니다.')
        .addStringOption(option => 
            option.setName('유형')
                .setDescription('게임 유형을 선택하세요')
                .setRequired(true)
                .addChoices(
                    { name: '일반', value: '일반' },
                    { name: '랭크', value: '랭크' },
                    { name: '내전(커스텀)', value: '내전' }
                ))
        .addStringOption(option => 
            option.setName('맵')
                .setDescription('루미아 섬 혹은 코발트')
                .setRequired(true)
                .addChoices(
                    { name: '루미아 섬', value: '루미아 섬' },
                    { name: '코발트', value: '코발트' }
                ))
        .addStringOption(option => 
            option.setName('시간')
                .setDescription('시작 시간 (예: 22시 30분 / 미입력 시 즉시)')
                .setRequired(false))
        .addIntegerOption(option => 
            option.setName('종료시간')
                .setDescription('삭제 대기 시간 (숫자만 입력, 기본 4시간)')
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('사용법')
        .setDescription('나쟈 봇 사용법 확인')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log('⏳ 명령어 목록 업데이트 중...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 업데이트 성공! 디스코드 새로고침(Ctrl+R)을 해주세요.');
    } catch (error) { console.error(error); }
})();