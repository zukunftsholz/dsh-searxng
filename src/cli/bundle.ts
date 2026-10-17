/**
 * Profile bundle-layer composition, observed the way the Cordis loader sees it.
 *
 * A profile mounts a provider only when two independent things are true:
 *
 *  1. the package is listed in the profile manifest's `dsh.profile.bundles`, so
 *     its own `cordis.patch.yml` (the `insert:` that creates the entry) is
 *     applied as a bundle layer, and
 *  2. the profile's `cordis.patch.yml` carries a matching non-insert patch,
 *     which supplies that existing entry's `config`.
 *
 * Presence in `dependencies` alone is not enough: it installs the package but
 * mounts nothing. `applyEntryPatches` resolves a non-insert patch by id against
 * entries that already exist, and a miss is only a loader warning — the row is
 * dropped silently, `ctx.web` never sees the provider, and a configured
 * `web.searchProvider: searxng` fails at search time with
 * `WEB_PROVIDER_CONFIGURED_MISSING`. That exact state has been observed on a
 * real machine, so the CLI verifies composition instead of assuming it.
 *
 * This module deliberately re-implements only the two loader rules it needs
 * (top-level `insert` appends entries; non-insert patches never create them).
 * It must not import `@deepseek-ai/dsh-app-boot`: the CLI is bundled standalone
 * and ships without any DSH runtime dependency.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Why a bundle layer does not contribute the target entry. */
export type BundleMountReason =
  /** The package is absent from `dsh.profile.bundles`, so its layer is never applied. */
  | 'not-enrolled'
  /** Enrolled, but the package is not installed under the profile's `node_modules`. */
  | 'package-missing'
  /** Enrolled, but the package declares no `dsh.bundle.patch`. */
  | 'no-bundle-metadata'
  /** Enrolled, but one of its declared patch files is unreadable or not a patch list. */
  | 'patch-unreadable'
  /** Enrolled and readable, but no top-level `insert` creates the target id. */
  | 'target-not-inserted'

export interface BundleMountStatus {
  /** The package name is listed in the profile manifest's `dsh.profile.bundles`. */
  enrolled: boolean
  /** The bundle layer really creates the target entry, so a config row resolves. */
  composes: boolean
  /**
   * Why it does not compose. Absent exactly when `composes` is true, or when
   * the package is not installed and the bundle layer therefore cannot be
   * observed at all (see `observable`).
   */
  reason?: BundleMountReason
  /**
   * Whether the bundle layer was observable. False only when the package is
   * absent from the profile's `node_modules`: an uninstalled package has no
   * patch file to read, so "not enrolled" and "package missing" are the only
   * verifiable facts and composition cannot be decided either way. Callers
   * that gate a write must not treat undecidable as a failure; `doctor`
   * reports it as the actionable `package-missing` condition instead.
   */
  observable: boolean
}

/** The package the CLI attaches; also the bundle name a profile must enroll. */
export const PLUGIN_NAME = 'dsh-searxng'

/**
 * Environment variable that overrides the package spec `setup` installs.
 *
 * The default install spec is this package pinned to its own version
 * (`dsh-searxng@0.5.0`), because installing the bare registry name resolves to
 * whatever the registry currently serves as `latest` — which, for a release that
 * is newer than the registry, is an older version the plugin manager then
 * correctly rejects as incompatible. Pinning makes a self-install deterministic.
 *
 * This override exists for the cases pinning still cannot serve: installing from
 * a packed tarball before publication, from a git ref, or from an alternate
 * registry/tag. The value is used verbatim as the `add` argument, so any spec
 * pnpm accepts works.
 */
export const PLUGIN_SPEC_ENV = 'DSH_SEARXNG_PLUGIN_SPEC'

/**
 * The install spec for this plugin.
 *
 * Pinned to the RUNNING package's own version rather than a literal, so the two
 * can never drift: bumping `package.json` changes the spec automatically. The
 * version is read from the packaged `package.json` at run time because the CLI
 * has no other authoritative source — it must not import its own entry point
 * (that would pull the harness runtime into the standalone bundle).
 * @param options.version - the running package version, when known.
 * @param options.env - environment to read the override from.
 * @returns the spec to pass to `dsh plugin add`.
 */
export function resolvePluginSpec(options: {
  version?: string
  env?: NodeJS.ProcessEnv
} = {}): string {
  const configured = options.env?.[PLUGIN_SPEC_ENV]?.trim()
  if (configured !== undefined && configured.length > 0) return configured
  // A version that cannot be determined still yields a valid spec (the bare
  // name); it is only less deterministic, and the operator can always override.
  return options.version === undefined || options.version.length === 0
    ? PLUGIN_NAME
    : `${PLUGIN_NAME}@${options.version}`
}

/** What this CLI knows about its own package, resolved once per process. */
export interface SelfPackage {
  /** Installed package version, or undefined when it cannot be read. */
  version?: string
  /** The spec `setup` installs by default. */
  spec: string
}

