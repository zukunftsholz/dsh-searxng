import type { FileHandle } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, parseDocument } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { PLUGIN_NAME, PLUGIN_SPEC_ENV } from '../../src/cli/bundle.ts'
import { CliError } from '../../src/cli/errors.ts'
import { symlinkTestTitle, symlinkUnsupported } from './symlink-capability.ts'
import type { CommandResult, CommandRunner } from '../../src/cli/process.ts'
import {
  NodeProfileManager,
  type ProfileFileSystem,
  type ProfileManager,
} from '../../src/cli/profile.ts'

const roots: string[] = []

/**
 * The install spec the fixture's manager passes to `dsh plugin add`.
 *
 * Deliberately not the real pinned spec: these assertions should not start
 * failing every time `package.json`'s version changes. The "pinned to the
 * running package's own version" behaviour is covered by its own tests against
 * `resolvePluginSpec`/`readSelfPackage`.
 */
const TEST_PLUGIN_SPEC = 'dsh-searxng@test'

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = []
  readonly signals: Array<AbortSignal | undefined> = []
  response: CommandResult = { exitCode: 0, stdout: '', stderr: '' }
  failure: unknown
  handler?: (
    command: string,
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ) => Promise<CommandResult>
  profileDir?: string
  simulatePluginEffects = true

  async run(
    command: string,
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<CommandResult> {
    this.calls.push({ command, args: [...args] })
    this.signals.push(options?.signal)
    if (this.failure !== undefined) throw this.failure
    const response = this.handler !== undefined
      ? await this.handler(command, args, options)
      : this.response
    if (response.exitCode === 0 && this.profileDir !== undefined && this.simulatePluginEffects) {
      const manifestPath = join(this.profileDir, 'package.json')
      let manifest: {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: string[]; [key: string]: unknown }; [key: string]: unknown }
      } = {}
      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as typeof manifest
      } catch {}
      manifest.dependencies ??= {}
      // Mirrors what `dsh plugin add|remove` actually does: plugin-manager's
      // `reconcile()` keeps `dsh.profile.bundles` in step with `dependencies`,
      // appending a newly installed bundle and dropping one whose dependency is
      // gone. Without the removal half, uninstall would look like it left a
      // stale bundle entry behind.
      const bundles = manifest.dsh?.profile?.bundles ?? []
      if (args.includes('add')) {
        manifest.dependencies['dsh-searxng'] = '0.1.1'
        if (!bundles.includes('dsh-searxng')) {
          manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, 'dsh-searxng'] } }
        }
      }
      if (args.includes('remove')) {
        delete manifest.dependencies['dsh-searxng']
        manifest.dsh = {
          ...manifest.dsh,
          profile: { ...manifest.dsh?.profile, bundles: bundles.filter((name) => name !== 'dsh-searxng') },
        }
      }
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    return response
  }
}

/**
 * Materialize a profile fixture.
 *
 * By default the fixture installs a stand-in `dsh-searxng` package carrying the
 * bundle patch this repo ships, and enrols it in `dsh.profile.bundles`, so the
 * profile is in the state `attach` now verifies: the config row resolves
 * because the bundle layer inserts the entry it targets. `bundle` overrides
 * that shape for the composition tests, which need the row to be unmountable.
 *
 * `reconcileBundles: false` suppresses the automatic enrolment so a test can
 * express the exact defective profile found on a real machine — the plugin
 * present in `dependencies` but absent from `dsh.profile.bundles`. That state is
 * unreachable through `dsh plugin add` (plugin-manager's `reconcile()` appends
 * the bundle), but entirely reachable by hand-editing the manifest, which is how
 * it happened. Only the test that pins that failure mode should use it.
 */
async function fixture(options: {
  packageJson?: unknown | string
  patch?: string
  fileSystem?: ProfileFileSystem
  runner?: RecordingRunner
  bundle?: BundleShape | null
  /** Set false to keep `dsh.profile.bundles` exactly as the fixture declares it. */
  reconcileBundles?: boolean
  /** Overrides the install spec the manager passes to `dsh plugin add`. */
  pluginSpec?: string
} = {}) {
  const dshHome = await fs.mkdtemp(join(tmpdir(), 'dsh-profile-'))
  roots.push(dshHome)
  const dir = join(dshHome, 'profiles', 'web')
  await fs.mkdir(dir, { recursive: true })
  if (options.packageJson !== undefined) {
    // Object manifests get the enrolled shape `dsh plugin add` produces, while
    // raw-string manifests stay byte-exact: the concurrency tests assert on the
    // exact bytes they wrote, and rewriting one would invalidate the fixture.
    const value = typeof options.packageJson === 'string'
      ? options.packageJson
      : options.reconcileBundles === false
        ? options.packageJson
        : enrolledManifest(options.packageJson)
    const source = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
    await fs.writeFile(join(dir, 'package.json'), source)
  }
  if (options.patch !== undefined) await fs.writeFile(join(dir, 'cordis.patch.yml'), options.patch)
  if (options.bundle !== null) installBundle(dir, options.bundle)
  const runner = options.runner ?? new RecordingRunner()
  runner.profileDir = dir
  const manager = new NodeProfileManager({
    commandRunner: runner,
    dshHome,
    fileSystem: options.fileSystem,
    randomId: () => 'fixed',
    // Pin the spec explicitly so these assertions never depend on the version
    // in package.json. The pinned-to-own-version behaviour has its own tests.
    pluginSpec: options.pluginSpec ?? TEST_PLUGIN_SPEC,
  })
  return { dshHome, dir, patchPath: join(dir, 'cordis.patch.yml'), manager, runner }
}

/** Bundle-layer shapes the composition observer distinguishes. */
type BundleShape =
  /** The shipped shape: inserts the entry the profile config targets. */
  | 'shipped'
  /** Installed but declares no `dsh.bundle`. */
  | 'no-metadata'
  /** Bundle layer inserts a different id, so the targeted row cannot resolve. */
  | 'other-id'
  /** Bundle patch file is not valid YAML. */
  | 'unreadable'

/**
 * Install a stand-in plugin package with a chosen bundle shape. `attach` reads
 * this package's manifest and patch file, so the fixture has to look like a
 * real installation rather than only a manifest dependency.
 * @param dir - absolute profile directory.
 * @param shape - which bundle layer to materialize.
 */
