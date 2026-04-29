<div align="center">

# 🤖 나쟈 봇 (베타)

**이터널 리턴 전용 디스코드 구인 봇**

![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?style=for-the-badge&logo=discord&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Status](https://img.shields.io/badge/상태-베타-orange?style=for-the-badge)

</div>

---

## ✨ 주요 기능

| 기능 | 설명 |
|------|------|
| 🎮 **파티 구인** | 일반 / 랭크 / 내전(커스텀) 모집 게시글 생성 |
| 📌 **팀 고정** | 원하는 팀에 미리 고정 배치 (📌 표시) |
| 🎲 **팀 섞기** | 고정 인원 제외 나머지를 랜덤 배정 |
| 👑 **방장 양도** | 다른 참가자에게 모집자 권한 이전 |
| ⏰ **자동 삭제** | 시작 시간 기준 설정 시간 후 자동 삭제 |
| 🔔 **DM 알림** | 참가자 발생 시 모집자에게 알림 전송 |

---

## 🚀 명령어

### `/구인`
이터널 리턴 구인을 시작합니다.

| 옵션 | 필수 | 설명 | 기본값 |
|------|------|------|--------|
| `유형` | ✅ | 일반 / 랭크 / 내전(커스텀) | - |
| `맵` | ✅ | 루미아 섬 / 코발트 | - |
| `시간` | ❌ | 시작 시간 (예: `22시 30분`) | 즉시 |
| `종료시간` | ❌ | 자동 삭제까지 대기 시간 (숫자) | 4시간 |

> 💡 랭크 선택 시 맵은 자동으로 **루미아 섬**으로 설정됩니다.  
> 💡 최대 인원: 코발트 **4인** · 루미아 섬 **3인** · 내전 **8인**

### `/사용법`
나쟈 봇 사용 가이드를 확인합니다. (본인에게만 보임)

---

## 🔧 설치 및 실행

**1. 저장소 클론**
```bash
git clone https://github.com/Kimminjae-32/nadja-bot.git
cd nadja-bot
```

**2. 패키지 설치**
```bash
npm install
```

**3. 환경변수 설정**

`.env` 파일을 생성하고 아래 내용을 입력하세요.
```
TOKEN=디스코드_봇_토큰
CLIENT_ID=봇_애플리케이션_ID
```

**4. 슬래시 명령어 등록**
```bash
node deploy-commands.js
```

**5. 봇 실행**
```bash
node index.js
```

---

## 📁 프로젝트 구조

```
nadja-bot/
├── index.js            # 메인 봇 파일
├── deploy-commands.js  # 슬래시 명령어 등록
├── recruits.json       # 구인 데이터 저장 (자동 생성)
├── package.json
├── .gitignore
└── .env                # 환경변수 (업로드 금지 🚫)
```

---

## ⚠️ 주의사항

- `.env` 파일은 절대 GitHub에 업로드하지 마세요.
- `recruits.json`은 봇 실행 시 자동으로 생성됩니다.
- 봇에게 **메시지 읽기/쓰기**, **멤버 조회**, **DM 전송** 권한이 필요합니다.

---

<div align="center">

*나쟈 봇은 현재 베타 버전입니다. 버그나 개선 사항은 Issues에 남겨주세요!*

</div>
