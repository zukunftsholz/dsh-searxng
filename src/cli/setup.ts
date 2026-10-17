import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { SearxngMode } from '../index.ts'
import { type AssetRenderer, type ManagedIdentity, type StagingAssetRenderer } from './assets.ts'
import { selectDeployment, type DeploymentDefinition } from './deployments.ts'
import type { DockerAdapter } from './docker.ts'
import { CliError } from './errors.ts'
import type { EnvironmentService, ResolvedEnvironment } from './environment.ts'
import type { JournalStore, OperationKind } from './journal.ts'
import { canonicalIdentity, bundleComposePath, healthyTimestamp, isAbort } from './managed.ts'
import type { ProfileManager } from './profile.ts'
import type { SearxngProbe } from './searxng.ts'
import type { DeploymentSnapshot, StateStore, StateV2 } from './state.ts'

export interface SetupDependencies {
  environment: EnvironmentService
  state: StateStore
  journal: JournalStore
  docker: DockerAdapter
  assets: StagingAssetRenderer
  searxng: SearxngProbe
  profiles: ProfileManager
  /** Packaged deployment catalog; fresh installs stage its newest state-compatible entry. */
  catalog: readonly DeploymentDefinition[]
  now(): Date
}

export interface SetupInput {
  profile: string
  /**
   * Deployment shape. Required by the use case as well as the argument parser:
   * a caller that omits it must not silently get either branch, because one of
   * them provisions a Docker container.
   */
  mode?: SearxngMode
  port: number
  portExplicit?: boolean
  url?: string
}
export interface SetupResult {
  profile: string
  endpoint: string
  reused: boolean
  mode: SearxngMode
  /**
   * An operational caveat the operator must see even though setup succeeded.
   * Today the only source is a `baseURLs` failover pool outranking the
   * `baseURL` this run just wrote — a silent mismatch otherwise.
   */
  warning?: string
}

interface SetupFactoryOptions { randomSecret?: () => string }

function setupFailed(): CliError {
  return new CliError('E_INTERNAL', 'Setup failed unexpectedly', 'Run dsh-searxng doctor and retry')
}

/**
 * The operator did not say which deployment shape to configure.
 *
 * Deliberately fatal rather than defaulted: the two shapes have opposite
 * consequences — `external` points at an instance that already exists, while
 * `managed` pulls an image and starts a container on the operator's machine.
 * Picking either on the operator's behalf is a decision this CLI must not make,
 * so both roads stay closed until one is named explicitly.
 */
function modeRequired(): CliError {
  return new CliError(
    'E_MODE_REQUIRED',
    'setup needs an explicit deployment mode: it never deploys SearXNG by itself unless asked',
    'Pass --url <endpoint> to use an existing SearXNG, or --managed to provision one with Docker',
    { modes: ['external', 'managed'] },
  )
}

/** The requested mode contradicts the flags the operator supplied. */
function modeMismatch(detail: string): CliError {
  return new CliError(
    'E_MODE_MISMATCH',
    `The requested deployment mode contradicts the supplied options: ${detail}`,
    'Pass --url <endpoint> for an existing SearXNG, or --managed alone to provision one',
  )
}

function inconsistentManagedDeployment(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'Managed deployment state does not match Docker resources',
    'Run dsh-searxng doctor and repair the managed deployment',
  )
}

function managedRecoveryFailed(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'Managed SearXNG is still unhealthy after restart',
    'Run dsh-searxng doctor and repair the managed deployment',
  )
}

/**
 * Recovery for a matching deployment whose readiness timed out. A present but
 * wedged runtime restarts; a runtime whose container is gone (the leftover of
 * `remove --service` without `--purge-data`, or a manual compose down) is
 * recreated from the recorded content-addressed bundle — restarting a
 * nonexistent container is the one shape this deployment state could not
 * previously recover from.
 */
