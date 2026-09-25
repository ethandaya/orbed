import { afterEach, test as check } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTestFiles, loadSuite } from '../src/suite.ts'

const orbed = join(process.cwd(), 'src', 'index.ts')
const workspaces: string[] = []
afterEach(async () => {
  while (workspaces.length) await rm(workspaces.pop()!, { recursive: true, force: true })
})
const workspace = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), 'orbed-suite-'))
  workspaces.push(root)
  await write(root, files)
  return root
}
const write = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
}
const tests = (...names: string[]) =>
  `import { test } from '${orbed}'\n${names.map(name => `test('${name}', async () => {})\n`).join('')}`

check('discovers test files outside dependencies, build output and dot-directories', async () => {
  const root = await workspace({
    'b.orbed.ts': tests('b'),
    'tests/a.orbed.ts': tests('a'),
    'node_modules/pkg/x.orbed.ts': tests('x'),
    'dist/y.orbed.ts': tests('y'),
    '.amp/z.orbed.ts': tests('z'),
    'tests/helper.ts': '',
    'tests/skipped.orbed.ts': `import { test } from '${orbed}'\nif (process.env.NEVER_SET_IN_TESTS) test('skipped', async () => {})\n`,
  })
  assert.deepEqual(await findTestFiles(root), [join(root, 'b.orbed.ts'), join(root, 'tests/a.orbed.ts'), join(root, 'tests/skipped.orbed.ts')])
  const suite = await loadSuite(root)
  assert.deepEqual(suite.tests.map(t => t.name), ['b', 'a'])
  assert.deepEqual(suite.config, {})
})

check('each load reflects edits to tests, their imports and the config', async () => {
  const root = await workspace({
    'orbed.config.ts': `export default { instructions: 'first' }\n`,
    'names.ts': `export const name = 'first'\n`,
    'app.orbed.ts': `import { test } from '${orbed}'\nimport { name } from './names.ts'\ntest(name, async () => {})\n`,
  })
  const before = await loadSuite(root)
  assert.deepEqual(before.tests.map(t => t.name), ['first'])
  assert.equal(before.config.instructions, 'first')
  await write(root, {
    'orbed.config.ts': `export default { instructions: 'second' }\n`,
    'names.ts': `export const name = 'second'\n`,
    'more.orbed.ts': tests('added'),
  })
  const after = await loadSuite(root)
  assert.deepEqual(after.tests.map(t => t.name), ['second', 'added'])
  assert.equal(after.config.instructions, 'second')
})

check('invalid suites fail when loaded', async () => {
  await assert.rejects(loadSuite(await workspace({ 'readme.md': '' })), /No test files found/)
  await assert.rejects(loadSuite(await workspace({ 'empty.orbed.ts': 'export {}\n' })), /No tests registered by empty\.orbed\.ts/)
  await assert.rejects(loadSuite(await workspace({ 'a.orbed.ts': tests('same'), 'b.orbed.ts': tests('same') })), /unique: same/)
  await assert.rejects(loadSuite(await workspace({ 'orbed.config.ts': 'export default 1\n', 'a.orbed.ts': tests('a') })), /config object/)
  await assert.rejects(loadSuite(await workspace({ 'orbed.config.ts': 'export default { beforeEach: "" }\n', 'a.orbed.ts': tests('a') })), /beforeEach/)
})

check('fixing a file that failed to load takes effect on the next load', async () => {
  const root = await workspace({
    'orbed.config.ts': 'export default {\n',
    'helper.ts': 'export const name = (\n',
    'app.orbed.ts': `import { test } from '${orbed}'\nimport { name } from './helper.ts'\ntest(name, async () => {})\n`,
    'other.orbed.ts': `import { test } from '${orbed}'\ntest('other', async () =>\n`,
  })
  const fixes: Record<string, string> = {
    'orbed.config.ts': 'export default {}\n',
    'helper.ts': `export const name = 'fixed'\n`,
    'other.orbed.ts': tests('other'),
  }
  for (const [path, content] of Object.entries(fixes)) {
    await assert.rejects(loadSuite(root))
    await write(root, { [path]: content })
  }
  assert.deepEqual((await loadSuite(root)).tests.map(t => t.name), ['fixed', 'other'])
})

check('a config that imports a test file keeps that file’s tests', async () => {
  const root = await workspace({
    'orbed.config.ts': `import { label } from './a.orbed.ts'\nexport default { instructions: label }\n`,
    'a.orbed.ts': `${tests('a')}export const label = 'shared'\n`,
    'b.orbed.ts': tests('b'),
  })
  const suite = await loadSuite(root)
  assert.deepEqual(suite.tests.map(t => t.name), ['a', 'b'])
  assert.equal(suite.config.instructions, 'shared')
})
