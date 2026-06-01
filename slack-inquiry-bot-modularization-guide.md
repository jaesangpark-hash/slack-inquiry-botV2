# Slack 문의대응봇 — 모듈화 / 설계 룰

> **용도**: AI 코딩 어시스턴트가 이 봇 코드를 모듈화·정리할 때 적용하는 룰 문서. 어떤 AI 도구든 시스템 프롬프트·룰 파일로 paste 가능(도구중립).
> **범위**: 코드 **구조**만 다룬다. 비즈니스 로직(응답 규칙)은 작성자 SSOT, 본 룰 대상 아님.

---

## 0. 범위

| 다룬다 | 다루지 않는다 |
|---|---|
| 코드를 어디에 두는가 (모듈 경계·DI·진입점 청결) | 비즈니스 로직(문의 응답 규칙) 변경 |
| `app.js` god object 분해 | Totus write 게이트웨이(`PLATFORM_API_URL`) 통일 — 당분간 보존 |
| 패턴·인터페이스·체크리스트 | 봇 외부 패키지 변경 |

**전제**: 이 룰은 자기완결적이다. 모든 예시는 이 봇(`src/`)의 실제 모듈에서 가져왔으므로, 다른 코드베이스를 참고할 필요 없이 이 문서만으로 적용 가능하다. 패턴은 언어 무관(JS↔TS 동등 적용).

**하드 제약 (위반 금지)**:
- 이 봇은 독립 실행 봇이다 — 봇 외부의 코드를 `require`/`import` 하지 않는다. 구조 패턴은 이 봇 안에서 일관되게 적용한다.
- 비즈니스 로직 본문은 원본 그대로 옮긴다 (구조만 이동, 로직 무변경).
- 본 작업에 무관한 코드·주석·포맷 수정 금지 (drive-by refactoring 금지).

**코드 레퍼런스 번들 동봉 시**: 본 가이드와 함께 동작하는 모듈 코드 번들(R1~R4 추출분 + `APPLY.md`)이 제공될 수 있다. 번들 = **부트스트랩 레퍼런스**(현 god object를 한 번에 구조 정렬), 가이드 = **차기 원천작업 적용 룰**(신규 flow·핸들러 추가 시). 둘은 보완 관계다 — 번들은 1회성 구조 정렬, 룰은 지속 표준. 번들 적용은 `app.js` 전체 치환이 아니라 `APPLY.md`의 헬퍼 삭제 + wiring 수동 반영(surgical)이며, 핸들러·flow·게이트웨이는 원형 보존한다.

---

## 1. 배경 — 이 구조가 왜 이렇게 나뉘었나

이 룰은 한 가지 출발 상태에서 나왔다: **`app.js` 한 파일에 2,400줄 넘게 (인라인 함수 40여 개 · Slack 핸들러 30개 · `google.sheets(...)` 직접 호출이 4개 파일에 흩어짐)** 모여 있던 god object. 한 파일이 너무 커서 AI에게 수정을 맡기면 엉뚱한 곳을 건드리기 쉬웠다.

**전달받으신 코드는 이미 이 룰대로 분리가 끝난 상태**다 (`app.js`는 조립만 하는 335줄, 비즈니스 로직은 `src/sheets/`·`src/handlers/`·`src/clients/`·`src/utils/` 등 책임별 모듈로 이동). 따라서 이 문서는 "지금부터 새 기능을 추가하거나 고칠 때 이 구조를 유지하는 룰"로 쓰면 된다.

분리된 핵심 자산: `src/auth/permission-gate.js`(권한 게이트 — 하드코딩 Slack ID 화이트리스트) · `src/clients/sheets-client.js`(Google Sheets 전송 단위) · `src/utils/env.js`(guard 5종 — `assertSecretsBase`/`assertGoogleSheets`/`assertChannels`/`assertKpiSheets`/`assertTriggerEmoji`).

---

## 2. 룰 (R1 ~ R7)

### R1 — 한 파일 = 한 책임

