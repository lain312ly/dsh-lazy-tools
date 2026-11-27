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
 * The resident layer is a measurement, not a taste: a monthly census counts this
 * machine's own tool calls from the session logs and re-derives which tools stay
 * visible. The first census runs on the first load (or the first load after the
 * window expired) and every run records its own timestamp, so the next one is
 * due one interval later — not at install time. `census.intervalDays` changes
 * the period; `0` keeps the census manual (`toolbox_census`).
 *
 * No DSH core change is involved and no dependency is imported: tool definitions
 * are plain objects understood by `ctx.tools.register`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'lazy-tools'
export const inject = ['tools', 'systemPrompt']

/** Tools that implement the disclosure mechanism itself; never hidden. */
const TOOLBOX = ['toolbox_search', 'toolbox_load', 'toolbox_status', 'toolbox_census']

/** PTC presentation transport; `tools.restrict()` rejects this name. */
const RUN_CODE = 'run_code'

/** Where the census keeps its result: `<DSH_HOME>/lazy-tools/census.json`. */
const CENSUS_RECORD = join('lazy-tools', 'census.json')

/** Upper bound on one `setTimeout`, so a long interval survives clock changes.
 *
 * A delay above this is re-armed in steps instead of being trusted to fire
 * once, and `setTimeout` clamps anything past 2^31-1 ms to an immediate run.
 */
const CENSUS_POLL_MS = 6 * 60 * 60 * 1000

/** Defaults for the monthly census; every field is configurable. */
const DEFAULT_CENSUS = {
  /** Run the census on a schedule at all. */
  enabled: true,
  /** Days between runs; `0` means "only when toolbox_census is called". */
  intervalDays: 30,
  /** Look-back window for the counted calls. */
  windowDays: 30,
  /** A tool needs at least this many calls per day to stay resident... */
  minCallsPerDay: 3,
  /** ...and a declaration no larger than this many characters... */
  maxSchemaChars: 1500,
  /** ...unless it is used at least this often per day, whatever its size. */
  dominantCallsPerDay: 50,
  /** Newest sessions considered; the sample is bounded on purpose. */
  maxSessions: 200,
  /** Delay after load before the first run, so startup is not disturbed. */
  startDelayMs: 30 * 1000,
  /** Write the result into the effective resident layer. */
  apply: true,
}