function installBundle(dir: string, shape: BundleShape = 'shipped'): void {
  const bundleDir = join(dir, 'node_modules', 'dsh-searxng')
  fsSync.mkdirSync(bundleDir, { recursive: true })
  const manifest: Record<string, unknown> = { name: 'dsh-searxng', version: '0.5.0' }
  if (shape !== 'no-metadata') manifest.dsh = { bundle: { patch: './cordis.patch.yml' } }
  fsSync.writeFileSync(join(bundleDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (shape === 'no-metadata') return
  const patch = shape === 'other-id'
    ? "- insert:\n    - id: another-entry\n"
    : shape === 'unreadable'
      ? '[unbalanced\n'
      : "- insert:\n    - id: web-search-searxng\n      name: 'dsh-searxng'\n"
  fsSync.writeFileSync(join(bundleDir, 'cordis.patch.yml'), patch)
}

/**
 * Enrol the plugin package as a profile bundle, the way `dsh plugin add`
 * reconciles it.
 *
 * This is what makes the config row resolvable: the shipped `cordis.patch.yml`
 * is a bundle layer whose `insert` creates the `web-search-searxng` entry, and
 * only an enrolled bundle is applied. A manifest that lists the dependency but
 * not the bundle is the silently-broken shape the CLI now refuses to produce,
 * so fixtures that exist to exercise other behaviour start from a working
 * profile instead of inheriting that defect.
 * @param manifest - a fixture manifest with a `dependencies` map.
 * @returns a copy whose `dsh.profile.bundles` lists the plugin, when the
 *   fixture is one where the plugin is meant to be installed.
 */
function enrolledManifest(manifest: unknown): unknown {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return manifest
  const record = manifest as Record<string, unknown>
  if (!record.dependencies || !Object.hasOwn(record.dependencies, 'dsh-searxng')) return manifest
  const dsh = (record.dsh ?? {}) as Record<string, unknown>
  const profile = (dsh.profile ?? {}) as Record<string, unknown>
  const bundles = Array.isArray(profile.bundles) ? profile.bundles as string[] : []
  if (bundles.includes('dsh-searxng')) return manifest
  return { ...record, dsh: { ...dsh, profile: { ...profile, bundles: [...bundles, 'dsh-searxng'] } } }
}


afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function ids(source: string): string[] {
  return (parse(source) as Array<{ id?: string }>).map((entry) => entry.id ?? '')
}

describe('ProfileManager contract and discovery', () => {
  it('is structural so a plain fake satisfies the public interface', async () => {
    const fake: ProfileManager = {
      inspect: async () => ({ installed: false, patchPath: '/profile/cordis.patch.yml' }),
      preview: async (_profile, endpoint) => ({ installed: false, attached: false, config: { baseURL: endpoint } }),
      validate: async (_profile, _endpoint, callback) => { await callback({ baseURL: 'http://localhost:8080' }) },
      attach: async () => {},
      detach: async () => {},
      uninstall: async () => {},
    }
    await expect(fake.inspect('web')).resolves.toMatchObject({ installed: false })
  })

  it('previews the exact effective provider config without mutating the profile', async () => {
    const patch = `- id: web-search-searxng
  config:
    baseURL: http://old.invalid
    language: zh-CN
    engines: bing,google
    categories: general
    authHeader: Bearer private-token
    unrelated: keep
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch,
    })

    await expect(manager.preview('web', 'https://search.example/root/')).resolves.toEqual({
      installed: true,
      attached: false,
      config: {
        baseURL: 'https://search.example/root',
        language: 'zh-CN',
        engines: 'bing,google',
        categories: 'general',
        authHeader: 'Bearer private-token',
        // The preview reports the config this CLI would WRITE, and every write
        // records the mode explicitly rather than relying on the schema default.
        mode: 'external',
      },
      current: {
        baseURL: 'http://old.invalid',
        language: 'zh-CN',
        engines: 'bing,google',
        categories: 'general',
        authHeader: 'Bearer private-token',
      },
      mount: { enrolled: true, composes: true, observable: true },
    })
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(patch)
  })

  it('exposes the live attachment endpoint when it differs from the preview target', async () => {
    const drifted = `# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    baseURL: http://drifted.invalid
    language: en
`
    const driftedProfile = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch: drifted,
    })
    const driftedPreview = await driftedProfile.manager.preview('web', 'http://127.0.0.1:8080')
    expect(driftedPreview.attached).toBe(false)
    expect(driftedPreview.current).toEqual({ baseURL: 'http://drifted.invalid', language: 'en' })

    const absent = await fixture({ packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } } })
    const absentPreview = await absent.manager.preview('web', 'http://127.0.0.1:8080')
    expect(absentPreview.attached).toBe(false)
    expect(absentPreview.current).toBeUndefined()
  })

  it('recognizes only the final effective correctly managed attachment', async () => {
    const correct = `# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    baseURL: http://localhost:8080
    language: en
`
    const attached = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch: correct,
    })
    await expect(attached.manager.preview('web', 'http://localhost:8080')).resolves.toMatchObject({
      attached: true,
      config: { baseURL: 'http://localhost:8080', language: 'en' },
    })

    const overridden = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch: `${correct}- id: web-search-searxng\n  config:\n    baseURL: http://user.invalid\n`,
    })
    await expect(overridden.manager.preview('web', 'http://localhost:8080')).resolves.toMatchObject({ attached: false })
  })

  it('validates an existing attachment without changing its bytes or inode', async () => {
    const patch = `# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    baseURL: http://localhost:8080
    language: zh-CN
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch,
    })
    const before = await fs.lstat(patchPath)
    await expect(manager.validate('web', 'http://localhost:8080', async (config) => {
      expect(config).toEqual({ baseURL: 'http://localhost:8080', language: 'zh-CN' })
    })).resolves.toBeUndefined()
    const after = await fs.lstat(patchPath)
    expect(after.ino).toBe(before.ino)
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(patch)
  })

  it('rejects a different-byte replacement during read-only attachment validation', async () => {
    const patch = `# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    baseURL: http://localhost:8080
`
    const concurrent = '# replaced during provider validation\n- id: editor\n'
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch,
    })
    await expect(manager.validate('web', 'http://localhost:8080', async () => {
      await fs.writeFile(patchPath, concurrent)
    })).rejects.toMatchObject({ code: 'E_PROFILE_CONCURRENT_MODIFICATION' })
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(concurrent)
  })

  it('rejects a same-byte inode replacement during read-only attachment validation', async () => {
    const patch = `# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    baseURL: http://localhost:8080
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch,
    })
    const before = await fs.lstat(patchPath)
    await expect(manager.validate('web', 'http://localhost:8080', async () => {
      const replacement = `${patchPath}.replacement`
      await fs.writeFile(replacement, patch)
      await fs.rename(replacement, patchPath)
    })).rejects.toMatchObject({ code: 'E_PROFILE_CONCURRENT_MODIFICATION' })
    expect((await fs.lstat(patchPath)).ino).not.toBe(before.ino)
  })

  it('rejects manifest dependency removal during read-only attachment validation', async () => {
    const patch = `# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    baseURL: http://localhost:8080
`
    const { manager, dir, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch,
    })
    const manifestPath = join(dir, 'package.json')
    await expect(manager.validate('web', 'http://localhost:8080', async () => {
      await fs.writeFile(manifestPath, `${JSON.stringify({ dependencies: {} }, null, 2)}\n`)
    })).rejects.toMatchObject({ code: 'E_PROFILE_CONCURRENT_MODIFICATION' })
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(patch)
  })

  it('rejects a same-byte manifest inode replacement during read-only attachment validation', async () => {
    const packageJson = `${JSON.stringify({ dependencies: { 'dsh-searxng': '0.1.1' } }, null, 2)}\n`
    const patch = `# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    baseURL: http://localhost:8080
`
    const { manager, dir } = await fixture({ packageJson, patch })
    const manifestPath = join(dir, 'package.json')
    const before = await fs.lstat(manifestPath)
    await expect(manager.validate('web', 'http://localhost:8080', async () => {
      const replacement = `${manifestPath}.replacement`
      await fs.writeFile(replacement, packageJson)
      await fs.rename(replacement, manifestPath)
    })).rejects.toMatchObject({ code: 'E_PROFILE_CONCURRENT_MODIFICATION' })
    expect((await fs.lstat(manifestPath)).ino).not.toBe(before.ino)
  })

  it('resolves an empty profile to the official web profile layout', async () => {
    const { dshHome, manager } = await fixture()
    await expect(manager.inspect('')).resolves.toEqual({
      installed: false,
      patchPath: join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
    })
  })

  it.each([
    [{ dependencies: { 'dsh-searxng': '^0.1.0' } }, 'dependencies'],
    [{ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-searxng'] } } }, 'bundles'],
  ])('detects an installed plugin from %s', async (packageJson, _source) => {
    const { manager } = await fixture({ packageJson })
    await expect(manager.inspect('web')).resolves.toMatchObject({ installed: true })
  })

  it.each([
    ['invalid JSON', '{secret endpoint https://private.invalid?q=token'],
    ['invalid dependencies', { dependencies: [] }],
    ['invalid bundles', { dsh: { profile: { bundles: [42] } } }],
  ])('reports %s as a stable safe profile error without mutation', async (_name, packageJson) => {
    const patch = '# keep\n[]\n'
    const { manager, patchPath } = await fixture({ packageJson, patch })
    let error: unknown
    try { await manager.inspect('web') } catch (cause) { error = cause }
    expect(error).toMatchObject({ code: 'E_PROFILE_WRITE', details: {} })
    expect(JSON.stringify(error)).not.toContain('private.invalid')
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(patch)
  })

  it.each(['../web', 'a/b', 'a\\b'])('rejects the unsafe profile name %s', async (profile) => {
    const { manager } = await fixture()
    await expect(manager.inspect(profile)).rejects.toMatchObject({ code: 'E_PROFILE_INVALID' })
  })
})

/**
 * A profile can carry the `web-search-searxng` config row while its bundle
 * layer never inserts that entry. `applyEntryPatches` resolves a non-insert
 * patch by id against entries that already exist and drops a miss with only a
 * loader warning, so the provider silently never registers and a configured
 * `web.searchProvider: searxng` fails at search time with
 * WEB_PROVIDER_CONFIGURED_MISSING. These tests pin both halves of the reply:
 * `attach` repairs and then proves the bundle layer, and `preview` reports it.
 */
