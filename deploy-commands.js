const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
    // =====================
    // /구인
    // =====================
    new SlashCommandBuilder()
        .setName('구인')
        .setDescription('이터널 리턴 구인을 시작합니다.')
        .addStringOption(option =>
            option.setName('유형')
                .setDescription('게임 유형과 맵을 선택하세요')
                .setRequired(true)
                .addChoices(
                    { name: '일반 (루미아 섬) - 3인', value: '일반_루미아' },
                    { name: '랭크 (루미아 섬) - 3인', value: '랭크_루미아' },
                    { name: '일반 (코발트) - 4인',    value: '일반_코발트' }
                ))
        .addStringOption(option =>
            option.setName('시간')
                .setDescription('시작 시간 (예: 22시 30분 / 미입력 시 즉시)')
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('종료시간')
                .setDescription('삭제 대기 시간 (숫자만 입력, 기본 24시간)')
                .setRequired(false)),

    // =====================
    // /내전
    // =====================
    new SlashCommandBuilder()
        .setName('내전')
        .setDescription('이터널 리턴 내전 구인을 시작합니다.')
        .addStringOption(option =>
            option.setName('유형')
                .setDescription('내전 유형을 선택하세요')
                .setRequired(true)
                .addChoices(
                    { name: '루미아 섬 (팀당인원/최대인원 자유)', value: '루미아' },
                    { name: '론울프 (1인 1팀 개인전, 최대 18명)', value: '론울프' },
                    { name: '코발트 (4vs4 고정)',                 value: '코발트' }
                ))
        .addIntegerOption(option =>
            option.setName('팀당인원')
                .setDescription('루미아 한 팀 인원 수 (기본 3명 / 루미아 전용)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(10))
        .addIntegerOption(option =>
            option.setName('최대인원')
                .setDescription('최대 참가 인원 (루미아 기본 24명 / 론울프 기본 18명)')
                .setRequired(false)
                .setMinValue(2)
                .setMaxValue(24))
        .addStringOption(option =>
            option.setName('시간')
                .setDescription('시작 시간 (예: 22시 30분 / 미입력 시 즉시)')
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('종료시간')
                .setDescription('삭제 대기 시간 (숫자만 입력, 기본 24시간)')
                .setRequired(false)),

    // =====================
    // /사용법
    // =====================
    new SlashCommandBuilder()
        .setName('사용법')
        .setDescription('나쟈 봇 사용법 확인'),

    // =====================
    // /시즌
    // =====================
    new SlashCommandBuilder()
        .setName('시즌')
        .setDescription('현재 이터널 리턴 시즌 정보를 표시합니다.'),

    // =====================
    // /무료실험체
    // =====================
    new SlashCommandBuilder()
        .setName('무료실험체')
        .setDescription('이번 주 무료 실험체 목록을 표시합니다.'),

].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log('⏳ 명령어 목록 업데이트 중...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 업데이트 성공! 디스코드 새로고침(Ctrl+R)을 해주세요.');
    } catch (error) { console.error(error); }
})();
