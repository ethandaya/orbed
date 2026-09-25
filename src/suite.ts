import { access, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Config, PortalTest } from './index.ts'
import { collect } from './registry.ts'

export type Suite = { tests: PortalTest[]; config: Config }

const CONFIG_FILE = 'orbed.config.ts'
const TEST_SUFFIX = '.orbed.ts'
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist'])
const orbedModules = dirname(fileURLToPath(import.meta.url)) + sep

const MODULE_FILE = /\.[cm]?[jt]sx?$|\.json$/

/** List workspace files, skipping dependencies, build output and dot-directories. */
async function workspaceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) await walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await walk(root)
  return files.sort()
}

/** Find *.orbed.ts files, skipping dependencies, build output and dot-directories. */
export async function findTestFiles(root: string): Promise<string[]> {
  return (await workspaceFiles(root)).filter(file => file.endsWith(TEST_SUFFIX))
}

/**
 * Bun keeps modules for the plugin's lifetime; drop workspace modules so edits apply.
 * require.cache only lists modules that evaluated, so a module that failed to load is
 * also evicted by path; otherwise fixing it would not take effect.
 */
async function forgetWorkspaceModules(root: string, files: string[]) {
  const realRoot = await realpath(root)
  const roots = [root, realRoot].map(path => path + sep)
  const cache = createRequire(import.meta.url).cache
  const candidates = [
    ...Object.keys(cache).filter(path => roots.some(root => path.startsWith(root)) && !path.includes(`${sep}node_modules${sep}`)),
    ...files.filter(file => MODULE_FILE.test(file)).flatMap(file => [file, join(realRoot, relative(root, file))]),
  ]
  for (const path of candidates) if (!path.startsWith(orbedModules)) delete cache[path]
}

/** Load orbed.config.ts and every test file fresh from the workspace. */
export async function loadSuite(root: string): Promise<Suite> {
  const files = await workspaceFiles(root)
  await forgetWorkspaceModules(root, files)
  const testFiles = files.filter(file => file.endsWith(TEST_SUFFIX))
  if (!testFiles.length) throw new Error(`No test files found; add *${TEST_SUFFIX} files that call test()`)
  const configPath = join(root, CONFIG_FILE)
  const hasConfig = await access(configPath).then(() => true, () => false)
  let config: unknown = {}
  // Collect while importing the config too: it may import a test file, whose test() calls run only once.
  const tests = await collect(async () => {
    if (hasConfig) config = (await import(pathToFileURL(configPath).href)).default
    for (const file of testFiles) await import(pathToFileURL(file).href)
  })
  if (typeof config !== 'object' || config === null) throw new Error(`${CONFIG_FILE} must export a config object`)
  if (!tests.length) {
    throw new Error(`No tests registered by ${testFiles.map(file => relative(root, file)).join(', ')}. Call test() from 'orbed', and check that only one copy of orbed is installed.`)
  }
  const duplicate = tests.find((test, index) => tests.findIndex(other => other.name === test.name) !== index)
  if (duplicate) throw new Error(`Test names must be unique: ${duplicate.name}`)
  return { tests, config: config as Config }
}
