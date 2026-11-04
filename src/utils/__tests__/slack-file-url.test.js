"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { assertSlackFileUrl } = require("../slack-file-url");

describe("assertSlackFileUrl", () => {
  for (const url of [
    "https://files.slack.com/files-pri/T0-F0B04ENE8LB/thumb.png",
    "https://files.slack.com/files-pri/T0-F0B04ENE8LB/download/thumb.png",
  ]) {
    test(`허용: ${url}`, () => {
      assert.doesNotThrow(() => assertSlackFileUrl(url));
    });
  }

  for (const url of [
    "http://files.slack.com/files-pri/T0-F0B04ENE8LB/thumb.png",
    "https://attacker.example/files-pri/thumb.png",
    "https://files.slack.com.attacker.example/files-pri/thumb.png",
    "https://evilfiles.slack.com/files-pri/thumb.png",
    "https://files.slack.com@attacker.example/files-pri/thumb.png",
    "https://attacker.example\\@files.slack.com/files-pri/thumb.png",
    "https://attacker.example#files.slack.com/files-pri/",
    "https://slack.com/api/auth.revoke",
    "https://jamake.slack.com/api/chat.postMessage?channel=C0&text=x",
    "https://files.slack.com/api/auth.revoke",
    "https://files.slack.com/files-pri/../api/auth.revoke",
    "https://files.slack.com/files-pri/%2e%2e/api/auth.revoke",
    "https://jamake.slack.com/files/U0/F0B04ENE8LB/thumb.png",
    "not a url",
    "",
    undefined,
  ]) {
    test(`거부: ${url}`, () => {
      assert.throws(() => assertSlackFileUrl(url), /Slack 파일 주소가 아님/);
    });
  }
});
