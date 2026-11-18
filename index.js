/**
 * dsh-lazy-tools — cache-friendly progressive tool disclosure for DeepSeek Harness.
 *
 * The plugin keeps a curated tool surface visible and hides the rest of an
 * agent's tool registry behind a per-agent `tools.restrict({ deny })`
 * restriction. Hidden tools are discoverable with `toolbox_search` and become
 * callable again after `toolbox_load`. Activation is an ordinary tool-registry
 * change, so the agent loop records a `developer/message` and the DeepSeek
 * adapter projects it as a `tool_addition` content block (`defer_loading` marks
 * declarations added later).
 *
 * Why deny instead of allow: a preset registers its core tools in its own scope,
 * so they are absent from the global registry view. An allow-list computed from
 * the global view would hide `read`/`write`/`pwsh` as collateral damage; a
 * deny-list computed from the agent's own pre-restriction view hides exactly what
 * the plugin can prove it should hide.
 *
 * No DSH core change is involved and no dependency is imported: tool definitions
 * are plain objects understood by `ctx.tools.register`.
 */

export const name = 'lazy-tools'
export const inject = ['tools', 'systemPrompt']

/** Tools that implement the disclosure mechanism itself; never hidden. */
const TOOLBOX = ['toolbox_search', 'toolbox_load', 'toolbox_status']

/** PTC presentation transport; `tools.restrict()` rejects this name. */
const RUN_CODE = 'run_code'

/** Tool surface kept visible by default (missing names are ignored).
 *
 * Chosen from a 30-day tool-call census of this machine's session logs
 * (200 sessions, 17,166 calls): every non-lazy tool with >=100 calls/month and
 * a schema under 1.5k characters stays resident; the rest is deferred.
 * `run_code` is exempt because `tools.restrict()` cannot name it.
 */
const DEFAULT_VISIBLE = [
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'pwsh',
  'bash',
  'read_image',
  'web_fetch',
  'todo_write',
  'ask_user_question',
  'skill',
  'present',
  'job_list',
  'job_output',
  'job_kill',
  'exit_plan_mode',
]

/** Clamp one config object into the shape this plugin expects. */
function normalizeConfig(raw) {
  const config = {
    visible: [],
    promptSection: true,
    promptOrder: 3150,
    searchLimit: 8,
    statusTool: true,
    resumePreserve: true,
  }
  if (raw === null || typeof raw !== 'object') return config
  if (Array.isArray(raw.visible)) {
    config.visible = raw.visible.filter(name => typeof name === 'string' && name.length > 0)
  }
  if (typeof raw.promptSection === 'boolean') config.promptSection = raw.promptSection
  if (Number.isFinite(raw.promptOrder)) config.promptOrder = raw.promptOrder
  if (Number.isInteger(raw.searchLimit) && raw.searchLimit > 0) {
    config.searchLimit = Math.min(raw.searchLimit, 50)
  }
  if (typeof raw.statusTool === 'boolean') config.statusTool = raw.statusTool
  if (typeof raw.resumePreserve === 'boolean') config.resumePreserve = raw.resumePreserve
  return config
}

const textBlock = text => [{ type: 'text', text }]

/** Compact JSON that never carries `undefined`. */
const asJson = value => JSON.stringify(value)

/** One-line parameter digest used by toolbox_load results. */
function parameterDigest(definition) {
  const parameters = definition && typeof definition.parameters === 'object' && definition.parameters !== null
    ? definition.parameters
    : {}
  const properties = parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : {}
  return {
    parameters: Object.keys(properties),
    required: Array.isArray(parameters.required) ? parameters.required.filter(item => typeof item === 'string') : [],
  }
}

