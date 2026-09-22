"use strict";

const { createHash } = require("node:crypto");

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
const POLLING = new Set(["taskwait", "tasklist"]);
const SHELL = new Set(["bash", "shell", "powershell"]);
const STATE_LIMIT = 256;
const HISTORY_LIMIT = 64;

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

function structuredExitCode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const code = value.exitCode ?? value.exit_code;
  if (typeof code !== "number" && (typeof code !== "string" || !code.trim())) return undefined;
  const n = Number(code);
  return Number.isFinite(n) ? n : undefined;
}

function exitCodeOf(event, name) {
  const code = structuredExitCode(event && event.details);
  if (code !== undefined) return code;
  if (!SHELL.has(normName(name || (event && event.toolName)))) return undefined;
  try {
    // Only a complete shell result envelope is metadata; source text is not.
    return structuredExitCode(JSON.parse(resultText(event && event.content)));
  } catch {
    return undefined;
  }
}

function isFailed(event, name) {
  if (!event) return false;
  if (event.isError === true) return true;
  const code = exitCodeOf(event, name);
  return code !== undefined && code !== 0;
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

function boundedSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > STATE_LIMIT) map.delete(map.keys().next().value);
}

function resultFingerprint(event) {
  // Hash the actual payload, including non-text data, but not call IDs or notices.
  return createHash("sha256")
    .update(stableStringify({ content: event && event.content, details: event && event.details }))
    .digest("hex");
}

function repeatedCycle(history) {
  const n = history.length;
  for (let period = 2; period <= 4 && period * 2 <= n; period += 1) {
    const tail = history.slice(n - period);
    // Single-call repetition belongs to the no-progress rule, not a longer cycle.
    if (new Set(tail.map((entry) => entry.sig)).size < 2) continue;
    let count = 1;
    while ((count + 1) * period <= n) {
      const start = n - (count + 1) * period;
      if (!tail.every((entry, i) => entry.sig === history[start + i].sig && entry.hash === history[start + i].hash)) break;
      count += 1;
    }
    if (count >= 2) return { period, count, nextSig: tail[0].sig };
  }
  return null;
}

function createController(config) {
  const state = {
    exactFail: new Map(),
    toolFail: new Map(),
    noProgress: new Map(),
    blocked: new Map(),
    history: [],
  };

  function cfg() {
    return config || {};
  }

  function threshold(field, fallback) {
    const n = Number(cfg()[field]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) || fallback : fallback;
  }

  function clearReads() {
    state.noProgress.clear();
    state.history.length = 0;
  }

  function reset() {
    state.exactFail.clear();
    state.toolFail.clear();
    state.blocked.clear();
    clearReads();
  }

  function setConfig(next) {
    config = next;
  }

  function enabled() {
    return cfg().guardrailsEnabled !== false;
  }

  function exempt(key) {
    const tools = cfg().pollingTools;
    const names = Array.isArray(tools) ? tools : typeof tools === "string" ? tools.split(",") : [];
    return EXEMPT.has(key) || POLLING.has(key) || names.some((name) => normName(name) === key);
  }

  function block(sig, reason) {
    boundedSet(state.blocked, sig, reason);
    return { action: "block", reason };
  }

  function before(name, input) {
    if (!enabled()) return null;
    const key = normName(name);
    if (exempt(key)) return null;
    const sig = signature(name, input);
    const failCount = state.exactFail.get(sig) || 0;
    if (failCount >= threshold("exactFailureBlockAfter", 3)) {
      return block(sig, `Blocked ${name}: the same call failed ${failCount} times with identical arguments. Change the command/query or explain the blocker.`);
    }
    const toolCount = state.toolFail.get(key) || 0;
    if (toolCount >= threshold("toolFailureBlockAfter", 8)) {
      return block(sig, `Blocked ${name}: this tool failed ${toolCount} consecutive times, including calls with different arguments. Use another tool or explain the blocker.`);
    }
    const rec = state.noProgress.get(sig);
    if (state.history.at(-1)?.sig === sig && rec && rec.count >= threshold("noProgressBlockAfter", 3)) {
      return block(sig, `Blocked ${name}: this read-only call returned the same result ${rec.count} times. Use what you already have or change the query.`);
    }
    const cycle = repeatedCycle(state.history);
    if (cycle && cycle.nextSig === sig && cycle.count >= threshold("cycleBlockAfter", 3)) {
      return block(sig, `Blocked ${name}: a ${cycle.period}-call read-only sequence repeated ${cycle.count} times with unchanged results. Change strategy instead of continuing the sequence.`);
    }
    state.blocked.delete(sig);
    return null;
  }

  function after(name, input, event) {
    if (!enabled()) return null;
    const key = normName(name);
    if (exempt(key)) return null;
    const sig = signature(name, input);
    const failed = isFailed(event, name);
    const blockedReason = state.blocked.get(sig);
    state.blocked.delete(sig);
    // The host may emit a tool_result for a rejected tool_call. It did not run.
    // A real successful result (e.g. an in-flight call) must still unlock progress.
    if (blockedReason && resultText(event && event.content).includes(blockedReason)) return null;
    if (failed) {
      const n = (state.exactFail.get(sig) || 0) + 1;
      const toolCount = (state.toolFail.get(key) || 0) + 1;
      boundedSet(state.exactFail, sig, n);
      boundedSet(state.toolFail, key, toolCount);
      state.noProgress.delete(sig);
      if (IDEMPOTENT.has(key)) state.history.length = 0;
      if (n >= threshold("exactFailureWarnAfter", 2) && n < threshold("exactFailureBlockAfter", 3)) {
        return {
          action: "warn",
          message: `${name} has failed ${n} times with identical arguments. Identical retries will be blocked after ${threshold("exactFailureBlockAfter", 3)} failures. Change strategy.`,
        };
      }
      if (toolCount >= threshold("toolFailureWarnAfter", 3) && toolCount < threshold("toolFailureBlockAfter", 8)) {
        return {
          action: "warn",
          message: `${name} has failed ${toolCount} consecutive times. Changing arguments alone is not progress; use another approach.`,
        };
      }
      return null;
    }
    state.toolFail.delete(key);
    for (const failedSig of state.exactFail.keys()) {
      if (failedSig.startsWith(`${key}\0`)) state.exactFail.delete(failedSig);
    }
    if (MUTATING.has(key)) {
      reset();
      return null;
    }
    if (!IDEMPOTENT.has(key)) {
      state.history.length = 0;
      return null;
    }
    const hash = resultFingerprint(event);
    const prev = state.noProgress.get(sig);
    if (prev && prev.hash !== hash) clearReads();
    // Only consecutive identical reads use the single-call rule. Interleaved
    // reads use cycles, so we never blacklist every member of a repeated cycle.
    const count = state.history.at(-1)?.sig === sig && prev && prev.hash === hash ? prev.count + 1 : 1;
    boundedSet(state.noProgress, sig, { hash, count });
    state.history.push({ sig, hash });
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    if (count >= threshold("noProgressWarnAfter", 2) && count < threshold("noProgressBlockAfter", 3)) {
      return {
        action: "warn",
        message: `${name} returned the same result ${count} times. Do not repeat it unchanged.`,
      };
    }
    const cycle = repeatedCycle(state.history);
    if (cycle && cycle.count >= threshold("cycleWarnAfter", 2) && cycle.count < threshold("cycleBlockAfter", 3)) {
      return {
        action: "warn",
        message: `A ${cycle.period}-call read-only sequence repeated ${cycle.count} times with unchanged results. Use the existing results or change strategy.`,
      };
    }
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
