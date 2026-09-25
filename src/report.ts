import type { Target, PortalURLs } from './portals.ts'
import type { Step } from './runtime.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative } from 'node:path'

export type Assessment = {
  claim: string
  verdict: 'supported' | 'contradicted' | 'insufficient-evidence'
  reason: string
  evidence: number[]
}
export type Event = {
  action: string
  at: string
  step?: number
  resource?: Target
  portal?: string
  url?: string
  path?: string
  selector?: string
  text?: string
  snapshot?: string
  screenshot?: string
  error?: string
  recoverable?: boolean
  assessment?: Assessment
  command?: string
  stdout?: string
  stderr?: string
  exitCode?: number
}
export type Status = 'passed' | 'failed' | 'incomplete'
export type SetupResult = {
  command: string
  stdout: string
  stderr: string
  exitCode?: number
  error?: string
}
export type Result = {
  name: string
  status: Status
  reason?: string
  threadID?: string
  archived?: boolean
  portalURLs?: PortalURLs
  evidence?: string
  assessments?: Assessment[]
  steps?: (Step & { status: Status; reason?: string })[]
  setup?: SetupResult
  durationMs?: number
}
export type Report = {
  schemaVersion: 1
  runID: string
  complete: boolean
  passed: boolean
  results: Result[]
  reportPath: string
  error?: string
}

type Evidence = { events?: Event[] }

const label = (status: Status) => status === 'passed' ? 'PASS' : status === 'failed' ? 'FAIL' : 'INCOMPLETE'
const block = (value: string) => value.trim() ? value.trim().split('\n').map(line => `    ${line}`).join('\n') : '    (empty)'

/** Write the review artifact: claims, verdicts and the exact observations cited for them. */
export async function writeMarkdownReport(report: Report): Promise<void> {
  const passed = report.results.filter(result => result.status === 'passed').length
  const failed = report.results.filter(result => result.status === 'failed').length
  const incomplete = report.results.filter(result => result.status === 'incomplete').length
  const lines = [
    `# orbed run: ${report.passed ? 'PASS' : 'FAIL'}`,
    '',
    `Run: \`${report.runID}\``,
    `Tests: ${passed} passed, ${failed} failed, ${incomplete} incomplete`,
    `Complete: ${report.complete ? 'yes' : 'no'}`,
    '',
  ]
  if (report.error) lines.push(`Suite error: ${report.error}`, '')
  for (const result of report.results) {
    lines.push(`## ${label(result.status)} — ${result.name}`, '')
    if (result.durationMs !== undefined) lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`, '')
    if (result.reason) lines.push(`Reason: ${result.reason}`, '')
    if (result.setup) {
      lines.push('### Setup', '', `Command: \`${result.setup.command}\``, `Exit: ${result.setup.exitCode ?? 'error'}`, '')
      if (result.setup.stdout.trim()) lines.push('Output:', '', block(result.setup.stdout), '')
      if (result.setup.stderr.trim()) lines.push('Error output:', '', block(result.setup.stderr), '')
    }
    let evidence: Evidence = {}
    if (result.evidence) {
      evidence = JSON.parse(await readFile(result.evidence, 'utf8')) as Evidence
      const path = relative(dirname(report.reportPath), result.evidence).replaceAll('\\', '/')
      lines.push(`[Raw evidence](${path})`, '')
    }
    let assessmentIndex = 0
    for (const [stepIndex, step] of (result.steps ?? []).entries()) {
      lines.push(`### ${stepIndex + 1}. ${label(step.status)} — ${step.kind}`, '', step.instruction, '')
      if (step.reason) lines.push(`Reason: ${step.reason}`, '')
      const recorded = step.kind === 'expect' ? result.assessments?.[assessmentIndex++] : undefined
      const assessment = evidence.events?.find(event => event.step === stepIndex && event.action === 'check' && !event.error)?.assessment ?? recorded
      if (!assessment) continue
      lines.push(`Verdict: **${assessment.verdict}**`, '', assessment.reason, '', 'Evidence:', '')
      for (const id of assessment.evidence) {
        const event = evidence.events?.[id]
        if (!event) {
          lines.push(`- Event ${id} (missing from evidence file)`)
          continue
        }
        if (event.screenshot) {
          const path = relative(dirname(report.reportPath), event.screenshot).replaceAll('\\', '/')
          lines.push(`- [Screenshot from ${event.portal ?? 'portal'} event ${id}](${path})${event.url ? ` — ${event.url}` : ''}`)
        } else if (event.action === 'command') {
          lines.push(`- Command event ${id}: \`${event.command}\` (exit ${event.exitCode})`)
          if (event.stdout?.trim()) lines.push('', block(event.stdout), '')
          if (event.stderr?.trim()) lines.push('', block(event.stderr), '')
        } else lines.push(`- Event ${id}: ${event.action}`)
      }
      lines.push('')
    }
    if (!result.steps?.length) lines.push('No test steps ran.', '')
    lines.push('---', '')
  }
  await writeFile(report.reportPath, `${lines.join('\n')}\n`)
}

