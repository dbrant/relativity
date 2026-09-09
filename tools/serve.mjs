/* serve.mjs — minimal static server for local development.
 *
 *   node tools/serve.mjs [port]        default 8123
 *   node tools/serve.mjs --stop        stop whatever this script left running
 *
 * Ctrl-C stops it. If it was started detached and the shell that launched it is
 * gone, --stop finds it by command line and asks it to close, which is more
 * reliable on Windows than pkill (that matches POSIX process names and will not
 * see "node.exe tools/serve.mjs 8123").
 *
 * It also stands down on its own after IDLE_EXIT_MINUTES without a request, so a
 * forgotten instance does not sit on a port indefinitely.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDLE_EXIT_MINUTES = 45;

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.stl': 'model/stl'
};

/* --stop: find our own kind by command line and end them. */
if (process.argv.includes('--stop')) {
  if (process.platform === 'win32') {
    const ps =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*tools/serve.mjs*' -and " +
      "$_.CommandLine -notlike '*--stop*' } | " +
      "ForEach-Object { Write-Output $_.ProcessId; Stop-Process -Id $_.ProcessId -Force }";
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
    const pids = out ? out.split(/\s+/) : [];
    console.log(pids.length ? 'stopped ' + pids.join(', ') : 'nothing to stop');
  } else {
    try {
      execFileSync('pkill', ['-f', 'tools/serve.mjs'], { stdio: 'ignore' });
      console.log('stopped');
    } catch {
      console.log('nothing to stop');
    }
  }
  process.exit(0);
}

const port = Number(process.argv[2]) || 8123;

const server = createServer(async (req, res) => {
  touch();
  const raw = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const rel = normalize(raw);
  const file = resolve(root, raw === '' ? 'index.html' : rel);
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

/* Sockets are tracked so shutdown does not hang waiting on keep-alive
 * connections the browser is holding open but not using. */
const sockets = new Set();
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

let idleTimer = null;
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => shutdown('idle for ' + IDLE_EXIT_MINUTES + ' min'), IDLE_EXIT_MINUTES * 60_000);
  idleTimer.unref?.();
}

let closing = false;
function shutdown(why) {
  if (closing) return;
  closing = true;
  clearTimeout(idleTimer);
  console.log('\nshutting down (' + why + ')');
  server.close(() => process.exit(0));
  for (const s of sockets) s.destroy();
  // Backstop, in case something still holds the loop open.
  setTimeout(() => process.exit(0), 2000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => shutdown(sig));
}

server.listen(port, () => {
  console.log('http://localhost:' + port + '/   pid ' + process.pid);
  console.log('stop with Ctrl-C, or: node tools/serve.mjs --stop');
  touch();
});
