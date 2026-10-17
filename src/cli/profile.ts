import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isAlias,
  isMap,
  isNode,
  isSeq,
  parseDocument,
  type Document,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'
import {
  bundleMountDiagnosis,
  inspectBundleMount,
  PLUGIN_SPEC_ENV,
  resolvePluginSpec,
  silentSkipConsequence,
  type BundleMountReason,
  type BundleMountStatus,
} from './bundle.ts'
import type { SearxngMode } from '../index.ts'
import { CliError } from './errors.ts'
import { assertValidProfile, profileDir, resolveDshCommand, resolveDshHome } from './environment.ts'
import type { CommandResult, CommandRunner } from './process.ts'

const DEFAULT_PROFILE = 'web'
const PLUGIN_NAME = 'dsh-searxng'
const TARGET_ID = 'web-search-searxng'
const MANAGED_MARKER = 'dsh-searxng managed attachment'

export interface ProfileManager {
  inspect(profile: string, signal?: AbortSignal): Promise<{ installed: boolean; patchPath: string }>
  preview(
    profile: string,
    endpoint: string,
    signal?: AbortSignal,
    mode?: SearxngMode,
  ): Promise<ProfileAttachmentPreview>
  validate(
    profile: string,
    endpoint: string,
    callback: (config: ProfileAttachmentConfig) => Promise<void>,
    signal?: AbortSignal,
    mode?: SearxngMode,
  ): Promise<void>
  attach(
    profile: string,
    endpoint: string,
    validate: (config: ProfileAttachmentConfig) => Promise<void>,
    signal?: AbortSignal,
    mode?: SearxngMode,
  ): Promise<void>
  detach(profile: string, signal?: AbortSignal): Promise<void>
  uninstall(profile: string, signal?: AbortSignal): Promise<void>
}

export interface ProfileAttachmentConfig {
  baseURL: string
  /**
   * Which deployment shape the profile describes. Written explicitly so the
   * profile is self-describing rather than relying on the plugin schema's
   * default, and so `doctor`/`remove` can act on the recorded intent.
   */
  mode?: SearxngMode
  /** Failover pool. Preserved verbatim: the CLI never reorders or clears it. */
  baseURLs?: string[]
  language?: string
  engines?: string
  categories?: string
  authHeader?: string
}

export interface ProfileAttachmentPreview {
  installed: boolean
  attached: boolean
  config: ProfileAttachmentConfig
  /** Effective config of the currently recorded target patch, when one is readable. */
  current?: ProfileAttachmentConfig
  /**
   * Whether the plugin's bundle layer actually inserts the target entry, so the
   * profile's config row resolves instead of being silently skipped. Absent
   * when the profile could not be inspected far enough to decide.
   */
  mount?: BundleMountStatus
}

export interface ProfileFileSystem {
  readFile: typeof fs.readFile
  lstat: typeof fs.lstat
  mkdir: typeof fs.mkdir
  open: typeof fs.open
  rename: typeof fs.rename
  unlink: typeof fs.unlink
}

export interface NodeProfileManagerOptions {
  commandRunner: CommandRunner
  dshHome?: string
  resolveDshHome?: () => string
  resolveProfileDirectory?: (profile: string) => string
  fileSystem?: ProfileFileSystem
  randomId?: () => string
  platform?: NodeJS.Platform
  dshCommand?: string
  /**
   * Package spec `setup` installs when the plugin is absent. Defaults to this
   * package pinned to its own installed version; `DSH_SEARXNG_PLUGIN_SPEC`
   * overrides it verbatim, and a caller may inject one directly (tests do).
   */
  pluginSpec?: string
}

const nodeFileSystem: ProfileFileSystem = {
  readFile: fs.readFile,
  lstat: fs.lstat,
  mkdir: fs.mkdir,
  open: fs.open,
  rename: fs.rename,
  unlink: fs.unlink,
}

type FailureStage = 'install' | 'write' | 'validation' | 'detach'

class OperationFailure extends Error {
  readonly stage: FailureStage
  constructor(stage: FailureStage) {
    super(stage)
    this.stage = stage
  }
}

class ProfileConflictError extends Error {
  constructor() {
    super('profile-conflict')
    this.name = 'ProfileConflictError'
  }
}

class CommittedWriteError extends Error {
  readonly committed: PatchSnapshot
  constructor(committed: PatchSnapshot) {
    super('committed-write-finalization-failed')
    this.name = 'CommittedWriteError'
    this.committed = committed
  }
}

interface FileIdentity {
  readonly device: number | bigint
  readonly inode: number | bigint
  readonly size: number | bigint
  readonly modifiedMs: number | bigint
  readonly changedMs: number | bigint
}

interface PatchSnapshot {
  readonly exists: boolean
  readonly bytes?: Buffer
  readonly identity?: FileIdentity
}

interface ParsedPatch {
  readonly document: Document<Node, true>
  readonly sequence: YAMLSeq<Node>
}

function ioCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function profileWriteError(
  message = 'Unable to update the DSH profile',
  details: Record<string, unknown> = {},
  action = 'Check the DSH profile and retry',
): CliError {
  return new CliError(
    'E_PROFILE_WRITE',
    message,
    action,
    details,
  )
}

function concurrentProfileModification(): CliError {
  return new CliError(
    'E_PROFILE_CONCURRENT_MODIFICATION',
    'The DSH profile changed during validation',
    'Review the profile change and retry setup',
  )
}

/**
 * The profile is installed and configured, but its bundle layer does not
 * actually mount the provider: the config row resolves to nothing and a
 * configured `web.searchProvider: searxng` fails at search time. This is a
 * distinct, actionable state, so it gets its own code instead of a generic
 * `E_PROFILE_WRITE`. It is raised before the patch file is touched, so the
 * rollback path must report it verbatim rather than folding it into a write
 * failure — hence a dedicated class.
 */