한 파일은 한 가지 비즈니스 책임만 갖는다. 파일 상단에 `// 단일 책임: ___` 한 줄 주석 의무. 300줄 초과 시 분리 신호.

**봇 적용**: `app.js` 40여 함수를 책임별로 분리.
- `src/sheets/normalize.js` ← `normalizeTitle*` / `stripKariSuffix` (순수 헬퍼: 여러 도메인 모듈이 공유 → title-matcher·delivery-date에서 떼어 **leaf로 먼저** 분리. 부록 A P10 SSOT)
- `src/sheets/title-matcher.js` ← `matchWorkTitleFromSheet` / `matchWorkTitleByTokens` / `matchWorkTitleWithCandidates`
- `src/sheets/delivery-date.js` ← `fetchDeliveryDate` / `parseEpisodeNumbers`
- `src/ai/inquiry-analyzer.js` ← `analyzeInquiryWithAI` / `parseScheduleInquiry` / `parseFileInquiry` (3종 통합 — 실측 발견: `parseFileInquiry`도 동일 `ai`+`GEMINI_MODEL`+`alertOnError` 의존 클래스)
- `src/slack/progress.js` ← `buildProgressText` / `updateProgress` / `withTimeout` / `alertOnError`

**이 봇 예시**: `src/sheets/`·`src/handlers/`의 각 파일이 한 책임만 갖는다 — `title-matcher.js`(작품명 매칭) / `delivery-date.js`(납품일 조회) / `resupply-actions.js`(재수급 액션)처럼.

### R2 — 진입점은 조립만 한다

`app.js`는 (a) env guard 호출 (b) 외부 클라이언트 생성 (c) 모듈·flow·handler 등록 (d) 종료 처리만 한다. 진입점에 새 비즈니스 함수 직접 추가 금지 — 신규 로직은 모듈에 두고 `app.js`는 등록만 한다.

**이 봇 예시**: `src/app.js` — env guard → 외부 클라이언트 생성 → 모듈/flow/handler 등록 → `app.start()` 순서만 담고, 비즈니스 함수는 0개.

### R3 — 외부 의존성은 인자로 주입한다 (DI)

모듈은 외부 자원(sheets·ai·slack·totus 클라이언트, 설정값)을 **인자로 받는다**. 모듈 내부에서 `process.env` 직접 read 금지, 전역 변수·싱글톤 의존 금지. 주입 객체는 **명시적·최소** 형태로 정리한다 — 함수 7개 일괄 주입(거대 deps) 같은 안티패턴 금지.

**봇 적용**: 기존 flow 주입 패턴(`require("./fileOrderFlow")(app, { ai, GEMINI_MODEL, google, getGoogleAuth, ... })`)을 모든 모듈로 확장. 현 `multipleInquiryFlow`의 함수 7개 일괄 주입은 분리 대상(§3 참고).

**이 봇 예시**: `src/auth/permission-gate.js`의 `PermissionDeps` JSDoc — 모듈이 필요한 의존을 인자 객체로 명시하고 내부에서 `process.env`를 직접 읽지 않는다. 시트 모듈도 `createTitleMatcher({ sheetsClient, masterSheetId })`처럼 factory 인자로 의존을 받는다.

### R4 — 외부 통신은 transport / 도메인 2층으로 분리한다

"HTTP 전송(어떻게)"과 "도메인 조회(무엇을)"를 분리한다. 외부 API 직접 호출(`google.sheets(...)`, `axios.post(...)`)은 client 파일 **한 곳**에만 둔다.

**봇 적용**: `google.sheets(...).spreadsheets.values.get/append/batchUpdate` raw 호출을 `src/clients/sheets-client.js` 단일 파일로 수렴. 도메인 모듈(`title-matcher`·`delivery-date`)·flow는 그 client를 호출. (진행: read get 5곳 수렴 완료 — `getValues(spreadsheetId, range)`. write 3곳(`app.js` append×2/batchUpdate)은 rowIndex 추출·옵션 분기가 이질적이라 후속 트랙.) client는 transport만(값 반환 또는 throw) — 에러 알림(`alertOnError`)·로깅 래핑은 호출처에 둔다(client가 Slack 알림을 삼키거나 발신하면 behavior 회귀).

