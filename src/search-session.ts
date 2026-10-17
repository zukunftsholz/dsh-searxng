/**
 * Provider-owned search session: one instance lives inside one
 * `SearxngSearchProvider`, so cache entries and pacing state never leak across
 * profiles or authentication contexts. The free functions in
 * `searxng-client.ts` stay uncontrolled on purpose — CLI lifecycle probes must
 * measure fresh, unpaced responses.
 *
 * One total budget spans the whole `search()` call: the pacing wait, every
 * backoff delay, and every network attempt. Attempt counts are a secondary
 * guard; the budget is the primary latency bound.
 *
 * The session takes an options RESOLVER rather than a frozen options object.
 * Under DSH 0.2.1-rc.2 plugin config is volatile: the settings section can
 * change between searches, and re-registering the provider to carry a new
 * endpoint would make the seam's selection flicker for the user. The resolver
 * is therefore called exactly once per `search()` and its result drives that
 * whole operation, so one search never mixes two sections. Cache and endpoint
 * health survive a settings edit; the cache key already includes every
 * request-shaping option, so entries written under an old section are simply
 * never hit again.
 *
 * @module dsh-searxng/search-session
 */

import {
  SearxngClientError,
  abortableDelay,
  buildSearchUrl,
  buildSearxngSearchParams,
  isSearxngSearchResponse,
  isValidSearxngBaseUrl,
  mapSearxngClientResponse,
  requestJsonWithRetry,
  searxngRequestHeaders,
} from './searxng-client.ts'
import type { SearxngClientOptions, SearxngClientResult } from './searxng-client.ts'

/** Knobs are per provider instance; defaults follow docs/development-plan.md M1. */
export interface SearxngSearchSessionOptions extends SearxngClientOptions {
  /**
   * Failover pool of SearXNG base URLs; the first entry is primary. A non-empty
   * list wins over `baseURL`. Absent or empty keeps single-`baseURL` behavior.
   */
  baseURLs?: readonly string[]
  /** Cached entry lifetime in milliseconds; 0 disables caching. Default 600_000. */
  cacheTtlMs?: number
  /** Maximum cached entries (LRU). Default 64. */
  cacheCapacity?: number
  /** Minimum spacing between network attempts; 0 disables pacing. Default 1500. */
  minIntervalMs?: number
  /** Maximum requests waiting for a pacing slot before rejecting. Default 8. */
  queueCapacity?: number
  /** Total wall-clock budget for one search call. Default 15_000. */
  totalBudgetMs?: number
}

/**
 * Supply the options for the NEXT operation. Called once at each operation's
 * entry so a settings change applies to the next search without re-registering
 * the provider.
 */
export type SearxngSearchSessionOptionsResolver = () => SearxngSearchSessionOptions

const DEFAULT_CACHE_TTL_MS = 600_000
const DEFAULT_CACHE_CAPACITY = 64
const DEFAULT_MIN_INTERVAL_MS = 1_500
const DEFAULT_QUEUE_CAPACITY = 8
const DEFAULT_TOTAL_BUDGET_MS = 15_000
const DEFAULT_BACKOFF_AFTER_RATE_LIMIT_MS = 1_000
const MAX_ATTEMPTS = 3
const RETRYABLE_STATUSES = new Set([502, 503, 504])
const MAX_POOL_ENTRIES = 8
const HEALTH_HALF_LIFE_MS = 30_000
const HEALTH_EPSILON = 0.25

/**
 * Resolve the failover pool: a non-empty `baseURLs` (exact duplicates collapse,
 * first occurrence kept, at most 8 entries) wins over `baseURL`; otherwise the
 * pool is the single `baseURL` (possibly `''`, which reads as unavailable).
 */
export function resolveEndpointPool(options: { baseURL?: string; baseURLs?: readonly string[] }): string[] {
  const listed = options.baseURLs
  if (listed === undefined) return [options.baseURL ?? '']
  // Volatile config reaches this function without a remount, so a shape that
  // the schema would have rejected must still fail loudly instead of being
  // iterated as characters.
  if (!Array.isArray(listed)) throw new RangeError('baseURLs must be a list of strings')
  if (listed.length === 0) return [options.baseURL ?? '']
  for (const entry of listed) {
    if (typeof entry !== 'string') throw new RangeError('baseURLs entries must be strings')
  }
  const pool = [...new Set(listed)]
  if (pool.length > MAX_POOL_ENTRIES) {
    throw new RangeError(`baseURLs must list at most ${MAX_POOL_ENTRIES} endpoints`)
  }
  return pool
}

/** Health-decay record for one pool endpoint: failures accumulate, time heals. */
interface EndpointHealth {
  penalty: number
  lastFailureAt: number
}

