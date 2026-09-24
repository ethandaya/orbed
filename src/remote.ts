import { execute, type StreamMessage } from '@ampcode/sdk'
import { exitCode, type Report } from './report.js'

export function parseReport(value: unknown): Report {
  if (!value || typeof value !== 'object') throw new Error('Invalid Orbed report')
  const report = value as Report
  if (report.schemaVersion !== 1 || typeof report.runID !== 'string' ||
      typeof report.complete !== 'boolean' || typeof report.passed !== 'boolean' ||
      typeof report.clean !== 'boolean' || typeof report.revision !== 'string' ||
      typeof report.sourceHash !== 'string' || !Array.isArray(report.results) ||
      (report.error !== undefined && typeof report.error !== 'string') ||
      report.results.some(result => !result || typeof result.name !== 'string' || !['passed', 'failed', 'incomplete'].includes(result.status))) {
    throw new Error('Invalid Orbed report')
  }
  return report
}

/** Consume actual tool results, never the assistant's final prose. */
export async function collectReport(stream: AsyncIterable<StreamMessage>, revision: string): Promise<Report> {
  let invocation: string | undefined
  let report: Report | undefined
  let completed = false
  for await (const message of stream) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && /^(?:plugin__[^ ]+__)?orbed_run$/.test(block.name)) {
          if (invocation) throw new Error('Expected exactly one orbed_run invocation')
          if (block.input.revision !== revision) throw new Error('Agent requested a different revision')
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
  return report
}

export async function runRemote(project: string, revision: string, signal: AbortSignal): Promise<Report> {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Supply a full 40-character Git revision')
  const stream = execute({
    prompt: `Run the configured Orbed suite. Call orbed_run exactly once with revision ${revision}. Do not modify files, checkout another revision, push, or interpret results yourself. If the tool is unavailable, report that and stop.`,
    options: { executor: 'orb', project, visibility: 'private', noArchiveAfterExecute: false },
    signal,
  })
  return collectReport(stream, revision)
}

export { exitCode }
