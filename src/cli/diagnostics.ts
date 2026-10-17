import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  bundleMountDiagnosis,
  PLUGIN_NAME,
  silentSkipConsequence,
  type BundleMountReason,
} from './bundle.ts'
import type { SearxngMode } from '../index.ts'
import { profileReadiness } from './bundle.ts'
import type { DockerAdapter, DockerDeploymentStatus, HostPortBinding } from './docker.ts'
import { CliError } from './errors.ts'
import type { EnvironmentService } from './environment.ts'
import { stateSha256, type JournalStore, type OperationJournal, type OperationKind, type OperationPhase } from './journal.ts'
import { bundleDirectory, isStagingDirectoryName, rethrowCancellation, stateIdentity } from './managed.ts'
import type { ProfileAttachmentConfig, ProfileAttachmentPreview, ProfileManager } from './profile.ts'
import type { SearxngProbe } from './searxng.ts'
import type { ManagedIdentity } from './assets.ts'
import type { DeploymentSnapshot, StateStore } from './state.ts'

export interface DiagnosticCheck {
  id: string
  status: 'pass' | 'fail' | 'skip'
  message: string
  error?: ReturnType<CliError['toJSON']>
}

/** Doctor's redacted view of an interrupted operation: digests and ids only, never secrets. */
export interface InterruptedOperationReport {
  id: string
  kind: OperationKind
  phase: OperationPhase
  startedAt: string
  ageMs: number
}

/**
 * One local privacy check. `verified` means the local configuration proves
 * the claim; `exposed` means it contradicts it; `unknown` means missing
 * evidence — never a pass. Local switches are never an end-to-end guarantee;
 * `PrivacyPosture.outOfScope` names what no local check can see.
 */
export interface PrivacyFinding {
  id: string
  status: 'verified' | 'exposed' | 'unknown'
  message: string
}

export interface PrivacyPosture {
  mode: 'managed' | 'external'
  findings: PrivacyFinding[]
  outOfScope: string[]
}

export interface DiagnosticResult {
  profile: string
  mode?: 'managed' | 'external'
  endpoint?: string
  healthy: boolean
  checks: DiagnosticCheck[]
  interruptedOperation?: InterruptedOperationReport
  /** Doctor only: local privacy checks and their explicit limits. */
  privacy?: PrivacyPosture
}

export interface DiagnosticDependencies {
  environment: EnvironmentService
  state: StateStore
  docker: DockerAdapter
  profiles: ProfileManager
  searxng: SearxngProbe
  /** When provided, doctor additionally reports an interrupted operation from the journal. */
  journal?: JournalStore
  now?: () => Date
}

/**
 * Read-only world model consumed by the pure repair planner. Produced by
 * `inspectSnapshot`; digests and IDs only, never secrets. Fields that are
 * unobservable for a condition default to the value that keeps the planner
 * conservative (it blocks on the conditions it can see).
 */
export interface DiagnosticSnapshot {
  profile: string
  /** Authoritative endpoint: the managed deployment's, or the profile entry's for external. */
  expectedEndpoint: string
  stateHash: string
  mode: 'managed' | 'external'
  docker: 'healthy' | 'offline'
  ownership: 'owned' | 'absent' | 'foreign'
  container: 'running' | 'stopped' | 'missing'
  generatedAssets: 'valid' | 'missing' | 'invalid'
  port: 'available' | 'owned' | 'foreign'
  endpoint: 'healthy' | 'unreachable' | 'auth-failed' | 'tls-failed'
  profileEndpoint?: { profile: string; expected: string; actual?: string }
  ownedTemporaryResourceIds: string[]
  interruptedOperation?: OperationJournal
}

/**
 * Bounded sweep for orphaned renderer staging directories: direct children of
 * the managed directory matching the exact `.staging-<pid>-<hex>` shape. The
 * scan never recurses and never leaves the managed directory; any failure to
 * read simply reports no orphans (the same unreadable directory fails the
 * state and bundle probes, which carry the actionable error).
 */
async function listOrphanedStagingDirectories(managedDir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(managedDir)
  } catch {
    return []
  }
  return names.filter(isStagingDirectoryName).sort()
}

export interface AssetProbeInput {
  stateDir: string
  homeId: string
  current: DeploymentSnapshot
  composePath?: string
}

