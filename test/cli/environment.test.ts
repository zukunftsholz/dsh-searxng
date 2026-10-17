import { describe, expect, it, vi } from 'vitest'
import { join, normalize, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  DSH_BIN_ENV,
  DSH_MISSING_ACTION,
  NodeEnvironmentService,
  resolveDshCommand,
  homeId,
  managedDir,
  profileDir,
  resolveDshHome,
  type EnvironmentService,
} from '../../src/cli/environment.ts'

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

describe('environment helpers', () => {
  it('resolves injected DSH_HOME or the injected home directory', () => {
    const homeDirectory = resolve('/Users/test')
    expect(resolveDshHome({ DSH_HOME: '/tmp/dsh' }, homeDirectory)).toBe(resolve('/tmp/dsh'))
    expect(resolveDshHome({ DSH_HOME: 'relative' }, homeDirectory)).toBe(join(process.cwd(), 'relative'))
    expect(resolveDshHome({ DSH_HOME: '~/relative' }, homeDirectory)).toBe(join(homeDirectory, 'relative'))
    expect(resolveDshHome({ DSH_HOME: '  ' }, homeDirectory)).toBe(join(homeDirectory, '.dsh'))
    expect(resolveDshHome({}, homeDirectory)).toBe(join(homeDirectory, '.dsh'))
  })

  it('derives profile and managed paths and rejects unsafe profiles', () => {
    expect(profileDir('/tmp/.dsh', 'web')).toBe(join('/tmp/.dsh', 'profiles', 'web'))
    expect(managedDir('/tmp/.dsh')).toBe(join('/tmp/.dsh', 'dsh-searxng'))
    for (const profile of ['', '.', '..', 'a/b', 'a\\b']) {
      try { profileDir('/tmp/.dsh', profile); throw new Error('expected rejection') } catch (error) { expect(error).toMatchObject({ code: 'E_PROFILE_INVALID' }) }
    }
  })

  it('rejects exactly the profile names the DSH launcher rejects', () => {
    // Quoted from `resolveProfileDir` in @deepseek-ai/dsh-app-boot 0.2.1-rc.2:
    // a name this CLI accepts but dsh refuses would produce a profile directory
    // the harness can never boot.
    for (const profile of ['node_modules']) {
      expect(() => profileDir('/tmp/.dsh', profile)).toThrow(
        expect.objectContaining({ code: 'E_PROFILE_INVALID' }),
      )
    }
    // Every name dsh accepts still resolves.
    for (const profile of ['web', 'desktop', 'work-2', 'a_b', 'UPPER']) {
      expect(profileDir('/tmp/.dsh', profile)).toBe(join('/tmp/.dsh', 'profiles', profile))
    }
  })

  it('computes a stable, path-derived home id', () => {
    const normalized = normalize(resolve('/tmp/dsh'))
    const expected = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
    expect(homeId(normalized)).toBe(expected)
    expect(homeId('/tmp/dsh/')).toBe(expected)
    expect(homeId('/tmp/other')).not.toBe(expected)
    expect(homeId(normalized)).not.toContain(normalized)
  })

  it('resolves a profile and preflights port separately from dsh', async () => {
    const dshHome = resolve('/tmp/dsh')
    const service = new NodeEnvironmentService({
      env: { DSH_HOME: '/tmp/dsh' }, homedir: '/Users/test',
      portChecker: async (port) => port !== 8080,
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    })
    await expect(service.resolve('web')).resolves.toMatchObject({
      dshHome,
      profileDir: join(dshHome, 'profiles', 'web'),
      managedDir: join(dshHome, 'dsh-searxng'),
    })
    await expect(service.preflightManaged(8080)).rejects.toMatchObject({ code: 'E_PORT_CONFLICT' })
    await expect(service.preflightDsh()).resolves.toBeUndefined()
  })

  it('dsh preflight invokes dsh --version exactly without shell options', async () => {
    const run = vi.fn(async (...args: Parameters<NonNullable<ConstructorParameters<typeof NodeEnvironmentService>[0]['commandRunner']['run']>>) => ({ exitCode: 0, stdout: '', stderr: '' }))
    const service = new NodeEnvironmentService({ portChecker: async () => true, commandRunner: { run } })
    await service.preflightDsh()
    expect(run).toHaveBeenCalledWith('dsh', ['--version'], { signal: undefined })
  })

  it.each([0, 65536, -1, 1.5, Number.NaN])('rejects invalid preflight port %s with stable error', async (port) => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    await expect(new NodeEnvironmentService({ portChecker: async () => true, commandRunner: { run } }).preflightManaged(port)).rejects.toMatchObject({ code: 'E_USAGE', action: 'Choose a valid port' })
    expect(run).not.toHaveBeenCalled()
  })

  it.each([{ exitCode: 127 }, { exitCode: 1 }])('reports missing or nonzero dsh with stable error', async (result) => {
    await expect(new NodeEnvironmentService({ portChecker: async () => true, commandRunner: { run: async () => ({ ...result, stdout: '', stderr: '' }) } }).preflightDsh()).rejects.toMatchObject({ code: 'E_DSH_MISSING', action: DSH_MISSING_ACTION })
  })

  it('maps a thrown ENOENT from dsh --version to the stable missing-dsh error', async () => {
    const missing = Object.assign(new Error('spawn dsh ENOENT'), { code: 'ENOENT' })
    const service = new NodeEnvironmentService({
      portChecker: async () => true,
      commandRunner: { run: async () => { throw missing } },
    })

    await expect(service.preflightDsh()).rejects.toMatchObject({
      code: 'E_DSH_MISSING',
      action: DSH_MISSING_ACTION,
    })
  })

  it('names the Desktop-only installation case and the override in the missing-dsh guidance', () => {
    // The Desktop install ships its CLI inside resources/app.asar and puts no
    // `dsh` on PATH, so bare "install dsh" is not actionable advice there.
    expect(DSH_MISSING_ACTION).toContain('npm install -g @deepseek-ai/dsh@next')
    expect(DSH_MISSING_ACTION).toContain('resources/app.asar')
    // The override is the supported answer for a Desktop-only machine.
    expect(DSH_MISSING_ACTION).toContain(DSH_BIN_ENV)
  })

  it('prefers the @next tag because latest is an unsupported older line', () => {
    // `@deepseek-ai/dsh` publishes `latest` at 0.2.0-rc.2 and the 0.2.1 line
    // under `next`; a bare install would land the operator on a harness this
    // plugin does not support.
    expect(DSH_MISSING_ACTION).not.toMatch(/npm install -g @deepseek-ai\/dsh\)/)
    expect(DSH_MISSING_ACTION).toMatch(/@deepseek-ai\/dsh@next/)
  })

  it('resolves the dsh executable from DSH_SEARXNG_DSH_BIN when set', () => {
    expect(resolveDshCommand({ [DSH_BIN_ENV]: '/opt/dsh/bin/dsh.cmd' })).toBe('/opt/dsh/bin/dsh.cmd')
    // Whitespace padding is trimmed, matching how the CLI reads DSH_HOME.
    expect(resolveDshCommand({ [DSH_BIN_ENV]: '  /opt/dsh  ' })).toBe('/opt/dsh')
  })

  it('falls back to PATH lookup when the override is absent or blank', () => {
    expect(resolveDshCommand({})).toBe('dsh')
    expect(resolveDshCommand({ [DSH_BIN_ENV]: '' })).toBe('dsh')
    expect(resolveDshCommand({ [DSH_BIN_ENV]: '   ' })).toBe('dsh')
  })

  it('invokes the configured executable rather than a hardcoded dsh', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const service = new NodeEnvironmentService({
      env: { [DSH_BIN_ENV]: '/opt/dsh/bin/dsh.cmd' },
      portChecker: async () => true,
      commandRunner: { run },
    })
    await service.preflightDsh()
    expect(run).toHaveBeenCalledWith('/opt/dsh/bin/dsh.cmd', ['--version'], { signal: undefined })
  })

  it('maps a port-checker failure to an actionable stable conflict error without invoking dsh', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const service = new NodeEnvironmentService({
      portChecker: async () => { throw new Error('socket probe failed') },
      commandRunner: { run },
    })

    await expect(service.preflightManaged(8080)).rejects.toMatchObject({
      code: 'E_PORT_CONFLICT',
      action: 'Choose another port or stop the process using it',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('accepts a plain object as an EnvironmentService', async () => {
    const service: EnvironmentService = {
      resolve: async (profile) => ({
        dshHome: '/fake',
        profileDir: `/fake/profiles/${profile}`,
        managedDir: '/fake/dsh-searxng',
        homeId: '0123456789abcdef',
      }),
      preflightManaged: async () => {},
      preflightDsh: async () => {},
    }

    await expect(service.resolve('web')).resolves.toMatchObject({ profileDir: '/fake/profiles/web' })
    await expect(service.preflightManaged(8080)).resolves.toBeUndefined()
    await expect(service.preflightDsh()).resolves.toBeUndefined()
  })

  it('propagates an already-aborted signal unchanged without invoking dependencies', async () => {
    const cancellation = abortError('cancelled before preflight')
    const controller = new AbortController()
    controller.abort(cancellation)
    const portChecker = vi.fn(async () => true)
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const service = new NodeEnvironmentService({ portChecker, commandRunner: { run } })

    await expect(service.preflightManaged(8080, controller.signal)).rejects.toBe(cancellation)
    expect(portChecker).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('propagates cancellation during the port checker unchanged without invoking dsh', async () => {
    const cancellation = abortError('cancelled during port check')
    const controller = new AbortController()
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const service = new NodeEnvironmentService({
      portChecker: async () => {
        controller.abort(cancellation)
        return true
      },
      commandRunner: { run },
    })

    await expect(service.preflightManaged(8080, controller.signal)).rejects.toBe(cancellation)
    expect(run).not.toHaveBeenCalled()
  })

  it('propagates cancellation during dsh --version unchanged', async () => {
    const cancellation = abortError('cancelled during version check')
    const controller = new AbortController()
    const service = new NodeEnvironmentService({
      portChecker: async () => true,
      commandRunner: {
        run: async () => {
          controller.abort(cancellation)
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
    })

    await expect(service.preflightDsh(controller.signal)).rejects.toBe(cancellation)
  })

  it.each(['port checker', 'dsh --version'] as const)(
    'propagates an AbortError thrown by the %s unchanged without an aborted signal',
    async (dependency) => {
      const cancellation = abortError(`cancelled by ${dependency}`)
      const service = new NodeEnvironmentService({
        portChecker: dependency === 'port checker'
          ? async () => { throw cancellation }
          : async () => true,
        commandRunner: {
          run: dependency === 'dsh --version'
            ? async () => { throw cancellation }
            : async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        },
      })

      const operation = dependency === 'port checker'
        ? service.preflightManaged(8080)
        : service.preflightDsh()
      await expect(operation).rejects.toBe(cancellation)
    },
  )
})
