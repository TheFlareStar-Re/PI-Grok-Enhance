"use strict";

const cfg = require("./src/config.js");

async function syncConfigFromSettings() {
  const settings = await pi.plugin.getSettings();
  const root = cfg.defaultRoot();
  cfg.ensureDir(root);
  const next = cfg.saveConfig(root, {
    enabled: settings.enabled !== false,
    disciplineEnabled: settings.disciplineEnabled !== false,
    disciplineOnAllModels: settings.disciplineOnAllModels === true,
    preactivateTools: settings.preactivateTools !== false,
    extraTools: settings.extraTools,
    guardrailsEnabled: settings.guardrailsEnabled !== false,
    exactFailureBlockAfter: settings.exactFailureBlockAfter,
    noProgressBlockAfter: settings.noProgressBlockAfter,
  });
  if (next.enabled) cfg.stampBoot(root, cfg.PLUGIN_VERSION);
  else cfg.clearBoot(root);
}

function statusText() {
  const settings = cfg.loadConfig(cfg.defaultRoot());
  return `Grok Enhance ${cfg.PLUGIN_VERSION} · ${settings.enabled ? "on" : "off"} · discipline ${
    settings.disciplineEnabled ? "on" : "off"
  } · guardrails ${settings.guardrailsEnabled ? `fail≥${settings.exactFailureBlockAfter}` : "off"} · preactivate ${
    settings.preactivateTools ? settings.extraTools : "off"
  }`;
}

async function onLoad() {
  await syncConfigFromSettings();

  await pi.commands.register({
    id: "grok-enhance.status",
    title: "Grok Enhance: Status",
    keywords: ["grok", "enhance", "harness"],
    run: async () => {
      await pi.ui.showToast(statusText());
    },
  });

  if (pi.events && typeof pi.events.on === "function") {
    pi.events.on("plugin:settingsChanged", () => {
      void syncConfigFromSettings();
    });
  }
}

async function onUnload() {
  try {
    await pi.commands.unregister("grok-enhance.status");
  } catch {
    /* ignore */
  }
  cfg.clearBoot(cfg.defaultRoot());
}

module.exports = { onLoad, onUnload };