**이 봇 예시**: `src/clients/sheets-client.js`(전송 — `getValues`/`append`/`batchUpdate`) ↔ `src/sheets/title-matcher.js`·`delivery-date.js`(도메인) 2층. client는 도메인을 모르고(Google API 호출만), 도메인은 `google.sheets(...)`를 직접 부르지 않는다.

**프롬프트 위치 (R4-b 판정: 단일 파일 통합 안 함)**: AI 프롬프트 텍스트는 비즈니스 로직(응답 규칙, §범위 제외)이라 구조 통합 대상이 아니다. analyzer 3종은 이미 `src/ai/inquiry-analyzer.js` 한 곳(SSOT 충족). flow별 프롬프트(`fileOrderFlow`·`workerRelayFlow`·`retakeFlow`·`multipleInquiryFlow`)는 `${langName}` 등 flow-local 변수와 강결합 → 사용처 옆 인라인 유지(locality). 단일 `prompts.js` 합류는 locality 손실·과잉 추상화라 비권장.

### R5 — 환경값은 부팅 시점에 fail-fast 검증한다

필수 env는 `requireEnv("X")`로 read 하고, 누락 시 부팅에서 throw 한다. 새 기능이 새 env를 쓰면 그 env를 검증하는 guard(`assertXxx`)를 같이 추가한다. env 헬퍼는 `utils/env.js` **단일 파일**에만 둔다.

**금지**: `process.env.X || "기본값"` / `process.env.X ?? "기본값"` 코드 리터럴 fallback. 잘못된 기본값이 조용히 채워져 엉뚱한 채널·시트로 동작하는 운영 사고로 이어진다.

**이 봇 예시**: `src/utils/env.js` — guard 5종(`assertSecretsBase`/`assertGoogleSheets`/`assertChannels`/`assertKpiSheets`/`assertTriggerEmoji`)이 정의돼 있고, `app.js` 부팅 시 4종이 자동 호출돼 23종 env 누락을 즉시 throw한다.

### R6 — silent failure 금지

`catch` 블록은 (a) 로그 (b) 알림 (c) 위로 throw 중 최소 하나를 수행한다. 빈 `catch (_) {}` 금지. 무시할 경우 "왜 무시 안전한가" 한 줄 주석 의무. 일시적 오류(재시도 가능)와 치명적 오류(설정 문제 등)를 구분한다.

**이 봇 예시**: `alertOnError` / `sendAlert` / `src/apiLogger.js` — 오류를 삼키지 않고 알림·로그로 노출한다. 외부 호출 결과가 errors를 담으면 throw, 부분 실패는 WARN 로그 후 진행하는 식으로 "조용한 실패"를 만들지 않는다.

### R7 — 분기 대신 설정/표로 확장한다 (하드코딩 금지)

국가·언어쌍·고객사·채널 식별자는 `if/else` 분기 대신 설정 맵·핸들러 등록 테이블로 둔다. "새 항목 추가 = 맵에 한 줄 추가" 형태로 만든다.

**봇 적용**: 언어쌍별 시트 range가 상수로 박혀 있다면 → 설정 맵(언어쌍 → range)으로 외부화. flow 라우팅도 분기 대신 핸들러 테이블로. ⚠️ **현 봇 caveat (2026-05-28 실측)**: `ZHJA_SHEET_RANGE`(`title-matcher.js`)는 한일/중일이 **단일 `중일_master` 시트를 공유**해 range가 1개뿐 → "언어쌍→range 맵"은 항목 1개짜리 선제 추상화(실측 없이 미리 일반화하는 과잉 설계)라 외부화 불요. `langMap`(`fileOrderFlow.js`)·채널(env+Set)·inquiry-type `switch`는 이미 맵/외부화 충족. 봇은 **분기 압력이 낮은 패키지**라 R7 우선순위 낮음 — 실제 다중 언어쌍 range·고객사 분기가 코드에 생길 때 적용.

