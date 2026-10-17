/**
 * `dsh-searxng`: registers a SearXNG-backed `WebSearchProvider`
 * with `ctx.web`. A function plugin (NOT a default-export service): a
 * search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-web-search-deepseek`
 * does. The key is owned by `@deepseek-ai/dsh-web`.
 *
 * Every config field is `.volatile()` and is read through `.get()` at
 * operation time. That is the whole point of the volatile contract: the user
 * edits this plugin's settings in the UI and the NEXT search uses the new
 * values without the provider being unregistered and re-registered (which
 * would make the seam's provider selection flicker). A frozen options object
 * captured in `apply` would silently ignore such an edit until remount.
 *
 * @module dsh-searxng
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { isValidSearxngBaseUrl } from './searxng-client.ts'
import { SearxngSearchProvider } from './provider.ts'
import type { SearxngSearchProviderOptions } from './provider.ts'

export {
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
} from './provider.ts'
export type {
  SearxngSearchProviderOptions,
  SearxngSearchProviderOptionsResolver,
} from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * How this plugin is expected to obtain its SearXNG endpoint.
 *
 * - `external` (default): the operator points the plugin at an instance they
 *   already run. The plugin itself never provisions, starts, or manages a
 *   container — it only makes HTTP searches against the configured URL.
 * - `managed`: explicit opt-in. The plugin still only searches; the marker
 *   tells the operator-facing CLI/settings UI that this profile's instance is
 *   one it may provision, own, and repair.
 *
 * Provisioning is therefore never a default. A profile that names only a
 * `baseURL` (every profile written by earlier releases) reads as `external`.
 */
export type SearxngMode = 'external' | 'managed'

/** The mode assumed when a profile does not name one. */
export const DEFAULT_SEARXNG_MODE: SearxngMode = 'external'

/**
 * Plugin config (all optional). Each field is volatile, so the provider reads
 * the current value on every operation instead of a value frozen at mount.
 */
export interface Config {
  /**
   * Deployment posture. `external` (default) searches an instance the operator
   * runs; `managed` marks the endpoint as one this tooling may provision. Never
   * changes how a search is executed — only who owns the endpoint.
   */
  mode?: SearxngMode
  /** SearXNG instance base URL without a query or fragment. Falls back to `$SEARXNG_BASE_URL`. Empty → unavailable. */
  baseURL?: string
  /** Failover pool of SearXNG base URLs; the first entry is primary and a non-empty list wins over `baseURL`. */
  baseURLs?: string[]
  /** Locale passed as SearXNG's `language` parameter, e.g. `zh-CN`. */
  language?: string
  /** Comma-separated engine allowlist passed as SearXNG's `engines` parameter. */
  engines?: string
  /** Comma-separated category filter passed as SearXNG's `categories` parameter. */
  categories?: string
  /** Authorization header value for instances fronted by an API-key gate. */
  authHeader?: string
  /** Cached query result lifetime in milliseconds; 0 disables caching. Default 600000. */
  cacheTtlMs?: number
  /** Minimum spacing between network requests in milliseconds; 0 disables pacing. Default 1500. */
  minIntervalMs?: number
  /** Maximum requests waiting for a pacing slot before rejecting. Default 8. */
  queueCapacity?: number
  /** Total wall-clock budget for one search call in milliseconds. Default 15000. */
  totalBudgetMs?: number
}

/**
 * The settings section as it REACHES `apply`: one stable reference per field,
 * each `.get()` returning the currently saved value. `schemas` hands the
 * plugin this shape (rather than the plain values) for volatile fields, so the
 * provider can read the live section on every operation.
 */
export interface ConfigRefs {
  mode: Volatile<SearxngMode>
  baseURL: Volatile<string | undefined>
  baseURLs: Volatile<string[] | undefined>
  language: Volatile<string | undefined>
  engines: Volatile<string | undefined>
  categories: Volatile<string | undefined>
  authHeader: Volatile<string | undefined>
  cacheTtlMs: Volatile<number | undefined>
  minIntervalMs: Volatile<number | undefined>
  queueCapacity: Volatile<number | undefined>
  totalBudgetMs: Volatile<number | undefined>
}

/**
 * Config schema. Every field is `.volatile()`: the loader hands `apply` a set of
 * stable references whose `.get()` returns the currently saved section, so a
 * settings edit applies to the next search without a remount. Volatile fields
 * must sit at a fixed object path — `.volatile()` on an `array(...)` element is
 * rejected by schemastery, which is why `baseURLs` is a whole-list reference.
 *
 * `mode` is a closed union rather than a free string so a typo in a settings
 * page or a hand-written profile fails validation instead of silently reading
 * as "not managed"; its `.default()` is what keeps untouched profiles working.
 */
