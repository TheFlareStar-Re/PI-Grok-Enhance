"use strict";

/**
 * Sidecar agent extension. CJS so jiti does not need import.meta.
 * Owns before_agent_start when enabled: inlines user-profile injection, then
 * appends Grok execution discipline. Pre-activates deferred tools after the
 * host reset so Grep/Glob/memory/skill_manage are in the first request.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

try {
  delete require.cache[require.resolve("./config.js")];
} catch {
  /* not cached yet */
}
try {
  delete require.cache[require.resolve("./discipline.js")];
} catch {
  /* not cached yet */
}
try {
  delete require.cache[require.resolve("./tools.js")];
} catch {
  /* not cached yet */
}
try {
  delete require.cache[require.resolve("./guardrails.js")];
} catch {
  /* not cached yet */
}
const cfg = require("./config.js");
const discipline = require("./discipline.js");
const tools = require("./tools.js");
const guardrails = require("./guardrails.js");

function readIfFile(file) {
  try {
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8").replace(/^\s+|\s+$/g, "");
  } catch {
    return "";
  }
}

function profileBlock(title, body) {
  if (!body) return "";
  return [
    "══════════════════════════════════════════════",
    title,
    "══════════════════════════════════════════════",
    body,
  ].join("\n");
}

const MEMORY_NUDGE = [
  "memory-nudge: v1",
  "If the last few tool calls produced a durable fact, call the memory tool (target=user for identity/preferences, target=memory for environment/conventions).",
  "Do not write those facts with MCP memory, create_entities, or other knowledge-graph tools.",
  "Skip one-offs, secrets, and procedures (skills).",
].join("\n");

function takeMemoryNudge(root) {
  const statePath = path.join(root, "nudge-state.json");
  const filePath = path.join(root, "nudge.md");
  const fromFile = readIfFile(filePath);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* missing */
  }
  let pending = false;
  let state = {};
  try {
    const raw = readIfFile(statePath);
    state = raw ? JSON.parse(raw) : {};
    pending = state.pending === true;
  } catch {
    state = {};
  }
  if (!pending && !fromFile) return "";
  state.pending = false;
  try {
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    /* ignore */
  }
  return fromFile || MEMORY_NUDGE;
}

function loadUserProfileBlock() {
  const root = path.join(os.homedir(), ".pi", "agent", "user-profile");
  try {
    const raw = readIfFile(path.join(root, "config.json"));
    const config = raw ? JSON.parse(raw) : {};
    if (config.enabled === false) return "";
    const parts = [];
    if (config.userProfileEnabled !== false) {
      parts.push(profileBlock("USER PROFILE (who the user is)", readIfFile(path.join(root, "USER.md"))));
    }
    if (config.memoryEnabled !== false) {
      parts.push(profileBlock("MEMORY (agent notes)", readIfFile(path.join(root, "MEMORY.md"))));
    }
    const nudge = takeMemoryNudge(root);
    if (nudge) parts.push(nudge);
    return parts.filter(Boolean).join("\n\n");
  } catch {
    return "";
  }
}

function grokEnhanceExtension(pi) {
  const { isGrokModel } = require("./model.js");
  const guard = guardrails.createController(cfg.loadConfig(cfg.defaultRoot()));
  const blockedCalls = new Set();
  let scope;

  function reset() {
    guard.reset();
    blockedCalls.clear();
    scope = undefined;
  }

  // Context.model is the real sidecar API; ExtensionAPI has no getModel().
  function settingsFor(ctx) {
    const settings = cfg.loadConfig(cfg.defaultRoot());
    const model = ctx && ctx.model;
    if (!settings.enabled || !isGrokModel(model)) {
      reset();
      return undefined;
    }
    const session = ctx.sessionManager && ctx.sessionManager.getSessionId();
    const nextScope = JSON.stringify([session, model.id, model.provider]);
    if (scope !== nextScope) reset();
    scope = nextScope;
    guard.setConfig(settings);
    if (!settings.guardrailsEnabled) guard.reset();
    return settings;
  }

  pi.on("session_shutdown", reset);
  pi.on("model_select", reset);
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      reset();
      const settings = settingsFor(ctx);
      if (!settings) return undefined;
      cfg.stampBoot(cfg.defaultRoot(), cfg.PLUGIN_VERSION);
      if (settings.preactivateTools) {
        tools.unionActivate(pi, cfg.parseToolNames(settings.extraTools));
      }
      const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
      const peer = loadUserProfileBlock();
      const apply = discipline.shouldApplyDiscipline(ctx.model, settings);
      return { systemPrompt: discipline.composePrompt(base, peer, apply) };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      const settings = settingsFor(ctx);
      if (!settings || !settings.guardrailsEnabled) return undefined;
      const input = event && (event.input !== undefined ? event.input : event.args);
      const decision = guard.before(event && event.toolName, input);
      if (decision && decision.action === "block") {
        if (event.toolCallId) {
          if (blockedCalls.size >= 256) blockedCalls.delete(blockedCalls.values().next().value);
          blockedCalls.add(event.toolCallId);
        }
        return { block: true, reason: `[grok-enhance] ${decision.reason}` };
      }
    } catch {
      /* Do not break the host tool path if an optional guard fails. */
    }
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    try {
      const settings = settingsFor(ctx);
      if (!settings || !settings.guardrailsEnabled) return undefined;
      if (event && blockedCalls.delete(event.toolCallId)) return undefined;
      const input = event && (event.input !== undefined ? event.input : event.args);
      const decision = guard.after(event && event.toolName, input, event);
      if (decision && decision.action === "warn") {
        return { content: guardrails.appendNotice(event && event.content, decision.message) };
      }
    } catch {
      /* Do not replace a real tool result with a guard error. */
    }
    return undefined;
  });
}

module.exports = grokEnhanceExtension;
module.exports.default = grokEnhanceExtension;
