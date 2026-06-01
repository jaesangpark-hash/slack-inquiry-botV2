# DEVELOPMENT.md — 개발 워크플로우 가이드

> **이 문서의 위치**: 개발 워크플로우(구조 이해·테스트·새 기능 추가·디버깅).
> - `README.md` = 빠른 실행 + env 설명 + 모듈 구조 맵
> - `DEVELOPMENT.md` = 개발 시 알아야 할 워크플로우 (이 문서)
> - `slack-inquiry-bot-modularization-guide.md` = 모듈화 원칙 룰 (AI 도구 중립, R1~R7)

---

## 1. 프로젝트 구조 워크스루

```
src/
├── app.js                    진입점 (조립만 — 비즈니스 로직 없음)
├── apiLogger.js              API 요청/응답 로깅 (logs/ 파일 적재)
│
├── ai/                       AI 분석 모듈
│   └── inquiry-analyzer.js   Gemini 기반 문의 분류 / 일정 파싱 / 파일 파싱 (3종 통합)
│
├── auth/                     권한 게이트
│   └── permission-gate.js    하드코딩 화이트리스트 기반 운영자 권한 확인 (Slack user ID 직접 대조)
│
├── clients/                  외부 시스템 전송 단위 (transport layer)
│   └── sheets-client.js      Google Sheets API 직접 호출 한 곳 (getValues / append / batchUpdate)
│
├── handlers/                 Slack 액션 핸들러 (app.js에 register 함수 노출)
│   ├── inquiry-entry.js      문의 진입 이벤트 (reaction_added → 분류 흐름 시작)
│   ├── resupply-actions.js   재수급 요청 액션
│   ├── schedule-actions.js   일정 문의 액션
│   └── direct-input-actions.js 직접 입력 액션
│
├── reports/                  리포트 모듈
│   └── kpi-report.js         KPI 문의 분석 리포트 생성 및 발송
│
├── sheets/                   Google Sheets 도메인 (transport 위임, 도메인 로직만)
│   ├── normalize.js          작품명 정규화 순수 함수 (normalizeTitle / normalizeTitleKo / stripKariSuffix)
│   ├── title-matcher.js      시트 기반 작품명 매칭
│   ├── delivery-date.js      납품 예정일 조회 및 에피소드 파싱
│   ├── resupply-record.js    재수급 기록 시트 읽기/쓰기
│   └── inquiry-history.js    문의 이력 시트 기록 (KPI 활성 시 사용)
│
├── slack/                    Slack UI 및 라우팅
│   ├── inquiry-router.js     문의 분류 ladder (토픽 → 서브토픽 → 모듈)
│   ├── inquiry-blocks.js     Block Kit 메시지 조립
│   ├── progress.js           진행 상태 텍스트 / 타임아웃 처리
│   ├── text.js               텍스트 포맷 헬퍼
│   └── thread-context.js     스레드 컨텍스트 읽기
│
├── utils/                    공통 유틸
│   ├── env.js                fail-fast guard 함수 5종 + 헬퍼 6종
│   └── trigger.js            TRIGGER_EMOJI 기반 reaction 판단 헬퍼
│
├── collectWorkers.js          작업자 DB CSV 수집 스크립트 (npm run collect)
├── fileOrderFlow.js           파일 발주 요청 처리 흐름
├── retakeFlow.js              리테이크 처리 흐름
├── scheduleExtFlow.js         일정 연장 처리 흐름
├── workerRelayFlow.js         작업자 중계 처리 흐름
└── multipleInquiryFlow.js     복합 문의 라우팅 흐름
```

### app.js 부팅 순서

```
1. dotenv.config()                    .env 로드
2. assertSecretsBase()                Slack + AI + Totus 게이트웨이 + Google (7종)
3. assertGoogleSheets()               시트 ID 9종
4. assertChannels()                   채널/유저 ID 6종
5. assertTriggerEmoji()               TRIGGER_EMOJI (1종)
6. Bolt App 초기화                    SlackBolt App (socketMode: true)
7. 외부 클라이언트 생성               sheetsClient / titleMatcher / deliveryDate / ...
8. handler 등록                       registerResupplyActions(app, ...) 등
9. Flow 등록                          fileOrderFlow(app, ...) 등
10. app.start()                       Socket Mode 연결 시작
```