/**
 * Read this package's own version from its installed `package.json`.
 *
 * Matches the repo's existing self-location convention (`PACKED_ASSET_ROOT` in
 * `deployments.ts`, which reads the catalog synchronously the same way): the
 * packed CLI is `lib/cli.mjs` with `package.json` alongside, while in
 * development it is `src/cli/*`, two levels deeper. Only `package.json` is
 * read — never the package entry point — so the standalone bundle keeps its
 * "no harness runtime" guarantee.
 * @param moduleUrl - the caller's `import.meta.url`.
 * @param env - environment to read the spec override from.
 * @returns the version (when readable) and the resolved spec.
 */
export function readSelfPackage(
  moduleUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): SelfPackage {
  const candidates = [
    new URL('../package.json', moduleUrl),
    new URL('../../package.json', moduleUrl),
  ]
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'))
      // Verify the name so a neighbouring unrelated package.json is never
      // mistaken for this one.
      if (!isRecord(parsed) || parsed.name !== PLUGIN_NAME) continue
      const version = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : undefined
      return {
        ...(version === undefined ? {} : { version }),
        spec: resolvePluginSpec({ ...(version === undefined ? {} : { version }), env }),
      }
    } catch {
      continue
    }
  }
  return { spec: resolvePluginSpec({ env }) }
}

/**
 * Directory of a package installed into a profile. Scoped names keep both
 * segments, mirroring the on-disk `@scope/name` layout.
 * @param profileDir - absolute profile directory.
 * @param name - package name.
 * @returns the absolute package directory (which may not exist).
 */
export function packageDirectory(profileDir: string, name: string): string {
  return join(profileDir, 'node_modules', ...name.split('/'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The entry ids a bundle's patch list creates by top-level `insert`.
 *
 * Faithful to the loader for the only shape a provider bundle uses: a patch
 * with `insert` and no `id` appends to the entry list; a patch with both
 * `insert` and `id` appends into an existing group instead, so it creates no
 * top-level entry. Non-insert patches never create an id.
 * @param patches - the parsed patch list of one bundle.
 * @returns the top-level entry ids created, in application order.
 */
export function insertedEntryIds(patches: readonly unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const raw of patches) {
    if (!isRecord(raw)) throw new Error('patch entry is not a map')
    if (raw.insert === undefined || raw.id !== undefined) continue
    if (!Array.isArray(raw.insert)) throw new Error('patch insert is not a list')
    for (const entry of raw.insert) {
      if (!isRecord(entry)) throw new Error('inserted entry is not a map')
      if (typeof entry.id === 'string') ids.add(entry.id)
    }
  }
  return ids
}

/**
 * The patch files a bundle declares, resolved to absolute paths.
 * @param packageDir - absolute package directory.
 * @param bundle - the package's `dsh.bundle` declaration.
 * @returns absolute patch paths in application order.
 * @throws when the declaration is neither a string nor a list of strings.
 */
function bundlePatchPaths(packageDir: string, bundle: Record<string, unknown>): string[] {
  const declared = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
  if (!Array.isArray(declared) || !declared.every((file) => typeof file === 'string')) {
    throw new Error('dsh.bundle.patch must be a file path or a list of file paths')
  }
  return declared.map((file) => join(packageDir, file))
}

/**
 * Observe whether a profile's bundle layer contributes the target entry.
 * @param options.profileDir - absolute profile directory.
 * @param options.pluginName - package that owns the bundle layer.
 * @param options.targetId - loader entry id the config row targets.
 * @param options.bundles - the profile manifest's current `dsh.profile.bundles`.
 * @returns the enrollment and composition verdict; never throws for absent files.
 */
export async function inspectBundleMount(options: {
  profileDir: string
  pluginName: string
  targetId: string
  bundles: readonly string[]
}): Promise<BundleMountStatus> {
  const enrolled = options.bundles.includes(options.pluginName)
  if (!enrolled) return { enrolled: false, composes: false, reason: 'not-enrolled', observable: true }

  const packageDir = packageDirectory(options.profileDir, options.pluginName)
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  } catch {
    // The package is not on disk, so its bundle layer cannot be read. Report
    // the fact that is verifiable and mark composition undecidable; a caller
    // that must not write an unmountable row opts into treating this as a
    // failure, while `doctor` reports it as the actionable condition.
    return { enrolled: true, composes: false, reason: 'package-missing', observable: false }
  }
  if (!isRecord(manifest) || !isRecord(manifest.dsh) || !isRecord(manifest.dsh.bundle)) {
    return { enrolled: true, composes: false, reason: 'no-bundle-metadata', observable: true }
  }

  let paths: string[]
  try {
    paths = bundlePatchPaths(packageDir, manifest.dsh.bundle)
  } catch {
    return { enrolled: true, composes: false, reason: 'no-bundle-metadata', observable: true }
  }

  const ids = new Set<string>()
  for (const path of paths) {
    let parsed: unknown
    try {
      parsed = parseYaml(await readFile(path, 'utf8'))
    } catch {
      return { enrolled: true, composes: false, reason: 'patch-unreadable', observable: true }
    }
    if (parsed === null) continue
    if (!Array.isArray(parsed)) return { enrolled: true, composes: false, reason: 'patch-unreadable', observable: true }
    try {
      for (const id of insertedEntryIds(parsed)) ids.add(id)
    } catch {
      return { enrolled: true, composes: false, reason: 'patch-unreadable', observable: true }
    }
  }

  if (ids.has(options.targetId)) return { enrolled: true, composes: true, observable: true }
  return { enrolled: true, composes: false, reason: 'target-not-inserted', observable: true }
}

/**
 * One operator-facing sentence naming the exact consequence and repair for
 * each non-composing verdict. Shared by `attach` and `doctor` so the failure
 * the CLI refuses to write and the failure it diagnoses read identically.
 * @param reason - the observed reason.
 * @param pluginName - package name, for the repair hint.
 * @returns the message and the recommended action.
 */
export function bundleMountDiagnosis(
  reason: BundleMountReason,
  pluginName = PLUGIN_NAME,
): { message: string; action: string } {
  switch (reason) {
    case 'not-enrolled':
      return {
        message: `The profile does not list ${pluginName} in dsh.profile.bundles, so its bundle layer never inserts the web-search-searxng entry and the provider is never registered with ctx.web`,
        action: `Add ${pluginName} to the profile's dsh.profile.bundles (run dsh-searxng setup, which enrolls it), then restart dsh`,
      }
    case 'package-missing':
      return {
        message: `${pluginName} is enrolled in dsh.profile.bundles but is not installed under the profile, so its bundle layer is skipped and the provider is never registered with ctx.web`,
        action: `Install the plugin into the profile (run dsh plugin --profile <name> add ${pluginName} or dsh-searxng setup), then restart dsh`,
      }
    case 'no-bundle-metadata':
      return {
        message: `${pluginName} declares no dsh.bundle.patch, so it contributes no bundle layer and the web-search-searxng entry is never inserted`,
        action: 'Reinstall a dsh-searxng release that ships its cordis.patch.yml, then restart dsh',
      }
    case 'patch-unreadable':
      return {
        message: `The ${pluginName} bundle patch could not be read, so its insert of the web-search-searxng entry cannot be applied`,
        action: 'Reinstall dsh-searxng into the profile, then restart dsh',
      }
    case 'target-not-inserted':
      return {
        message: `The ${pluginName} bundle layer does not insert a web-search-searxng entry, so the profile's config row for it is silently skipped and the provider is never registered with ctx.web`,
        action: 'Install a dsh-searxng release whose bundle inserts web-search-searxng, then restart dsh',
      }
  }
}

/**
 * The consequence of a silently skipped config row, spelled out once so every
 * surface reports the same link from cause to symptom.
 * @returns the sentence appended to diagnosis messages.
 */
export function silentSkipConsequence(): string {
  return 'the profile\'s web-search-searxng config row is silently skipped and a configured web.searchProvider: searxng fails at search time with WEB_PROVIDER_CONFIGURED_MISSING'
}

/** Search readiness of one profile's recorded provider config. */
export type ProfileReadiness =
  | 'ready'
  | 'invalid-endpoint'
  | 'awaiting-managed-endpoint'
  | 'no-endpoint'

/**
 * Whether a URL is a usable SearXNG base URL: absolute HTTP(S), no embedded
 * credentials, no query, no fragment. Mirrors the provider's own rule.
 * @param value - candidate base URL.
 * @returns true when the provider would accept it.
 */
function isValidBaseUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 && url.password.length === 0 &&
    url.search.length === 0 && url.hash.length === 0
}

