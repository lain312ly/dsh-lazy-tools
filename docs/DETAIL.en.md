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

## How it works

1. On `agent/created` the plugin reads **the agent's own tool view** (before this plugin restricts anything), builds a
   deny-list from every name outside the resident layer, and calls `agent.ctx.tools.restrict({ deny })`. A deny-list,
   not an allow-list: a preset registers its core tools (`read`/`write`/`pwsh`) in its own scope, so they are missing
   from the global registry and an allow-list would hide them too. Deny names only tools the plugin can prove it should
   hide, and skips the tools this session has already activated when the restriction is rebuilt.
2. When the model calls `toolbox_load(["name"])`, the name joins that session's activation set, the old restriction is
   lifted, the agent view is read again, and the deny-list is rebuilt from the new set.
3. The tool registry changed, so the agent loop records a `developer/message` (source `tool-registry`) carrying a
   `tool-addition` block.
4. When the route declares the `toolUpdate` capability, the DeepSeek adapter serializes that block as `tool_addition`
   and adds the tool-changes `anthropic-beta` header — an appended activation block instead of a rewritten prefix.
5. When the route does not declare it, DSH strips the developer message and the tool simply appears in the next full
   tool table: the feature still works, it just saves the initial table instead of an incremental channel.

Activation is never persisted: a resumed session derives it from `session.toolHistory()` (the session log is the source
of truth), so continuation and fork behave the same. `resumePreserve` (on by default) treats tools already declared in
the session as loaded, so a resumed conversation does not lose half of its surface.

## Tools

| Tool | Purpose |
| --- | --- |
| `toolbox_search(query, limit?)` | Search installed-but-unloaded tools by name or description; returns name, one-line description, loaded flag |
| `toolbox_load(names[])` | Activate tools for the calling agent; returns parameter names and required fields so the next step can call them |
| `toolbox_status()` | Diagnostics: provider/model, route `toolUpdate` capability, resident / activated / awaiting lists |

## Configuration (the `lazy-tools` row in `cordis.patch.yml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `visible` | `[]` | Extra tool names for the resident layer; unknown names are ignored |
| `promptSection` | `true` | Inject the deferred-tool catalog prompt section |
| `promptOrder` | `3150` | Section order (between MCP_SERVERS and TOOLS_SDK) |
| `searchLimit` | `8` | Default result count for `toolbox_search`, capped at 50 |
| `statusTool` | `true` | Register `toolbox_status` |
| `resumePreserve` | `true` | Treat tools declared earlier in the session as loaded on resume |

Example — keep `subagent` and `web_search` resident too:

```yaml
- id: lazy-tools
  config:
    visible: [subagent, web_search]
```

The default resident layer comes from a 30-day census of the author's machine, so **tune it to your own usage after
installing**: run `python scripts/tool-census.py --days 30` to get your own calls-per-day and schema sizes, add the
tools it marks `resident` to `visible`, and confirm the result with `toolbox_status` in a new session (unknown names
are ignored silently).

## Measured (DSH Desktop 2.0.23-next, `@deepseek-ai/dsh@0.2.2-rc.3`, Windows)

- Baseline session without the plugin: 42 tools, **39,429 characters**.
- 14 resident tools accounted for 13,034 of those characters; hideable candidates about 26,300.
- New session with the plugin: **18 tools, 14,496 characters** in the first request (15 of the 16 resident names plus
  3 toolbox tools; the preset registers `exit_plan_mode` right after that request), about 24 tools hidden.
- The route reported `toolUpdate: addition-only`; after `toolbox_load` the log contains
  `developer/message(tool-addition)` and the tool is callable immediately.

## Known limitations

- **Only agents created after activation are restricted.** Sessions that already exist keep the full surface; open a
  new conversation to see the effect.
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
