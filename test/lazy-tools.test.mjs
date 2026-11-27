/**
 * Behavioural tests for dsh-lazy-tools, run with `node --test`.
 *
 * The plugin only touches five surfaces — `ctx.tools.register`,
 * `agent.ctx.tools.definitions(agent)`, `agent.ctx.tools.restrict({deny})`,
 * `ctx.on(...)`, and `ctx.systemPrompt.section(...)` — so a small in-memory
 * harness exercises the real code without DSH running.
 *
 * Tool composition model matches DSH: an agent sees the global registry plus the
 * tools its preset mounted; `restrict({deny})` can hide a composed tool and its
 * disposer un-hides it, but no restriction can create a tool the preset never
 * mounted.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

// The plugin reads and writes its census record under DSH_HOME. Every test runs
// against a throwaway home, so a record on the developer's machine can never
// change what a test observes.
const testHome = mkdtempSync(join(tmpdir(), 'lazy-tools-home-'))
const inheritedHome = process.env.DSH_HOME
process.env.DSH_HOME = testHome
test.after(() => {
  if (inheritedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = inheritedHome
  rmSync(testHome, { recursive: true, force: true })
})

function definition(name, description = `${name} tool`) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
  }
}

function createHarness({ liveAgents, sessionQuery } = {}) {
  const handlers = new Map()
  const registered = new Map()
  const sections = new Map()

  const ctx = {
    get(key) {
      if (key === 'agents' && liveAgents !== undefined) return { list: () => liveAgents() }
      if (key === 'sessionQuery') return sessionQuery
      return undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(callback) {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    systemPrompt: {
      section(section) {
        sections.set(section.name, section)
        return () => sections.delete(section.name)
      },
    },
    tools: {
      register(tool) {
        registered.set(tool.name, tool)
        return () => registered.delete(tool.name)
      },
      definitions(agent) {
        if (agent === undefined) return [...registered.values()]
        const names = [...registered.keys(), ...agent.composed]
        const seen = new Set()
        const out = []
        for (const name of names) {
          if (seen.has(name) || agent.denied.has(name)) continue
          seen.add(name)
          out.push(registry.get(name) ?? definition(name))
        }
        return out
      },
    },
  }

  const registry = new Map()

  function makeAgent(id, composed) {
    const agent = {
      id,
      composed: [...composed],
      denied: new Set(),
      session: { toolHistory: () => ({ tools: [], updates: [] }) },
      model: { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    }
    agent.ctx = {
      tools: {
        definitions: () => ctx.tools.definitions(agent),
        restrict({ deny }) {
          const added = deny.filter(name => !agent.denied.has(name))
          for (const name of added) agent.denied.add(name)
          return () => {
            for (const name of added) agent.denied.delete(name)
          }
        },
      },
    }
    return agent
  }

  function emit(event, payload) {
    const handler = handlers.get(event)
    if (handler !== undefined) handler(payload)
  }

  /** Render the registered prompt catalog the way an assembly would. */
  function catalog(context) {
    const section = sections.get('lazy-tools-catalog')
    assert.ok(section !== undefined, 'the prompt catalog section was not registered')
    return typeof section.text === 'function' ? section.text(context) : section.text
  }

  return { ctx, registry, makeAgent, emit, registered, sections, catalog }
}

function tool(name) {
  const harness = createHarness()
  apply(harness.ctx, { visible: ['read'], promptSection: false, statusTool: true })
  const toolbox = name => harness.registered.get(name)
  return { ...harness, toolbox }
}

test('hides composed tools that are not resident, keeps resident ones', () => {
  const { ctx, makeAgent, emit } = tool('toolbox_load')
  const agent = makeAgent('a1', ['read', 'write', 'web_search', 'subagent'])
  emit('agent/created', { agent })

  const names = ctx.tools.definitions(agent).map(entry => entry.name)
  assert.ok(names.includes('read'), 'resident tool stays visible')
  assert.ok(names.includes('toolbox_load'), 'toolbox tools stay visible')
  assert.ok(!names.includes('web_search'), 'deferred tool is hidden')
  assert.ok(!names.includes('subagent'), 'deferred tool is hidden')
})

