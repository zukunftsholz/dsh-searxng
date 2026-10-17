import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundleMountDiagnosis,
  inspectBundleMount,
  insertedEntryIds,
  packageDirectory,
  PLUGIN_SPEC_ENV,
  PLUGIN_NAME,
  profileReadiness,
  readSelfPackage,
  resolvePluginSpec,
  silentSkipConsequence,
} from '../../src/cli/bundle.ts'
import { describeSearxngProfile } from '../../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

/**
 * Materialize a profile whose plugin package may or may not exist, and whose
 * bundle patch may declare a different insert. Every dimension the observer
 * reads is controllable so each reason is reachable in isolation.
 */
async function profile(options: {
  bundles?: string[]
  install?: boolean
  bundle?: unknown | null
  patch?: string
  pluginName?: string
} = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dsh-bundle-'))
  roots.push(dir)
  const name = options.pluginName ?? PLUGIN_NAME
  if (options.install !== false) {
    const packageDir = packageDirectory(dir, name)
    await fs.mkdir(packageDir, { recursive: true })
    const manifest: Record<string, unknown> = { name, version: '0.5.0' }
    if (options.bundle !== null) manifest.dsh = { bundle: options.bundle ?? { patch: './cordis.patch.yml' } }
    await fs.writeFile(join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await fs.writeFile(
      join(packageDir, 'cordis.patch.yml'),
      options.patch ?? `- insert:\n    - id: web-search-searxng\n      name: 'dsh-searxng'\n`,
    )
  }
  return { dir, bundles: options.bundles ?? [name] }
}

function observe(dir: string, bundles: readonly string[], pluginName = PLUGIN_NAME) {
  return inspectBundleMount({ profileDir: dir, pluginName, targetId: 'web-search-searxng', bundles })
}

describe('bundle patch insert semantics', () => {
  it('counts only top-level inserts, matching the loader', () => {
    // A group insert (`id` + `insert`) appends into an existing group and
    // creates no top-level entry; a non-insert patch never creates one either.
    expect([...insertedEntryIds([
      { insert: [{ id: 'a' }, { id: 'b' }] },
      { id: 'group', insert: [{ id: 'inner' }] },
      { id: 'config-only' },
    ])]).toEqual(['a', 'b'])
  })

  it('keeps application order and de-duplicates repeated ids', () => {
    expect([...insertedEntryIds([
      { insert: [{ id: 'second' }] },
      { insert: [{ id: 'first' }, { id: 'second' }] },
    ])]).toEqual(['second', 'first'])
  })

  it('accepts entries without an id, which create nothing addressable', () => {
    expect([...insertedEntryIds([{ insert: [{ name: 'anon' }] }])]).toEqual([])
  })

  it('rejects a patch list whose shapes the loader would reject', () => {
    expect(() => insertedEntryIds(['not-a-map'])).toThrow()
    expect(() => insertedEntryIds([{ insert: 'not-a-list' }])).toThrow()
    expect(() => insertedEntryIds([{ insert: ['not-a-map'] }])).toThrow()
  })
})

describe('bundle mount observation', () => {
  it('composes when the enrolled bundle layer inserts the target id', async () => {
    const test = await profile()
    await expect(observe(test.dir, test.bundles)).resolves.toEqual({
      enrolled: true,
      composes: true,
      observable: true,
    })
  })

  it('reports not-enrolled and a verifiable composition failure', async () => {
    const test = await profile({ bundles: ['@deepseek-ai/dsh-base'] })
    await expect(observe(test.dir, test.bundles)).resolves.toEqual({
      enrolled: false,
      composes: false,
      reason: 'not-enrolled',
      observable: true,
    })
  })

  it('separates an uninstalled package from a proven composition failure', async () => {
    const test = await profile({ install: false })
    // Composition is undecidable: there is no patch file to read. Callers that
    // gate a write must not mistake this for a bundle-composition bug.
    await expect(observe(test.dir, test.bundles)).resolves.toEqual({
      enrolled: true,
      composes: false,
      reason: 'package-missing',
      observable: false,
    })
  })

  it('reports a plugin that declares no bundle metadata', async () => {
    const test = await profile({ bundle: null })
    await expect(observe(test.dir, test.bundles)).resolves.toMatchObject({
      enrolled: true,
      composes: false,
      reason: 'no-bundle-metadata',
      observable: true,
    })
  })

  it('reports a malformed bundle declaration as missing metadata', async () => {
    const test = await profile({ bundle: { patch: 42 } })
    await expect(observe(test.dir, test.bundles)).resolves.toMatchObject({
      reason: 'no-bundle-metadata',
      observable: true,
    })
  })

  it('reports an unreadable bundle patch', async () => {
    const test = await profile()
    await fs.writeFile(join(packageDirectory(test.dir, PLUGIN_NAME), 'cordis.patch.yml'), '[unbalanced\n')
    await expect(observe(test.dir, test.bundles)).resolves.toMatchObject({
      reason: 'patch-unreadable',
      observable: true,
    })
  })

  it('reports a patch that is not a top-level list', async () => {
    const test = await profile({ patch: 'id: scalar\n' })
    await expect(observe(test.dir, test.bundles)).resolves.toMatchObject({
      reason: 'patch-unreadable',
      observable: true,
    })
  })

  it('reports an enrolled bundle that inserts a different id', async () => {
    const test = await profile({ patch: "- insert:\n    - id: someone-else\n" })
    await expect(observe(test.dir, test.bundles)).resolves.toMatchObject({
      enrolled: true,
      composes: false,
      reason: 'target-not-inserted',
      observable: true,
    })
  })

  it('treats an empty patch file as a readable list with no inserts', async () => {
    const test = await profile({ patch: '[]\n' })
    await expect(observe(test.dir, test.bundles)).resolves.toMatchObject({
      reason: 'target-not-inserted',
      observable: true,
    })
  })

  it('reads every file of a multi-file bundle declaration in order', async () => {
    const test = await profile({
      bundle: { patch: ['./first.yml', './second.yml'] },
      // `profile()` writes this into cordis.patch.yml, which the multi-file
      // declaration does not name, so the fixture below supplies both files.
      patch: "- insert:\n    - id: another-id\n",
    })
    const packageDir = packageDirectory(test.dir, PLUGIN_NAME)
    await fs.writeFile(join(packageDir, 'first.yml'), "- insert:\n    - id: another-id\n")
    await fs.writeFile(join(packageDir, 'second.yml'), "- insert:\n    - id: web-search-searxng\n")
    // The target is inserted by the second file only; both must be read.
    await expect(observe(test.dir, test.bundles)).resolves.toMatchObject({ composes: true })
  })

  it('fails observably when one file of a multi-file declaration is missing', async () => {
    // A declaration that names an absent file cannot be read, so the layer is
    // unobservable-by-defect rather than silently treated as "inserts nothing".
    const test = await profile({ bundle: { patch: ['./first.yml', './second.yml'] } })
    const packageDir = packageDirectory(test.dir, PLUGIN_NAME)
    await fs.writeFile(join(packageDir, 'second.yml'), "- insert:\n    - id: web-search-searxng\n")
    await expect(observe(test.dir, test.bundles)).resolves.toMatchObject({
      enrolled: true,
      composes: false,
      reason: 'patch-unreadable',
      observable: true,
    })
  })

  it('resolves the package under a scoped name layout', async () => {
    const scoped = '@scope/plugin'
    const test = await profile({ pluginName: scoped })
    expect(packageDirectory(test.dir, scoped)).toBe(join(test.dir, 'node_modules', '@scope', 'plugin'))
    await expect(observe(test.dir, test.bundles, scoped)).resolves.toMatchObject({ composes: true })
  })
})

/**
 * `profileReadiness` in src/cli/bundle.ts is a local mirror of the plugin's
 * exported `describeSearxngProfile`. The mirror exists because importing the
 * entry point would pull the harness runtime into the standalone CLI bundle,
 * which `scripts/check-packed-cli.mjs` forbids. Nothing else keeps the two in
 * step, so this pins them together: any divergence fails here rather than
 * shipping a `doctor` that disagrees with the provider.
 */
describe('profileReadiness mirrors the plugin helper', () => {
  const cases: Array<{ mode?: 'external' | 'managed'; baseURL?: string; baseURLs?: readonly string[] }> = [
    { mode: 'external', baseURL: 'http://127.0.0.1:8080' },
    { mode: 'managed', baseURL: 'http://127.0.0.1:18080' },
    { mode: 'external' },
    { mode: 'managed' },
    {},
    { baseURL: '' },
    { baseURLs: [] },
    { baseURLs: ['https://a.example', 'https://b.example'] },
    { mode: 'managed', baseURLs: ['https://a.example'] },
    { baseURL: 'not a url' },
    { baseURL: 'ftp://files.example' },
    { baseURL: 'https://user:pass@a.example' },
    { baseURL: 'https://a.example/?q=1' },
    { baseURL: 'https://a.example/#frag' },
    { baseURLs: ['https://a.example', 'ftp://bad.example'] },
    // A failover pool outranks a broken baseURL, exactly as the provider reads it.
    { baseURL: 'not a url', baseURLs: ['https://a.example'] },
  ]

  it.each(cases.map((value) => [JSON.stringify(value), value] as const))(
    'agrees with describeSearxngProfile for %s',
    (_label, config) => {
      expect(profileReadiness(config)).toBe(describeSearxngProfile(config).state)
    },
  )

  it('separates the awaiting-managed state from an external misconfiguration', () => {
    // The distinction that matters: an opted-in managed profile with no endpoint
    // yet is not the same defect as an external profile with nothing configured.
    expect(profileReadiness({ mode: 'managed' })).toBe('awaiting-managed-endpoint')
    expect(profileReadiness({ mode: 'external' })).toBe('no-endpoint')
    expect(profileReadiness({})).toBe('no-endpoint')
  })
})

/**
 * The install spec `setup` passes to `dsh plugin add`.
 *
 * Installing the bare registry name resolves to whatever the registry serves as
 * `latest`. For a release newer than the registry, that is an OLDER version that
 * the plugin manager then correctly rejects as incompatible — so
 * `npx dsh-searxng@0.5.0 setup` could not install itself. The spec is therefore
 * pinned to the running package's own version.
 */
describe('plugin install spec', () => {
  it('pins the default spec to the running package version', () => {
    expect(resolvePluginSpec({ version: '0.5.0' })).toBe('dsh-searxng@0.5.0')
    // A different version yields a different spec, so the pin cannot drift from
    // package.json without this changing too.
    expect(resolvePluginSpec({ version: '1.2.3' })).toBe('dsh-searxng@1.2.3')
  })

  it('never emits a bare name when a version is known', () => {
    // The bare name is exactly the bug: it lets the registry choose.
    expect(resolvePluginSpec({ version: '0.5.0' })).not.toBe(PLUGIN_NAME)
  })

  it('uses the environment override verbatim, without parsing it', () => {
    for (const spec of [
      'file:./dsh-searxng-0.5.0.tgz',
      'file:/abs/path/dsh-searxng-0.5.0.tgz',
      'github:rogerdigital/dsh-searxng',
      'git+https://github.com/rogerdigital/dsh-searxng.git#v0.5.0',
      'dsh-searxng@next',
      'dsh-searxng@^0.5.0',
    ]) {
      expect(resolvePluginSpec({ version: '0.5.0', env: { [PLUGIN_SPEC_ENV]: spec } })).toBe(spec)
    }
  })

  it('trims the override and treats blank as unset', () => {
    expect(resolvePluginSpec({ version: '0.5.0', env: { [PLUGIN_SPEC_ENV]: '  dsh-searxng@next  ' } }))
      .toBe('dsh-searxng@next')
    expect(resolvePluginSpec({ version: '0.5.0', env: { [PLUGIN_SPEC_ENV]: '' } })).toBe('dsh-searxng@0.5.0')
    expect(resolvePluginSpec({ version: '0.5.0', env: { [PLUGIN_SPEC_ENV]: '   ' } })).toBe('dsh-searxng@0.5.0')
    expect(resolvePluginSpec({ version: '0.5.0', env: {} })).toBe('dsh-searxng@0.5.0')
  })

  it('falls back to the bare name only when no version can be determined', () => {
    expect(resolvePluginSpec({})).toBe(PLUGIN_NAME)
    expect(resolvePluginSpec({ version: '' })).toBe(PLUGIN_NAME)
  })

  it('reads the running version from this package, not a literal', () => {
    // Both real layouts: this test file lives two levels under the repo root
    // (like src/cli/*), and the packed CLI is lib/cli.mjs beside package.json.
    const fromSource = readSelfPackage(new URL('../../src/cli/bundle.ts', import.meta.url).href)
    const fromPacked = readSelfPackage(new URL('../../lib/cli.mjs', import.meta.url).href)
    const declared = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }

    expect(fromSource.version).toBe(declared.version)
    expect(fromPacked.version).toBe(declared.version)
    // The pin is derived, so it always agrees with the manifest.
    expect(fromSource.spec).toBe(`dsh-searxng@${declared.version}`)
    expect(fromPacked.spec).toBe(`dsh-searxng@${declared.version}`)
  })

  it('honours the override when reading the self package', () => {
    const self = readSelfPackage(new URL('../../src/cli/bundle.ts', import.meta.url).href, {
      [PLUGIN_SPEC_ENV]: 'file:./local.tgz',
    })
    expect(self.spec).toBe('file:./local.tgz')
  })

  it('reads nothing from a neighbouring package.json that is not this package', () => {
    // A path outside this package must not be mistaken for its manifest.
    const self = readSelfPackage('file:///nonexistent/deeply/nested/module.mjs')
    expect(self.version).toBeUndefined()
    expect(self.spec).toBe(PLUGIN_NAME)
  })
})

