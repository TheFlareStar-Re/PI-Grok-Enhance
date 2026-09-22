# Grok Enhance

PI-Desktop trusted agent extension. Version **0.2.0**.

## Scope

All prompt injection, user-profile reminder consumption, tool preactivation, and
loop guards require an explicitly identified Grok model from the extension
callback's `ctx.model`. Provider names and endpoint URLs do not select these
features: `grok-4.7` on a custom provider is supported. Unknown and non-Grok
models are untouched. The obsolete `disciplineOnAllModels` setting is ignored.

## Behavior

- Inject concise execution discipline while allowing normal conversation,
  clarification, approval, requested plans, and honest blockers.
- Pre-activate installed `Grep`, `Glob`, `memory`, and `skill_manage` tools.
- Warn after two identical failures; block subsequent identical calls after
  three failures. Warn after three failures of one tool across changed arguments;
  block after eight. A successful call resets that tool's failure counters.
- Warn after two consecutive identical read results and block after three.
- Detect periods of two to four read-only calls using arguments and result
  fingerprints. Warn after two cycles and block the expected next call after
  three. Changed results, a different strategy, or successful Write/Edit allow
  progress. Successful Write/Edit resets guard state.
- Exempt interaction and polling tools (`TaskWait`, `TaskList`, plus configured
  names). Successful Bash is not classified as repeated read-only work.
- Reset state on a new user prompt, model/session change, disable, or shutdown.
  Evidence is bounded to 64 read results and 256 entries per map.

The extension does not execute tool calls written in prose and does not send
queued follow-ups. It reads profile files and consumes pending profile memory
reminders only for Grok; it does not edit USER.md or MEMORY.md.

## Plugin-only limits

This release contains no PI-Desktop host changes and requires no custom host
build. Two requested enhancements are not implemented by this plugin:

1. **Automatic action-promise recovery.** Prompt guidance discourages ending
   with a promise, but cannot force another model turn. The current extension
   API does not expose a cancellation-safe, bounded continuation of the same
   host request. Queued `sendUserMessage()` follow-ups can outlive cancellation
   or run after a model switch, so this plugin deliberately does not use them.
2. **xAI wire compatibility.** The plugin cannot adapt the host's provider
   serialization or response stream through the current extension API. Reserved
   tool-name aliases, wire-only schema sanitization, reasoning parameter
   normalization, and cache routing headers are therefore not supplied here.

The implemented improvements are execution guidance and stronger tool-loop
guards, selected by Grok model ID even on custom endpoints. No host public API,
credentials, or permission boundary is replaced.

## Install and verify

Import `dist/cn.star.grok-enhance-0.2.0.piplug` and fully restart PI-Desktop,
including its tray process. Existing guard settings remain readable.

Run tests with `PI_SCRATCH_DIR` pointing to a session scratch directory:

```powershell
node --test src/*.test.js
```

Use PI-Desktop's `PluginCheck` and then `PluginPack` on this plugin directory.
The packer validates the manifest and creates an installable uncompressed archive.