describe('bundle layer enrollment', () => {
  const rowPatch = `- id: web-search-searxng
  config:
    baseURL: http://127.0.0.1:8080
`

  it('enrols an installed but unenrolled plugin before writing the config row', async () => {
    const { manager, dir, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } },
      patch: '[]\n',
    })
    const manifestPath = join(dir, 'package.json')

    await manager.attach('web', 'http://127.0.0.1:8080', async () => {})

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-searxng'])
    // Unrelated manifest fields survive the enrollment write.
    expect(manifest.dependencies).toEqual({ 'dsh-searxng': '0.5.0' })
    expect(ids(await fs.readFile(patchPath, 'utf8'))).toEqual(['web-search-searxng'])
  })

  it('reports the enrolled and composed profile in a preview', async () => {
    const { manager } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' } },
      patch: rowPatch,
    })
    await expect(manager.preview('web', 'http://127.0.0.1:8080')).resolves.toMatchObject({
      installed: true,
      mount: { enrolled: true, composes: true, observable: true },
    })
  })

  it('reports an unenrolled profile as a proven composition failure', async () => {
    // This is the exact defective profile found on a real machine: the plugin is
    // installed (so it is in `dependencies`), the config row targets its entry,
    // but nothing lists it in `dsh.profile.bundles`, so the bundle layer is
    // never applied, the insert never happens, and the row is silently skipped.
    // `reconcileBundles: false` is required precisely because `dsh plugin add`
    // would have enrolled it — this state comes from a hand-edited manifest.
    const created = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' }, dsh: { profile: { bundles: [] } } },
      patch: rowPatch,
      reconcileBundles: false,
    })
    await expect(created.manager.preview('web', 'http://127.0.0.1:8080')).resolves.toMatchObject({
      mount: { enrolled: false, composes: false, reason: 'not-enrolled', observable: true },
    })
    // The manifest really is in that shape, and the row really is present:
    // presence without enrolment is what makes the silent skip dangerous.
    expect(JSON.parse(await fs.readFile(join(created.dir, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { 'dsh-searxng': '0.5.0' },
      dsh: { profile: { bundles: [] } },
    })
    expect(ids(await fs.readFile(created.patchPath, 'utf8'))).toEqual(['web-search-searxng'])
  })

  it('refuses to write a config row the bundle layer would not mount', async () => {
    const original = '[]\n'
    const { manager, dir, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' }, dsh: { profile: { bundles: ['dsh-searxng'] } } },
      patch: original,
      bundle: 'other-id',
    })
    let validations = 0

    const error = await manager.attach('web', 'http://127.0.0.1:8080', async () => {
      validations += 1
    }).catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      code: 'E_PROFILE_BUNDLE_MISSING',
      details: { bundleMount: 'target-not-inserted', plugin: 'dsh-searxng' },
    })
    // The operator gets the exact consequence, not a generic write failure.
    expect((error as Error).message).toContain('WEB_PROVIDER_CONFIGURED_MISSING')
    expect((error as Error).message).toContain('silently skipped')
    // Nothing was written and no validation ran against a broken profile.
    expect(validations).toBe(0)
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(original)
    // The plugin is still installed: only the unmountable row was refused.
    expect(JSON.parse(await fs.readFile(join(dir, 'package.json'), 'utf8')))
      .toMatchObject({ dependencies: { 'dsh-searxng': '0.5.0' } })
  })

  it('reports a bundle patch that cannot be read as a distinct reason', async () => {
    const { manager } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' }, dsh: { profile: { bundles: ['dsh-searxng'] } } },
      bundle: 'unreadable',
    })
    await expect(manager.preview('web', 'http://127.0.0.1:8080')).resolves.toMatchObject({
      mount: { enrolled: true, composes: false, reason: 'patch-unreadable', observable: true },
    })
  })

  it('reports a plugin without bundle metadata as a distinct reason', async () => {
    const { manager } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' }, dsh: { profile: { bundles: ['dsh-searxng'] } } },
      bundle: 'no-metadata',
    })
    await expect(manager.preview('web', 'http://127.0.0.1:8080')).resolves.toMatchObject({
      mount: { enrolled: true, composes: false, reason: 'no-bundle-metadata', observable: true },
    })
  })

  it('reports an enrolled bundle whose package is absent as undecidable, not broken', async () => {
    const { manager } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' }, dsh: { profile: { bundles: ['dsh-searxng'] } } },
      bundle: null,
    })
    // `preview` still reports it so `doctor` can act, but marks it undecidable
    // so the write guard does not misattribute an install failure.
    await expect(manager.preview('web', 'http://127.0.0.1:8080')).resolves.toMatchObject({
      mount: { enrolled: true, composes: false, reason: 'package-missing', observable: false },
    })
  })

  it('does not misattribute an absent package to a bundle-composition bug', async () => {
    const { manager } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' }, dsh: { profile: { bundles: ['dsh-searxng'] } } },
      patch: '[]\n',
      bundle: null,
    })
    // The package is enrolled but not installed, so there is no patch file to
    // read. `attach` must not refuse on the strength of an unobservable layer.
    await expect(manager.attach('web', 'http://127.0.0.1:8080', async () => {}))
      .resolves.toBeUndefined()
  })

  it('is idempotent: a second attach reports no further enrollment', async () => {
    const { manager, dir } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' }, dsh: { profile: { bundles: [] } } },
      patch: '[]\n',
    })
    await manager.attach('web', 'http://127.0.0.1:8080', async () => {})
    const manifestPath = join(dir, 'package.json')
    const afterFirst = await fs.readFile(manifestPath, 'utf8')
    const before = await fs.lstat(manifestPath)

    await manager.attach('web', 'http://127.0.0.1:8080', async () => {})

    // An already-enrolled bundle is left byte-identical and untouched on disk.
    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(afterFirst)
    expect((await fs.lstat(manifestPath)).ino).toBe(before.ino)
    const bundles = (JSON.parse(afterFirst) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
    expect(bundles.filter((name) => name === 'dsh-searxng')).toHaveLength(1)
  })

  it('creates the bundle list when the manifest has no dsh section', async () => {
    const { manager, dir } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' } },
      patch: '[]\n',
      // A manifest with no `dsh.profile` at all: enrollment must create it.
    })
    // Remove the enrollment the fixture adds for object manifests, so this
    // exercises the no-`dsh` branch specifically.
    const manifestPath = join(dir, 'package.json')
    await fs.writeFile(manifestPath, `${JSON.stringify({ dependencies: { 'dsh-searxng': '0.5.0' } }, null, 2)}\n`)

    await manager.attach('web', 'http://127.0.0.1:8080', async () => {})

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['dsh-searxng'])
    expect(manifest.dependencies).toEqual({ 'dsh-searxng': '0.5.0' })
  })

  it('preserves unrelated manifest fields and key order on enrollment', async () => {
    const { manager, dir } = await fixture({
      packageJson: {
        name: 'dsh-profile-web',
        private: true,
        dependencies: { 'dsh-searxng': '0.5.0' },
        dsh: { profile: { bundles: [], extra: 'kept' }, unrelated: 42 },
        other: { nested: true },
      },
      patch: '[]\n',
    })
    await manager.attach('web', 'http://127.0.0.1:8080', async () => {})

    const text = await fs.readFile(join(dir, 'package.json'), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    const manifest = JSON.parse(text) as Record<string, unknown>
    expect(manifest).toMatchObject({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'dsh-searxng': '0.5.0' },
      dsh: { profile: { bundles: ['dsh-searxng'], extra: 'kept' }, unrelated: 42 },
      other: { nested: true },
    })
  })
})

describe('ProfileManager explicit uninstall', () => {
  it('uses the standard DSH command and verifies removal from the manifest', async () => {
    const test = await fixture({ packageJson: { dependencies: { 'dsh-searxng': '0.1.1', other: '1.0.0' } } })
    await test.manager.uninstall('web')
    expect(test.runner.calls).toContainEqual({ command: 'dsh', args: ['plugin', '--profile', 'web', 'remove', 'dsh-searxng'] })
    expect(JSON.parse(await fs.readFile(join(test.dir, 'package.json'), 'utf8'))).toMatchObject({ dependencies: { other: '1.0.0' } })
  })

  it('fails when the command reports success without removing the plugin', async () => {
    const runner = new RecordingRunner()
    runner.simulatePluginEffects = false
    const test = await fixture({ packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } }, runner })
    await expect(test.manager.uninstall('web')).rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
  })

  it('is a command-free no-op when the plugin is already absent', async () => {
    const test = await fixture({ packageJson: { dependencies: { other: '1.0.0' } } })
    await test.manager.uninstall('web')
    expect(test.runner.calls).toEqual([])
  })

  it('invokes the executable named by DSH_SEARXNG_DSH_BIN when no command is injected', async () => {
    // A Desktop-only install has no `dsh` on PATH; the override is the
    // supported way to point the CLI at the executable that does exist.
    const bin = process.platform === 'win32' ? 'C:\\opt\\dsh\\dsh.cmd' : '/opt/dsh/dsh'
    const previous = process.env.DSH_SEARXNG_DSH_BIN
    process.env.DSH_SEARXNG_DSH_BIN = bin
    try {
      const { manager, runner } = await fixture({ packageJson: { dependencies: { 'dsh-searxng': '0.5.0' } } })
      await manager.uninstall('web')
      expect(runner.calls).toContainEqual({
        command: bin,
        args: ['plugin', '--profile', 'web', 'remove', 'dsh-searxng'],
      })
    } finally {
      if (previous === undefined) delete process.env.DSH_SEARXNG_DSH_BIN
      else process.env.DSH_SEARXNG_DSH_BIN = previous
    }
  })
})

