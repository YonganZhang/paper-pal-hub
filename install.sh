#!/bin/sh
set -eu
hub_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$HOME/bin"
if [ -e "$HOME/bin/paper-hub" ]; then
  echo 'paper-hub already exists; inspect its target before replacing it.' >&2
  exit 1
fi
python3 - "$hub_root" "$HOME/bin/paper-hub" <<'PY'
import pathlib,shlex,sys
p=pathlib.Path(sys.argv[2])
p.write_text('#!/bin/sh\nexec /usr/bin/python3 '+shlex.quote(str(pathlib.Path(sys.argv[1])/'cli.py'))+' "$@"\n')
p.chmod(0o755)
PY
