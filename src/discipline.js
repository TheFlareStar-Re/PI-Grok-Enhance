"use strict";

const MARKER = "exec-discipline: grok-v1";

const DISCIPLINE = `
${MARKER}

You are in PI-Desktop Agent mode. Default tools this turn: Read, Write, Edit, Bash.
Grep, Glob, and peer tools (memory, skill_manage) should already be in the active tool list — call them directly. Do not ToolSearch first unless a named tool is truly absent from the current list.

# Tool-use enforcement
You MUST use tools to act. If you say you will read, grep, edit, or run something, that tool call MUST be in this same response. Do not end a turn with a plan or "I will…". Every response is either (a) tool calls that make progress or (b) a final result.

# Parallel tool calls
Independent Read / Grep / Glob / Bash lookups belong in ONE response. Only serialize when a later call needs an earlier result.

# Do not answer from memory
NEVER guess: file contents, line counts, whether a path exists, git status, cwd, OS, current time, or whether a command succeeded. Use Read, Grep, Glob, or Bash. User-profile text describes the USER, not this machine.

# Loops
Do not retry the same Bash/Grep/Read with identical arguments after it failed or returned the same data. Change the query or report the blocker. Identical retries are blocked.

# Finishing
Keep going until the task is done and verified with a tool, or report the blocker. Do not fabricate command output.
`.trim();

function modelNeedle(pi) {
  try {
    const m = pi && typeof pi.getModel === "function" ? pi.getModel() : null;
    if (m == null) return "";
    if (typeof m === "string") return m;
    return [m.id, m.modelId, m.name, m.provider, m.api, m.providerId].filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

function shouldApplyDiscipline(pi, config) {
  if (!config || config.disciplineEnabled === false) return false;
  if (config.disciplineOnAllModels) return true;
  const needle = modelNeedle(pi);
  if (!needle) return true;
  return /grok/i.test(needle);
}

function alreadyHas(haystack, needle) {
  return String(haystack || "").includes(needle);
}

function appendIfMissing(base, block, signature) {
  const body = String(block || "").replace(/^\s+|\s+$/g, "");
  if (!body) return String(base || "").replace(/\s+$/, "");
  const out = String(base || "").replace(/\s+$/, "");
  const sig = signature || body.slice(0, Math.min(48, body.length));
  if (sig && alreadyHas(out, sig)) return out;
  if (!out) return body;
  return `${out}\n\n${body}`;
}

function composePrompt(basePrompt, peerBlock, applyDiscipline) {
  let out = String(basePrompt || "").replace(/\s+$/, "");
  out = appendIfMissing(out, peerBlock, "USER PROFILE (who the user is)");
  if (applyDiscipline) out = appendIfMissing(out, DISCIPLINE, MARKER);
  return out ? `${out}\n` : out;
}

module.exports = {
  MARKER,
  DISCIPLINE,
  modelNeedle,
  shouldApplyDiscipline,
  appendIfMissing,
  composePrompt,
};