describe('transactional attachment', () => {
  it('does not run add or remove when another process installs the plugin before the add boundary', async () => {
    const uninstalled = `${JSON.stringify({ dependencies: {} }, null, 2)}\n`
    const installed = `${JSON.stringify({ dependencies: { 'dsh-searxng': '9.9.9' } }, null, 2)}\n`
    let manifestPath = ''
    let patchPath = ''
    let injected = false
    const fileSystem: ProfileFileSystem = {
      ...fs,
      readFile: (async (...args: Parameters<typeof fs.readFile>) => {
        const source = await fs.readFile(...args)
        if (String(args[0]) === patchPath && !injected) {
          injected = true
          await fs.writeFile(manifestPath, installed)
        }
        return source
      }) as typeof fs.readFile,
    }
    const created = await fixture({ packageJson: uninstalled, patch: '[]\n', fileSystem })
    manifestPath = join(created.dir, 'package.json')
    patchPath = created.patchPath

    await expect(created.manager.attach('web', 'http://localhost:8080', async () => {}))
      .rejects.toMatchObject({ code: 'E_PROFILE_CONCURRENT_MODIFICATION' })

    expect(created.runner.calls).toEqual([])
    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(installed)
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
  })

  it('fails before validation when plugin add reports success without installing the manifest dependency', async () => {
    const runner = new RecordingRunner()
    runner.simulatePluginEffects = false
    runner.handler = async () => ({ exitCode: 0, stdout: '', stderr: '' })
    const original = '# unchanged\n[]\n'
    const { manager, patchPath } = await fixture({ patch: original, runner })
    let validations = 0

    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      validations += 1
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryFailure: 'install', primaryError: 'process', rollbackFailures: [] },
    })
    expect(validations).toBe(0)
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(original)
  })

  it('passes the pinned install spec, not the bare registry name', async () => {
    // The bare name is the self-install blocker: the registry would serve
    // whatever `latest` is, which can be an older, correctly-rejected version.
    const { manager, runner } = await fixture({
      packageJson: { dependencies: {} },
      patch: '[]\n',
      pluginSpec: 'dsh-searxng@9.9.9',
    })
    await manager.attach('web', 'http://localhost:8080', async () => {})
    expect(runner.calls.map((call) => call.args)).toContainEqual([
      'plugin', '--profile', 'web', 'add', 'dsh-searxng@9.9.9',
    ])
    expect(runner.calls.map((call) => call.args).flat()).not.toContain(PLUGIN_NAME)
  })

  it('uses an injected local tarball spec verbatim so a pre-publication install works', async () => {
    // The exact case that was broken: 0.5.0 exists in a tarball but not on npm.
    const spec = 'file:./pack/dsh-searxng-0.5.0.tgz'
    const { manager, runner } = await fixture({
      packageJson: { dependencies: {} },
      patch: '[]\n',
      pluginSpec: spec,
    })
    await manager.attach('web', 'http://localhost:8080', async () => {})
    expect(runner.calls.map((call) => call.args)).toContainEqual([
      'plugin', '--profile', 'web', 'add', spec,
    ])
  })

  it('reports an incompatible-package rejection precisely instead of a generic install failure', async () => {
    // Reproduces the plugin manager's real diagnostic for an older release.
    const runner = new RecordingRunner()
    runner.simulatePluginEffects = false
    runner.handler = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: [
        'dsh: installation rejected: Plugin dsh-searxng@0.4.0 is incompatible with dsh 0.2.1-rc.2:',
        'requirements {"@deepseek-ai/dsh-web":">=0.1.0-rc.6 <0.2.0"}. Exact-version exemption: not active.',
        'dsh: nothing was installed.',
      ].join('\n'),
    })
    const original = '[]\n'
    const { manager, patchPath } = await fixture({ patch: original, runner })

    const error = await manager.attach('web', 'http://localhost:8080', async () => {})
      .catch((cause: unknown) => cause)

    // A precise, actionable code — not E_PROFILE_WRITE/profile-conflict, which
    // told the operator nothing about the actual problem.
    expect(error).toMatchObject({ code: 'E_PLUGIN_INSTALL_FAILED', details: { incompatible: true } })
    const cliError = error as CliError
    // The manager's own lines are quoted: they name the failing requirement.
    expect(cliError.message).toContain('incompatible with this dsh runtime')
    expect(cliError.message).toContain('dsh-searxng@0.4.0')
    expect(cliError.message).toContain('>=0.1.0-rc.6 <0.2.0')
    // The remedy names the override, since that is the way out pre-publication.
    expect(cliError.action).toContain(PLUGIN_SPEC_ENV)
    // Nothing was written: a refused install must not leave a config row behind.
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(original)
  })

  it('keeps every other add failure a plain install failure', async () => {
    // Only an incompatibility is separately actionable; a registry/network error
    // must not be misreported as an incompatibility.
    const runner = new RecordingRunner()
    runner.simulatePluginEffects = false
    runner.handler = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/dsh-searxng: Not Found',
    })
    const { manager } = await fixture({ patch: '[]\n', runner })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryFailure: 'install', primaryError: 'process' },
    })
  })

  it('does not claim or remove a plugin when the post-add manifest ownership snapshot is unstable', async () => {
    const installed = `${JSON.stringify({ dependencies: { 'dsh-searxng': '0.1.1' } }, null, 2)}\n`
    const runner = new RecordingRunner()
    runner.simulatePluginEffects = false
    let manifestPath = ''
    let manifestReads = 0
    const fileSystem: ProfileFileSystem = {
      ...fs,
      readFile: (async (...args: Parameters<typeof fs.readFile>) => {
        const source = await fs.readFile(...args)
        if (String(args[0]) === manifestPath) {
          manifestReads += 1
          if (manifestReads === 3) {
            const replacement = `${manifestPath}.replacement`
            await fs.writeFile(replacement, source)
            await fs.rename(replacement, manifestPath)
          }
        }
        return source
      }) as typeof fs.readFile,
    }
    const created = await fixture({ packageJson: { dependencies: {} }, patch: '[]\n', runner, fileSystem })
    manifestPath = join(created.dir, 'package.json')
    runner.handler = async (_command, args) => {
      if (args.includes('add')) await fs.writeFile(manifestPath, installed)
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await expect(created.manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: {
        primaryError: 'E_PROFILE_CONCURRENT_MODIFICATION',
        rollbackFailures: ['plugin-residual'],
      },
    })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(installed)
  })

  it('rejects manifest dependency removal during attachment validation without removing a pre-existing plugin', async () => {
    const original = '[]\n'
    const { manager, runner, dir, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch: original,
    })
    const manifestPath = join(dir, 'package.json')

    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      await fs.writeFile(manifestPath, `${JSON.stringify({ dependencies: {} }, null, 2)}\n`)
    })).rejects.toMatchObject({ code: 'E_PROFILE_CONCURRENT_MODIFICATION' })

    expect(runner.calls).toEqual([])
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(original)
  })

  it('rejects a same-byte manifest inode replacement during attachment validation', async () => {
    const packageJson = `${JSON.stringify({ dependencies: { 'dsh-searxng': '0.1.1' } }, null, 2)}\n`
    const original = '[]\n'
    const { manager, runner, dir, patchPath } = await fixture({ packageJson, patch: original })
    const manifestPath = join(dir, 'package.json')
    const before = await fs.lstat(manifestPath)

    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      const replacement = `${manifestPath}.replacement`
      await fs.writeFile(replacement, packageJson)
      await fs.rename(replacement, manifestPath)
    })).rejects.toMatchObject({ code: 'E_PROFILE_CONCURRENT_MODIFICATION' })

    expect(runner.calls).toEqual([])
    expect((await fs.lstat(manifestPath)).ino).not.toBe(before.ino)
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(original)
  })

  it('rejects a same-byte manifest replacement during the patch write before validation', async () => {
    const packageJson = `${JSON.stringify({ dependencies: { 'dsh-searxng': '0.1.1' } }, null, 2)}\n`
    let manifestPath = ''
    let patchPath = ''
    let replaceManifest = true
    const fileSystem: ProfileFileSystem = {
      ...fs,
      rename: async (...args: Parameters<typeof fs.rename>) => {
        await fs.rename(...args)
        if (String(args[1]) === patchPath && replaceManifest) {
          replaceManifest = false
          const replacement = `${manifestPath}.replacement`
          await fs.writeFile(replacement, packageJson)
          await fs.rename(replacement, manifestPath)
        }
      },
    }
    const created = await fixture({ packageJson, patch: '[]\n', fileSystem })
    manifestPath = join(created.dir, 'package.json')
    patchPath = created.patchPath
    let validations = 0

    await expect(created.manager.attach('web', 'http://localhost:8080', async () => {
      validations += 1
    })).rejects.toMatchObject({ code: 'E_PROFILE_CONCURRENT_MODIFICATION' })

    expect(validations).toBe(0)
    expect(created.runner.calls).toEqual([])
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
  })

  it('passes a safe clone of the exact written effective config to validation', async () => {
    const patch = `- id: web-search-searxng
  config:
    language: zh-CN
    engines: bing
    categories: general
    authHeader: Bearer private-token
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch,
    })
    let received: object | undefined
    await manager.attach('web', 'https://search.example/', async (config) => {
      received = config
      ;(config as { baseURL: string }).baseURL = 'http://mutated.invalid'
    })
    expect(received).toEqual({
      baseURL: 'http://mutated.invalid',
      language: 'zh-CN',
      engines: 'bing',
      categories: 'general',
      authHeader: 'Bearer private-token',
      mode: 'external',
    })
    const rows = parse(await fs.readFile(patchPath, 'utf8')) as Array<{ config?: Record<string, unknown> }>
    expect(rows.at(-1)?.config?.baseURL).toBe('https://search.example')
  })
  it('installs with exact argv, writes an empty patch, then validates', async () => {
    const events: string[] = []
    const runner = new RecordingRunner()
    const originalRun = runner.run.bind(runner)
    runner.run = async (command, args) => {
      events.push('install')
      return originalRun(command, args)
    }
    const { manager, runner: recorded, patchPath } = await fixture({ patch: '[]\n', runner })

    await manager.attach('', 'http://127.0.0.1:8080', async () => {
      events.push('validate')
      expect(await fs.readFile(patchPath, 'utf8')).toContain('baseURL: http://127.0.0.1:8080')
    })

    expect(recorded.calls).toEqual([{
      command: 'dsh',
      args: ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    }])
    expect(events).toEqual(['install', 'validate'])
    const output = await fs.readFile(patchPath, 'utf8')
    expect(ids(output)).toEqual(['web-search-searxng'])
    expect(output).toContain('# dsh-searxng managed attachment')
  })

  it('preserves comments, unrelated nodes, and the last effective full config', async () => {
    const patch = `# profile comment
- id: unrelated
  config:
    answer: 42 # inline survives
- id: web-search-searxng
  config:
    baseURL: http://first.invalid
    firstOnly: true
- id: web-search-searxng
  config:
    baseURL: http://last.invalid
    unknownKey: keep
    nested:
      enabled: true
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '^0.1.0' } },
      patch,
    })

    await manager.attach('web', 'https://search.example/root///', async () => {})

    const output = await fs.readFile(patchPath, 'utf8')
    expect(output).toContain('# profile comment')
    expect(output).toContain('# inline survives')
    expect(ids(output)).toEqual([
      'unrelated',
      'web-search-searxng',
      'web-search-searxng',
      'web-search-searxng',
    ])
    const rows = parse(output) as Array<{ id: string; config?: Record<string, unknown> }>
    expect(rows.at(-1)).toEqual({
      id: 'web-search-searxng',
      config: {
        baseURL: 'https://search.example/root',
        unknownKey: 'keep',
        nested: { enabled: true },
        mode: 'external',
      },
    })
  })

  it('replaces a prior managed patch idempotently without duplicating it', async () => {
    const patch = `- id: web-search-searxng
  config:
    timeoutMs: 5000
# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    timeoutMs: 5000
    baseURL: http://old.invalid
`
    const { manager, patchPath } = await fixture({
      packageJson: { dsh: { profile: { bundles: ['dsh-searxng'] } } },
      patch,
    })
    await manager.attach('web', 'http://new.example/', async () => {})
    await manager.attach('web', 'http://newer.example', async () => {})

    const output = await fs.readFile(patchPath, 'utf8')
    expect(output.match(/dsh-searxng managed attachment/g)).toHaveLength(1)
    expect(ids(output)).toEqual(['web-search-searxng', 'web-search-searxng'])
    expect((parse(output) as Array<{ config: Record<string, unknown> }>).at(-1)?.config).toEqual({
      timeoutMs: 5000,
      baseURL: 'http://newer.example',
      mode: 'external',
    })
  })

  it('copies a later managed config instead of an earlier unmarked target config', async () => {
    const patch = `- id: web-search-searxng
  config:
    timeoutMs: 1000
    source: user
# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    timeoutMs: 9000
    source: managed
    laterOnly: keep
    baseURL: http://old.invalid
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch,
    })

    await manager.attach('web', 'http://new.example', async () => {})

    const rows = parse(await fs.readFile(patchPath, 'utf8')) as Array<{
      id: string
      config: Record<string, unknown>
    }>
    expect(rows.at(-1)?.config).toEqual({
      timeoutMs: 9000,
      source: 'managed',
      laterOnly: 'keep',
      baseURL: 'http://new.example',
      mode: 'external',
    })
  })

  it('copies a later unmarked target config after an earlier managed patch', async () => {
    const patch = `# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    source: managed
    baseURL: http://old.invalid
- id: web-search-searxng
  config:
    source: later-user
    userOnly: keep
    baseURL: http://user.invalid
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch,
    })

    await manager.attach('web', 'http://new.example', async () => {})

    const rows = parse(await fs.readFile(patchPath, 'utf8')) as Array<{
      id: string
      config: Record<string, unknown>
    }>
    expect(rows.at(-1)?.config).toEqual({
      source: 'later-user',
      userOnly: 'keep',
      baseURL: 'http://new.example',
      mode: 'external',
    })
  })

  it.each([
    'ftp://search.example',
    'https://user:password@search.example',
    'https://search.example?q=secret',
    'https://search.example/#secret',
  ])('rejects unsafe endpoint %s before install or writes', async (endpoint) => {
    const original = Buffer.from('[]\n')
    const { manager, runner, patchPath } = await fixture({ patch: original.toString() })
    await expect(manager.attach('web', endpoint, async () => {})).rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
    expect(runner.calls).toEqual([])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
  })

  it.each([
    ['mapping root', 'key: value\n'],
    ['empty document', '# comment only\n'],
    ['invalid YAML', '- id: [\n'],
  ])('rejects a malformed %s without installing or changing bytes', async (_name, patch) => {
    const original = Buffer.from(patch)
    const { manager, runner, patchPath } = await fixture({ patch })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
    expect(runner.calls).toEqual([])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
  })

  it.each([
    ['readiness', new CliError('E_SEARXNG_START_TIMEOUT', 'not ready', 'retry'), 'E_SEARXNG_START_TIMEOUT'],
    ['provider', new CliError('E_SEARCH_FAILED', 'provider failed', 'retry'), 'E_SEARCH_FAILED'],
    ['state', new CliError('E_INTERNAL', 'state failed', 'retry'), 'E_INTERNAL'],
    ['cancellation', Object.assign(new Error('cancelled'), { name: 'AbortError' }), 'abort'],
  ])('restores the patch but retains an added plugin residual after %s failure', async (_stage, failure, primaryError) => {
    const original = Buffer.from('# exact\n- id: other\n  config: { value: 1 }\n')
    const { manager, runner, patchPath } = await fixture({ patch: original.toString() })

    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      throw failure
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      action: expect.stringMatching(/setup/i),
      details: { primaryFailure: 'validation', primaryError, rollbackFailures: ['plugin-residual'] },
    })

    expect(runner.calls).toEqual([
      { command: 'dsh', args: ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC] },
    ])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
    await expect(manager.inspect('web')).resolves.toMatchObject({ installed: true })
  })

  it('reuses a retained plugin residual on the next successful attachment', async () => {
    const { manager, runner, patchPath } = await fixture({ patch: '[]\n' })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      throw new CliError('E_SEARCH_FAILED', 'provider failed', 'retry')
    })).rejects.toMatchObject({
      details: { rollbackFailures: ['plugin-residual'] },
    })

    await expect(manager.attach('web', 'http://localhost:8080', async () => {})).resolves.toBeUndefined()

    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toContain('dsh-searxng managed attachment')
  })

  it.each([
    ['version', { dependencies: { 'dsh-searxng': '2.0.0' } }],
    ['registration source', { dependencies: {}, dsh: { profile: { bundles: ['dsh-searxng'] } } }],
  ])('does not remove a transaction-added plugin after validation changes its %s', async (_change, concurrentManifest) => {
    const runner = new RecordingRunner()
    runner.simulatePluginEffects = false
    const created = await fixture({ packageJson: { dependencies: {} }, patch: '[]\n', runner })
    const manifestPath = join(created.dir, 'package.json')
    runner.handler = async (_command, args) => {
      if (args.includes('add')) {
        await fs.writeFile(manifestPath, `${JSON.stringify({ dependencies: { 'dsh-searxng': '0.1.1' } }, null, 2)}\n`)
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await expect(created.manager.attach('web', 'http://localhost:8080', async () => {
      await fs.writeFile(manifestPath, `${JSON.stringify(concurrentManifest, null, 2)}\n`)
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: {
        primaryError: 'E_PROFILE_CONCURRENT_MODIFICATION',
        rollbackFailures: ['plugin-residual'],
      },
    })

    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(`${JSON.stringify(concurrentManifest, null, 2)}\n`)
    await expect(fs.readFile(created.patchPath, 'utf8')).resolves.toBe('[]\n')
  })

  it('rethrows a safe validation CliError unchanged after successful rollback', async () => {
    const validationError = new CliError(
      'E_AUTH_FAILED',
      'SearXNG authentication failed',
      'Check the configured authorization header and retry',
    )
    const { manager } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch: '[]\n',
    })
    let error: unknown
    try {
      await manager.attach('web', 'http://localhost:8080', async () => { throw validationError })
    } catch (cause) { error = cause }
    expect(error).toBe(validationError)
  })

  it('rethrows validation cancellation unchanged after successful rollback', async () => {
    const cancellation = new Error('The operation was aborted')
    cancellation.name = 'AbortError'
    const { manager } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.1' } },
      patch: '[]\n',
    })
    let error: unknown
    try {
      await manager.attach('web', 'http://localhost:8080', async () => { throw cancellation })
    } catch (cause) { error = cause }
    expect(error).toBe(cancellation)
  })

  it('restores original absence after validation fails', async () => {
    const { manager, runner, patchPath } = await fixture()
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      throw new Error('no')
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { rollbackFailures: ['plugin-residual'] },
    })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    await expect(fs.lstat(patchPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(manager.inspect('web')).resolves.toMatchObject({ installed: true })
  })

  it('restores the exact successful-add initialization after validation fails', async () => {
    const runner = new RecordingRunner()
    const initialized = Buffer.from(`# initialized by dsh
- id: unrelated
  config:
    keep: true # preserve comment
- id: web-search-searxng
  config:
    baseURL: http://initialized.invalid/base/
    providerOption: keep
`)
    const { manager, dir, patchPath } = await fixture({ runner })
    runner.handler = async (_command, args) => {
      if (args.includes('add')) {
        await fs.writeFile(join(dir, 'package.json'), JSON.stringify({
          dependencies: { 'dsh-searxng': '0.1.0' },
        }))
        await fs.writeFile(patchPath, initialized)
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      const attached = await fs.readFile(patchPath, 'utf8')
      expect(attached).toContain('# dsh-searxng managed attachment')
      throw new Error('validation failed')
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryFailure: 'validation', rollbackFailures: ['plugin-residual'] },
    })

    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    await expect(fs.readFile(patchPath)).resolves.toEqual(initialized)
  })

  it('never removes a pre-existing plugin when validation fails', async () => {
    const { manager, runner } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '^0.1.0' } },
      patch: '[]\n',
    })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      throw new Error('no')
    })).rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
    expect(runner.calls).toEqual([])
  })
})

