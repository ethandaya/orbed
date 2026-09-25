import { spawn } from 'node:child_process'
import type { SetupResult } from './report.ts'

const SETUP_OUTPUT_LIMIT = 2 * 1024 * 1024

/** Run setup in its own process group so failure cannot leave mutating descendants behind. */
export function runSetupCommand(command: string, cwd: string, signal: AbortSignal, timeoutMs = 20_000): Promise<SetupResult> {
  return new Promise(resolve => {
    const child = spawn('bash', ['-o', 'pipefail', '-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputSize = 0
    let failure: string | undefined
    let settled = false
    const killGroup = () => {
      if (!child.pid) return
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= String(error)
      }
    }
    const stop = (reason: string) => {
      failure ??= reason
      killGroup()
    }
    const append = (chunks: Buffer[], value: Buffer) => {
      outputSize += value.length
      if (outputSize > SETUP_OUTPUT_LIMIT) stop(`output exceeded ${SETUP_OUTPUT_LIMIT} bytes`)
      else chunks.push(value)
    }
    child.stdout.on('data', value => append(stdout, value))
    child.stderr.on('data', value => append(stderr, value))
    child.on('error', error => { failure ??= String(error) })
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs}ms`), timeoutMs)
    const abort = () => stop(String(signal.reason ?? new Error('orbed suite cancelled')))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve({
        command,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: code ?? undefined,
        error: failure ?? (code === 0 ? undefined : `exited with code ${code}`),
      })
    })
  })
}
