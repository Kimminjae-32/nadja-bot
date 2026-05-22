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
    // /전적
    // =====================
    new SlashCommandBuilder()
        .setName('전적')
        .setDescription('이터널 리턴 유저의 전적을 조회합니다.')
        .addStringOption(option =>
            option.setName('닉네임')
                .setDescription('조회할 유저의 닉네임을 입력하세요')
                .setRequired(true)),

    // =====================
    // /추천실험체
    // =====================
    new SlashCommandBuilder()
        .setName('추천실험체')
        .setDescription('유저가 가장 많이 플레이한 실험체 TOP3를 보여줍니다.')
        .addStringOption(option =>
            option.setName('닉네임')
                .setDescription('조회할 유저의 닉네임을 입력하세요')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('모드')
                .setDescription('게임 모드 (기본: 전체)')
                .setRequired(false)
                .addChoices(
                    { name: '솔로', value: '1' },
                    { name: '듀오', value: '2' },
                    { name: '스쿼드', value: '3' }
                )),

    // =====================
    // /랭킹
    // =====================
    new SlashCommandBuilder()
        .setName('랭킹')
        .setDescription('서버 유저들의 MMR 랭킹을 보여줍니다.')
        .addStringOption(option =>
            option.setName('모드')
                .setDescription('게임 모드 (기본: 스쿼드)')
                .setRequired(false)
                .addChoices(
                    { name: '솔로', value: '1' },
                    { name: '듀오', value: '2' },
                    { name: '스쿼드', value: '3' }
                )),

    // =====================
    // /내전결과
    // =====================
    new SlashCommandBuilder()
        .setName('내전결과')
        .setDescription('내전 결과를 기록합니다. (방장 전용)')
        .addIntegerOption(option =>
            option.setName('승팀')
                .setDescription('이긴 팀 번호 (예: 1 → 1팀 승리)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(18)),

].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log('⏳ 명령어 목록 업데이트 중...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 업데이트 성공! 디스코드 새로고침(Ctrl+R)을 해주세요.');
    } catch (error) { console.error(error); }
})();
