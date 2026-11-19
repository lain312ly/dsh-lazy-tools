# Verification

Every claim in the README and in `docs/DETAIL.*.md` was measured on a live DSH installation. This page records the
environment, the method, the observations, and what remains unverified, so the numbers can be reproduced.

Session identifiers are truncated to 8 characters; full logs stay on the test machine.

## Environment

| Item | Value |
| --- | --- |
| DSH Desktop | 2.0.23-next (all numbers below); 2.0.24-next for the 2026-11-19 smoke |
| `@deepseek-ai/dsh` | 0.2.2-rc.3 (all numbers below); 0.2.2-rc.5 for the 2026-11-19 smoke |
| Profile | `desktop` |
| OS | Windows |
| Model route | DeepSeek account route, `deepseek-flash` |
| Install form | linked checkout (`link:` dependency in the profile manifest) |

## Method

DSH writes a JSONL (zstd) session log under `~/.dsh/sessions`, and the log is the authority for the plugin's behaviour:

- `request/header` — the exact tool declarations sent with that request, and their serialized length;
- `developer/message` — the agent-loop record written when the tool registry changed; a `tool-addition` block proves the
  load travelled through the incremental channel;
- `tool/call` / `tool/result` — which tools actually ran, in which order;
- `assistant/message.usage` — `inputTokens` for the first request.

`scripts/verify-session-tools.py` reads those events and prints a `PASS …` line when a session's first header fits the
budget and a `tool-addition` block exists.

## Facts

| id | Observation | Evidence |
| --- | --- | --- |
| F1 | `ctx.tools.restrict({ allow })` can hide global tools inside an agent scope; it requires a scoped context (`agent.ctx`) and rejects unknown names and `run_code` | `@deepseek-ai/dsh-tools` `src/index.ts` restrict implementation |
| F2 | The restriction scope comes from the access context (the service proxy rewrites `this.ctx` to the use site) | `@deepseek-ai/cordis` `utils.ts` `createTraceable` |
| F3 | When the tool table changes, the agent loop writes a `developer/message` (source `tool-registry`) with `tool-addition` / `tool-removal` blocks and `headerSeq` | `dsh-agent-loop` `src/agent.ts` |
| F4 | With the `toolUpdate` capability, later-added tools are projected as `deferLoading: true` and activated by the addition block; without it the developer message is stripped | `dsh-llm` `src/content.ts` |
| F5 | The DeepSeek adapter serializes the block as `{type:'tool_addition', tool:{type:'tool_reference', name}}` and adds the tool-changes beta header when needed | `dsh-llm-deepseek` `src/serialize.ts`, `src/adapter.ts` |
| F6 | The built-in `deepseek-flash` catalog declares `toolUpdate: addition-only`; account routes follow the online `/models` list | `dsh-llm-deepseek` `src/models.ts`, `src/listed-catalog.ts` |
| F7 | Public agent surface: `agent.session`, `agent.ctx`, `agent.model.current()` | `dsh-agent` `runtime-types.ts` |
| F8 | `session.toolHistory()` returns `{ tools, updates[].additions }`, enough to derive which tools a resumed session already declared | `dsh-session` `src/index.ts` |
| F9 | Events `agent/created` (serial), `agent/disposed`, `tools/change` exist and are observable | Cordis event inspection |
| F10 | Baseline of a 42-tool session: first `request/header` carries 42 tools / **39,429 characters** | session `258e897a` |
| F11 | The system prompt (~9.7k characters) contains no tool schemas, so hiding tools does not shrink it | session `258e897a` |
| F12 | Installing a bundle writes both `dependencies` and `dsh.profile.bundles` in the profile manifest | profile `package.json` |
| F13 | Disabling the plugin really restores the surface: new session `lazy-run-off` had 41 tools / 38,941 characters, no `toolbox_*` in the table, `list_agents` directly callable; re-enabling produced 16 tools / 13,833 characters with `list_agents` awaiting a load | sessions `03a1b672`, `0a9945a2` |
| F14 | Core tools (`read`/`write`/`pwsh`, …) are registered by the preset in its own scope, so they are absent from `ctx.tools.definitions()` (the global view). `toolbox_status` reported `visible: []` with `agentToolCount: 49`, proving the two views differ | live `toolbox_status` |
| F15 | The account route really reports `toolUpdate: "addition-only"`; no `modelOverrides` needed | live `toolbox_status` |
| F16 | Install/enable of the plugin produced `toolbox_*` tool additions and removals in a running session's `request/header` and `developer/message` (seq 636 added, 712 removed, 720 added again), proving the dynamic tool-update channel works on the DeepSeek route | session `258e897a` |
| F17 | An allow-list prototype reduced a child session's first header to only 3 toolbox tools — core tools were hidden as collateral damage; the per-agent deny-list version gave 16 tools with `read` still working | sessions `b8793a74`, `e1309871` |
| F18 | Per-agent deny child session: first header **16 tools / 13,833 characters**, `read` usable, `toolbox_load(["list_agents"])` recorded a `tool-addition` and `list_agents` returned 4 agents; first request `inputTokens = 6795` | session `e1309871` |
| F19 | Enabling/disabled regression on 2026-11-18 measured both states as described in F13 | sessions `03a1b672`, `0a9945a2` |
| F20 | Enabled-state child session: `restricted: true`, `agentToolCount: 17`, `toolUpdate: addition-only`; `toolbox_load([schedule_list, list_agents])` returned `activated` for both and `list_agents` succeeded | session `a66c2dd1` |
| F21 | A brand-new GUI conversation reported `restricted: true`, `toolUpdate: addition-only`, `agentToolCount: 18`, `visible` 14 names, `activated: ["schedule_list"]`, `awaitingCount: 89` | user-run `toolbox_status` in the GUI |
| F22 | 30-day tool census over 200 sessions / 17,166 calls: `pwsh` 4059, `edit` 2632, `ops_bash` 2025 (dsh-ops uninstalled), `read` 1775, `run_code` 1491, `write` 758, `grep` 404, `read_image` 399, `compress` 343 (not installed), `web_fetch` 176, `job_output` 136, `present` 136, `todo_write` 107, `send_message` 87, `subagent` 64, `glob` 53 | decompressed `~/.dsh/sessions` |
| F23 | After moving `read_image` (403 chars) and `web_fetch` (256 chars) into the resident layer per that census: new child session first header **18 tools / 14,496 characters**, and `toolbox_load([read_image, web_fetch])` returned `alreadyAvailable` (no duplicate activation) | session `0f032475` |

