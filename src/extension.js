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

function loadLocal(rel) {
  const resolved = require.resolve(rel);
  delete require.cache[resolved];
  return require(resolved);
}

const cfg = loadLocal("./config.js");
const discipline = loadLocal("./discipline.js");
const tools = loadLocal("./tools.js");
const guardrails = loadLocal("./guardrails.js");

function loadUserProfileBlock() {
  const file = path.join(
    os.homedir(),
    ".pi-desktop",
    "plugins",
    "installed",
    "cn.star.user-profile",
    "src",
    "memory-store.js",
  );
  try {
    if (!fs.existsSync(file)) return "";
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    const store = require(resolved);
    if (typeof store.buildFullInjection !== "function") return "";
    const root = store.defaultRoot();
    return store.buildFullInjection(root, store.loadConfig(root)) || "";
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
