"use strict";

function toolName(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  return String(entry.name || "");
}

function listNames(pi, method) {
  if (!pi || typeof pi[method] !== "function") return [];
  try {
    const raw = pi[method]() || [];
    return Array.isArray(raw) ? raw.map(toolName).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function unionActivate(pi, extras) {
  const current = listNames(pi, "getActiveTools");
  const known = new Set(listNames(pi, "getAllTools"));
  const wanted = new Set(current);
  const added = [];
  for (const name of extras || []) {
    if (!name) continue;
    if (known.size > 0 && !known.has(name)) continue;
    if (!wanted.has(name)) added.push(name);
    wanted.add(name);
  }
  if (typeof pi.setActiveTools === "function") {
    pi.setActiveTools([...wanted]);
  }
  return { active: [...wanted], added };
}

module.exports = { toolName, listNames, unionActivate };