export type AssetProbeStatus = DiagnosticSnapshot['generatedAssets']

export interface SnapshotDependencies extends DiagnosticDependencies {
  journal: JournalStore
  /** Overrides the filesystem bundle probe; production reads the managed directory. */
  probeAssets?(input: AssetProbeInput): Promise<AssetProbeStatus>
}

const EXPECTED_ENVIRONMENT: ReadonlyArray<readonly [string, (input: AssetProbeInput) => string]> = [
  ['DSH_SEARXNG_IMAGE', (input) => input.current.image],
  ['DSH_SEARXNG_PORT', (input) => String(input.current.port)],
  ['DSH_SEARXNG_HOME_ID', (input) => input.homeId],
  ['DSH_SEARXNG_PROJECT', (input) => input.current.projectName],
  ['DSH_SEARXNG_CONTAINER', (input) => input.current.containerName],
]

/**
 * Structural bundle probe: the recorded configuration digest (or the live
 * Compose path for digest-less v1 snapshots) must point at a directory whose
 * `.env` carries the deployment identity and whose Compose and settings files
 * exist. The SearXNG secret itself is never read or compared here.
 */
async function fileAssetProbe(input: AssetProbeInput): Promise<AssetProbeStatus> {
  const bundleDir = bundleDirectory(input.stateDir, input.current, input.composePath)
  if (bundleDir === undefined) return 'missing'
  try {
    await stat(bundleDir)
  } catch {
    return 'missing'
  }
  try {
    const lines = new Set((await readFile(join(bundleDir, '.env'), 'utf8')).split('\n').map((line) => line.trim()))
    for (const [key, value] of EXPECTED_ENVIRONMENT) {
      if (!lines.has(`${key}=${value(input)}`)) return 'invalid'
    }
    for (const path of [join(bundleDir, 'compose.yml'), join(bundleDir, 'searxng', 'settings.yml')]) {
      if (!(await stat(path)).isFile()) return 'invalid'
    }
    return 'valid'
  } catch {
    return 'invalid'
  }
}

/**
 * Collect the repair snapshot for a profile. Read-only: probing never mutates
 * state, Docker resources, or the profile. The state hash pins the snapshot to
 * exactly the state bytes the planner reasoned about.
 */
export async function inspectSnapshot(
  profile: string,
  dependencies: SnapshotDependencies,
  signal?: AbortSignal,
): Promise<DiagnosticSnapshot> {
  signal?.throwIfAborted()
  const environment = await dependencies.environment.resolve(profile)
  const state = await dependencies.state.read()
  const entry = state.profiles[profile]
  if (entry === undefined) throw invalidState(`Profile ${profile} has no recorded SearXNG attachment`)
  const interruptedOperation = await dependencies.journal.read()
  const managed = state.managed
  const expectedEndpoint = entry.mode === 'managed' && managed !== undefined ? managed.current.endpoint : entry.endpoint

  let docker: DiagnosticSnapshot['docker'] = 'healthy'
  let ownership: DiagnosticSnapshot['ownership'] = 'absent'
  let container: DiagnosticSnapshot['container'] = 'missing'
  let generatedAssets: DiagnosticSnapshot['generatedAssets'] = entry.mode === 'external' ? 'valid' : 'missing'
  let port: DiagnosticSnapshot['port'] = 'available'
  let composePath: string | undefined
  let probeEndpoint = true

  if (entry.mode === 'managed') {
    if (managed === undefined) throw invalidState('Managed deployment state is missing')
    try {
      await dependencies.docker.preflight(signal)
    } catch (error) {
      rethrowCancellation(error, signal)
      docker = 'offline'
      probeEndpoint = false
    }
    if (docker === 'healthy') {
      try {
        const status = await dependencies.docker.deploymentStatus(
          stateIdentity(environment.managedDir, state.homeId, managed.current),
          signal,
        )
        ownership = status.ownership
        container = status.container === 'absent' ? 'missing' : status.container
        composePath = status.composePath
        if (ownership === 'foreign') {
          // A reported-foreign deployment is not ours: the container value is
          // untrusted and its endpoint must not be probed as if it were.
          container = 'missing'
          probeEndpoint = false
        }
      } catch (error) {
        rethrowCancellation(error, signal)
        ownership = 'foreign'
        probeEndpoint = false
      }
    }
    generatedAssets = await (dependencies.probeAssets ?? fileAssetProbe)({
      stateDir: environment.managedDir,
      homeId: state.homeId,
      current: managed.current,
      ...(composePath === undefined ? {} : { composePath }),
    })
    if (docker === 'healthy') {
      if (container === 'running') {
        port = 'owned'
      } else {
        try {
          await dependencies.environment.preflightManaged(managed.current.port, signal)
          port = 'available'
        } catch (error) {
          rethrowCancellation(error, signal)
          port = error instanceof CliError && error.code === 'E_PORT_CONFLICT' ? 'foreign' : 'available'
        }
      }
    }
  }

  const { preview } = await observeAttachment(dependencies.profiles, profile, expectedEndpoint, entry.mode, signal)

  const endpointHealth: DiagnosticSnapshot['endpoint'] = probeEndpoint
    ? await probeEndpointHealth(dependencies.searxng, preview?.config ?? { baseURL: expectedEndpoint }, signal)
    : 'unreachable'

  const attached = preview !== undefined && preview.installed && preview.attached

  return {
    profile,
    expectedEndpoint,
    stateHash: stateSha256(state),
    mode: entry.mode,
    docker,
    ownership,
    container,
    generatedAssets,
    port,
    endpoint: endpointHealth,
    ...(attached ? {} : {
      profileEndpoint: {
        profile,
        expected: expectedEndpoint,
        ...(preview?.current !== undefined && preview.current.baseURL !== expectedEndpoint
          ? { actual: preview.current.baseURL }
          : {}),
      },
    }),
    ownedTemporaryResourceIds: await listOrphanedStagingDirectories(environment.managedDir),
    ...(interruptedOperation === undefined ? {} : { interruptedOperation }),
  }
}

