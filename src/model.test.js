"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isGrokModel } = require("./model.js");

test("recognizes Grok IDs including provider-qualified IDs", () => {
  for (const id of ["grok-4.6", "custom/grok-4.7", "x-ai/Grok-4-fast", "grok", "grok_4.6"]) {
    assert.equal(isGrokModel({ id }), true, id);
  }
  assert.equal(isGrokModel("grok-4.6"), true);
  assert.equal(isGrokModel({ modelId: "grok-4.7" }), true);
  assert.equal(isGrokModel({ name: "Grok 4.6" }), false);
});

test("unknown or non-Grok identities fail closed despite provider or display name", () => {
  for (const model of [null, undefined, {}, "", "not-grok", { provider: "xai" }, { id: "", name: "Grok" },
    { id: "claude-opus-4", name: "Grok", provider: "grok-proxy" },
    { id: "gpt-5.6", provider: "xai" }, { id: "my-grok-wrapper" }]) {
    assert.equal(isGrokModel(model), false, JSON.stringify(model));
  }
});
