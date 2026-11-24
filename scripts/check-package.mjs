#!/usr/bin/env node
/**
 * Dependency-free packaging self-check for dsh-lazy-tools.
 *
 * Run with `npm run check`. It verifies the manifest fields DSH relies on, that
 * every `files` entry resolves to a real file, that each locale parses and
 * points at an existing detail document, and that the shipped Loader patch and
 * icon are usable.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

const fail = message => problems.push(message)
const ok = message => notes.push(message)

function readText(relPath) {
  try {
    return readFileSync(join(root, relPath), 'utf8')
  } catch (error) {
    fail(`${relPath}: ${error.message}`)
    return undefined
  }
}

function statOrUndefined(relPath) {
  try {
    return statSync(join(root, relPath))
  } catch {
    return undefined
  }
}

// --- manifest -----------------------------------------------------------

let manifest
const manifestText = readText('package.json')
if (manifestText !== undefined) {
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    fail(`package.json is not valid JSON: ${error.message}`)
  }
}

if (manifest !== undefined) {
  for (const field of ['name', 'version', 'description', 'license', 'author', 'repository', 'homepage', 'bugs']) {
    const value = manifest[field]
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      fail(`package.json is missing "${field}"`)
    }
  }
  if (manifest.type !== 'module') fail('package.json must declare "type": "module"')
  if (manifest.main !== 'index.js') fail('package.json main must be index.js')
  const exports = manifest.exports
  if (exports === null || typeof exports !== 'object') {
    fail('package.json is missing "exports"')
  } else {
    for (const key of ['.', './locale/*.json', './icon']) {
      if (exports[key] === undefined) fail(`package.json exports is missing "${key}"`)
    }
  }
  const patch = manifest.dsh?.bundle?.patch
  if (patch === undefined) fail('package.json is missing "dsh.bundle.patch"')
  else if (statOrUndefined(patch) === undefined) fail(`dsh.bundle.patch points at a missing file: ${patch}`)
  if (manifest.engines?.dsh !== undefined) {
    fail('package.json must not declare engines.dsh: the plugin degrades gracefully on routes without toolUpdate')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail('package.json "files" must be a non-empty array')
  }
}

// --- files entries resolve ---------------------------------------------

/** Expand one `files` entry into the relative paths it matches. */
function expand(entry) {
  if (!entry.includes('*')) {
    return statOrUndefined(entry) === undefined ? [] : [entry]
  }
  const parts = entry.split('/')
  const pattern = parts.pop()
  const dir = parts.length === 0 ? '.' : parts.join('/')
  const directory = statOrUndefined(dir)
  if (directory === undefined || !directory.isDirectory()) return []
  const matcher = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return readdirSync(join(root, dir))
    .filter(name => matcher.test(name))
    .map(name => (dir === '.' ? name : `${dir}/${name}`))
    .filter(relPath => statOrUndefined(relPath) !== undefined)
}

if (manifest !== undefined && Array.isArray(manifest.files)) {
  for (const entry of manifest.files) {
    // A negation (`!docs/MAINTENANCE.md`) excludes an already-included path,
    // so it is checked for a resolvable target, not for matching files.
    if (entry.startsWith('!')) {
      const target = entry.slice(1)
      if (statOrUndefined(target) === undefined) fail(`files exclusion names a missing path: ${entry}`)
      else ok(`files "${entry}" excludes ${target}`)
      continue
    }
    const matches = expand(entry)
    if (matches.length === 0) fail(`files entry matches nothing: ${entry}`)
    else ok(`files "${entry}" -> ${matches.length} path(s)`)
  }
}

// --- locales and detail documents --------------------------------------

const locales = ['locale/en.json', 'locale/zh.json']
const detailDocuments = new Set()
for (const localePath of locales) {
  const text = readText(localePath)
  if (text === undefined) continue
  let locale
  try {
    locale = JSON.parse(text)
  } catch (error) {
    fail(`${localePath} is not valid JSON: ${error.message}`)
    continue
  }
  const meta = locale.meta
  if (meta === null || typeof meta !== 'object') {
    fail(`${localePath} is missing "meta"`)
    continue
  }
  for (const field of ['title', 'description']) {
    if (typeof meta[field] !== 'string' || meta[field].trim() === '') fail(`${localePath} meta.${field} is empty`)
  }
  if (typeof meta.detail !== 'string') {
    fail(`${localePath} meta.detail is missing`)
    continue
  }
  if (!meta.detail.startsWith('docs/') || !/\.md$/.test(meta.detail)) {
    fail(`${localePath} meta.detail must be a docs/*.md path, got ${meta.detail}`)
    continue
  }
  const detailStat = statOrUndefined(meta.detail)
  if (detailStat === undefined) fail(`${localePath} meta.detail points at a missing file: ${meta.detail}`)
  else {
    detailDocuments.add(meta.detail)
    ok(`${localePath} detail -> ${meta.detail} (${detailStat.size} bytes)`)
  }
}

// --- loader patch ------------------------------------------------------

if (manifest !== undefined) {
  const patchPath = manifest.dsh?.bundle?.patch
  if (typeof patchPath === 'string') {
    const patch = readText(patchPath)
    if (patch !== undefined) {
      if (!/\binsert\s*:/.test(patch)) fail(`${patchPath} has no insert block`)
      if (!patch.includes('id: lazy-tools')) fail(`${patchPath} does not insert the "lazy-tools" row`)
      if (!patch.includes(`name: ${manifest.name}`)) fail(`${patchPath} row name does not match the package name`)
      ok(`${patchPath} inserts the lazy-tools row`)
    }
  }
}

// --- runtime files -----------------------------------------------------

for (const relPath of ['index.js', 'icon.svg']) {
  const stat = statOrUndefined(relPath)
  if (stat === undefined) {
    fail(`missing runtime file: ${relPath}`)
    continue
  }
  if (relPath.endsWith('.svg')) {
    const svg = readFileSync(join(root, relPath), 'utf8')
    if (!svg.trimStart().startsWith('<svg')) fail('icon.svg does not start with <svg')
    if (stat.size > 256 * 1024) fail(`icon.svg is ${stat.size} bytes, above the 256 KiB limit`)
    ok(`icon.svg renders as SVG (${stat.size} bytes)`)
  }
}

// --- report ------------------------------------------------------------

for (const note of notes) console.log(`ok   ${note}`)
for (const problem of problems) console.error(`fail ${problem}`)
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) in ${relative(process.cwd(), root) || '.'}`)
  process.exitCode = 1
} else {
  console.log('\npackage check passed')
}
