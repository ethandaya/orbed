import { join } from 'node:path'
import type { PortalTest } from './index.ts'
import { portalPathURL, type PortalURLs } from './portals.ts'
import { evaluate, evidenceError, isVerdict, type Event } from './report.ts'
import type { Step } from './runtime.ts'

export type BrowserRun = {
  test: PortalTest
  portals: PortalURLs
  current: string
  directory: string
  events: Event[]
  steps: Step[]
  step?: Step
  start: number
  finished: boolean
}

type Browser = (...args: string[]) => Promise<string>

const interactions = new Set(['click', 'fill', 'press'])
const observations = new Set(['open', 'navigate', 'snapshot'])

const selector = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new Error('A CSS selector is required')
  return value
}

async function recordBrowserURL(run: BrowserRun, event: Event, browser: Browser): Promise<void> {
  event.url = await browser('get', 'url')
  if (new URL(event.url).origin !== new URL(run.portals[run.current]).origin) throw new Error('Browser left the declared portal')
}

export async function performBrowserAction(
  run: BrowserRun,
  input: Record<string, unknown>,
  browser: Browser,
  save: () => Promise<void>,
): Promise<string> {
  const event: Event = {
    action: String(input.action),
    at: new Date().toISOString(),
    portal: run.current || undefined,
    step: run.steps.length - 1,
  }
  try {
    if (event.action === 'check') {
      event.recoverable = true
      if (run.events.slice(run.start).some(e => e.action === 'check' && !e.error)) throw new Error('This step has already been checked')
      if (!isVerdict(input.verdict) ||
          typeof input.reason !== 'string' || !input.reason.trim() || !Array.isArray(input.evidence)) {
        throw new Error('Check requires a verdict, reason and captured evidence IDs')
      }
      event.assessment = {
        claim: run.step!.instruction,
        verdict: input.verdict,
        reason: input.reason,
        evidence: input.evidence as number[],
      }
      const error = evidenceError(event.assessment.evidence, run.events, run.portals, run.step!.target, run.start - 1)
      if (error) throw new Error(`${error}. This step has not advanced; capture valid evidence and resubmit check.`)
    } else if (event.action === 'finish') {
      run.finished = true
    } else if (event.action === 'open') {
      const name = input.portal ?? (Object.keys(run.portals).length === 1 ? Object.keys(run.portals)[0] : undefined)
      if (typeof name !== 'string' || !Object.hasOwn(run.portals, name)) throw new Error('Open requires a declared portal name')
      run.current = name
      event.portal = name
      if (!run.events.some(e => e.action === 'open' && e.portal === name && !e.error)) {
        await browser('open', run.portals[name])
      }
      await browser('set', 'viewport', ...run.test.viewport.map(String), '2')
      await recordBrowserURL(run, event, browser)
      event.snapshot = await browser('snapshot')
    } else if (event.action === 'navigate') {
      if (!run.current || !run.events.some(e => e.action === 'open' && e.portal === run.current && !e.error)) throw new Error('Open the portal first')
      event.path = typeof input.path === 'string' ? input.path : undefined
      await browser('open', portalPathURL(run.portals[run.current], input.path))
      await recordBrowserURL(run, event, browser)
      event.snapshot = await browser('snapshot')
    } else {
      if (!run.events.some(e => e.action === 'open' && !e.error)) throw new Error('Open the portal first')
      await recordBrowserURL(run, event, browser)
      if (event.action === 'snapshot') event.snapshot = await browser('snapshot')
      else if (event.action === 'click' || event.action === 'fill') {
        event.selector = selector(input.selector)
        if (event.action === 'fill') {
          if (typeof input.text !== 'string') throw new Error('Fill requires text')
          await browser('fill', event.selector, input.text)
        } else await browser('click', event.selector)
      } else if (event.action === 'press') {
        if (typeof input.key !== 'string' || input.key.startsWith('-')) throw new Error('Press requires a key')
        await browser('press', input.key)
      } else throw new Error('Unknown action')
    }
    if (interactions.has(event.action)) await recordBrowserURL(run, event, browser)
    if (observations.has(event.action)) {
      const screenshot = join(run.directory, `event-${run.events.length}.png`)
      await browser('screenshot', screenshot)
      event.screenshot = screenshot
    }
  } catch (error) {
    event.error = String(error)
    if (interactions.has(event.action) &&
        /Element not found:|strict mode violation|^Error: (A CSS selector is required|Fill requires text|Press requires a key)$/i.test(event.error)) {
      event.recoverable = true
      event.error += ' Inspect the page and retry with a valid target, then capture a fresh snapshot before checking claims.'
    }
  }
  run.events.push(event)
  await save()
  return JSON.stringify(event.action === 'finish' ? evaluate(run.step!, run.events, run.portals, run.start) : { id: run.events.length - 1, ...event })
}
