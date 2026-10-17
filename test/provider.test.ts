import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  Config,
  DEFAULT_SEARXNG_MODE,
  apply,
  describeSearxngProfile,
} from '../src/index.ts'
import {
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
  mapSearxngResponse,
  mapSearxngResult,
} from '../src/provider.ts'
import type { SearxngSearchProviderOptions } from '../src/provider.ts'
import type { SearxngResult } from '../src/types.ts'

const BASE = 'http://127.0.0.1:8080'

/**
 * Build a provider over one fixed options value. The real plugin passes a
 * resolver that re-reads the volatile settings section on every operation; the
 * tests that care about that pass `new SearxngSearchProvider(() => ...)` with a
 * mutable holder directly.
 */
function createProvider(options: SearxngSearchProviderOptions): SearxngSearchProvider {
  return new SearxngSearchProvider(() => options)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function inspectErrorChain(value: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current = value
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const record = current as Record<string, unknown>
    parts.push(String(record.name ?? ''))
    parts.push(String(record.message ?? ''))
    parts.push(JSON.stringify(current))
    current = record.cause
  }
  return parts.join('\n')
}

function responseWithCountedCancellation(
  status: number,
  onCancel: () => void,
  cancelFailure?: Error,
): Response {
  const body = new ReadableStream({
    cancel() {
      onCancel()
      if (cancelFailure !== undefined) throw cancelFailure
    },
  })
  return new Response(body, { status })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('mapSearxngResult', () => {
  it('maps a full entry to url/title/snippet/publishedAt', () => {
    const entry: SearxngResult = {
      url: 'https://example.com/a',
      title: 'A result',
      content: 'A snippet',
      engine: 'google',
      score: 1.5,
      publishedDate: '2026-01-02T03:04:05Z',
    }
    expect(mapSearxngResult(entry)).toEqual({
      url: 'https://example.com/a',
      title: 'A result',
      snippet: 'A snippet',
      publishedAt: '2026-01-02T03:04:05Z',
    })
  })

  it('keeps an entry with only url and title (seam allows URL-only sources)', () => {
    const entry: SearxngResult = { url: 'https://example.com/b', title: 'B', content: '' }
    expect(mapSearxngResult(entry)).toEqual({ url: 'https://example.com/b', title: 'B' })
  })

  it('keeps an entry with only a url', () => {
    expect(mapSearxngResult({ url: 'https://example.com/c', title: null, content: null })).toEqual({
      url: 'https://example.com/c',
    })
  })

  it('drops an entry without a url', () => {
    expect(mapSearxngResult({ title: 'orphan', content: 'no url' })).toBeUndefined()
    expect(mapSearxngResult({ url: '', title: 'empty url' })).toBeUndefined()
    expect(mapSearxngResult({ url: null })).toBeUndefined()
  })

  it('drops blank-only fields instead of inventing them', () => {
    expect(mapSearxngResult({ url: 'https://example.com/d', title: '  ', content: ' \t ' })).toEqual({
      url: 'https://example.com/d',
    })
  })
})

describe('mapSearxngResponse', () => {
  it('maps results and reports truncated: false (the seam owns truncation)', () => {
    const result = mapSearxngResponse({
      query: 'q',
      results: [
        { url: 'https://example.com/1', title: '1', content: 's1' },
        { title: 'no url' },
      ],
      number_of_results: 42,
    })
    expect(result).toEqual({
      sources: [{ url: 'https://example.com/1', title: '1', snippet: 's1' }],
      truncated: false,
    })
  })

  it('tolerates a missing results array', () => {
    expect(mapSearxngResponse({ query: 'q' })).toEqual({ sources: [], truncated: false })
  })
})

describe('SearxngSearchProvider', () => {
  it('registers under the stable searxng id', () => {
    expect(createProvider({ baseURL: BASE }).id).toBe(SEARXNG_PROVIDER_ID)
  })

  describe('available', () => {
    it('is true for an absolute base URL', () => {
      expect(createProvider({ baseURL: BASE }).available()).toBe(true)
    })

    it('is false without a base URL or with a relative one', () => {
      expect(createProvider({ baseURL: '' }).available()).toBe(false)
      expect(createProvider({ baseURL: 'localhost:8080' }).available()).toBe(false)
    })

    it.each([`${BASE}?x=1`, `${BASE}#section`])(
      'is false when the base URL contains a query or fragment: %s',
      (baseURL) => {
        expect(createProvider({ baseURL }).available()).toBe(false)
      },
    )

    it('is false when the base URL contains credentials', () => {
      expect(createProvider({ baseURL: 'http://user:pass@localhost:8080' }).available()).toBe(false)
    })
  })

  describe('search', () => {
    it('rejects an unsafe base URL without making a request', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await expect(createProvider({ baseURL: 'http://user:pass@localhost:8080' }).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([
      [`${BASE}/`, `${BASE}/search`],
      [`${BASE}/searxng`, `${BASE}/searxng/search`],
      [`${BASE}/searxng/`, `${BASE}/searxng/search`],
    ])('normalizes the base URL %s', async (baseURL, expectedPath) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)

      await createProvider({ baseURL }).search({ query: 'q' })

      const requested = new URL(fetchMock.mock.calls[0]![0] as string)
      expect(requested.origin + requested.pathname).toBe(expectedPath)
    })

    it('requests the JSON format with query and optional filters', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ results: [{ url: 'https://example.com/1', content: 's' }] }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const provider = createProvider({
        baseURL: BASE,
        language: 'zh-CN',
        engines: 'bing,duckduckgo',
        categories: 'general',
      })
      const result = await provider.search({ query: '你好 world' })

      expect(result.sources).toEqual([{ url: 'https://example.com/1', snippet: 's' }])
      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
      const parsed = new URL(url)
      expect(parsed.origin + parsed.pathname).toBe(`${BASE}/search`)
      expect(parsed.searchParams.get('q')).toBe('你好 world')
      expect(parsed.searchParams.get('format')).toBe('json')
      expect(parsed.searchParams.get('language')).toBe('zh-CN')
      expect(parsed.searchParams.get('engines')).toBe('bing,duckduckgo')
      expect(parsed.searchParams.get('categories')).toBe('general')
      expect(init.method).toBe('GET')
      expect((init.headers as Record<string, string>)['accept']).toBe('application/json')
    })

    it('omits filter parameters when unconfigured', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)

      await createProvider({ baseURL: BASE }).search({ query: 'q', maxResults: 3 })

      const parsed = new URL(fetchMock.mock.calls[0]![0] as string)
      expect(parsed.searchParams.has('language')).toBe(false)
      expect(parsed.searchParams.has('engines')).toBe(false)
      expect(parsed.searchParams.has('categories')).toBe(false)
    })

    it('sends the configured authorization header verbatim', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)

      await createProvider({ baseURL: BASE, authHeader: 'Bearer tok' }).search({ query: 'q' })

      const init = fetchMock.mock.calls[0]![1] as RequestInit
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok')
    })

    it('links the caller abort signal to the request', async () => {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))
      vi.stubGlobal('fetch', fetchMock)
      const controller = new AbortController()

      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' }, controller.signal)
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      controller.abort()

      await expect(attempt).rejects.toMatchObject({ code: 'WEB_ABORTED' })
      expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).not.toBe(controller.signal)
      expect((fetchMock.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true)
    })

    it.each([
      [403, /JSON format|search\.formats/],
      [429, /rate limit/i],
      [502, /HTTP 502/],
    ])('maps HTTP %i to a WEB_PROVIDER_ERROR with guidance', async (status, pattern) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status })))

      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' })
      await expect(attempt).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(WebError)
        expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
        expect((error as WebError).message).toMatch(pattern)
        return true
      })
    })

    it('maps a network failure to WEB_PROVIDER_ERROR with a redacted cause that leaks no request state', async () => {
      const privateQuery = 'private provider query'
      const credential = 'Bearer credential-secret'
      const nested = new Error(`request http://localhost/search?q=${encodeURIComponent(privateQuery)} authorization=${credential}`)
      const cause = new TypeError('fetch failed', { cause: nested })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause))

      const attempt = createProvider({ baseURL: BASE, authHeader: credential }).search({ query: privateQuery })
      await expect(attempt).rejects.toSatisfy((error: unknown) => {
        expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
        // The failure class is chained for diagnosability (WebError gained
        // `cause` chaining), but the copy drops the raw chain: the fetch
        // TypeError's message carries the request URL and authorization header.
        expect((error as WebError).cause).toMatchObject({ name: 'SearxngClientError', kind: 'network' })
        expect((error as WebError).cause).not.toBe(cause)
        const visible = inspectErrorChain(error)
        expect(visible).not.toContain(privateQuery)
        expect(visible).not.toContain(encodeURIComponent(privateQuery))
        expect(visible).not.toContain(credential)
        expect(visible).not.toContain('fetch failed')
        return true
      })
    })

    it('retries one transient transport failure and then succeeds', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValueOnce(jsonResponse({ results: [{ url: 'https://example.com/ok' }] }))
      vi.stubGlobal('fetch', fetchMock)

      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' })
      await vi.runAllTimersAsync()

      await expect(attempt).resolves.toMatchObject({ sources: [{ url: 'https://example.com/ok' }] })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('cancels during the retry delay and cleans up the delay timer', async () => {
      vi.useFakeTimers()
      const controller = new AbortController()
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
      vi.stubGlobal('fetch', fetchMock)
      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' }, controller.signal)
      const expectation = expect(attempt).rejects.toMatchObject({ code: 'WEB_ABORTED' })
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await expectation
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      vi.useRealTimers()
    })

    it.each([502, 503, 504])('retries HTTP %i once and then succeeds', async (status) => {
      vi.useFakeTimers()
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('temporary', { status }))
        .mockResolvedValueOnce(jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)

      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' })
      await vi.runAllTimersAsync()

      await expect(attempt).resolves.toMatchObject({ sources: [] })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('cancels a transient response body before retrying', async () => {
      vi.useFakeTimers()
      let cancellations = 0
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(responseWithCountedCancellation(502, () => { cancellations += 1 }))
        .mockResolvedValueOnce(jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)

      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' })
      await vi.runAllTimersAsync()

      await expect(attempt).resolves.toBeDefined()
      expect(cancellations).toBe(1)
    })

    it.each([401, 403, 429, 500])('cancels the final unused HTTP %i response body', async (status) => {
      let cancellations = 0
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        responseWithCountedCancellation(status, () => { cancellations += 1 }),
      ))

      await expect(createProvider({ baseURL: BASE }).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(cancellations).toBe(1)
    })

    it.each([502, 503, 504])('cancels every unused HTTP %i response after retry exhaustion', async (status) => {
      vi.useFakeTimers()
      let cancellations = 0
      const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
        responseWithCountedCancellation(status, () => { cancellations += 1 }),
      ))
      vi.stubGlobal('fetch', fetchMock)
      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' })
      const expectation = expect(attempt).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      await vi.runAllTimersAsync()
      await expectation
      expect(cancellations).toBe(3)
    })

    it('does not mask the primary HTTP failure when body cancellation rejects', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithCountedCancellation(
        401,
        () => {},
        new Error('private cancellation failure'),
      )))

      await expect(createProvider({ baseURL: BASE }).search({ query: 'q' }))
        .rejects.toSatisfy((error: unknown) => {
          expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
          expect((error as Error).message).toMatch(/HTTP 401/)
          expect(inspectErrorChain(error)).not.toContain('private cancellation failure')
          return true
        })
    })

    it('does not let a stalled body cancellation hide or delay the HTTP failure', async () => {
      vi.useFakeTimers()
      const response = new Response(new ReadableStream({
        cancel: () => new Promise<void>(() => {}),
      }), { status: 401 })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      let rejection: unknown
      void createProvider({ baseURL: BASE }).search({ query: 'q' }).catch((error: unknown) => {
        rejection = error
      })

      await vi.advanceTimersByTimeAsync(1)

      expect(rejection).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    })

    it('stops after three transient attempts', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
      vi.stubGlobal('fetch', fetchMock)
      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' })
      const expectation = expect(attempt).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      await vi.runAllTimersAsync()
      await expectation
      expect(fetchMock).toHaveBeenCalledTimes(3)
      vi.useRealTimers()
    })

    it.each([401, 403])('does not retry HTTP %i', async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('denied', { status }))
      vi.stubGlobal('fetch', fetchMock)
      await expect(createProvider({ baseURL: BASE }).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('retries HTTP 429 exactly once under the rate-limit backoff', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn().mockResolvedValue(new Response('denied', { status: 429 }))
      vi.stubGlobal('fetch', fetchMock)
      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' })
      const expectation = expect(attempt).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      await vi.runAllTimersAsync()
      await expectation
      expect(fetchMock).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('serves a repeated query from the provider cache without a second fetch', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [{ url: 'https://example.com/r' }] }))
      vi.stubGlobal('fetch', fetchMock)
      const provider = createProvider({ baseURL: BASE, minIntervalMs: 0 })
      await provider.search({ query: 'repeat me' }, undefined)
      await provider.search({ query: 'repeat me' }, undefined)
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('maps a full pacing queue to an actionable WEB_PROVIDER_ERROR', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
      vi.stubGlobal('fetch', fetchMock)
      const provider = createProvider({ baseURL: BASE, minIntervalMs: 1_500, queueCapacity: 1 })
      void provider.search({ query: 'one' }, undefined).catch(() => {})
      void provider.search({ query: 'two' }, undefined).catch(() => {})
      await vi.advanceTimersByTimeAsync(0)
      void provider.search({ query: 'three' }, undefined).catch(() => {})
      await expect(provider.search({ query: 'four' }, undefined)).rejects.toSatisfy((error: unknown) => {
        expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
        expect((error as Error).message).toMatch(/pacing/i)
        return true
      })
      vi.useRealTimers()
    })

    it('maps pacing budget exhaustion to an actionable WEB_PROVIDER_ERROR', async () => {
      vi.useFakeTimers()
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
      const provider = createProvider({ baseURL: BASE, minIntervalMs: 5_000, totalBudgetMs: 1_000 })
      void provider.search({ query: 'one' }, undefined).catch(() => {})
      void provider.search({ query: 'two' }, undefined).catch(() => {})
      const third = provider.search({ query: 'three' }, undefined)
      const expectation = expect(third).rejects.toSatisfy((error: unknown) => {
        expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
        expect((error as Error).message).toMatch(/budget/i)
        return true
      })
      await vi.advanceTimersByTimeAsync(1_100)
      await expectation
      vi.useRealTimers()
    })

    it('applies a finite default timeout even when fetch ignores abort', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
      vi.stubGlobal('fetch', fetchMock)
      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' })
      const expectation = expect(attempt).rejects.toSatisfy((error: unknown) => {
        expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
        expect((error as WebError).message).toMatch(/timed out/i)
        return true
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await expectation
      expect(fetchMock).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('cleans up the per-attempt timeout after a successful response', async () => {
      vi.useFakeTimers()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ results: [] })))
      await expect(createProvider({ baseURL: BASE }).search({ query: 'q' })).resolves.toBeDefined()
      expect(vi.getTimerCount()).toBe(0)
      vi.useRealTimers()
    })

    it('handles a synchronous fetch throw without an unhandled rejection', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn(() => { throw new TypeError('sync offline') })
      vi.stubGlobal('fetch', fetchMock)
      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' })
      const expectation = expect(attempt).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      await vi.runAllTimersAsync()
      await expectation
      expect(fetchMock).toHaveBeenCalledTimes(3)
      vi.useRealTimers()
    })

    it('does not retry malformed JSON or a non-JSON success', async () => {
      for (const response of [
        new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }),
        new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ]) {
        const fetchMock = vi.fn().mockResolvedValue(response)
        vi.stubGlobal('fetch', fetchMock)
        await expect(createProvider({ baseURL: BASE }).search({ query: 'q' }))
          .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
        expect(fetchMock).toHaveBeenCalledOnce()
      }
    })

    it.each([null, [], {}, { results: 'invalid' }])('rejects a malformed JSON contract without retrying', async (payload) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload))
      vi.stubGlobal('fetch', fetchMock)
      await expect(createProvider({ baseURL: BASE }).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it.each([
      { results: [null] },
      { results: ['primitive'] },
      { results: [{}] },
      { results: [{ url: null }] },
      { results: [{ url: '' }] },
      { results: [{ url: 'not a URL' }] },
      { results: [{ url: 'javascript:alert(1)' }] },
      { results: [{ url: 'https://example.com', title: 42 }] },
      { results: [{ url: 'https://example.com', content: {} }] },
      { results: [{ url: 'https://example.com', publishedDate: false }] },
      { results: [{ url: 'https://example.com', score: 'high' }] },
    ])('filters malformed result entries without throwing: $results', async ({ results }) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(createProvider({ baseURL: BASE }).search({ query: 'q' }))
        .resolves.toEqual({ sources: [], truncated: false })
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('retains valid results while filtering malformed neighbors', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
        results: [
          null,
          { url: 'javascript:alert(1)' },
          { url: 'https://example.com/ok', title: 'Kept' },
          { url: 'https://example.com/bad', title: 42 },
        ],
      })))

      await expect(createProvider({ baseURL: BASE }).search({ query: 'q' })).resolves.toEqual({
        sources: [{ url: 'https://example.com/ok', title: 'Kept' }],
        truncated: false,
      })
    })

    it('ignores Retry-After on a non-retryable rate limit', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('limited', {
        status: 429,
        headers: { 'retry-after': '999999' },
      }))
      vi.stubGlobal('fetch', fetchMock)
      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' })
      await expect(attempt).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(fetchMock).toHaveBeenCalledOnce()
      vi.useRealTimers()
    })

    it('maps an abort during fetch to WEB_ABORTED', async () => {
      const privateQuery = 'abort private query'
      const rawAbort = new DOMException(`aborted /search?q=${encodeURIComponent(privateQuery)}`, 'AbortError')
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(rawAbort))

      const attempt = createProvider({ baseURL: BASE }).search({ query: privateQuery })
      await expect(attempt).rejects.toSatisfy((error: unknown) => {
        expect((error as WebError).code).toBe('WEB_ABORTED')
        expect((error as WebError).cause).toMatchObject({ name: 'SearxngClientError', kind: 'caller-abort' })
        expect(inspectErrorChain(error)).not.toContain(privateQuery)
        expect(inspectErrorChain(error)).not.toContain(encodeURIComponent(privateQuery))
        return true
      })
    })

    it('maps a non-JSON 200 body to WEB_PROVIDER_ERROR', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ))

      const attempt = createProvider({ baseURL: BASE }).search({ query: 'q' })
      await expect(attempt).rejects.toSatisfy((error: unknown) => {
        expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
        expect((error as WebError).message).toMatch(/unprocessable response body/)
        return true
      })
    })

    it('cancels an unread non-JSON success body before reporting the contract error', async () => {
      let cancellations = 0
      const body = new ReadableStream({ cancel: () => { cancellations += 1 } })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })))

      await expect(createProvider({ baseURL: BASE }).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(cancellations).toBe(1)
    })

    it('does not let stalled non-JSON body cancellation delay the contract error', async () => {
      vi.useFakeTimers()
      let cancellations = 0
      const body = new ReadableStream({
        cancel: () => {
          cancellations += 1
          return new Promise<void>(() => {})
        },
      })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })))
      let rejection: unknown
      void createProvider({ baseURL: BASE }).search({ query: 'q' }).catch((error: unknown) => {
        rejection = error
      })

      await vi.advanceTimersByTimeAsync(1)

      expect(rejection).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(cancellations).toBe(1)
    })
  })
})