function normalized(error: unknown): CliError {
  if (error instanceof CliError) return error
  return new CliError('E_INTERNAL', 'A diagnostic check failed unexpectedly', 'Inspect the check and retry')
}

function invalidState(message: string): CliError {
  return new CliError('E_STATE_INVALID', message, 'Run dsh-searxng setup or repair the recorded attachment')
}

function resourceForeign(): CliError {
  return new CliError(
    'E_RESOURCE_FOREIGN',
    'A same-name Docker resource is not owned by this dsh-searxng installation',
    'Rename or remove the foreign resource, then retry',
  )
}

/**
 * The profile's config row is present but the plugin's bundle layer does not
 * mount the entry it targets. Doctor reports this separately from attachment
 * drift: the row is there and the endpoint answers, yet no provider is
 * registered, so the symptom surfaces only at search time.
 * @param reason - the observed composition reason.
 * @returns the failure to report.
 */
function bundleNotMounted(reason: BundleMountReason): CliError {
  const { message, action } = bundleMountDiagnosis(reason)
  return new CliError(
    'E_PROFILE_BUNDLE_MISSING',
    `${message}; ${silentSkipConsequence()}`,
    action,
    { bundleMount: reason, plugin: PLUGIN_NAME },
  )
}

/**
 * Shared attachment observation used by both `diagnose` and `inspectSnapshot`.
 * `diagnose` previews the profile's recorded endpoint so doctor can report
 * attachment drift; `inspectSnapshot` previews the state-truth endpoint
 * (the managed deployment's) because repair plans against state. The preview
 * call, its error handling, and the effective-config derivation are one
 * pipeline so the two observers cannot drift.
 */
interface AttachmentObservation {
  preview?: ProfileAttachmentPreview
  previewError?: unknown
}

async function observeAttachment(
  profiles: ProfileManager,
  profile: string,
  endpoint: string,
  mode: SearxngMode,
  signal?: AbortSignal,
): Promise<AttachmentObservation> {
  let preview: ProfileAttachmentPreview | undefined
  let previewError: unknown
  try {
    preview = await profiles.preview(profile, endpoint, signal, mode)
  } catch (error) {
    rethrowCancellation(error, signal)
    previewError = error
  }
  return {
    ...(preview === undefined ? {} : { preview }),
    ...(previewError === undefined ? {} : { previewError }),
  }
}