test('toolbox_load activates a composed hidden tool and it becomes visible', async () => {
  const { ctx, makeAgent, emit, toolbox } = tool('toolbox_load')
  const agent = makeAgent('a2', ['read', 'subagent'])
  emit('agent/created', { agent })

  const result = await toolbox('toolbox_load').execute({ names: ['subagent'] }, { agent })
  assert.deepEqual(result.activated, ['subagent'])
  assert.deepEqual(result.unavailable, [])
  assert.deepEqual(result.unknown, [])
  assert.ok(ctx.tools.definitions(agent).some(entry => entry.name === 'subagent'))
})

test('toolbox_load refuses tools that another preset mounted but this agent did not', async () => {
  const { ctx, makeAgent, emit, toolbox } = tool('toolbox_load')
  // Another agent mounts subagent and list_agents, so they enter the universe.
  const other = makeAgent('other', ['read', 'subagent', 'list_agents'])
  emit('agent/created', { agent: other })

  const agent = makeAgent('a3', ['read', 'pwsh'])
  emit('agent/created', { agent })

  const result = await toolbox('toolbox_load').execute({ names: ['subagent', 'list_agents', 'totally_made_up'] }, { agent })
  assert.deepEqual(result.activated, [])
  assert.deepEqual(result.unavailable.sort(), ['list_agents', 'subagent'])
  assert.deepEqual(result.unknown, ['totally_made_up'])
  const names = ctx.tools.definitions(agent).map(entry => entry.name)
  assert.ok(!names.includes('subagent'))
  assert.ok(!names.includes('list_agents'))
})

test('toolbox_search tokenises multi-word queries and stays inside the agent composition', async () => {
  const { makeAgent, emit, toolbox } = tool('toolbox_search')
  const other = makeAgent('other', ['read', 'list_agents'])
  emit('agent/created', { agent: other })

  const agent = makeAgent('a4', ['read', 'web_search', 'subagent'])
  emit('agent/created', { agent })

  const byPhrase = await toolbox('toolbox_search').execute({ query: 'web search' }, { agent })
  assert.ok(byPhrase.results.some(entry => entry.name === 'web_search'), 'multi-word query finds web_search')

  const byIntent = await toolbox('toolbox_search').execute({ query: 'spawn a subagent in a separate context' }, { agent })
  assert.ok(byIntent.results.some(entry => entry.name === 'subagent'), 'prose query finds subagent')

  const crossAgent = await toolbox('toolbox_search').execute({ query: 'list agents' }, { agent })
  assert.ok(!crossAgent.results.some(entry => entry.name === 'list_agents'), 'never offers another preset\u2019s tool')

  const resident = await toolbox('toolbox_search').execute({ query: 'read file' }, { agent })
  assert.ok(!resident.results.some(entry => entry.name === 'read'), 'never offers a tool the step can already call')
})

test('a preset switch drops activations the new composition no longer mounts', async () => {
  const { ctx, makeAgent, emit, toolbox } = tool('toolbox_load')
  const agent = makeAgent('a5', ['read', 'subagent'])
  emit('agent/created', { agent })
  await toolbox('toolbox_load').execute({ names: ['subagent'] }, { agent })
  assert.ok(ctx.tools.definitions(agent).some(entry => entry.name === 'subagent'))

  // The session switches to a preset that does not mount subagent.
  agent.composed = ['read', 'pwsh']
  // Simulate the recomposition DSH performs: drop the restriction, swap the set.
  agent.denied.clear()
  emit('tools/change', {})
  await new Promise(resolve => setTimeout(resolve, 0))

  const status = await toolbox('toolbox_status').execute({}, { agent })
  assert.deepEqual(status.dropped, ['subagent'], 'stale activation reported')
  assert.deepEqual(status.activated, [])
  const names = ctx.tools.definitions(agent).map(entry => entry.name)
  assert.ok(!names.includes('subagent'), 'the tool that is gone does not stay activated')
})

