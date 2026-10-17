import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../../src/cli/args.ts'

describe('parseCliArgs', () => {
  it.each([['--help'], ['-h']])('parses %s without requiring a command', (flag) => {
    expect(parseCliArgs([flag])).toEqual({ command: 'help' })
  })

  it('rejects help combined with mutations', () => {
    expect(() => parseCliArgs(['setup', '--help'])).toThrow(/cannot be combined/i)
  })
  it('requires an explicit deployment mode instead of defaulting to provisioning', () => {
    // The user directive behind this rule: setup must never deploy SearXNG by
    // itself unless asked. Both the omission and the ambiguity are refused
    // before any profile or Docker work can happen.
    expect(() => parseCliArgs(['setup'])).toThrow(/--url <endpoint>|--managed/i)
    expect(() => parseCliArgs(['setup', '--profile', 'work'])).toThrow(/--url <endpoint>|--managed/i)
    expect(() => parseCliArgs(['setup', '--url', 'https://search.example', '--managed']))
      .toThrow(/different modes/i)
  })

  it('gives each mode argument failure its own actionable code', () => {
    // A generic E_USAGE would bury the one decision the operator must make.
    expect(() => parseCliArgs(['setup'])).toThrow(
      expect.objectContaining({ code: 'E_MODE_REQUIRED' }),
    )
    expect(() => parseCliArgs(['setup', '--managed', '--url', 'https://search.example'])).toThrow(
      expect.objectContaining({ code: 'E_MODE_MISMATCH' }),
    )
    // Every other argument failure stays a plain usage error.
    expect(() => parseCliArgs(['setup', '--managed', '--port', '0'])).toThrow(
      expect.objectContaining({ code: 'E_USAGE' }),
    )
    expect(() => parseCliArgs(['status', '--managed'])).toThrow(
      expect.objectContaining({ code: 'E_USAGE' }),
    )
  })

  it('defaults the profile and port, and records the external mode for --url', () => {
    expect(parseCliArgs(['setup', '--url', 'https://search.example'])).toEqual({
      command: 'setup',
      profile: 'web',
      mode: 'external',
      url: 'https://search.example',
      port: 8080,
      portExplicit: false,
      json: false,
    })
  })

  it('records the managed mode for --managed without an endpoint', () => {
    expect(parseCliArgs(['setup', '--managed'])).toEqual({
      command: 'setup',
      profile: 'web',
      mode: 'managed',
      port: 8080,
      portExplicit: false,
      json: false,
    })
  })

  it('parses setup profile, URL, port, and JSON output', () => {
    expect(parseCliArgs(['setup', '--profile', 'work', '--url', 'https://search.example', '--port', '9090', '--json'])).toEqual({
      command: 'setup',
      profile: 'work',
      mode: 'external',
      url: 'https://search.example',
      port: 9090,
      portExplicit: true,
      json: true,
    })
  })

  it('accepts an absolute HTTP(S) URL with a subpath', () => {
    expect(parseCliArgs(['setup', '--url', 'https://search.example/searxng'])).toMatchObject({
      command: 'setup',
      mode: 'external',
      url: 'https://search.example/searxng',
    })
  })

  it.each([1, 65535])('accepts setup port boundary %s', (port) => {
    expect(parseCliArgs(['setup', '--managed', '--port', String(port)]))
      .toMatchObject({ command: 'setup', mode: 'managed', port, portExplicit: true })
  })

  it.each(['status', 'doctor', 'tune'])('parses %s with defaults', (command) => {
    expect(parseCliArgs([command])).toEqual({ command, profile: 'web', json: false })
  })

  it('parses repair with defaults', () => {
    expect(parseCliArgs(['repair'])).toEqual({ command: 'repair', profile: 'web', json: false })
  })

  it('parses repair profile and JSON output', () => {
    expect(parseCliArgs(['repair', '--profile', 'work', '--json'])).toEqual({
      command: 'repair',
      profile: 'work',
      json: true,
    })
  })

  it('parses remove flags', () => {
    expect(parseCliArgs(['remove', '--service', '--purge-data', '--yes', '--json'])).toEqual({
      command: 'remove',
      profile: 'web',
      json: true,
      service: true,
      purgeData: true,
      yes: true,
    })
  })

  it('parses update with defaults', () => {
    expect(parseCliArgs(['update'])).toEqual({ command: 'update', profile: 'web', json: false })
  })

  it('parses update profile, deployment version, and JSON output', () => {
    expect(parseCliArgs(['update', '--profile', 'work', '--deployment-version', '2', '--json'])).toEqual({
      command: 'update',
      profile: 'work',
      deploymentVersion: 2,
      json: true,
    })
  })

  it('keeps remove defaults explicit', () => {
    expect(parseCliArgs(['remove'])).toEqual({
      command: 'remove',
      profile: 'web',
      json: false,
      service: false,
      purgeData: false,
      yes: false,
    })
  })

  it.each([
    ['unknown command', ['wat']],
    ['empty profile', ['setup', '--profile', '']],
    ['slash profile', ['setup', '--profile', 'a/b']],
    ['backslash profile', ['setup', '--profile', 'a\\b']],
    ['dot-segment profile', ['setup', '--profile', 'a/../b']],
    ['dot profile', ['setup', '--profile', '.']],
    ['dot-dot profile', ['setup', '--profile', '..']],
    ['port below range', ['setup', '--port', '0']],
    ['port above range', ['setup', '--port', '65536']],
    ['noninteger port', ['setup', '--port', '8080.5']],
    ['URL without scheme', ['setup', '--url', 'search.example']],
    ['non-http URL', ['setup', '--url', 'ftp://search.example']],
    ['URL with query', ['setup', '--url', 'https://search.example/?q=1']],
    ['URL with fragment', ['setup', '--url', 'https://search.example/#top']],
    ['URL with username', ['setup', '--url', 'https://user@search.example']],
    ['URL with password', ['setup', '--url', 'https://:secret@search.example']],
    ['remove yes without purge-data', ['remove', '--yes']],
    ['status port', ['status', '--port', '8081']],
    ['doctor port', ['doctor', '--port', '8081']],
    ['remove port', ['remove', '--port', '8081']],
    ['status URL', ['status', '--url', 'https://search.example']],
    ['doctor URL', ['doctor', '--url', 'https://search.example']],
    ['remove URL', ['remove', '--url', 'https://search.example']],
    ['setup service', ['setup', '--service']],
    ['setup purge-data', ['setup', '--purge-data']],
    ['setup yes', ['setup', '--yes']],
    ['status service', ['status', '--service']],
    ['doctor service', ['doctor', '--service']],
    ['status purge-data', ['status', '--purge-data']],
    ['doctor purge-data', ['doctor', '--purge-data']],
    ['status yes', ['status', '--yes']],
    ['doctor yes', ['doctor', '--yes']],
    ['repair port', ['repair', '--port', '8081']],
    ['repair URL', ['repair', '--url', 'https://search.example']],
    ['repair service', ['repair', '--service']],
    ['repair purge-data', ['repair', '--purge-data']],
    ['repair yes', ['repair', '--yes']],
    ['purge without service', ['remove', '--purge-data']],
    ['zero deployment version', ['update', '--deployment-version', '0']],
    ['noninteger deployment version', ['update', '--deployment-version', '2.5']],
    ['deployment version above range', ['update', '--deployment-version', '65536']],
    ['setup deployment version', ['setup', '--deployment-version', '2']],
    ['status deployment version', ['status', '--deployment-version', '2']],
    ['doctor deployment version', ['doctor', '--deployment-version', '2']],
    ['repair deployment version', ['repair', '--deployment-version', '2']],
    ['remove deployment version', ['remove', '--deployment-version', '2']],
    ['update port', ['update', '--port', '8081']],
    ['update url', ['update', '--url', 'https://search.example']],
    ['update service', ['update', '--service']],
    // The DSH launcher rejects `node_modules` as a profile name; accepting it
    // here would create a directory under profiles/ that shadows dependency
    // resolution and that `dsh --profile node_modules` refuses to boot.
    ['setup node_modules profile', ['setup', '--profile', 'node_modules']],
    ['status node_modules profile', ['status', '--profile', 'node_modules']],
    ['doctor parent profile', ['doctor', '--profile', '..']],
  ] as const)('rejects %s', (_name, argv) => {
    expect(() => parseCliArgs(argv)).toThrow()
  })
})