/** One operation's fully validated, defaulted view of the settings section. */
interface SessionSnapshot {
  readonly options: SearxngSearchSessionOptions
  readonly pool: readonly string[]
  readonly cacheTtlMs: number
  readonly cacheCapacity: number
  readonly minIntervalMs: number
  readonly queueCapacity: number
  readonly totalBudgetMs: number
  readonly perAttemptTimeoutMs: number
  readonly retryDelayMs: number
}

interface CacheEntry {
  readonly expiresAt: number
  readonly value: SearxngClientResult
}

interface PacerWaiter {
  readonly deadlineAt: number
  readonly signal?: AbortSignal
  resolve(): void
  reject(error: SearxngClientError): void
  onAbort(): void
}

/** The pacing limits of the operation currently being admitted. */
interface PacerLimits {
  readonly intervalMs: number
  readonly queueCapacity: number
}

/**
 * Token bucket with a bounded FIFO of waiting acquirers. Tokens refill
 * continuously; a full queue rejects immediately (`busy`) instead of holding
 * the caller, and every wait is abortable. Pacing is provider-instance-local:
 * it cannot coordinate other processes sharing the same instance or IP.
 *
 * Limits are read per admission from the caller's resolver rather than frozen
 * at construction. Volatile settings can change a rate between searches, and a
 * rebuilt bucket would hand out a fresh burst — charging the new rate against
 * the existing bucket is both simpler and stricter than resetting it.
 */
class Pacer {
  private tokens: number
  private lastRefillAt: number
  private readonly waiters: PacerWaiter[] = []
  private wakeTimer: ReturnType<typeof setTimeout> | undefined
  private intervalMs = 1_500

  constructor(private readonly capacity = 2) {
    this.tokens = capacity
    this.lastRefillAt = Date.now()
  }

  acquire(limits: PacerLimits, deadlineAt: number, signal?: AbortSignal): Promise<void> {
    this.intervalMs = limits.intervalMs
    if (this.waiters.length >= limits.queueCapacity) {
      return Promise.reject(new SearxngClientError(
        'busy',
        'SearXNG provider pacing queue is full; retry after in-flight searches settle',
      ))
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PacerWaiter = {
        deadlineAt,
        ...(signal === undefined ? {} : { signal }),
        resolve,
        reject,
        onAbort: () => {
          this.removeWaiter(waiter)
          reject(new SearxngClientError('caller-abort', 'SearXNG search aborted'))
        },
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
      this.drain()
    })
  }

  private removeWaiter(waiter: PacerWaiter): void {
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) this.waiters.splice(index, 1)
    if (this.waiters.length === 0) this.clearWake()
  }

  private drain(): void {
    const now = Date.now()
    // Budget spent waiting never starts a network attempt.
    for (const waiter of [...this.waiters]) {
      if (waiter.deadlineAt <= now) {
        this.removeWaiter(waiter)
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.reject(new SearxngClientError('budget', 'SearXNG search budget expired while waiting for a pacing slot'))
      }
    }
    this.refill(now)
    while (this.waiters.length > 0 && this.tokens >= 1) {
      const waiter = this.waiters.shift()
      if (waiter === undefined) break
      this.tokens -= 1
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
    }
    this.scheduleWake()
  }

  private refill(now: number): void {
    const gained = (now - this.lastRefillAt) / this.intervalMs
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained)
      this.lastRefillAt = now
    }
  }

  private scheduleWake(): void {
    if (this.waiters.length === 0) {
      this.clearWake()
      return
    }
    const now = Date.now()
    const timeToNextToken = this.tokens >= 1 ? 0 : (1 - this.tokens) * this.intervalMs
    let nextEventAt = now + timeToNextToken
    for (const waiter of this.waiters) nextEventAt = Math.min(nextEventAt, waiter.deadlineAt)
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer)
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      this.drain()
    }, Math.max(1, nextEventAt - now))
  }

  private clearWake(): void {
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = undefined
    }
  }
}

export class SearxngSearchSession {
  private readonly resolveOptions: SearxngSearchSessionOptionsResolver
  private readonly cache = new Map<string, CacheEntry>()
  private readonly health = new Map<string, EndpointHealth>()
  /** Per-endpoint buckets; created on first use and kept for the instance. */
  private readonly pacers = new Map<string, Pacer>()

  /**
   * @param resolveOptions - the options for the next operation. A thunk rather
   *   than a value because the plugin's settings section is volatile and can
   *   change between searches.
   */
  constructor(resolveOptions: SearxngSearchSessionOptionsResolver) {
    this.resolveOptions = resolveOptions
  }