/**
 * Classify one profile's recorded provider config for `doctor`/`status`.
 *
 * This deliberately mirrors `describeSearxngProfile` in the plugin entry point
 * rather than importing it. Importing it — even though it is a pure function —
 * makes the bundler pull the whole plugin entry into the standalone CLI, which
 * drags in the harness runtime packages. The packed CLI must run from `npx`
 * before a DSH host resolves this plugin's peers, so it may carry no harness
 * runtime at all, and `scripts/check-packed-cli.mjs` enforces exactly that by
 * scanning the emitted bundle for those package names. A test asserts the two
 * implementations give identical verdicts, so they cannot drift silently.
 *
 * `managed` with no endpoint is a legitimate pre-provisioning state — the
 * operator opted in and this CLI has not written the endpoint yet — while
 * `external` with no endpoint is a genuine misconfiguration.
 * @param config - the effective provider config.
 * @returns the readiness verdict.
 */
export function profileReadiness(config: {
  mode?: 'external' | 'managed'
  baseURL?: string
  baseURLs?: readonly string[]
}): ProfileReadiness {
  const mode = config.mode ?? 'external'
  const listed = Array.isArray(config.baseURLs) ? config.baseURLs : []
  const endpoints = listed.length > 0 ? listed : [config.baseURL ?? '']
  const configured = endpoints.some((endpoint) => typeof endpoint === 'string' && endpoint.length > 0)
  if (!configured) return mode === 'managed' ? 'awaiting-managed-endpoint' : 'no-endpoint'
  return endpoints.every((endpoint) => typeof endpoint === 'string' && isValidBaseUrl(endpoint))
    ? 'ready'
    : 'invalid-endpoint'
}