/** Tool surface kept visible until a census replaces it (missing names are ignored).
 *
 * Measured on the author's machine (30 days, 200 sessions, 17,166 calls): every
 * non-lazy tool with >=100 calls/month and a schema under 1.5k characters stayed
 * resident; the rest is deferred. `run_code` is exempt because
 * `tools.restrict()` cannot name it. The monthly census re-derives this list
 * from your own logs, so the constant is only the first-run fallback.
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
    census: { ...DEFAULT_CENSUS },
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

  const census = raw.census
  if (census !== null && typeof census === 'object') {
    const clamp = (value, low, high) => Math.min(Math.max(value, low), high)
    if (typeof census.enabled === 'boolean') config.census.enabled = census.enabled
    if (typeof census.apply === 'boolean') config.census.apply = census.apply
    if (Number.isFinite(census.intervalDays) && census.intervalDays >= 0) {
      config.census.intervalDays = clamp(census.intervalDays, 0, 365)
    }
    if (Number.isFinite(census.windowDays) && census.windowDays >= 1) {
      config.census.windowDays = clamp(census.windowDays, 1, 365)
    }
    if (Number.isFinite(census.minCallsPerDay) && census.minCallsPerDay >= 0) {
      config.census.minCallsPerDay = census.minCallsPerDay
    }
    if (Number.isFinite(census.dominantCallsPerDay) && census.dominantCallsPerDay >= 0) {
      config.census.dominantCallsPerDay = census.dominantCallsPerDay
    }
    if (Number.isFinite(census.maxSchemaChars) && census.maxSchemaChars >= 0) {
      config.census.maxSchemaChars = Math.floor(census.maxSchemaChars)
    }
    if (Number.isInteger(census.maxSessions) && census.maxSessions >= 1) {
      config.census.maxSessions = Math.min(census.maxSessions, 500)
    }
    if (Number.isFinite(census.startDelayMs) && census.startDelayMs >= 0) {
      config.census.startDelayMs = census.startDelayMs
    }
  }
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

  /** sessionId -> { agent, activated:Set<string>, snapshot:Map, dispose? } */
  const agents = new Map()
  /** Every tool definition this plugin has observed, from the global or an agent view. */
  const universe = new Map()
  /** Last census result this instance adopted, or `undefined` before the first run. */
  let census = undefined
  /** When the current census was taken (ms), restored from the record on load. */
  let censusAt = undefined
  let censusTimer = undefined
  let censusRunning = false
  let residentCache = undefined
  let mutating = false
  let refreshQueued = false

  const warn = (message, error) => {
    const detail = error === undefined ? '' : String((error && error.message) || error)
    console.warn(`[lazy-tools] ${message}${detail === '' ? '' : `: ${detail}`}`)
  }

  /** Names in the resident layer right now: static fallback, census, user additions.
   *
   * The census replaces the shipped default only when it ran and `census.apply`
   * is on; `visible` stays additive in every case, so a user override never
   * disappears because a tool got quiet.
   */
  function residentSet() {
    if (residentCache !== undefined) return residentCache
    const base = census !== undefined && config.census.apply ? census.resident : DEFAULT_VISIBLE
    const set = new Set()
    for (const name of base) if (name !== RUN_CODE) set.add(name)
    for (const name of config.visible) if (name !== RUN_CODE) set.add(name)
    residentCache = set
    return set
  }

  /** Forget the derived resident layer after a census or config change. */
  function invalidateResident() {
    residentCache = undefined
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
    const resident = residentSet()
    const deny = []
    for (const name of snapshot.keys()) {
      if (name === RUN_CODE || resident.has(name) || TOOLBOX.includes(name)) continue
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

  /** Whether two compositions hold exactly the same tool names. */
  function sameComposition(previous, next) {
    if (previous.size !== next.size) return false
    for (const name of next.keys()) if (!previous.has(name)) return false
    return true
  }

  /** Rebuild one agent's restriction from its live view. */
  function applyRestriction(state) {
    const previous = state.snapshot
    liftRestriction(state)
    // The frozen catalog describes one composition. A preset switch, a newly
    // installed plugin, or an uninstalled one changes the tool set, and the
    // cached text would then omit the tools that just arrived (or name the ones
    // that left). Activation never reaches this path: `toolbox_load` lifts and
    // settles without touching the catalog, which is what keeps the prompt
    // byte-identical for a whole session.
    if (!sameComposition(previous, state.snapshot)) state.catalog = undefined
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
    const state = {
      agent,
      activated: new Set(),
      snapshot: new Map(),
      dispose: undefined,
      dropped: new Set(),
      catalog: undefined,
    }
    agents.set(agent.id, state)
    if (!config.resumePreserve) return state
    const resident = residentSet()
    const declared = previouslyDeclared(agent)
    for (const name of declared) {
      if (name === RUN_CODE || resident.has(name) || TOOLBOX.includes(name)) continue
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
    const resident = residentSet()
    const names = []
    for (const name of pool.keys()) {
      if (name === RUN_CODE || resident.has(name) || TOOLBOX.includes(name)) continue
      if (state !== undefined && state.activated.has(name)) continue
      names.push(name)
    }
    return names.sort()
  }

  /** The agent one prompt assembly belongs to, when the caller named one.
   *
   * The agent loop assembles with `{ agent, scope: agent }` — `scope` is the
   * agent object itself, because an agent's registrations are keyed by it. A
   * bare `assemble()` or another plugin's scope resolves to nothing, and that
   * assembly gets the installation-wide catalog instead of a wrongly personal
   * one.
   */
  function agentOfAssembly(context) {
    if (context === null || typeof context !== 'object') return undefined
    const candidate = context.agent !== undefined ? context.agent : context.scope
    if (candidate === null || typeof candidate !== 'object') return undefined
    if (typeof candidate.id !== 'string') return undefined
    const state = agents.get(candidate.id)
    return state === undefined ? undefined : state.agent
  }

  /** One agent's deferred-tool catalog, fixed the first time it is assembled.
   *
   * DSH renders every section on every step, and a route that accepts a
   * mid-session system prompt keeps the changed text by appending the whole
   * re-rendered prompt to the history. A list that shrank after every
   * `toolbox_load` would therefore cost one full prompt copy per activation, so
   * the catalog is frozen per agent for the life of the session: a tool loaded
   * afterwards stays listed, and `toolbox_load` answers `alreadyAvailable`.
   *
   * @param agent - the agent whose composition the catalog describes.
   * @returns the catalog text, `''` when the agent has nothing deferred, or
   * `undefined` when this plugin has not seen the agent's composition yet.
   */
  function catalogFor(agent) {
    const state = agents.get(agent.id)
    if (state === undefined || state.snapshot.size === 0) return undefined
    if (state.catalog === undefined) {
      state.catalog = personalCatalog(awaitingNames(agent))
    }
    return state.catalog
  }

  /** Catalog of one preset's deferred tools — every listed name is loadable. */
  function personalCatalog(names) {
    if (names.length === 0) return ''
    const shown = names.slice(0, 80).join(', ')
    const more = names.length > 80 ? `, and ${names.length - 80} more` : ''
    return 'Deferred tools of your preset, hidden from your tool list to save context: ' + shown + more + '.\n'
      + 'Call toolbox_search(query) to inspect a candidate, then toolbox_load(names) to activate it before use. '
      + 'A name that is already loaded, or that this preset does not mount, is reported back instead of failing.'
  }

  /** Catalog for an assembly that names no agent: the installation-wide list.
   *
   * Nothing here is claimed to be absent from the current tool list, because
   * this view cannot tell which preset the step runs under.
   */
  function installationCatalog() {
    globalDefinitions()
    const names = awaitingNames(undefined)
    if (names.length === 0) return ''
    const shown = names.slice(0, 80).join(', ')
    const more = names.length > 80 ? `, and ${names.length - 80} more` : ''
    return 'Tools registered in this installation: ' + shown + more + '.\n'
      + 'Some of them are already in your tool list, some belong to a preset this session does not use, '
      + 'and the rest are deferred to save context. '
      + 'toolbox_search only returns the ones you can load right now, and toolbox_load reports the rest as unavailable. '
      + 'Call toolbox_search(query) to inspect a candidate, then toolbox_load(names) to activate it before use.'
  }

  function catalogText(context) {
    const agent = agentOfAssembly(context)
    if (agent !== undefined) {
      const text = catalogFor(agent)
      if (text !== undefined) return text
    }
    return installationCatalog()
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
      if (censusTimer !== undefined) {
        clearTimeout(censusTimer)
        censusTimer = undefined
      }
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
  // Census: re-derive the resident layer from this machine's own tool calls.
  //
  // Timing is anchored on the run, not the install: every run stamps
  // `lastAt`, and the next one is due `census.intervalDays` after that stamp.
  // With no record yet, the first run happens `census.startDelayMs` after
  // load — so a fresh install measures before it decides anything.
  // ---------------------------------------------------------------------

  /** Root of DSH's data directory, resolved the way DSH itself does. */
  function dshHome() {
    const configured = process.env.DSH_HOME
    if (typeof configured === 'string' && configured.length > 0) return configured
    return join(homedir(), '.dsh')
  }

  /** Absolute path of the census record. */
  function censusPath() {
    return join(dshHome(), CENSUS_RECORD)
  }

  /** Adopt a persisted census result, if it matches the current thresholds. */
  function loadCensusRecord() {
    let text
    try {
      text = readFileSync(censusPath(), 'utf8')
    } catch {
      return
    }
    let record
    try {
      record = JSON.parse(text)
    } catch (error) {
      warn('could not parse the census record; it will be rewritten', error)
      return
    }
    if (record === null || typeof record !== 'object') return
    if (!Number.isFinite(record.lastAt) || !Array.isArray(record.resident)) return
    censusAt = record.lastAt
    if (record.thresholds !== undefined && !sameThresholds(record.thresholds)) {
      // The user changed the knobs: keep the timestamp (the cadence continues)
      // but drop the numbers, so the next run recomputes under the new rules.
      return
    }
    census = {
      lastAt: record.lastAt,
      windowDays: Number.isFinite(record.windowDays) ? record.windowDays : config.census.windowDays,
      measuredDays: Number.isFinite(record.measuredDays) ? record.measuredDays : config.census.windowDays,
      sessions: Number.isFinite(record.sessions) ? record.sessions : 0,
      calls: Number.isFinite(record.calls) ? record.calls : 0,
      failed: Number.isFinite(record.failed) ? record.failed : 0,
      truncated: record.truncated === true,
      rows: Array.isArray(record.rows) ? record.rows : [],
      resident: record.resident.filter(name => typeof name === 'string'),
    }
    invalidateResident()
  }

  /** The threshold set a result was computed with. */
  function censusThresholds() {
    return {
      windowDays: config.census.windowDays,
      minCallsPerDay: config.census.minCallsPerDay,
      maxSchemaChars: config.census.maxSchemaChars,
      dominantCallsPerDay: config.census.dominantCallsPerDay,
    }
  }

  /** Whether a record's thresholds match the live config. */
  function sameThresholds(thresholds) {
    const current = censusThresholds()
    if (thresholds === null || typeof thresholds !== 'object') return false
    return Object.keys(current).every(key => thresholds[key] === current[key])
  }

  /** Persist one result; a failure only costs the next run a re-scan. */
  function saveCensusRecord(result) {
    const path = censusPath()
    const payload = {
      version: 1,
      lastAt: result.lastAt,
      thresholds: censusThresholds(),
      windowDays: config.census.windowDays,
      measuredDays: result.measuredDays,
      sessions: result.sessions,
      calls: result.calls,
      failed: result.failed,
      truncated: result.truncated,
      resident: result.resident,
      rows: result.rows,
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.tmp`
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(temporary, path)
    } catch (error) {
      warn('could not write the census record', error)
    }
  }

  /** Tool-call counts from one session's events, inside the window.
   *
   * Also reports the oldest counted event, so a short history does not get
   * divided by the full window: three days of logs would otherwise look like a
   * third of the real usage rate.
   *
   * @param events - one session's events.
   * @param sinceMs - window start.
   * @param counts - name -> call count, accumulated across sessions.
   * @returns the oldest counted event time, or `undefined` when nothing counted.
   */
  function countCalls(events, sinceMs, counts) {
    if (!Array.isArray(events)) return undefined
    let earliest
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      const type = event.type
      if (type !== 'tool/call' && type !== 'tool/ptc-dispatch') continue
      const time = Number.isFinite(event.time) ? event.time : 0
      if (time < sinceMs) continue
      const data = event.data
      if (data === null || typeof data !== 'object') continue
      const toolName = data.name
      if (typeof toolName !== 'string' || toolName.length === 0) continue
      counts.set(toolName, (counts.get(toolName) ?? 0) + 1)
      if (earliest === undefined || time < earliest) earliest = time
    }
    return earliest
  }

  /** Read one session's events through the session-query service. */
  async function eventsOf(service, sessionId) {
    if (typeof service.inspectSession === 'function') {
      return await service.inspectSession(sessionId, session => {
        if (typeof session.snapshotEvents !== 'function') throw new Error('session snapshot is unavailable')
        return session.snapshotEvents()
      })
    }
    const snapshot = await service.readSession(sessionId)
    return snapshot === undefined ? [] : snapshot.events
  }

  /** Which tools stay resident, given their measured usage and declaration size.
   *
   * @param counts - name -> call count inside the window.
   * @param days - measured span the counts came from, so a young history is not
   * divided by the configured window.
   */
  function censusRows(counts, days) {
    globalDefinitions()
    const span = Math.max(days, 1)
    const rows = []
    for (const [toolName, calls] of counts) {
      const perDay = calls / span
      const definition = universe.get(toolName)
      const schemaChars = definition === undefined ? null : asJson(definition).length
      const resident = toolName !== RUN_CODE
        && !TOOLBOX.includes(toolName)
        && (perDay >= config.census.dominantCallsPerDay
          || (schemaChars !== null
            && schemaChars <= config.census.maxSchemaChars
            && perDay >= config.census.minCallsPerDay))
      rows.push({ name: toolName, calls, perDay: Math.round(perDay * 100) / 100, schemaChars, resident })
    }
    rows.sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name))
    return rows
  }

  /** Rebuild every live agent's restriction against a new resident layer.
   *
   * Without this the new layer would only reach agents created afterwards,
   * which for a long-running session means "next month, maybe".
   */
  function reapplyAll() {
    invalidateResident()
    // The frozen catalog describes the old layer; let the next assembly rebuild it.
    for (const state of agents.values()) state.catalog = undefined
    mutating = true
    try {
      for (const state of agents.values()) {
        try {
          applyRestriction(state)
        } catch (error) {
          warn(`could not re-apply the restriction for ${state.agent.id}`, error)
        }
      }
    } finally {
      mutating = false
    }
  }

  /** Count calls across recent sessions, derive the layer, and adopt the result.
   *
   * A dry run returns the same measurement without touching the cadence, the
   * record, or the live restrictions.
   */
  async function runCensus(options = {}) {
    const dryRun = options.dryRun === true
    if (censusRunning) return { ok: false, error: 'a census is already running' }
    const service = ctx.get('sessionQuery')
    if (service === undefined) {
      return { ok: false, error: 'the sessionQuery service is not mounted; tool usage cannot be counted' }
    }
    censusRunning = true
    const startedAt = Date.now()
    const since = startedAt - config.census.windowDays * 86400000
    try {
      let records = await service.listSessions()
      if (!Array.isArray(records)) records = []
      const candidates = records
        .filter(record => record !== null && typeof record === 'object' && record.header !== undefined)
        .sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0))
      const selected = []
      let truncated = false
      for (const record of candidates) {
        const live = record.live === true
        if (!live && (record.header.createdAt ?? 0) < since) continue
        selected.push(record)
        if (selected.length >= config.census.maxSessions) {
          truncated = candidates.length > selected.length
          break
        }
      }

      const counts = new Map()
      let sessions = 0
      let failed = 0
      let earliest
      for (const record of selected) {
        try {
          const oldest = countCalls(await eventsOf(service, record.header.id), since, counts)
          if (oldest !== undefined && (earliest === undefined || oldest < earliest)) earliest = oldest
          sessions++
        } catch (error) {
          failed++
          warn(`could not read the session ${record.header.id} for the census`, error)
        }
        // Yield between sessions: the census must not stall the agent loop.
        await new Promise(resolve => setImmediate(resolve))
      }

      let calls = 0
      for (const count of counts.values()) calls += count
      // Divide by the span the counts actually cover, capped at the window.
      const measuredDays = earliest === undefined
        ? config.census.windowDays
        : Math.min(config.census.windowDays, Math.max((startedAt - earliest) / 86400000, 1))
      const rows = censusRows(counts, measuredDays)
      const resident = rows.filter(row => row.resident).map(row => row.name)
      const result = {
        ok: true,
        lastAt: Date.now(),
        durationMs: Date.now() - startedAt,
        windowDays: config.census.windowDays,
        measuredDays: Math.round(measuredDays * 10) / 10,
        sessions,
        calls,
        failed,
        truncated,
        rows,
        resident,
        applied: !dryRun && config.census.apply,
        dryRun,
      }
      if (dryRun) return result
      censusAt = result.lastAt
      census = result
      if (config.census.apply) reapplyAll()
      else invalidateResident()
      saveCensusRecord(result)
      return result
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    } finally {
      censusRunning = false
    }
  }

  /** When the next automatic census is due, or `undefined` when it never runs. */
  function censusDueAt() {
    if (!config.census.enabled || config.census.intervalDays <= 0) return undefined
    if (censusAt === undefined) return Date.now() + config.census.startDelayMs
    return censusAt + config.census.intervalDays * 86400000
  }

  /** Arm one timer for the next due census, re-arming in bounded steps. */
  function scheduleCensus() {
    if (censusTimer !== undefined) {
      clearTimeout(censusTimer)
      censusTimer = undefined
    }
    const due = censusDueAt()
    if (due === undefined) return
    const delay = Math.max(Math.min(due - Date.now(), CENSUS_POLL_MS), 50)
    censusTimer = setTimeout(() => {
      censusTimer = undefined
      if (Date.now() < due) {
        scheduleCensus()
        return
      }
      runCensus()
        .then(result => {
          if (result.ok) {
            warn(`census re-derived the resident layer in ${result.durationMs}ms: `
              + `${result.resident.length} resident, ${result.calls} calls in ${result.sessions} sessions `
              + `over ${result.measuredDays} days`)
          } else {
            warn(`census did not run: ${result.error}`)
          }
        })
        .catch(error => warn('census failed', error))
        .finally(() => scheduleCensus())
    }, delay)
    if (typeof censusTimer.unref === 'function') censusTimer.unref()
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
        const resident = residentSet()
        // Only surface tools the step cannot already call.
        const view = agent === undefined ? new Set() : agentView(agent)
        const results = []
        for (const [toolName, definition] of pool) {
          if (toolName === RUN_CODE || resident.has(toolName) || TOOLBOX.includes(toolName)) continue
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
  // toolbox_census: re-measure tool usage and re-derive the resident layer.
  // ---------------------------------------------------------------------

  try {
    ctx.tools.register({
      name: 'toolbox_census',
      description: 'Count this machine\'s recent tool calls and re-derive which tools stay visible. The plugin runs it automatically every `census.intervalDays`; call it to measure now. Set dryRun to report without changing anything.',
      parameters: {
        type: 'object',
        properties: {
          dryRun: {
            type: 'boolean',
            description: 'Report the measurement without applying it or restarting the interval.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textBlock(asJson(value)),
      },
      execute: async args => {
        const dryRun = args !== null && typeof args === 'object' && args.dryRun === true
        const previous = [...residentSet()].sort()
        const result = await runCensus({ dryRun })
        if (result.ok !== true) throw new Error(`census failed: ${result.error}`)
        // What this run measured (merged with the user's additions), and what
        // the session is actually running on. A dry run reports the former.
        const measured = [...new Set([...result.resident, ...config.visible])].sort()
        const inForce = result.applied === true ? [...residentSet()].sort() : previous
        const measuredSet = new Set(measured)
        const previousSet = new Set(previous)
        return {
          applied: result.applied === true,
          dryRun,
          measuredAt: new Date(result.lastAt).toISOString(),
          windowDays: result.windowDays,
          measuredDays: result.measuredDays,
          durationMs: result.durationMs,
          sessions: result.sessions,
          calls: result.calls,
          failedSessions: result.failed,
          sampleTruncated: result.truncated,
          thresholds: censusThresholds(),
          resident: measured,
          inForce,
          added: measured.filter(name => !previousSet.has(name)),
          removed: previous.filter(name => !measuredSet.has(name)),
          top: result.rows.slice(0, 15),
          note: result.applied === true
            ? 'The resident layer changed; live agents were re-restricted against it.'
            : (dryRun
              ? 'Dry run: nothing was applied or recorded.'
              : 'census.apply is off: the measurement was recorded but the resident layer is unchanged.'),
        }
      },
    })
  } catch (error) {
    warn('could not register toolbox_census', error)
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

          const due = censusDueAt()
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
            visible: [...residentSet()].filter(toolName => view.has(toolName)),
            activated: state !== undefined ? [...state.activated] : [],
            dropped: state !== undefined ? [...state.dropped] : [],
            awaitingCount: awaiting.length,
            awaiting,
            census: {
              enabled: config.census.enabled,
              intervalDays: config.census.intervalDays,
              source: census === undefined
                ? 'default-list'
                : (config.census.apply ? 'census' : 'census-not-applied'),
              lastRunAt: censusAt === undefined ? null : new Date(censusAt).toISOString(),
              nextRunAt: due === undefined ? null : new Date(due).toISOString(),
              windowDays: config.census.windowDays,
              measuredDays: census === undefined ? null : census.measuredDays,
              sessions: census === undefined ? null : census.sessions,
              calls: census === undefined ? null : census.calls,
              residentCount: residentSet().size,
              record: censusPath(),
            },
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
        text: context => catalogText(context),
      })
    } catch (error) {
      warn('could not register the deferred-tool prompt section', error)
    }
  }

  // Adopt the last census before any agent is restricted: the record decides
  // which tools are resident, so a late read would re-hide a measured layer.
  loadCensusRecord()

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

  // Arm the monthly census. The first run happens after `census.startDelayMs`
  // because no record exists yet; later runs are due one interval after the
  // previous run's own timestamp, so a restart cannot postpone them.
  try {
    scheduleCensus()
  } catch (error) {
    warn('could not schedule the census', error)
  }
}
