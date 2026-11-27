# Progressive tool disclosure (dsh-lazy-tools)

Rarely used tools are removed from every model request and loaded on demand. Activation travels through DeepSeek's
`tool_addition` / `defer_loading` channel, which DSH already implements, so no core change and no dependency is involved.

## The problem

A profile with a few plugins easily produces 40k characters of tool declarations (`request/header.tools`). One measured
42-tool session carried **39,429 characters**, sent with every request and rewritten into the prompt cache repeatedly.
Almost every session only calls 5–10 of those tools.

The plugin splits the surface into two layers:

- **Resident layer**: `read` `write` `edit` `glob` `grep` `pwsh` `bash` `read_image` `web_fetch` `todo_write`
  `ask_user_question` `skill` `present` `job_list` `job_output` `job_kill` `exit_plan_mode` (extend with `visible`).
  The list is measured, not guessed: a census of 200 sessions and 17,166 tool calls kept every non-lazy tool with
  ≥100 calls per month and a schema under 1.5k characters; `run_code` stays resident because `restrict()` cannot name it.
- **Deferred layer**: every other global tool. Those are absent from the initial tool table; the system prompt keeps one
  compact catalog line, and the model calls `toolbox_search` to find a candidate and `toolbox_load` to activate it.
  That line is built from **this agent's own** tool set (never a tool only another preset mounts, never one this session
  already loaded) and is fixed at the session's first assembly: DSH keeps a changed system prompt by appending it, so a
  catalog that shrank with every activation would cost one full prompt copy each time.

## How it works

1. On `agent/created` the plugin reads **the agent's own tool view** (before this plugin restricts anything), builds a
   deny-list from every name outside the resident layer, and calls `agent.ctx.tools.restrict({ deny })`. A deny-list,
   not an allow-list: a preset registers its core tools (`read`/`write`/`pwsh`) in its own scope, so they are missing
   from the global registry and an allow-list would hide them too. Deny names only tools the plugin can prove it should
   hide, and skips the tools this session has already activated when the restriction is rebuilt. On load (enable,
   update, hot reload) the same pass runs over every live agent in `ctx.agents.list()` — otherwise the restrictions
   released at unload would never be restored and open sessions would silently run on the full tool surface.
2. When the model calls `toolbox_load(["name"])`, the plugin lifts the old restriction and reads the agent view again:
   that read is the session's real composed tool set. A name outside it is reported as `unavailable` (mounted by another
   preset, not by this one) instead of being activated — `restrict()` can un-hide a composed tool, never create one.
3. The tool registry changed, so the agent loop records a `developer/message` (source `tool-registry`) carrying a
   `tool-addition` block.
4. When the route declares the `toolUpdate` capability, the DeepSeek adapter serializes that block as `tool_addition`
   and adds the tool-changes `anthropic-beta` header — an appended activation block instead of a rewritten prefix.
5. When the route does not declare it, DSH strips the developer message and the tool simply appears in the next full
   tool table: the feature still works, it just saves the initial table instead of an incremental channel.
6. A preset switch or a plugin enable/disable raises `tools/change`: the plugin recomposes, drops activations the new
   composition no longer mounts, and reports them in `toolbox_status.dropped`.

**Presentation matters.** Steps 3–5 only happen under the **native presentation** (`standard`, `cordis`, `minimal`, and
custom presets that declare no executor): every tool goes into `request/header.tools`, so there is something to append to.
Under the **PTC presentation** (`ptc`, `flash-lean-ptc-v3`) the header is always `[run_code]` and the tool surface lives in
the system prompt as a `ToolArgsMap` SDK block, so no `tool-addition` exists; each load grows the next request's system
prompt and therefore rewrites the prefix (a cache miss). Load in batches there.

Activation is never persisted: a resumed session derives it from `session.toolHistory()` (the session log is the source
of truth), so continuation and fork behave the same. `resumePreserve` (on by default) treats tools already declared in
the session as loaded, so a resumed conversation does not lose half of its surface.

