# Public source export and publication

This document describes application release packaging. It never publishes a paper,
private registry, translation model, login file or the development repository history.

Run from the application root:

```sh
python3 -m unittest discover -s tests -p test_public_export.py -v
python3 scripts/export-public.py --json
```

The exporter copies only the explicit `REQUIRED` / `OPTIONAL` source lists in
`scripts/export-public.py`. The public `README.md` comes from
`docs/public-readme.md`. New files require a deliberate allowlist change. Production
service units and manuscript-specific browser regression scripts are excluded.
`public-export-manifest.json` records each exported file's SHA-256, without a
timestamp, private path or development commit history.

The default destination is `_tmp/public-release`. `--source PATH` selects another
source root; `--output PATH` must remain within that source's `_tmp` directory.
`--json` emits `{schema_version,output,file_count,manifest}` on stdout. Errors go to
stderr with empty stdout. Exit codes: 0 success, 1 refused or failed export,
2 invalid command-line arguments. There is no interactive prompt or network access.

All approved sources are validated before writing. Secret-like tokens, private
keys, binary files, source/output symlinks and unmanaged destination files cause
refusal. This scan is a release check, not a guarantee that arbitrary confidential
prose can be detected. Review the complete export before publication. The exporter
does not rewrite source strings or change application behavior.

Repeating an export yields the same file bytes for the same input. A public
checkout's `.git` metadata is preserved without reading or replacing it. Existing
unmanaged files must be inspected manually; they are never deleted automatically.
The public source tree includes this exporter and its public README source, so it
can also produce a fresh export after downstream modifications.

Only after review, initialize a **new** Git repository in the generated directory
and create a public GitHub repository. Commit the exported application sources,
not the private repository's `.git` directory. Review `git status`, the manifest,
license, lock file and secret scan before pushing. Use ordinary pushes; never
force-push the development repository into the public release.

## License and redistribution audit

- Application overlay and newly authored code: MIT, see root `LICENSE`.
- [Paper Pal](https://github.com/claire1217/paper-pal): MIT, copyright 2026
  claire1217. Attribution remains in `LICENSE`. Its source is installed separately
  at the exact commit recorded in `sources.lock.json`; the overlay does not include
  the upstream checkout, npm dependencies or their bundled artifacts.
- [Argos Translate](https://github.com/argosopentech/argos-translate): MIT. The
  optional installer fetches the version locked in `sources.lock.json`. The
  English–Chinese OPUS-MT-derived model is recorded as CC BY 4.0 and attributed to
  Jörg Tiedemann and Santhosh Thottingal (2020); downloaded packages and models are
  not redistributed in this source export. Preserve their own license notices if
  you redistribute those artifacts separately.
- `aiohttp`: Apache 2.0 with MIT-licensed llhttp components, installed separately.
  PyMuPDF: AGPL/commercial dual
  licensing, installed separately for PDF previews. Review PyMuPDF's applicable
  terms for your deployment or use a commercially licensed distribution. The
  source overlay's MIT license does not relicense third-party dependencies.
- Pillow: MIT-CMU/PIL licensing depending on the release, installed separately for image validation.
  Its installed distribution retains third-party codec notices.
- Codex and Claude official CLIs, user subscriptions, manuscript assets and generated
  images are not included and remain subject to their respective terms and rights.

No private paper, experimental dataset, model weights, browser state, credentials,
AI conversation or archived manuscript version is part of this public application
release. Author-approved paper exports are a separate action.
