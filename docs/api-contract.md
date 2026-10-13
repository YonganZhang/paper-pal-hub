# Paper workspace extension contract (schema 1)

All endpoints below are relative to `/papers/<slug>/hub`, authenticated and same-origin, with X-Paper-Pal:1 for non-browser clients. Errors are JSON {error:message}, status400/404/409/503. No manuscripts or accepted figures are changed by archive or compare. Feature assets must be deployed together with the gateway.

## Versions

GET /versions -> {schema_version:1,versions:[...chronological],latest_id:string|null}. Each version: {id:"v0.0",version:"0.0",name,note,created_at,parent_id,snapshot_path,manifest_path,file_count,figure_count,pdf_available}. First baseline0.0, subsequent1.0,2.0. POST /versions {name,note,expected_parent:id|null,request_id:uuid} -> {schema_version:1,created:boolean,version:...}. A stale expected_parent is409, same request_id is idempotent. Snapshot path contains files preserving project-relative names, manifest.json and HANDOFF.md. No delete/restore API this release.

GET /versions/compare?base=v0.0&target=working&path=paper/main.tex (or target=v1.0) -> {schema_version:1,base,target,files:[{path,status:"added"|"modified"|"deleted"|"equal",kind:"text"|"image"|"binary",before:{url,preview_url,sha256,size}|null,after:...|null,diff:[{type:"equal"|"delete"|"insert",text}],latest_text:string|null}],figures:[{id,title,status,before:{url,preview_url,sha256,path}|null,after:...|null}],summary:{added,modified,deleted,figures_changed}}. Only the selected path includes full diff/latest_text; other file records retain metadata. Omitted path defaults to the configured main document. File route GET /versions/<id>/file?path=...&preview=1 optionally renders PDF preview, known manifest files only. Working route uses id=working and known inventory only. GET /versions/<id>/download -> ZIP Content-Disposition attachment. UI comparison is read-only; latest text/diff toggles never feed source-save. window.paperHubFlush(): await actual upstream pending document save, flushes the existing upstream save operation. Document event paper-hub:document has detail.path. UI uses own topbar button + fullscreen mobile dialog, no changes to mobile.js. Current selection comes from #document-select.

## Figures

Project .paper-pal.json may point figures.manifest to a project-contained JSON path, default .paper-figures.json. JSON {schema_version:1,figures:[{id,title,path,source_paths:[...relative script/design files],data_paths:[...relative inputs],command:[...argv],kind:"plot"|"diagram"|"generated",prompt?,model?,reference_paths?:[],notes?}]}. All path fields remain within project including resolved symlinks. No shell command strings; command is metadata until explicitly requested through AI job. Figure paths are actual LaTeX assets; registered figures can render inline by file caption/path. Registry never claims completeness automatically.

GET /figures -> {schema_version:1,figures:[...metadata + {asset_url,preview_url,missing_paths:[],reproducible:boolean}],manifest_path}. Backend module exports figure_records(repo:Path, config:dict)->list[dict], including validated metadata but no URLs; snapshotter imports it. Missing data makes reproducible=false, never fake a full lineage. Runtime exceptions meaningful, no subprocess at import.

POST /figures/jobs {figure_id,instruction,provider:"codex"|"claude",model?,request_id} ->202 {id,status,...}; GET /figures/jobs/<id> -> {id,status:"queued"|"running"|"proposed"|"accepted"|"error",figure_id,provider,model,instruction,created_at,error?,candidate_url?,candidate_preview_url?,workspace_path,manifest_path,summary?}. Explicit click only. Run a new one-shot subscription CLI process in private staged workspace, not a new agent runtime. Copy registered scripts/data/assets preserving relative paths. Discuss/read globals/project skill as applicable; generate candidate asset in workspace only. Codex workspace-write, same current login via subscription-cli; Claude tool policy must be explicit and no claim of OS isolation. Worker's deliverable actual nonempty validated PNG/JPEG/SVG/PDF, no fake ready state. Keep original image until approval. POST /figures/jobs/<id>/accept {expected_sha256} -> {status:"accepted",...}; verify live original hash, archive original+candidate+job provenance, atomic replace target only, stale original409, already accepted idempotent. The corresponding paper AI reads current global plotting/imagegen/share-web-consultation skills and executes applicable tools itself. Codex native image availability is detected from the official CLI. Actual observed calls are recorded; image model identity remains unknown when unreported, never substituted with a claimed fixed Image2. No separate image API is configured. Support import candidate from an existing local AI-produced asset via Python public method/CLI helper (not arbitrary public file reads). job artifacts served by GET /figures/jobs/<id>/asset?preview=1. No shell or file path is exposed as an executable website endpoint. Limit active jobs, timeout/cancel/shutdown lifecycle; no permanent GPU workers. Figure service class FigureStudio(registry_reader,root) .install(app) under existing security middleware, .cleanup(app), original changes only accept endpoint. Tests use isolated repo and fake CLI, never real manuscript/real models.