/**
 * Shared endpoint probe chain and classification. Doctor reports each stage
 * as its own check; the snapshot consumes the same chain through this
 * classifier so repair and doctor observe identical probe semantics.
 */
async function probeEndpointHealth(
  searxng: SearxngProbe,
  config: ProfileAttachmentConfig,
  signal?: AbortSignal,
): Promise<DiagnosticSnapshot['endpoint']> {
  try {
    await searxng.http(config, signal)
    await searxng.readiness({ ...config, attempts: 1, timeoutMs: 10_000 }, signal)
    await searxng.realSearch(config, signal)
    return 'healthy'
  } catch (error) {
    rethrowCancellation(error, signal)
    if (error instanceof CliError && error.code === 'E_AUTH_FAILED') return 'auth-failed'
    if (error instanceof CliError && error.code === 'E_TLS_FAILED') return 'tls-failed'
    return 'unreachable'
  }
}

/**
 * Shared end-to-end validation used by repair and update after a mutation:
 * the doctor-shaped HTTP/JSON/real-search/profile/provider chain, returning
 * the passing checks or throwing on the first failure. Both transactions
 * validate through this one pipeline so their post-mutation semantics can
 * never drift.
 */
export async function validateEndToEnd(
  profile: string,
  endpoint: string,
  dependencies: Pick<DiagnosticDependencies, 'profiles' | 'searxng'>,
  signal?: AbortSignal,
  mode: SearxngMode = 'managed',
): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = []
  let preview: ProfileAttachmentPreview | undefined
  try {
    preview = await dependencies.profiles.preview(profile, endpoint, signal, mode)
  } catch (error) {
    rethrowCancellation(error, signal)
    preview = undefined
  }
  const config = preview?.config ?? { baseURL: endpoint }
  // Cold-start gate first: Compose up returns before the service listens, so
  // post-mutation validation may run against a container that still refuses
  // connections. Readiness inherits setup's default retrying budget (no
  // attempts/timeout overrides) and waits for it; the single-shot checks
  // below then run against a warm service, reported in doctor's order.
  await dependencies.searxng.readiness(config, signal)
  await dependencies.searxng.http(config, signal)
  checks.push({ id: 'http', status: 'pass', message: 'SearXNG HTTP endpoint is reachable' })
  checks.push({ id: 'json', status: 'pass', message: 'SearXNG JSON API is enabled' })
  await dependencies.searxng.realSearch(config, signal)
  checks.push({ id: 'search', status: 'pass', message: 'SearXNG returned a real search result' })
  if (preview === undefined || !preview.installed || !preview.attached) {
    throw new CliError('E_SEARCH_FAILED', 'The DSH profile attachment is missing or outdated', 'Re-run dsh-searxng repair')
  }
  checks.push({ id: 'profile', status: 'pass', message: 'DSH profile has the expected managed attachment' })
  await dependencies.profiles.validate(
    profile,
    endpoint,
    async (validated) => { await dependencies.searxng.providerSearch(validated, signal) },
    signal,
  )
  checks.push({ id: 'provider', status: 'pass', message: 'DSH provider search returned a result' })
  return checks
}

/** Coarse human duration for report lines; machine consumers read `ageMs`. */
export function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000))
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

const PRIVACY_OUT_OF_SCOPE_SHARED: readonly string[] = [
  'Upstream search engines receive the queries and log them under their own policies; this CLI cannot verify or control that',
  'Network observers between this host, the instance, and the engines are outside local verification',
]

const PRIVACY_OUT_OF_SCOPE_MANAGED: readonly string[] = [
  ...PRIVACY_OUT_OF_SCOPE_SHARED,
  'Container logs on this host are not configured or verified for query redaction',
]

const PRIVACY_OUT_OF_SCOPE_EXTERNAL: readonly string[] = [
  ...PRIVACY_OUT_OF_SCOPE_SHARED,
  "The remote instance operator's logs and data handling are outside local verification",
]

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1'])

