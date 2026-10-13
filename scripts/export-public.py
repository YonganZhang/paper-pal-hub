#!/usr/bin/env python3
"""Export an explicit, reviewed source set without the development Git history."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

# New application files are deliberately opt-in. Production-specific browser
# scripts, service units, reports, registry and manuscript files are excluded.
REQUIRED = (
    'LICENSE', 'requirements.txt', '.gitignore', 'install.sh',
    'hub.py', 'cli.py', 'archive_cli.py', 'backend-launch.mjs', 'backend-loader.mjs',
    'subscription-cli.mjs', 'consultation-cli.mjs', 'translation.py', 'translate-worker.py',
    'translation-ai.mjs', 'sources.lock.json',
    'scripts/export-public.py', 'scripts/install-translation.sh', 'scripts/README.md',
    'templates/README.md', 'templates/paper-ai.SKILL.md.template',
    'docs/README.md', 'docs/api-contract.md', 'docs/publication.md', 'docs/public-readme.md',
    'tests/test_hub.py', 'tests/test_translation.py', 'tests/test_public_export.py',
    'tests/backend_contract.test.mjs', 'tests/subscription_contract.test.mjs', 'tests/consultation_contract.test.mjs',
    'tests/browser_ai_send.js', 'tests/browser_ai_selection.js',
    'tests/browser_draft_ack.js', 'tests/browser_reading_artifacts.js',
    'web/index.html', 'web/login.html', 'web/login.css', 'web/icon.svg',
    'web/library.js', 'web/library.css', 'web/mobile.js', 'web/mobile.css',
    'web/reader.js', 'web/zh.js', 'web/paper-ai.js', 'web/paper-ai.css',
    'web/translation.js',
    'versions.py', 'figures.py', 'figure-task.mjs',
    'web/versions.js', 'web/versions.css',
    'web/figure-studio.js', 'web/figure-studio.css',
    'web/figure-inline.js',
    'tests/test_versions.py', 'tests/test_figures.py',
    'tests/figure_task_contract.test.mjs', 'tests/browser_versions.js',
    'tests/browser_figure_studio.js', 'tests/browser_text_input.js', 'tests/browser_figure_inline.js', 'tests/browser_consultation_fill.js', 'tests/browser_translation_visible.js', 'tests/browser_translation_races.js', 'tests/browser_translation_quality.js',
    'tests/browser_retry_identity.js', 'tests/test_portability.py',
    'tests/runtime_paths.test.mjs',
)
OPTIONAL = ('docs/local-cli.md',)
README_SOURCE = 'docs/public-readme.md'
MANIFEST = 'public-export-manifest.json'
SECRET_PATTERNS = (
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(rb'\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b'),
    re.compile(rb'(?i)authorization\s*[:=]\s*["\']?Bearer\s+[A-Za-z0-9._-]{24,}'),
    re.compile(rb'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b'),
    re.compile(rb'https?://[^/\s:@]+:[^/\s@]+@'),
    re.compile(rb'''(?i)["']?(?:password|api_key|auth_token)["']?\s*[:=]\s*["'][^"'\r\n]{12,}["']'''),
)


def safe_file(root, relative):
    name = Path(relative)
    if name.is_absolute() or '..' in name.parts or '.git' in name.parts:
        raise ValueError('Unsafe source path')
    path = root / name
    for part in (path, *path.parents):
        if part == root:
            break
        if part.is_symlink():
            raise ValueError(f'Symlinks are not exportable: {relative}')
    if not path.is_file() or not path.resolve().is_relative_to(root):
        raise ValueError(f'Missing or unsafe source file: {relative}')
    return path


def source_payload(root):
    sources = {name: name for name in REQUIRED}
    sources.update({name: name for name in OPTIONAL if (root / name).exists() or (root / name).is_symlink()})
    sources['README.md'] = README_SOURCE
    payload = {}
    for destination, relative in sorted(sources.items()):
        file = safe_file(root, relative)
        data = file.read_bytes()
        if any(pattern.search(data) for pattern in SECRET_PATTERNS):
            raise ValueError(f'Secret-like content requires review: {relative}')
        # Reject binary dumps and credentials masquerading as an approved source.
        try:
            data.decode('utf-8')
        except UnicodeDecodeError as error:
            raise ValueError(f'Non-text export source: {relative}') from error
        payload[destination] = (data, 0o755 if file.stat().st_mode & stat.S_IXUSR else 0o644)
    manifest = {
        'schema_version': 1,
        'files': {name: hashlib.sha256(data).hexdigest() for name, (data, _) in payload.items()},
    }
    payload[MANIFEST] = ((json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode(), 0o644)
    return payload


def export_public(source, output=None):
    root = Path(source).resolve()
    destination = Path(output) if output is not None else root / '_tmp/public-release'
    destination = destination.absolute()
    staging_root = root / '_tmp'
    if not destination.is_relative_to(staging_root) or destination == staging_root:
        raise ValueError('Output must be a child of the source _tmp directory')
    for part in (destination, *destination.parents):
        if part == root:
            break
        if part.is_symlink():
            raise ValueError('Output paths must not contain symlinks')
    destination = destination.resolve()
    if not destination.is_relative_to(staging_root) or destination == staging_root:
        raise ValueError('Output must be a child of the source _tmp directory')
    payload = source_payload(root)  # Preflight everything before writing anything.
    if destination.exists():
        for file in destination.rglob('*'):
            relative = file.relative_to(destination)
            if relative.parts[0] == '.git':
                continue  # Never read, replace or delete repository metadata.
            if file.is_symlink():
                raise ValueError(f'Unexpected output symlink: {relative}')
            if file.is_file() and str(relative) not in payload:
                raise ValueError(f'Unmanaged output file; inspect manually: {relative}')
    for name, (data, mode) in payload.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix='.export-', dir=path.parent)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data)
            os.chmod(temporary, mode)
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return {'schema_version': 1, 'output': str(destination), 'file_count': len(payload),
            'manifest': str(destination / MANIFEST)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog='Example: python3 scripts/export-public.py --json')
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1], help='Application source root')
    parser.add_argument('--output', type=Path, help='Child of source/_tmp (default: _tmp/public-release)')
    parser.add_argument('--json', action='store_true', help='Print schema_version, output, file_count and manifest')
    args = parser.parse_args(argv)
    try:
        result = export_public(args.source, args.output)
    except (OSError, ValueError) as error:
        print(f'Export refused: {error}', file=sys.stderr)
        return 1
    print(json.dumps(result) if args.json else f"Exported {result['file_count']} files to {result['output']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
