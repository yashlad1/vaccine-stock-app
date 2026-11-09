/**
 * Mutation testing, without a dependency.
 *
 * Breaks the code on purpose, one edit at a time, and reports which edits the
 * test suite FAILS to notice. A surviving mutant is a line of behaviour no
 * test actually pins. "543 tests pass" says nothing about that.
 *
 * Stryker would do this better, but `package.json` is an EAS fingerprint
 * source: a devDependency there rotates the OTA runtimeVersion and cuts every
 * installed phone off from updates (CLAUDE.md section 10a). So this is 100
 * lines and no dependency, and it runs as `node`, never as an npm script, for
 * the same reason.
 *
 *   node scripts/mutate.ts                    # the correctness-critical layer
 *   node scripts/mutate.ts src/domain/supply.ts
 *   node scripts/mutate.ts --all              # every operator, much slower
 *
 * Restores every file it touches, including on Ctrl-C.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Op = { name: string; find: RegExp; make: (m: string) => string };

// Conservative operators: each produces code that still parses, and each maps
// to a mistake a person could actually make.
const OPS: Op[] = [
  { name: 'boundary <= to <', find: /<=/g, make: () => '<' },
  { name: 'boundary >= to >', find: />=/g, make: () => '>' },
  { name: 'boundary < to <=', find: /([^<>=!])<([^<=])/g, make: (m) => m.replace('<', '<=') },
  { name: 'boundary > to >=', find: /([^->=!])>([^>=])/g, make: (m) => m.replace('>', '>=') },
  { name: 'equality flipped', find: /===/g, make: () => '!==' },
  { name: 'inequality flipped', find: /!==/g, make: () => '===' },
  { name: 'and to or', find: /&&/g, make: () => '||' },
  { name: 'or to and', find: /\|\|/g, make: () => '&&' },
  { name: 'true to false', find: /\btrue\b/g, make: () => 'false' },
  { name: 'false to true', find: /\bfalse\b/g, make: () => 'true' },
  { name: 'off by one', find: /\b(\d{1,4})\b/g, make: (m) => String(Number(m) + 1) },
];

const DEFAULT_TARGETS = ['src/domain', 'src/db/repo'];
const args = process.argv.slice(2).filter((a) => a !== '--all');
const ALL = process.argv.includes('--all');

function sources(path: string): string[] {
  const p = resolve(path);
  if (statSync(p).isFile()) return [p];
  return readdirSync(p).flatMap((n) => {
    const f = join(p, n);
    if (statSync(f).isDirectory()) return sources(f);
    return n.endsWith('.ts') && !n.includes('.test.') ? [f] : [];
  });
}

const files = (args.length ? args : DEFAULT_TARGETS).flatMap(sources);
const suite = () => {
  try {
    execFileSync('npx', ['jest', '--silent'], {
      stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    });
    return true;   // suite passed => the mutant SURVIVED
  } catch { return false; }  // suite failed => the mutant was KILLED
};

const originals = new Map<string, string>();
const restore = () => originals.forEach((text, f) => writeFileSync(f, text));
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('exit', restore);

console.log(`Baseline: checking the suite is green before mutating...`);
if (!suite()) { console.error('The suite is already failing. Fix that first.'); process.exit(1); }

let killed = 0;
const survivors: string[] = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  originals.set(file, text);
  const lines = text.split('\n');
  for (const op of ALL ? OPS : OPS.slice(0, 8)) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comments and string-only lines: a mutation there proves nothing.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      op.find.lastIndex = 0;
      if (!op.find.test(line)) continue;
      op.find.lastIndex = 0;
      const mutatedLine = line.replace(op.find, (m) => op.make(m));
      if (mutatedLine === line) continue;
      const copy = [...lines];
      copy[i] = mutatedLine;
      writeFileSync(file, copy.join('\n'));
      const survived = suite();
      writeFileSync(file, text);
      const where = `${file.replace(resolve('.') + '/', '')}:${i + 1}`;
      if (survived) survivors.push(`  SURVIVED  ${op.name.padEnd(20)} ${where}\n              ${line.trim().slice(0, 100)}`);
      else killed++;
      process.stdout.write(survived ? 'o' : '.');
    }
  }
}

const total = killed + survivors.length;
console.log(`\n\nMutants: ${total}  killed: ${killed}  survived: ${survivors.length}`);
console.log(`Mutation score: ${total ? ((killed / total) * 100).toFixed(1) : '-'}%\n`);
if (survivors.length) {
  console.log('Lines no test pins (review each: some are equivalent mutants, not gaps):\n');
  console.log(survivors.join('\n'));
}