test('status reports the composed surface, not the process-wide universe', async () => {
  const { makeAgent, emit, toolbox } = tool('toolbox_status')
  const other = makeAgent('other', ['read', 'list_agents', 'send_message'])
  emit('agent/created', { agent: other })
  const agent = makeAgent('a6', ['read', 'subagent'])
  emit('agent/created', { agent })

  const status = await toolbox('toolbox_status').execute({}, { agent })
  // 4 toolbox tools (global) + read + subagent (composed) = 6
  assert.equal(status.composedToolCount, 6)
  assert.ok(status.awaiting.includes('subagent'), 'composed but hidden tool is awaiting')
  assert.ok(!status.awaiting.includes('list_agents'), 'another preset\u2019s tool is not awaited')
})

test('status visible lists only the tools the step can actually call', async () => {
  const { ctx, makeAgent, emit, toolbox } = tool('toolbox_status')
  const agent = makeAgent('s1', ['read', 'pwsh', 'subagent'])
  emit('agent/created', { agent })

  // Another plugin (or this one failing to restrict) hides a resident tool that
  // *is* part of the composition, so `pool` still contains it while `view` does not.
  agent.denied.add('read')

  const status = await toolbox('toolbox_status').execute({}, { agent })
  const callable = new Set(ctx.tools.definitions(agent).map(entry => entry.name))
  assert.ok(status.visible.includes('pwsh'))
  assert.ok(!status.visible.includes('read'), 'a resident tool the step cannot call is not reported visible')
  for (const name of status.visible) {
    assert.ok(callable.has(name), `${name} is reported visible but is not callable`)
  }
  for (const name of status.awaiting) {
    assert.ok(!callable.has(name), `${name} is reported awaiting but is callable`)
  }
})

test('a plugin load re-restricts agents that already existed', async () => {
  const live = []
  const harness = createHarness({ liveAgents: () => live })
  const agent = harness.makeAgent('r1', ['read', 'web_search', 'subagent'])
  // The agent was created before this plugin instance: no agent/created will fire.
  live.push(agent)

  apply(harness.ctx, { visible: ['read'], promptSection: false, statusTool: true })

  const names = harness.ctx.tools.definitions(agent).map(entry => entry.name)
  assert.ok(names.includes('read'), 'resident tool stays visible')
  assert.ok(!names.includes('web_search'), 'deferred tool hidden by the load-time sweep')
  assert.ok(!names.includes('subagent'), 'deferred tool hidden by the load-time sweep')

  const status = await harness.registered.get('toolbox_status').execute({}, { agent })
  assert.equal(status.restricted, true)
  // 4 toolbox tools (global) + read + web_search + subagent = 7
  assert.equal(status.composedToolCount, 7)
  assert.ok(status.awaiting.includes('web_search'))
})

test('toolbox_search applies the restriction itself for an agent it never saw', async () => {
  const harness = createHarness()
  apply(harness.ctx, { visible: ['read'], promptSection: false, statusTool: true })
  // Another preset mounts list_agents, so the name reaches the process-wide universe.
  const other = harness.makeAgent('other', ['read', 'list_agents'])
  harness.emit('agent/created', { agent: other })

  const agent = harness.makeAgent('a7', ['read', 'web_search', 'pwsh'])
  // No agent/created: the plugin instance loaded after this agent was created.

  const cross = await harness.registered.get('toolbox_search').execute({ query: 'list agents' }, { agent })
  assert.deepEqual(cross.results, [], 'never offers a tool outside this composition')

  const own = await harness.registered.get('toolbox_search').execute({ query: 'web search' }, { agent })
  assert.ok(own.results.some(entry => entry.name === 'web_search'), 'composed hidden tool is still findable')

  const names = harness.ctx.tools.definitions(agent).map(entry => entry.name)
  assert.ok(!names.includes('web_search'), 'search applied the restriction instead of leaving the agent bare')
  assert.ok(names.includes('read'))
})

