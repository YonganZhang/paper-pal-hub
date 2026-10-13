#!/usr/bin/env node
import { register } from 'node:module';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
// Match the installed Paper Pal launcher: keep unrelated credentials out of CLI children.
delete process.env.TINYFISH_API_KEY;
register('./backend-loader.mjs', import.meta.url);
await import(pathToFileURL(path.join(process.env.PAPER_PAL_DIR || path.join(homedir(), '.local/share/paper-pal'), 'server.mjs')));