**원칙**: "새 고객사·언어쌍·채널 추가 = 코드 분기가 아닌 설정(맵/표)에 한 줄 추가". 다만 이 봇은 분기 압력이 낮아 R7 우선순위는 낮다 — 실제 다중 언어쌍 range·고객사 분기가 코드에 생길 때 적용하면 된다.

---

## 3. before / after (패턴 학습 입력)

### before — god object + 거대 deps

```js
// app.js (2459줄 일부) — 비즈니스 함수가 진입점에 인라인
async function fetchDeliveryDate(workNameKo, episode, lang = "zh-ja", projectName = null) { /* 50줄 */ }
async function matchWorkTitleFromSheet(titleJa, titleKo = null) { /* 시트 직접 호출 + 매칭 */ }
async function analyzeInquiryWithAI(sourceText, isThreadContext = false) { /* Gemini 직접 호출 */ }
// ... 인라인 함수 수십 개 ...

// flow에 함수 뭉치 일괄 주입 (거대 deps · flow 간 결합)
const { handleMultipleInquiry } = require("./multipleInquiryFlow")(app, {
  ai, GEMINI_MODEL, matchWorkTitleFromSheet, matchWorkTitleByTokens,
  generateDraftId, draftStore, fetchDeliveryDate,
  handleFileOrderInquiry, handleRetakeInquiry, handleScheduleExt,
});
```

위반: R2(진입점 로직) · R4(Sheets·Gemini raw 호출) · R3(거대 deps + flow 간 결합).

### after — 책임별 모듈 + 명시적 client 주입

```js
// src/clients/sheets-client.js — R4 (전송 단위만)
module.exports = function createSheetsClient({ google, getGoogleAuth }) {
  return {
    async getValues(sheetId, range) { /* google.sheets 직접 호출은 여기 한 곳만 */ },
    async append(sheetId, range, rows) { /* ... */ },
  };
};

// src/sheets/title-matcher.js — R1 (작품명 매칭 한 책임) + R3 (sheetsClient 주입)
module.exports = function createTitleMatcher({ sheetsClient, masterSheetId }) {
  async function matchFromSheet(titleJa, titleKo) { /* sheetsClient.getValues(...) */ }
  return { matchFromSheet, matchByTokens, matchWithCandidates };
};

// src/sheets/delivery-date.js — R1 (납품일 조회 한 책임)
module.exports = function createDeliveryDateService({ sheetsClient, titleMatcher }) {
  async function fetchDeliveryDate(workNameKo, episode, lang) { /* ... */ }
  return { fetchDeliveryDate };
};

// app.js — R2 (조립만)
assertSecretsBase(); assertGoogleSheets(); assertChannels();           // R5
const sheetsClient = createSheetsClient({ google, getGoogleAuth });
const titleMatcher = createTitleMatcher({ sheetsClient, masterSheetId: requireEnv("MASTER_SHEET_ID") });
const deliveryDate = createDeliveryDateService({ sheetsClient, titleMatcher });

require("./flows/multipleInquiryFlow")(app, { ai, titleMatcher, deliveryDate, draftStore }); // 명시적·최소 deps
```

비즈니스 로직 본문은 원본 그대로 옮긴다. 파일명·경계는 실제 코드를 보고 확정.

---

## 4. 적용 체크리스트 (작업 후 self-check)

