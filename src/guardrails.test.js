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

describe("failure classification", () => {
  it("does not infer errors from Read bodies or embedded JSON examples", () => {
    for (const text of ["Error handling guide", '{"exitCode":1}', '{"isError":true}', 'const example = {"exit_code":2};']) {
      assert.equal(g.isFailed(okEvent(text), "Read"), false, text);
      const c = g.createController({ exactFailureBlockAfter: 1 });
      c.after("Read", { path: text }, okEvent(text));
      assert.equal(c.before("Read", { path: text }), null);
    }
  });

  it("accepts only structured shell exit codes, with metadata taking precedence", () => {
    assert.equal(g.isFailed(okEvent('{"exitCode":2}'), "Bash"), true);
    assert.equal(g.isFailed(okEvent('{"exit_code":2}'), "Bash"), true);
    assert.equal(g.isFailed({ toolName: "Bash", content: '{"exitCode":2}' }), true);
    assert.equal(g.isFailed(okEvent('output: {"exitCode":2}'), "Bash"), false);
    assert.equal(g.isFailed(okEvent('{"example":{"exitCode":2}}'), "Bash"), false);
    assert.equal(g.isFailed({ ...okEvent('{"exitCode":2}'), details: { exit_code: 0 } }, "Bash"), false);
    assert.equal(g.isFailed({ isError: true, details: { exitCode: 0 } }, "Read"), true);
    assert.equal(g.isFailed({ isError: false, details: { exit_code: 2 } }, "Read"), true);
  });
});

describe("tool-wide consecutive failures", () => {
  it("warns after three changed-argument failures and blocks after eight", () => {
    const c = g.createController({});
    for (let i = 1; i <= 8; i += 1) {
      const input = { command: `missing-${i}` };
      assert.equal(c.before("Bash", input), null);
      const decision = c.after("Bash", input, failEvent(1));
      if (i === 3) assert.equal(decision?.action, "warn");
      // Another tool succeeding must not reset Bash's streak.
      c.after("Read", { path: `file-${i}` }, okEvent("ok"));
    }
    assert.equal(c.before("Bash", { command: "missing-9" })?.action, "block");
    assert.equal(c.before("Grep", { pattern: "alternative" }), null);
  });

  it("honors tool-wide thresholds and resets that tool on success", () => {
    const c = g.createController({ toolFailureWarnAfter: 2, toolFailureBlockAfter: 4 });
    for (let i = 0; i < 4; i += 1) {
      const decision = c.after("Bash", { command: `bad-${i}` }, failEvent(1));
      if (i === 1) assert.equal(decision?.action, "warn");
    }
    assert.equal(c.before("Bash", { command: "new" })?.action, "block");
    c.after("Bash", { command: "recovered" }, okEvent("ok"));
    assert.equal(c.before("Bash", { command: "new" }), null);
    c.after("Bash", { command: "bad-0" }, failEvent(1));
    assert.equal(c.before("Bash", { command: "bad-0" }), null);
  });

  for (const tool of ["Write", "Edit"]) {
    it(`${tool} success clears all tool-wide and exact failure counts`, () => {
      const c = g.createController({ toolFailureBlockAfter: 2, exactFailureBlockAfter: 2 });
      for (let i = 0; i < 2; i += 1) {
        c.after("Bash", { command: "bad" }, failEvent(1));
        c.after("Grep", { pattern: "bad" }, failEvent(1));
      }
      c.after(tool, { path: "file" }, failEvent(1));
      assert.equal(c.before("Bash", { command: "other" })?.action, "block");
      c.after(tool, { path: "file" }, okEvent("written"));
      assert.equal(c.before("Bash", { command: "bad" }), null);
      assert.equal(c.before("Grep", { pattern: "other" }), null);
    });
  }

  it("does not count guard-generated blocked results as new failures", () => {
    const c = g.createController({});
    const input = { command: "bad" };
    for (let i = 0; i < 3; i += 1) c.after("Bash", input, failEvent(1));
    const first = c.before("Bash", input);
    for (let i = 0; i < 10; i += 1) {
      const blocked = c.before("Bash", input);
      assert.deepEqual(blocked, first);
      assert.equal(c.after("Bash", input, { isError: true, content: blocked.reason }), null);
    }
    assert.equal(c.before("Bash", { command: "alternative" }), null);
  });
});

