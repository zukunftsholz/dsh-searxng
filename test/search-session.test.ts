import { afterEach, describe, expect, it, vi } from 'vitest'
import { SearxngSearchSession } from '../src/search-session.ts'
import type { SearxngSearchSessionOptions } from '../src/search-session.ts'

const BASE = 'http://127.0.0.1:8080'

/**
 * Build a session over one fixed options value. The real plugin passes a
 * resolver that re-reads the volatile settings section on every operation; the
 * tests that care about that pass `() => ...` with a mutable holder directly.
 */
function createSession(options: SearxngSearchSessionOptions): SearxngSearchSession {
  return new SearxngSearchSession(() => options)
}

/**
 * A `fetch` mock typed as the global one, returning a FRESH Response per call:
 * one shared instance would have its body consumed by the first `json()` read.
 */
function jsonFetch(body: unknown = RESULT): ReturnType<typeof vi.fn> & typeof globalThis.fetch {
  return vi.fn(async (_url: string) => jsonResponse(body)) as unknown as
    ReturnType<typeof vi.fn> & typeof globalThis.fetch
}

/** Real-time pause for the two pacing tests, which deliberately avoid fake clocks. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const RESULT = { results: [{ url: 'https://example.com/r', title: 'R', content: 'S' }] }

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('SearxngSearchSession cache', () => {
  it('serves a repeated query from cache without a second fetch', async () => {
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = createSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await session.search('same query', undefined)
    await session.search('same query', undefined)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not serve a different query, params, or base URL from the cache', async () => {
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = createSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await session.search('a', undefined)
    await session.search('b', undefined)
    const other = createSession({ baseURL: BASE, fetch, engines: 'bing', cacheTtlMs: 60_000, minIntervalMs: 0 })
    await other.search('a', undefined)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = createSession({ baseURL: BASE, fetch, cacheTtlMs: 1_000, minIntervalMs: 0 })
    await session.search('q', undefined)
    vi.advanceTimersByTime(1_001)
    await session.search('q', undefined)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('evicts the least recently used entry beyond capacity', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = createSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, cacheCapacity: 2, minIntervalMs: 0 })
    await session.search('q1', undefined)
    await session.search('q2', undefined)
    await session.search('q1', undefined)
    await session.search('q3', undefined)
    await session.search('q2', undefined)
    // q1's hit refreshed its recency, so q2 is the eviction victim and the
    // final search refetches it: a pure FIFO cache would serve q2 and stop at 3.
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('rejects an already-aborted caller without fetch, even on a cache hit', async () => {
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = createSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await session.search('q', undefined)
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(session.search('q', controller.signal)).rejects.toMatchObject({ kind: 'caller-abort' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('disables caching when cacheTtlMs is 0', async () => {
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = createSession({ baseURL: BASE, fetch, cacheTtlMs: 0, minIntervalMs: 0 })
    await session.search('q', undefined)
    await session.search('q', undefined)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache an empty result page', async () => {
    const fetch = vi.fn(async () => jsonResponse({ results: [] }))
    const session = createSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await session.search('q', undefined)
    await session.search('q', undefined)
    // An empty page is a success but carries no reusable information; caching
    // it would mask upstream recovery for the whole TTL.
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache failures', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(jsonResponse(RESULT))
    const session = createSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await expect(session.search('q', undefined)).rejects.toMatchObject({ kind: 'http', status: 403 })
    await expect(session.search('q', undefined)).resolves.toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects an invalid base URL before any cache or fetch work', async () => {
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = createSession({ baseURL: 'http://user:pass@x', fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await expect(session.search('q', undefined)).rejects.toMatchObject({ kind: 'invalid-url' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('SearxngSearchSession pacing', () => {
  function pendingFetch(): { fetch: ReturnType<typeof vi.fn>; release: () => void } {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = vi.fn(async () => {
      await gate
      return jsonResponse(RESULT)
    })
    return { fetch, release }
  }

  it('admits a burst up to bucket capacity immediately', async () => {
    vi.useFakeTimers()
    const { fetch } = pendingFetch()
    const session = createSession({ baseURL: BASE, fetch, minIntervalMs: 1_500 })
    void session.search('one', undefined)
    void session.search('two', undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('paces a third concurrent request until a token refills', async () => {
    vi.useFakeTimers()
    const { fetch } = pendingFetch()
    const session = createSession({ baseURL: BASE, fetch, minIntervalMs: 1_500 })
    void session.search('one', undefined)
    void session.search('two', undefined)
    void session.search('three', undefined)
    await vi.advanceTimersByTimeAsync(1_499)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('rejects immediately when the waiting queue is full', async () => {
    vi.useFakeTimers()
    const { fetch } = pendingFetch()
    const session = createSession({ baseURL: BASE, fetch, minIntervalMs: 1_500, queueCapacity: 1 })
    void session.search('one', undefined)
    void session.search('two', undefined)
    void session.search('three', undefined)
    await expect(session.search('four', undefined)).rejects.toMatchObject({ kind: 'busy' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects a queued caller on abort and frees its queue slot', async () => {
    vi.useFakeTimers()
    const { fetch } = pendingFetch()
    const session = createSession({ baseURL: BASE, fetch, minIntervalMs: 1_500, queueCapacity: 1 })
    void session.search('one', undefined)
    void session.search('two', undefined)
    const controller = new AbortController()
    const queued = session.search('three', controller.signal)
    void queued.catch(() => {})
    controller.abort(new Error('stop'))
    await expect(queued).rejects.toMatchObject({ kind: 'caller-abort' })
    // The freed slot admits a new waiter instead of rejecting it as busy.
    const next = session.search('four', undefined)
    void next.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    await expect(Promise.race([next.then(() => 'settled'), Promise.resolve('waiting')])).resolves.toBe('waiting')
  })

  it('runs concurrent searches unpaced when minIntervalMs is 0', async () => {
    vi.useFakeTimers()
    const { fetch } = pendingFetch()
    const session = createSession({ baseURL: BASE, fetch, minIntervalMs: 0 })
    for (const query of ['a', 'b', 'c', 'd', 'e']) void session.search(query, undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(5)
  })
})

describe('SearxngSearchSession budget', () => {
  it('clamps the per-attempt timeout to the remaining budget', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(() => new Promise<Response>(() => {}))
    const session = createSession({
      baseURL: BASE, fetch, minIntervalMs: 0, totalBudgetMs: 500,
    })
    const attempt = session.search('q', undefined)
    void attempt.catch(() => {})
    await vi.advanceTimersByTimeAsync(499)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(attempt).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('does not retry when Retry-After exceeds the remaining budget', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => new Response('slow down', {
      status: 429,
      headers: { 'retry-after': '30' },
    }))
    const session = createSession({
      baseURL: BASE, fetch, minIntervalMs: 0, totalBudgetMs: 1_000,
    })
    await expect(session.search('q', undefined)).rejects.toMatchObject({ kind: 'http', status: 429 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('honors Retry-After within budget and retries once', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(jsonResponse(RESULT))
    const session = createSession({
      baseURL: BASE, fetch, minIntervalMs: 0, totalBudgetMs: 10_000,
    })
    const attempt = session.search('q', undefined)
    void attempt.catch(() => {})
    await vi.advanceTimersByTimeAsync(999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(attempt).resolves.toMatchObject({ truncated: false })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('exhausts the budget during the pacing wait without any network attempt', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = vi.fn(async () => {
      await gate
      return jsonResponse(RESULT)
    })
    const session = createSession({
      baseURL: BASE, fetch, minIntervalMs: 5_000, totalBudgetMs: 1_000, cacheTtlMs: 0,
    })
    void session.search('one', undefined).catch(() => {})
    void session.search('two', undefined).catch(() => {})
    const third = session.search('three', undefined)
    void third.catch(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(third).rejects.toMatchObject({ kind: 'budget' })
    expect(fetch).toHaveBeenCalledTimes(2)
    release()
  })

  it('caps total attempts at three under repeated 5xx within budget', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => new Response('bad gateway', { status: 503 }))
    const session = createSession({
      baseURL: BASE, fetch, minIntervalMs: 0, retryDelayMs: 100, totalBudgetMs: 60_000, cacheTtlMs: 0,
    })
    const attempt = session.search('q', undefined)
    void attempt.catch(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(attempt).rejects.toMatchObject({ kind: 'http', status: 503 })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('retries a network failure within budget and succeeds', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(RESULT))
    const session = createSession({
      baseURL: BASE, fetch, minIntervalMs: 0, retryDelayMs: 100, cacheTtlMs: 0,
    })
    const attempt = session.search('q', undefined)
    void attempt.catch(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(attempt).resolves.toMatchObject({ truncated: false })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

const BASE_B = 'http://127.0.0.1:8081'

function poolSession(fetch: unknown, options: Record<string, unknown> = {}) {
  return createSession({
    baseURL: BASE,
    baseURLs: [BASE, BASE_B],
    fetch: fetch as typeof globalThis.fetch,
    minIntervalMs: 0,
    retryDelayMs: 1,
    ...options,
  })
}

describe('SearxngSearchSession failover', () => {
  it('fails over to the secondary endpoint on a network failure', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE)) throw new TypeError('fetch failed')
      return jsonResponse(RESULT)
    })
    const result = await poolSession(fetch).search('q', undefined)
    expect(result.sources.length).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toContain(BASE_B)
  })

  it('fails over after a retryable HTTP status', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith(BASE) ? jsonResponse({}, 502) : jsonResponse(RESULT))
    const result = await poolSession(fetch).search('q', undefined)
    expect(result.sources.length).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toContain(BASE_B)
  })

  it('fails over after a rate limit once Retry-After fits the budget', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith(BASE)
        ? new Response(JSON.stringify({}), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '0' },
          })
        : jsonResponse(RESULT))
    const result = await poolSession(fetch).search('q', undefined)
    expect(result.sources.length).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toContain(BASE_B)
  })

  it('does not fail over on a non-retryable HTTP status', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith(BASE) ? jsonResponse({}, 403) : jsonResponse(RESULT))
    await expect(poolSession(fetch).search('q', undefined)).rejects.toMatchObject({ kind: 'http', status: 403 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not fail over on an unprocessable response body', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith(BASE)
        ? new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })
        : jsonResponse(RESULT))
    await expect(poolSession(fetch).search('q', undefined)).rejects.toMatchObject({ kind: 'contract' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('throws the last failure after exhausting attempts across the pool', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE)) throw new TypeError('fetch failed')
      return jsonResponse({}, 502)
    })
    await expect(poolSession(fetch).search('q', undefined)).rejects.toMatchObject({ kind: 'network' })
    expect(fetch).toHaveBeenCalledTimes(3)
    // Both endpoints carry fresh penalties; the pool-order tie goes to the primary.
    expect(fetch.mock.calls[2]?.[0]).toContain(BASE)
  })

  it('steers the next search away from a failing primary until it recovers', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE)) throw new TypeError('fetch failed')
      return jsonResponse(RESULT)
    })
    const session = poolSession(fetch)
    await session.search('one', undefined)
    await session.search('two', undefined)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls[2]?.[0]).toContain(BASE_B)
  })

  it('returns to the primary after its health penalty decays', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE)) throw new TypeError('fetch failed')
      return jsonResponse(RESULT)
    })
    const session = poolSession(fetch)
    const first = session.search('one', undefined)
    await vi.advanceTimersByTimeAsync(10)
    await first
    vi.advanceTimersByTime(65_000)
    const second = session.search('two', undefined)
    await vi.advanceTimersByTimeAsync(10)
    await second
    expect(fetch.mock.calls[2]?.[0]).toContain(BASE)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('serves a repeat query from the pool cache when the serving endpoint died', async () => {
    let primaryUp = true
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE) && !primaryUp) throw new TypeError('fetch failed')
      return jsonResponse(RESULT)
    })
    const session = poolSession(fetch, { cacheTtlMs: 60_000 })
    await session.search('same', undefined)
    primaryUp = false
    const again = await session.search('same', undefined)
    expect(again.sources.length).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('waits on the selected endpoint bucket, not the primary one, when steering', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE)) throw new TypeError('fetch failed')
      return jsonResponse(RESULT)
    })
    const session = createSession({
      baseURL: BASE,
      baseURLs: [BASE, BASE_B],
      fetch: fetch as typeof globalThis.fetch,
      minIntervalMs: 1_500,
      retryDelayMs: 1,
    })
    const one = session.search('one', undefined)
    await vi.advanceTimersByTimeAsync(10)
    await one
    // The primary stays penalized, so both follow-ups select the secondary and
    // pace on its bucket: the second waits for its refill, never for the
    // primary's.
    await session.search('two', undefined)
    const three = session.search('three', undefined)
    await vi.advanceTimersByTimeAsync(2_000)
    await three
    const urls = fetch.mock.calls.map((call) => String(call[0]))
    expect(urls[0]).toContain(BASE)
    expect(urls.slice(1).every((url) => url.startsWith(BASE_B))).toBe(true)
  })
})

describe('SearxngSearchSession volatile options', () => {
  it('resolves the options for each search, so a changed section takes effect immediately', async () => {
    const fetch = jsonFetch()
    let section: SearxngSearchSessionOptions = {
      baseURL: BASE, fetch, minIntervalMs: 0, cacheTtlMs: 0, language: 'en',
    }
    const session = new SearxngSearchSession(() => section)

    await session.search('q', undefined)
    section = { ...section, language: 'zh-CN' }
    await session.search('q', undefined)

    const first = new URL(fetch.mock.calls[0]![0])
    const second = new URL(fetch.mock.calls[1]![0])
    expect(first.searchParams.get('language')).toBe('en')
    expect(second.searchParams.get('language')).toBe('zh-CN')
  })

  it('resolves exactly once per search, so one operation never straddles two sections', async () => {
    let resolutions = 0
    let section!: SearxngSearchSessionOptions
    const fetch = vi.fn(async (_url: string) => {
      // A save landing mid-flight must not retarget a request already in
      // progress, nor the retry that follows it.
      section = { ...section, language: 'ja' }
      return jsonResponse(RESULT)
    }) as unknown as ReturnType<typeof vi.fn> & typeof globalThis.fetch
    section = { baseURL: BASE, fetch, minIntervalMs: 0, cacheTtlMs: 0, language: 'en' }
    const session = new SearxngSearchSession(() => {
      resolutions += 1
      return section
    })

    await session.search('q', undefined)

    expect(resolutions).toBe(1)
    const requested = new URL(fetch.mock.calls[0]![0])
    expect(requested.searchParams.get('language')).toBe('en')
  })

  it('keeps the cache a pure function of the request-shaping options across a settings edit', async () => {
    const fetch = jsonFetch()
    let section: SearxngSearchSessionOptions = {
      baseURL: BASE, fetch, minIntervalMs: 0, cacheTtlMs: 60_000,
    }
    const session = new SearxngSearchSession(() => section)

    await session.search('same', undefined)
    section = { ...section, engines: 'bing' }
    await session.search('same', undefined)
    // The edit changes the request shape, so this is a different request and
    // must not be served from the entry written under the old section.
    expect(fetch).toHaveBeenCalledTimes(2)

    // An edit that does NOT change the request shape keeps the entry usable.
    section = { ...section, cacheTtlMs: 120_000 }
    await session.search('same', undefined)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reports a knob a later edit made invalid as a config failure instead of throwing from the constructor', async () => {
    const fetch = jsonFetch()
    let section: SearxngSearchSessionOptions = {
      baseURL: BASE, fetch, minIntervalMs: 0, cacheTtlMs: 0,
    }
    const session = new SearxngSearchSession(() => section)
    await expect(session.search('q', undefined)).resolves.toBeTruthy()

    section = { ...section, totalBudgetMs: 0 }
    await expect(session.search('q', undefined)).rejects.toMatchObject({ kind: 'config' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects only the misconfigured pool entry shape without losing the good searches', async () => {
    const fetch = jsonFetch()
    let section: SearxngSearchSessionOptions = {
      baseURL: BASE, baseURLs: [BASE], fetch, minIntervalMs: 0, cacheTtlMs: 0,
    }
    const session = new SearxngSearchSession(() => section)
    await expect(session.search('q', undefined)).resolves.toBeTruthy()

    section = { ...section, baseURLs: ['not a url'] }
    await expect(session.search('q2', undefined)).rejects.toMatchObject({ kind: 'invalid-url' })

    section = { ...section, baseURLs: [BASE] }
    await expect(session.search('q3', undefined)).resolves.toBeTruthy()
  })

  // These two use REAL timers at a small interval rather than fake ones: a
  // search parked on an unresolved fetch never settles, so `advanceTimersByTime`
  // cannot make progress and the test hangs until vitest's timeout. Asserting
  // real wall-clock admission is both faster and closer to the behaviour that
  // matters (when the request reaches the network).
  it('re-reads the pacing limits per admission without restarting the bucket', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = vi.fn(async () => {
      await gate
      return jsonResponse(RESULT)
    })
    let section: SearxngSearchSessionOptions = { baseURL: BASE, fetch, minIntervalMs: 150, cacheTtlMs: 0 }
    const session = new SearxngSearchSession(() => section)

    void session.search('one', undefined).catch(() => {})
    void session.search('two', undefined).catch(() => {})
    await delay(20)
    expect(fetch).toHaveBeenCalledTimes(2)

    // Capacity 2 with no refill yet. The queue cap is read live, so lowering it
    // to 1 makes the next caller reject as busy rather than the bucket handing
    // out a fresh burst.
    section = { ...section, queueCapacity: 1 }
    const three = session.search('three', undefined)
    void three.catch(() => {})
    await delay(10)
    await expect(session.search('four', undefined)).rejects.toMatchObject({ kind: 'busy' })
    expect(fetch).toHaveBeenCalledTimes(2)

    // `three` queued under the old cap, so it survives the edit and admits
    // once a token refills. Its own fetch is still parked on the gate, so
    // assert admission (the call count), not settlement.
    await delay(300)
    expect(fetch).toHaveBeenCalledTimes(3)

    release()
    await three
  })

  it('honors a raised minIntervalMs on the next search without a new burst', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = vi.fn(async () => {
      await gate
      return jsonResponse(RESULT)
    })
    let section: SearxngSearchSessionOptions = { baseURL: BASE, fetch, minIntervalMs: 150, cacheTtlMs: 0 }
    const session = new SearxngSearchSession(() => section)

    void session.search('one', undefined).catch(() => {})
    void session.search('two', undefined).catch(() => {})
    await delay(20)
    expect(fetch).toHaveBeenCalledTimes(2)

    // Raising the spacing must slow the next admission to the NEW interval, not
    // to the old one: the bucket is kept, so the extra wait is real.
    section = { ...section, minIntervalMs: 400 }
    const three = session.search('three', undefined)
    void three.catch(() => {})
    await delay(280)
    expect(fetch).toHaveBeenCalledTimes(2)
    await delay(200)
    expect(fetch).toHaveBeenCalledTimes(3)

    release()
    await three
  })
})
