#!/usr/bin/env python3
"""paper-hub: connect an exact local LaTeX project to the shared paper library."""
import argparse
import fcntl
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_REGISTRY = Path.home() / '.config/paper-pal/hub.json'
SLUG = re.compile(r'^[a-z0-9][a-z0-9-]{0,62}$')


def upstream_directory():
    return Path(os.environ.get('PAPER_PAL_DIR') or Path.home() / '.local/share/paper-pal').expanduser().resolve()


def node_command():
    command = shutil.which('node')
    if not command:
        raise ValueError('Node 22+ is required; node was not found on PATH')
    return command


def atomic_json(path, data):
    fd, name = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(data, out, ensure_ascii=False, indent=2); out.write('\n')
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_registry(path):
    if not path.exists():
        return {'schema_version': 1, 'papers': []}
    data = json.loads(path.read_text())
    if data.get('schema_version') != 1 or not isinstance(data.get('papers'), list):
        raise ValueError('Registry schema must be version 1')
    return data


def ready(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/bootstrap', timeout=2) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


def free_port(port):
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def run(command):
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError(f"Command failed: {command[0]}: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def inside(repo, value, label, exists=False):
    value_path = Path(value)
    target = (repo / value_path).resolve()
    if value_path.is_absolute() or not target.is_relative_to(repo) or target == repo:
        raise ValueError(f'{label} must be a relative path inside the project')
    if exists and not target.exists():
        raise ValueError(f'{label} does not exist: {value}')
    return target


def create_config(repo, args):
    config_path = repo / '.paper-pal.json'
    if config_path.exists():
        config = json.loads(config_path.read_text())
        source = config.get('sourceRoot', '.')
        if source != '.':
            inside(repo, source, 'sourceRoot', exists=True)
        main = config.get('defaultDocument')
        if not main:
            raise ValueError('Existing .paper-pal.json needs defaultDocument')
        inside(repo, main, 'defaultDocument', exists=True)
        for flag, given, actual in [('main', args.main, main), ('source-root', args.source_root, source),
                                     ('pdf', args.pdf, config.get('pdf'))]:
            if given and given != actual:
                raise ValueError(f'Existing config has a different {flag}; edit it explicitly before registering')
        if args.build_script or args.model:
            raise ValueError('Existing config preserved; configure build/model in .paper-pal.json first')
        return
    if not all((args.main, args.source_root, args.pdf)):
        raise ValueError('New project needs --main, --source-root and --pdf (or an existing .paper-pal.json)')
    main = inside(repo, args.main, 'main', exists=True)
    source = repo if args.source_root == '.' else inside(repo, args.source_root, 'source-root', exists=True)
    if not main.is_relative_to(source):
        raise ValueError('main must be inside source-root')
    inside(repo, args.pdf, 'pdf')
    if args.build_script:
        inside(repo, args.build_script, 'build-script', exists=True)
        if any(c in args.build_script for c in '\n\r'):
            raise ValueError('build-script contains a newline')
    makefile = repo / '.paper-hub.mk'
    if makefile.exists() and args.build_script:
        raise ValueError('.paper-hub.mk already exists; configure manually to preserve it')
    launcher = upstream_directory() / 'bin/paper-pal.mjs'
    if not launcher.is_file():
        raise ValueError('Pinned Paper Pal checkout is missing: ' + str(launcher))
    setup = [node_command(), str(launcher), 'setup', str(repo), '--main', args.main,
             '--source', args.source_root, '--title', args.title, '--provider', args.provider,
             '--review-language', 'Chinese', '--no-compile', '--no-remember', '--json']
    if args.model:
        setup.extend(['--model', args.model])
    run(setup)
    try:
        config = json.loads(config_path.read_text())
        config['pdf'] = args.pdf
        config.setdefault('claude', {'command':'claude', 'model':'haiku', 'models':['haiku','sonnet','opus']})
        if args.build_script:
            # make accepts a LaTeX target so Paper Pal can infer the main outline.
            script = shlex.quote(args.build_script).replace('$', '$$').replace('#', '\\#')
            makefile.write_text(f'.PHONY: all\nall:\n\tbash {script}\n\n%:\n\t@:\n')
            config['latex'] = {'enabled': True, 'cwd': '.', 'command': 'make',
                               'args': ['-f', '.paper-hub.mk', 'all', args.main]}
        atomic_json(config_path, config)
    except Exception:
        config_path.unlink(missing_ok=True)
        makefile.unlink(missing_ok=True)
        raise


def systemd_quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def ensure_paper_skill(repo):
    target = repo / '.agents/skills/paper-ai/SKILL.md'
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text((Path(__file__).resolve().parent / 'templates/paper-ai.SKILL.md.template').read_text())
    claude_skills=repo / '.claude/skills'
    if not claude_skills.exists() and not claude_skills.is_symlink():
        claude_skills.parent.mkdir(parents=True,exist_ok=True)
        claude_skills.symlink_to('../.agents/skills')
    elif claude_skills.is_dir() and not claude_skills.is_symlink():
        for skill in target.parent.parent.iterdir():
            link=claude_skills/skill.name
            if not link.exists() and not link.is_symlink():
                link.symlink_to(Path('../../.agents/skills')/skill.name)
    readme = repo / '.agents/README.md'
    if not readme.exists():
        readme.write_text('# 项目论文 AI\n\n`skills/paper-ai/SKILL.md` 提供本项目论文共改入口；全局规则与技能保持用户级真源，聊天与批注留在 `.paper-pal/`。入口由 `paper-hub add` 安装，修改记录见项目 Git。\n')


def add(args):
    address=urlsplit(args.base_url)
    if address.scheme not in ('http','https') or not address.netloc or address.username or address.password or address.query or address.fragment or address.path not in ('','/'):
        raise ValueError('base-url must be an http(s) origin without credentials or paths')
    if not SLUG.fullmatch(args.id):
        raise ValueError('id must be 1–63 lowercase letters, digits or hyphens, starting with a letter/digit')
    repo = Path(args.project).expanduser().resolve(strict=True)
    if not repo.is_dir():
        raise ValueError('project must be a directory')
    if any(c in str(repo) + args.title for c in '\n\r\x00'):
        raise ValueError('Project path and title must be single lines')
    if args.port and not 1024 <= args.port <= 65535:
        raise ValueError('port must be between 1024 and 65535')
    if args.adopt_service and not re.fullmatch(r'[a-zA-Z0-9_.-]+\.service', args.adopt_service):
        raise ValueError('Invalid user service name')
    registry = args.registry.expanduser().resolve()
    registry.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(str(registry) + '.lock', 'a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = read_registry(registry)
        current = next((p for p in data['papers'] if p['id'] == args.id), None)
        if current:
            if current['repo'] != str(repo):
                raise ValueError('This id belongs to another project; registry was not changed')
            return {'schema_version': 1, 'created': False, 'paper': current}
        if any(p['repo'] == str(repo) for p in data['papers']):
            raise ValueError('Project already registered; do not start two backends for the same source')
        occupied = {p['port'] for p in data['papers']}
        port = args.port or next((n for n in range(4320, 4420) if n not in occupied and free_port(n)), None)
        if not port or port in occupied:
            raise ValueError('Port is unavailable or already registered')
        if args.adopt_service:
            if not args.port or not ready(port):
                raise ValueError('Adopting a service requires --port and a healthy existing backend')
            working = run(['systemctl', '--user', 'show', args.adopt_service, '-p', 'WorkingDirectory', '--value']).strip()
            if Path(working).resolve() != repo:
                raise ValueError('Existing service belongs to a different project')
        elif not free_port(port):
            raise ValueError('Port is already in use')
        create_config(repo, args)
        ensure_paper_skill(repo)
        service = args.adopt_service or f'paper-pal-{args.id}.service'
        item = {'id': args.id, 'title': args.title, 'repo': str(repo), 'port': port, 'service': service,
                'description': args.description, 'tags': args.tag,
                'url': args.base_url.rstrip('/') + f'/papers/{args.id}/'}
        if not args.no_start and not args.adopt_service:
            unit_dir = Path.home() / '.config/systemd/user'
            unit_dir.mkdir(parents=True, exist_ok=True)
            unit = unit_dir / service
            if unit.exists():
                raise ValueError('Service file already exists; refusing to replace it')
            tmp = Path.home() / 'tmp/paper-hub' / args.id
            tmp.mkdir(parents=True, exist_ok=True, mode=0o700)
            launcher = Path(__file__).resolve().parent / 'backend-launch.mjs'
            service_environment = {'PAPER_PAL_DIR': str(upstream_directory())}
            service_environment.update({key: os.environ[key] for key in ('PATH', 'CODEX_BIN', 'CLAUDE_BIN') if key in os.environ})
            environment_lines = ''.join('Environment=' + systemd_quote(key + '=' + value) + '\n'
                                        for key, value in service_environment.items())
            unit.write_text('[Unit]\nDescription=Paper Pal ' + args.id + '\nAfter=network-online.target\n\n'
                            '[Service]\nType=simple\nWorkingDirectory=' + str(repo).replace('%', '%%') + '\n'
                            'Environment=' + systemd_quote('TMPDIR=' + str(tmp)) + '\n'
                            + environment_lines +
                            'ExecStart=' + systemd_quote(node_command()) + ' ' + systemd_quote(launcher) + ' --repo . --port ' + str(port) + '\n'
                            'Restart=on-failure\nRestartSec=3\nTimeoutStopSec=10\nUMask=0077\n\n'
                            '[Install]\nWantedBy=default.target\n')
            try:
                run(['systemctl', '--user', 'daemon-reload'])
                run(['systemctl', '--user', 'enable', '--now', service])
                for _ in range(30):
                    if ready(port):
                        break
                    time.sleep(.3)
                else:
                    raise ValueError('Backend did not become ready; see its user systemd journal')
            except Exception:
                # Cleanup must not hide the original error (including a bad unit).
                subprocess.run(['systemctl', '--user', 'disable', '--now', service],
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
                unit.unlink(missing_ok=True)
                subprocess.run(['systemctl', '--user', 'daemon-reload'],
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
                raise
        data['papers'].append(item)
        atomic_json(registry, data)
        return {'schema_version': 1, 'created': True, 'paper': item}


def main():
    if len(sys.argv)>1 and sys.argv[1] in ('versions','figures'):
        from archive_cli import main as archive_main
        return archive_main(sys.argv[1],sys.argv[2:])
    parser = argparse.ArgumentParser(description=__doc__, epilog='Examples: paper-hub add /abs/project --id my-paper --title "My paper" --json\nLocal agents: paper-hub versions --help | paper-hub figures --help\nExisting .paper-pal.json is preserved. New projects: see add --help.')
    sub = parser.add_subparsers(dest='command', required=True)
    ap = sub.add_parser('add', help='Register a project, creating a user service unless --no-start')
    ap.add_argument('project'); ap.add_argument('--id', required=True); ap.add_argument('--title', required=True)
    ap.add_argument('--description', default=''); ap.add_argument('--tag', action='append', default=[])
    ap.add_argument('--main'); ap.add_argument('--source-root'); ap.add_argument('--pdf'); ap.add_argument('--build-script')
    ap.add_argument('--provider', choices=['codex', 'claude'], default='codex'); ap.add_argument('--model')
    ap.add_argument('--port', type=int); ap.add_argument('--adopt-service'); ap.add_argument('--no-start', action='store_true')
    ap.add_argument('--base-url', default=os.environ.get('PAPER_HUB_BASE_URL','https://papers.yongan.site'), help='Public library URL, e.g. http://127.0.0.1:4318')
    for name in ('list', 'status'):
        sub.add_parser(name, help='List registered papers' if name == 'list' else 'Check backend health; exit 1 if any is offline')
    for p in sub.choices.values():
        p.add_argument('--registry', type=Path, default=DEFAULT_REGISTRY, help='Private registry (default: ~/.config/paper-pal/hub.json)')
        p.add_argument('--json', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'add':
            result = add(args)
        else:
            result = read_registry(args.registry.expanduser())
            if args.command == 'status':
                result['papers'] = [p | {'ready': ready(p['port'])} for p in result['papers']]
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        elif args.command == 'add':
            print(('Registered: ' if result['created'] else 'Already registered: ') + result['paper']['url'])
        else:
            for p in result['papers']:
                print(p['id'] + ' · ' + p['title'] + (' · ' + ('ready' if p['ready'] else 'offline') if 'ready' in p else '') + ' · ' + p['url'])
        if args.command == 'status' and any(not p['ready'] for p in result['papers']):
            return 1
        return 0
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f'paper-hub: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
