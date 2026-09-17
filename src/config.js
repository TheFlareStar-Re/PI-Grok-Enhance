"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_ID = "cn.star.grok-enhance";
const PLUGIN_VERSION = "0.1.1";

const DEFAULT_CONFIG = {
  enabled: true,
  disciplineEnabled: true,
  disciplineOnAllModels: false,
  preactivateTools: true,
  extraTools: "Grep,Glob,memory,skill_manage",
  guardrailsEnabled: true,
  exactFailureWarnAfter: 2,
  exactFailureBlockAfter: 3,
  noProgressWarnAfter: 2,
  noProgressBlockAfter: 3,
};

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function homedir() {
  return os.homedir();
}

function defaultRoot() {
  return path.join(homedir(), ".pi", "agent", "grok-enhance");
}

function configPath(root) {
  return path.join(root || defaultRoot(), "config.json");
}

function bootPath(root) {
  return path.join(root || defaultRoot(), "_boot.txt");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function clampConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const exactWarn = clampInt(src.exactFailureWarnAfter, DEFAULT_CONFIG.exactFailureWarnAfter, 1, 20);
  const exactBlock = clampInt(src.exactFailureBlockAfter, DEFAULT_CONFIG.exactFailureBlockAfter, 1, 20);
  const npWarn = clampInt(src.noProgressWarnAfter, DEFAULT_CONFIG.noProgressWarnAfter, 1, 20);
  const npBlock = clampInt(src.noProgressBlockAfter, DEFAULT_CONFIG.noProgressBlockAfter, 1, 20);
  return {
    enabled: src.enabled !== false,
    disciplineEnabled: src.disciplineEnabled !== false,
    disciplineOnAllModels: src.disciplineOnAllModels === true,
    preactivateTools: src.preactivateTools !== false,
    extraTools:
      typeof src.extraTools === "string" && src.extraTools.trim()
        ? src.extraTools.trim()
        : DEFAULT_CONFIG.extraTools,
    guardrailsEnabled: src.guardrailsEnabled !== false,
    exactFailureWarnAfter: exactWarn,
    exactFailureBlockAfter: Math.max(exactWarn, exactBlock),
    noProgressWarnAfter: npWarn,
    noProgressBlockAfter: Math.max(npWarn, npBlock),
  };
}

function loadConfig(root) {
  const file = configPath(root);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return clampConfig(raw);
  } catch {
    return clampConfig(DEFAULT_CONFIG);
  }
}

function saveConfig(root, cfg) {
  ensureDir(root || defaultRoot());
  const next = clampConfig(cfg);
  fs.writeFileSync(configPath(root), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function stampBoot(root, version) {
  try {
    const dir = root || defaultRoot();
    ensureDir(dir);
    fs.writeFileSync(bootPath(dir), `${version || PLUGIN_VERSION} ${new Date().toISOString()}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

function clearBoot(root) {
  try {
    fs.unlinkSync(bootPath(root));
  } catch {
    /* ignore */
  }
}

function parseToolNames(text) {
  return String(text || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  PLUGIN_ID,
  PLUGIN_VERSION,
  DEFAULT_CONFIG,
  homedir,
  defaultRoot,
  configPath,
  bootPath,
  ensureDir,
  clampConfig,
  loadConfig,
  saveConfig,
  stampBoot,
  clearBoot,
  parseToolNames,
  clampInt,
};
