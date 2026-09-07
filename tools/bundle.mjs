/* bundle.mjs — inline every local asset into a single file.
 *
 *   node tools/bundle.mjs
 *
 * Writes two artefacts from the same source:
 *   dist/index.html     a standalone page you can double-click or email
 *   dist/artifact.html  body-only, for hosts that supply their own <head>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(root, p), 'utf8');

let html = read('index.html');

html = html.replace(
  /<link rel="stylesheet" href="(css\/[^"]+)">/g,
  (_, href) => '<style>\n' + read(href).trimEnd() + '\n</style>'
);

html = html.replace(
  /<script src="(js\/[^"]+)"><\/script>/g,
  (_, src) => '<script>\n' + read(src).trimEnd() + '\n</script>'
);

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/index.html'), html);

// The artifact host wraps the file in its own document skeleton, so hand it the
// contents of <head> and <body> with the document furniture removed.
const artifact = html
  .replace(/^[\s\S]*?<head>\s*/i, '')
  .replace(/\s*<\/head>\s*<body>\s*/i, '\n\n')
  .replace(/\s*<\/body>\s*<\/html>\s*$/i, '\n')
  .replace(/^\s*<meta charset="utf-8">\s*$/im, '')
  .replace(/^\s*<meta name="viewport"[^>]*>\s*$/im, '')
  .replace(/\n{3,}/g, '\n\n')
  .trimStart();

writeFileSync(resolve(root, 'dist/artifact.html'), artifact);

const kb = s => (Buffer.byteLength(s) / 1024).toFixed(0) + ' kB';
console.log('dist/index.html    ' + kb(html));
console.log('dist/artifact.html ' + kb(artifact));