class BundleMountError extends CliError {
  constructor(reason: BundleMountReason, pluginName = PLUGIN_NAME) {
    const { message, action } = bundleMountDiagnosis(reason, pluginName)
    super(
      'E_PROFILE_BUNDLE_MISSING',
      `${message}; ${silentSkipConsequence()}`,
      action,
      { bundleMount: reason, plugin: pluginName },
    )
    this.name = 'BundleMountError'
  }
}

/**
 * Classify a failed `dsh plugin add`.
 *
 * A bare "install failed" hides the one thing the operator can fix. The plugin
 * manager refuses a package whose declared harness requirements the running DSH
 * does not satisfy, and its diagnostic names the offending package and version.
 * That case is separately actionable — the spec resolved to an incompatible
 * release, usually because the registry serves an older `latest` than the one
 * asked for — so it gets `E_PLUGIN_INSTALL_FAILED` with the registry remedy.
 * Every other failure stays a plain install failure so the rollback path keeps
 * classifying it as a process error.
 * @param result - the completed command result.
 * @param spec - the spec that was requested, for the message.
 * @returns the failure to report.
 */
function installRejected(result: CommandResult, spec: string): Error {
  const output = `${result.stdout}\n${result.stderr}`
  const incompatible = /is incompatible with dsh/i.test(output)
  if (!incompatible) return new OperationFailure('install')
  // Quote the manager's own rejection lines: they name the exact requirement
  // that failed, which is more precise than anything this CLI could paraphrase.
  // The requirement object sits on the line AFTER the "incompatible" sentence,
  // so matching only the keywords would drop the detail that matters most.
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const start = lines.findIndex((line) => /is incompatible with dsh/i.test(line))
  const detail = (start === -1
    ? lines.filter((line) => /installation rejected|nothing was installed/i.test(line))
    : lines.slice(start, start + 2))
    .map((line) => line.replace(/^dsh:\s*/, ''))
    .join(' ')
    .trim()
  return new CliError(
    'E_PLUGIN_INSTALL_FAILED',
    `dsh plugin add ${spec} was refused because that package is incompatible with this dsh runtime${detail.length === 0 ? '' : `: ${detail}`}`,
    `Install a dsh-searxng release compatible with this dsh runtime, or set ${PLUGIN_SPEC_ENV} to an explicit spec (a version, dist-tag, git URL, or packed tarball path)`,
    { spec, incompatible: true },
  )
}

function cancellationFrom(error: unknown, signal?: AbortSignal): unknown | undefined {
  if (signal?.aborted) return signal.reason ?? error
  if (error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return error
  return undefined
}

function primaryErrorClass(error: unknown, stage: FailureStage, signal?: AbortSignal): string {
  if (cancellationFrom(error, signal) !== undefined) return 'abort'
  if (error instanceof CliError) return error.code
  if (error instanceof ProfileConflictError) return 'profile-conflict'
  if (error instanceof OperationFailure) return 'process'
  if (stage === 'install') return 'process'
  if (stage === 'write' || stage === 'detach') return 'filesystem'
  return 'unknown'
}

function fileIdentity(stat: Awaited<ReturnType<typeof fs.lstat>>): FileIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    changedMs: stat.ctimeMs,
  }
}

function sameIdentity(left?: FileIdentity, right?: FileIdentity): boolean {
  return left !== undefined && right !== undefined &&
    left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.modifiedMs === right.modifiedMs && left.changedMs === right.changedMs
}

function sameFileAcrossRename(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.modifiedMs === right.modifiedMs
}

function sameSnapshot(left: PatchSnapshot, right: PatchSnapshot): boolean {
  if (left.exists !== right.exists) return false
  if (!left.exists) return true
  return left.bytes !== undefined && right.bytes !== undefined &&
    left.bytes.equals(right.bytes) && sameIdentity(left.identity, right.identity)
}

function sameBytes(snapshot: PatchSnapshot, bytes: Buffer): boolean {
  return snapshot.exists && snapshot.bytes !== undefined && snapshot.bytes.equals(bytes)
}

function resolvedProfileName(profile: string): string {
  const name = profile || DEFAULT_PROFILE
  return assertValidProfile(name)
}

function normalizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) throw new Error('unsafe')
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    throw profileWriteError('The SearXNG endpoint is invalid')
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function installedFromManifest(value: unknown): boolean {
  if (!isPlainRecord(value)) throw profileWriteError('The DSH profile manifest is invalid')

  let dependencyInstalled = false
  if (value.dependencies !== undefined) {
    if (!isPlainRecord(value.dependencies)) throw profileWriteError('The DSH profile manifest is invalid')
    for (const version of Object.values(value.dependencies)) {
      if (typeof version !== 'string') throw profileWriteError('The DSH profile manifest is invalid')
    }
    dependencyInstalled = Object.hasOwn(value.dependencies, PLUGIN_NAME)
  }

  let bundleInstalled = false
  if (value.dsh !== undefined) {
    if (!isPlainRecord(value.dsh)) throw profileWriteError('The DSH profile manifest is invalid')
    if (value.dsh.profile !== undefined) {
      if (!isPlainRecord(value.dsh.profile)) throw profileWriteError('The DSH profile manifest is invalid')
      if (value.dsh.profile.bundles !== undefined) {
        if (!Array.isArray(value.dsh.profile.bundles) || value.dsh.profile.bundles.some((item) => typeof item !== 'string')) {
          throw profileWriteError('The DSH profile manifest is invalid')
        }
        bundleInstalled = value.dsh.profile.bundles.includes(PLUGIN_NAME)
      }
    }
  }
  return dependencyInstalled || bundleInstalled
}

/**
 * The profile manifest's current `dsh.profile.bundles` list.
 * @param value - the parsed manifest.
 * @returns the bundle names; empty when the field is absent.
 * @throws when the field exists but is not a list of strings.
 */