async function recoverUnhealthyRuntime(
  previous: StateV2,
  environment: ResolvedEnvironment,
  identity: ManagedIdentity,
  dependencies: SetupDependencies,
  signal?: AbortSignal,
): Promise<void> {
  const status = await dependencies.docker.deploymentStatus(identity, signal)
  if (status.container !== 'absent') {
    await dependencies.docker.restart(identity, signal)
    return
  }
  const composePath = previous.managed === undefined
    ? undefined
    : bundleComposePath(environment.managedDir, previous.managed.current)
  if (composePath === undefined) throw inconsistentManagedDeployment()
  await dependencies.docker.up({ ...identity, composePath }, signal)
}

function portMigrationRequired(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The requested port differs from the existing managed deployment',
    'Run dsh-searxng doctor and use an explicit repair or migration workflow',
  )
}

/**
 * Setup refuses while any journal is recorded: a journal exists exactly while
 * an operation is between its first mutation and its validated completion,
 * and setup must not silently clear or run around that invariant. Recovery
 * belongs to repair.
 */
function setupInterrupted(kind: OperationKind): CliError {
  return new CliError(
    'E_STATE_INVALID',
    `An interrupted ${kind} operation is recorded in the journal; setup refuses to run until it is recovered`,
    'Run dsh-searxng repair to recover the interrupted operation, then retry setup',
  )
}

function rollbackIncomplete(primary: unknown, rollbackFailures: readonly string[]): CliError {
  const inherited = primary instanceof CliError && Array.isArray(primary.details.rollbackFailures)
    ? primary.details.rollbackFailures.filter((value): value is string => typeof value === 'string')
    : []
  return new CliError(
    'E_INTERNAL',
    'Setup failed and rollback was incomplete',
    'Run dsh-searxng doctor and repair the managed deployment before retrying',
    {
      primaryError: primary instanceof CliError ? primary.code : isAbort(primary) ? 'abort' : 'internal',
      rollbackFailures: [...inherited, ...rollbackFailures],
    },
  )
}

