import { createHash } from 'node:crypto'
import { homedir as defaultHomedir } from 'node:os'
import { join, normalize, resolve as resolvePath } from 'node:path'
import type { CommandRunner } from './process.ts'
import { CliError } from './errors.ts'

/**
 * Validate a profile name against the same rule the DSH launcher applies.
 *
 * The set is quoted from `resolveProfileDir` in `@deepseek-ai/dsh-app-boot`
 * (0.2.1-rc.2), which rejects `""`, `.`, `..`, `node_modules`, and any name
 * containing a path separator. Accepting a name dsh itself refuses would let
 * the CLI write a profile directory the harness can never boot, so the check
 * is kept identical rather than merely "safe enough" — `node_modules` in
 * particular is a legal-looking name that would collide with dependency
 * resolution inside `profiles/`.
 * @param profile - the profile name from the command line.
 * @returns the unchanged name.
 * @throws {CliError} `E_PROFILE_INVALID` for every name dsh would reject.
 */
export function assertValidProfile(profile: string): string {
  if (
    !profile || profile === '.' || profile === '..' || profile === 'node_modules' ||
    profile.includes('/') || profile.includes('\\')
  ) {
    throw new CliError('E_PROFILE_INVALID', 'Profile must be a safe name', 'Choose a profile without path separators or dot segments')
  }
  return profile
}

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, homedir: string = defaultHomedir()): string {
  const configured = env.DSH_HOME?.trim()
  if (!configured) return normalize(resolvePath(homedir, '.dsh'))
  const expanded = configured.replace(/^~(?=$|[\\/])/, homedir)
  return normalize(resolvePath(expanded))
}

export function profileDir(dshHome: string, profile: string): string {
  assertValidProfile(profile)
  return join(dshHome, 'profiles', profile)
}

export function managedDir(dshHome: string): string { return join(dshHome, 'dsh-searxng') }

export function homeId(dshHome: string): string {
  return createHash('sha256').update(normalize(resolvePath(dshHome))).digest('hex').slice(0, 16)
}

/**
 * Environment variable naming an explicit `dsh` executable to invoke.
 *
 * The CLI shells out to `dsh plugin --profile <name> add|remove` to manage
 * profile plugins, so it needs a real, invocable CLI. A Desktop installation of
 * DSH carries its CLI inside `resources/app.asar` and puts nothing named `dsh`
 * on `PATH`, which makes the plugin unusable from such a machine even though a
 * perfectly good CLI ships alongside the app. This variable closes that gap
 * without hardcoding any installation path.
 *
 * An empty or whitespace-only value is treated as unset, matching how DSH
 * itself reads `$DSH_HOME`.
 */
export const DSH_BIN_ENV = 'DSH_SEARXNG_DSH_BIN'

/**
 * Guidance for a missing `dsh` executable.
 *
 * Two cases must be distinguishable, so both are named: no CLI installed at
 * all, and a Desktop-only install whose CLI exists but is not on `PATH`. The
 * `@next` tag matters — `latest` is an older line this plugin does not support,
 * so a bare install would leave the operator in a confusing incompatibility.
 */
export const DSH_MISSING_ACTION =
  `Install the dsh CLI on PATH (npm install -g @deepseek-ai/dsh@next), or point ${DSH_BIN_ENV} at an existing dsh executable; a Desktop-only install carries its CLI inside resources/app.asar and exposes no dsh command`

/**
 * Resolve which `dsh` executable to invoke.
 * @param env - the environment to read.
 * @returns the configured executable, or `dsh` to resolve from `PATH`.
 */
export function resolveDshCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DSH_BIN_ENV]?.trim()
  return configured !== undefined && configured.length > 0 ? configured : 'dsh'
}

export interface ResolvedEnvironment { dshHome: string; profileDir: string; managedDir: string; homeId: string }
export interface EnvironmentService {
  resolve(profile: string): Promise<ResolvedEnvironment>
  preflightDsh(signal?: AbortSignal): Promise<void>
  preflightManaged(port: number, signal?: AbortSignal): Promise<void>
}
export interface PortChecker { (port: number, signal?: AbortSignal): Promise<boolean> }
export interface EnvironmentServiceOptions { env?: NodeJS.ProcessEnv; homedir?: string; portChecker: PortChecker; commandRunner: CommandRunner; dshCommand?: string }

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
}

function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  if (isAbortError(error)) throw error
}

export class NodeEnvironmentService implements EnvironmentService {
  private readonly env: NodeJS.ProcessEnv
  private readonly homedir: string
  private readonly portChecker: PortChecker
  private readonly commandRunner: CommandRunner
  private readonly dshCommand: string
  constructor(options: EnvironmentServiceOptions) {
    this.env = options.env ?? process.env
    this.homedir = options.homedir ?? defaultHomedir()
    this.portChecker = options.portChecker
    this.commandRunner = options.commandRunner
    this.dshCommand = options.dshCommand ?? resolveDshCommand(this.env)
  }
  async resolve(profile: string): Promise<ResolvedEnvironment> {
    const dshHome = resolveDshHome(this.env, this.homedir)
    return { dshHome, profileDir: profileDir(dshHome, profile), managedDir: managedDir(dshHome), homeId: homeId(dshHome) }
  }
  async preflightManaged(port: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new CliError('E_USAGE', 'Port must be between 1 and 65535', 'Choose a valid port')
    let available: boolean
    try {
      available = await this.portChecker(port, signal)
      signal?.throwIfAborted()
    } catch (error) {
      rethrowCancellation(error, signal)
      throw new CliError('E_PORT_CONFLICT', 'Unable to verify port availability', 'Choose another port or stop the process using it')
    }
    if (!available) throw new CliError('E_PORT_CONFLICT', `Port ${port} is already in use`, 'Choose another port')
  }
  async preflightDsh(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    try {
      const result = await this.commandRunner.run(this.dshCommand, ['--version'], { signal })
      signal?.throwIfAborted()
      if (result.exitCode !== 0) throw new Error('nonzero')
    } catch (error) {
      rethrowCancellation(error, signal)
      throw new CliError('E_DSH_MISSING', 'The dsh executable is unavailable', DSH_MISSING_ACTION)
    }
  }
}