function bundlesFromManifest(value: unknown): string[] {
  if (!isPlainRecord(value)) throw profileWriteError('The DSH profile manifest is invalid')
  if (value.dsh === undefined) return []
  if (!isPlainRecord(value.dsh)) throw profileWriteError('The DSH profile manifest is invalid')
  if (value.dsh.profile === undefined) return []
  if (!isPlainRecord(value.dsh.profile)) throw profileWriteError('The DSH profile manifest is invalid')
  const bundles = value.dsh.profile.bundles
  if (bundles === undefined) return []
  if (!Array.isArray(bundles) || bundles.some((item) => typeof item !== 'string')) {
    throw profileWriteError('The DSH profile manifest is invalid')
  }
  return [...bundles]
}

/**
 * Append `name` to a manifest's `dsh.profile.bundles`, preserving every other
 * field verbatim. Returns the manifest unchanged when the name is already
 * enrolled, so a repeat run is a no-op.
 * @param value - the parsed manifest.
 * @param name - the bundle to enroll.
 * @returns the updated manifest, or undefined when no change is needed.
 */
function withEnrolledBundle(value: unknown, name: string): Record<string, unknown> | undefined {
  const bundles = bundlesFromManifest(value)
  if (bundles.includes(name)) return undefined
  if (!isPlainRecord(value)) throw profileWriteError('The DSH profile manifest is invalid')
  const dsh = value.dsh === undefined ? {} : value.dsh
  if (!isPlainRecord(dsh)) throw profileWriteError('The DSH profile manifest is invalid')
  const profile = dsh.profile === undefined ? {} : dsh.profile
  if (!isPlainRecord(profile)) throw profileWriteError('The DSH profile manifest is invalid')
  return { ...value, dsh: { ...dsh, profile: { ...profile, bundles: [...bundles, name] } } }
}

function hasManagedMarker(node: YAMLMap<unknown, unknown>): boolean {
  return (node.commentBefore ?? '')
    .split('\n')
    .some((line) => line.trim() === MANAGED_MARKER)
}

function isTargetPatch(node: Node): node is YAMLMap<unknown, unknown> {
  return isMap(node) && node.get('id') === TARGET_ID
}

function isManagedPatch(node: Node): node is YAMLMap<unknown, unknown> {
  return isTargetPatch(node) && hasManagedMarker(node)
}

function containsAnchorOrAlias(value: unknown): boolean {
  if (!isNode(value)) return false
  if (isAlias(value)) return true
  if ('anchor' in value && typeof value.anchor === 'string' && value.anchor.length > 0) return true
  if (isMap(value)) {
    return value.items.some((pair) => containsAnchorOrAlias(pair.key) || containsAnchorOrAlias(pair.value))
  }
  if (isSeq(value)) return value.items.some((item) => containsAnchorOrAlias(item))
  return false
}

function parsePatch(bytes: Buffer): ParsedPatch {
  let document: Document<Node, true>
  try {
    document = parseDocument(bytes.toString('utf8')) as Document<Node, true>
  } catch {
    throw profileWriteError('The DSH profile patch is invalid')
  }
  if (document.errors.length > 0 || !isSeq(document.contents)) {
    throw profileWriteError('The DSH profile patch must be a YAML sequence')
  }
  return { document, sequence: document.contents as YAMLSeq<Node> }
}

function configOf(
  document: Document<Node, true>,
  patch: YAMLMap<unknown, unknown>,
): YAMLMap<unknown, unknown> {
  const config = patch.get('config', true)
  if (config === undefined) return document.createNode({}) as YAMLMap<unknown, unknown>
  if (!isMap(config)) throw profileWriteError('The target DSH profile config is invalid')
  if (containsAnchorOrAlias(config)) {
    throw profileWriteError('The target DSH profile config contains an unsafe YAML anchor or alias')
  }
  return config.clone() as YAMLMap<unknown, unknown>
}

function providerConfig(config: YAMLMap<unknown, unknown>, endpoint?: string): ProfileAttachmentConfig {
  let value: unknown
  try { value = config.toJSON() } catch { throw profileWriteError('The target DSH profile config is invalid') }
  if (!isPlainRecord(value)) throw profileWriteError('The target DSH profile config is invalid')
  const configuredBaseURL = endpoint ?? value.baseURL
  if (typeof configuredBaseURL !== 'string') throw profileWriteError('The target DSH profile config has no valid SearXNG endpoint')
  const result: ProfileAttachmentConfig = { baseURL: normalizeEndpoint(configuredBaseURL) }
  // `mode` is read back so a caller can report the recorded intent. A value the
  // plugin schema would reject is treated as a malformed profile rather than
  // silently coerced to a default, because the two modes have opposite
  // consequences for whether Docker may be touched.
  const mode = value.mode
  if (mode !== undefined) {
    if (mode !== 'external' && mode !== 'managed') {
      throw profileWriteError('The target DSH profile mode config is invalid')
    }
    result.mode = mode
  }
  const baseURLs = value.baseURLs
  if (baseURLs !== undefined) {
    if (!Array.isArray(baseURLs) || baseURLs.some((entry) => typeof entry !== 'string')) {
      throw profileWriteError('The target DSH profile baseURLs config is invalid')
    }
    result.baseURLs = [...baseURLs] as string[]
  }
  for (const key of ['language', 'engines', 'categories', 'authHeader'] as const) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== 'string') throw profileWriteError(`The target DSH profile ${key} config is invalid`)
    result[key] = field
  }
  return result
}

function cloneProviderConfig(config: ProfileAttachmentConfig): ProfileAttachmentConfig {
  return { ...config }
}

function lastTarget(parsed: ParsedPatch): YAMLMap<unknown, unknown> | undefined {
  let target: YAMLMap<unknown, unknown> | undefined
  for (const item of parsed.sequence.items) if (isTargetPatch(item)) target = item
  return target
}

function configFromAttachment(bytes: Buffer): ProfileAttachmentConfig {
  const parsed = parsePatch(bytes)
  const target = lastTarget(parsed)
  if (target === undefined) throw profileWriteError('The managed DSH profile attachment is missing')
  return providerConfig(configOf(parsed.document, target))
}

