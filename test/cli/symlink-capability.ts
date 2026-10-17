/**
 * Symlink capability probe.
 *
 * Several security tests prove this codebase refuses to follow a symbolic link.
 * Constructing their fixtures needs the *test process* to create one, which is a
 * host privilege rather than a property of the code under test:
 *
 * - Windows requires `SeCreateSymbolicLinkPrivilege`, granted either by an
 *   elevated (Administrator) process or by Developer Mode. With neither, every
 *   symlink call fails with `EPERM` no matter what arguments are passed.
 * - Linux/macOS normally allow it unprivileged, but a hardened container or a
 *   restrictive mount can also refuse.
 *
 * Gating on `process.platform === 'win32'` would be wrong in both directions: it
 * would skip on a Windows developer machine that *does* have Developer Mode
 * (silently dropping real coverage) and it would still fail on a hardened Linux
 * host. So the gate is a measured capability, never a platform guess.
 *
 * The probe runs synchronously once per test module, which keeps
 * `it.skipIf(!canCreateSymlink)` available at collection time.
 *
 * @module test/cli/symlink-capability
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Error codes that mean "this host will not let this process create a symlink".
 *
 * `EPERM`/`EACCES` are the Windows privilege refusals; `EINVAL` is the
 * filesystem saying it does not support links; `ENOSYS`/`ENOTSUP` are platforms
 * without the call; `UNKNOWN` is what Windows surfaces for some
 * privilege-shaped failures on older Node releases.
 */
const UNSUPPORTED_CODES = new Set(['EPERM', 'EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'UNKNOWN'])

interface ProbeResult {
  ok: boolean
  /** The `code` of the error that refused the link, when one did. */
  code?: string
  /** One-line explanation naming the real cause. */
  detail?: string
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Attempt both a file symlink and a directory symlink in a throwaway directory.
 *
 * Both are probed because the tests need both, and Windows can in principle
 * refuse one while allowing the other. Requiring both means the gate matches
 * what the fixtures actually do.
 */
function probeSymlink(): ProbeResult {
  let directory: string | undefined
  try {
    directory = mkdtempSync(join(tmpdir(), 'dsh-symlink-probe-'))
    const file = join(directory, 'file')
    writeFileSync(file, '')
    const innerDirectory = join(directory, 'dir')
    mkdirSync(innerDirectory)
    symlinkSync(file, join(directory, 'file-link'))
    symlinkSync(innerDirectory, join(directory, 'dir-link'), 'dir')
    return { ok: true }
  } catch (error) {
    // A privilege refusal is not a product defect: it is a host limitation, and
    // the honest response is to skip with the reason stated.
    return { ok: false, ...(errorCode(error) === undefined ? {} : { code: errorCode(error) }) }
  } finally {
    if (directory !== undefined) {
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {
        // A leftover probe directory must never fail the suite.
      }
    }
  }
}

const probe = probeSymlink()

/**
 * The reason a platform-limited run reports for these tests. Kept as one
 * constant so the four call sites and the docs cannot drift apart.
 *
 * It deliberately does not say "Windows": the gate is a capability, and naming a
 * platform would be a claim the probe does not make.
 */
export const SYMLINK_SKIP_REASON =
  'host cannot create symbolic links (Windows needs Developer Mode or an elevated process)'

/** Whether this process can create both file and directory symlinks. */
export const canCreateSymlink: boolean = probe.ok

/**
 * Build the reported title for a symlink-gated test.
 *
 * Vitest's `skipIf` carries no message parameter, so the reason travels in the
 * test name. On a capable host the title is unchanged; on a restricted host the
 * skipped entry names the cause instead of leaving a bare `skipped` that reads
 * like a product failure.
 * @param title - the test's normal title.
 * @returns the title to report.
 */
export function symlinkTestTitle(title: string): string {
  if (canCreateSymlink) return title
  const observed = probe.code === undefined ? '' : ` [${probe.code}]`
  return `${title} — ${SYMLINK_SKIP_REASON}${observed}`
}

/**
 * The gate itself, so every call site reads the same way:
 * `it.skipIf(!canCreateSymlink)(symlinkTestTitle('...'), fn)`.
 */
export const symlinkUnsupported: boolean = !canCreateSymlink
