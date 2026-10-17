# Certification records (historical)

These JSON files are **verbatim evidence of real certification runs** on named platforms. They are
not edited after the fact: a record describes the run that produced it, and rewriting one would
destroy the evidence it exists to hold.

Read them with the release they cover in mind:

| File | Release | Harness line | Status |
|---|---|---|---|
| `v0.4.0-darwin-arm64.json` | 0.4.0 | `@deepseek-ai/dsh-web >=0.1.0-rc.6 <0.2.0` | historical |
| `v0.3.0-darwin-arm64.json` | 0.3.0 | `@deepseek-ai/dsh-web >=0.1.0-rc.6 <0.2.0` | historical |

Both were produced against the previous DeepSeek Harness line. `0.5.0` targets `0.2.1-rc.2` and
changed behaviour these runs did not exercise — `setup` now requires an explicit `--url` or
`--managed`, the CLI refuses to write a config row whose bundle layer does not insert it, and the
install spec is pinned to the running package version.

**A record here certifies exactly the tarball whose SHA-256 it names. It says nothing about `0.5.0`,
which has no record and is therefore uncertified.** See
[../release-certification.md](../release-certification.md) for the required environments, the
acceptance rules, and the evidence log.