/** Tool names named by a `tools.restrict()` validation error, if it listed them. */
function restrictableFromError(error) {
  const message = String((error && error.message) || error)
  const marker = 'known global tools: '
  const index = message.lastIndexOf(marker)
  if (index < 0) return undefined
  const tail = message.slice(index + marker.length).trim()
  if (tail.length === 0) return new Set()
  return new Set(tail.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0))
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  const visible = new Set()
  for (const name of DEFAULT_VISIBLE) if (name !== RUN_CODE) visible.add(name)
  for (const name of config.visible) if (name !== RUN_CODE) visible.add(name)

  /** sessionId -> { agent, activated:Set<string>, snapshot:Map, dispose? } */
  const agents = new Map()
  /** Every tool definition this plugin has observed, from the global or an agent view. */
  const universe = new Map()
  let mutating = false
  let refreshQueued = false

  const warn = (message, error) => {
    const detail = error === undefined ? '' : String((error && error.message) || error)
    console.warn(`[lazy-tools] ${message}${detail === '' ? '' : `: ${detail}`}`)
  }

  const absorb = definitions => {
    const snapshot = new Map()
    for (const definition of definitions) {
      snapshot.set(definition.name, definition)
      universe.set(definition.name, definition)
    }
    return snapshot
  }

  /** Global registry view, added to the universe. */
  function globalDefinitions() {
    try {
      return absorb(ctx.tools.definitions())
    } catch (error) {
      warn('could not read the global tool registry', error)
      return new Map()
    }
  }

  /** One agent's own pre-restriction view, added to the universe. */
  function snapshotFor(agent) {
    try {
      return absorb(agent.ctx.tools.definitions(agent))
    } catch (error) {
      warn(`could not read the agent tool view for ${agent.id}`, error)
      return new Map()
    }
  }

  /** Names this plugin would hide for one agent, given its activated set. */
  function denyFor(snapshot, activated) {
    const deny = []
    for (const name of snapshot.keys()) {
      if (name === RUN_CODE || visible.has(name) || TOOLBOX.includes(name)) continue
      if (activated.has(name)) continue
      deny.push(name)
    }
    return deny
  }

  /** Apply a deny-list, tolerating names the scope layer does not let us name. */
  function restrictAgent(state, deny) {
    if (deny.length === 0) return undefined
    try {
      return state.agent.ctx.tools.restrict({ deny })
    } catch (error) {
      const restrictable = restrictableFromError(error)
      if (restrictable === undefined) {
        warn(`could not restrict tools for ${state.agent.id}`, error)
        return undefined
      }
      const filtered = deny.filter(name => restrictable.has(name))
      if (filtered.length === 0) return undefined
      try {
        return state.agent.ctx.tools.restrict({ deny: filtered })
      } catch (retryError) {
        warn(`could not restrict tools for ${state.agent.id}`, retryError)
        return undefined
      }
    }
  }

  /** Lift the previous restriction and read this agent's own composed tool set.
   *
   * The read must happen with the restriction lifted, otherwise the plugin would
   * observe its own hiding as "this tool does not exist". The resulting snapshot
   * is the only authority on what this agent can ever call: `tools.restrict()`
   * can un-hide a composed tool, it can never create one that the preset did not
   * mount. Activations that disappeared from the composition (a preset switch,
   * a disabled plugin) are dropped here and reported through `dropped`.
   */
  function liftRestriction(state) {
    try {
      state.dispose?.()
    } catch (error) {
      warn(`could not lift the previous restriction for ${state.agent.id}`, error)
    }
    state.dispose = undefined
    const snapshot = snapshotFor(state.agent)
    state.snapshot = snapshot
    state.dropped = new Set()
    for (const name of [...state.activated]) {
      if (snapshot.has(name)) continue
      state.activated.delete(name)
      state.dropped.add(name)
    }
    return snapshot
  }

  /** Re-apply the restriction from the current snapshot and activation set. */
  function settleRestriction(state) {
    state.dispose = restrictAgent(state, denyFor(state.snapshot, state.activated))
  }

  /** Rebuild one agent's restriction from its live view. */
  function applyRestriction(state) {
    liftRestriction(state)
    settleRestriction(state)
  }

  /** Tool names a resumed session already declared, folded from its log. */
  function previouslyDeclared(agent) {
    const names = new Set()
    try {
      const history = agent.session.toolHistory()
      for (const tool of history.tools) names.add(tool.name)
      for (const update of history.updates) {
        for (const tool of update.additions) names.add(tool.name)
      }
    } catch (error) {
      warn(`could not read tool history for ${agent.id}`, error)
    }
    return names
  }

  /** Per-agent state, restored from the session log on first sight. */
  function stateFor(agent) {
    const existing = agents.get(agent.id)
    if (existing !== undefined) return existing
    const state = { agent, activated: new Set(), snapshot: new Map(), dispose: undefined, dropped: new Set() }
    agents.set(agent.id, state)
    if (!config.resumePreserve) return state
    const declared = previouslyDeclared(agent)
    for (const name of declared) {
      if (name === RUN_CODE || visible.has(name) || TOOLBOX.includes(name)) continue
      state.activated.add(name)
    }
    return state
  }

  /** State for one agent, applying the restriction first if it was never applied.
   *
   * `agent/created` is the normal entry point, but it cannot fire for an agent
   * that already existed when this plugin instance loaded (a profile restart in
   * the middle of a session, a plugin update, a hot reload). Without this the
   * session would silently run unrestricted and `toolbox_search` would offer the
   * process-wide universe, including tools this preset never mounted.
   */
  function ensureState(agent) {
    const state = stateFor(agent)
    if (state.snapshot.size > 0) return state
    mutating = true
    try {
      applyRestriction(state)
    } catch (error) {
      warn(`could not restrict tools for ${agent.id}`, error)
    } finally {
      mutating = false
    }
    return state
  }

  function activatedOf(agent) {
    if (agent === undefined) return undefined
    return agents.get(agent.id)
  }

  /** The agent's currently callable tool names, as the step sees them. */
  function agentView(agent) {
    try {
      return new Set(agent.ctx.tools.definitions(agent).map(definition => definition.name))
    } catch (error) {
      warn(`could not read the agent tool view for ${agent.id}`, error)
      return new Set()
    }
  }

  /** The tool definitions this agent could ever call, hidden or not.
   *
   * An agent's own composition is authoritative; the process-wide universe is
   * only a fallback for calls without an agent context (the prompt catalog).
   * Using the universe here would offer tools that another preset mounted and
   * this agent never had, so `toolbox_load` would report them as activated and
   * the model would then get `unknown tool` from the platform.
   */
  function poolFor(agent) {
    const state = activatedOf(agent)
    if (state !== undefined && state.snapshot.size > 0) return state.snapshot
    return universe
  }

  /** Universe entries this plugin hides from at least one agent. */
  function awaitingNames(agent) {
    const state = activatedOf(agent)
    const pool = poolFor(agent)
    const names = []
    for (const name of pool.keys()) {
      if (name === RUN_CODE || visible.has(name) || TOOLBOX.includes(name)) continue
      if (state !== undefined && state.activated.has(name)) continue
      names.push(name)
    }
    return names.sort()
  }

  function catalogText() {
    globalDefinitions()
    const names = awaitingNames(undefined)
    if (names.length === 0) return ''
    const shown = names.slice(0, 80).join(', ')
    const more = names.length > 80 ? `, and ${names.length - 80} more` : ''
    return 'Deferred tools seen in this installation: ' + shown + more + '.\n'
      + 'They are intentionally absent from your tool list to save context. '
      + 'Not every one of them belongs to your preset: toolbox_search only returns the ones you can actually load, '
      + 'and toolbox_load reports the rest as unavailable. '
      + 'Call toolbox_search(query) to inspect a candidate, then toolbox_load(names) to activate it before use.'
  }

  // ---------------------------------------------------------------------
  // Lifecycle: one restriction per agent, kept in sync with the registry.
  // ---------------------------------------------------------------------

  ctx.on('agent/created', payload => {
    const agent = payload && payload.agent
    if (agent === undefined) return
    const state = stateFor(agent)
    mutating = true
    try {
      applyRestriction(state)
    } finally {
      mutating = false
    }
  })

  ctx.on('agent/disposed', payload => {
    const agent = payload && payload.agent
    if (agent === undefined) return
    const state = agents.get(agent.id)
    if (state === undefined) return
    agents.delete(agent.id)
    try {
      state.dispose?.()
    } catch (error) {
      warn(`could not release the restriction for ${agent.id}`, error)
    }
  })

  ctx.on('tools/change', () => {
    if (mutating || refreshQueued) return
    refreshQueued = true
    queueMicrotask(() => {
      refreshQueued = false
      mutating = true
      try {
        for (const state of agents.values()) applyRestriction(state)
      } finally {
        mutating = false
      }
    })
  })

  // A plugin unload must not leave per-agent restrictions behind.
  try {
    ctx.effect(() => () => {
      for (const state of agents.values()) {
        try {
          state.dispose?.()
        } catch {
          // The agent scope may already be gone.
        }
      }
      agents.clear()
    }, 'lazy-tools:release-agent-restrictions')
  } catch (error) {
    warn('could not install the unload cleanup', error)
  }

  // ---------------------------------------------------------------------
  // toolbox_search: compact discovery over hidden tools.
  // ---------------------------------------------------------------------

  try {
    ctx.tools.register({
      name: 'toolbox_search',
      description: 'Search tools that are installed but not loaded yet. Matches tool names and one-line descriptions; call toolbox_load with the returned names to activate them before use.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Case-insensitive text matched against tool names and descriptions.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results to return (default 8, capped at 50).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textBlock(asJson(value)),
      },
      execute: async (args, exec) => {
        const query = args !== null && typeof args === 'object' && typeof args.query === 'string' ? args.query.trim() : ''
        if (query.length === 0) throw new Error('query must be a non-empty string')
        const requested = args !== null && typeof args === 'object' && Number.isInteger(args.limit) && args.limit > 0
          ? args.limit
          : config.searchLimit
        const limit = Math.min(requested, 50)
        const tokens = query.toLowerCase().split(/[^a-z0-9_]+/).filter(token => token.length > 0)
        if (tokens.length === 0) throw new Error('query must contain at least one searchable word')
        const agent = exec ? exec.agent : undefined
        const state = agent === undefined ? undefined : ensureState(agent)
        const pool = poolFor(agent)
        // Only surface tools the step cannot already call.
        const view = agent === undefined ? new Set() : agentView(agent)
        const results = []
        for (const [toolName, definition] of pool) {
          if (toolName === RUN_CODE || visible.has(toolName) || TOOLBOX.includes(toolName)) continue
          if (view.has(toolName)) continue
          if (state !== undefined && state.activated.has(toolName)) continue
          const description = typeof definition.description === 'string' ? definition.description : ''
          const haystack = `${toolName} ${description}`.toLowerCase()
          const nameLower = toolName.toLowerCase()
          const hits = tokens.filter(token => haystack.includes(token))
          if (hits.length === 0) continue
          const nameHit = hits.some(token => nameLower.includes(token))
          results.push({
            name: toolName,
            score: (nameHit ? 0 : 10) - hits.length,
            description: description.length > 160 ? `${description.slice(0, 157)}...` : description,
            loaded: false,
          })
        }
        results.sort((left, right) => left.score - right.score || left.name.localeCompare(right.name))
        return {
          query,
          tokens,
          total: results.length,
          results: results.slice(0, limit).map(({ name: toolName, description, loaded }) => ({ name: toolName, description, loaded })),
        }
      },
    })
  } catch (error) {
    warn('could not register toolbox_search', error)
  }

  // ---------------------------------------------------------------------
  // toolbox_load: activate hidden tools for the calling agent.
  // ---------------------------------------------------------------------

  try {
    ctx.tools.register({
      name: 'toolbox_load',
      description: 'Load (activate) installed tools that are currently hidden. Provide the exact tool names; they become callable from the next step.',
      parameters: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exact tool names to activate, for example ["schedule_list"].',
          },
        },
        required: ['names'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textBlock(asJson(value)),
      },
      execute: async (args, exec) => {
        const agent = exec ? exec.agent : undefined
        if (agent === undefined) throw new Error('toolbox_load must be called by an agent')
        const rawNames = args !== null && typeof args === 'object' && Array.isArray(args.names) ? args.names : []
        const requested = rawNames.filter(entry => typeof entry === 'string' && entry.trim().length > 0).map(entry => entry.trim())
        if (requested.length === 0) throw new Error('names must be a non-empty array of tool names')

        const state = ensureState(agent)
        // What the step can call right now (the restriction is still applied).
        const visibleNow = agentView(agent)

        // Decide against the agent's own composed tool set, never the process-wide
        // universe: `tools.restrict()` can un-hide a composed tool but cannot
        // create one, so a name outside the composition must not be "activated".
        mutating = true
        let snapshot
        try {
          snapshot = liftRestriction(state)
        } finally {
          mutating = false
        }

        const activated = []
        const alreadyAvailable = []
        const unavailable = []
        const unknown = []
        for (const toolName of requested) {
          if (TOOLBOX.includes(toolName) || visibleNow.has(toolName)) {
            alreadyAvailable.push(toolName)
            continue
          }
          if (!snapshot.has(toolName)) {
            // Known to the installation (another preset mounted it) but not part
            // of this agent's composition: hiding is reversible, mounting is not.
            if (universe.has(toolName)) unavailable.push(toolName)
            else unknown.push(toolName)
            continue
          }
          if (state.activated.has(toolName)) {
            alreadyAvailable.push(toolName)
            continue
          }
          state.activated.add(toolName)
          activated.push(toolName)
        }

        mutating = true
        try {
          settleRestriction(state)
        } finally {
          mutating = false
        }

        const loaded = activated.map(toolName => ({
          name: toolName,
          ...parameterDigest(snapshot.get(toolName)),
        }))
        return {
          activated,
          alreadyAvailable,
          unavailable,
          unknown,
          dropped: [...state.dropped],
          loaded,
          note: activated.length > 0
            ? 'Activated tools are callable from the next step; their definitions arrive through the tool update channel.'
            : 'No tool was activated.',
        }
      },
    })
  } catch (error) {
    warn('could not register toolbox_load', error)
  }

  // ---------------------------------------------------------------------
  // toolbox_status: capability probe and diagnostics.
  // ---------------------------------------------------------------------

  if (config.statusTool) {
    try {
      ctx.tools.register({
        name: 'toolbox_status',
        description: 'Report the lazy-tool surface for this session: model route, whether the route supports mid-conversation tool updates, which tools are visible, loaded, or still deferred.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => textBlock(asJson(value)),
        },
        execute: async (_args, exec) => {
          const agent = exec ? exec.agent : undefined
          const state = agent === undefined ? undefined : ensureState(agent)
          globalDefinitions()
          const view = agent === undefined ? new Set() : agentView(agent)
          const pool = poolFor(agent)
          const awaiting = awaitingNames(agent)
          const selection = agent !== undefined && agent.model !== undefined && typeof agent.model.current === 'function'
            ? agent.model.current()
            : undefined

          let toolUpdate = null
          let capabilityError = null
          const llm = ctx.get('llm')
          if (llm !== undefined && selection !== undefined) {
            try {
              const info = await llm.resolveModelInfo(selection.provider, selection.model, exec ? exec.signal : undefined)
              toolUpdate = info !== undefined && info.toolUpdate !== undefined ? info.toolUpdate : null
            } catch (error) {
              capabilityError = String((error && error.message) || error)
            }
          }

          return {
            provider: selection !== undefined ? selection.provider : null,
            model: selection !== undefined ? selection.model : null,
            toolUpdate,
            capabilityError,
            restricted: state !== undefined && state.dispose !== undefined,
            agentToolCount: agent !== undefined ? view.size : null,
            composedToolCount: agent !== undefined ? pool.size : null,
            // What the step can call right now. `pool` is the composition the
            // agent *could* call; a resident name outside it (universe fallback)
            // or one hidden by a stacked restriction is not visible to the model.
            visible: [...visible].filter(toolName => view.has(toolName)),
            activated: state !== undefined ? [...state.activated] : [],
            dropped: state !== undefined ? [...state.dropped] : [],
            awaitingCount: awaiting.length,
            awaiting,
          }
        },
      })
    } catch (error) {
      warn('could not register toolbox_status', error)
    }
  }

  // ---------------------------------------------------------------------
  // Compact prompt catalog so the model knows hidden tools exist.
  // ---------------------------------------------------------------------

  if (config.promptSection) {
    try {
      ctx.systemPrompt.section({
        name: 'lazy-tools-catalog',
        order: config.promptOrder,
        text: () => catalogText(),
      })
    } catch (error) {
      warn('could not register the deferred-tool prompt section', error)
    }
  }

  // Re-attach to agents that were already live when this instance loaded: a
  // plugin update or hot reload releases every restriction, and `agent/created`
  // will never fire again for those sessions. `previouslyDeclared` keeps tools
  // their log already announced callable, so this only restores the hiding the
  // conversation never saw. Runs last so the snapshot includes this plugin's own
  // toolbox tools.
  try {
    const service = ctx.get('agents')
    if (service !== undefined && typeof service.list === 'function') {
      mutating = true
      try {
        for (const agent of service.list()) {
          if (agent === undefined || agent.id === undefined) continue
          try {
            applyRestriction(stateFor(agent))
          } catch (error) {
            warn(`could not re-attach to the live agent ${agent.id}`, error)
          }
        }
      } finally {
        mutating = false
      }
    }
  } catch (error) {
    warn('could not enumerate live agents on load', error)
  }
}