describe('rollback and file safety', () => {
  function proxiedHandle(handle: FileHandle, writeFile: FileHandle['writeFile']): FileHandle {
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'writeFile') return writeFile.bind(handle)
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  it('does not validate, cleans temporary files, restores bytes, and retains an added plugin after write failure', async () => {
    // Inject the failure on the PATCH write specifically, not by call ordinal:
    // attach now also writes the profile manifest when it has to enrol the
    // bundle, so "the first temp file opened" is no longer necessarily the
    // patch. Targeting the path keeps this test about patch-write rollback.
    let failed = false
    let patchPathForInjection = ''
    const fileSystem: ProfileFileSystem = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        const target = String(args[0])
        if (!failed && target.includes(patchPathForInjection) && target.includes('.tmp-')) {
          failed = true
          return proxiedHandle(handle, async () => { throw new Error('write secret') })
        }
        return handle
      },
    }
    const original = Buffer.from('# exact\n[]\n')
    const created = await fixture({ patch: original.toString(), fileSystem })
    patchPathForInjection = created.patchPath
    const { manager, runner, dir, patchPath } = created
    let validations = 0
    await expect(manager.attach('web', 'http://localhost:8080', async () => { validations += 1 }))
      .rejects.toMatchObject({
        code: 'E_PROFILE_WRITE',
        details: { primaryFailure: 'write', rollbackFailures: ['plugin-residual'] },
      })
    expect(validations).toBe(0)
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    await expect(manager.inspect('web')).resolves.toMatchObject({ installed: true })
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
    expect((await fs.readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('reports patch rollback failure alongside the primary failure without leaking causes', async () => {
    // Target the rollback rename of the patch file by path rather than "the
    // second rename": attach performs an additional manifest rename when it
    // enrols the bundle, so ordinals are not stable.
    let patchPathForInjection = ''
    let patchRenames = 0
    const fileSystem: ProfileFileSystem = {
      ...fs,
      rename: async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) === patchPathForInjection) patchRenames += 1
        // The first patch rename is the forward write; the second is the
        // rollback, which is the one that must fail here.
        if (String(args[1]) === patchPathForInjection && patchRenames === 2) {
          throw new Error('rollback endpoint https://private.invalid?q=token')
        }
        await fs.rename(...args)
      },
    }
    const created = await fixture({ patch: '[]\n', fileSystem })
    patchPathForInjection = created.patchPath
    const { manager } = created
    let error: unknown
    try {
      await manager.attach('web', 'http://localhost:8080', async () => { throw new Error('validation token') })
    } catch (cause) { error = cause }
    expect(error).toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: {
        primaryFailure: 'validation',
        primaryError: 'unknown',
        rollbackFailures: ['plugin-residual', 'patch'],
      },
    })
    expect(JSON.stringify(error)).not.toContain('private.invalid')
    expect(JSON.stringify(error)).not.toContain('validation token')
  })

  it('preserves command cancellation after confirming there was no install side effect', async () => {
    const runner = new RecordingRunner()
    const cancellation = new Error('cancel secret endpoint https://private.invalid?q=token')
    cancellation.name = 'AbortError'
    runner.failure = cancellation
    const { manager, patchPath } = await fixture({ patch: '[]\n', runner })
    let error: unknown
    try { await manager.attach('web', 'http://localhost:8080', async () => {}) } catch (cause) { error = cause }
    expect(error).toBe(cancellation)
    expect(JSON.stringify(error)).not.toContain('private.invalid')
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
  })

  it('passes the exact signal to add and reports a retained plugin residual after abort side effects', async () => {
    const controller = new AbortController()
    const cancellation = new Error('cancelled')
    cancellation.name = 'AbortError'
    const runner = new RecordingRunner()
    const { manager, dir } = await fixture({ patch: '[]\n', runner })
    runner.handler = async (_command, args) => {
      if (args.includes('add')) {
        await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-searxng': '0.1.0' } }))
        throw cancellation
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    let error: unknown
    try {
      await manager.attach('web', 'http://localhost:8080', async () => {}, controller.signal)
    } catch (cause) { error = cause }

    expect(error).toMatchObject({
      code: 'E_PROFILE_WRITE',
      action: expect.stringMatching(/setup/i),
      details: { primaryError: 'abort', rollbackFailures: ['plugin-residual'] },
    })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    expect(runner.signals[0]).toBe(controller.signal)
  })

  it('detects and retains an install residual after a nonzero add result', async () => {
    const runner = new RecordingRunner()
    const { manager, dir } = await fixture({ patch: '[]\n', runner })
    runner.handler = async (_command, args) => {
      if (args.includes('add')) {
        await fs.writeFile(join(dir, 'package.json'), JSON.stringify({
          dsh: { profile: { bundles: ['dsh-searxng'] } },
        }))
        return { exitCode: 1, stdout: '', stderr: 'unsafe process output' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await expect(manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: {
        primaryFailure: 'install',
        primaryError: 'process',
        rollbackFailures: ['plugin-residual'],
      },
    })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    await expect(manager.inspect('web')).resolves.toMatchObject({ installed: true })
  })

  it('preserves an existing patch changed by a failed add even when the manifest stays uninstalled', async () => {
    const runner = new RecordingRunner()
    const original = '# original before failed add\n- id: original\n'
    const changed = '# changed by failed add\n- id: changed\n'
    const { manager, patchPath } = await fixture({ patch: original, runner })
    runner.handler = async (_command, args) => {
      if (args.includes('add')) {
        await fs.writeFile(patchPath, changed)
        return { exitCode: 1, stdout: '', stderr: 'unsafe process output' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await expect(manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: {
        primaryFailure: 'install',
        primaryError: 'profile-conflict',
      },
    })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(changed)
  })

  it('preserves a patch created before add aborts when the manifest stays uninstalled', async () => {
    const runner = new RecordingRunner()
    const cancellation = new Error('cancelled')
    cancellation.name = 'AbortError'
    const changed = '# created by aborted add\n- id: changed\n'
    const { manager, patchPath } = await fixture({ runner })
    runner.handler = async (_command, args) => {
      if (args.includes('add')) {
        await fs.writeFile(patchPath, changed)
        throw cancellation
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await expect(manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: {
        primaryFailure: 'install',
        primaryError: 'profile-conflict',
      },
    })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(changed)
  })

  it('preserves a patch initialized by the add command', async () => {
    const runner = new RecordingRunner()
    const { manager, dir, patchPath } = await fixture({ runner })
    runner.handler = async () => {
      await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-searxng': '0.1.0' } }))
      await fs.writeFile(patchPath, '# initialized by dsh\n- id: initialized\n  config: { keep: true }\n')
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await manager.attach('web', 'http://localhost:8080', async () => {})
    const output = await fs.readFile(patchPath, 'utf8')
    expect(output).toContain('# initialized by dsh')
    expect(ids(output)).toEqual(['initialized', 'web-search-searxng'])
  })

  it('preserves an existing patch changed during add and reports a conflict before validation', async () => {
    const runner = new RecordingRunner()
    const original = '# original A\n- id: original\n'
    const changed = '# changed B during add\n- id: changed\n'
    const { manager, dir, patchPath } = await fixture({ patch: original, runner })
    runner.handler = async (_command, args) => {
      if (args.includes('add')) {
        await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-searxng': '0.1.0' } }))
        await fs.writeFile(patchPath, changed)
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    let validations = 0

    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      validations += 1
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryError: 'profile-conflict', rollbackFailures: ['plugin-residual'] },
    })
    expect(validations).toBe(0)
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', TEST_PLUGIN_SPEC],
    ])
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(changed)
  })

  it('does not overwrite a concurrent patch change observed before commit', async () => {
    const original = '# original\n[]\n'
    const concurrent = '# concurrent before commit\n- id: editor\n'
    let patchReads = 0
    let patchPath = ''
    const fileSystem: ProfileFileSystem = {
      ...fs,
      readFile: (async (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === patchPath) {
          patchReads += 1
          if (patchReads === 3) await fs.writeFile(patchPath, concurrent)
        }
        return fs.readFile(...args)
      }) as typeof fs.readFile,
    }
    const created = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch: original,
      fileSystem,
    })
    patchPath = created.patchPath

    await expect(created.manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryFailure: 'write', primaryError: 'profile-conflict' },
    })
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(concurrent)
  })

  it('preserves a concurrent validation edit and reports rollback conflict', async () => {
    const concurrent = '# concurrent during validation\n- id: editor\n'
    const validationError = new CliError('E_SEARCH_FAILED', 'Search failed', 'Retry')
    const { manager, patchPath } = await fixture({ patch: '[]\n' })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      await fs.writeFile(patchPath, concurrent)
      throw validationError
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: {
        primaryFailure: 'validation',
        primaryError: 'E_SEARCH_FAILED',
        rollbackFailures: ['plugin-residual', 'patch-conflict'],
      },
    })
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(concurrent)
  })

  it('treats a same-byte atomic replacement during validation as a rollback conflict', async () => {
    const validationError = new CliError('E_SEARCH_FAILED', 'Search failed', 'Retry')
    const { manager, patchPath } = await fixture({ patch: '[]\n' })
    let replacementInode: number | undefined
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      const managedBytes = await fs.readFile(patchPath)
      const replacement = `${patchPath}.editor`
      await fs.writeFile(replacement, managedBytes)
      await fs.rename(replacement, patchPath)
      replacementInode = (await fs.lstat(patchPath)).ino
      throw validationError
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { rollbackFailures: ['plugin-residual', 'patch-conflict'] },
    })
    expect((await fs.lstat(patchPath)).ino).toBe(replacementInode)
    expect(await fs.readFile(patchPath, 'utf8')).toContain('dsh-searxng managed attachment')
  })

  it('does not report success when validation returns after a different-byte edit', async () => {
    const concurrent = '# validation returned after edit\n- id: newest\n'
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch: '[]\n',
    })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      await fs.writeFile(patchPath, concurrent)
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryError: 'profile-conflict', rollbackFailures: ['patch-conflict'] },
    })
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(concurrent)
  })

  it('does not report success when validation returns after a same-byte inode replacement', async () => {
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch: '[]\n',
    })
    let replacementInode: number | undefined
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      const managedBytes = await fs.readFile(patchPath)
      const replacement = `${patchPath}.validation-returned`
      await fs.writeFile(replacement, managedBytes)
      await fs.rename(replacement, patchPath)
      replacementInode = (await fs.lstat(patchPath)).ino
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryError: 'profile-conflict', rollbackFailures: ['patch-conflict'] },
    })
    expect((await fs.lstat(patchPath)).ino).toBe(replacementInode)
  })

  it.skipIf(process.platform === 'win32')('cleans temporary files and restores the original after a directory fsync failure', async () => {
    let failDirectorySync = true
    const fileSystem: ProfileFileSystem = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        if (args[1] === 'r' && failDirectorySync) {
          failDirectorySync = false
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'sync') return async () => { throw new Error('directory fsync failed') }
              const value = Reflect.get(target, property, target) as unknown
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        }
        return handle
      },
    }
    const original = Buffer.from('# exact\n[]\n')
    const { manager, dir, patchPath } = await fixture({ patch: original.toString(), fileSystem })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryFailure: 'write', primaryError: 'filesystem', rollbackFailures: ['plugin-residual'] },
    })
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
    expect((await fs.readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('preserves a same-byte foreign replacement made while post-rename directory fsync fails', async () => {
    let replaceDuringDirectorySync = true
    let patchPath = ''
    let foreignInode: number | undefined
    const fileSystem: ProfileFileSystem = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        if (args[1] === 'r' && replaceDuringDirectorySync) {
          replaceDuringDirectorySync = false
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'sync') return async () => {
                const committedBytes = await fs.readFile(patchPath)
                const replacement = `${patchPath}.foreign`
                await fs.writeFile(replacement, committedBytes)
                await fs.rename(replacement, patchPath)
                foreignInode = (await fs.lstat(patchPath)).ino
                throw new Error('directory fsync failed after foreign replacement')
              }
              const value = Reflect.get(target, property, target) as unknown
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        }
        return handle
      },
    }
    const created = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch: '[]\n',
      fileSystem,
    })
    patchPath = created.patchPath

    await expect(created.manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { rollbackFailures: ['patch-conflict'] },
    })
    expect((await fs.lstat(patchPath)).ino).toBe(foreignInode)
    expect(await fs.readFile(patchPath, 'utf8')).toContain('dsh-searxng managed attachment')
  })

  it.skipIf(process.platform === 'win32')('rejects and preserves a same-byte foreign replacement made immediately after rename', async () => {
    let replaceAfterRename = true
    let patchPath = ''
    let foreignInode: number | undefined
    const fileSystem: ProfileFileSystem = {
      ...fs,
      rename: async (...args: Parameters<typeof fs.rename>) => {
        await fs.rename(...args)
        if (String(args[1]) === patchPath && replaceAfterRename) {
          replaceAfterRename = false
          const committedBytes = await fs.readFile(patchPath)
          const replacement = `${patchPath}.foreign-after-rename`
          await fs.writeFile(replacement, committedBytes)
          await fs.rename(replacement, patchPath)
          foreignInode = (await fs.lstat(patchPath)).ino
        }
      },
    }
    const created = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch: '[]\n',
      fileSystem,
    })
    patchPath = created.patchPath
    let validations = 0

    await expect(created.manager.attach('web', 'http://localhost:8080', async () => {
      validations += 1
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryError: 'profile-conflict', rollbackFailures: ['patch-conflict'] },
    })
    expect(validations).toBe(0)
    expect((await fs.lstat(patchPath)).ino).toBe(foreignInode)
    expect(await fs.readFile(patchPath, 'utf8')).toContain('dsh-searxng managed attachment')
  })

  it('writes user-only files and leaves no temporary artifacts', async () => {
    const { manager, dir, patchPath } = await fixture({ patch: '[]\n' })
    await manager.attach('web', 'http://localhost:8080', async () => {})
    if (process.platform !== 'win32') expect((await fs.stat(patchPath)).mode & 0o777).toBe(0o600)
    expect((await fs.readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  // Gated on a MEASURED capability, not `process.platform`: a Windows host with
  // Developer Mode keeps this coverage. See symlink-capability.ts.
  it.skipIf(symlinkUnsupported)(symlinkTestTitle('rejects symlinked profile files without following or changing them'), async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'dsh-profile-outside-'))
    roots.push(outside)
    const secret = join(outside, 'secret.yml')
    await fs.writeFile(secret, '[]\n')
    const { manager, patchPath } = await fixture()
    await fs.symlink(secret, patchPath)
    await expect(manager.attach('web', 'http://localhost:8080', async () => {}))
      .rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
    await expect(fs.readFile(secret, 'utf8')).resolves.toBe('[]\n')
  })
})