23종 env 중 하나라도 누락되면 2~5단계에서 throw하고 봇이 시작되지 않습니다.
에러 메시지에 누락된 변수 이름이 출력됩니다.

---

## 2. 로컬 셋업

`.env.example`을 복사해 `.env`를 만들고 23종을 채우세요. 자세한 내용은 `README.md §1` 참고.

### npm 경로 (개발 권장 — hot reload·디버깅 용이)

```bash
npm install
npm start
```

Node.js 22+ 필요. `console.log` 추가 후 재시작하면 즉시 반영됩니다.

### Docker 경로

```bash
docker compose up -d --build
docker compose logs -f
```

코드 변경 후 적용: `docker compose up -d --build` 재실행.

---

## 3. 테스트 실행

```bash
npm test
```

Node.js 내장 test runner(`node --test`)를 사용합니다. 별도 테스트 프레임워크 설치 불요.

- **총 테스트 수**: 317개
- **위치 규약**: 각 모듈 옆 `__tests__/` 디렉토리
  - 예: `src/sheets/title-matcher.js` → `src/sheets/__tests__/title-matcher.test.js`
- **특성**: 외부 API mock 기반 — 실 Slack/Sheets/Gemini 연결 없이 실행

새 모듈 추가 시 `<모듈>/__tests__/<모듈>.test.js`로 테스트를 동반 작성하세요.

---

## 4. 새 flow / handler 추가하는 법

### 4-1. 새 Slack 액션/뷰 핸들러 추가

1. `src/handlers/<도메인>-actions.js` 파일 생성 (기존 `resupply-actions.js` 패턴 참고)
2. 파일 상단 `// 단일 책임: ___` 주석 작성
3. `registerXxxActions(app, deps)` 형태의 등록 함수 export
4. `src/app.js`에서 import 후 호출:
   ```js
   const { registerXxxActions } = require("./handlers/xxx-actions");
   // app.start() 전에 등록
   registerXxxActions(app, { sheetsClient, titleMatcher, ... });
   ```

### 4-2. 새 시트 읽기/쓰기 모듈 추가

1. `src/sheets/<목적>.js` 파일 생성 (기존 `delivery-date.js` 패턴 참고)
2. factory 함수 형태로 export:
   ```js
   module.exports = function createXxxService({ sheetsClient, sheetId }) {
     return {
       async fetchXxx(...) { return sheetsClient.getValues(sheetId, range); },
     };
   };
   ```
3. Google Sheets 직접 호출(`google.sheets(...)`)은 `src/clients/sheets-client.js` 한 곳에만 두세요.
   새 시트 operation이 필요하면 `sheets-client.js`에 메서드 추가 후 도메인 모듈에서 호출합니다.

### 4-3. 새 AI 분석 추가

`src/ai/inquiry-analyzer.js`에 analyze 함수를 추가하세요. factory DI 패턴:
```js
module.exports = function createInquiryAnalyzer({ ai, GEMINI_MODEL, alertOnError }) {
  async function analyzeXxx(text) { /* Gemini 호출 */ }
  return { analyzeInquiry, parseScheduleInquiry, parseFileInquiry, analyzeXxx };
};
```
새 Gemini 모델이나 프롬프트는 `inquiry-analyzer.js` 내부에만 두세요 (SSOT).

### 4-4. 분류 ladder 변경

- **분류 로직**: `src/slack/inquiry-router.js` → `routeInquiry(text)` 순수 함수
- **진입 어댑터**: `src/handlers/inquiry-entry.js` → reaction/message 이벤트 수신 후 `routeInquiry` 호출

분류 규칙만 변경하면 `inquiry-router.js`만 수정, 어댑터는 그대로입니다.

### 4-5. 새 Flow 추가

