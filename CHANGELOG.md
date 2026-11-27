# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] — 2026-11-27

### Added

- **the resident layer now calibrates itself from your own usage, once a month.**
  `toolbox_census` counts this machine's `tool/call` and `tool/ptc-dispatch`
  events through DSH's `sessionQuery` service and re-derives which tools stay
  visible: at least `census.minCallsPerDay` calls per day with a schema under
  `census.maxSchemaChars`, or `census.dominantCallsPerDay` calls per day
  whatever the size. The shipped 17-tool list is now only the fallback used
  before the first census.

- **the clock starts when a census finishes, not when the plugin is installed.**
  Each run stamps `lastAt` and the next one is due `lastAt + intervalDays`, so a
  restart cannot postpone it. With no record yet the first run happens
  `census.startDelayMs` after load (30 s), which means a fresh install measures
  before it decides anything. `census.intervalDays` changes the period (1–365
  days); `0` disables automatic runs and leaves `toolbox_census` as the only
  trigger.

- `toolbox_census({dryRun})`, and a `census` block in `toolbox_status`
  (`source`, `lastRunAt`, `nextRunAt`, `measuredDays`, `sessions`, `calls`,
  `residentCount`, `record`).

### Changed

- the census result is persisted at `$DSH_HOME/lazy-tools/census.json` and
  adopted on load, so a restart never rescans; changing a threshold invalidates
  the stored numbers and the next run recomputes under the new rules.
- applying a census rebuilds the restriction of every live agent and unfreezes
  the prompt catalog, so a long-running session sees the new layer instead of
  waiting for its next birth.
- the daily rate is divided by the span the counts actually cover (oldest
  counted event to now, capped at the window), so a machine with three days of
  history is not divided by 30. Measured on the author's machine: 109 sessions,
  10,069 calls, 29.9 days, 3.7 s, resident layer 9 tools.
- `visible` stays additive in every case: a pinned tool is never squeezed out by
  a monthly result. `census.apply: false` records the measurement without
  touching the layer.

## [0.1.5.1] — 2026-11-24

### Fixed

- **The prompt catalog no longer lists tools the session can already call.**
  The section text provider now reads the assembling agent from the assembly
  context the loop passes (`{ agent, scope: agent }`) and builds the list from
  that agent's own composition minus what it has already loaded, instead of the
  process-wide tool universe. The previous text claimed those tools were
  "intentionally absent from your tool list", which was false for any tool this
  session had activated — and the list also carried names that another preset
  mounted and this session could never load.

- **The catalog is frozen per agent at its first assembly.** DSH keeps a changed
  system prompt by appending the whole re-rendered prompt to the history, so a
  list that shrank after every `toolbox_load` would have cost one full prompt
  copy per activation. A tool loaded later stays in the list, and `toolbox_load`
  answers `alreadyAvailable` for it.

### Added

- an assembly that names no agent the plugin has seen (a bare `assemble()`,
  another plugin's scope) gets its own hedged installation list, which claims
  nothing about the current tool list.
- `docs/MAINTENANCE.md` records each weekly availability check; it is excluded
  from the published bundle (`files: "!docs/MAINTENANCE.md"`), and
  `npm run check` now understands exclusion entries instead of failing on them.

## [0.1.5] — 2026-11-18

### Added

- the two helper scripts now ship with the bundle: `scripts/tool-census.py` and
  `scripts/verify-session-tools.py` are in `files`, so a bundle installed from a
  Git tag contains them at
  `~/.dsh/profiles/<profile>/node_modules/dsh-lazy-tools/scripts/` instead of
  existing only in a checkout.

### Changed

- documented the census where users actually look for it: README now shows a real
  30-day output excerpt, the full flag table, the read-only/privacy note, and the
  installed-bundle path; `docs/DETAIL.*.md` gained the same flag table.
- the locale descriptions no longer claim "only newly created agents are
  affected" — they match 0.1.2's load-time re-attach.

## [0.1.4] — 2026-11-18

### Changed

- **GitHub tags are the only distribution channel.** The 0.1.3 packaging work
  made the package publishable, but the first `npm publish` was rejected with
  HTTP 403 — the account requires a second factor (`--otp`) or a granular token
  with 2FA bypass, and the author decided not to publish to npm. `private` is
  back, the install snippets point at the GitHub tag, and the README's publish
  section now describes the tag flow instead of npm.

## [0.1.3] — 2026-11-18

### Fixed

- **`toolbox_status.visible` no longer reports tools the step cannot call.** It
  filtered the resident layer by `pool` — the agent's composition, or the
  process-wide universe when no state existed yet — instead of by the callable
  view. In a `minimal` session it claimed 16 resident tools (`read`, `write`,
  `edit`, …) while the request header declared 17 names, 14 of which that preset
  could never call. Filtering by the live view also covers stacked restrictions:
  a resident tool hidden by another plugin is no longer reported visible, and
  `visible` is now a subset of the callable surface by construction.

### Added

- test: `status visible lists only the tools the step can actually call`, which
  asserts `visible ⊆ callable` and `awaiting ∩ callable = ∅` (nine tests total).

### Changed

- Packaging is publishable: `private` removed from `package.json` and the
  repository/homepage/bugs URLs point at `github.com/lain312ly/dsh-lazy-tools`.
  `dsh-lazy-tools` was unused on the public npm registry, so the README install
  section now lists `dsh-lazy-tools@<version>` as the first target and documents
  `npm publish` (`npm pack --dry-run` shows the 12-file / 30.8 kB tarball).

## [0.1.2] — 2026-11-18

### Fixed

- **A plugin reload no longer leaves open sessions unrestricted.** Every
  restriction is destroyed when the plugin unloads, and `agent/created` never
  fires again for agents that were already live, so an updated or hot-reloaded
  plugin used to leave those sessions with the full tool surface and no lazy
  loading at all — until their first `toolbox_*` call made the state appear.
  On load the plugin now walks `ctx.agents.list()` and re-applies the
  restriction to every live agent. Observed in a manual `minimal` session
  (`toolbox_status` first reported `restricted: false`, `composedToolCount: 106`
  — the process-wide universe — then flipped to `restricted: true` and
  `composedToolCount: 21` after one load call).
- **`toolbox_search` / `toolbox_status` / `toolbox_load` self-heal a missing
  state.** When an agent is seen for the first time outside `agent/created`, the
  first `toolbox_*` call now applies the restriction before answering, instead
  of answering from the process-wide universe: search no longer offers tools
  that `toolbox_load` then reports as `unavailable`.

### Added

- `test/lazy-tools.test.mjs` grows to eight tests: the load-time sweep over
  existing agents, and search self-healing for an agent the plugin never saw.

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
