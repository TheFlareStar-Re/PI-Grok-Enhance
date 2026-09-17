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
    return parts.filter(Boolean).join("\n\n");
  } catch {
    return "";
  }
}

function grokEnhanceExtension(pi) {
  const guard = guardrails.createController(cfg.loadConfig(cfg.defaultRoot()));

  try {
    const root = cfg.defaultRoot();
    const settings = cfg.loadConfig(root);
    if (settings.enabled) cfg.stampBoot(root, cfg.PLUGIN_VERSION);
    else cfg.clearBoot(root);
  } catch {
    /* ignore */
  }

  function reloadGuard() {
    const settings = cfg.loadConfig(cfg.defaultRoot());
    guard.setConfig(settings);
    return settings;
  }

  pi.on("before_agent_start", async (event) => {
    try {
      const root = cfg.defaultRoot();
      const settings = reloadGuard();
      if (!settings.enabled) {
        cfg.clearBoot(root);
        return undefined;
      }
      cfg.stampBoot(root, cfg.PLUGIN_VERSION);
      guard.reset();

      if (settings.preactivateTools) {
        tools.unionActivate(pi, cfg.parseToolNames(settings.extraTools));
      }

      const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
      const peer = loadUserProfileBlock();
      const apply = discipline.shouldApplyDiscipline(pi, settings);
      return { systemPrompt: discipline.composePrompt(base, peer, apply) };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_call", (event) => {
    try {
      const settings = cfg.loadConfig(cfg.defaultRoot());
      if (!settings.enabled || settings.guardrailsEnabled === false) return undefined;
      guard.setConfig(settings);
      const input = event && (event.input !== undefined ? event.input : event.args);
      const decision = guard.before(event && event.toolName, input);
      if (decision && decision.action === "block") {
        return { block: true, reason: decision.reason };
      }
    } catch {
      /* ignore */
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    try {
      const settings = cfg.loadConfig(cfg.defaultRoot());
      if (!settings.enabled || settings.guardrailsEnabled === false) return undefined;
      guard.setConfig(settings);
      const input = event && (event.input !== undefined ? event.input : event.args);
      const decision = guard.after(event && event.toolName, input, event);
      if (decision && decision.action === "warn") {
        return { content: guardrails.appendNotice(event && event.content, decision.message) };
      }
    } catch {
      /* ignore */
    }
    return undefined;
  });
}

module.exports = grokEnhanceExtension;
module.exports.default = grokEnhanceExtension;