function isCurrentManagedAttachment(
  parsed: ParsedPatch,
  endpoint: string,
  mode: SearxngMode,
): boolean {
  const managed = parsed.sequence.items.filter(isManagedPatch)
  const target = lastTarget(parsed)
  if (managed.length !== 1 || target === undefined || !isManagedPatch(target)) return false
  const config = providerConfig(configOf(parsed.document, target))
  // The mode is part of the attachment's identity: a profile that targets the
  // right endpoint but records the wrong shape would send `doctor` and
  // `remove --service` down the wrong branch, so it reads as not attached.
  return config.baseURL === endpoint && (config.mode ?? 'external') === mode
}

function serializePatch(document: Document<Node, true>): Buffer {
  try {
    const source = document.toString()
    const reparsed = parseDocument(source)
    if (reparsed.errors.length > 0 || !isSeq(reparsed.contents)) throw new Error('invalid serialization')
    reparsed.toJS({ maxAliasCount: 100 })
    return Buffer.from(source)
  } catch {
    throw profileWriteError('The DSH profile patch cannot be serialized safely')
  }
}

function renderAttachment(
  parsed: ParsedPatch,
  endpoint: string,
  mode: SearxngMode,
): Buffer {
  const { document, sequence } = parsed
  let lastEffectiveConfig: YAMLMap<unknown, unknown> | undefined
  const retained: Node[] = []

  for (const item of sequence.items) {
    if (isManagedPatch(item) && containsAnchorOrAlias(item)) {
      throw profileWriteError('The managed DSH profile patch contains an unsafe YAML anchor or alias')
    }
    if (isTargetPatch(item)) lastEffectiveConfig = configOf(document, item)
    if (isManagedPatch(item)) {
      continue
    }
    retained.push(item)
  }

  const config = lastEffectiveConfig ?? document.createNode({}) as YAMLMap<unknown, unknown>
  config.set('baseURL', endpoint)
  // Written explicitly rather than left to the schema default: the profile
  // records which shape the operator chose, so `doctor`, `remove --service` and
  // the settings page all read the same intent instead of inferring it. Every
  // other key (notably a `baseURLs` failover pool) is carried through untouched.
  config.set('mode', mode)
  const managed = document.createNode({ id: TARGET_ID }) as YAMLMap<unknown, unknown>
  if (!isMap(managed)) throw profileWriteError()
  managed.set('config', config)
  managed.commentBefore = ` ${MANAGED_MARKER}`
  sequence.items = [...retained, managed]
  // Force block style. A profile initialized from the shipped template starts
  // as the flow sequence `[]`, and appending to a flow sequence makes the whole
  // document serialize as `[{ id: ..., config: { ... } }]` — valid YAML, but
  // nothing like the block shape every DSH profile and the shipped template
  // use, and unreadable once a config carries more than a couple of keys. The
  // entry list is the one place the CLI must match the harness's own shape.
  sequence.flow = false
  if (isMap(config)) config.flow = false
  return serializePatch(document)
}

function renderDetachment(parsed: ParsedPatch): Buffer | undefined {
  for (const item of parsed.sequence.items) {
    if (isManagedPatch(item) && containsAnchorOrAlias(item)) {
      throw profileWriteError('The managed DSH profile patch contains an unsafe YAML anchor or alias')
    }
  }
  const retained = parsed.sequence.items.filter((item) => !isManagedPatch(item))
  if (retained.length === parsed.sequence.items.length) return undefined
  parsed.sequence.items = retained
  return serializePatch(parsed.document)
}

export class NodeProfileManager implements ProfileManager {
  private readonly commandRunner: CommandRunner
  private readonly resolveProfileDirectory: (profile: string) => string
  private readonly fileSystem: ProfileFileSystem
  private readonly randomId: () => string
  private readonly platform: NodeJS.Platform
  private readonly dshCommand: string
  private readonly pluginSpec: string