async function loopbackFinding(
  docker: DockerAdapter,
  identity: ManagedIdentity,
  signal?: AbortSignal,
): Promise<PrivacyFinding> {
  if (docker.publishedHostBindings === undefined) {
    return { id: 'loopback-bind', status: 'unknown', message: 'The Docker adapter cannot report published port bindings for this deployment' }
  }
  let bindings: readonly HostPortBinding[]
  try {
    bindings = await docker.publishedHostBindings(identity, signal)
  } catch {
    return { id: 'loopback-bind', status: 'unknown', message: 'Published port bindings could not be read from the running container' }
  }
  if (bindings.length === 0) {
    return { id: 'loopback-bind', status: 'unknown', message: 'The container publishes no ports through Docker' }
  }
  const exposed = [...new Set(bindings.filter((binding) => !LOOPBACK_ADDRESSES.has(binding.hostIp)).map((binding) => binding.hostIp))]
  if (exposed.length === 0) {
    return { id: 'loopback-bind', status: 'verified', message: `Published ports bind to loopback only (${[...new Set(bindings.map((binding) => binding.hostIp))].join(', ')})` }
  }
  return { id: 'loopback-bind', status: 'exposed', message: `Published ports bind to non-loopback interfaces (${exposed.join(', ')})` }
}

async function bundlePermissionFinding(bundleDir: string): Promise<PrivacyFinding> {
  // POSIX permission bits are not enforced on Windows: stat reports a nominal
  // mode regardless of the on-disk ACL, so a check there could only produce
  // false alarms. Missing evidence reads unknown, never a pass or an alarm.
  if (process.platform === 'win32') {
    return { id: 'config-file-permissions', status: 'unknown', message: 'POSIX file permissions are not enforced on Windows; bundle permissions were not checked' }
  }
  const exposed: string[] = []
  try {
    for (const name of [join('searxng', 'settings.yml'), '.env']) {
      const fileMode = (await stat(join(bundleDir, name))).mode & 0o777
      if ((fileMode & 0o077) !== 0) exposed.push(`${name} is ${fileMode.toString(8)}`)
    }
  } catch {
    return { id: 'config-file-permissions', status: 'unknown', message: 'The managed configuration bundle is unavailable for a permission check' }
  }
  return exposed.length === 0
    ? { id: 'config-file-permissions', status: 'verified', message: 'Bundle configuration files are owner-only (0600)' }
    : { id: 'config-file-permissions', status: 'exposed', message: `Bundle configuration is readable beyond the owner: ${exposed.join('; ')}` }
}

async function effectiveLoggingFinding(bundleDir: string): Promise<PrivacyFinding> {
  let parsed: unknown
  try {
    parsed = parseYaml(await readFile(join(bundleDir, 'searxng', 'settings.yml'), 'utf8'))
  } catch {
    return { id: 'effective-logging', status: 'unknown', message: 'The effective settings could not be parsed; logging behavior is unverified' }
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'logging' in (parsed as Record<string, unknown>)) {
    return { id: 'effective-logging', status: 'unknown', message: 'Explicit logging configuration is present in the effective settings; review what it records' }
  }
  return { id: 'effective-logging', status: 'unknown', message: 'No explicit logging configuration in the effective settings; SearXNG defaults apply' }
}

/**
 * Collect the doctor privacy posture. Every finding fails independently to
 * `unknown` — a missing check is never a pass, and the posture never blocks
 * or fails the diagnostic chain.
 */