test('prompt catalog lists this agent\u2019s deferred tools, not the process-wide universe', () => {
  const harness = createHarness()
  apply(harness.ctx, { visible: ['read'], promptSection: true, statusTool: false })
  // Another preset mounts list_agents, so the name enters the universe.
  const other = harness.makeAgent('other', ['read', 'list_agents'])
  harness.emit('agent/created', { agent: other })

  const agent = harness.makeAgent('c1', ['read', 'web_search', 'subagent'])
  harness.emit('agent/created', { agent })

  const text = harness.catalog({ agent, scope: agent })
  assert.match(text, /Deferred tools of your preset/)
  assert.match(text, /\bweb_search\b/)
  assert.match(text, /\bsubagent\b/)
  assert.ok(!/\blist_agents\b/.test(text), 'a tool this preset never mounted is not offered')
  assert.ok(!/\bread\b/.test(text), 'a resident tool is not listed as deferred')
  assert.ok(!/\btoolbox_search\b/.test(text.split('\n')[0]), 'the disclosure tools themselves are not listed')
})

test('prompt catalog is frozen for the session, so activation never rewrites the prompt', async () => {
  const harness = createHarness()
  apply(harness.ctx, { visible: ['read'], promptSection: true, statusTool: false })
  const agent = harness.makeAgent('c2', ['read', 'subagent', 'web_search'])
  harness.emit('agent/created', { agent })

  const before = harness.catalog({ agent, scope: agent })
  assert.match(before, /subagent/)

  await harness.registered.get('toolbox_load').execute({ names: ['subagent'] }, { agent })

  const after = harness.catalog({ agent, scope: agent })
  assert.equal(after, before, 'the catalog text is byte-identical after activation, so no system prompt is re-sent')
})

test('prompt catalog falls back to the installation list when the assembly names no agent', () => {
  const harness = createHarness()
  apply(harness.ctx, { visible: ['read'], promptSection: true, statusTool: false })
  const other = harness.makeAgent('other', ['read', 'list_agents'])
  harness.emit('agent/created', { agent: other })
  const agent = harness.makeAgent('c3', ['read', 'web_search'])
  harness.emit('agent/created', { agent })

  const global = harness.catalog({})
  assert.match(global, /Tools registered in this installation/)
  assert.match(global, /list_agents/, 'the installation list still spans every preset')
  assert.ok(!/intentionally absent/.test(global), 'no claim is made about tools it cannot verify')

  // An agent this plugin instance has never restricted: its composition is
  // unknown, so a personal list would be a guess.
  const unknown = harness.makeAgent('never-seen', ['read', 'pwsh'])
  const fallback = harness.catalog({ agent: unknown, scope: unknown })
  assert.match(fallback, /Tools registered in this installation/)
})

test('prompt catalog is empty when the agent has nothing deferred', () => {
  const harness = createHarness()
  apply(harness.ctx, { visible: ['read', 'pwsh'], promptSection: true, statusTool: false })
  const agent = harness.makeAgent('c4', ['read', 'pwsh'])
  harness.emit('agent/created', { agent })

  assert.equal(harness.catalog({ agent, scope: agent }), '')
})

test('a newly installed plugin\u2019s tools are deferred and show up in the catalog', async () => {
  const harness = createHarness()
  apply(harness.ctx, { visible: ['read'], promptSection: true, statusTool: true })
  const agent = harness.makeAgent('n1', ['read', 'subagent'])
  harness.emit('agent/created', { agent })

  const before = harness.catalog({ agent, scope: agent })
  assert.ok(!/freshly_installed/.test(before), 'the tool does not exist yet')

  // A plugin install registers global tools; DSH then recomposes the agents and
  // emits `tools/change`, which the plugin re-applies from.
  harness.ctx.tools.register(definition('freshly_installed'))
  harness.emit('tools/change', {})
  await new Promise(resolve => setTimeout(resolve, 0))

  const names = harness.ctx.tools.definitions(agent).map(entry => entry.name)
  assert.ok(!names.includes('freshly_installed'), 'an unmeasured tool starts in the deferred layer')
  const after = harness.catalog({ agent, scope: agent })
  assert.match(after, /freshly_installed/, 'the catalog is rebuilt so the model learns the tool exists')

  // And it is describable and loadable right away.
  const found = await harness.registered.get('toolbox_search').execute({ query: 'freshly installed' }, { agent })
  assert.ok(found.results.some(entry => entry.name === 'freshly_installed'))
  const loaded = await harness.registered.get('toolbox_load').execute({ names: ['freshly_installed'] }, { agent })
  assert.deepEqual(loaded.activated, ['freshly_installed'])
})

