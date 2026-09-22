"use strict";

// Model identity, not provider identity: custom providers may serve many families.
function isGrokModel(model) {
  const id = typeof model === "string" ? model : model && (model.id ?? model.modelId);
  if (typeof id !== "string") return false;
  return /^(?:[^/\s]+\/)*grok(?:$|[-_.\s]|\d)/i.test(id.trim());
}

module.exports = { isGrokModel };
