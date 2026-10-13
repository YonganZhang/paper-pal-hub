import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('public_export', ROOT / 'scripts/export-public.py')
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class PublicExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in (*exporter.REQUIRED, exporter.README_SOURCE):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('Public source for ' + name + '\n')

    def test_allowlist_readme_manifest_and_repeat_keep_git(self):
        for name in ('.git/config', '_reports/private-review.md', '.env',
                     '.paper-pal/chat/session.json', '_tmp/browser.config.json',
                     'web/private-extra.js', 'papers/main.tex'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('PRIVATE NOT EXPORTED')
        (self.root / 'docs/local-cli.md').write_text('Optional local interface documentation\n')
        result = exporter.export_public(self.root)
        destination = Path(result['output'])
        self.assertEqual((destination / 'README.md').read_text(), (self.root / exporter.README_SOURCE).read_text())
        self.assertTrue((destination / 'figures.py').exists())
        self.assertTrue((destination / 'docs/local-cli.md').exists())
        self.assertFalse((destination / '.git').exists())
        self.assertFalse((destination / '.env').exists())
        self.assertFalse((destination / 'web/private-extra.js').exists())
        self.assertFalse((destination / 'papers').exists())
        manifest_before = (destination / exporter.MANIFEST).read_bytes()
        manifest = json.loads(manifest_before)
        for name, digest in manifest['files'].items():
            self.assertEqual(hashlib.sha256((destination / name).read_bytes()).hexdigest(), digest)
        (destination / '.git').mkdir()
        (destination / '.git/config').write_text('EXISTING PUBLIC GIT METADATA')
        exporter.export_public(self.root)
        self.assertEqual((destination / exporter.MANIFEST).read_bytes(), manifest_before)
        self.assertEqual((destination / '.git/config').read_text(), 'EXISTING PUBLIC GIT METADATA')
        self.assertFalse(any(b'PRIVATE NOT EXPORTED' in path.read_bytes() for path in destination.rglob('*') if path.is_file()))

    def test_secret_rejection_happens_before_output_mutation(self):
        exporter.export_public(self.root)
        destination = self.root / '_tmp/public-release'
        previous = (destination / 'hub.py').read_bytes()
        # Construct the fixture dynamically, so the exported test contains no key.
        (self.root / 'hub.py').write_text('key = "' + 'sk-' + 'proj-' + 'x' * 32 + '"\n')
        with self.assertRaisesRegex(ValueError, 'Secret-like'):
            exporter.export_public(self.root)
        self.assertEqual((destination / 'hub.py').read_bytes(), previous)
        (self.root / 'hub.py').write_text(json.dumps({'password': 'private' + '-value-for-test'}))
        with self.assertRaisesRegex(ValueError, 'Secret-like'):
            exporter.export_public(self.root)
        self.assertEqual((destination / 'hub.py').read_bytes(), previous)

    def test_unsafe_paths_symlinks_and_unmanaged_output_refused(self):
        with self.assertRaisesRegex(ValueError, 'Output must'):
            exporter.export_public(self.root, self.root / 'public')
        with self.assertRaisesRegex(ValueError, 'Output must'):
            exporter.export_public(self.root, self.root / '_tmp/../outside')
        with self.assertRaisesRegex(ValueError, 'Unsafe source'):
            exporter.safe_file(self.root, '../outside')
        (self.root / '_tmp').mkdir()
        (self.root / '_tmp/link').symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            exporter.export_public(self.root, self.root / '_tmp/link/output')
        asset = self.root / 'hub.py'
        asset.unlink()
        asset.symlink_to(self.root / 'cli.py')
        with self.assertRaisesRegex(ValueError, 'Symlinks'):
            exporter.export_public(self.root)
        asset.unlink()
        asset.write_text('restored fixture')
        exporter.export_public(self.root)
        destination = self.root / '_tmp/public-release'
        (destination / 'unknown-secret.txt').write_text('do not delete me')
        with self.assertRaisesRegex(ValueError, 'Unmanaged'):
            exporter.export_public(self.root)
        self.assertEqual((destination / 'unknown-secret.txt').read_text(), 'do not delete me')

    def test_cli_failure_has_empty_stdout_and_nonzero_status(self):
        completed = subprocess.run([sys.executable, str(ROOT / 'scripts/export-public.py'),
                                    '--source', str(self.root), '--output', str(self.root / 'bad'), '--json'],
                                   stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, '')
        self.assertIn('Export refused:', completed.stderr)