## Tools

| Tool | Purpose |
| --- | --- |
| `toolbox_search(query, limit?)` | Search the tools this preset composed but the plugin hides, tokenising the query |
| `toolbox_load(names[])` | Activate tools for the calling agent; returns parameter names and required fields. Names this session never composed land in `unavailable`; names the installation does not know land in `unknown` |
| `toolbox_status()` | Diagnostics: provider/model, route `toolUpdate`, `composedToolCount`, resident / activated / awaiting / dropped, `census` |
| `toolbox_census(dryRun?)` | Measure the same usage now and re-derive the resident layer; `dryRun` reports without changing anything |

## The resident layer calibrates itself every month

The resident layer is not a frozen constant; it is re-derived from this machine's own usage:

- Source: DSH's `sessionQuery` service — `listSessions()` for the corpus, `inspectSession()` for events; the plugin
  counts `tool/call` and `tool/ptc-dispatch` (only the latter names the inner tool under a PTC preset);
- Read-only, bounded to the sessions inside `windowDays` (default 30) up to `maxSessions` (default 200), yielding with
  `setImmediate` between sessions so the agent loop keeps running. Measured here: 109 sessions, 10,069 calls, 3.7 s;
- The divisor is the span the counts actually cover (oldest counted event to now, capped at the window), so a machine
  with three days of history is not divided by 30 and does not mark everything as rare;
- Schema sizes come from the declarations the plugin itself observed (`universe`), not from `request/header.tools`;
- The clock starts when a census *finishes*: the result carries `lastAt` and the next run is due
  `lastAt + intervalDays`. With no record yet (fresh install) the first run happens `startDelayMs` (30 s) after load.
  The interval is configurable (1–365 days); `0` keeps it manual;
- Changing a threshold (`windowDays` / `minCallsPerDay` / `maxSchemaChars` / `dominantCallsPerDay`) invalidates the old
  result, so the next run recomputes under the new rules;
- The result lives in `$DSH_HOME/lazy-tools/census.json` and is adopted on load, so a restart does not rescan;
- Applying it rebuilds every live agent's restriction and unfreezes the prompt catalog for the next assembly;
- `visible` always adds on top: a tool you pin is never squeezed out by the census, and `census.apply: false` records the
  measurement without altering the layer.

## Configuration (the `lazy-tools` row in `cordis.patch.yml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `visible` | `[]` | Extra tool names for the resident layer; unknown names are ignored |
| `promptSection` | `true` | Inject the deferred-tool catalog prompt section |
| `promptOrder` | `3150` | Section order (between MCP_SERVERS and TOOLS_SDK) |
| `searchLimit` | `8` | Default result count for `toolbox_search`, capped at 50 |
| `statusTool` | `true` | Register `toolbox_status` |
| `resumePreserve` | `true` | Treat tools declared earlier in the session as loaded on resume |
| `census.enabled` | `true` | Run the scheduled census at all |
| `census.intervalDays` | `30` | Days between runs; `0` keeps it manual |
| `census.windowDays` | `30` | Look-back window |
| `census.minCallsPerDay` | `3` | Below this rate a tool is deferred |
| `census.maxSchemaChars` | `1500` | Above this size a tool is deferred unless dominant |
| `census.dominantCallsPerDay` | `50` | At or above this rate a tool stays resident regardless of size |
| `census.maxSessions` | `200` | Newest sessions considered |
| `census.apply` | `true` | Whether the result becomes the resident layer |
| `census.startDelayMs` | `30000` | Delay before the first run after load |

Example — keep `subagent` and `web_search` resident too:

```yaml
- id: lazy-tools
  config:
    visible: [subagent, web_search]
```

The shipped resident layer comes from a 30-day census of the author's machine; **after installing, the monthly census
re-derives it from your own usage**. Pinning tools still uses `visible`, which is additive and never overridden. To look
first, without DSH running, `python scripts/tool-census.py --days 30` reads the same logs and writes nothing.

