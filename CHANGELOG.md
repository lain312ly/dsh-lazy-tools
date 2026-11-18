# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-11-18

### Fixed

- **`toolbox_load` no longer "activates" tools the agent never had.** It used to
  consult the process-wide tool universe, which accumulates tools observed from
  every session and the global registry. In a `minimal` session it reported
  `activated: ["subagent"]` for a preset that mounts no `subagent`, and the very
  next call failed with `unknown tool "subagent"` (`ToolNotFoundError`) — 15 such
  failures in one 40-step session. Loads now decide against the calling agent's
  own composed tool set (read with the restriction lifted), report
  `unavailable` for names mounted by another preset, and leave the tool table
  untouched for them.
- **`toolbox_search` matches multi-word queries.** It compared the whole query as
  one substring, so `"web search"`, `"spawn subagent"` or any sentence returned
  `total: 0`. Queries are now tokenised on non-word characters and ranked with
  name hits before description hits.
- **Recompositions drop stale activations.** Switching a session to a preset that
  no longer mounts an activated tool now removes it from the activation set and
  reports it in `toolbox_status.dropped`, instead of leaving a phantom entry.

### Added

- `toolbox_search` results stay inside the calling agent's composition, so a
  preset never advertises another preset's tools.
- `toolbox_status` reports `composedToolCount` (the agent's own surface) and
  `dropped` (activations removed by the last recomposition).
- `test/lazy-tools.test.mjs`: six behavioural tests with an in-memory harness
  (`npm test`), covering hiding, activation, the unavailable bucket, tokenised
  search, cross-preset isolation and preset-switch cleanup.

## [0.1.0] — 2026-11-18

First public release.

### Added

- Bundle `dsh-lazy-tools` with a Loader patch that inserts the `lazy-tools` row;
  enabling the bundle is enough, no profile-level configuration is required.
- Per-agent progressive tool disclosure: `agent/created` snapshots the agent's
  own tool view and hides every non-resident tool with
  `agent.ctx.tools.restrict({ deny })`. A deny-list is used instead of an
  allow-list because preset core tools (`read`, `write`, `pwsh`, ...) are
  registered in the preset scope and are absent from the global registry view.
- `toolbox_search(query, limit?)` — name/description search over installed but
  unloaded tools.
- `toolbox_load(names[])` — activates tools for the calling agent and returns a
  parameter digest so the next step can call them directly.
- `toolbox_status()` — diagnostics: provider/model, route `toolUpdate`
  capability, resident/activated/awaiting tool lists, restriction state.
- Compact deferred-tool catalog as a system prompt section (order `3150`), so
  the model knows hidden tools exist without shipping their schemas.
- Resume support: activation state is derived from `session.toolHistory()`
  instead of being persisted; `resumePreserve` keeps tools declared earlier in
  the same session callable after a resume or fork.
- Cleanup on plugin unload: every per-agent restriction is released with
  `ctx.effect`.
- `scripts/check-package.mjs` — dependency-free manifest/asset validator, run by
  `npm run check` and by CI.
- `scripts/tool-census.py` — reads your own session logs and suggests a `visible`
  list from real call frequency and schema size, because the shipped resident
  layer reflects one machine's usage.
- `scripts/verify-session-tools.py` — reads zstd session logs and asserts the
  first `request/header` stayed small while a `tool_addition` block appeared.

### Measured

- Baseline session: 42 tools / 39,429 characters in the first `request/header`.
- Enabled, linked install: 18 tools / 14,496 characters (16 resident + 3 toolbox
  tools; `exit_plan_mode` is registered by the preset right after the first
  request), about 24 hidden tools.
- Route capability observed on this installation: `toolUpdate: "addition-only"`;
  `toolbox_load` produces a `developer/message` carrying `tool-addition`.
- Disable/enable regression: disabling restores 41 tools / 38,941 characters.

### Known limitations

- Only agents created after activation are restricted; pre-existing sessions
  keep the full surface until reopened in a new conversation.
- Tools that an agent registers in its own scope cannot be named by
  `tools.restrict()` and are therefore never hidden (intentional safety bound).
- `addition-only` routes discard `tool_removal`: a loaded tool cannot be hidden again inside the same session
  (no in-session unload). Disabling or removing the bundle is always possible and restores the full surface for new
  sessions.
- Combined with other plugins that also call `tools.restrict`, restrictions
  intersect and may over-hide.
