import { parseArgs } from 'node:util'
import type { SearxngMode } from '../index.ts'

export type CliCommand =
  | { command: 'help' }
  | {
      command: 'setup'
      profile: string
      /**
       * Which deployment shape the operator asked for. Required: `setup` never
       * guesses, because guessing wrong either provisions a container nobody
       * wanted or silently targets an endpoint that does not exist.
       */
      mode: SearxngMode
      url?: string
      port: number
      portExplicit: boolean
      json: boolean
    }
  | {
      command: 'status' | 'doctor' | 'tune'
      profile: string
      json: boolean
    }
  | {
      command: 'repair'
      profile: string
      json: boolean
    }
  | {
      command: 'update'
      profile: string
      deploymentVersion?: number
      json: boolean
    }
  | {
      command: 'remove'
      profile: string
      json: boolean
      service: boolean
      purgeData: boolean
      yes: boolean
    }

const options = {
  profile: { type: 'string' as const },
  port: { type: 'string' as const },
  json: { type: 'boolean' as const },
  url: { type: 'string' as const },
  service: { type: 'boolean' as const },
  'purge-data': { type: 'boolean' as const },
  yes: { type: 'boolean' as const },
  'deployment-version': { type: 'string' as const },
  managed: { type: 'boolean' as const },
  help: { type: 'boolean' as const, short: 'h' },
}

/**
 * The argument error carries its own code so the CLI entry point can report the
 * same precise failure the setup use case reports. A generic usage error would
 * hide the one thing the operator must decide: which deployment shape to use.
 */
export class ArgumentError extends Error {
  readonly code: 'E_USAGE' | 'E_MODE_REQUIRED' | 'E_MODE_MISMATCH'

  constructor(message: string, code: ArgumentError['code'] = 'E_USAGE') {
    super(`Invalid CLI arguments: ${message}`)
    this.name = 'ArgumentError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new ArgumentError(message)
}

function invalidMode(message: string, code: 'E_MODE_REQUIRED' | 'E_MODE_MISMATCH'): never {
  throw new ArgumentError(message, code)
}

/**
 * Validate a profile name against the DSH launcher's own rule. Kept in sync
 * with `assertValidProfile` (and with `resolveProfileDir` in
 * `@deepseek-ai/dsh-app-boot` 0.2.1-rc.2): a name dsh refuses must fail here,
 * before this CLI creates a directory the harness cannot boot.
 * @param value - the `--profile` value, or undefined for the default.
 * @returns the profile name.
 */
function parseProfile(value: string | undefined): string {
  const profile = value ?? 'web'
  if (
    !profile || profile === '.' || profile === '..' || profile === 'node_modules' ||
    profile.includes('/') || profile.includes('\\')
  ) {
    invalid('profile must be a safe name')
  }
  return profile
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8080
  if (!/^\d+$/.test(value)) invalid('port must be an integer')
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) invalid('port must be between 1 and 65535')
  return port
}

function parseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalid('url must be an absolute HTTP(S) URL')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    invalid('url must be an absolute HTTP(S) URL without query, fragment, or credentials')
  }
  return value
}

function parseDeploymentVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) invalid('deployment-version must be an integer')
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 1 || version > 65535) {
    invalid('deployment-version must be between 1 and 65535')
  }
  return version
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true })
  const [command, ...extra] = parsed.positionals
  if (parsed.values.help === true) {
    if (command !== undefined || extra.length > 0 || Object.entries(parsed.values).some(([key, value]) => key !== 'help' && value !== undefined)) {
      invalid('--help cannot be combined with a command or other options')
    }
    return { command: 'help' }
  }
  if (!command || extra.length > 0 || !['setup', 'status', 'doctor', 'tune', 'repair', 'update', 'remove'].includes(command)) {
    invalid('expected one command: setup, status, doctor, tune, repair, update, or remove')
  }
  const cliCommand = command as CliCommand['command']

  if (cliCommand !== 'setup' && parsed.values.port !== undefined) {
    invalid('--port is only supported by setup')
  }
  if (cliCommand !== 'update' && parsed.values['deployment-version'] !== undefined) {
    invalid('--deployment-version is only supported by update')
  }

  const profile = parseProfile(parsed.values.profile)
  const port = parsePort(parsed.values.port)
  const json = parsed.values.json ?? false
  const url = parseUrl(parsed.values.url)
  const service = parsed.values.service ?? false
  const purgeData = parsed.values['purge-data'] ?? false
  const yes = parsed.values.yes ?? false
  const deploymentVersion = parseDeploymentVersion(parsed.values['deployment-version'])

  if (cliCommand !== 'setup' && url !== undefined) invalid('--url is only supported by setup')
  if (cliCommand !== 'setup' && parsed.values.managed !== undefined) invalid('--managed is only supported by setup')
  if (cliCommand !== 'remove' && (service || purgeData || yes)) invalid('remove flags are only supported by remove')
  if (cliCommand === 'remove' && purgeData && !service) invalid('--purge-data requires --service')
  if (cliCommand === 'remove' && yes && !purgeData) invalid('--yes requires --purge-data')

  // `setup` has two mutually exclusive deployment shapes and no default: the
  // managed one provisions a Docker container, which must never happen because
  // the operator omitted a flag. `--url` selects an existing instance;
  // `--managed` explicitly opts into provisioning.
  if (cliCommand === 'setup') {
    const managed = parsed.values.managed ?? false
    if (managed && url !== undefined) {
      invalidMode('--managed and --url select different modes; pass only one', 'E_MODE_MISMATCH')
    }
    if (!managed && url === undefined) {
      invalidMode(
        'setup requires either --url <endpoint> (use an existing SearXNG) or --managed (provision one with Docker); it never deploys SearXNG by itself unless asked',
        'E_MODE_REQUIRED',
      )
    }
  }

  if (cliCommand === 'setup') return {
    command: cliCommand,
    profile,
    mode: parsed.values.managed === true ? 'managed' : 'external',
    ...(url === undefined ? {} : { url }),
    port,
    portExplicit: parsed.values.port !== undefined,
    json,
  }
  if (cliCommand === 'update') return {
    command: cliCommand,
    profile,
    ...(deploymentVersion === undefined ? {} : { deploymentVersion }),
    json,
  }
  if (cliCommand === 'remove') return { command: cliCommand, profile, json, service, purgeData, yes }
  return { command: cliCommand, profile, json }
}