  /** Run one search through instance-local cache, pacing, and the total budget. */
  async search(query: string, signal?: AbortSignal): Promise<SearxngClientResult> {
    if (signal?.aborted) throw new SearxngClientError('caller-abort', 'SearXNG search aborted')
    const snapshot = this.snapshot()
    if (!snapshot.pool.every(isValidSearxngBaseUrl)) {
      throw new SearxngClientError('invalid-url', 'SearXNG base URL is invalid')
    }
    const key = cacheKey(snapshot, query)
    const cached = this.readCached(snapshot, key)
    if (cached !== undefined) return structuredClone(cached)

    const deadlineAt = Date.now() + snapshot.totalBudgetMs
    const limits: PacerLimits = {
      intervalMs: snapshot.minIntervalMs,
      queueCapacity: snapshot.queueCapacity,
    }
    let lastFailure: SearxngClientError | undefined
    let rateLimitBackoffUsed = false
    let pacingEndpoint: string | undefined
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) throw lastFailure ?? budgetExpired()
      const endpoint = this.selectEndpoint(snapshot)
      // Pacing is per endpoint: a failover attempt waits only on the endpoint it
      // targets, and same-endpoint retries keep the slot acquired for attempt 1.
      if (endpoint !== pacingEndpoint) {
        await this.pacerFor(endpoint, snapshot)?.acquire(limits, deadlineAt, signal)
        pacingEndpoint = endpoint
      }
      let outcome: Awaited<ReturnType<typeof requestJsonWithRetry>>
      try {
        outcome = await requestJsonWithRetry({
          url: buildSearchUrl(endpoint, buildSearxngSearchParams(snapshot.options, query)),
          headers: searxngRequestHeaders(snapshot.options),
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: Math.max(1, Math.min(snapshot.perAttemptTimeoutMs, Math.ceil(remaining))),
          maxAttempts: 1,
          ...(snapshot.options.fetch === undefined ? {} : { fetch: snapshot.options.fetch }),
        })
      } catch (error) {
        if (!(error instanceof SearxngClientError)) throw error
        if (error.kind !== 'timeout' && error.kind !== 'network') throw error
        lastFailure = error
        this.recordFailure(endpoint)
        if (attempt === MAX_ATTEMPTS) throw error
        const delay = Math.min(snapshot.retryDelayMs, deadlineAt - Date.now() - 1)
        if (delay <= 0) throw error
        await abortableDelay(delay, signal)
        continue
      }

      if (outcome.response.ok) {
        if (!isSearxngSearchResponse(outcome.payload)) {
          throw new SearxngClientError('contract', 'SearXNG returned an unprocessable response body')
        }
        const mapped = mapSearxngClientResponse(outcome.payload)
        this.recordSuccess(endpoint)
        this.writeCached(snapshot, key, mapped)
        return mapped
      }