describe('SearxngSearchProvider baseURLs', () => {
  const PRIMARY = 'http://127.0.0.1:9090'
  const SECONDARY = 'http://127.0.0.1:8081'
  const POOL_RESULT = { results: [{ url: 'https://example.com/r', title: 'R' }] }

  it('is available when every pool entry is usable', () => {
    expect(createProvider({ baseURL: BASE, baseURLs: [PRIMARY, BASE] }).available()).toBe(true)
  })

  it('is unavailable when any pool entry is invalid', () => {
    const provider = createProvider({ baseURL: BASE, baseURLs: [BASE, 'not a url'] })
    expect(provider.available()).toBe(false)
  })

  it('routes through the pool primary and fails over within the pool, ignoring baseURL', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(PRIMARY)) throw new TypeError('down')
      return jsonResponse(POOL_RESULT)
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createProvider({ baseURL: BASE, baseURLs: [PRIMARY, SECONDARY] })
    const result = await provider.search({ query: 'q' })

    expect(result.sources.length).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]![0])).toContain(PRIMARY)
    expect(String(fetchMock.mock.calls[1]![0])).toContain(SECONDARY)
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain(`${BASE}/`)
  })

  it('rejects with invalid-url when a pool entry is malformed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const provider = createProvider({ baseURL: BASE, baseURLs: [BASE, 'not a url'] })
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: expect.stringContaining('absolute HTTP URL'),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('SearxngSearchProvider maxResults', () => {
  /** Five distinct, valid sources so slicing is observable. */
  const PAGE = {
    results: [
      { url: 'https://example.com/1', title: '1' },
      { url: 'https://example.com/2', title: '2' },
      { url: 'https://example.com/3', title: '3' },
      { url: 'https://example.com/4', title: '4' },
      { url: 'https://example.com/5', title: '5' },
    ],
  }

  it('slices the page to maxResults at the provider request layer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(PAGE)))

    const result = await createProvider({ baseURL: BASE }).search({ query: 'q', maxResults: 3 })

    expect(result.sources.map((source) => source.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ])
    // The provider honored the bound itself, so the seam has nothing left to
    // cut and `truncated` stays false: the flag means "the SEAM dropped
    // sources", and the caller asked for at most 3 and got 3.
    expect(result.truncated).toBe(false)
  })

  it('returns the whole page when maxResults is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(PAGE)))

    const result = await createProvider({ baseURL: BASE }).search({ query: 'q' })

    expect(result.sources).toHaveLength(5)
    expect(result.truncated).toBe(false)
  })

  it('returns the whole page when it fits within maxResults', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(PAGE)))

    const result = await createProvider({ baseURL: BASE }).search({ query: 'q', maxResults: 8 })

    expect(result.sources).toHaveLength(5)
    expect(result.truncated).toBe(false)
  })

  it('keeps the sourced page out of the cache path so a later wider bound still sees every source', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(PAGE))
    vi.stubGlobal('fetch', fetchMock)
    const provider = createProvider({ baseURL: BASE, minIntervalMs: 0, cacheTtlMs: 60_000 })

    await expect(provider.search({ query: 'narrow then wide', maxResults: 2 }))
      .resolves.toMatchObject({ sources: [{ url: 'https://example.com/1' }, { url: 'https://example.com/2' }] })
    // The cache stores the full page; the slice happens after the cache read,
    // so the second search must observe all five rather than the earlier two.
    const wide = await provider.search({ query: 'narrow then wide', maxResults: 8 })

    expect(wide.sources).toHaveLength(5)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('SearxngSearchProvider volatile options', () => {
  it('observes a settings change between two searches without re-registering', async () => {
    // A fresh Response per call: one shared instance would have its body
    // consumed by the first json() read and fail the second search.
    const fetchMock = vi.fn(async (_url: string) => jsonResponse({
      results: [{ url: 'https://example.com/r', title: 'R' }],
    }))
    vi.stubGlobal('fetch', fetchMock)
    // A stand-in for the plugin's volatile config references: the provider
    // holds the resolver, and `.get()` returns whatever is saved right now.
    let section: SearxngSearchProviderOptions = { baseURL: BASE, minIntervalMs: 0, cacheTtlMs: 0 }
    const provider = new SearxngSearchProvider(() => section)

    await provider.search({ query: 'q' })
    expect(fetchMock).toHaveBeenCalledOnce()
    let requested = new URL(fetchMock.mock.calls[0]![0] as string)
    expect(requested.searchParams.get('language')).toBeNull()

    // The user edits the plugin settings; nothing re-registers the provider.
    section = { baseURL: BASE, minIntervalMs: 0, cacheTtlMs: 0, language: 'zh-CN', engines: 'bing' }
    await provider.search({ query: 'q' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    requested = new URL(fetchMock.mock.calls[1]![0] as string)
    expect(requested.searchParams.get('language')).toBe('zh-CN')
    expect(requested.searchParams.get('engines')).toBe('bing')
  })

  it('reflects a settings change in available() for the next selection', () => {
    let section: SearxngSearchProviderOptions = { baseURL: '' }
    const provider = new SearxngSearchProvider(() => section)
    expect(provider.available()).toBe(false)

    section = { baseURL: BASE }
    expect(provider.available()).toBe(true)

    section = { baseURL: 'localhost:8080' }
    expect(provider.available()).toBe(false)
  })

  it('reads the section exactly once per search, so one operation never mixes two sections', async () => {
    let section: SearxngSearchProviderOptions = { baseURL: BASE, minIntervalMs: 0, cacheTtlMs: 0, language: 'en' }
    const fetchMock = vi.fn(async (_url: string) => {
      // Mid-operation the user saves another section. This search must still
      // run entirely on the one it resolved at entry.
      section = { baseURL: BASE, minIntervalMs: 0, cacheTtlMs: 0, language: 'ja' }
      return jsonResponse({ results: [{ url: 'https://example.com/r' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = new SearxngSearchProvider(() => section)

    await provider.search({ query: 'q' })

    const requested = new URL(fetchMock.mock.calls[0]![0])
    expect(requested.searchParams.get('language')).toBe('en')
  })

  it('reports a section that an edit made unusable as an actionable settings error, not a throw', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [{ url: 'https://example.com/r' }] }))
    vi.stubGlobal('fetch', fetchMock)
    // Under volatile config an edit can reach the provider with a knob the
    // mount-time schema would have rejected; it must surface as a search error.
    const provider = new SearxngSearchProvider(() => ({
      baseURL: BASE,
      cacheTtlMs: -1,
    }))

    await expect(provider.search({ query: 'q' })).rejects.toSatisfy((error: unknown) => {
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
      expect((error as WebError).message).toMatch(/settings/i)
      expect((error as WebError).message).toMatch(/cacheTtlMs/)
      return true
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats an unusable section as unavailable rather than throwing at selection time', () => {
    const provider = new SearxngSearchProvider(() => ({
      baseURL: BASE,
      baseURLs: ['not a url'],
    }))
    // available() is called from inside the seam's provider selection; a throw
    // here would escape as a non-WebError and break the whole search path.
    expect(provider.available()).toBe(false)
  })
})

describe('dsh-searxng mode', () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  function load(section: Record<string, unknown>): Record<string, { get(): unknown }> {
    // Synchronous schema: narrow away the StandardSchema `| Promise<...>` arm.
    const result = Config['~standard'].validate(section) as
      | { issues?: readonly unknown[]; value?: unknown }
      | undefined
    if (result === undefined || (result.issues !== undefined && result.issues.length > 0)) {
      throw new Error(`validation failed: ${JSON.stringify(result?.issues)}`)
    }
    return result.value as Record<string, { get(): unknown }>
  }

  function makeContext(): { ctx: Record<string, unknown>; providers: SearxngSearchProvider[] } {
    const providers: SearxngSearchProvider[] = []
    return {
      providers,
      ctx: {
        web: { registerSearchProvider: (p: SearxngSearchProvider) => { providers.push(p); return () => {} } },
        get: () => undefined,
        launchEnvironment: undefined,
      },
    }
  }

  it('declares mode as a volatile field defaulting to external', () => {
    expect(DEFAULT_SEARXNG_MODE).toBe('external')
    const config = load({})
    expect(typeof config.mode?.get).toBe('function')
    expect(config.mode!.get()).toBe('external')
  })

  it('round-trips an explicit managed choice', () => {
    expect(load({ mode: 'managed' }).mode!.get()).toBe('managed')
    expect(load({ mode: 'external' }).mode!.get()).toBe('external')
  })

  it('rejects an unknown mode at validation instead of coercing it', () => {
    expect('issues' in Config['~standard'].validate({ mode: 'managed-docker' })).toBe(true)
  })

  // The user-facing requirement: the mode is chosen in the plugin settings page,
  // not guessed by the CLI. That only works if the schema advertises `mode` as an
  // enumerated, defaulted, volatile field the settings surface can render as a
  // select. Schemastery serializes to an internal spec (`refs` + `dict`), so walk
  // that form rather than assuming a JSON-Schema `properties` map.
  it('advertises mode to a settings surface as a selectable, defaulted choice', () => {
    const spec = JSON.parse(JSON.stringify(Config.toJSON())) as {
      uid: number
      refs: Record<string, { type: string; list?: number[]; value?: unknown; meta?: Record<string, unknown>; dict?: Record<string, number> }>
    }
    const dict = spec.refs[String(spec.uid)]?.dict
    expect(dict).toBeDefined()
    const mode = spec.refs[String(dict!.mode)]!

    expect(mode.type).toBe('union')
    const values = (mode.list ?? []).map((ref) => spec.refs[String(ref)]!.value)
    expect(values).toEqual(['external', 'managed'])
    expect(mode.meta).toMatchObject({ default: 'external', volatile: true })
  })

  it('keeps a legacy profile with only baseURL working as external', () => {
    const config = load({ baseURL: BASE })
    expect(config.mode!.get()).toBe('external')
    expect(config.baseURL!.get()).toBe(BASE)
  })

  it('applies mode without changing how a search executes', async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse({ results: [{ url: 'https://example.com/1' }] }))
    vi.stubGlobal('fetch', fetchMock)

    for (const mode of ['external', 'managed'] as const) {
      const { ctx, providers } = makeContext()
      apply(ctx as never, load({ mode, baseURL: BASE, minIntervalMs: 0, cacheTtlMs: 0 }) as never)
      await providers[0]!.search({ query: 'same query' })
    }

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Ownership metadata must never leak into the request.
    expect(fetchMock.mock.calls[0]![0]).toBe(fetchMock.mock.calls[1]![0])
  })

  it('decides availability by the endpoint alone, in both modes', () => {
    for (const mode of ['external', 'managed'] as const) {
      const withUrl = makeContext()
      apply(withUrl.ctx as never, load({ mode, baseURL: BASE }) as never)
      expect(withUrl.providers[0]!.available()).toBe(true)

      // A managed profile with no endpoint still cannot search; claiming
      // availability would send the request to an empty URL.
      const withoutUrl = makeContext()
      apply(withoutUrl.ctx as never, load({ mode }) as never)
      expect(withoutUrl.providers[0]!.available()).toBe(false)
    }
  })

  it('distinguishes awaiting a managed endpoint from a plain missing one', () => {
    expect(describeSearxngProfile({ mode: 'external', baseURL: BASE }))
      .toEqual({ available: true, state: 'ready' })
    expect(describeSearxngProfile({ mode: 'managed', baseURL: BASE }))
      .toEqual({ available: true, state: 'ready' })
    expect(describeSearxngProfile({ mode: 'external' }))
      .toEqual({ available: false, state: 'no-endpoint' })
    // Opted into provisioning, CLI has not written the endpoint yet: a real
    // state, not a misconfiguration, but still not searchable.
    expect(describeSearxngProfile({ mode: 'managed' }))
      .toEqual({ available: false, state: 'awaiting-managed-endpoint' })
    expect(describeSearxngProfile({}))
      .toEqual({ available: false, state: 'no-endpoint' })
  })

  it('reports an unusable endpoint as invalid in either mode', () => {
    expect(describeSearxngProfile({ mode: 'external', baseURL: 'localhost:8080' }))
      .toEqual({ available: false, state: 'invalid-endpoint' })
    expect(describeSearxngProfile({ mode: 'managed', baseURL: 'http://user:pass@x' }))
      .toEqual({ available: false, state: 'invalid-endpoint' })
    expect(describeSearxngProfile({ baseURLs: [BASE] }))
      .toEqual({ available: true, state: 'ready' })
    expect(describeSearxngProfile({ mode: 'managed', baseURLs: ['nope'] }))
      .toEqual({ available: false, state: 'invalid-endpoint' })
  })
})
