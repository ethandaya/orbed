#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { parseReport, exitCode } from './report.js'

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' } } })
  if (values.help) {
    console.log('orbed check <report.json>\nExit: 0 passed; 1 failed/incomplete; 2 invalid report.')
  } else if (positionals[0] === 'check' && positionals.length === 2) {
    const report = parseReport(JSON.parse(await readFile(positionals[1], 'utf8')))
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = exitCode(report)
  } else throw new Error('Use orbed check <report.json>')
} catch (error) {
  console.error(String(error))
  process.exitCode = 2
}