      const status = outcome.response.status
      lastFailure = new SearxngClientError('http', `SearXNG search failed with HTTP ${status}`, status)
      const retryableStatus = RETRYABLE_STATUSES.has(status)
      const rateLimited = status === 429 && !rateLimitBackoffUsed
      if (!retryableStatus && !rateLimited) throw lastFailure
      this.recordFailure(endpoint)
      let delay = snapshot.retryDelayMs
      if (status === 429) {
        rateLimitBackoffUsed = true
        delay = parseRetryAfterMs(outcome.response.headers.get('retry-after'))
          ?? Math.max(delay, DEFAULT_BACKOFF_AFTER_RATE_LIMIT_MS)
      }
      // Never retry earlier than Retry-After; a delay that no longer fits in
      // the budget returns the failure instead of starting another attempt.
      if (delay >= deadlineAt - Date.now()) throw lastFailure
      await abortableDelay(delay, signal)
    }
    throw lastFailure ?? budgetExpired()
  }

  /**
   * Resolve and validate one operation's settings. A misconfigured knob is a
   * typed `config` failure rather than a constructor-time throw: volatile
   * settings can change after the plugin mounted, and a settings edit must
   * surface as an actionable search error instead of killing the provider.
   */
  private snapshot(): SessionSnapshot {
    const options = this.resolveOptions()
    if (options === null || typeof options !== 'object') {
      throw new SearxngClientError('config', 'SearXNG provider options must be an object')
    }
    const cacheTtlMs = requireIntegerSetting(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 'cacheTtlMs')
    const cacheCapacity = requireIntegerSetting(options.cacheCapacity, DEFAULT_CACHE_CAPACITY, 1, 'cacheCapacity')
    const minIntervalMs = requireIntegerSetting(options.minIntervalMs, DEFAULT_MIN_INTERVAL_MS, 0, 'minIntervalMs')
    const queueCapacity = requireIntegerSetting(options.queueCapacity, DEFAULT_QUEUE_CAPACITY, 1, 'queueCapacity')
    const totalBudgetMs = requireIntegerSetting(options.totalBudgetMs, DEFAULT_TOTAL_BUDGET_MS, 1, 'totalBudgetMs')
    let pool: string[]
    try {
      pool = resolveEndpointPool(options)
    } catch (error) {
      throw new SearxngClientError(
        'config',
        error instanceof Error ? error.message : 'baseURLs is invalid',
        undefined,
        { cause: error },
      )
    }
    return {
      options,
      pool,
      cacheTtlMs,
      cacheCapacity,
      minIntervalMs,
      queueCapacity,
      totalBudgetMs,
      perAttemptTimeoutMs: options.timeoutMs ?? 10_000,
      retryDelayMs: options.retryDelayMs ?? 100,
    }
  }

  /**
   * The bucket for one endpoint, or `undefined` when pacing is off. Buckets are
   * per endpoint (a failover attempt waits only on the endpoint it targets) and
   * live for the instance, so an unrelated settings edit never restarts the
   * pacing window; only the limits are re-read per admission.
   */
  private pacerFor(endpoint: string, snapshot: SessionSnapshot): Pacer | undefined {
    if (snapshot.minIntervalMs === 0) return undefined
    const existing = this.pacers.get(endpoint)
    if (existing !== undefined) return existing
    const created = new Pacer()
    this.pacers.set(endpoint, created)
    return created
  }

  /**
   * Lowest quantized effective penalty wins; ties resolve to pool order, so the
   * primary is sticky and regains the first slot once its penalty decays below
   * the epsilon (about two half-lives after its last failure).
   */
  private selectEndpoint(snapshot: SessionSnapshot): string {
    let best: string | undefined
    let bestScore = Number.POSITIVE_INFINITY
    for (const endpoint of snapshot.pool) {
      const score = this.effectivePenalty(this.health.get(endpoint))
      if (score < bestScore) {
        best = endpoint
        bestScore = score
      }
    }
    // resolveEndpointPool always yields at least one entry; the guard only
    // satisfies the index-access type.
    if (best === undefined) throw new SearxngClientError('invalid-url', 'SearXNG base URL is invalid')
    return best
  }

  private effectivePenalty(health: EndpointHealth | undefined): number {
    if (health === undefined || health.penalty === 0) return 0
    const elapsed = Date.now() - health.lastFailureAt
    const effective = health.penalty * 2 ** (-elapsed / HEALTH_HALF_LIFE_MS)
    return effective < HEALTH_EPSILON ? 0 : effective
  }

  private recordFailure(endpoint: string): void {
    // Health outlives a settings edit, so an endpoint first seen under a new
    // pool starts from a clean record here rather than a pre-seeded one.
    const health = this.health.get(endpoint) ?? { penalty: 0, lastFailureAt: 0 }
    health.penalty += 1
    health.lastFailureAt = Date.now()
    this.health.set(endpoint, health)
  }

  private recordSuccess(endpoint: string): void {
    const health = this.health.get(endpoint)
    if (health === undefined) return
    health.penalty = 0
  }

  private readCached(snapshot: SessionSnapshot, key: string): SearxngClientResult | undefined {
    if (snapshot.cacheTtlMs === 0) return undefined
    const entry = this.cache.get(key)
    if (entry === undefined) return undefined
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    // Re-insert so eviction order tracks recency of use, not just insertion.
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value
  }

  private writeCached(snapshot: SessionSnapshot, key: string, value: SearxngClientResult): void {
    if (snapshot.cacheTtlMs === 0) return
    // An empty page is a success but carries no reusable information; caching
    // it would mask upstream recovery for the whole TTL (observed in the
    // 2026-09-11 evaluation: a cooled-down instance served stale empties).
    if (value.sources.length === 0) return
    this.cache.delete(key)
    this.cache.set(key, { expiresAt: Date.now() + snapshot.cacheTtlMs, value })
    while (this.cache.size > snapshot.cacheCapacity) {
      const oldest = this.cache.keys().next()
      if (oldest.done === true) break
      this.cache.delete(oldest.value)
    }
  }
}

/**
 * Cache identity: the exact query text (syntax and case preserved), every
 * resolved request-shaping option, and the pool. One pool serves equivalent
 * content, so entries are shared across its endpoints, not per endpoint.
 */
function cacheKey(snapshot: SessionSnapshot, query: string): string {
  return JSON.stringify([
    snapshot.pool,
    snapshot.options.language ?? '',
    snapshot.options.engines ?? '',
    snapshot.options.categories ?? '',
    query,
  ])
}

/** Validate one numeric knob from the current section; `minimum` is inclusive. */
function requireIntegerSetting(value: number | undefined, fallback: number, minimum: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    const bound = minimum === 0 ? 'a non-negative safe integer' : `a positive safe integer`
    throw new SearxngClientError('config', `${name} must be ${bound}`)
  }
  return resolved
}

function budgetExpired(): SearxngClientError {
  return new SearxngClientError('budget', 'SearXNG search budget expired before a network attempt')
}

/** Parse a `Retry-After` header carrying delay seconds; other forms fall back to the default. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined
  return Number.parseInt(value.trim(), 10) * 1_000
}
