"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const cfg = require("./config.js");

function harness(t, model = { id: "grok-4.6" }, overrides = {}) {
  assert.ok(process.env.PI_SCRATCH_DIR, "Tests require PI_SCRATCH_DIR");
  const home = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR, "grok-extension-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".pi", "agent", "grok-enhance");
  const profile = path.join(home, ".pi", "agent", "user-profile");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "USER.md"), "Fixture user");
  fs.writeFileSync(path.join(profile, "nudge-state.json"), '{"pending":true}');
  cfg.saveConfig(root, overrides);
  const filename = path.join(__dirname, "extension.js");
  const realRequire = createRequire(filename);
  const wrappedRequire = (name) => name === "./config.js" ? { ...cfg, defaultRoot: () => root }
    : name === "node:os" ? { ...os, homedir: () => home } : realRequire(name);
  wrappedRequire.resolve = realRequire.resolve;
  wrappedRequire.cache = {};
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports, require: wrappedRequire, console, process }, { filename });
  const handlers = new Map();
  const active = ["Read", "Write", "Edit", "Bash"];
  const all = [...active, "Grep", "Glob", "memory", "skill_manage"];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    getActiveTools: () => active.slice(),
    getAllTools: () => all.map((name) => ({ name })),
    setActiveTools(names) { active.splice(0, active.length, ...names); },
  };
  module.exports(pi);
  const ctx = { model, sessionManager: { getSessionId: () => "fixture-session" } };
  return {
    ctx, active, root,
    emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
    pending: () => JSON.parse(fs.readFileSync(path.join(profile, "nudge-state.json"), "utf8")).pending,
  };
}

test("non-Grok and unknown models do not inject, activate, consume profile or block", async (t) => {
  for (const model of [{ id: "gpt-5.6", provider: "xai" }, undefined]) {
    const h = harness(t, model);
    h.ctx.model = model;
    assert.equal(await h.emit("before_agent_start", { systemPrompt: "HOST" }), undefined);
    assert.deepEqual(h.active, ["Read", "Write", "Edit", "Bash"]);
    assert.equal(h.pending(), true);
    for (let i = 0; i < 5; i++) {
      assert.equal(h.emit("tool_result", { toolName: "Bash", input: { command: "bad" }, isError: true }), undefined);
    }
    assert.equal(h.emit("tool_call", { toolName: "Bash", input: { command: "bad" } }), undefined);
  }
});

test("Grok uses ctx.model, activates tools and blocks repeated failures within a request", async (t) => {
  const h = harness(t);
  const prompt = await h.emit("before_agent_start", { systemPrompt: "HOST" });
  assert.match(prompt.systemPrompt, /exec-discipline: grok-v1/);
  assert.equal(h.active.includes("Grep"), true);
  assert.equal(h.pending(), false);
  for (let i = 0; i < 3; i++) h.emit("tool_result", { toolName: "Bash", input: { command: "bad" }, isError: true });
  assert.equal(h.emit("tool_call", { toolName: "Bash", input: { command: "bad" }, toolCallId: "blocked" }).block, true);
  await h.emit("before_agent_start", { systemPrompt: "HOST" });
  assert.equal(h.emit("tool_call", { toolName: "Bash", input: { command: "bad" } }), undefined);
});

test("changing model or disabling clears Grok guard state", async (t) => {
  const h = harness(t);
  await h.emit("before_agent_start", { systemPrompt: "HOST" });
  for (let i = 0; i < 3; i++) h.emit("tool_result", { toolName: "Bash", input: { command: "bad" }, isError: true });
  h.ctx.model = { id: "claude-opus-4" };
  assert.equal(h.emit("tool_call", { toolName: "Bash", input: { command: "bad" } }), undefined);
  h.ctx.model = { id: "grok-4.6" };
  assert.equal(h.emit("tool_call", { toolName: "Bash", input: { command: "bad" } }), undefined);
  cfg.saveConfig(h.root, { enabled: false });
  assert.equal(await h.emit("before_agent_start", { systemPrompt: "HOST" }), undefined);
});

test("disabled Grok plugin never consumes the pending profile nudge", async (t) => {
  const h = harness(t, { id: "grok-4.6" }, { enabled: false });
  assert.equal(await h.emit("before_agent_start", { systemPrompt: "HOST" }), undefined);
  assert.equal(h.pending(), true);
});

test("custom provider and endpoint still receive all Grok enhancements", async (t) => {
  const h = harness(t, { id: "grok-4.7", provider: "custom-provider-uuid", baseUrl: "https://proxy.example/v1" });
  assert.match((await h.emit("before_agent_start", { systemPrompt: "HOST" })).systemPrompt, /exec-discipline/);
  assert.equal(h.active.includes("Glob"), true);
  for (let i = 0; i < 3; i++) h.emit("tool_result", { toolName: "Bash", input: { command: "bad" }, isError: true });
  assert.equal(h.emit("tool_call", { toolName: "Bash", input: { command: "bad" } }).block, true);
});

test("model_select clears state even when no tool runs between switches", async (t) => {
  const h = harness(t);
  await h.emit("before_agent_start", { systemPrompt: "HOST" });
  for (let i = 0; i < 3; i++) h.emit("tool_result", { toolName: "Bash", input: { command: "bad" }, isError: true });
  h.emit("model_select", { model: { id: "gpt-5.6" } });
  h.emit("model_select", { model: { id: "grok-4.6" } });
  assert.equal(h.emit("tool_call", { toolName: "Bash", input: { command: "bad" } }), undefined);
});

test("a blocked retry does not swallow a concurrent real failure", async (t) => {
  const h = harness(t, { id: "grok-4.6" }, { toolFailureBlockAfter: 4 });
  await h.emit("before_agent_start", { systemPrompt: "HOST" });
  const call = { toolName: "Bash", input: { command: "bad" } };
  for (let i = 0; i < 2; i++) h.emit("tool_result", { ...call, isError: true });
  assert.equal(h.emit("tool_call", { ...call, toolCallId: "first" }), undefined);
  assert.equal(h.emit("tool_call", { ...call, toolCallId: "second" }), undefined);
  h.emit("tool_result", { ...call, toolCallId: "first", isError: true });
  const blocked = h.emit("tool_call", { ...call, toolCallId: "blocked" });
  assert.equal(blocked.block, true);
  h.emit("tool_result", { ...call, toolCallId: "blocked", isError: true, content: blocked.reason });
  h.emit("tool_result", { ...call, toolCallId: "second", isError: true, content: "actual failure" });
  assert.equal(h.emit("tool_call", { toolName: "Bash", input: { command: "changed" } }).block, true);
});
