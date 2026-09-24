import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('CLI exit codes distinguish pass, blocked gate and malformed input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orbed-cli-'))
  try {
    const path = join(directory, 'report.json')
    const base = { schemaVersion: 1, runID: 'cli', complete: true, passed: true,
      revision: 'a'.repeat(40), clean: true, sourceHash: 'b'.repeat(64), results: [{ name: 'case', status: 'passed' }] }
    for (const [report, expected] of [[base, 0], [{ ...base, complete: false }, 1],
      [{ ...base, results: [{ name: 'case', status: 'failed' }] }, 1], [{}, 2]]) {
      await writeFile(path, JSON.stringify(report))
      const process = spawnSync('node', ['dist/cli.js', 'check', path], { encoding: 'utf8' })
      assert.equal(process.status, expected, process.stderr)
    }
    const invalid = spawnSync('node', ['dist/cli.js', 'run', '--project', 'example/app', '--revision', 'main'], { encoding: 'utf8' })
    assert.equal(invalid.status, 2)
    assert.match(invalid.stderr, /40-character/)
  } finally { await rm(directory, { recursive: true }) }
})