The census only reads `~/.dsh/sessions/**/session.v4.jsonl.zstd`; it writes nothing and never touches the network. It
needs Python 3.10+ and `zstandard` (`pip install zstandard`). It counts dispatches (`tool/call` on native presets,
`tool/ptc-dispatch` on PTC) and schema characters (from `request/header.tools` of native sessions), marks a tool
`resident` when it averages at least 3 calls/day with a schema of at most 1500 characters, and always keeps a tool
averaging 50+ calls/day resident regardless of schema size.

| Flag | Default | Effect |
| --- | --- | --- |
| `--days` | `30` | Census window |
| `--min-calls-per-day` | `3` | Below this average → `defer` |
| `--max-schema-chars` | `1500` | Larger schemas stay deferred unless dominant |
| `--dominant-calls-per-day` | `50` | Above this average → `resident` unconditionally |
| `--sessions` | `~/.dsh/sessions` | Log root |
| `--json` | off | Machine-readable output |

The script lives at `scripts/tool-census.py` in the repository; in a bundle installed from GitHub it sits at
`~/.dsh/profiles/<profile>/node_modules/dsh-lazy-tools/scripts/` (shipped since 0.1.5).

## Measured (DSH Desktop 2.0.23-next / 2.0.24-next, `@deepseek-ai/dsh@0.2.2-rc.3` / `0.2.2-rc.5`, Windows)

- Baseline session without the plugin: 42 tools, **39,429 characters**.
- 14 resident tools accounted for 13,034 of those characters; hideable candidates about 26,300.
- New session with the plugin: **18 tools, 14,496 characters** in the first request (15 of the 16 resident names plus
  3 toolbox tools; the preset registers `exit_plan_mode` right after that request), about 24 tools hidden.
- The route reported `toolUpdate: addition-only`; after `toolbox_load` the log contains
  `developer/message(tool-addition)` and the tool is callable immediately.

## Known limitations

- **How much you save immediately depends on what the session already declared.** On load the plugin walks
  `ctx.agents.list()` and re-applies the restriction to every live agent, but `resumePreserve` treats every tool the
  session log already announced as loaded (otherwise the model would hold names it cannot call). A conversation that
  already saw the full tool table before the plugin was enabled is therefore not hidden retroactively — open a new
  conversation for the full saving.
- `tools.restrict()` only reaches tools on the agent's inheritance chain. Tools an agent registers in its own scope
  cannot be named, so the plugin filters them out — an intentional safety bound.
- `addition-only` routes discard `tool_removal`, so a loaded tool **cannot be hidden again inside the same session**
  (there is no in-session unload): it simply stays resident for the rest of that conversation. This has nothing to do
  with uninstalling the bundle — disable or remove the `lazy-tools` row at any time, see "Uninstall the bundle" below.
- With other plugins that also call `tools.restrict`, the restrictions intersect and may over-hide. Disable this plugin
  to recover.
- Without a `toolUpdate` capability the load still works but no `tool_addition` block appears: you save the initial tool
  table, not the incremental update. Check the value with `toolbox_status`.

## Troubleshooting

1. Call `toolbox_status` in a new session and confirm `restricted: true` and `toolUpdate` equal to `addition-only` or
   `in-history`.
2. If `toolUpdate` is `null`, declare the capability for the account route in the profile's `cordis.patch.yml` and reload:

```yaml
- id: llm-deepseek-account
  config:
    modelOverrides:
      deepseek-flash:
        toolUpdate: 'addition-only'
```

3. On HTTP 400 or any `tool_addition` error, disable the plugin (`set_plugin enabled:false`) and remove that override.
4. After editing `index.js`, disable and re-enable the bundle: an already loaded JS module is not hot-replaced.

## Uninstall the bundle

Disable or remove the `lazy-tools` row in Plugin Manager. Every per-agent restriction is destroyed with the plugin
fiber and the agent scope, and new sessions get the full surface back.
