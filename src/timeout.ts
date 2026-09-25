/** Bound the caller's wait even if the underlying SDK promise never settles. */
export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    if (signal?.aborted) {
      operation.catch(() => {})
      signal.throwIfAborted()
    }
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
      ...(signal ? [new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error(`${label} cancelled`))
        signal.addEventListener('abort', onAbort, { once: true })
      })] : []),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}