function safeEndpoint(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new CliError('E_USAGE', 'The SearXNG endpoint is invalid', 'Use an absolute HTTP or HTTPS URL') }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new CliError(
      'E_USAGE',
      'The SearXNG endpoint must be a safe HTTP or HTTPS URL',
      'Remove credentials, query parameters, and fragments from the endpoint',
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

function healthyTimestampFor(dependencies: SetupDependencies): string {
  return healthyTimestamp(dependencies.now, setupFailed)
}

function isMatchingManagedState(
  managed: StateV2['managed'],
  homeId: string,
  identity: ManagedIdentity,
  endpoint: string,
  port: number,
  catalog: readonly DeploymentDefinition[],
): boolean {
  return managed !== undefined &&
    homeId === identity.homeId &&
    // The recorded deployment must be one this package still ships: reuse
    // keeps older-but-current catalog entries running (update moves versions),
    // while an unknown version/image means state and resources no longer
    // describe a packaged deployment.
    catalog.some((deployment) =>
      deployment.deploymentVersion === managed.current.deploymentVersion &&
      deployment.image === managed.current.image,
    ) &&
    managed.current.endpoint === endpoint &&
    managed.current.port === port &&
    managed.current.projectName === identity.projectName &&
    managed.current.containerName === identity.containerName
}

function managedState(
  previous: StateV2,
  input: SetupInput,
  endpoint: string,
  identity: ManagedIdentity,
  dependencies: SetupDependencies,
  configurationSha256?: string,
  deployment?: DeploymentDefinition,
): StateV2 {
  const prior = previous.managed?.current
  // Fresh installs take their identity from the staged catalog deployment;
  // every other caller reuses the recorded current deployment.
  const source = deployment ?? prior
  if (source === undefined) throw setupFailed()
  const digest = configurationSha256 ?? prior?.configurationSha256
  const current: DeploymentSnapshot = {
    deploymentVersion: source.deploymentVersion,
    image: source.image,
    endpoint,
    port: input.port,
    projectName: identity.projectName,
    containerName: identity.containerName,
    ...(digest === undefined ? {} : { configurationSha256: digest }),
  }
  return {
    schemaVersion: 2,
    homeId: identity.homeId,
    managed: {
      current,
      lastHealthyAt: healthyTimestampFor(dependencies),
    },
    profiles: { ...previous.profiles, [input.profile]: { mode: 'managed', endpoint } },
  }
}

function externalState(previous: StateV2, input: SetupInput, endpoint: string): StateV2 {
  return {
    schemaVersion: 2,
    homeId: previous.homeId,
    ...(previous.managed === undefined ? {} : { managed: previous.managed }),
    profiles: { ...previous.profiles, [input.profile]: { mode: 'external', endpoint } },
  }
}

function profileStateMatches(previous: StateV2, input: SetupInput, endpoint: string, mode: 'managed' | 'external'): boolean {
  const current = previous.profiles[input.profile]
  return current?.mode === mode && current.endpoint === endpoint
}

async function withStateRestore(
  previous: StateV2,
  dependencies: SetupDependencies,
  operation: (write: (next: StateV2) => Promise<void>) => Promise<void>,
): Promise<void> {
  let stateWriteAttempted = false
  try {
    await operation(async (next) => {
      stateWriteAttempted = true
      await dependencies.state.write(next)
    })
  } catch (primary) {
    if (!stateWriteAttempted) throw primary
    try {
      await dependencies.state.write(previous)
    } catch {
      throw rollbackIncomplete(primary, ['state'])
    }
    throw primary
  }
}

async function attachAndCommit(
  input: SetupInput,
  endpoint: string,
  mode: SearxngMode,
  previous: StateV2,
  next: StateV2,
  dependencies: SetupDependencies,
  signal?: AbortSignal,
): Promise<void> {
  await withStateRestore(previous, dependencies, async (write) => {
    await dependencies.profiles.attach(
      input.profile,
      endpoint,
      async (config) => {
        await dependencies.searxng.providerSearch(config, signal)
        await write(next)
      },
      signal,
      mode,
    )
  })
}

async function validateAndCommit(
  input: SetupInput,
  endpoint: string,
  mode: SearxngMode,
  previous: StateV2,
  next: StateV2,
  dependencies: SetupDependencies,
  signal?: AbortSignal,
): Promise<void> {
  await withStateRestore(previous, dependencies, async (write) => {
    await dependencies.profiles.validate(
      input.profile,
      endpoint,
      async (config) => {
        await dependencies.searxng.providerSearch(config, signal)
        await write(next)
      },
      signal,
      mode,
    )
  })
}

async function cleanupCreatedDeployment(
  identity: ManagedIdentity,
  dependencies: SetupDependencies,
): Promise<string[]> {
  const failures: string[] = []
  let ownership: 'absent' | 'owned' | undefined
  try {
    ownership = await dependencies.docker.inspectOwnership(identity)
  } catch {
    failures.push('docker-ownership')
  }
  if (ownership === 'owned') {
    try { await dependencies.docker.down(identity, true) } catch { failures.push('docker') }
  }
  return failures
}

function isIncompleteRollback(error: unknown): error is CliError {
  return error instanceof CliError &&
    Array.isArray(error.details.rollbackFailures) &&
    error.details.rollbackFailures.length > 0
}

/**
 * The caveat a successful external setup must still surface: when the profile
 * carries a `baseURLs` failover pool, the provider resolves that pool before
 * `baseURL`, so the endpoint this run just recorded is not the one searches use.
 * The pool is never cleared or reordered — it was configured deliberately and
 * silently dropping it would be worse — so the mismatch is reported instead.
 * @param config - the effective profile config after the write.
 * @returns the warning, or undefined when `baseURL` is authoritative.
 */
function endpointPoolWarning(config: { baseURL: string; baseURLs?: readonly string[] }): string | undefined {
  const pool = config.baseURLs
  if (pool === undefined || pool.length === 0) return undefined
  return `baseURLs is set and takes precedence over baseURL: searches use ${JSON.stringify(pool[0])} (the pool's first entry), not the recorded ${JSON.stringify(config.baseURL)}, until baseURLs is cleared`
}

async function externalSetup(
  input: SetupInput,
  endpoint: string,
  previous: StateV2,
  dependencies: SetupDependencies,
  signal?: AbortSignal,
): Promise<SetupResult> {
  const preview = await dependencies.profiles.preview(input.profile, endpoint, signal, 'external')
  await dependencies.searxng.realSearch(preview.config, signal)
  const warning = endpointPoolWarning(preview.config)
  if (preview.attached && profileStateMatches(previous, input, endpoint, 'external')) {
    await dependencies.profiles.validate(
      input.profile,
      endpoint,
      async (config) => { await dependencies.searxng.providerSearch(config, signal) },
      signal,
      'external',
    )
    return {
      profile: input.profile,
      endpoint,
      reused: true,
      mode: 'external',
      ...(warning === undefined ? {} : { warning }),
    }
  }
  const next = externalState(previous, input, endpoint)
  await attachAndCommit(input, endpoint, 'external', previous, next, dependencies, signal)
  return {
    profile: input.profile,
    endpoint,
    reused: false,
    mode: 'external',
    ...(warning === undefined ? {} : { warning }),
  }
}

async function managedSetup(
  input: SetupInput,
  previous: StateV2,
  environment: ResolvedEnvironment,
  dependencies: SetupDependencies,
  randomSecret: () => string,
  signal?: AbortSignal,
): Promise<SetupResult> {
  const endpoint = `http://127.0.0.1:${input.port}`
  const placeholderIdentity = canonicalIdentity(environment.managedDir, environment.homeId)
  // Fresh installs target the newest catalog deployment compatible with the
  // current state schema; the same catalog decides whether an existing
  // deployment can be reused below.
  const deployment = selectDeployment(dependencies.catalog, previous.schemaVersion)

  await dependencies.docker.preflight(signal)
  const ownership = await dependencies.docker.inspectOwnership(placeholderIdentity, signal)
  const hasState = previous.managed !== undefined
  const matching = hasState && ownership === 'owned' &&
    isMatchingManagedState(previous.managed, previous.homeId, placeholderIdentity, endpoint, input.port, dependencies.catalog)

  if ((hasState && !matching) || (!hasState && ownership === 'owned')) {
    throw inconsistentManagedDeployment()
  }

  const preview = await dependencies.profiles.preview(input.profile, endpoint, signal, 'managed')

  if (matching) {
    try {
      await dependencies.searxng.readiness(preview.config, signal)
    } catch (error) {
      if (isAbort(error, signal)) throw error
      if (!(error instanceof CliError) || error.code !== 'E_SEARXNG_START_TIMEOUT') throw error
      await recoverUnhealthyRuntime(previous, environment, placeholderIdentity, dependencies, signal)
      try {
        await dependencies.searxng.readiness(preview.config, signal)
      } catch (recoveryError) {
        if (isAbort(recoveryError, signal)) throw recoveryError
        if (recoveryError instanceof CliError && recoveryError.code !== 'E_SEARXNG_START_TIMEOUT') throw recoveryError
        throw managedRecoveryFailed()
      }
      try {
        await dependencies.searxng.realSearch(preview.config, signal)
      } catch (recoveryError) {
        if (isAbort(recoveryError, signal) || recoveryError instanceof CliError) throw recoveryError
        throw managedRecoveryFailed()
      }
      const next = managedState(previous, input, endpoint, placeholderIdentity, dependencies)
      await attachAndCommit(input, endpoint, 'managed', previous, next, dependencies, signal)
      return { profile: input.profile, endpoint, reused: false, mode: 'managed' }
    }

    await dependencies.searxng.realSearch(preview.config, signal)
    if (preview.attached && profileStateMatches(previous, input, endpoint, 'managed')) {
      await dependencies.profiles.validate(
        input.profile,
        endpoint,
        async (config) => { await dependencies.searxng.providerSearch(config, signal) },
        signal,
        'managed',
      )
      return { profile: input.profile, endpoint, reused: true, mode: 'managed' }
    }
    const next = managedState(previous, input, endpoint, placeholderIdentity, dependencies)
    if (preview.attached) {
      await validateAndCommit(input, endpoint, 'managed', previous, next, dependencies, signal)
    } else {
      await attachAndCommit(input, endpoint, 'managed', previous, next, dependencies, signal)
    }
    return { profile: input.profile, endpoint, reused: true, mode: 'managed' }
  }

  await dependencies.environment.preflightManaged(input.port, signal)
  const staged = await dependencies.assets.stage({
    stateDir: environment.managedDir,
    identity: placeholderIdentity,
    port: input.port,
    secret: randomSecret(),
    definition: deployment,
  })
  const identity = { ...placeholderIdentity, composePath: join(staged.directory, 'compose.yml') }
  try {
    // From this point onward, any resources discovered under this identity may
    // only have been created by this first-setup transaction.
    await dependencies.docker.up(identity, signal)
    await dependencies.searxng.readiness(preview.config, signal)
    await dependencies.searxng.realSearch(preview.config, signal)
    const next = managedState(previous, input, endpoint, identity, dependencies, staged.configurationSha256, staged.definition)
    await attachAndCommit(input, endpoint, 'managed', previous, next, dependencies, signal)
    return { profile: input.profile, endpoint, reused: false, mode: 'managed' }
  } catch (primary) {
    const cleanupFailures = await cleanupCreatedDeployment(identity, dependencies)
    if (cleanupFailures.length > 0) throw rollbackIncomplete(primary, cleanupFailures)
    throw primary
  }
}

export function createSetup(options: SetupFactoryOptions = {}) {
  const randomSecret = options.randomSecret ?? (() => randomBytes(32).toString('hex'))
  return async function setupUseCase(
    input: SetupInput,
    dependencies: SetupDependencies,
    signal?: AbortSignal,
  ): Promise<SetupResult> {
    try {
      // Resolve the deployment mode BEFORE taking the state lock. A setup
      // invoked without a mode must have no side effect whatsoever — including
      // no lock acquisition, which writes a lock file and is observable by a
      // concurrently running operation. The mode decision needs nothing but the
      // input, so there is no reason to hold the lock to make it.
      const mode = resolveMode(input)
      return await dependencies.state.withLock(async () => {
        signal?.throwIfAborted()
        const journal = await dependencies.journal.read()
        if (journal !== undefined) throw setupInterrupted(journal.kind)
        const environment = await dependencies.environment.resolve(input.profile)
        const previous = await dependencies.state.read()
        if (mode === 'external') {
          const endpoint = safeEndpoint(input.url as string)
          await dependencies.environment.preflightDsh(signal)
          return await externalSetup(input, endpoint, previous, dependencies, signal)
        }
        const portExplicit = input.portExplicit ?? true
        let port = input.port
        if (previous.managed !== undefined) {
          if (!portExplicit) port = previous.managed.current.port
          else if (port !== previous.managed.current.port) throw portMigrationRequired()
        }
        await dependencies.environment.preflightDsh(signal)
        return await managedSetup({ ...input, port }, previous, environment, dependencies, randomSecret, signal)
      })
    } catch (error) {
      if (isIncompleteRollback(error)) throw error
      if (signal?.aborted) signal.throwIfAborted()
      if (isAbort(error, signal)) throw error
      if (error instanceof CliError) throw error
      throw setupFailed()
    }
  }
}

/**
 * Decide the deployment shape from the caller's input, or refuse.
 *
 * This is the one place the choice is made, and it never infers a default:
 * `external` requires a target endpoint and `managed` requires the absence of
 * one. The argument parser enforces the same rule for the command line; this
 * guard exists so a programmatic caller cannot reach the Docker path by
 * omission either.
 * @param input - the setup request.
 * @returns the mode to run.
 * @throws {CliError} `E_MODE_REQUIRED` when neither was named, and
 *   `E_MODE_MISMATCH` when the named mode contradicts the supplied endpoint.
 */
export function resolveMode(input: SetupInput): SearxngMode {
  if (input.mode === undefined) throw modeRequired()
  if (input.mode === 'external') {
    if (input.url === undefined) throw modeMismatch('mode "external" needs a --url endpoint to target')
    return 'external'
  }
  if (input.url !== undefined) throw modeMismatch(`mode "managed" provisions its own endpoint and cannot also use ${JSON.stringify(input.url)}`)
  return 'managed'
}

export const setup: (
  input: SetupInput,
  dependencies: SetupDependencies,
  signal?: AbortSignal,
) => Promise<SetupResult> = createSetup()
