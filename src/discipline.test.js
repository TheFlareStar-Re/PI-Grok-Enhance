"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const discipline = require("./discipline.js");
const tools = require("./tools.js");
const cfg = require("./config.js");

describe("discipline", () => {
  it("exports a unique marker", () => {
    assert.equal(discipline.DISCIPLINE.includes(discipline.MARKER), true);
    assert.equal(discipline.MARKER, "exec-discipline: grok-v1");
  });

  it("compose is idempotent", () => {
    const once = discipline.composePrompt("HOST", "", true);
    const twice = discipline.composePrompt(once, "", true);
    const count = twice.split(discipline.MARKER).length - 1;
    assert.equal(count, 1);
  });

  it("keeps USER PROFILE when adding discipline", () => {
    const peer = "USER PROFILE (who the user is)\n- 耀星";
    const out = discipline.composePrompt("HOST", peer, true);
    assert.equal(out.includes("HOST"), true);
    assert.equal(out.includes("USER PROFILE (who the user is)"), true);
    assert.equal(out.includes(discipline.MARKER), true);
  });

  it("does not duplicate USER PROFILE", () => {
    const base = "HOST\n\nUSER PROFILE (who the user is)\n- x";
    const out = discipline.composePrompt(base, "USER PROFILE (who the user is)\n- y", false);
    assert.equal(out.split("USER PROFILE (who the user is)").length - 1, 1);
  });

  it("applies only to a known Grok model", () => {
    assert.equal(discipline.shouldApplyDiscipline({ id: "grok-4.6", provider: "xai" }, { disciplineEnabled: true }), true);
    for (const model of [{ id: "claude-opus-4-6" }, {}, undefined]) {
      assert.equal(discipline.shouldApplyDiscipline(model, { disciplineEnabled: true, disciplineOnAllModels: true }), false);
    }
    assert.equal(discipline.shouldApplyDiscipline({ id: "grok-4.6" }, { enabled: false }), false);
  });
});

describe("tools", () => {
  it("unions extras onto getActiveTools and skips unknown names", () => {
    const active = ["Read", "Write", "Edit", "Bash", "ToolSearch"];
    const all = [...active, "Grep", "Glob", "memory"];
    const pi = {
      getActiveTools: () => active.slice(),
      getAllTools: () => all.map((name) => ({ name, active: active.includes(name) })),
      setActiveTools(names) {
        this.last = names;
      },
    };
    const result = tools.unionActivate(pi, ["Grep", "Glob", "memory", "skill_manage", "Nope"]);
    assert.deepEqual(result.added.sort(), ["Glob", "Grep", "memory"]);
    assert.equal(pi.last.includes("Read"), true);
    assert.equal(pi.last.includes("Grep"), true);
    assert.equal(pi.last.includes("skill_manage"), false);
    assert.equal(pi.last.includes("Nope"), false);
  });
});

describe("config", () => {
  it("parses extra tool names", () => {
    assert.deepEqual(cfg.parseToolNames("Grep, Glob, memory"), ["Grep", "Glob", "memory"]);
  });
});