export const Config: z<Config, ConfigRefs> = z.object({
  mode: z.union([z.const('external'), z.const('managed')]).default(DEFAULT_SEARXNG_MODE).volatile(),
  baseURL: z.string().volatile(),
  baseURLs: z.array(z.string()).volatile(),
  language: z.string().volatile(),
  engines: z.string().volatile(),
  categories: z.string().volatile(),
  authHeader: z.string().volatile(),
  cacheTtlMs: z.number().volatile(),
  minIntervalMs: z.number().volatile(),
  queueCapacity: z.number().volatile(),
  totalBudgetMs: z.number().volatile(),
})

/**
 * Project the CURRENT settings section into one operation's provider options.
 * Environment fallbacks live here, not in the provider: every value the
 * provider reads is already fully resolved.
 */
function resolveOptions(ctx: Context, config: ConfigRefs): SearxngSearchProviderOptions {
  // No public instance is assumed: most disable the JSON format and
  // rate-limit heavily, so an unset base URL honestly reads "unavailable".
  const baseURLs = config.baseURLs.get()
  const baseURL = config.baseURL.get()
    ?? launchEnvironmentOf(ctx).get('SEARXNG_BASE_URL')?.value
    ?? ''
  const language = config.language.get()
  const engines = config.engines.get()
  const categories = config.categories.get()
  const authHeader = config.authHeader.get()
  const cacheTtlMs = config.cacheTtlMs.get()
  const minIntervalMs = config.minIntervalMs.get()
  const queueCapacity = config.queueCapacity.get()
  const totalBudgetMs = config.totalBudgetMs.get()
  return {
    baseURL,
    ...(Array.isArray(baseURLs) && baseURLs.length > 0 ? { baseURLs } : {}),
    ...language !== undefined && language.length > 0 ? { language } : {},
    ...engines !== undefined && engines.length > 0 ? { engines } : {},
    ...categories !== undefined && categories.length > 0 ? { categories } : {},
    ...authHeader !== undefined && authHeader.length > 0 ? { authHeader } : {},
    ...cacheTtlMs !== undefined ? { cacheTtlMs } : {},
    ...minIntervalMs !== undefined ? { minIntervalMs } : {},
    ...queueCapacity !== undefined ? { queueCapacity } : {},
    ...totalBudgetMs !== undefined ? { totalBudgetMs } : {},
  }
}

/** Register the SearXNG search provider with `ctx.web`. */
export function apply(ctx: Context, config: ConfigRefs): void {
  // The resolver, not a snapshot: the provider asks for the options of the
  // operation it is about to run, so a saved settings edit takes effect on the
  // next search and the provider registration never has to change.
  ctx.web.registerSearchProvider(new SearxngSearchProvider(() => resolveOptions(ctx, config)))
}

/**
 * Why a profile is or is not able to search, for the settings page and the
 * operator CLI.
 *
 * `mode` deliberately does NOT gate availability. A search can only run against
 * a reachable endpoint, so `available()` is decided purely by the endpoint in
 * both modes — claiming availability because a container *might* be provisioned
 * would send the search to an empty URL and surface a confusing provider error
 * instead of the seam's honest `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`. What the
 * mode changes is the REASON an unconfigured profile is unconfigured, which is
 * the distinction this function exposes:
 *
 * - `awaiting-managed-endpoint` — `managed` with no endpoint yet. A legitimate
 *   pre-provisioning state, not a misconfiguration: the operator opted into
 *   provisioning and the CLI has not written the endpoint yet.
 * - `no-endpoint` — `external` (or default) with no endpoint. A genuine
 *   misconfiguration: nothing points at a SearXNG and nothing will create one.
 */
export type SearxngProfileState =
  | 'ready'
  | 'invalid-endpoint'
  | 'awaiting-managed-endpoint'
  | 'no-endpoint'

/** Describe one profile's search readiness. Pure; makes no network calls. */
export function describeSearxngProfile(profile: {
  readonly mode?: SearxngMode
  readonly baseURL?: string
  readonly baseURLs?: readonly string[]
}): { readonly available: boolean; readonly state: SearxngProfileState } {
  const mode = profile.mode ?? DEFAULT_SEARXNG_MODE
  const listed = Array.isArray(profile.baseURLs) ? profile.baseURLs : []
  const endpoints = listed.length > 0 ? listed : [profile.baseURL ?? '']
  const configured = endpoints.some((endpoint) => typeof endpoint === 'string' && endpoint.length > 0)
  if (!configured) {
    return {
      available: false,
      state: mode === 'managed' ? 'awaiting-managed-endpoint' : 'no-endpoint',
    }
  }
  const available = endpoints.every(isValidSearxngBaseUrl)
  return { available, state: available ? 'ready' : 'invalid-endpoint' }
}