- [ ] **R1 단일 책임**: 파일 상단 `// 단일 책임: ___` 한 줄 주석 작성. 못 쓰면 분리.
- [ ] **R2 진입점 청결**: `app.js`에 새 비즈니스 함수 직접 추가 없음.
- [ ] **R3 DI 주입**: 모듈이 외부 자원을 인자로 받음. 모듈 내부 `process.env` 직접 read 없음, 전역 싱글톤 의존 없음.
- [ ] **R3 deps 최소**: 주입 인자가 명시적·최소. 함수 7개 일괄 주입 같은 거대 deps 없음.
- [ ] **R4 transport 분리**: `google.sheets(...)` / `axios.post(...)` 직접 호출이 client 파일 한 곳에만 존재.
- [ ] **R5 guard**: 새 env는 `utils/env.js` guard에 추가. `process.env.X || "기본값"` / `?? "기본값"` 패턴 없음.
- [ ] **R6 silent failure 없음**: 빈 `catch` 없음. 비웠다면 사유 주석 의무.
- [ ] **R7 하드코딩 없음**: 국가·언어쌍·고객사·채널 분기를 설정 맵으로.
- [ ] **독립 실행**: 봇 외부의 코드를 import하지 않는다 (봇은 독립 실행 — `src/` 안에서만 의존).
- [ ] **변경 범위**: 구조 이동만, 도메인 로직 무변경. drive-by 수정 없음.
- [ ] **테스트 가능성**: 가짜 의존 주입만으로 모듈 단독 테스트 가능.

---

## 5. 게이트웨이 경계

봇의 Totus **write** = `PLATFORM_API_URL` 게이트웨이(REST). **게이트웨이 통일·재활용 작업은 본 룰 범위 밖이며 당분간 보존**한다. 본 룰은 구조 정렬만 다룬다.

봇의 권한 게이트(`permission-gate.js`)는 하드코딩 Slack ID 화이트리스트(`ALLOWED_USER_IDS`)로 외부 조회 없이 판정한다(이 전달본 한정 — 외부 권한 시스템 비의존). transport 분리(R4)의 봇 내 예시는 `clients/sheets-client.js`(Google Sheets 전송 단위 — `getValues`/`append`/`batchUpdate`)를 참고.

---

## 부록 A — 이 봇의 패턴 색인 (자기참조)

이 봇 코드(`src/` 기준)에서 각 룰이 실제로 구현된 위치. 새 코드를 짤 때 "어디를 흉내 내면 되는가"의 색인이다.

| # | 패턴 | 이 봇에서의 위치 | 핵심 |
|---|---|---|---|
| P1 | 조립 전용 진입점 | `src/app.js` | env guard → 클라이언트 생성 → 모듈/flow/handler 등록 → `app.start()` 조립만. 비즈니스 로직 0 |
| P2 | 단일 책임 모듈 | `src/sheets/*.js` · `src/handlers/*.js` | 한 파일 = 한 책임 (작품명 매칭 / 납품일 조회 / 재수급 액션 …) |
| P3 | 명시적 I/O 계약(JSDoc) | `src/auth/permission-gate.js` (`PermissionDeps`) | 주입 객체 형태를 JSDoc으로 고정 |
| P4 | DI 주입(factory) | `src/sheets/title-matcher.js` (`createTitleMatcher`) · `delivery-date.js` | deps를 인자 객체로 받고 내부에서 `process.env` read 안 함 |
| P5 | transport ↔ 도메인 2층 | `src/clients/sheets-client.js` → `src/sheets/*.js` | `google.sheets(...)` 호출은 client 한 곳, 도메인은 client만 호출 |
| P6 | 모듈별 fail-fast guard | `src/utils/env.js` (`assertSecretsBase` 외 4종) | 부팅 시 필요 env 검증, 누락 시 throw |
| P7 | 순수 헬퍼 SSOT | `src/sheets/normalize.js` (`normalizeTitle` / `stripKariSuffix`) | 부수효과 없는 순수 함수, 한 곳에만 |
| P8 | 부수효과 격리(write 캡슐화) | `src/clients/sheets-client.js` (`append` / `batchUpdate`) | 시트 write가 client 안에 갇힘 → 호출처는 결과 예측 가능 |

**읽기 우선순위**: P1 → P5 → P4 → P6 (전체 그림). P3·P7·P8은 후순위.

**룰 ↔ 패턴 매핑**: R1↔P1·P2 / R2↔P1 / R3↔P3·P4 / R4↔P5 / R5↔P6·P7 / R6↔(silent failure 금지) / R7↔(설정/표 확장 — 이 봇은 분기 압력 낮아 후순위).
