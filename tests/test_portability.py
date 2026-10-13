import argparse
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cli
import hub

ROOT = Path(__file__).resolve().parents[1]


class PortableInstallationTests(unittest.TestCase):
    def setUp(self):
        directory = ROOT / '_tmp' / 'audit-release'
        directory.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=directory)
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'paper'
        self.repo.mkdir()
        (self.repo / 'main.tex').write_text('A manuscript fixture.\n')
        self.upstream = self.root / 'reviewed upstream'
        (self.upstream / 'bin').mkdir(parents=True)
        (self.upstream / 'bin/paper-pal.mjs').write_text('''
import {writeFileSync} from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2), repo=args[1];
writeFileSync(path.join(repo,'.paper-pal.json'),JSON.stringify({sourceRoot:'.',defaultDocument:'main.tex',latex:{enabled:false}}));
writeFileSync(path.join(repo,'setup-argv.json'),JSON.stringify(args));
''')
        self.args = argparse.Namespace(main='main.tex', source_root='.', pdf='main.pdf',
            build_script=None, model='account-model', title='Fixture', provider='codex')

    def tearDown(self):
        self.temporary.cleanup()

    def test_new_paper_setup_uses_reviewed_checkout_without_global_cli(self):
        with patch.dict(os.environ, {'PAPER_PAL_DIR': str(self.upstream)}):
            cli.create_config(self.repo, self.args)
        self.assertEqual(json.loads((self.repo / '.paper-pal.json').read_text())['pdf'], 'main.pdf')
        args = json.loads((self.repo / 'setup-argv.json').read_text())
        self.assertEqual(args[:2], ['setup', str(self.repo)])
        self.assertEqual(args[args.index('--model') + 1], 'account-model')

    def test_missing_checkout_fails_with_actionable_diagnostic(self):
        with patch.dict(os.environ, {'PAPER_PAL_DIR': str(self.root / 'missing')}):
            with self.assertRaisesRegex(ValueError, 'Pinned Paper Pal checkout is missing'):
                cli.create_config(self.repo, self.args)
        self.assertFalse((self.repo / '.paper-pal.json').exists())

    def test_user_service_retains_paths_without_copying_secrets(self):
        (self.repo / '.paper-pal.json').write_text(json.dumps({'sourceRoot': '.', 'defaultDocument': 'main.tex'}))
        home = self.root / 'user'
        home.mkdir()
        args = argparse.Namespace(project=str(self.repo), id='portable', title='Fixture', description='',
            tag=[], registry=self.root / 'registry.json', port=4421, adopt_service=None,
            no_start=False, base_url='http://127.0.0.1:4318', main=None, source_root=None,
            pdf=None, build_script=None, model=None, provider='codex')
        with patch.object(cli.Path, 'home', return_value=home), \
             patch.dict(os.environ, {'PAPER_PAL_DIR': str(self.upstream), 'CODEX_BIN': '/approved/codex',
                                     'ANTHROPIC_API_KEY': 'unused'}), \
             patch.object(cli, 'run', return_value=''), patch.object(cli, 'ready', return_value=True), \
             patch.object(cli, 'free_port', return_value=True):
            result = cli.add(args)
        unit = (home / '.config/systemd/user/paper-pal-portable.service').read_text()
        self.assertTrue(result['created'])
        self.assertIn('PAPER_PAL_DIR=' + str(self.upstream), unit)
        self.assertIn('CODEX_BIN=/approved/codex', unit)
        self.assertIn('Environment="PATH=', unit)
        self.assertIn('ExecStart="' + cli.node_command() + '"', unit)
        self.assertNotIn('ANTHROPIC_API_KEY', unit)
        self.assertNotIn('unused', unit)

    def test_gateway_environment_default_and_explicit_override(self):
        auth = self.root / 'auth.json'
        auth.write_text(json.dumps({'username': 'fixture-user', 'password': 'fixture'}))
        auth.chmod(0o600)
        argv = ['hub.py', '--registry', str(self.root / 'registry.json'), '--auth-file', str(auth),
                '--host', '127.0.0.1:4318', '--local']
        for flags, expected in [([], self.upstream), (['--upstream-dir', str(self.root / 'explicit')], self.root / 'explicit')]:
            with patch.dict(os.environ, {'PAPER_PAL_DIR': str(self.upstream)}), \
                 patch('sys.argv', argv + flags), patch.object(hub, 'build_app') as build, \
                 patch.object(hub, 'load_session_key', return_value=b'fixture'), patch.object(hub.web, 'run_app'):
                hub.main()
            self.assertEqual(build.call_args.args[3], expected)


if __name__ == '__main__':
    unittest.main()