async function collectPrivacyPosture(input: {
  mode: 'managed' | 'external'
  endpoint: string
  authConfigured: boolean
  bundleDir?: string
  identity?: ManagedIdentity
  docker: DockerAdapter
  signal?: AbortSignal
}): Promise<PrivacyPosture> {
  if (input.mode === 'external') {
    const transport: PrivacyFinding = input.endpoint.startsWith('https://')
      ? { id: 'transport', status: 'verified', message: 'The endpoint uses HTTPS' }
      : { id: 'transport', status: 'exposed', message: 'The endpoint uses plaintext HTTP; traffic is observable on the network path' }
    const auth: PrivacyFinding = input.authConfigured
      ? { id: 'remote-auth', status: 'verified', message: 'An authorization header is configured for the remote instance' }
      : { id: 'remote-auth', status: 'unknown', message: 'No authorization header is configured for the remote instance' }
    return { mode: 'external', findings: [transport, auth], outOfScope: [...PRIVACY_OUT_OF_SCOPE_EXTERNAL] }
  }
  if (input.bundleDir === undefined) {
    return {
      mode: 'managed',
      findings: [
        { id: 'loopback-bind', status: 'unknown', message: 'The managed bundle is unavailable; local privacy checks did not run' },
      ],
      outOfScope: [...PRIVACY_OUT_OF_SCOPE_MANAGED],
    }
  }
  const findings: PrivacyFinding[] = []
  if (input.identity === undefined) {
    findings.push({ id: 'loopback-bind', status: 'unknown', message: 'The managed deployment identity is unavailable; the running bindings were not checked' })
  } else {
    findings.push(await loopbackFinding(input.docker, input.identity, input.signal).catch(() => ({
      id: 'loopback-bind', status: 'unknown', message: 'Published port bindings could not be read from the running container',
    } as PrivacyFinding)))
  }
  findings.push(await bundlePermissionFinding(input.bundleDir).catch(() => ({
    id: 'config-file-permissions', status: 'unknown', message: 'The managed configuration bundle is unavailable for a permission check',
  }) as PrivacyFinding))
  findings.push(await effectiveLoggingFinding(input.bundleDir).catch(() => ({
    id: 'effective-logging', status: 'unknown', message: 'The effective settings could not be parsed; logging behavior is unverified',
  }) as PrivacyFinding))
  return { mode: 'managed', findings, outOfScope: [...PRIVACY_OUT_OF_SCOPE_MANAGED] }
}

/** Human rendering of the privacy posture; the JSON form is the object itself. */
export function formatPrivacyPosture(posture: PrivacyPosture): string {
  return [
    'Privacy posture (local checks only):',
    ...posture.findings.map((finding) => `  ${finding.id}: ${finding.status} — ${finding.message}`),
    '  Out of scope of local checks:',
    ...posture.outOfScope.map((line) => `  - ${line}`),
  ].join('\n')
}