Flow 파일(`src/xxxFlow.js`)은 핵심 비즈니스 로직이 있는 곳입니다.
```js
module.exports = function xxxFlow(app, { ai, GEMINI_MODEL, titleMatcher, deliveryDate }) {
  app.action("xxx_action", async ({ ack, body, client }) => { /* ... */ });
};
```
`app.js`에서 import 후 `xxxFlow(app, { ... })` 호출로 등록합니다.

---

## 5. 디버깅

### 로그 확인

- **파일 로그**: `logs/api-YYYY-MM-DD.jsonl` — `src/apiLogger.js`가 API 요청/응답을 기록
- **콘솔 로그**: Bolt가 이벤트 수신 시 stdout 출력 (npm start 터미널에서 실시간 확인)
- **Docker**: `docker compose logs -f` 로 실시간 확인

### guard throw 메시지 읽기

부팅 시 env 누락으로 throw가 발생하면 다음과 같이 출력됩니다:
```
Error: [assertSecretsBase] 필수 환경변수 누락: SLACK_BOT_TOKEN, GEMINI_API_KEY
```
`.env`에서 해당 변수를 찾아 채운 뒤 재시작하면 됩니다.

### Bolt Socket Mode 이슈

- `SLACK_APP_TOKEN`이 올바르지 않으면 WebSocket 연결 실패가 발생합니다
- Slack App 설정에서 Socket Mode가 활성화되어 있는지 확인하세요
- `reactions:read` / `reactions:write` scope 미등록 시 이모지 관련 기능 오류

---

## 6. env 관리

- **`.env`**: 실 값 보관 (gitignore — git에 커밋하지 마세요)
- **`.env.example`**: 템플릿 (git 추적 대상, 실 값 없음)
- **guard 검증 시점**: 부팅(`npm start` 또는 `docker compose up`) 시 자동 실행

새 env 추가 시 3곳을 동반 수정하세요:
1. `src/utils/env.js` — 해당 guard 함수에 변수명 추가
2. `.env.example` — 한국어 주석과 함께 키 추가
3. `.env` — 실 값 입력

### 허용 담당자(권한 목록) 편집 레시피

봇을 사용할 수 있는 담당자를 추가하거나 제외할 때는 `src/auth/permission-gate.js`의 `ALLOWED_USER_IDS` 배열을 편집합니다.

**추가**:
```js
const ALLOWED_USER_IDS = new Set([
  // ... 기존 목록 ...
  "UNEWUSERID",  // 홍길동
]);
```

**제외**: 해당 줄을 삭제합니다.

Slack user ID는 Slack 프로필 > 더보기(···) > "멤버 ID 복사"로 확인할 수 있습니다 (`U`로 시작하는 영숫자).

`process.env.X || "기본값"` 또는 `process.env.X ?? "기본값"` 패턴은 사용하지 마세요.
잘못된 기본값이 조용히 채워져 오동작 원인이 됩니다 (`src/utils/env.js §guard` 참고).

---

## 7. 흔한 작업 레시피

### 트리거 이모지 변경

코드 수정 없이 `.env`만 변경합니다:
```
TRIGGER_EMOJI=새이모지이름
```
변경 후 `npm start` 재시작 (Docker면 `docker compose up -d --build`).

### 봇 권한 범위 변경 (reactions:write 추가 등)

Slack App 관리 페이지 → OAuth & Permissions → Bot Token Scopes에서 scope를 추가합니다.
추가 후 워크스페이스에 봇을 재설치해야 반영됩니다.

### 새 RETAKE 채널 추가

코드 수정 없이 `.env`만 변경합니다:
```
RETAKE_CHANNELS=C기존채널ID,C새채널ID
```
쉼표 구분, 공백 없이 입력하세요.

### 작업자 목록 갱신

작업자 시트 변경 후:
```bash
npm run collect
```

### 테스트 일부만 실행

```bash
# 특정 파일 테스트
node --test src/sheets/__tests__/normalize.test.js

# 특정 디렉토리
node --test src/sheets/__tests__/
```
