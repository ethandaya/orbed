import type { PortalTest } from './index.ts'

let collecting: PortalTest[] | undefined

/** Called by test(); declarations outside a collection are returned but not recorded. */
export function register(test: PortalTest) {
  collecting?.push(test)
}

/** Record every test() call made while load runs. */
export async function collect(load: () => Promise<unknown>): Promise<PortalTest[]> {
  if (collecting) throw new Error('Tests are already being collected')
  const tests: PortalTest[] = []
  collecting = tests
  try { await load() } finally { collecting = undefined }
  return tests
}
