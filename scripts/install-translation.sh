#!/usr/bin/env bash
set -euo pipefail
hub_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
translation_env="$HOME/envs/paper-hub-translation"
mkdir -p "$HOME/tmp/paper-hub-translation"
export TMPDIR="$HOME/tmp/paper-hub-translation"
if [ ! -x "$translation_env/bin/python" ]; then
  uv venv --python 3.11 "$translation_env"
fi
uv pip install --python "$translation_env/bin/python" 'argostranslate==1.11.0'
export ARGOS_DEVICE_TYPE=cpu
"$translation_env/bin/python" - "$hub_root/sources.lock.json" <<'PY'
import hashlib,json,pathlib,sys
import argostranslate.package as p
expected=json.loads(pathlib.Path(sys.argv[1]).read_text())['translations']['offline']
p.update_package_index()
item=next(i for i in p.get_available_packages() if i.from_code=='en' and i.to_code=='zh' and i.package_version==expected['model'])
file=item.download()
if hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()!=expected['sha256']:
    raise SystemExit('Translation model changed; inspect before installing')
p.install_from_path(file)
print('English → Chinese translation model verified and installed.')
PY
