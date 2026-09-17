"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const g = require("./guardrails.js");

function failEvent(exitCode) {
  return { isError: false, details: { exitCode }, content: [{ type: "text", text: `exit ${exitCode}` }] };
}

function okEvent(text) {
  return { isError: false, content: [{ type: "text", text }] };
}

describe("guardrails exact failure", () => {
  it("blocks the call after N identical Bash failures", () => {
    const c = g.createController({
      guardrailsEnabled: true,
      exactFailureWarnAfter: 2,
      exactFailureBlockAfter: 3,
    });
    const input = { command: "nope-xyz" };
    assert.equal(c.before("Bash", input), null);
    assert.equal(c.after("Bash", input, failEvent(1)), null);
    const warn = c.after("Bash", input, failEvent(1));
    assert.equal(warn.action, "warn");
    c.after("Bash", input, failEvent(1));
    const blocked = c.before("Bash", input);
    assert.equal(blocked.action, "block");
    assert.match(blocked.reason, /failed 3 times/);
  });

  it("does not block a different command", () => {
    const c = g.createController({
      guardrailsEnabled: true,
      exactFailureWarnAfter: 2,
      exactFailureBlockAfter: 3,
    });
    c.after("Bash", { command: "a" }, failEvent(1));
    c.after("Bash", { command: "a" }, failEvent(1));
    c.after("Bash", { command: "a" }, failEvent(1));
    assert.equal(c.before("Bash", { command: "b" }), null);
  });

  it("Write success clears failure counts", () => {
    const c = g.createController({
      guardrailsEnabled: true,
      exactFailureWarnAfter: 2,
      exactFailureBlockAfter: 3,
    });
    const input = { command: "a" };
    c.after("Bash", input, failEvent(1));
    c.after("Bash", input, failEvent(1));
    c.after("Bash", input, failEvent(1));
    c.after("Write", { path: "x" }, okEvent("ok"));
    assert.equal(c.before("Bash", input), null);
  });
});

describe("guardrails idempotent no progress", () => {
  it("blocks repeating the same Read result", () => {
    const c = g.createController({
      guardrailsEnabled: true,
      noProgressWarnAfter: 2,
      noProgressBlockAfter: 3,
    });
    const input = { path: "a.txt" };
    c.after("Read", input, okEvent("hello"));
    const warn = c.after("Read", input, okEvent("hello"));
    assert.equal(warn.action, "warn");
    c.after("Read", input, okEvent("hello"));
    const blocked = c.before("Read", input);
    assert.equal(blocked.action, "block");
  });

  it("does not treat a changed Read as a loop", () => {
    const c = g.createController({
      guardrailsEnabled: true,
      noProgressWarnAfter: 2,
      noProgressBlockAfter: 3,
    });
    const input = { path: "a.txt" };
    c.after("Read", input, okEvent("v1"));
    c.after("Read", input, okEvent("v2"));
    c.after("Read", input, okEvent("v2"));
    assert.equal(c.before("Read", input), null);
  });
});

describe("guardrails misc", () => {
  it("exempts memory", () => {
    const c = g.createController({
      guardrailsEnabled: true,
      exactFailureBlockAfter: 1,
    });
    c.after("memory", { action: "add" }, { isError: true, content: "Error" });
    assert.equal(c.before("memory", { action: "add" }), null);
  });

  it("disabled is a no-op", () => {
    const c = g.createController({ guardrailsEnabled: false, exactFailureBlockAfter: 1 });
    c.after("Bash", { command: "x" }, failEvent(1));
    assert.equal(c.before("Bash", { command: "x" }), null);
  });

  it("isFailed reads exitCode", () => {
    assert.equal(g.isFailed(failEvent(1)), true);
    assert.equal(g.isFailed(okEvent("ok")), false);
    assert.equal(g.isFailed({ isError: true }), true);
  });

  it("appendNotice keeps prior content", () => {
    const next = g.appendNotice([{ type: "text", text: "out" }], "stop");
    assert.equal(next[0].text, "out");
    assert.match(next[1].text, /grok-enhance/);
  });
});
