import { execute, type StreamMessage } from '@ampcode/sdk'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import { exitCode, type Report } from './report.js'

const exec = promisify(execFile)

function isHTTPS(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { return new URL(value).protocol === 'https:' } catch { return false }
}

export function parseReport(value: unknown): Report {
  if (!value || typeof value !== 'object') throw new Error('Invalid Orbed report')
  const report = value as Report
  if (report.schemaVersion !== 1 || typeof report.runID !== 'string' ||
      typeof report.complete !== 'boolean' || typeof report.passed !== 'boolean' ||
      typeof report.clean !== 'boolean' || typeof report.revision !== 'string' ||
      typeof report.sourceHash !== 'string' || !Array.isArray(report.results) ||
      (report.error !== undefined && typeof report.error !== 'string') ||
      report.results.some(result => !result || typeof result.name !== 'string' || !['passed', 'failed', 'incomplete'].includes(result.status) ||
        (result.artifacts !== undefined && (!result.artifacts || !isHTTPS(result.artifacts.evidenceURL) || !Array.isArray(result.artifacts.screenshotURLs) ||
          result.artifacts.screenshotURLs.some(url => !isHTTPS(url)))))) {
    throw new Error('Invalid Orbed report')
  }
  return report
}

/** Consume actual tool results, never the assistant's final prose. */
export async function collectReport(stream: AsyncIterable<StreamMessage>, revision: string, artifacts = false): Promise<Report> {
  let invocation: string | undefined
  let report: Report | undefined
  let completed = false
  for await (const message of stream) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && /^(?:plugin__[^ ]+__)?orbed_run$/.test(block.name)) {
          if (invocation) throw new Error('Expected exactly one orbed_run invocation')
          if (block.input.revision !== revision) throw new Error('Agent requested a different revision')
          if (Boolean(block.input.artifacts) !== artifacts) throw new Error('Agent requested different artifact handling')
          invocation = block.id
        }
      }
    }
    if (message.type === 'user') {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result' || !invocation || block.tool_use_id !== invocation) continue
        if (report || block.is_error) throw new Error('Duplicate or failed orbed_run result')
        report = parseReport(JSON.parse(block.content))
      }
    }
    if (message.type === 'result') {
      if (message.is_error || message.permission_denials?.length) throw new Error('Amp execution failed or required permission was denied')
      completed = true
    }
  }
  if (!completed || !report) throw new Error('Amp did not return a completed tool-backed Orbed report')
  if (report.revision !== revision || !report.clean || !/^[a-f0-9]{64}$/.test(report.sourceHash)) {
    throw new Error('Result is not bound to the requested clean revision')
  }
  if (artifacts && report.complete && report.results.some(result => !result.artifacts)) {
    throw new Error('Completed remote result is missing requested evidence artifacts')
  }
  return report
}

export async function runRemote(project: string, revision: string, signal: AbortSignal, artifacts = false): Promise<Report> {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Supply a full 40-character Git revision')
  const stream = execute({
    prompt: `Run the configured Orbed suite. Call orbed_run exactly once with ${JSON.stringify({ revision, artifacts })}. Do not modify files, checkout another revision, push, or interpret results yourself. If the tool is unavailable, report that and stop.`,
    options: { executor: 'orb', project, visibility: 'private', noArchiveAfterExecute: false },
    signal,
  })
  return collectReport(stream, revision, artifacts)
}

async function validateArtifactFile(path: string): Promise<void> {
  const file = await stat(path)
  if (!file.isFile() || file.size < 1) throw new Error('Orbed artifact is empty or not a regular file')
  if (file.size > 16 * 1024 * 1024) throw new Error('Orbed artifact exceeds 16 MiB')
}

async function validateDownloadedEvidence(result: Report['results'][number], directory: string): Promise<void> {
  const path = join(directory, 'evidence.json')
  await validateArtifactFile(path)
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('Orbed evidence artifact is not valid JSON') }
  if (!value || typeof value !== 'object') throw new Error('Orbed evidence artifact has an invalid structure')
  const evidence = value as { test?: { name?: unknown }; events?: unknown; steps?: unknown }
  if (evidence.test?.name !== result.name || !Array.isArray(evidence.events) || !Array.isArray(evidence.steps)) {
    throw new Error('Orbed evidence artifact does not match its test result')
  }
  const screenshotURLs: string[] = []
  for (const event of evidence.events) {
    if (!event || typeof event !== 'object' || !('screenshot' in event)) continue
    const url = (event as { screenshotURL?: unknown }).screenshotURL
    if (!isHTTPS(url)) throw new Error('Orbed evidence artifact is missing a screenshot attachment')
    screenshotURLs.push(url)
  }
  if (!result.artifacts || screenshotURLs.length !== result.artifacts.screenshotURLs.length ||
      screenshotURLs.some((url, index) => url !== result.artifacts!.screenshotURLs[index])) {
    throw new Error('Orbed evidence screenshot manifest does not match the report')
  }
  for (const [index] of screenshotURLs.entries()) {
    const screenshot = join(directory, `screenshot-${index}.png`)
    await validateArtifactFile(screenshot)
    const bytes = await readFile(screenshot)
    if (!isPNG(bytes)) throw new Error('Orbed screenshot artifact is not a PNG')
  }
}

function isPNG(bytes: Buffer): boolean {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 45 || !bytes.subarray(0, signature.length).equals(signature)) return false
  let offset = signature.length
  let chunks = 0
  let width = 0
  let height = 0
  let channels = 0
  let imageDataEnded = false
  const imageData: Buffer[] = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) return false
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return false
    if (chunks++ === 0) {
      if (type !== 'IHDR' || length !== 13) return false
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (!width || !height || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return false
      channels = data[9] === 2 ? 3 : 4
    } else if (type === 'IDAT') {
      if (imageDataEnded) return false
      imageData.push(data)
    } else if (imageData.length) imageDataEnded = true
    offset = end
    if (type === 'IEND') {
      if (length !== 0 || !imageData.length || offset !== bytes.length) return false
      const expected = (width * channels + 1) * height
      if (!Number.isSafeInteger(expected) || expected > 256 * 1024 * 1024) return false
      try {
        const pixels = inflateSync(Buffer.concat(imageData), { maxOutputLength: expected })
        if (pixels.length !== expected) return false
        for (let row = 0; row < height; row++) if (pixels[row * (width * channels + 1)] > 4) return false
        return true
      } catch { return false }
    }
  }
  return false
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Download remote evidence immediately; attachment URLs are credentials and may expire. */
export async function downloadArtifacts(report: Report, directory: string,
  download: (url: string, path: string) => Promise<void> = async (url, path) => {
    await exec('amp', ['files', 'get', url, '-o', path], { timeout: 60_000, killSignal: 'SIGKILL' })
  }): Promise<void> {
  await mkdir(dirname(directory), { recursive: true })
  await mkdir(directory)
  try {
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
    for (const [index, result] of report.results.entries()) {
      if (!result.artifacts) continue
      const target = join(directory, String(index))
      await mkdir(target)
      const files = [
        [result.artifacts.evidenceURL, 'evidence.json'],
        ...result.artifacts.screenshotURLs.map((url, screenshot) => [url, `screenshot-${screenshot}.png`]),
      ] as const
      for (const [url, name] of files) {
        const path = join(target, name)
        await download(url, path)
        await validateArtifactFile(path)
      }
      await validateDownloadedEvidence(result, target)
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export { exitCode }