/** Keep passing JSON unpublished until its review artifact exists and cancellation is settled. */
export async function finalizeReport(
  report: Report,
  signal: AbortSignal,
  save: () => Promise<void>,
  writeMarkdown: (report: Report) => Promise<void> = writeMarkdownReport,
): Promise<void> {
  let rendered = JSON.stringify(report)
  try {
    await writeMarkdown(report)
  } catch (error) {
    report.complete = false
    report.passed = false
    report.error = `Report generation failed: ${error}`
  }
  await persistTerminalReport(report, signal, save)
  if (JSON.stringify(report) === rendered) return
  try {
    await writeMarkdown(report)
  } catch (error) {
    report.complete = false
    report.passed = false
    report.error = `Report generation failed: ${error}`
    await save()
  }
}

/** Persist terminal state without allowing cancellation during the write to return a passing report. */
export async function persistTerminalReport(report: Report, signal: AbortSignal, save: () => Promise<void>): Promise<void> {
  let cancellationRecorded = false
  const recordCancellation = () => {
    if (!signal.aborted || cancellationRecorded) return false
    cancellationRecorded = true
    report.complete = false
    report.passed = false
    report.error = String(signal.reason ?? new Error('orbed suite cancelled'))
    return true
  }
  recordCancellation()
  await save()
  if (recordCancellation()) await save()
}

/** Action citations describe steps; at least one captured observation must support a claim. */
export function evidenceError(ids: number[], events: Event[], portals: PortalURLs, target?: Target, after = -1): string | undefined {
  if (!Array.isArray(ids) || !ids.length) return 'Cite at least one captured observation'
  after = Math.max(after, events.findLastIndex(event =>
    ['click', 'fill', 'press'].includes(event.action)))
  let observations = 0
  let fresh = false
  let targetObservation = target === undefined
  for (const id of ids) {
    const event = events[id]
    if (!Number.isInteger(id) || id < 0 || !event || event.error) return `Invalid evidence ID ${id}`
    const command = event.action === 'command' && !!event.command &&
      typeof event.stdout === 'string' && typeof event.stderr === 'string' && Number.isInteger(event.exitCode)
    const url = event.portal === undefined ? undefined : portals[event.portal]
    const browser = ['open', 'navigate', 'snapshot'].includes(event.action) && event.snapshot && event.screenshot &&
      url && event.url && new URL(event.url).origin === new URL(url).origin
    if (id > after && ((browser && target?.kind === 'portal' && event.portal === target.name) ||
        (command && target?.kind !== 'portal' && event.resource?.kind === target?.kind && event.resource?.name === target?.name))) targetObservation = true
    if ((command || browser) && id > after) fresh = true
    if (command || browser) observations++
    else if (!['click', 'fill', 'press'].includes(event.action)) return `Event ${id} is not captured evidence`
  }
  if (!observations) return 'Actions alone are not proof; capture a snapshot or command observation'
  if (!targetObservation) return `Capture a fresh observation of ${target!.kind} ${target!.name} for this step`
  if (!fresh) return 'Capture fresh evidence for this expectation'
}

export function evaluate(step: Step, events: Event[], portals: PortalURLs, start = 0): Pick<Result, 'status' | 'reason' | 'assessments'> {
  const incomplete = (reason: string): Pick<Result, 'status' | 'reason'> => ({ status: 'incomplete', reason })
  for (const [index, event] of events.entries()) {
    if (index < start) continue
    if (!event.error || (event.action === 'check' && event.recoverable)) continue
    const retry = events.findIndex((e, i) => i > index && e.action === event.action && e.portal === event.portal && !e.error)
    const observation = events.findIndex((e, i) => i > retry && e.action === 'snapshot' && e.portal === event.portal && !e.error && e.snapshot && e.screenshot)
    const nextCheck = events.findIndex((e, i) => i > index && e.action === 'check' && !e.error)
    if (!event.recoverable || retry < 0 || observation < 0 || nextCheck < observation) {
      return incomplete('An operation failed without a successful retry and fresh observation before assessment')
    }
  }
  if (events.at(-1)?.action !== 'finish') return incomplete('Agent did not finish')
  const checks = events.slice(start).filter(e => e.action === 'check' && !e.error)
  if (checks.length !== 1) return incomplete('Missing or duplicate step assessment')
  if (events.at(-2) !== checks[0]) return incomplete('Assessment must follow all step operations')
  for (const check of checks) {
    const assessment = check.assessment
    if (!assessment || assessment.claim !== step.instruction ||
        !['supported', 'contradicted', 'insufficient-evidence'].includes(assessment.verdict) ||
        typeof assessment.reason !== 'string' || !assessment.reason.trim() ||
        !Array.isArray(assessment.evidence) || !assessment.evidence.length) {
      return incomplete('Invalid assertion evidence')
    }
    const error = evidenceError(assessment.evidence, events.slice(0, events.indexOf(check)), portals, step.target, start - 1)
    if (error) return incomplete(error)
  }
  const assessments = checks.map(check => check.assessment!)
  const uncertain = assessments.find(a => a.verdict === 'insufficient-evidence')
  const failed = assessments.find(a => a.verdict === 'contradicted')
  return { assessments, ...(uncertain ? incomplete(uncertain.reason) : failed ? { status: 'failed' as const, reason: failed.reason } : { status: 'passed' as const }) }
}
