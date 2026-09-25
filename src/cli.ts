#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { downloadArtifacts, parseReport, runRemote, exitCode } from './remote.js'

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string' }, revision: { type: 'string' }, output: { type: 'string' },
    artifacts: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('orbed run --project namespace/project --revision <full-sha> [--output report.json] [--artifacts directory] [--timeout-ms 900000]\norbed check <report.json>\nExit: 0 passed; 1 failed/incomplete; 2 invocation, transport or artifact-download error.')
  } else if (positionals[0] === 'check' && positionals.length === 2) {
    const report = parseReport(JSON.parse(await readFile(positionals[1], 'utf8')))
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = exitCode(report)
  } else if (positionals[0] === 'run' && positionals.length === 1 && values.project && values.revision) {
    const timeoutMs = Number(values['timeout-ms'] ?? 900_000)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error('timeout-ms must be 1–3600000')
    const report = await runRemote(values.project, values.revision, AbortSignal.timeout(timeoutMs), Boolean(values.artifacts))
    const json = JSON.stringify(report, null, 2)
    if (values.output) await writeFile(values.output, json)
    if (values.artifacts) await downloadArtifacts(report, values.artifacts)
    console.log(json)
    process.exitCode = exitCode(report)
  } else throw new Error('Use orbed --help for usage')
} catch (error) {
  console.error(String(error))
  process.exitCode = 2
}
