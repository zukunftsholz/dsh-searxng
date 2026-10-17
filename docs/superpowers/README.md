# Historical plans and specifications

Everything under `plans/` and `specs/` is a **dated record of work as it was planned and reviewed
at that time**. Files are not rewritten when the product moves on, so commands, version numbers,
file paths, and line references inside them describe the tree as it was on their date — not the
current release.

For current, authoritative documentation read:

- [README.md](../../README.md) — install, commands, configuration, error codes, support matrix.
- [docs/release-certification.md](../release-certification.md) — certification evidence log.
- [docs/development-plan.md](../development-plan.md) — forward-looking plan and milestone status.

`docs/development-plan.md` describes the milestone plan those documents belong to; its *Current
state* table is kept current, while the dated plan and spec files are not.

Two consequences worth knowing when reading an old file here:

- Before `0.5.0`, `npx dsh-searxng setup` provisioned a Docker deployment by default. Since
  `0.5.0` it requires an explicit `--url <endpoint>` or `--managed`; a bare `setup` is refused with
  `E_MODE_REQUIRED`. Plans and specs written before that change still show the bare form.
- Before `0.5.0`, the plugin targeted DeepSeek Harness `0.1.x`
  (`@deepseek-ai/dsh-web >=0.1.0-rc.6 <0.2.0`). `0.5.0` targets `0.2.1-rc.2`
  (`>=0.2.1-rc.2 <0.3.0`) and no longer supports the `0.1.x` line.