describe('detachment', () => {
  it('removes only marker-and-id matches, preserving marker-only and unmarked target patches', async () => {
    const patch = `# keep top
- id: web-search-searxng
  config: { baseURL: http://user.invalid }
# dsh-searxng managed attachment
- id: other
  config: { untouched: true }
# dsh-searxng managed attachment
- id: web-search-searxng
  config: { baseURL: http://managed.invalid }
`
    const { manager, runner, patchPath } = await fixture({ patch })
    await manager.detach('web')
    await manager.detach('web')

    const output = await fs.readFile(patchPath, 'utf8')
    expect(ids(output)).toEqual(['web-search-searxng', 'other'])
    expect(output).toContain('# keep top')
    expect(output).toContain('# dsh-searxng managed attachment')
    expect(output).toContain('http://user.invalid')
    expect(output).not.toContain('http://managed.invalid')
    expect(runner.calls).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects and preserves a same-byte foreign replacement immediately after detach rename', async () => {
    const patch = `# dsh-searxng managed attachment
- id: web-search-searxng
  config: { baseURL: http://managed.invalid }
- id: user
  config: { keep: true }
`
    let replaceAfterRename = true
    let patchPath = ''
    let foreignInode: number | undefined
    const fileSystem: ProfileFileSystem = {
      ...fs,
      rename: async (...args: Parameters<typeof fs.rename>) => {
        await fs.rename(...args)
        if (String(args[1]) === patchPath && replaceAfterRename) {
          replaceAfterRename = false
          const detachedBytes = await fs.readFile(patchPath)
          const replacement = `${patchPath}.foreign-detach`
          await fs.writeFile(replacement, detachedBytes)
          await fs.rename(replacement, patchPath)
          foreignInode = (await fs.lstat(patchPath)).ino
        }
      },
    }
    const created = await fixture({ patch, fileSystem })
    patchPath = created.patchPath

    await expect(created.manager.detach('web')).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryError: 'profile-conflict', rollbackFailures: ['patch-conflict'] },
    })
    expect((await fs.lstat(patchPath)).ino).toBe(foreignInode)
    expect(ids(await fs.readFile(patchPath, 'utf8'))).toEqual(['user'])
  })
})

