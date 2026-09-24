import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectReport, parseReport } from '../dist/remote.js'

const revision = 'a'.repeat(40)
const report = () => ({ schemaVersion: 1, runID: 'test-run', complete: true, passed: true,
  revision, clean: true, sourceHash: 'b'.repeat(64), results: [{ name: 'counter', status: 'passed' }] })
const messages = () => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'orbed_run', input: { revision } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: JSON.stringify(report()), is_error: false }] } },
  { type: 'result', is_error: false, result: 'Everything passed!' },
]
async function* stream(list) { yield* list }

test('only a matching tool-backed result establishes completion', async () => {
  assert.deepEqual(await collectReport(stream(messages()), revision), report())
  await assert.rejects(collectReport(stream([messages()[2]]), revision), /tool-backed/)
  const wrongTool = messages()
  wrongTool[1].message.content[0].tool_use_id = 'unrelated'
  await assert.rejects(collectReport(stream(wrongTool), revision), /tool-backed/)
})

test('transport errors, duplicate calls, wrong revision and malformed results cannot pass', async () => {
  const mutations = [
    m => m.pop(),
    m => { m[2].is_error = true },
    m => { m[2].permission_denials = ['orbed_run'] },
    m => m.splice(1, 0, m[0]),
    m => { m[0].message.content[0].input.revision = 'c'.repeat(40) },
    m => { m[1].message.content[0].content = '{invalid' },
    m => { m[1].message.content[0].content = JSON.stringify({ ...report(), clean: false }) },
    m => { m[1].message.content[0].content = JSON.stringify({ ...report(), revision: 'c'.repeat(40) }) },
  ]
  for (const mutate of mutations) {
    const data = messages()
    mutate(data)
    await assert.rejects(collectReport(stream(data), revision))
  }
  for (const value of [null, {}, { ...report(), results: [null] }, { ...report(), complete: 'true' }]) {
    assert.throws(() => parseReport(value), /Invalid/)
  }
})

test('failed suite is retained even if final assistant prose claims success', async () => {
  const data = messages()
  data[1].message.content[0].content = JSON.stringify({ ...report(), passed: false, results: [{ name: 'counter', status: 'failed' }] })
  assert.equal((await collectReport(stream(data), revision)).passed, false)
})
