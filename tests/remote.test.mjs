import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { collectReport, downloadArtifacts, parseReport } from '../dist/remote.js'

const revision = 'a'.repeat(40)
const report = () => ({ schemaVersion: 1, runID: 'test-run', complete: true, passed: true,
  revision, clean: true, sourceHash: 'b'.repeat(64), results: [{ name: 'counter', status: 'passed' }] })
const messages = (artifacts = false, result = report()) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'orbed_run', input: { revision, artifacts } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: JSON.stringify(result), is_error: false }] } },
  { type: 'result', is_error: false, result: 'Everything passed!' },
]
async function* stream(list) { yield* list }

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function png(valid = true) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', valid ? deflateSync(Buffer.from([0, 0, 0, 0])) : Buffer.from([1])),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

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

test('requested remote artifacts are required, validated and downloaded', async () => {
  const artifactReport = report()
  artifactReport.results[0].artifacts = {
    evidenceURL: 'https://artifacts.example/evidence',
    screenshotURLs: ['https://artifacts.example/screenshot'],
  }
  assert.deepEqual(await collectReport(stream(messages(true, artifactReport)), revision, true), artifactReport)
  await assert.rejects(collectReport(stream(messages(true)), revision, true), /missing requested/)
  assert.throws(() => parseReport({ ...artifactReport, results: [{ ...artifactReport.results[0], artifacts: {
    ...artifactReport.results[0].artifacts, evidenceURL: 'http://artifacts.example/evidence',
  } }] }), /Invalid/)

  const parent = await mkdtemp(join(tmpdir(), 'orbed-artifacts-'))
  const directory = join(parent, 'bundle')
  try {
    const screenshotURL = artifactReport.results[0].artifacts.screenshotURLs[0]
    const bodies = new Map([
      [artifactReport.results[0].artifacts.evidenceURL, JSON.stringify({
        test: { name: 'counter' }, events: [{ screenshot: '/tmp/a.png', screenshotURL }], steps: [],
      })],
      [screenshotURL, png()],
    ])
    await downloadArtifacts(artifactReport, directory, async (url, path) => {
      await writeFile(path, bodies.get(url))
    })
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')), artifactReport)
    assert.equal((await readFile(join(directory, '0/screenshot-0.png'))).subarray(1, 4).toString(), 'PNG')

    const invalid = join(parent, 'invalid')
    await assert.rejects(downloadArtifacts(artifactReport, invalid, async (url, path) => {
      await writeFile(path, url === screenshotURL ? png(false) : bodies.get(url))
    }), /not a PNG/)
    await assert.rejects(access(invalid))

    const malformed = join(parent, 'malformed')
    await assert.rejects(downloadArtifacts(artifactReport, malformed, async (url, path) => {
      await writeFile(path, url === artifactReport.results[0].artifacts.evidenceURL ? '{bad' : bodies.get(url))
    }), /not valid JSON/)
    await assert.rejects(access(malformed))
  } finally { await rm(parent, { recursive: true, force: true }) }
})