  constructor(options: NodeProfileManagerOptions) {
    this.commandRunner = options.commandRunner
    const homeResolver = options.resolveDshHome ?? (() => options.dshHome ?? resolveDshHome())
    this.resolveProfileDirectory = options.resolveProfileDirectory
      ?? ((profile) => profileDir(homeResolver(), profile))
    this.fileSystem = options.fileSystem ?? nodeFileSystem
    this.randomId = options.randomId ?? (() => `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    this.platform = options.platform ?? process.platform
    // Honour DSH_SEARXNG_DSH_BIN directly too: a caller that constructs this
    // manager without threading an env (the CLI does thread it) must still get
    // the override, because a Desktop-only install has no dsh on PATH.
    this.dshCommand = options.dshCommand ?? resolveDshCommand()
    // Same rationale for the install spec: pinning to this package's own version
    // must not depend on the caller remembering to pass it.
    this.pluginSpec = options.pluginSpec ?? resolvePluginSpec()
  }

  async inspect(profile: string, signal?: AbortSignal): Promise<{ installed: boolean; patchPath: string }> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const dir = this.resolveProfileDirectory(name)
    const patchPath = join(dir, 'cordis.patch.yml')
    const installed = await this.readInstalled(join(dir, 'package.json'))
    signal?.throwIfAborted()
    return { installed, patchPath }
  }

  async preview(
    profile: string,
    endpoint: string,
    signal?: AbortSignal,
    mode: SearxngMode = 'external',
  ): Promise<ProfileAttachmentPreview> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const dir = this.resolveProfileDirectory(name)
    const installed = await this.readInstalled(join(dir, 'package.json'))
    const snapshot = await this.readPatchSnapshot(join(dir, 'cordis.patch.yml'))
    const source = snapshot.bytes ?? Buffer.from('[]\n')
    const current = parsePatch(source)
    const attached = installed && isCurrentManagedAttachment(current, normalizedEndpoint, mode)
    const output = renderAttachment(parsePatch(source), normalizedEndpoint, mode)
    let currentConfig: ProfileAttachmentConfig | undefined
    try { currentConfig = cloneProviderConfig(configFromAttachment(source)) } catch { currentConfig = undefined }
    const mount = await this.readBundleMount(dir)
    signal?.throwIfAborted()
    return {
      installed,
      attached,
      config: cloneProviderConfig(configFromAttachment(output)),
      ...(currentConfig === undefined ? {} : { current: currentConfig }),
      ...(mount === undefined ? {} : { mount }),
    }
  }

  async validate(
    profile: string,
    endpoint: string,
    callback: (config: ProfileAttachmentConfig) => Promise<void>,
    signal?: AbortSignal,
    mode: SearxngMode = 'external',
  ): Promise<void> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const dir = this.resolveProfileDirectory(name)
    const manifestPath = join(dir, 'package.json')
    let manifestSnapshot: PatchSnapshot
    let snapshot: PatchSnapshot
    try {
      manifestSnapshot = await this.readManifestSnapshot(manifestPath)
      snapshot = await this.readPatchSnapshot(join(dir, 'cordis.patch.yml'))
    } catch (error) {
      if (error instanceof ProfileConflictError) throw concurrentProfileModification()
      throw error
    }
    if (
      manifestSnapshot.bytes === undefined ||
      !this.installedFromManifestSnapshot(manifestSnapshot) ||
      snapshot.bytes === undefined
    ) throw concurrentProfileModification()
    const parsed = parsePatch(snapshot.bytes)
    if (!isCurrentManagedAttachment(parsed, normalizedEndpoint, mode)) throw concurrentProfileModification()
    const target = lastTarget(parsed)
    if (target === undefined) throw concurrentProfileModification()
    const config = cloneProviderConfig(providerConfig(configOf(parsed.document, target)))

    let callbackFailed = false
    let callbackError: unknown
    try {
      await callback(config)
    } catch (error) {
      callbackFailed = true
      callbackError = error
    }

    let unchanged = false
    try {
      const manifestAfter = await this.readManifestSnapshot(manifestPath)
      const after = await this.readPatchSnapshot(join(dir, 'cordis.patch.yml'))
      unchanged = sameSnapshot(manifestSnapshot, manifestAfter) &&
        sameSnapshot(snapshot, after) &&
        manifestAfter.bytes !== undefined &&
        this.installedFromManifestSnapshot(manifestAfter)
    } catch {
      unchanged = false
    }
    if (!unchanged) throw concurrentProfileModification()
    if (callbackFailed) throw callbackError
    signal?.throwIfAborted()
  }

  async attach(
    profile: string,
    endpoint: string,
    validate: (config: ProfileAttachmentConfig) => Promise<void>,
    signal?: AbortSignal,
    mode: SearxngMode = 'external',
  ): Promise<void> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const dir = this.resolveProfileDirectory(name)
    const packagePath = join(dir, 'package.json')
    const patchPath = join(dir, 'cordis.patch.yml')
    let manifestBefore: PatchSnapshot
    try {
      manifestBefore = await this.readManifestSnapshot(packagePath)
    } catch (error) {
      if (error instanceof ProfileConflictError) throw concurrentProfileModification()
      throw error
    }
    const installedBefore = this.installedFromManifestSnapshot(manifestBefore)
    let manifestBaseline = manifestBefore
    let original: PatchSnapshot
    try {
      original = await this.readPatchSnapshot(patchPath)
    } catch (error) {
      if (error instanceof ProfileConflictError) {
        throw profileWriteError(
          'The DSH profile changed while it was being read',
          { primaryFailure: 'write', primaryError: 'profile-conflict', rollbackFailures: [] },
        )
      }
      throw error
    }
    if (original.bytes !== undefined) {
      renderAttachment(parsePatch(original.bytes), normalizedEndpoint, mode)
    }
    let pluginAdded = false
    let pluginResidualPossible = false
    let deferredAddError: unknown
    let writeAttempted = false
    let rollbackExpected: PatchSnapshot | undefined
    let output: Buffer | undefined
    let failureStage: FailureStage = 'install'
    let rollbackTarget = original
    let restoreRollbackTargetAllowed = true

    try {
      if (!installedBefore) {
        failureStage = 'install'
        const beforeAdd = await this.readManifestSnapshot(packagePath)
        if (!sameSnapshot(manifestBefore, beforeAdd) || this.installedFromManifestSnapshot(beforeAdd)) {
          throw concurrentProfileModification()
        }
        let addError: unknown
        try {
          await this.addPlugin(name, signal)
        } catch (error) {
          addError = error
        }
        let afterAdd: PatchSnapshot
        try {
          afterAdd = await this.readManifestSnapshot(packagePath)
        } catch {
          pluginResidualPossible = true
          throw concurrentProfileModification()
        }
        if (!this.installedFromManifestSnapshot(afterAdd)) {
          if (!sameSnapshot(beforeAdd, afterAdd)) {
            throw concurrentProfileModification()
          }
          if (addError !== undefined) throw addError
          throw new OperationFailure('install')
        }
        pluginAdded = true
        pluginResidualPossible = true
        manifestBaseline = afterAdd
        deferredAddError = addError
      }

      // Enrol the bundle layer BEFORE writing the config row. The row is a
      // non-insert patch: the loader resolves it by id against entries that
      // already exist, and the only thing that creates this entry is the
      // plugin's own bundle layer, applied because the profile lists the
      // package in `dsh.profile.bundles`. Without enrolment the row is dropped
      // with a loader warning and the provider never registers. This is the
      // state a real profile was found in, so it is repaired and then proved,
      // never assumed: `dsh plugin add` normally enrols the bundle itself, but
      // a hand-edited manifest can remove it and nothing fails until a search.
      const enrolled = await this.ensureBundleEnrolled(packagePath, manifestBaseline, signal)
      if (enrolled !== undefined) {
        manifestBaseline = enrolled
      }
      await this.requireBundleMount(dir, packagePath, manifestBaseline)

      signal?.throwIfAborted()
      const renderBase = await this.readPatchSnapshot(patchPath)
      if (!await this.manifestMatches(packagePath, manifestBaseline)) {
        throw concurrentProfileModification()
      }
      rollbackExpected = renderBase
      if (pluginAdded) {
        if (original.exists && !sameSnapshot(original, renderBase)) {
          restoreRollbackTargetAllowed = false
          throw new ProfileConflictError()
        }
        if (!original.exists) rollbackTarget = renderBase
      }
      if (deferredAddError !== undefined) throw deferredAddError
      failureStage = 'write'
      output = renderAttachment(parsePatch(renderBase.bytes ?? Buffer.from('[]\n')), normalizedEndpoint, mode)
      // Portable best-effort CAS: within the trusted profile directory, compare
      // bytes plus file identity immediately before the atomic rename.
      const beforeCommit = await this.readPatchSnapshot(patchPath)
      if (!sameSnapshot(renderBase, beforeCommit)) throw new ProfileConflictError()

      writeAttempted = true
      try {
        rollbackExpected = await this.writeAtomic(patchPath, output, renderBase)
      } catch (error) {
        if (error instanceof CommittedWriteError) rollbackExpected = error.committed
        throw error
      }

      failureStage = 'validation'
      if (!await this.manifestMatches(packagePath, manifestBaseline)) {
        throw concurrentProfileModification()
      }
      let validationError: unknown
      try {
        await validate(cloneProviderConfig(configFromAttachment(output)))
      } catch (error) {
        validationError = error
      }
      const afterValidation = await this.readPatchSnapshot(patchPath)
      if (rollbackExpected === undefined || !sameSnapshot(afterValidation, rollbackExpected)) {
        if (validationError !== undefined) throw validationError
        throw new ProfileConflictError()
      }
      if (!await this.manifestMatches(packagePath, manifestBaseline)) {
        throw concurrentProfileModification()
      }
      if (validationError !== undefined) throw validationError
      signal?.throwIfAborted()
    } catch (primaryError) {
      const rollbackFailures: string[] = []
      let patchRollbackBlocked = false
      let effectivePrimaryError = primaryError
      if (pluginResidualPossible) rollbackFailures.push('plugin-residual')

      if (!installedBefore && !pluginAdded && failureStage === 'install') {
        try {
          rollbackExpected = await this.readPatchSnapshot(patchPath)
          if (!sameSnapshot(original, rollbackExpected)) {
            restoreRollbackTargetAllowed = false
            effectivePrimaryError = new ProfileConflictError()
          }
        } catch (error) {
          rollbackFailures.push(error instanceof ProfileConflictError ? 'patch-conflict' : 'patch')
          patchRollbackBlocked = true
        }
      }

      let rollbackCurrent: PatchSnapshot | undefined
      if ((pluginAdded || writeAttempted) && !patchRollbackBlocked) {
        try {
          const current = await this.readPatchSnapshot(patchPath)
          if (rollbackExpected === undefined || !sameSnapshot(current, rollbackExpected)) {
            throw new ProfileConflictError()
          }
          rollbackCurrent = current
        } catch (error) {
          rollbackFailures.push(error instanceof ProfileConflictError ? 'patch-conflict' : 'patch')
        }
      }

      if (rollbackCurrent !== undefined && restoreRollbackTargetAllowed) {
        try {
          await this.restoreSnapshot(patchPath, rollbackTarget, rollbackCurrent)
        } catch (error) {
          rollbackFailures.push(error instanceof ProfileConflictError ? 'patch-conflict' : 'patch')
        }
      }

      if (rollbackFailures.length === 0) {
        const cancellation = cancellationFrom(effectivePrimaryError, signal)
        if (cancellation !== undefined) throw cancellation
        if (effectivePrimaryError instanceof CliError) throw effectivePrimaryError
      }
      // A bundle-mount failure is raised before the patch file is touched and
      // names its own repair; folding it into a generic write failure would
      // hide the one fact the operator needs. Residual state is still reported.
      if (effectivePrimaryError instanceof BundleMountError) {
        throw new CliError(
          'E_PROFILE_BUNDLE_MISSING',
          effectivePrimaryError.message,
          effectivePrimaryError.action,
          { ...effectivePrimaryError.details, rollbackFailures },
        )
      }
      throw profileWriteError(
        'Unable to attach SearXNG to the DSH profile',
        {
          primaryFailure: failureStage,
          primaryError: primaryErrorClass(effectivePrimaryError, failureStage, signal),
          rollbackFailures,
        },
        rollbackFailures.includes('plugin-residual')
          ? 'Run dsh-searxng setup again; it will reuse or reconcile the retained plugin package state'
          : 'Check the DSH profile and retry',
      )
    }
  }

  async detach(profile: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const dir = this.resolveProfileDirectory(name)
    const patchPath = join(dir, 'cordis.patch.yml')
    let snapshot: PatchSnapshot
    try {
      snapshot = await this.readPatchSnapshot(patchPath)
    } catch (error) {
      if (error instanceof ProfileConflictError) {
        throw profileWriteError(
          'The DSH profile changed while it was being read',
          { primaryFailure: 'detach', primaryError: 'profile-conflict', rollbackFailures: [] },
        )
      }
      throw error
    }
    if (!snapshot.exists || snapshot.bytes === undefined) return
    const output = renderDetachment(parsePatch(snapshot.bytes))
    if (output === undefined) return
    let writeAttempted = false
    let rollbackExpected = snapshot
    try {
      const beforeCommit = await this.readPatchSnapshot(patchPath)
      if (!sameSnapshot(snapshot, beforeCommit)) throw new ProfileConflictError()
      writeAttempted = true
      try {
        rollbackExpected = await this.writeAtomic(patchPath, output, snapshot)
      } catch (error) {
        if (error instanceof CommittedWriteError) rollbackExpected = error.committed
        throw error
      }
      signal?.throwIfAborted()
    } catch (primaryError) {
      const rollbackFailures: string[] = []
      if (writeAttempted) {
        try {
          const current = await this.readPatchSnapshot(patchPath)
          if (!sameSnapshot(current, rollbackExpected)) {
            throw new ProfileConflictError()
          }
          await this.restoreSnapshot(patchPath, snapshot, current)
        } catch (error) {
          rollbackFailures.push(error instanceof ProfileConflictError ? 'patch-conflict' : 'patch')
        }
      }
      if (rollbackFailures.length === 0) {
        const cancellation = cancellationFrom(primaryError, signal)
        if (cancellation !== undefined) throw cancellation
        if (primaryError instanceof CliError) throw primaryError
      }
      throw profileWriteError(
        'Unable to detach SearXNG from the DSH profile',
        {
          primaryFailure: 'detach',
          primaryError: primaryErrorClass(primaryError, 'detach', signal),
          rollbackFailures,
        },
      )
    }
  }

  async uninstall(profile: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const packagePath = join(this.resolveProfileDirectory(name), 'package.json')
    if (!await this.readInstalled(packagePath)) return
    let result
    try {
      result = await this.commandRunner.run(
        this.dshCommand,
        ['plugin', '--profile', name, 'remove', PLUGIN_NAME],
        { signal },
      )
      signal?.throwIfAborted()
    } catch (error) {
      const cancellation = cancellationFrom(error, signal)
      if (cancellation !== undefined) throw cancellation
      throw profileWriteError('Unable to remove dsh-searxng from the DSH profile')
    }
    if (result.exitCode !== 0 || await this.readInstalled(packagePath)) {
      throw profileWriteError('Unable to remove dsh-searxng from the DSH profile')
    }
  }

  private async readInstalled(packagePath: string): Promise<boolean> {
    try {
      const info = await this.fileSystem.lstat(packagePath)
      if (info.isSymbolicLink()) throw profileWriteError('The DSH profile manifest is unsafe')
      const source = await this.fileSystem.readFile(packagePath)
      let value: unknown
      try { value = JSON.parse(source.toString()) } catch { throw profileWriteError('The DSH profile manifest is invalid') }
      return installedFromManifest(value)
    } catch (error) {
      if (ioCode(error) === 'ENOENT') return false
      if (error instanceof CliError) throw error
      throw profileWriteError('Unable to read the DSH profile manifest')
    }
  }

  /**
   * Observe whether the plugin's bundle layer really inserts the target entry
   * for this profile. Returns undefined when the manifest cannot be read far
   * enough to decide, so callers never mistake "unknown" for "broken".
   * @param dir - absolute profile directory.
   * @returns the mount verdict, or undefined when undecidable.
   */
  private async readBundleMount(dir: string): Promise<BundleMountStatus | undefined> {
    let bundles: string[]
    try {
      const snapshot = await this.readManifestSnapshot(join(dir, 'package.json'))
      if (snapshot.bytes === undefined) return undefined
      bundles = bundlesFromManifest(JSON.parse(snapshot.bytes.toString()))
    } catch {
      return undefined
    }
    try {
      return await inspectBundleMount({ profileDir: dir, pluginName: PLUGIN_NAME, targetId: TARGET_ID, bundles })
    } catch {
      return undefined
    }
  }

  /**
   * Enrol the plugin package as a profile bundle when it is not already listed,
   * preserving every other manifest field. A no-op for the normal case, where
   * `dsh plugin add` already reconciled the bundle list.
   * @param packagePath - absolute profile manifest path.
   * @param expected - the manifest snapshot the caller is working against.
   * @param signal - cancellation signal.
   * @returns the new manifest snapshot when the file was rewritten, else undefined.
   * @throws {@link concurrentProfileModification} when the manifest moved under us.
   */
  private async ensureBundleEnrolled(
    packagePath: string,
    expected: PatchSnapshot,
    signal?: AbortSignal,
  ): Promise<PatchSnapshot | undefined> {
    signal?.throwIfAborted()
    const current = await this.readManifestSnapshot(packagePath)
    if (!sameSnapshot(current, expected) || current.bytes === undefined) throw concurrentProfileModification()
    let parsed: unknown
    try { parsed = JSON.parse(current.bytes.toString()) } catch { throw profileWriteError('The DSH profile manifest is invalid') }
    const updated = withEnrolledBundle(parsed, PLUGIN_NAME)
    if (updated === undefined) return undefined
    // Serialize exactly like the manifest the CLI already read: two-space JSON
    // plus a trailing newline, the shape `initProfile` and `saveManifest` write.
    const bytes = Buffer.from(`${JSON.stringify(updated, undefined, 2)}\n`)
    const committed = await this.writeAtomic(packagePath, bytes, current)
    signal?.throwIfAborted()
    return committed
  }

  /**
   * Prove the config row this CLI is about to write will actually resolve.
   * A row that the loader silently skips is worse than a failed setup: it looks
   * configured while `ctx.web` has no provider, and the operator only finds out
   * when a search throws `WEB_PROVIDER_CONFIGURED_MISSING`.
   *
   * The guard fires only on conditions it can prove: the package is enrolled
   * and installed, so its bundle layer is readable, and that layer still does
   * not insert the entry. An uninstallable package is not a mount problem —
   * `attach` reports that separately and more precisely — so it is left to the
   * normal install failure path rather than blamed on bundle composition.
   * @param dir - absolute profile directory.
   * @param packagePath - absolute profile manifest path.
   * @param expected - the manifest snapshot the caller is working against.
   * @throws {@link BundleMountError} when the entry provably does not compose.
   */
  private async requireBundleMount(
    dir: string,
    packagePath: string,
    expected: PatchSnapshot,
  ): Promise<void> {
    if (!await this.manifestMatches(packagePath, expected)) throw concurrentProfileModification()
    const mount = await this.readBundleMount(dir)
    if (mount === undefined || mount.composes || !mount.observable) return
    throw new BundleMountError(mount.reason ?? 'not-enrolled')
  }

  private installedFromManifestSnapshot(snapshot: PatchSnapshot): boolean {
    if (snapshot.bytes === undefined) return false
    let value: unknown
    try { value = JSON.parse(snapshot.bytes.toString()) } catch { throw profileWriteError('The DSH profile manifest is invalid') }
    return installedFromManifest(value)
  }

  private async readManifestSnapshot(packagePath: string): Promise<PatchSnapshot> {
    let before: Awaited<ReturnType<typeof fs.lstat>>
    try {
      before = await this.fileSystem.lstat(packagePath)
    } catch (error) {
      if (ioCode(error) === 'ENOENT') return { exists: false }
      if (error instanceof CliError) throw error
      throw profileWriteError('Unable to read the DSH profile manifest')
    }
    if (before.isSymbolicLink() || !before.isFile()) throw profileWriteError('The DSH profile manifest is unsafe')
    try {
      const bytes = Buffer.from(await this.fileSystem.readFile(packagePath))
      const after = await this.fileSystem.lstat(packagePath)
      if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(fileIdentity(before), fileIdentity(after))) {
        throw new ProfileConflictError()
      }
      return { exists: true, bytes, identity: fileIdentity(after) }
    } catch (error) {
      if (error instanceof ProfileConflictError || error instanceof CliError) throw error
      if (ioCode(error) === 'ENOENT') throw new ProfileConflictError()
      throw profileWriteError('Unable to read the DSH profile manifest')
    }
  }

  private async manifestMatches(packagePath: string, expected: PatchSnapshot): Promise<boolean> {
    try {
      const current = await this.readManifestSnapshot(packagePath)
      return sameSnapshot(current, expected) && this.installedFromManifestSnapshot(current)
    } catch {
      return false
    }
  }

  private async readPatchSnapshot(patchPath: string): Promise<PatchSnapshot> {
    let before: Awaited<ReturnType<typeof fs.lstat>>
    try {
      before = await this.fileSystem.lstat(patchPath)
    } catch (error) {
      if (ioCode(error) === 'ENOENT') return { exists: false }
      if (error instanceof CliError) throw error
      throw profileWriteError('Unable to read the DSH profile patch')
    }
    if (before.isSymbolicLink() || !before.isFile()) throw profileWriteError('The DSH profile patch is unsafe')
    try {
      const bytes = Buffer.from(await this.fileSystem.readFile(patchPath))
      const after = await this.fileSystem.lstat(patchPath)
      if (after.isSymbolicLink() || !sameIdentity(fileIdentity(before), fileIdentity(after))) {
        throw new ProfileConflictError()
      }
      return { exists: true, bytes, identity: fileIdentity(after) }
    } catch (error) {
      if (error instanceof ProfileConflictError || error instanceof CliError) throw error
      if (ioCode(error) === 'ENOENT') throw new ProfileConflictError()
      throw profileWriteError('Unable to read the DSH profile patch')
    }
  }

  private async addPlugin(
    profile: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    // Pinned spec, not the bare registry name: `dsh plugin add dsh-searxng`
    // resolves to whatever the registry serves as `latest`, so a release that is
    // newer than the registry would install an older version that the plugin
    // manager then rejects as incompatible — `npx dsh-searxng@0.5.0 setup` could
    // not install itself. Pinning (or an explicit DSH_SEARXNG_PLUGIN_SPEC) makes
    // a self-install and a pre-release/`@next` install deterministic.
    const result = await this.commandRunner.run(this.dshCommand, [
      'plugin', '--profile', profile, 'add', this.pluginSpec,
    ], { signal })
    signal?.throwIfAborted()
    if (result.exitCode !== 0) throw installRejected(result, this.pluginSpec)
  }

  private async restoreSnapshot(
    patchPath: string,
    snapshot: PatchSnapshot,
    expectedCurrent: PatchSnapshot,
  ): Promise<void> {
    if (snapshot.exists && snapshot.bytes !== undefined) {
      await this.writeAtomic(patchPath, snapshot.bytes, expectedCurrent)
      return
    }
    const beforeUnlink = await this.readPatchSnapshot(patchPath)
    if (!sameSnapshot(beforeUnlink, expectedCurrent)) throw new ProfileConflictError()
    try { await this.fileSystem.unlink(patchPath) } catch (error) {
      if (ioCode(error) !== 'ENOENT') throw error
    }
    await this.syncDirectory(dirname(patchPath))
  }

  private async writeAtomic(
    path: string,
    bytes: Buffer,
    expectedCurrent?: PatchSnapshot,
  ): Promise<PatchSnapshot> {
    const directory = dirname(path)
    await this.fileSystem.mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${path}.tmp-${this.randomId()}`
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await this.fileSystem.open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(bytes)
      await handle.chmod(0o600)
      await handle.sync()
      const staged: PatchSnapshot = {
        exists: true,
        bytes: Buffer.from(bytes),
        identity: fileIdentity(await handle.stat()),
      }
      if (expectedCurrent !== undefined) {
        const beforeRename = await this.readPatchSnapshot(path)
        if (!sameSnapshot(beforeRename, expectedCurrent)) throw new ProfileConflictError()
      }
      await this.fileSystem.rename(temporaryPath, path)
      const renamedIdentity = fileIdentity(await handle.stat())
      // macOS advances ctime during rename. Prove continuity with the stable
      // fields, then use this same open handle's post-rename identity for the
      // exact target comparison below, including the updated ctime.
      if (staged.identity === undefined || !sameFileAcrossRename(staged.identity, renamedIdentity)) {
        throw new ProfileConflictError()
      }
      let closeFailed = false
      try {
        await handle.close()
        handle = undefined
      } catch {
        closeFailed = true
      }
      const committed = await this.readPatchSnapshot(path)
      if (!sameBytes(committed, bytes) || !sameIdentity(committed.identity, renamedIdentity)) {
        throw new ProfileConflictError()
      }
      if (closeFailed) throw new CommittedWriteError(committed)
      try {
        await this.syncDirectory(directory)
      } catch {
        throw new CommittedWriteError(committed)
      }
      return committed
    } catch (error) {
      if (handle !== undefined) {
        try { await handle.close() } catch {}
      }
      try { await this.fileSystem.unlink(temporaryPath) } catch {}
      throw error
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    if (this.platform === 'win32') return
    const handle = await this.fileSystem.open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
}
