# Paper Pal Hub

A mobile-friendly, Chinese-first review workspace for multiple LaTeX papers, built
as a hash-locked overlay for [Paper Pal](https://github.com/claire1217/paper-pal).
Keep English manuscript sources, read Chinese or bilingual views, discuss edits
with Codex or Claude, and approve candidates before they replace manuscript assets.

## Features

- Card-based paper library; separate chats, annotations, project instructions and
  draft state per paper. Mobile drawers can be opened and closed without sending.
- Explicit Send for AI chat, with provider/model selection and saved draft context.
  The installed official CLI supplies the current subscription login.
- English, Chinese and bilingual reading. Optional CPU-only Argos translation
  starts on demand, caches unchanged paragraphs and exits after the task.
- Numbered paper archives, metadata and handoff manifests; compare working content
  with a saved version, or compare two saved versions. Previous figures remain
  available alongside replacements. Archives are application snapshots, not Git tags.
- Figure inventory with script/design inputs, data paths and generation metadata;
  staged image candidates require explicit acceptance. Import externally generated
  images through the documented local helper when no image tool is available.

The interface contracts for versions, figures and candidates are in
[docs/api-contract.md](docs/api-contract.md). Some figures are not fully reproducible:
missing source data or design files are reported explicitly. A configured text
model does not automatically provide image generation tools.

## Requirements and installation

Use Linux, Python **3.10+**, Node **22+**, an official Codex and/or Claude CLI, and
the exact upstream Paper Pal checkout below. Automatic per-paper service setup
uses user systemd. A working LaTeX toolchain is needed only for compiling PDFs.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
mkdir -p "$HOME/.local/share"
git clone https://github.com/claire1217/paper-pal.git "$HOME/.local/share/paper-pal"
git -C "$HOME/.local/share/paper-pal" checkout 5103b3acfb05307ab72c8c9255a986011f0df462
npm --prefix "$HOME/.local/share/paper-pal" install
sh install.sh
```

Add `$HOME/bin` to your PATH to use `paper-hub`. The launcher uses the system
`python3`; if dependencies are only in `.venv`, invoke `.venv/bin/python cli.py`
instead. The application does not patch installed upstream files: the gateway and
Node load hook verify `sources.lock.json` hashes before adapting reviewed assets
and backend seams. A different upstream revision must be reviewed and relocked;
changing hashes alone is insufficient.

Set `PAPER_PAL_DIR` when the upstream checkout is elsewhere; its default is
`$HOME/.local/share/paper-pal`. The override changes its location, while module
SHA-256 locks still require the same reviewed upstream commit. The Python gateway
also accepts `--upstream-dir PATH` for its static-asset checkout.

Sign in through each official CLI's own authentication workflow. For a paper whose
entry point is `paper/main.tex` and PDF is `build/main.pdf`:

```sh
.venv/bin/python cli.py add /absolute/path/to/paper --id my-paper --title "My paper" \
  --main paper/main.tex --source-root paper --pdf build/main.pdf --provider codex \
  --base-url http://127.0.0.1:4318 --json
.venv/bin/python cli.py status --json
```

Choose a model already verified for your account with `--model`. Existing project
configuration is preserved; repeated registration of the same ID and directory is
idempotent. CLI errors use stderr; JSON stdout stays parseable. Exit codes are
0 success, 1 runtime/configuration failure, 2 command-line usage error.
Pass your actual `--base-url` when deploying elsewhere, or set `PAPER_HUB_BASE_URL`;
the default retains the original deployment address for compatibility.

The private registry lives at `~/.config/paper-pal/hub.json`. Create a private JSON
auth file with `username` and `password` keys outside the checkout, restrict it to
mode 0600, then start the gateway with its allowed host:

```sh
.venv/bin/python hub.py --registry "$HOME/.config/paper-pal/hub.json" \
  --auth-file "$HOME/.config/paper-pal/auth.json" --host 127.0.0.1:4318 --port 4318 --local
```

Open `http://127.0.0.1:4318/login`. `--local` is for loopback development. For public
access, use HTTPS at your own configured host and remove `--local`; route your
reverse proxy to the gateway's loopback port. Keep per-paper backends private.
Deployment units must point to this checkout and its Python environment. No
production account credentials, tunnel configuration or paper is shipped. Set your
own base URL instead of relying on legacy deployment defaults.

Registration invokes the pinned checkout's `bin/paper-pal.mjs` with Node; a global
`paper-pal` executable at a fixed npm path is not required. New user services keep
the resolved Node executable, upstream directory, PATH, and explicit CODEX_BIN /
CLAUDE_BIN overrides. Repeated registration preserves existing service units;
update an older unit's environment explicitly when moving a CLI or checkout.

Optional English–Chinese CPU translation uses `uv` and a separate environment:

```sh
bash scripts/install-translation.sh
```

This installs Argos Translate and verifies the model hash from the lock file.
It downloads a model separately; no model is bundled. AI translation is a separate
subscription-backed option and requires its configured model to be available.
Set `translation.aiModel` in a paper's `.paper-pal.json`, or set
`PAPER_HUB_TRANSLATION_MODEL` in the gateway environment, to select an available
Codex translation model. The project setting wins; the compatibility default is
`gpt-5.6-luna`. Each job freezes its model, which is included in its cache key.
Changing a model does not silently reuse another model's translations. Ordinary
CPU translation and its caches remain independent of this setting.

## Model adapters and skills

`subscription-cli.mjs` is the execution boundary for existing official Codex and
Claude clients. It verifies subscription authentication at each request and filters
unrelated API credentials from child environments. `backend-loader.mjs` adapts the
locked upstream provider interface; figure jobs use `figure-task.mjs`. Provider
IDs and model names are configuration allowlists, not claims of universal access.
There is no silent fallback to an API key. Extending providers requires updating
and testing both the allowed interface and the execution adapter.

Website login controls access to this workspace. It is **separate from** the
server's CLI subscription login. Papers running as the same operating-system user
share that user's current provider login; signing into a different website account
does not select a different AI subscription. This is intended for a trusted author
workspace, not a multi-tenant subscription reseller.

Each paper's real project directory supplies `AGENTS.md` and
`.agents/skills/paper-ai/SKILL.md`. Registration installs a starter project skill only
if absent; maintain the paper's current narrative, evidence and figure rules there.
The same user-level global skills remain available through the respective CLI's
normal discovery. Linked project Claude skills reuse `.agents/skills` where
possible. Skills are read as needed, not all injected into every prompt. Editing
rules/skills takes effect on subsequent requests; model configuration changes need
a backend restart. A shared user environment is not an operating-system sandbox.

The paper's own AI worker reads applicable global plotting, image-generation and
web-consultation skills, and uses their tools itself. A separate controller does
not operate ChatGPT on its behalf, and no additional image API is configured.
When the official Codex CLI exposes native image generation, figure jobs enable
that capability and record observed tool calls. Tool availability does not pin a
particular image model; an unreported image model stays unknown in the receipt.

Staged figure workers keep browser IPC and Playwright cache in a private temporary directory for each job. They retain the global consultation skill's shared write lock and
user-service environment; browser profile and credential storage are not granted
write access. A tool failure returns its explicit failure receipt instead of
being hidden behind a missing-image error. Browser consultation follows the
skill's login, conversation identity and send guards.

The paper AI panel uses a text draft. Closing the panel or reloading preserves
unsent text; only the explicit Send action submits it. The application does not
provide a microphone/voice-recognition control.

Select **请 ChatGPT 网页咨询** beside the composer, then click Send to explicitly
enable browser consultation for that message. The selected Codex/Claude worker
reads the current global consultation skill and operates its approved browser
itself. Unchecked messages retain the ordinary read-only tools. Consultation
helpers run in a private scratch directory; manuscript changes still require
review and acceptance. Codex writes are restricted to scratch/tool runtime;
Claude's Bash workflow relies on instructions and is not an OS sandbox.
Minimal result receipts are kept in the paper's private `.paper-pal/consultations/`;
scratch directories are cleaned after the run. A missing login, unrelated draft,
wrong conversation identity or failed guard is reported as blocked, not a reply.
The checkbox does not authorize clearing an existing browser draft. Only threads
that have been reopened and identity-checked are offered for automatic reuse.
Success receipts must confirm a completed response, original-tab preservation
and zero unexpected sends. Receipt links remain valid after scratch cleanup.

## Versions, images and handoff

The first baseline is `0.0`; subsequent explicit archives increment to `1.0`, `2.0`
and so on. Archive metadata records timestamps, parent version, user name/note and
the actual snapshot/manifest paths. Start a revision from a saved baseline, review
diffs, then archive an approved state. A saved version remains available for later
comparison even after newer saves. Downloadable snapshots and `HANDOFF.md` give
other AI tools a concrete set of files and provenance to inspect.

Figure metadata can point to local drawing scripts, source data, editable design
files, reference images and generation instructions. Keep these paths inside the
project. Version snapshots retain registered lineage files within their documented
size limits. Regeneration works only when inputs, dependencies and tools exist;
image-generation subscriptions are not assumed to expose an image API. AI-produced
assets can be imported as candidates through the local interface and reviewed
before acceptance. Accepted image changes are archived with provenance.

Subsequent figure jobs inherit accepted helper scripts and processed data as well
as the originally registered filenames, excluding runtime logs and candidate
outputs. Current project guidance, manuscript text and project skills are supplied
afresh; referenced context outside the staged copy may be read from the original
project in read-only mode. Global rules and skills remain live reads. Concurrent
input changes during copying cause rejection rather than a mixed candidate.

Saving drafts, approving candidates, and creating a numbered archive are distinct
actions. Compare views are read-only. Translation never overwrites the English
LaTeX source. Back up each paper directory and its private `.paper-pal` state using
your own storage policy; publishing this application does not publish your papers.

Other AI tools can use the same local interfaces without driving a browser:

```sh
paper-hub versions list /absolute/path/to/paper --json
paper-hub versions save /absolute/path/to/paper --name "Reviewed draft" --note "Updated figures" --json
paper-hub versions compare /absolute/path/to/paper --base v0.0 --target working --json
paper-hub figures list /absolute/path/to/paper --json
paper-hub figures import /absolute/path/to/paper --figure fig1 \
  --image /absolute/path/to/candidate.png --provider local-import --model gpt-image-2 --json
```

`--model` on import records the actual tool that produced the image; it does not
invoke that model. Use its real identifier rather than copying the example blindly.
The imported result is a review candidate; acceptance remains an explicit action.
Use `--target v1.0` to compare two archives. `save` returns the new snapshot and
manifest paths; `--request-id` supports repeat-safe save/import automation.

## Development and licensing

```sh
.venv/bin/python -m unittest discover -s tests -v
node --test tests/backend_contract.test.mjs tests/subscription_contract.test.mjs tests/figure_task_contract.test.mjs tests/runtime_paths.test.mjs tests/consultation_contract.test.mjs
```

Gateway/backend tests require the pinned upstream checkout. Browser fixture scripts
use isolated test papers; they must not accept candidates or send model requests in
real manuscripts. Keep credentials, runtime state, archives and test artifacts out
of Git. See [publication.md](docs/publication.md) for the explicit allowlist export
and license audit. The public tree starts with fresh history; private development
reports and manuscript-specific scripts are intentionally excluded.

MIT; see [LICENSE](LICENSE). Upstream Paper Pal copyright 2026 claire1217 is
retained. Dependencies and optional translation models retain their own licenses;
PyMuPDF uses AGPL/commercial terms, and the separately downloaded OPUS-MT-derived
translation model requires CC BY 4.0 attribution. No manuscript, dataset, login,
AI conversation or model weight is distributed here.