## Submission and worker settings

Submission request IDs identify the complete frozen payload. Retrying an unknown
result with the same payload reuses its ID; changing its name/note/parent or
figure/instruction/provider/model uses a different ID. Concurrent parent changes
still require a refreshed archive list. Delayed acknowledgments preserve newer
form input. A figure job supplies `original_project_root` and `context_paths`;
current guidance and skills are copied afresh, while accepted recipe helpers and
processed data retain their source paths. Only staged output may be edited.

AI translation uses project `translation.aiModel`, then gateway environment
`PAPER_HUB_TRANSLATION_MODEL`, then the compatibility default `gpt-5.6-luna`.
The requested model is frozen per job and included in both chapter and paragraph
cache identities. Translation and figure jobs finish process-group cleanup before
publishing a terminal status or releasing their active-worker slot.

## Public release

Export allowlisted app modules, web assets, tests and templates to a clean generated repo under _tmp/public-release; omit _reports, project papers, runtime, credentials, user history and app's private git history. Public source license MIT (upstream attribution retained). Never publish existing repo history. Public README explains dependencies/source pin/install/configuration, no scientific paper data or proprietary content. Runtime source resolution uses PAPER_PAL_DIR or the current HOME. Publish the clean export only after reviewing its exact file manifest.


## Optional chat browser consultation

The existing authenticated POST `/api/chat/message` accepts `webConsultation:true`
as a strict boolean for that user message. Omission, false or a string keeps the
ordinary read-only chat policy. The frontend stages this choice in the per-session
unsent draft; toggling it never sends. Only explicit Send posts the frozen choice.

An enabled message uses the selected official subscription CLI and existing
login, with no API-key fallback. The corresponding worker reads current global
and project skills itself. Codex uses a private workspace-write scratch and narrow
browser runtime roots; Claude enables Bash and depends on the explicit tool policy,
without claiming OS isolation. Original project files are read-only by policy.
An existing browser draft is a stop condition; the checkbox does not authorize
clearing or staging it. Original browser tabs are preserved.

The host waits for worker exit before removing scratch, including timeout and
shutdown paths. Minimal receipts are archived privately at
`.paper-pal/consultations/<run>/receipt.json`; temporary receipt links in the answer
are rewritten to that durable location. Missing/invalid completion yields an
explicit unfinished prefix. A success requires a valid ChatGPT conversation URL,
workspace label, observed user message and completed assistant reply, original-tab
preservation, positive send count and zero unexpected sends. These are worker
observations, not a provider-signed audit. No drafts, cookies or conversation
transcripts are archived in these receipts. Previous threads are suggested only
when a successful reopen/identity check was recorded (`thread_reusable:true`);
the worker must verify identity again before using them.

When a worker creates a Page through run-code, it binds the global send guard
to that same Page using an in-memory target token. The CLI current tab must not
be assumed to follow a newly created Page. Missing or duplicate targets fail closed.


## Translation revision and reading cache

GET `/papers/<slug>/hub/translation-config` returns `{default_engine:"ai",
revisions:{ai:<hash>,offline:<hash>}}` with no-store. An existing translate POST may
include `revision`; a stale value returns409 before starting a worker. The job
freezes provider/model and publishes `revision`, along with checked paragraph
progress. `translation.aiProvider` accepts only Codex/Claude subscriptions;
`translation.aiModel` and gateway equivalents configure the model. Defaults are
Codex/gpt-5.6-luna or, when Claude is selected, haiku. No API provider fallback.

At most four unfinished jobs and two active workers. Numeric validation accepts
English small cardinal/ordinal words rendered as numerals and normal thousands
separators, but rejects missing original values, invented values or changed percent
units. Protected labels must retain their identity; repeated labels may use natural
pronouns. The checks apply before paragraph/disk caching. They do not prove complete
semantic correctness. Cache identity includes provider/model/glossary/contract;
legacy machine drafts cannot satisfy a precise-translation cache key.

Browser caches are per paper and server revision, keyed by prose content rather
than image HTML. In-flight views are coalesced; late results cache under their own
key and cannot paint another chapter/engine. Reload can reuse the private browser
cache. After first opting into Chinese reading, a stable subsequent chapter can
prepare on demand in the background. `window.paperHubTranslationSnapshot()` returns
only current rendered `{path,texts}` for read-only checks/preparation; figure anchor
IDs and hidden source metadata are excluded. It grants no source-save capability.
For pending inline revisions, text extraction excludes deleted spans and review
numbers and includes proposed additions, so old/new sentences are never joined.
Those blocks are labelled as a pending Chinese preview; reading them does not
accept a proposal. Standalone unresolved LaTeX include identifiers are preserved
verbatim without a model call.
