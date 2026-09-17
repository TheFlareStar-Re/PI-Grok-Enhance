"use strict";

const IDEMPOTENT = new Set(["read", "grep", "glob", "ls", "find"]);
const EXEMPT = new Set([
  "memory",
  "skill_manage",
  "ask",
  "askquestion",
  "submitplan",
  "submitgoal",
  "enterplanmode",
  "entergoalmode",
]);
const MUTATING = new Set(["write", "edit"]);

function normName(name) {
  return String(name || "").trim().toLowerCase();
}

function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function signature(name, input) {
  return `${normName(name)}\0${stableStringify(input && typeof input === "object" ? input : { value: input })}`;
}

function resultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        return part.text || part.content || "";
      })
      .join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function djb2(text) {
  let h = 5381;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h, 33) ^ s.charCodeAt(i);
  return String(h >>> 0);
}

function exitCodeOf(event) {
  const details = event && event.details;
  if (details && typeof details === "object") {
    if (details.exitCode != null) return Number(details.exitCode);
    if (details.exit_code != null) return Number(details.exit_code);
  }
  const text = resultText(event && event.content);
  const m = text.match(/"exit(?:Code|_code)"\s*:\s*(-?\d+)/);
  if (m) return Number(m[1]);
  return undefined;
}

function isFailed(event) {
  if (!event) return false;
  if (event.isError === true) return true;
  const code = exitCodeOf(event);
  if (code !== undefined && Number.isFinite(code) && code !== 0) return true;
  const text = resultText(event.content);
  if (/^\s*Error\b/i.test(text)) return true;
  if (/"isError"\s*:\s*true/.test(text)) return true;
  return false;
}

function appendNotice(content, message) {
  const line = `\n[grok-enhance] ${message}`;
  if (Array.isArray(content)) {
    return [...content, { type: "text", text: line }];
  }
  if (typeof content === "string") return `${content}${line}`;
  if (content == null) return [{ type: "text", text: line.trim() }];
  return [{ type: "text", text: `${resultText(content)}${line}` }];
}

function createController(config) {
  const state = {
    exactFail: new Map(),
    noProgress: new Map(),
  };

  function cfg() {
    return config || {};
  }

  function reset() {
    state.exactFail = new Map();
    state.noProgress = new Map();
  }

  function setConfig(next) {
    config = next;
  }

  function enabled() {
    return cfg().guardrailsEnabled !== false;
  }

  function before(name, input) {
    if (!enabled()) return null;
    const key = normName(name);
    if (EXEMPT.has(key)) return null;
    const sig = signature(name, input);
    const failCount = state.exactFail.get(sig) || 0;
    const blockAfter = Number(cfg().exactFailureBlockAfter || 3);
    if (failCount >= blockAfter) {
      return {
        action: "block",
        reason: `Blocked ${name}: the same call failed ${failCount} times with identical arguments. Change the command/query or explain the blocker.`,
      };
    }
    const rec = state.noProgress.get(sig);
    const npBlock = Number(cfg().noProgressBlockAfter || 3);
    if (rec && rec.count >= npBlock) {
      return {
        action: "block",
        reason: `Blocked ${name}: this read-only call returned the same result ${rec.count} times. Use what you already have or change the query.`,
      };
    }
    return null;
  }

  function after(name, input, event) {
    if (!enabled()) return null;
    const key = normName(name);
    if (EXEMPT.has(key)) return null;
    const sig = signature(name, input);
    if (isFailed(event)) {
      const n = (state.exactFail.get(sig) || 0) + 1;
      state.exactFail.set(sig, n);
      state.noProgress.delete(sig);
      const warnAfter = Number(cfg().exactFailureWarnAfter || 2);
      const blockAfter = Number(cfg().exactFailureBlockAfter || 3);
      if (n >= warnAfter && n < blockAfter) {
        return {
          action: "warn",
          message: `${name} has failed ${n} times with identical arguments. The next identical retry will be blocked. Change strategy.`,
        };
      }
      return null;
    }
    state.exactFail.delete(sig);
    if (MUTATING.has(key)) {
      state.exactFail.clear();
      state.noProgress.clear();
      return null;
    }
    if (!IDEMPOTENT.has(key)) {
      state.noProgress.delete(sig);
      return null;
    }
    const hash = djb2(resultText(event && event.content));
    const prev = state.noProgress.get(sig);
    if (prev && prev.hash === hash) {
      prev.count += 1;
      const warnAfter = Number(cfg().noProgressWarnAfter || 2);
      const blockAfter = Number(cfg().noProgressBlockAfter || 3);
      if (prev.count >= warnAfter && prev.count < blockAfter) {
        return {
          action: "warn",
          message: `${name} returned the same result ${prev.count} times. Do not repeat it unchanged.`,
        };
      }
      return null;
    }
    state.noProgress.set(sig, { hash, count: 1 });
    return null;
  }

  return { reset, setConfig, before, after, signature, isFailed, resultText, appendNotice };
}

module.exports = {
  IDEMPOTENT,
  EXEMPT,
  MUTATING,
  signature,
  stableStringify,
  resultText,
  djb2,
  isFailed,
  appendNotice,
  createController,
};
