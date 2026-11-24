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

import { apply } from '../index.js'

function definition(name, description = `${name} tool`) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
  }
}

function createHarness({ liveAgents } = {}) {
  const handlers = new Map()
  const registered = new Map()
  const sections = new Map()

  const ctx = {
    get(key) {
      if (key === 'agents' && liveAgents !== undefined) return { list: () => liveAgents() }
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
  // 3 toolbox tools (global) + read + subagent (composed) = 5
  assert.equal(status.composedToolCount, 5)
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
  // 3 toolbox tools (global) + read + web_search + subagent = 6
  assert.equal(status.composedToolCount, 6)
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
