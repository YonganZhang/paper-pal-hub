#!/usr/bin/env python3
"""Private stdin/stdout translation worker; no manuscript or network access needed."""
import json
import os
import sys
import re

os.environ['ARGOS_DEVICE_TYPE'] = 'cpu'
os.environ['ARGOS_STANZA_AVAILABLE'] = 'false'
os.environ['OMP_NUM_THREADS'] = '2'
os.environ['ARGOS_INTER_THREADS'] = '1'
os.environ['ARGOS_INTRA_THREADS'] = '2'
os.environ['ARGOS_COMPUTE_TYPE'] = 'int8'
os.environ['ARGOS_BEAM_SIZE'] = '1'

import argostranslate.translate

payload = json.load(sys.stdin)
texts = payload['texts']
glossary = payload['glossary']
translator = argostranslate.translate.get_translation_from_codes('en', 'zh')
if translator is None:
    raise SystemExit('English → Chinese model is not installed')
for index, text in enumerate(texts):
    # NDJSON lets the gateway publish genuine progress, even for long sections.
    result = translator.translate(text) if any('a' <= c.lower() <= 'z' for c in text) else text
    for term, rule in glossary.items():
        pattern=r'(?<![A-Za-z])'+re.escape(term).replace(r'\ ',r'[\s-]+')+r'(?![A-Za-z])'
        if re.search(pattern,text,re.IGNORECASE):
            for variant in rule['variants']:
                result = re.sub(re.escape(variant),lambda match:rule['target'],result,flags=re.IGNORECASE)
    print(json.dumps({'index': index, 'text': result}, ensure_ascii=False), flush=True)
