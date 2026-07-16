// 단일 책임: APM 이름 → Slack ID 매핑을 제공한다
// 납품 시트 D열 텍스트 기준. 추가 시 여기에 등록.
// 장기적으로는 Totus 프로젝트 APM 값으로 대체 예정.
"use strict";

const APM_SLACK_ID_MAP = {
  "서주원": "U07E0QPL8MV",
  "정태영": "U05CE8HFA6B",
  "오화진": "U02GPTNGZ5W",
  "박재상": "U04463JR4HH",
};

module.exports = { APM_SLACK_ID_MAP };
