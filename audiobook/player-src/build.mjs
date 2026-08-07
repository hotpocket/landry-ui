// build.mjs — source in this directory becomes the artifacts consumers copy.
//
// Classic script, not ESM: chatterbook's `build_book.sh --mode standalone`
// emits a file:// bundle and Chrome refuses module fetches over file://.
//
// preact/compat is aliased over react so the source stays idiomatic React —
// moving to React proper later is a change to this file, not to the source.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'player');
const VANILLA = join(here, '..', 'vanilla');

mkdirSync(OUT, { recursive: true });

const result = await build({
  entryPoints: [join(here, 'src', 'index.tsx')],
  bundle: true,
  format: 'iife',
  globalName: 'RepoStoryPlayer',
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  outfile: join(OUT, 'player.js'),
  alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
  logLevel: 'info',
  metafile: true,
});

// Assets that are not compiled and must not drift: the service worker is
// framework-agnostic and ships byte-identical, which is what makes the iOS
// streamed-206 path unable to regress across this port.
// player.css is copied rather than forked while the port is at parity. It moves
// into src/ the moment it has to change (the reading-mode progress line is the
// first thing that will).
for (const f of ['sw.js', 'manifest.webmanifest', 'feedback.js', 'player.css']) {
  const src = join(VANILLA, f);
  if (existsSync(src)) copyFileSync(src, join(OUT, f));
}
if (existsSync(join(VANILLA, 'icons'))) {
  cpSync(join(VANILLA, 'icons'), join(OUT, 'icons'), { recursive: true });
}

const bytes = readFileSync(join(OUT, 'player.js')).length;
const gz = (await import('node:zlib')).gzipSync(readFileSync(join(OUT, 'player.js')), { level: 9 }).length;
console.log(`player.js ${bytes} raw / ${gz} gzip`);
