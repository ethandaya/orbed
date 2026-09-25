import type { Target } from './index.js'

export type Service = { name: string; publicURL?: string; baseURL?: string; port?: number; listening: boolean; health?: { ok: boolean } }
export type PortalURLs = Record<string, string>
export type Database = { service: string; instructions: string }
export type Resources = {
  databases?: Record<string, Database>
  services?: Record<string, { instructions: string }>
}
export type Binding = { target: Target; instructions: string; url?: string }

/** Reject an explicitly cross-origin path before asking the browser to navigate. */
export function portalPathURL(portalURL: string, path: unknown): string {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Navigate requires an absolute application path')
  const portal = new URL(portalURL)
  const destination = new URL(path, portal)
  if (destination.origin !== portal.origin) throw new Error('Navigate cannot leave the declared portal')
  return destination.href
}

/** Bind to Amp's running services; never create or guess a resource. */
export function resolveResource(target: Target, services: Service[], resources: Resources, allowShell: boolean): Binding {
  let name = target.name
  if (target.kind === 'portal' && !name) {
    const portals = services.filter(s => s.publicURL)
    if (portals.length !== 1) throw new Error(`Portal is ambiguous or missing; available: ${portals.map(s => s.name).join(', ') || 'none'}. Use portals.get(name), or ask Amp to configure a portal.`)
    name = portals[0].name
  }
  let guidance = ''
  let serviceName = name
  if (target.kind === 'db') {
    const database = Object.hasOwn(resources.databases ?? {}, name) ? resources.databases![name] : undefined
    if (!database?.service || !database.instructions.trim()) throw new Error(`Database ${name} is not bound to orb setup. Add its existing Amp service and inspection instructions to the plugin's databases bindings.`)
    serviceName = database.service
    guidance = database.instructions
  } else if (target.kind === 'service' && Object.hasOwn(resources.services ?? {}, name)) {
    guidance = resources.services![name].instructions
  }
  const service = services.find(s => s.name === serviceName)
  if (!service || (target.kind === 'portal' && !service.publicURL)) {
    throw new Error(`${target.kind} ${name} is not configured; available: ${services.filter(s => target.kind !== 'portal' || s.publicURL).map(s => s.name).join(', ') || 'none'}. Ask Amp to configure it.`)
  }
  if (!service.listening || service.health?.ok === false) throw new Error(`${target.kind} ${name} is configured but unavailable`)
  if (target.kind !== 'portal' && !allowShell) throw new Error(`${target.kind} ${name} requires allowShell: true for runtime command evidence`)
  return {
    target: { kind: target.kind, name },
    url: target.kind === 'portal' ? service.publicURL : undefined,
    instructions: `Existing Amp service: ${service.name}. ${service.port ? `Local port: ${service.port}.` : ''} ${guidance}`,
  }
}