describe('YAML document shape', () => {
  it('retains unrelated anchors and styles as YAML AST nodes permit', async () => {
    const patch = `- id: unrelated
  config: &shared
    style: 'quoted'
- id: another
  config: *shared
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch,
    })
    await manager.attach('web', 'http://localhost:8080', async () => {})
    const output = await fs.readFile(patchPath, 'utf8')
    expect(output).toContain('&shared')
    expect(output).toContain('*shared')
    expect(output).toContain("style: 'quoted'")
    expect(parseDocument(output).errors).toEqual([])
  })

  it('rejects an aliased target config safely before mutation', async () => {
    const patch = `- id: source
  config: &shared
    timeoutMs: 1000
- id: web-search-searxng
  config: *shared
`
    const original = Buffer.from(patch)
    const { manager, runner, patchPath } = await fixture({ patch })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {}))
      .rejects.toMatchObject({ code: 'E_PROFILE_WRITE', details: {} })
    expect(runner.calls).toEqual([])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
  })

  it('rejects an anchored target config safely before first attachment', async () => {
    const patch = `- id: web-search-searxng
  config: &provider
    timeoutMs: 1000
    baseURL: http://old.invalid
`
    const original = Buffer.from(patch)
    const { manager, runner, patchPath } = await fixture({ patch })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {}))
      .rejects.toMatchObject({ code: 'E_PROFILE_WRITE', details: {} })
    expect(runner.calls).toEqual([])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
  })

  it('supports a normal first attach, reattach, and detach lifecycle', async () => {
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch: '[]\n',
    })
    await manager.attach('web', 'http://first.example', async () => {})
    await manager.attach('web', 'http://second.example', async () => {})
    await manager.detach('web')
    expect(parse(await fs.readFile(patchPath, 'utf8'))).toEqual([])
  })

  it('writes block style, matching the shape a DSH profile and the shipped template use', async () => {
    // A profile initialized from the shipped template starts as the flow
    // sequence `[]`. Appending to it would otherwise serialize the whole file as
    // `[{ id: ..., config: { ... } }]`: valid YAML, but nothing like the block
    // shape every real profile has, and unreadable as the config grows.
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' } },
      patch: '# keep me\n[]\n',
    })
    await manager.attach('web', 'http://127.0.0.1:8080', async () => {})

    const output = await fs.readFile(patchPath, 'utf8')
    expect(output).toContain('# keep me')
    // Block sequence and block mapping, with the comment preserved above.
    expect(output).toBe([
      '# keep me',
      '# dsh-searxng managed attachment',
      '- id: web-search-searxng',
      '  config:',
      '    baseURL: http://127.0.0.1:8080',
      '    mode: external',
      '',
    ].join('\n'))
    expect(parseDocument(output).errors).toEqual([])
  })

  it('writes mode and baseURL in the same order and shape regardless of attach count', async () => {
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' } },
      patch: '[]\n',
    })
    await manager.attach('web', 'http://127.0.0.1:8080', async () => {})
    const first = await fs.readFile(patchPath, 'utf8')
    await manager.attach('web', 'http://127.0.0.1:8080', async () => {})
    // Idempotent: a repeat attach with the same endpoint writes identical bytes.
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(first)
  })

  it('preserves a baseURLs failover pool verbatim while writing mode and baseURL', async () => {
    // The pool is the operator's own configuration and outranks `baseURL` inside
    // the provider. The CLI records the requested endpoint and the mode but must
    // never reorder, dedupe, or drop the pool — reordering could push traffic to
    // an endpoint they did not choose as primary.
    const patch = `- id: web-search-searxng
  config:
    baseURL: http://old.invalid
    baseURLs:
      - https://primary.example
      - https://secondary.example
    language: zh-CN
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.5.0' } },
      patch,
    })
    await manager.attach('web', 'http://127.0.0.1:8080', async () => {}, undefined, 'external')

    const rows = parse(await fs.readFile(patchPath, 'utf8')) as Array<{ id: string; config?: Record<string, unknown> }>
    expect(rows.at(-1)?.config).toEqual({
      baseURL: 'http://127.0.0.1:8080',
      baseURLs: ['https://primary.example', 'https://secondary.example'],
      language: 'zh-CN',
      mode: 'external',
    })
  })

  it('rejects removing a managed anchor referenced by a later retained alias', async () => {
    const patch = `# dsh-searxng managed attachment
- id: web-search-searxng
  config: &managed
    baseURL: http://old.invalid
- id: later
  config: *managed
`
    const original = Buffer.from(patch)
    const { manager, runner, patchPath } = await fixture({ patch })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {}))
      .rejects.toMatchObject({ code: 'E_PROFILE_WRITE', details: {} })
    expect(runner.calls).toEqual([])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
  })
})