## Self-checks

| id | Assertion | Result | Measured |
| --- | --- | --- | --- |
| C1 | Bundle manifest parses and declares the Cordis patch | pass | `dsh-lazy-tools 0.1.0 ./cordis.patch.yml` |
| C2 | `index.js` has valid JavaScript syntax | pass | `node --check` exit 0, no output |
| C3 | Both locale files parse and the icon asset exists | pass | `locales-ok true (icon.svg 630 bytes)` |
| C4 | The shipped patch inserts the `lazy-tools` row | pass | contains `insert` and `lazy-tools` |
| C5 | The bundle is installed in the profile (dependency plus selected bundle) | pass | `true true` |
| C6 | A new agent gets a reduced first header plus a tool-addition record | pass | `tools=16 chars=13833 additions=2 laterAdded=exit_plan_mode,list_agents`; disabled control 41/38,941; revised defaults 18/14,496 |
| C7 | The route capability probe returns a `toolUpdate` value | pass | 4 log hits; `toolUpdate=addition-only`, `capabilityError=null` |
| C8 | The `toolbox_load` activation path ran in a session | pass | `toolbox_load` + `tool-addition` for `list_agents`, which then returned 6 agents |
| C9 | Detail document and verification tooling are present | pass | both files non-empty |
| C10 | The verification helper compiles | pass | `python -m py_compile` exit 0 |

Run the same checks on a checkout with:

```bash
node --check index.js
npm run check
python scripts/verify-session-tools.py --limit 8 --check \
  --max-tools 18 --max-chars 15000 --require-tools read,write,pwsh --expect-addition
```

A passing run prints, for example:

```
PASS session=0f032475 tools=18 chars=14496 additions=2 laterAdded=exit_plan_mode
```

### Rerun after the release refactor

After this release prepared the localized detail documents and the packaging checks, the bundle was disabled and
re-enabled to force a module reload, and a fresh subagent reproduced the surface:

```
PASS session=86a1c100 tools=18 chars=14496 additions=2 laterAdded=exit_plan_mode,list_agents
```

That session reported `restricted: true`, `toolUpdate: "addition-only"`, `visible` = the 16 resident names,
`awaitingCount: 87`, `agentToolCount: 19`; `toolbox_load(["list_agents"])` returned
`activated: ["list_agents"]`, `agentToolCount` rose to 20, `awaitingCount` fell to 86, and `list_agents` then returned
9 agents. The numbers match the figures in the README and `docs/DETAIL.*.md` exactly.

## Not verified

- **Rendered metadata.** The Plugin Manager detail page, localized title/description, and icon were checked as files and
  through the Host's resource loading, but not visually: the running GUI requires re-authentication, so no browser
  screenshot was taken. Text and paths are confirmed; rendering is not.