const cycleCalls = [
  ["Read", { path: "a", offset: 0 }, "alpha"],
  ["Grep", { pattern: "b" }, "beta"],
  ["Glob", { pattern: "c*" }, "gamma"],
  ["Read", { path: "d" }, "delta"],
];

function runCycle(c, calls, round) {
  const decisions = [];
  for (const [name, input, text] of calls) {
    assert.equal(c.before(name, input), null, `round ${round}: ${name}`);
    // Reordered input keys must have the same signature.
    decisions.push(c.after(name, Object.fromEntries(Object.entries(input).reverse()), okEvent(text)));
  }
  return decisions;
}

describe("read-only cycles", () => {
  for (const period of [2, 3, 4]) {
    it(`warns on two cycles and blocks only the expected next call for period ${period}`, () => {
      const c = g.createController({});
      const calls = cycleCalls.slice(0, period);
      runCycle(c, calls, 1);
      assert.equal(runCycle(c, calls, 2).at(-1)?.action, "warn");
      runCycle(c, calls, 3);
      assert.equal(c.before(calls[0][0], calls[0][1])?.action, "block");
      for (const [name, input] of calls.slice(1)) assert.equal(c.before(name, input), null);
      assert.equal(c.before("Read", { path: "new-strategy" }), null);
      assert.equal(c.before("Bash", { command: "inspect" }), null);
      const alternative = calls[1];
      c.after(alternative[0], alternative[1], okEvent(alternative[2]));
      assert.equal(c.before(calls[0][0], calls[0][1]), null);
    });
  }

  it("uses the result fingerprint, not only tool names and arguments", () => {
    const c = g.createController({});
    for (let i = 0; i < 10; i += 1) {
      runCycle(c, [["Read", { path: "a" }, `version-${i}`], cycleCalls[1]], i);
    }
    assert.equal(c.before("Read", { path: "a" }), null);
  });

  it("fingerprints non-text result content and structured details too", () => {
    const c = g.createController({});
    const input = { path: "image" };
    for (let i = 0; i < 8; i += 1) {
      assert.equal(c.before("Read", input), null);
      c.after("Read", input, { content: [{ type: "image", data: `image-${i}` }], details: { revision: i } });
    }
  });

  it("unlocks on a new real result even after a block decision", () => {
    const c = g.createController({});
    const calls = cycleCalls.slice(0, 2);
    for (let i = 0; i < 3; i += 1) runCycle(c, calls, i);
    assert.equal(c.before(calls[0][0], calls[0][1])?.action, "block");
    c.after(calls[0][0], calls[0][1], okEvent("changed externally"));
    assert.equal(c.before(calls[0][0], calls[0][1]), null);
    assert.equal(c.before(calls[1][0], calls[1][1]), null);
  });

  for (const tool of ["Write", "Edit"]) {
    it(`${tool} success unlocks cycles and repeated single reads`, () => {
      const c = g.createController({});
      const calls = cycleCalls.slice(0, 2);
      for (let i = 0; i < 3; i += 1) runCycle(c, calls, i);
      assert.equal(c.before(calls[0][0], calls[0][1])?.action, "block");
      c.after(tool, { path: "a" }, failEvent(1));
      assert.equal(c.before(calls[0][0], calls[0][1])?.action, "block");
      c.after(tool, { path: "a" }, okEvent("written"));
      runCycle(c, calls, 1);
      for (let i = 0; i < 3; i += 1) c.after("Read", { path: "single" }, okEvent("same"));
      assert.equal(c.before("Read", { path: "single" })?.action, "block");
      c.after(tool, { path: "single" }, okEvent("written"));
      assert.equal(c.before("Read", { path: "single" }), null);
    });
  }

  it("does not turn cycle-block results into tool failures or new progress", () => {
    const c = g.createController({});
    const calls = cycleCalls.slice(0, 2);
    for (let i = 0; i < 3; i += 1) runCycle(c, calls, i);
    for (let i = 0; i < 10; i += 1) {
      const decision = c.before(calls[0][0], calls[0][1]);
      assert.equal(decision?.action, "block");
      assert.equal(c.after(calls[0][0], calls[0][1], { isError: true, content: decision.reason }), null);
    }
    assert.equal(c.before("Read", { path: "different" }), null);
  });

  it("honors configured cycle thresholds", () => {
    const c = g.createController({ cycleWarnAfter: 3, cycleBlockAfter: 4 });
    const calls = cycleCalls.slice(0, 2);
    runCycle(c, calls, 1);
    assert.equal(runCycle(c, calls, 2).at(-1), null);
    assert.equal(runCycle(c, calls, 3).at(-1)?.action, "warn");
    runCycle(c, calls, 4);
    assert.equal(c.before(calls[0][0], calls[0][1])?.action, "block");
  });

  it("does not classify ordinary successful Bash as a read-only loop", () => {
    const c = g.createController({});
    for (let i = 0; i < 10; i += 1) {
      assert.equal(c.before("Bash", { command: "echo ok" }), null);
      assert.equal(c.after("Bash", { command: "echo ok" }, okEvent("ok")), null);
    }
  });
});