export async function diagnose(
  profile: string,
  kind: 'status' | 'doctor',
  dependencies: DiagnosticDependencies,
  signal?: AbortSignal,
): Promise<DiagnosticResult> {
  const checks: DiagnosticCheck[] = []
  let blocked = false
  const record = async (id: string, message: string, operation: () => Promise<void>): Promise<void> => {
    if (blocked) {
      if (kind === 'doctor') checks.push({ id, status: 'skip', message: 'Skipped because a prerequisite failed' })
      return
    }
    try {
      signal?.throwIfAborted()
      await operation()
      checks.push({ id, status: 'pass', message })
    } catch (error) {
      signal?.throwIfAborted()
      const failure = normalized(error)
      checks.push({ id, status: 'fail', message: failure.message, error: failure.toJSON() })
      blocked = true
    }
  }

  // Doctor reads the journal first: an interrupted operation is the headline
  // finding, reported without secrets (ids, kinds, phases, and age only). A
  // validly recorded interruption fails this check without blocking the rest
  // of the chain — the service may still be healthy and repair decides what
  // happens next — while an unreadable journal means the state directory is
  // untrustworthy and skips everything downstream.
  let interruptedOperation: InterruptedOperationReport | undefined
  if (kind === 'doctor' && dependencies.journal !== undefined) {
    try {
      signal?.throwIfAborted()
      const journal = await dependencies.journal.read()
      if (journal === undefined) {
        checks.push({ id: 'journal', status: 'pass', message: 'No interrupted operation is recorded' })
      } else {
        const now = dependencies.now?.() ?? new Date()
        const ageMs = Math.max(0, now.getTime() - Date.parse(journal.startedAt))
        interruptedOperation = {
          id: journal.id,
          kind: journal.kind,
          phase: journal.phase,
          startedAt: journal.startedAt,
          ageMs,
        }
        const failure = new CliError(
          'E_STATE_INVALID',
          `An interrupted ${journal.kind} operation is recorded in phase ${journal.phase} (started ${formatAge(ageMs)} ago)`,
          'Run dsh-searxng repair to recover the interrupted operation',
        )
        checks.push({ id: 'journal', status: 'fail', message: failure.message, error: failure.toJSON() })
      }
    } catch (error) {
      signal?.throwIfAborted()
      const failure = normalized(error)
      checks.push({ id: 'journal', status: 'fail', message: failure.message, error: failure.toJSON() })
      blocked = true
    }
  }

  let environment: Awaited<ReturnType<EnvironmentService['resolve']>> | undefined
  let state: Awaited<ReturnType<StateStore['read']>> | undefined
  let entry: Awaited<ReturnType<StateStore['read']>>['profiles'][string] | undefined
  await record('environment', 'Environment and attachment state are available', async () => {
    environment = await dependencies.environment.resolve(profile)
    await dependencies.environment.preflightDsh(signal)
    state = await dependencies.state.read()
    entry = state.profiles[profile]
    if (entry === undefined) throw invalidState(`Profile ${profile} has no recorded SearXNG attachment`)
  })
  if (blocked && kind === 'status') return { profile, healthy: false, checks }

  let preview: ProfileAttachmentPreview | undefined
  let previewError: unknown
  if (entry !== undefined) {
    const observation = await observeAttachment(dependencies.profiles, profile, entry.endpoint, entry.mode, signal)
    preview = observation.preview
    previewError = observation.previewError
  }

  // Report the deployment shape in force before anything that depends on it.
  // `mode` decides whether Docker is part of this deployment at all, so it is
  // reported as its own pass line rather than an aside: an operator debugging
  // an external profile needs to see that Docker is out of scope here, not
  // wonder why no Docker checks appeared.
  //
  // The readiness verdict comes from the plugin's own `describeSearxngProfile`
  // rather than being re-derived here, so doctor and the provider can never
  // disagree about what a given config means. `available` is deliberately
  // mode-independent, so the *state* carries the distinction: `managed` with no
  // endpoint is a legitimate pre-provisioning state, while `external` with no
  // endpoint is a genuine misconfiguration.
  if (entry !== undefined) {
    const effective = preview?.config ?? { baseURL: entry.endpoint }
    const readiness = profileReadiness({
      mode: entry.mode,
      baseURL: effective.baseURL,
      ...(preview?.config?.baseURLs === undefined ? {} : { baseURLs: preview.config.baseURLs }),
    })
    const shape = entry.mode === 'managed'
      ? 'managed (this installation owns a Docker SearXNG)'
      : 'external (an existing SearXNG instance; Docker is not used)'
    const detail = readiness === 'awaiting-managed-endpoint'
      ? '; managed mode is selected but no endpoint is written yet, so searches are unavailable until setup completes'
      : readiness === 'no-endpoint'
        ? '; no endpoint is configured, so searches are unavailable until setup records one'
        : readiness === 'invalid-endpoint'
          ? '; the configured endpoint is not a valid HTTP(S) base URL'
          : ''
    checks.push({ id: 'mode', status: 'pass', message: `Deployment mode is ${shape}${detail}` })
  }
  let deployment: DockerDeploymentStatus | undefined
  if (entry?.mode === 'managed') {
    await record('docker', 'Docker and Compose are available', async () => { await dependencies.docker.preflight(signal) })
    if (blocked && kind === 'status') return { profile, mode: entry.mode, endpoint: entry.endpoint, healthy: false, checks }
    await record('ownership', 'Managed Docker resources have valid ownership labels', async () => {
      if (environment === undefined || state?.managed === undefined) throw invalidState('Managed deployment state is missing')
      deployment = await dependencies.docker.deploymentStatus(
        stateIdentity(environment.managedDir, state.homeId, state.managed.current),
        signal,
      )
      if (deployment.ownership === 'foreign') throw resourceForeign()
      if (deployment.ownership !== 'owned') throw invalidState('Managed Docker resources are absent')
    })
    if (blocked && kind === 'status') return { profile, mode: entry.mode, endpoint: entry.endpoint, healthy: false, checks }
    await record('container', 'Managed SearXNG container is running', async () => {
      if (deployment?.container !== 'running') throw invalidState('Managed SearXNG container is not running')
    })
  } else {
    for (const [id, message] of [
      ['docker', 'Skipped for an external SearXNG endpoint'],
      ['ownership', 'Skipped for an external SearXNG endpoint'],
      ['container', 'Skipped for an external SearXNG endpoint'],
    ] as const) checks.push({ id, status: 'skip', message })
  }

  const config = preview?.config ?? (entry === undefined ? undefined : { baseURL: entry.endpoint })
  // The failover pool outranks `baseURL` in the provider's own resolution, so a
  // `baseURL` written by `setup --url` is not the endpoint actually in use while
  // `baseURLs` is set. Report it rather than silently probing the wrong host:
  // the operator set that pool deliberately, so the CLI neither clears nor
  // reorders it, but it must not leave the mismatch invisible either.
  if (preview?.config?.baseURLs !== undefined && preview.config.baseURLs.length > 0) {
    checks.push({
      id: 'endpoint-pool',
      status: 'pass',
      message: `baseURLs is set (${preview.config.baseURLs.length} entr${preview.config.baseURLs.length === 1 ? 'y' : 'ies'}, primary ${preview.config.baseURLs[0]}) and takes precedence over baseURL (${preview.config.baseURL}); searches use the pool until baseURLs is cleared`,
    })
  }
  await record('http', 'SearXNG HTTP endpoint is reachable', async () => {
    if (config === undefined) throw normalized(previewError)
    await dependencies.searxng.http(config, signal)
  })
  await record('json', 'SearXNG JSON API is enabled', async () => {
    if (config === undefined) throw normalized(previewError)
    await dependencies.searxng.readiness({ ...config, attempts: 1, timeoutMs: 10_000 }, signal)
  })
  await record('search', 'SearXNG returned a real search result', async () => {
    if (config === undefined) throw normalized(previewError)
    await dependencies.searxng.realSearch(config, signal)
  })
  await record('profile', 'DSH profile has the expected managed attachment', async () => {
    if (previewError !== undefined) throw previewError
    if (preview === undefined || !preview.installed || !preview.attached) throw invalidState('DSH profile attachment is missing or outdated')
  })
  // The row and the bundle layer are two separate facts, and a profile can have
  // the first without the second — the state a real machine was found in. The
  // loader then drops the row with only a warning, `ctx.web` never sees the
  // provider, and `web.searchProvider: searxng` throws
  // WEB_PROVIDER_CONFIGURED_MISSING at search time. Nothing else in this chain
  // notices, because the row reads as present and the HTTP endpoint is healthy.
  await record('bundle', 'The dsh-searxng bundle layer mounts the provider entry', async () => {
    if (previewError !== undefined) throw previewError
    if (preview === undefined) throw invalidState('The DSH profile could not be inspected')
    if (preview.mount === undefined || preview.mount.composes) return
    // `package-missing` is real and actionable here: the profile lists the
    // bundle but the package is not installed, so the layer is skipped. Only
    // the CLI's write guard treats it as out of scope, because there the
    // install failure is reported with more precision.
    throw bundleNotMounted(preview.mount.reason ?? 'not-enrolled')
  })
  await record('provider', 'DSH provider search returned a result', async () => {
    if (entry === undefined) throw invalidState('Profile attachment state is missing')
    await dependencies.profiles.validate(
      profile,
      entry.endpoint,
      async (validatedConfig) => { await dependencies.searxng.providerSearch(validatedConfig, signal) },
      signal,
    )
  })

  // Privacy posture is supplementary local evidence: it never blocks the
  // chain, and status runs stay lean by design.
  let privacy: PrivacyPosture | undefined
  if (kind === 'doctor' && entry !== undefined) {
    const authConfigured = typeof preview?.config?.authHeader === 'string' && preview.config.authHeader.length > 0
    const managedContext = entry.mode === 'managed' && state?.managed !== undefined && environment !== undefined
      ? {
          bundleDir: bundleDirectory(environment.managedDir, state.managed.current, deployment?.composePath),
          identity: stateIdentity(environment.managedDir, state.homeId, state.managed.current),
        }
      : undefined
    privacy = await collectPrivacyPosture({
      mode: entry.mode,
      endpoint: entry.endpoint,
      authConfigured,
      ...(managedContext === undefined || managedContext.bundleDir === undefined ? {} : { bundleDir: managedContext.bundleDir }),
      ...(managedContext === undefined ? {} : { identity: managedContext.identity }),
      docker: dependencies.docker,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  return {
    profile,
    ...(entry === undefined ? {} : { mode: entry.mode, endpoint: entry.endpoint }),
    healthy: !checks.some((check) => check.status === 'fail'),
    checks,
    ...(interruptedOperation === undefined ? {} : { interruptedOperation }),
    ...(privacy === undefined ? {} : { privacy }),
  }
}