- **Other platforms.** macOS and Linux were not tested.
- **Routes without `toolUpdate`.** The `null` path (tool still loads, no `tool_addition` block) is implemented and
  documented but could not be observed on this installation, whose route reports `addition-only`.
- **In-session unload.** `addition-only` routes discard `tool_removal`, so hiding an already loaded tool again is
  intentionally unsupported and untested. Uninstalling the bundle is unaffected and was verified (41 tools / 38,941
  characters after disabling).

## 0.1.1 regression (2026-11-18)

The failure that motivated 0.1.1 was observed in a `minimal` session (session `c70fa2b9`): `toolbox_load` returned
`activated: ["subagent"]` for a preset that mounts no `subagent`, and the next call failed with
`Error: unknown tool "subagent"` (`ToolNotFoundError`). The same session produced 15 `UNKNOWN_TOOL` results across
`subagent`, `subagent_fork`, `list_agents`, `list_subagent_models`, `wait_agent`, `read`, `glob`, `grep` and
`cua_driver_native__list_apps`; only `working_directory` (a genuinely composed tool) entered the tool table.

Fixes and their evidence:

| Check | Evidence |
| --- | --- |
| `toolbox_load` decides against the agent's own composition | child session `5835a2bd` (cordis, native): `toolbox_load(["office_render"])` → `unknown`, nothing activated, no follow-up error |
| tokenised `toolbox_search` | same session: `toolbox_search("web search")` → `tokens: ["web","search"]`, 3 hits including `web_search` (`total: 0` before) |
| activation still works and travels the incremental channel | same session: `toolbox_load(["list_agents"])` → `activated`, header 19 → 20 tools, `developer/message(tool-addition: list_agents)`, `list_agents()` returned 10 agents |
| recomposition drops stale activations | unit test `test/lazy-tools.test.mjs`: preset switch removes `subagent` from `activated` and reports it in `dropped` |
| no restriction-caused tool errors | `UNKNOWN_TOOL` count in `5835a2bd`: 0 |

Unit tests: `npm test` → 6/6 pass. The `unavailable` bucket (a tool another preset mounted but this agent did not) is
covered by the unit test; the live session above exercised the `unknown` bucket because no other preset had touched that
plugin instance yet.

## 0.1.2 regression (2026-11-18)

Two GUI conversations were opened by hand in the `minimal` preset and both asked for `subagent` (a tool `minimal` does
not mount). The plugin was 0.1.1 in both; the two runs disagree, and the disagreement is the defect.

| | session `5d9f2c35` | session `007cdbc7` |
| --- | --- | --- |
| created | 13:03:34, plugin already enabled | 12:53:46, **before** the two plugin reloads at 12:58:43–12:59:10 |
| preset switch to `minimal` | 13:03:36 | 13:01:19 |
| first `request/header` | 5 tools / 2,441 chars | 17 tools / 11,764 chars |
| first `toolbox_status` | `restricted: true`, `agentToolCount: 5`, `composedToolCount: 21`, awaiting 16 | `restricted: false`, `agentToolCount: 21`, `composedToolCount: 106` (the process-wide universe), awaiting 87 |
| `toolbox_search("subagent")` | 0 hits (correct: not composed) | **5 hits**, including `subagent` |
| `toolbox_load(["subagent"])` | `activated: []`, `unavailable: ["subagent"]` | `activated: []`, `unavailable: ["subagent"]` |
| `UNKNOWN_TOOL` results | 0 | 0 |
| final answer | honest: "本次实际上没有成功调用 subagent" | honest: "subagent 工具这次用不了 … 我不会虚构调用结果" |

Session `007cdbc7` was created while the plugin was being reloaded for the 0.1.1 verification. Disabling the plugin
destroys every per-agent restriction, and re-enabling cannot restore them: `agent/created` already fired long before, so
that session ran its first turn on the full tool surface (`composedToolCount: 106` is the plugin's process-wide universe,
not its composition) and `toolbox_search` advertised the universe, offering `subagent` right before `toolbox_load`
answered `unavailable`. The state only appeared when `toolbox_load` created it lazily. Session `5d9f2c35`, created after
the reload, behaved exactly as designed.

Fixes and evidence:

| Check | Evidence |
| --- | --- |
| a plugin load re-restricts agents that already exist | unit test "a plugin load re-restricts agents that already existed": apply() with a live-agent service hides `web_search`/`subagent` and `toolbox_status` reports `restricted: true`, `composedToolCount: 6` |
| the first `toolbox_*` call heals a missing state | unit test "toolbox_search applies the restriction itself for an agent it never saw": searching for another preset's `list_agents` returns no results instead of the universe fallback, and the composed hidden tool is still findable |
| nothing regressed in the 0.1.1 behaviour | `npm test` → 8/8; live reload followed by a `toolbox_status` from the lead session reports a composed surface instead of the universe |

