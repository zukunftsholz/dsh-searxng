/**
 * DSH web-seam adapter for the dependency-free SearXNG client.
 *
 * The provider takes an options RESOLVER rather than a frozen options object:
 * under DSH 0.2.1-rc.2 the plugin's settings section is volatile, so a user
 * editing the plugin settings must see the change on the next search. The
 * resolver is called once per operation, so one search never mixes two
 * sections, and the provider never has to re-register (re-registering makes the
 * seam's selection flicker for the user).
 *
 * @module dsh-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import {
  SearxngClientError,
  isValidSearxngBaseUrl,
  mapSearxngClientResponse,
  mapSearxngClientResult,
} from './searxng-client.ts'
import { SearxngSearchSession, resolveEndpointPool } from './search-session.ts'
import type { SearxngSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/**
 * Resolved provider options (the plugin's `apply` supplies env-var and
 * constant defaults).
 */
export interface SearxngSearchProviderOptions {
  /** Absolute HTTP(S) SearXNG base URL without credentials, query, or fragment. */
  baseURL: string
  /**
   * Failover pool of SearXNG base URLs; the first entry is primary. A non-empty
   * list wins over `baseURL`.
   */
  baseURLs?: readonly string[]
  /** Locale passed as SearXNG's `language` parameter, e.g. `zh-CN`. */
  language?: string
  /** Comma-separated engine allowlist passed as SearXNG's `engines` parameter. */
  engines?: string
  /** Comma-separated category filter passed as SearXNG's `categories` parameter. */
  categories?: string
  /** Authorization header value for instances fronted by an API-key gate. */
  authHeader?: string
  /** Cached entry lifetime in milliseconds; 0 disables. Default 600_000. */
  cacheTtlMs?: number
  /** Minimum spacing between network attempts; 0 disables pacing. Default 1500. */
  minIntervalMs?: number
  /** Maximum requests waiting for a pacing slot before rejecting. Default 8. */
  queueCapacity?: number
  /** Total wall-clock budget for one search call in milliseconds. Default 15_000. */
  totalBudgetMs?: number
}

/**
 * Supply the options for the NEXT operation: called once at each operation's
 * entry so a settings change applies to the next search without remounting.
 */
export type SearxngSearchProviderOptionsResolver = () => SearxngSearchProviderOptions

/** Map one SearXNG result to the DSH web source shape. */
export function mapSearxngResult(result: unknown): WebSearchSource | undefined {
  return mapSearxngClientResult(result)
}

/** Map a SearXNG response envelope to the DSH web result shape. */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  return mapSearxngClientResponse(response)
}

/** The SearXNG-backed search provider; failures surface through stable DSH errors. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  private readonly resolveOptions: SearxngSearchProviderOptionsResolver
  private readonly session: SearxngSearchSession

  /**
   * @param resolveOptions - the options for the next operation, snapshotted
   *   once at each operation's entry. A thunk rather than a value because the
   *   plugin's settings section can change between searches.
   */
  constructor(resolveOptions: SearxngSearchProviderOptionsResolver) {
    this.resolveOptions = resolveOptions
    this.session = new SearxngSearchSession(resolveOptions)
  }

  available(): boolean {
    // Availability is a cheap local check and the seam calls it from inside
    // provider selection, so a malformed section reads "unavailable" rather
    // than escaping as a non-WebError exception.
    let endpoints: readonly string[]
    try {
      endpoints = resolveEndpointPool(this.resolveOptions())
    } catch {
      return false
    }
    // Every named endpoint must be usable: silently skipping one the operator
    // configured would hide a mistake behind partial availability.
    return endpoints.every(isValidSearxngBaseUrl)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    let result: WebSearchResult
    try {
      result = await this.session.search(request.query, signal)
    } catch (error: unknown) {
      throw toWebError(error)
    }
    return applyMaxResults(result, request.maxResults)
  }
}

