# slack-inquiry-bot

작업자 문의에 자동 응답하는 Slack 봇 전체 패키지입니다.
기존 단일 파일(flat) 구조를 책임별 모듈로 분리한 버전입니다.

> 기준일: 2026-05-29
> npm 또는 Docker 두 경로로 구동 가능. 둘 다 같은 `.env` 파일을 읽습니다.
> 별도 cd/배포 인프라는 미포함 — 운영 환경에 맞게 자체 배포 구성.

> 🔰 **새 버전을 처음 받으셨다면 `START_HERE.md`(이관·세팅 가이드)부터 보세요.** 기존 코드 백업 → 새 코드 교체 → 설정 이어받기 → 켜기를 한 단계씩 안내합니다.
> 이관을 마친 뒤 평소 운영(켜기·끄기·문제 해결)은 `OPERATOR_GUIDE.md`를 보세요.

---

## 목차

1. [실행 가이드 (npm / Docker)](#1-실행-가이드)
2. [모듈 구조 맵](#2-모듈-구조-맵)
3. [운영 패치 env 동작](#3-운영-패치-env-동작)
4. [동봉 파일 안내](#4-동봉-파일-안내)

---

## 1. 실행 가이드

### 공통 선행: `.env` 파일 준비

npm이든 Docker든 **같은 `.env` 파일**을 읽습니다. 먼저 아래를 진행하세요.

```bash
cp .env.example .env
# .env를 에디터로 열어 23종 환경변수를 채웁니다
# (각 변수에 한국어 주석으로 설명이 있습니다)
```

Slack 트리거 이모지도 미리 준비하세요:
- Slack workspace에 커스텀 이모지 등록 (예: `문의봇소환`)
- `.env`의 `TRIGGER_EMOJI`에 이모지 이름 입력 (콜론 제외)
- 봇 Slack App에 **`reactions:read`** 및 **`reactions:write`** scope 필요 (대응완료 마킹)

### 경로 A — npm으로 실행 (Node.js 22+ 필요)

```bash
# 1. 의존성 설치
npm install

# 2. 봇 시작
npm start
```

### 경로 B — Docker로 실행

```bash
# 빌드 + 실행 (백그라운드)
docker compose up -d --build

# 로그 확인
docker compose logs -f

# 정지
docker compose down
```

Docker는 `.env` 파일을 자동으로 읽습니다 (`env_file: .env` 설정).

### 작업자 목록 수집 (일회성)

```bash
npm run collect
```

작업자 시트에서 CSV를 수집합니다. 최초 설정 또는 작업자 변경 시 실행.

### 채널 ID 확인 도구

```bash
node tools/findChannels.js
```

Slack 채널 ID 목록을 확인할 때 사용합니다.

---

## 2. 모듈 구조 맵

기존 단일 `app.js` (2459 LOC)를 책임별로 분리한 구조입니다.
`app.js` (335 LOC)는 조립만 담당하고 비즈니스 로직은 각 모듈에 있습니다.

### `src/app.js` — 진입점 (조립만)

env guard 호출 → 외부 클라이언트 생성 → 모듈/flow/handler 등록 → 봇 시작.
비즈니스 함수 없음.

### `src/slack/` — Slack UI 및 라우팅

| 파일 | 책임 |
|---|---|
| `inquiry-router.js` | 문의 분류 ladder (토픽 → 서브토픽 → 모듈 라우팅) |
| `inquiry-blocks.js` | Slack Block Kit 메시지 조립 (문의 응답 UI) |
| `progress.js` | 진행 상태 텍스트 빌드 / 업데이트 / 타임아웃 처리 |
| `text.js` | 텍스트 포맷 헬퍼 (공통 메시지 형식) |
| `thread-context.js` | 스레드 컨텍스트 읽기 (문의 답글 맥락 수집) |

### `src/handlers/` — Slack 액션 핸들러

| 파일 | 책임 |
|---|---|
| `inquiry-entry.js` | 문의 진입 이벤트 처리 (reaction_added → 분류 흐름 시작) |
| `resupply-actions.js` | 재수급 요청 액션 핸들러 |
| `schedule-actions.js` | 일정 문의 액션 핸들러 |
| `direct-input-actions.js` | 직접 입력 액션 핸들러 |

### `src/sheets/` — Google Sheets 도메인

| 파일 | 책임 |
|---|---|
| `normalize.js` | 작품명 정규화 순수 함수 (normalizeTitle / normalizeTitleKo / stripKariSuffix) |
| `title-matcher.js` | 시트 기반 작품명 매칭 (토큰 매칭 / 후보 매칭 포함) |
| `delivery-date.js` | 납품 예정일 조회 및 에피소드 파싱 |
| `resupply-record.js` | 재수급 기록 시트 읽기/쓰기 |
| `inquiry-history.js` | 문의 이력 시트 기록 (KPI 기능용, 현재 reservation) |

### `src/clients/` — 외부 시스템 클라이언트

| 파일 | 책임 |
|---|---|
| `sheets-client.js` | Google Sheets API 전송 단위 (getValues / append / batchUpdate) |

### `src/ai/` — AI 분석

| 파일 | 책임 |
|---|---|
| `inquiry-analyzer.js` | Gemini 기반 문의 분류 / 일정 파싱 / 파일 파싱 (3종 통합) |

### `src/auth/` — 권한 게이트

| 파일 | 책임 |
|---|---|
| `permission-gate.js` | 하드코딩 화이트리스트 기반 운영자 권한 확인 (Slack user ID 직접 대조) |

### `src/reports/` — 리포트

| 파일 | 책임 |
|---|---|
| `kpi-report.js` | KPI 문의 분석 리포트 생성 및 발송 |

### `src/utils/` — 공통 유틸

| 파일 | 책임 |
|---|---|
| `env.js` | fail-fast guard 함수 5개 정의 — 부팅 시 4개 자동 호출(assertSecretsBase / assertGoogleSheets / assertChannels / assertTriggerEmoji) + assertKpiSheets는 KPI 기능 reservation으로 미호출 |
| `trigger.js` | TRIGGER_EMOJI 기반 reaction 판단 헬퍼 |

### Flow 파일 (`src/*.Flow.js`, `src/multipleInquiryFlow.js`)

| 파일 | 책임 |
|---|---|
| `fileOrderFlow.js` | 파일 발주 요청 처리 흐름 |
| `retakeFlow.js` | 리테이크 처리 흐름 |
| `scheduleExtFlow.js` | 일정 연장 처리 흐름 |
| `workerRelayFlow.js` | 작업자 중계 처리 흐름 |
| `multipleInquiryFlow.js` | 복합 문의 라우팅 흐름 |

### 상세 설계 원칙

동봉된 `slack-inquiry-bot-modularization-guide.md`를 참고하세요.
R1~R7 룰과 before/after 패턴, 그리고 이 봇 자체 모듈을 기준으로 한 패턴 색인(부록 A)이 수록되어 있습니다.

---

## 3. 운영 패치 env 동작

이 프로젝트에 포함된 3가지 운영 패치가 있습니다.
운영 환경에서 동작하려면 아래 내용을 확인하세요.

### (a) permission-gate — 하드코딩 화이트리스트 권한 확인

`src/auth/permission-gate.js`가 코드에 등록된 Slack user ID 목록으로 운영자 권한을 확인합니다.

**동작 방식**:
- 봇이 반응을 받으면 반응을 누른 사람의 Slack user ID를 화이트리스트(`ALLOWED_USER_IDS`)와 직접 대조
- 목록에 있는 user ID만 봇 기능 접근 허용
- 목록에 없는 사용자: ephemeral 메시지("문의봇은 APM만 사용할 수 있습니다") 발송 후 처리 중단
- Slack users.info / email / 도메인 / Totus 조회 없음 — 추가 env 불필요

**허용 담당자 추가/제외**:
- `src/auth/permission-gate.js`의 `ALLOWED_USER_IDS` 배열에서 1줄 추가(또는 삭제)
- Slack user ID는 Slack 프로필 > "멤버 ID 복사"로 확인 (U로 시작하는 영숫자)
- AI에게 "permission-gate.js에 [이름]의 Slack ID [UXXXXXXXXX]를 추가해줘"라고 요청 가능

### (b) env guard — 부팅 fail-fast 검증

`src/utils/env.js`에 guard 5개가 정의되어 있고, 그중 4개가 `app.js` 부팅 시 자동 실행됩니다 (5번째 `assertKpiSheets`는 KPI 기능 reservation으로 미호출).

```
assertSecretsBase()    → SLACK_BOT_TOKEN, SLACK_APP_TOKEN, GEMINI_API_KEY,
                          GEMINI_MODEL, PLATFORM_API_URL, PLATFORM_API_TOKEN, GOOGLE_CREDENTIALS
assertGoogleSheets()   → 시트 ID 8종 + GOOGLE_SHEET_RANGE (9종)
assertChannels()       → 채널/유저 ID 6종
assertTriggerEmoji()   → TRIGGER_EMOJI
```

23종 중 하나라도 누락되면 **봇이 시작되지 않고 에러 메시지를 출력**합니다.
에러 메시지에 누락된 변수 이름이 표시되므로 `.env`에서 해당 변수를 채워 재시작하세요.

### (c) TRIGGER_EMOJI 외부화

`reaction_added` 핸들러의 트리거 조건이 코드에 하드코딩되지 않고 env로 외부화되어 있습니다.

- `.env`의 `TRIGGER_EMOJI` 값이 반응 이름과 일치할 때만 봇이 동작합니다
- Slack workspace에 해당 커스텀 이모지를 먼저 등록해야 합니다
- 이모지 이름 변경 시 코드 수정 없이 `.env`만 변경하면 됩니다

---

## 4. 동봉 파일 안내

| 파일 | 내용 |
|---|---|
| `src/` | 봇 전체 소스 + `__tests__/` (317 테스트) |
| `package.json` / `package-lock.json` | npm 의존성 (npm install 재현성) |
| `.gitignore` | .env, logs, node_modules 등 git 제외 설정 |
| `tsconfig.json` | TypeScript 점진 변환 시 참고 (현재 JS만 실행) |
| `tools/findChannels.js` | Slack 채널 ID 확인 도구 |
| `.env.example` | 부팅 필수 23종 env 템플릿 (각 변수 한국어 주석 포함) |
| `Dockerfile` | Docker 이미지 빌드 파일 (node:22-slim 기반) |
| `docker-compose.yml` | Docker Compose 단일 파일 (env_file:.env, default bridge) |
| `.dockerignore` | Docker build context 제외 설정 |
| `README.md` | 이 파일 — 빠른 실행 가이드 + 모듈 구조 맵 |
| `START_HERE.md` | **새 버전 처음 받으신 분용 이관·세팅 가이드** — 기존 코드 백업 → 새 코드 교체 → 설정 이어받기 → 켜기 (요청문 그대로 복붙) |
| `OPERATOR_GUIDE.md` | **비개발자용 운영 가이드** — 평소 켜기·끄기·상태확인·문제해결을 평이한 언어로 단계별 안내 |
| `DEVELOPMENT.md` | 개발 워크플로우 가이드 (구조 워크스루·테스트·새 handler 추가법) |
| `slack-inquiry-bot-modularization-guide.md` | 모듈화 설계 룰 문서 (R1~R7, 패턴 색인). 모든 예제가 이 봇 자체 모듈을 기준으로 작성되어 이 문서 하나만으로 적용 가능합니다 |

---

## 참고

- **테스트 실행**: `npm test` (외부 API mock 기반)
- **개발 워크플로우**: `DEVELOPMENT.md` 참고 (새 flow/handler 추가법, 디버깅, 레시피)
- **모듈화 원칙**: `slack-inquiry-bot-modularization-guide.md` 참고 (R1~R7 룰, 패턴 색인)
- **TS 변환 원할 시**: `tsconfig.json` 참고 (`allowJs: true, checkJs: false` 설정 확인)
- **cd/배포 인프라 미포함**: Docker 또는 npm으로 직접 구동. 운영 환경에 맞게 자체 배포 구성.
