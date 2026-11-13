"use strict";

// 게이트웨이 변경 요청에 항상 동봉하는 확인 헤더.
const GATEWAY_MUTATION_HEADERS = Object.freeze({
  "X-Confirm-Mutation": "I-UNDERSTAND-PROD",
});

module.exports = { GATEWAY_MUTATION_HEADERS };