/**
 * Apply `request.maxResults` at the provider's own request layer.
 *
 * `WebSearchResult.truncated` means "the SEAM dropped sources to honor
 * `maxResults`" — `dsh-web`'s `capSources()` sets it only when it has to cut,
 * and never clears a provider-set `true`. A provider that already honored the
 * bound leaves `truncated: false`, exactly as the shipped Exa provider does for
 * `numResults`: the caller asked for at most N sources and got at most N, so
 * nothing is dropped afterwards. Cutting here only avoids handing the seam a
 * page it would immediately discard; it does not change what the caller sees,
 * so `truncated` stays whatever the result already carried.
 *
 * This happens OUTSIDE the session cache on purpose: cache identity is the
 * query plus request-shaping options, so one search at `maxResults: 3` must not
 * poison a later search at `maxResults: 8`.
 */
function applyMaxResults(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || !Number.isFinite(maxResults) || maxResults < 0) return result
  const bound = Math.floor(maxResults)
  if (result.sources.length <= bound) return result
  return { ...result, sources: result.sources.slice(0, bound) }
}

/** Map one client failure to the seam's stable error vocabulary. */
function toWebError(error: unknown): WebError {
  if (!(error instanceof SearxngClientError)) {
    return new WebError('SearXNG request failed', 'WEB_PROVIDER_ERROR')
  }
  // The cause attached at this boundary is a REDACTED copy: it keeps the
  // failure kind and HTTP status for diagnosability but drops the raw chain,
  // whose message can carry the request URL and authorization header. The
  // unredacted chain stays available to the CLI probes, which classify TLS
  // failures from it and never cross this seam.
  const cause = redactedCause(error)
  if (error.kind === 'caller-abort') {
    return new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause })
  }
  if (error.kind === 'invalid-url') {
    return new WebError(
      'SearXNG base URL must be an absolute HTTP URL without credentials, query, or fragment',
      'WEB_PROVIDER_ERROR',
      { cause },
    )
  }
  if (error.kind === 'timeout') {
    return new WebError(
      'SearXNG request timed out; check the instance and network, then retry',
      'WEB_PROVIDER_ERROR',
      { cause },
    )
  }
  if (error.kind === 'budget') {
    return new WebError(
      'SearXNG search exceeded its total time budget; the instance is too slow, so raise totalBudgetMs or retry',
      'WEB_PROVIDER_ERROR',
      { cause },
    )
  }
  if (error.kind === 'busy') {
    return new WebError(
      'SearXNG provider is pacing concurrent searches and its queue is full; retry after in-flight searches settle',
      'WEB_PROVIDER_ERROR',
      { cause },
    )
  }
  if (error.kind === 'config') {
    return new WebError(`SearXNG plugin settings are unusable: ${error.message}`, 'WEB_PROVIDER_ERROR', { cause })
  }
  if (error.kind === 'contract') {
    return new WebError('SearXNG returned an unprocessable response body', 'WEB_PROVIDER_ERROR', { cause })
  }
  if (error.kind === 'http') {
    return new WebError(httpFailureMessage(error.status), 'WEB_PROVIDER_ERROR', { cause })
  }
  return new WebError('SearXNG request failed', 'WEB_PROVIDER_ERROR', { cause })
}

/**
 * Copy the failure class without its underlying chain. Every client-failure
 * message is a constant string that names no request state, so the copy is safe
 * to expose; the discarded chain is not.
 */
function redactedCause(error: SearxngClientError): SearxngClientError {
  return new SearxngClientError(error.kind, error.message, error.status)
}

function httpFailureMessage(status: number | undefined): string {
  if (status === 403) {
    return 'SearXNG refused the request (HTTP 403). Most likely the instance does not enable the JSON format — add "json" to search.formats in its settings, or see the plugin README for a ready-to-use docker-compose instance'
  }
  if (status === 429) {
    return 'SearXNG instance rate limit hit (HTTP 429). Space out requests, or raise the limiter limits on the instance'
  }
  return `SearXNG instance error (HTTP ${status ?? 'unknown'})`
}
