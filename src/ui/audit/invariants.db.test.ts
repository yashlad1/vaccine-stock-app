import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_FONT_SCALE, touch, type as typeScale } from '../tokens';

/**
 * The rules in CLAUDE.md, enforced by reading the source.
 *
 * Several invariants there are architectural: "nothing outside driver.*.ts may
 * import expo-sqlite", "never position anything at bottom: 0". They are stated,
 * reviewed for by hand, and then broken - the navigation-bar clipping shipped
 * for a release and made a working feature look unbuilt.
 *
 * A grep is a crude test. It is also the only kind that catches a rule being
 * broken in a file nobody thought to look at, which is exactly how these get
 * broken.
 */

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const files = walk(SRC).filter((f) => !/\.test\.tsx?$/.test(f));
const rel = (f: string) => f.slice(SRC.length + 1);
const read = (f: string) => readFileSync(f, 'utf8');

describe('invariant 6 — the expo-sqlite firewall', () => {
  /**
   * Two files outside the driver import it, and both are deliberate.
   *
   * `serializeAsync`, `deserializeDatabaseAsync` and `backupDatabaseAsync` have
   * no equivalent in the Db interface, and CLAUDE.md section 10 *requires*
   * them: a raw file copy under WAL yields a silently stale backup, and
   * validate-before-commit restore needs an in-memory database built from
   * bytes.
   *
   * The invariant's PURPOSE - a data layer testable in plain Node - is intact
   * regardless, because the logic is already extracted into csv.ts,
   * validate.ts and collect.ts, which are Node-tested. What remains in these
   * two files is a thin platform shim with no branching worth testing.
   *
   * The allowlist is exact, so a NEW violation still fails. That is the point:
   * this test exists to catch the import nobody meant to add.
   */
  const ALLOWED = new Set(['db/backup/export.ts', 'db/backup/import.ts']);

  it('is imported at RUNTIME only by the driver adapters and the backup shims', () => {
    const offenders = files
      .filter((f) => {
        // `import type` is erased at compile time and costs nothing at runtime,
        // so it does not breach the firewall.
        const runtime = read(f)
          .split('\n')
          .some((l) => /from ['"]expo-sqlite/.test(l) && !/^\s*import\s+type\b/.test(l));
        return runtime;
      })
      .map(rel)
      .filter((f) => !/^db\/driver\.[a-z]+\.ts$/.test(f))
      .filter((f) => !ALLOWED.has(f));
    expect(offenders).toEqual([]);
  });
});

describe('invariant 1 — the ledger is append-only', () => {
  it('no code UPDATEs or DELETEs a movement\'s arithmetic', () => {
    // The database enforces this with triggers too. This catches the attempt
    // at review time rather than as a runtime failure in a clinic.
    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      if (/DELETE\s+FROM\s+stock_movements/i.test(src)) offenders.push(`${rel(f)}: DELETE`);
      // Annotations (patient_id, patient_label, needs_detail, dirty,
      // last_synced_at) ARE editable by design; arithmetic is not.
      const updates = src.match(/UPDATE\s+stock_movements\s+SET\s+([^`]*?)WHERE/gis) ?? [];
      for (const u of updates) {
        if (/\b(delta_doses|movement_type|vaccine_id|lot_id|reverses_id|occurred_at)\s*=/i.test(u)) {
          offenders.push(`${rel(f)}: UPDATE of an arithmetic column`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no code hard-DELETEs a vaccine', () => {
    // Invariant 3: every past dose references the row, so a hard delete
    // orphans the ledger and breaks history, CSV export and every report.
    const offenders = files
      .filter((f) => /DELETE\s+FROM\s+vaccines/i.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('UI rule — nothing sits under the Android navigation bar', () => {
  it('only the shared Footer positions anything at bottom: 0', () => {
    // Because every primary CTA lives in the bottom third by design, a missing
    // inset makes the button untappable rather than merely clipped.
    const offenders = files
      .filter((f) => /bottom:\s*0\b/.test(read(f)))
      .map(rel)
      .filter((f) => f !== 'ui/components.tsx');
    expect(offenders).toEqual([]);
  });

  it('every scrolling screen accounts for the inset', () => {
    const screens = files.filter((f) => rel(f).startsWith('app/') && /\.tsx$/.test(f));
    const offenders: string[] = [];
    for (const f of screens) {
      const src = read(f);
      const scrolls = /<ScrollView|<FlatList/.test(src);
      const handled = /<Footer|useBottomInset/.test(src);
      if (scrolls && !handled) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });
});

describe('UI rule — accessibility floors', () => {
  it('touch targets stay at or above 56dp', () => {
    expect(touch.min).toBeGreaterThanOrEqual(56);
    expect(touch.cta).toBeGreaterThanOrEqual(56);
  });

  it('the type scale never drops below 14pt', () => {
    for (const [name, size] of Object.entries(typeScale)) {
      expect({ name, size }).toMatchObject({ size: expect.any(Number) });
      expect(size >= 14).toBe(true);
    }
  });

  it('font scaling is capped but generous', () => {
    // Capped so a 1.6x display setting cannot push a 34pt number off screen,
    // but the cap must not be so low that it defeats the setting.
    expect(MAX_FONT_SCALE).toBeGreaterThanOrEqual(1.5);
    expect(MAX_FONT_SCALE).toBeLessThanOrEqual(2);
  });

  it('all user-facing text goes through T, which applies the cap', () => {
    // A raw <Text> silently opts out of the font-scale cap.
    const offenders = files
      .filter((f) => rel(f).startsWith('app/') || rel(f).startsWith('ui/'))
      .filter((f) => rel(f) !== 'ui/components.tsx')
      .filter((f) => /<Text[\s>]/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('repo hygiene — the repo is public', () => {
  it('no server credentials are committed anywhere in src', () => {
    // Section 13. A publishable key is designed to be exposed, but a specific
    // clinic's key in a public repo is a standing invitation to probe it.
    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      if (/sb_publishable_[A-Za-z0-9_-]{10,}/.test(src)) offenders.push(`${rel(f)}: publishable key`);
      if (/https:\/\/[a-z0-9]{20}\.supabase\.co/.test(src)) offenders.push(`${rel(f)}: project URL`);
    }
    expect(offenders).toEqual([]);
  });
});