describe("exemptions and lifecycle bounds", () => {
  for (const pollingTools of [undefined, "CustomWait, Read", ["CustomWait", "Read"]]) {
    it(`exempts polling and interaction tools with config ${JSON.stringify(pollingTools)}`, () => {
      const c = g.createController({ pollingTools, exactFailureBlockAfter: 1 });
      const names = ["TaskWait", "TaskList", "ask", "AskQuestion", "submitplan"];
      if (pollingTools) names.push("CustomWait", "Read");
      for (const name of names) {
        for (let i = 0; i < 10; i += 1) {
          assert.equal(c.before(name, {}), null);
          assert.equal(c.after(name, {}, i % 2 ? failEvent(1) : okEvent("pending")), null);
        }
      }
    });
  }

  it("supports reset and live configuration changes", () => {
    const c = g.createController({ toolFailureBlockAfter: 1 });
    c.after("Bash", {}, failEvent(1));
    assert.equal(c.before("Bash", {})?.action, "block");
    c.setConfig({ guardrailsEnabled: false });
    assert.equal(c.before("Bash", {}), null);
    assert.equal(c.after("Bash", {}, failEvent(1)), null);
    c.reset();
    c.setConfig({});
    assert.equal(c.before("Bash", {}), null);
  });

  it("bounds every state map to 256 entries under long-session load", () => {
    const NativeMap = global.Map;
    const maps = [];
    let c;
    try {
      global.Map = class extends NativeMap {
        constructor(...args) { super(...args); maps.push(this); }
      };
      c = g.createController({ exactFailureBlockAfter: 1, toolFailureBlockAfter: 1 });
    } finally {
      global.Map = NativeMap;
    }
    for (let i = 0; i < 1000; i += 1) {
      c.after(`Tool${i}`, { value: i }, failEvent(1));
      c.before(`Tool${i}`, { value: i });
      c.after("Read", { path: `file-${i}` }, okEvent(`content-${i}`));
    }
    assert.ok(maps.length >= 2);
    for (const map of maps) assert.ok(map.size <= 256, `map grew to ${map.size}`);
    assert.equal(c.before("Tool0", { value: 0 }), null);
    assert.equal(c.before("Tool999", { value: 999 })?.action, "block");
  });

  it("does not retain a stale cycle outside the 64-result window", () => {
    const c = g.createController({});
    for (let i = 0; i < 3; i += 1) runCycle(c, cycleCalls.slice(0, 2), i);
    for (let i = 0; i < 70; i += 1) c.after("Read", { path: `new-${i}` }, okEvent(`new-${i}`));
    runCycle(c, cycleCalls.slice(0, 2), "after window");
  });

  it("caps cycle evidence at 64 results even with higher configured thresholds", () => {
    const c = g.createController({ cycleBlockAfter: 33 });
    for (let i = 0; i < 80; i += 1) runCycle(c, cycleCalls.slice(0, 2), i);
    assert.equal(c.before(cycleCalls[0][0], cycleCalls[0][1]), null);
  });
});