The first line was also exercised live, because a unit test alone would not prove that `ctx.agents.list()` is reachable
from a plugin and that restricting an idle agent takes effect before its next request:

- **Lead session** (agent that existed long before the plugin was installed): before the reload `toolbox_status`
  reported `restricted: false`, `composedToolCount: 107` (the universe); after the 0.1.2 reload the same call reported
  `restricted: true`, `composedToolCount: 49` (its real composition), `visible` = the 16 resident names, `activated` = the
  26 tools its log had already announced, `awaiting` = the 4 `team_task_*` names.
- **A child agent created while the plugin was active** (`bdc9b764`, cordis, header 18 tools) was left idle, then the
  plugin was disabled at 13:16:43 and re-enabled at 13:16:46 — which releases and re-applies every restriction. Its next
  request, at 13:16:49 and before any `toolbox_*` call, carried **19 tools** (16 resident + 3 toolbox) instead of the full
  49-tool cordis surface; the `toolbox_status` it then called reported `restricted: true`, `composedToolCount: 49`,
  `activated: []`, `awaitingCount: 30`. Under 0.1.1 that header would have been the full surface: the plugin released the
  restriction at unload and `agent/created` never fires again for an agent that already exists.

Live re-check still owed for the two hand-run `minimal` conversations: after this 0.1.2 reload, a message in
`007cdbc7` should report `restricted: true`, `composedToolCount: 21`, `activated` = the 12 tools its already-declared
header exposed, `awaiting` = the 4 `team_task_*` names; and a message in `5d9f2c35` should report `restricted: true`,
`composedToolCount: 21`, `visible` = `pwsh` + `read_image`, and `subagent` still `unavailable`.

## 0.1.3 (2026-11-18)

Found by the model itself in the second turn of `007cdbc7`, while it re-read `index.js` after the 0.1.2 reload. In that
session's first `toolbox_status` (0.1.1) the `visible` field listed the 16 resident *names* — `read`, `write`, `edit`,
`glob`, `grep`, … — while the first request header held 17 tools, exactly `pwsh`, `read_image`, the three toolbox tools
and 12 desktop extras. Fourteen of the "visible" names did not exist in that preset at all, so the field reported ghost
tools: a milder version of the 0.1.1 activation bug.

Cause: `toolbox_status` filtered the resident layer with `pool.has(name)` — the agent's composition, or the process-wide
universe when no state existed yet — instead of the callable view. The same handler already computes `view` via
`agentView(agent)`, which is the authoritative "what this step can call".

The fix is one word (`pool` → `view`) plus a comment, but the invariant is worth pinning: `visible ⊆ callable` and
`awaiting ∩ callable = ∅`. The new test builds a composition that contains `read`, has "another plugin" hide it, and
asserts the status does not list it. Verified as a real regression test: it fails with `pool.has` (`8/9`) and passes with
`view.has` (`9/9`).

Note this symptom was already absent from the 0.1.2 status in the same session (`visible` = `pwsh` + `read_image`),
because the universe fallback was the first bug; the remaining exposure is a restriction that cannot be applied (for
example a stacked plugin, or `restrict()` throwing), where `visible` would again have listed names the step cannot call.

## Compatibility smoke — DSH 0.2.2-rc.5 / Desktop 2.0.24-next (2026-11-19)

The desktop auto-updated from rc.3/2.0.23 to rc.5/2.0.24 in the days after the release, so the same plugin was
re-checked on the new runtime with no code changes:

| Check | Observation |
| --- | --- |
| plugin still applies | lead session `toolbox_status`: `restricted: true`, `agentToolCount: 45`, `composedToolCount: 49`, `awaitingCount: 4` — same shape as on rc.3 |
| fresh agent is restricted | child session `7a62b308` (cordis): first `request/header` = **18 tools**, `toolbox_status` reports `restricted: true`, `agentToolCount: 19`, `composedToolCount: 49`, `awaitingCount: 30` |
| tokenised search | `toolbox_search("list subagent models")` → `tokens: ["list","subagent","models"]`, 15 hits, `list_subagent_models` first |
| activation + incremental channel | `toolbox_load(["list_subagent_models"])` → `activated`, the next `request/header` grows 18 → **19 tools**, and a `developer/message` carries the `tool-addition` block |
| loaded tool callable | `list_subagent_models()` returned `deepseek-account — DeepSeek Account` |
| no restriction-caused errors | no error tool results in `7a62b308` |
| unit gate | `npm test` 9/9, `npm run check` pass under Node 24.19.0 |
