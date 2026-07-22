// 단일 책임: 문의 텍스트 LLM 분석 (Gemini 호출 + JSON 파싱)
"use strict";

/**
 * @param {{ ai: object, GEMINI_MODEL: string, alertOnError: Function }} deps
 */
module.exports = function createInquiryAnalyzer({ ai, GEMINI_MODEL, alertOnError }) {
  // ── AI 분석 ───────────────────────────────────────────────
  async function analyzeInquiryWithAI(sourceText, isThreadContext = false, msgDate = null) {
    const dateContext = msgDate ? `문의 작성일(KST): ${msgDate}\n\n` : "";
    const prompt = `${dateContext}너는 웹툰/만화 로컬라이징 전문 문의 분석 AI다.

${isThreadContext ? `
[스레드 맥락 분석 모드]
아래 문의는 Slack 스레드의 전체 맥락이야. [엄마 스레드]부터 [답변 N]까지의 흐름을 종합해서 분석해줘.

**분석 우선순위:**
1) 작품명·회차 → 엄마 스레드에서 우선 추출 (없으면 댓글에서)
2) 문의 유형·액션 → 가장 마지막 [답변 N] (소환된 메시지) 기준으로 판단
3) 상세 내용 → 전체 흐름 종합

**예시:**
[엄마 스레드]에 "『작품명』 99화에서..." 있으면 → title_ja는 이걸로 추출
마지막 [답변 3]에 "이미지 공유합니다" → action_required는 이 메시지의 의도 파악
` : ''}

[규칙]
1) translated_ko
   - 원문이 일본어 또는 중국어: 전체를 자연스러운 한국어로 번역 (요약 금지, 구조 유지)
   - 원문이 한국어: 원문 그대로 반환 (번역하지 말 것)
   - 고유명사는 일본어 원문 유지. 인용문은 원문 그대로.
2) source_lang — "ja" | "zh" | "ko" | "other"
3) summary_ko — 1~2문장 핵심 요약. 작품명이 포함될 경우 반드시 원문(일본어·중국어) 그대로 사용할 것 (번역 금지)
4) action_required — 담당자가 취해야 할 다음 액션 1문장. 작품명이 포함될 경우 반드시 원문(일본어·중국어) 그대로 사용할 것 (번역 금지)
5) title_ja — 일본어·중국어 작품명 원문 그대로 추출. 절대 번역하지 말 것. 괄호(「」『』<>《》【】 등)·(仮) 제거. 없으면 null
6) title_ko — 한국어 작품명 원문 그대로 추출. 절대 번역하지 말 것. 괄호·(仮) 제거. 없으면 null
7) inquiry_type — 아래 중 가장 적합한 하나만 선택. 판단 순서대로 적용할 것:
   - "스케줄 문의"     : 납품일·작업 일정 연장/변경 요청
   - "원본 파일 순서"  : 파일 순서·페이지 배열이 잘못됐다는 문의 (파일 자체는 존재하나 순서 오류)
   - "원본 파일 확인"  : 파일 자체의 물리적 결함으로 인해 작업이 불가능하여 파일 재전송이 필요한 경우. 해당: 파일 누락·손상·레이어 미분리·프리뷰와 작화 상이. 미해당(→작업 관련 문의): 대사 내용 확인, 말풍선 내용 질문, 원문 대사 검수, "이 대사가 맞나요" 류의 내용 판단 요청 — 이미지 공유 요청이 포함되어 있어도 목적이 대사 확인이면 "작업 관련 문의"로 분류.
   - "번역문 누락" : ★최우선 판단★ 번역문을 받지 못했거나 전달되지 않아 작업이 지연·불가한 경우. "번역문 못 받았어요", "번역문 안 왔어요", "번역문 누락", "번역문 받지 못하여 제출 지연", "번역문 전달 받는 대로 작업" 등 번역문 미수신이 원인인 경우. 제출 지연·작업 완료 언급이 있어도 번역문 미수신이 원인이면 반드시 "번역문 누락"으로 분류.
   - "번역문 확인" : 번역문 자체의 내용 이슈 — 오탈자·대사 불일치·번역문 내용 확인 요청 (예: "번역문 확인 부탁드려요", "대사가 다른 것 같아요"). 미해당(→작업 관련 문의): 회차 간(또는 작품 내) 설정·용어·수치가 서로 모순된다는 지적 — 예: "N화는 A인데 M화는 B", 장비/아이템 등급·점수·수치·명칭이 화수마다 다름. 어느 쪽이 맞는지 원문·설정 판단이 필요한 사안이므로 번역문 릴레이가 아닌 PM 문의로 처리.
   - "번역문 수정" : ★우선 판단★ 번역문 내용(오역·오탈자·표현 변경 등)을 수정하여 재전달하는 경우. 발신자가 번역가이거나, 번역문 수정본을 식자 작업자에게 전달하는 상황. 영어·일본어로 작성된 문의도 해당. "change translation", "翻訳を変更", "번역 수정", 수정 전/후 대사가 명시된 경우 모두 해당. 미해당(→수정&리테이크): 식자 완료 후 재작업, Totus 태스크 재오픈
   - "작업 관련 문의"  : 번역·식자 작업 내용 관련 질문. 대사 확인·내용 문의·원문 검수·작업 가능 여부 판단이 필요한 경우. 회차 간(또는 작품 내) 설정·용어·수치 모순을 지적하며 확인을 요청하는 경우 포함(어느 화가 맞는지 원문·설정 판단이 필요한 사안). 파일을 요청하더라도 목적이 내용 확인이면 여기에 해당. 단, 번역문 미수신이 원인인 경우는 "번역문 누락"으로 분류.
   - "수정&리테이크"   : 식자·식자검수 완료 후 재작업 요청, 또는 Totus 태스크 재오픈 요청 (예: "다시 열어주세요", "에디터 돌려주세요", "리테이크"). 식자 관련 수정에 한정. 미해당(→번역문 수정): 번역문 내용 수정 요청, 수정 전/후 대사가 명시된 경우
   - "복수 문의"       : 아래 중 하나라도 해당하면 복수 문의로 분류
       · 위 유형 중 2가지 이상이 혼재하는 경우
       · 동일 유형이라도 작품명이 2개 이상 언급된 경우 (예: A작품 130화 + B작품 60화 일정 조정 요청)
       · 단, 동일 작품의 연속/복수 화수(예: 130-132화, 130화·131화)는 유형에 따라 처리 방식이 다름:
         - 문의·재수급 유형: 단건으로 묶어서 처리 (화수별 분리 불필요)
         - 스케줄·파일순서·리테이크 유형: 화수별로 별도 항목으로 분리 (화수마다 독립적으로 처리해야 함)
   - "기타"            : 위 어느 유형에도 해당하지 않는 경우
   ※ route_ambiguous(릴레이/문의 경계 판단): "번역문 누락/확인/수정"(작업자에게 바로 전달하는 릴레이)인지 "작업 관련 문의"(어느 쪽이 맞는지 PM의 원문·설정 판단이 필요)인지 확신이 안 서는 경계 케이스면 true. 둘 중 하나가 명확하거나, 그 외 유형(스케줄·파일·리테이크·복수·기타 등)으로 명확히 분류되면 false.
8) priority — "높음" | "보통" | "낮음"
9) episode — 문의에서 언급된 화수(숫자만). 여러 화차면 첫 번째만. 없으면 null
10) pivo_id — PIVO ID로 추정되는 6자리 숫자. 문의 어디에 있든(줄 앞머리, 괄호 안, 문장 중간 등) 찾아서 추출.
    회차·날짜 등 자릿수가 다른 숫자와 혼동하지 말 것. 6자리 숫자가 확실치 않으면 null.

JSON만 출력. 코드블록 금지.
{"translated_ko":"string","source_lang":"string","summary_ko":"string","action_required":"string","title_ja":"string|null","title_ko":"string|null","inquiry_type":"string","priority":"string","episode":"string|null","pivo_id":"string|null","route_ambiguous":"boolean","multi_items":"array|null"}

multi_items: inquiry_type이 "복수 문의"인 경우에만 항목 배열 반환, 그 외 null
각 항목 형식:
{"type":"스케줄|재수급|파일순서|리테이크|문의|불명","work_title_ja":"string|null","work_title_ko":"string|null","episode":"string|null","extend_days":"number|null","requested_date":"string|null","reason":"string|null","content":"string|null","file_numbers":"array"}

스케줄 항목의 날짜 추출 규칙 (한국어·일본어·영어 모두 적용):
- requested_date: 목표 마감일 YYYY-MM-DD. 작성일 기준으로 변환.
  · 달력 날짜: "N월N일까지", "28일까지", "by May 10", "5/10" 등
  · 상대 목표일: "내일/明日/tomorrow"=작성일+1, "모레/明後日/the day after tomorrow"=작성일+2
  · "to/by/until tomorrow", "내일까지", "明日まで" 처럼 목표 마감일을 가리키면 모두 requested_date 로.
  · 작성일을 알 수 없으면 임의 추측 금지 → null
- extend_days: "추가 일수"가 명시된 경우에만 사용. 반드시 정수(예: 3)만. "N일 연장", "extend N days", "N more days" 등.
  · 위 목표일 표현(tomorrow 등)은 extend_days 가 아니라 requested_date 로 넣을 것.
  · 숫자가 아니면(문자열·불명) 반드시 null. 절대 "tomorrow" 같은 문자열을 넣지 말 것.

문의 메시지:
${sourceText}`.trim();

    const response = await alertOnError("Gemini(analyzeInquiry)", () =>
      ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt })
    );
    const cleaned  = (response.text || "").trim().replace(/```json|```/g, "").trim();
    const parsed   = JSON.parse(cleaned);
    return {
      translated_ko:   parsed.translated_ko   || "",
      source_lang:     parsed.source_lang     || "ja",
      summary_ko:      parsed.summary_ko      || "",
      action_required: parsed.action_required || "내용 확인 후 회신 필요",
      title_ja:        parsed.title_ja        || null,
      title_ko:        parsed.title_ko        || null,
      inquiry_type:    parsed.inquiry_type    || "기타",
      priority:        parsed.priority        || "보통",
      episode:         parsed.episode         || null,
      pivo_id:         parsed.pivo_id         || null,
      route_ambiguous: parsed.route_ambiguous === true,
      multi_items:     Array.isArray(parsed.multi_items) ? parsed.multi_items : null,
    };
  }

  // ── AI 파서 ───────────────────────────────────────────────
  async function parseScheduleInquiry(text, msgDate = null) {
    const dateContext = msgDate ? `문의 작성일(KST): ${msgDate}\n` : "";
    const prompt = `${dateContext}아래 문의에서 정보를 추출해줘.
1) work_title_ja: 일본어 작품명. 원문에서 한 글자도 바꾸지 말고 그대로 추출. <>꺾쇠만 제거. (없으면 null)
2) work_title_ko: 한국어 작품명. 원문에서 한 글자도 바꾸지 말고 그대로 추출. <>꺾쇠만 제거. (없으면 null)
3) episode: 회차 표현 그대로 (예: "236-238話"→"236-238", "49화"→"49", 없으면 null)
4) requested_date: 요청 마감 희망일 YYYY-MM-DD. 문의 작성일 기준으로 변환. (없으면 null)
   - 달력 날짜: "N월N일까지", "28일까지", "by May 10", "5/10" 등
   - 상대적 목표일(작성일 기준 며칠 뒤): "내일/明日/tomorrow"=작성일+1, "모레/明後日/the day after tomorrow"=작성일+2
   - "to/by/until tomorrow", "내일까지", "明日まで" 처럼 목표 마감일을 가리키는 표현은 모두 여기(requested_date)로 변환
5) extend_days: 연장 일수(현재 마감일에서 며칠 더) 숫자. 목표 마감일이 아니라 "추가 일수"가 명시된 경우에만 사용.
   - "N일 연장", "N일 늘려", "extend N days", "N more days", "push N days" 등 일수 직접 명시
   - 위 4)의 목표일 표현은 여기 넣지 말 것(requested_date로). 일수만 명시된 경우에만.
   판단 불가하면 null
6) worker_type: "번역" | "식자" | "불명"
JSON만 출력. 코드블록 금지.
문의: ${text}`.trim();
    const res = await alertOnError("Gemini(parseSchedule)", () =>
      ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt })
    );
    const parsed = JSON.parse((res.text || "").replace(/```json|```/g, "").trim());
    console.log("[parseSchedule] 파싱 결과:", JSON.stringify(parsed));
    return parsed;
  }

  async function parseFileInquiry(text) {
    const prompt = `
아래 문의에서 정보를 추출해줘.
1) work_title_ja: 일본어 또는 중국어 작품명. 괄호(「」『』<>《》【】 등) 제거 후 반환 (없으면 null)
2) work_title_ko: 한국어 작품명. 괄호 제거 후 반환 (없으면 null)
3) episode: 회차 숫자만 (예: "49화"→"49", 없으면 null)
4) file_numbers: 파일/페이지 번호 배열 (예: [5,6,7], 없으면 [])
5) reason_raw: 재수급 사유만 1문장. 작품명·회차·파일번호는 절대 포함하지 말 것. (없으면 null)
   - 원문이 일본어 또는 중국어인 경우: 자연스러운 한국어로 번역. 이때 작품명 등 고유명사는 번역하지 말고 완전히 제거할 것
   - 원문이 한국어인 경우: 원문 그대로 반환. 단 작품명이 포함되어 있으면 제거할 것
JSON만 출력. 코드블록 금지.
문의: ${text}`.trim();
    const res = await alertOnError("Gemini(parseFileInquiry)", () =>
      ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt })
    );
    return JSON.parse((res.text || "").replace(/```json|```/g, "").trim());
  }

  return { analyzeInquiryWithAI, parseScheduleInquiry, parseFileInquiry };
};
