# Verification

Every claim in the README and in `docs/DETAIL.*.md` was measured on a live DSH installation. This page records the
environment, the method, the observations, and what remains unverified, so the numbers can be reproduced.

Session identifiers are truncated to 8 characters; full logs stay on the test machine.

## Environment

| Item | Value |
| --- | --- |
| DSH Desktop | 2.0.23-next |
| `@deepseek-ai/dsh` | 0.2.2-rc.3 |
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

## Not verified

- **Rendered metadata.** The Plugin Manager detail page, localized title/description, and icon were checked as files and
  through the Host's resource loading, but not visually: the running GUI requires re-authentication, so no browser
  screenshot was taken. Text and paths are confirmed; rendering is not.
- **Other platforms.** macOS and Linux were not tested.
- **Routes without `toolUpdate`.** The `null` path (tool still loads, no `tool_addition` block) is implemented and
  documented but could not be observed on this installation, whose route reports `addition-only`.
- **Unload.** `addition-only` routes discard `tool_removal`, so unloading is intentionally unsupported and untested.
