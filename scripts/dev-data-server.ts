import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Serve the newest Mac backup's clinic.db to the browser dev loop, which
 * loads it in place of an empty database (loadMacCopy in src/db/driver.expo.ts).
 *
 * Bound to 127.0.0.1, so the children's records never leave this Mac: a
 * phone on the same Wi-Fi cannot reach it. Read on every request, so the
 * next nightly copy is picked up without a restart.
 *
 *   node scripts/dev-data-server.ts            # newest folder in backups/
 *   node scripts/dev-data-server.ts <folder>   # any folder holding clinic.db
 *
 * Then open http://localhost:8081/?macdata to replace the browser's
 * database with it. Run with node, never as an npm script: `packageJson:scripts`
 * is an OTA fingerprint source (CLAUDE.md section 10a).
 */

const PORT = 8099;
const LOCAL_PAGE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function newestCopy(): string {
  if (process.argv[2]) return join(resolve(process.argv[2]), 'clinic.db');
  const dir = resolve('backups');
  const latest = readdirSync(dir).filter((n) => n.startsWith('clinic-server-copy-')).sort().at(-1);
  if (!latest) throw new Error(`no clinic-server-copy-* folder in ${dir}`);
  return join(dir, latest, 'clinic.db');
}

createServer((req, res) => {
  const origin = req.headers.origin ?? '';
  if (origin && !LOCAL_PAGE.test(origin)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const file = newestCopy();
    res.writeHead(200, {
      'Content-Type': 'application/vnd.sqlite3',
      'Cache-Control': 'no-store',
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    });
    res.end(readFileSync(file));
    console.log(`served ${file}`);
  } catch (e) {
    res.writeHead(404).end();
    console.error(e instanceof Error ? e.message : e);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`clinic copy on http://127.0.0.1:${PORT}/clinic.db`));
