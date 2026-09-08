/* bundle.mjs — inline every local asset into a single file.
 *
 *   node tools/bundle.mjs
 *
 * Writes dist/index.html: a standalone page with no external dependency except
 * the webfonts, which fall back cleanly offline. Double-click it, put it on a
 * USB stick, attach it to an email.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(root, p), 'utf8');

// Refresh the baked-in models first, so a changed STL cannot go stale in dist.
execFileSync(process.execPath, [resolve(root, 'tools/embed-models.mjs')], { stdio: 'inherit' });

let html = read('index.html');

html = html.replace(
  /<link rel="stylesheet" href="(css\/[^"]+)">/g,
  (_, href) => '<style>\n' + read(href).trimEnd() + '\n</style>'
);

html = html.replace(
  /<script src="((?:js|objects)\/[^"]+)"><\/script>/g,
  (_, src) => '<script>\n' + read(src).trimEnd() + '\n</script>'
);

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/index.html'), html);

console.log('dist/index.html  ' + (Buffer.byteLength(html) / 1024).toFixed(0) + ' kB');