test('activating a tool does not rebuild the catalog', async () => {
  const harness = createHarness()
  apply(harness.ctx, { visible: ['read'], promptSection: true, statusTool: true })
  const agent = harness.makeAgent('n2', ['read', 'subagent'])
  harness.emit('agent/created', { agent })

  const before = harness.catalog({ agent, scope: agent })
  // A `tools/change` that does not alter this agent's composition (another
  // agent's tool list moved) must keep the frozen text intact.
  harness.emit('tools/change', {})
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(harness.catalog({ agent, scope: agent }), before)
})

// --- census ---------------------------------------------------------------

/** One in-memory stand-in for the `sessionQuery` service. */
function sessionQuery(sessions) {
  const reads = []
  return {
    reads,
    async listSessions() {
      return sessions.map(session => ({
        header: { id: session.id, createdAt: session.createdAt ?? Date.now(), isSeeded: false },
        live: session.live === true,
        persisted: true,
      }))
    },
    async inspectSession(id, read) {
      reads.push(id)
      const session = sessions.find(entry => entry.id === id)
      if (session === undefined) throw new Error(`unknown session ${id}`)
      return read({ snapshotEvents: () => session.events })
    },
  }
}

/** `count` calls to one tool, spread over `spanDays` ending now. */
function callEvents(name, count, spanDays = 10) {
  const events = []
  const span = spanDays * 86400000
  const step = span / Math.max(count, 1)
  for (let index = 0; index < count; index += 1) {
    events.push({ type: 'tool/call', time: Date.now() - span + index * step, data: { name, arguments: '{}' } })
  }
  return events
}