describe('bundle mount diagnosis', () => {  const reasons = ['not-enrolled', 'package-missing', 'no-bundle-metadata', 'patch-unreadable', 'target-not-inserted'] as const

  it('names the consequence and a repair action for every reason', () => {
    for (const reason of reasons) {
      const { message, action } = bundleMountDiagnosis(reason)
      expect(message.length).toBeGreaterThan(0)
      expect(action.length).toBeGreaterThan(0)
    }
  })

  it('states the exact silent-skip consequence for the not-enrolled case', () => {
    const { message } = bundleMountDiagnosis('not-enrolled')
    expect(message).toContain('dsh.profile.bundles')
    expect(message).toContain('never registered with ctx.web')
  })

  it('names the package and keeps every reason distinct', () => {
    const messages = reasons.map((reason) => bundleMountDiagnosis(reason, '@scope/plugin').message)
    expect(new Set(messages).size).toBe(reasons.length)
    expect(bundleMountDiagnosis('package-missing', '@scope/plugin').message).toContain('@scope/plugin')
  })

  it('spells out the symptom a configured provider reports', () => {
    expect(silentSkipConsequence()).toContain('silently skipped')
    expect(silentSkipConsequence()).toContain('WEB_PROVIDER_CONFIGURED_MISSING')
  })
})
