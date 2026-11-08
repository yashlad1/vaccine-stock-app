import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SAFE, exportProblem, loadProblem, restoreFailedProblem, restoreRejectedProblem, startupProblem, syncProblem,
} from './error-copy';

const text = (p: { title: string; body: string; safe: boolean }) => `${p.title}. ${p.body}${p.safe ? ` ${SAFE}` : ''}`;

describe('error copy: where the "still safe" line appears', () => {
  test('a failed read says what failed, what to do, and that records are safe', () => {
    const p = loadProblem(new Error('database is locked'), 'load your vaccines');
    expect(p).toEqual({
      title: 'Could not load your vaccines',
      body: 'Tap Try again. If it keeps failing, close the app and open it again.',
      safe: true,
      action: 'Try again',
    });
    expect(text(p)).toContain('Your records are still safe on this phone.');
  });

  test('a damaged database file does NOT claim safety, and warns off uninstalling', () => {
    const p = loadProblem(new Error('SQLITE_NOTADB: file is not a database'), 'load your vaccines');
    expect(p.safe).toBe(false);
    expect(text(p)).not.toContain('safe');
    expect(p.body).toContain('Do not uninstall the app');
  });

  test('an app that does not match the data says update, and is safe', () => {
    const p = loadProblem(new Error('no such column: price_rupees'), 'load the trends');
    expect(p.body).toBe('This copy of the app does not match your saved data. Update the app.');
    expect(p.safe).toBe(true);
  });

  test('the downgrade guard: update, and nothing was changed', () => {
    const p = startupProblem('This version of the app (schema v5) is older than your saved data (schema v6). Please update the app.');
    expect(p.title).toBe('Update the app');
    expect(p.action).toBe('Check for update');
    expect(p.safe).toBe(true);
  });

  test('a startup or migration failure does NOT claim safety', () => {
    const p = startupProblem('migration m005 failed: disk I/O error');
    expect(p.title).toBe('Could not open your records');
    expect(p.action).toBe('Restart the app');
    expect(p.safe).toBe(false);
    expect(text(p)).not.toContain('safe');
    expect(text(p)).not.toContain('m005');
  });

  test('a failed backup export is safe: the records were only read', () => {
    const p = exportProblem();
    expect(p.title).toBe('Could not save your backup');
    expect(p.safe).toBe(true);
  });

  test('a rejected restore file keeps the importer reason word for word, and is safe', () => {
    const reason = 'That backup is from a newer version of the app.';
    const p = restoreRejectedProblem(reason);
    expect(p.body).toBe(`${reason} Choose a different backup file.`);
    expect(p.safe).toBe(true);
  });

  test('a restore that fails after she confirmed does NOT claim safety', () => {
    const p = restoreFailedProblem('Disk full.');
    expect(p.body).toContain('Disk full.');
    expect(p.safe).toBe(false);
    expect(text(p)).not.toContain('still safe');
  });
});

describe('error copy: sync is always a delivery delay', () => {
  test.each([
    ['Sign-in failed (400). invalid', 'The server did not accept the login.'],
    ['The server rejected this account (401).', 'The server did not accept the login.'],
    ['Upload of vaccines failed (400): column sex does not exist', 'The server is not ready for this version of the app.'],
    ['Network request failed', 'No connection to the server.'],
    ['Download of patients failed (503): x', 'No connection to the server.'],
    ['something odd', 'Could not reach the server.'],
  ])('%s', (raw, start) => {
    const out = syncProblem(raw);
    expect(out.startsWith(start)).toBe(true);
    expect(out).toContain(SAFE);
    expect(out).not.toMatch(/\(400\)|column|503/);
  });

  test('wrong login points at Server backup', () => {
    expect(syncProblem('The email or password was not accepted.')).toContain('Check the email and password on Server backup.');
  });
});

describe('dashboard wording', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8');
  const src = js.match(/function dashProblem[\s\S]*?\n}\n/)![0];
  const run = (e: unknown, onLine = true) =>
    new Function('e', 'navigator', `${src}; return dashProblem(e);`)(e, { onLine }) as string;
  const SAFE_CLINIC = 'Your records are still safe on the clinic phone.';

  test.each([
    [new Error('signed out'), 'You were signed out.', 'Sign in again'],
    [new TypeError('Failed to fetch'), 'No internet on this device.', 'tap Refresh'],
    [new Error('Could not load data (503)'), 'The server did not answer.', 'tap Refresh'],
    [new Error('The server is out of date: no "level" column'), 'The server is not ready for this version of the page.', 'Tell whoever'],
  ])('%s', (e, start, next) => {
    const out = run(e);
    expect(out.startsWith(start)).toBe(true);
    expect(out).toContain(SAFE_CLINIC);
    expect(out).toContain(next);
    expect(out).not.toMatch(/503|SQL|level/);
  });

  test('offline is recognised without a TypeError', () => {
    expect(run(new Error('x'), false)).toContain('No internet');
  });

  test('no data yet is a sentence, not a bare "No vaccines yet"', () => {
    expect(js).toContain('No records yet. They appear here after the clinic phone uploads its first entry.');
  });
});