/** Redirect the census record into a throwaway DSH_HOME for one test. */
function censusSandbox() {
  const home = mkdtempSync(join(tmpdir(), 'lazy-tools-census-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    home,
    record: join(home, 'lazy-tools', 'census.json'),
    write(value) {
      mkdirSync(join(home, 'lazy-tools'), { recursive: true })
      writeFileSync(this.record, JSON.stringify(value), 'utf8')
    },
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    },
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('the first census runs after load and re-derives the resident layer', async () => {
  const sandbox = censusSandbox()
  try {
    const service = sessionQuery([{
      id: 's1',
      events: [...callEvents('pwsh', 300), ...callEvents('subagent', 10)],
    }])
    const harness = createHarness({ sessionQuery: service })
    const agent = harness.makeAgent('c1', ['read', 'pwsh', 'subagent', 'web_search'])
    apply(harness.ctx, { visible: [], promptSection: false, statusTool: true, census: { startDelayMs: 0 } })
    harness.emit('agent/created', { agent })
    await sleep(200)

    assert.deepEqual(service.reads, ['s1'], 'the census read the session')
    const names = harness.ctx.tools.definitions(agent).map(entry => entry.name)
    assert.ok(names.includes('pwsh'), 'a tool used 10x/day stays resident')
    assert.ok(!names.includes('subagent'), 'a tool used 0.3x/day is deferred')
    assert.ok(!names.includes('web_search'), 'a tool with no calls is deferred')

    const status = await harness.registered.get('toolbox_status').execute({}, { agent })
    assert.equal(status.census.source, 'census')
    assert.equal(status.census.sessions, 1)
    assert.equal(status.census.calls, 310)
    assert.ok(status.census.residentCount >= 1)
    assert.ok(Date.parse(status.census.lastRunAt) > 0, 'the run stamped its own time')

    assert.ok(existsSync(sandbox.record), 'the result is recorded')
    const record = JSON.parse(readFileSync(sandbox.record, 'utf8'))
    assert.equal(record.version, 1)
    assert.ok(record.resident.includes('pwsh'))
    assert.ok(!record.resident.includes('subagent'))
    assert.equal(record.calls, 310)
  } finally {
    sandbox.restore()
  }
})

test('a fresh census record postpones the next run by the configured interval', async () => {
  const sandbox = censusSandbox()
  try {
    const lastAt = Date.now() - 60 * 60 * 1000
    sandbox.write({
      version: 1,
      lastAt,
      thresholds: { windowDays: 30, minCallsPerDay: 3, maxSchemaChars: 1500, dominantCallsPerDay: 50 },
      windowDays: 30,
      sessions: 3,
      calls: 99,
      failed: 0,
      truncated: false,
      resident: ['read', 'pwsh'],
      rows: [],
    })
    const service = sessionQuery([{ id: 's1', events: callEvents('subagent', 500) }])
    const harness = createHarness({ sessionQuery: service })
    const agent = harness.makeAgent('c2', ['read', 'pwsh', 'subagent'])
    apply(harness.ctx, { visible: [], promptSection: false, statusTool: true, census: { startDelayMs: 0 } })
    harness.emit('agent/created', { agent })
    await sleep(200)

    assert.deepEqual(service.reads, [], 'no census before the recorded run plus one interval')
    const status = await harness.registered.get('toolbox_status').execute({}, { agent })
    assert.equal(status.census.sessions, 3, 'the recorded measurement is reported')
    assert.equal(status.census.source, 'census')
    const due = Date.parse(status.census.nextRunAt)
    assert.ok(Math.abs(due - (lastAt + 30 * 86400000)) < 2000, 'the next run is one interval after the recorded run')

    const names = harness.ctx.tools.definitions(agent).map(entry => entry.name)
    assert.ok(names.includes('pwsh'), 'the recorded layer is what the agent is restricted against')
    assert.ok(!names.includes('subagent'))
  } finally {
    sandbox.restore()
  }
})

test('an overdue record triggers a fresh census on load', async () => {
  const sandbox = censusSandbox()
  try {
    const lastAt = Date.now() - 31 * 86400000
    sandbox.write({
      version: 1,
      lastAt,
      thresholds: { windowDays: 30, minCallsPerDay: 3, maxSchemaChars: 1500, dominantCallsPerDay: 50 },
      windowDays: 30,
      sessions: 1,
      calls: 5,
      failed: 0,
      truncated: false,
      resident: ['read'],
      rows: [],
    })
    const service = sessionQuery([{ id: 's9', events: callEvents('subagent', 300) }])
    const harness = createHarness({ sessionQuery: service })
    const agent = harness.makeAgent('c3', ['read', 'subagent'])
    apply(harness.ctx, { visible: [], promptSection: false, statusTool: true, census: { startDelayMs: 0 } })
    harness.emit('agent/created', { agent })
    await sleep(200)

    assert.deepEqual(service.reads, ['s9'], 'the overdue census ran')
    const names = harness.ctx.tools.definitions(agent).map(entry => entry.name)
    assert.ok(names.includes('subagent'), 'the fresh measurement promoted the tool')
    const record = JSON.parse(readFileSync(sandbox.record, 'utf8'))
    assert.ok(record.lastAt > lastAt, 'the record was refreshed by this run')
  } finally {
    sandbox.restore()
  }
})

test('census.intervalDays 0 keeps the census manual', async () => {
  const sandbox = censusSandbox()
  try {
    const service = sessionQuery([{ id: 's1', events: callEvents('pwsh', 90) }])
    const harness = createHarness({ sessionQuery: service })
    const agent = harness.makeAgent('c4', ['read', 'pwsh'])
    apply(harness.ctx, {
      visible: [],
      promptSection: false,
      statusTool: true,
      census: { intervalDays: 0, startDelayMs: 0 },
    })
    harness.emit('agent/created', { agent })
    await sleep(200)

    assert.deepEqual(service.reads, [], 'no automatic run when the interval is 0')
    const status = await harness.registered.get('toolbox_status').execute({}, { agent })
    assert.equal(status.census.nextRunAt, null)

    const manual = await harness.registered.get('toolbox_census').execute({}, { agent })
    assert.equal(manual.applied, true)
    assert.ok(manual.resident.includes('pwsh'), '3 calls/day is enough to stay resident')
  } finally {
    sandbox.restore()
  }
})

test('a dry run reports without applying or recording', async () => {
  const sandbox = censusSandbox()
  try {
    const service = sessionQuery([{ id: 's1', events: callEvents('pwsh', 300) }])
    const harness = createHarness({ sessionQuery: service })
    const agent = harness.makeAgent('c5', ['read', 'pwsh', 'web_search'])
    apply(harness.ctx, {
      visible: [],
      promptSection: false,
      statusTool: true,
      census: { intervalDays: 0 },
    })
    harness.emit('agent/created', { agent })
    const before = harness.ctx.tools.definitions(agent).map(entry => entry.name)

    const result = await harness.registered.get('toolbox_census').execute({ dryRun: true }, { agent })
    assert.equal(result.dryRun, true)
    assert.equal(result.applied, false)
    assert.ok(result.resident.includes('pwsh'), 'the dry run still reports the layer it would adopt')
    assert.ok(result.removed.includes('glob'), 'the dry run reports what it would drop')
    assert.ok(result.inForce.includes('glob'), 'but nothing was dropped from the session')
    assert.equal(existsSync(sandbox.record), false, 'a dry run records nothing')

    const status = await harness.registered.get('toolbox_status').execute({}, { agent })
    assert.equal(status.census.lastRunAt, null, 'a dry run does not start the interval')
    assert.equal(status.census.source, 'default-list')
  } finally {
    sandbox.restore()
  }
})

test('census.apply false records the measurement without changing the layer', async () => {
  const sandbox = censusSandbox()
  try {
    const service = sessionQuery([{ id: 's1', events: callEvents('subagent', 500) }])
    const harness = createHarness({ sessionQuery: service })
    const agent = harness.makeAgent('c6', ['read', 'subagent'])
    apply(harness.ctx, {
      visible: [],
      promptSection: false,
      statusTool: true,
      census: { intervalDays: 0, apply: false },
    })
    harness.emit('agent/created', { agent })

    const result = await harness.registered.get('toolbox_census').execute({}, { agent })
    assert.equal(result.applied, false)
    assert.ok(result.top.some(row => row.name === 'subagent' && row.resident === true), 'the measurement still says resident')

    const names = harness.ctx.tools.definitions(agent).map(entry => entry.name)
    assert.ok(!names.includes('subagent'), 'the shipped layer still governs the session')
    const status = await harness.registered.get('toolbox_status').execute({}, { agent })
    assert.equal(status.census.source, 'census-not-applied')
    assert.ok(existsSync(sandbox.record), 'the measurement is still recorded')
  } finally {
    sandbox.restore()
  }
})

test('without the sessionQuery service the census fails loudly instead of guessing', async () => {
  const harness = createHarness()
  apply(harness.ctx, {
    visible: [],
    promptSection: false,
    statusTool: true,
    census: { intervalDays: 0 },
  })
  const agent = harness.makeAgent('c7', ['read', 'web_search'])
  harness.emit('agent/created', { agent })

  await assert.rejects(
    harness.registered.get('toolbox_census').execute({}, { agent }),
    /sessionQuery/,
  )
  const names = harness.ctx.tools.definitions(agent).map(entry => entry.name)
  assert.ok(names.includes('read'), 'the plugin keeps working without the census')
  assert.ok(!names.includes('web_search'))
})

