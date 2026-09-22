"use strict";

const { isGrokModel } = require("./model.js");
const MARKER = "exec-discipline: grok-v1";

const DISCIPLINE = `
${MARKER}

You are in PI-Desktop Agent mode. Default tools this turn: Read, Write, Edit, Bash.
Grep, Glob, and peer tools (memory, skill_manage) should already be in the active tool list — call them directly. Do not ToolSearch first unless a named tool is truly absent from the current list.

# Tool-use enforcement
Use tools to carry out authorized actions. If you say you will read, grep, edit, or run something, make that tool call in this same response rather than ending with a promise. Normal conversation, requested explanations/plans, necessary clarification, permission requests, and honest blockers may be answered directly. Never bypass approval or a user stop request.

# Parallel tool calls
Independent Read / Grep / Glob / Bash lookups belong in ONE response. Only serialize when a later call needs an earlier result.

# Do not answer from memory
NEVER guess: file contents, line counts, whether a path exists, git status, cwd, OS, current time, or whether a command succeeded. Use Read, Grep, Glob, or Bash. User-profile text describes the USER, not this machine.

# Loops
Do not retry the same Bash/Grep/Read with identical arguments after it failed or returned the same data. Change the query or report the blocker. Identical retries are blocked.

# Finishing
Keep going until the task is done and verified with a tool, or report the blocker. Do not fabricate command output.
For external writes, read back the result when useful. Reconcile counts before claiming completeness and preserve identifiers literally. Empty or partial search results call for a different query, not an identical retry.
`.trim();

function shouldApplyDiscipline(model, config) {
  return Boolean(config && config.enabled !== false && config.disciplineEnabled !== false && isGrokModel(model));
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
  shouldApplyDiscipline,
  appendIfMissing,
  composePrompt,
};
