// Daily backup of every Floorwalker database, run on the server by deploy/floorwalker-backup.timer:
//   node deploy/backup.mjs [data dir] [backup root] [days to keep]
// Each SQLite file is copied with VACUUM INTO, which gives a consistent snapshot while the app keeps running.
// server.secret goes along: stored PayPal and webhook secrets can't be decrypted without it.
// Then every copy is opened and integrity-checked, so a bad backup is reported the day it happens.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const DATA = process.argv[2] ?? '/opt/floorwalker/app/data';
const ROOT = process.argv[3] ?? '/opt/floorwalker/backups';
const KEEP = Number(process.argv[4] ?? 14);
const day = new Date().toISOString().slice(0, 10);
const out = join(ROOT, day);

const files = [];
const walk = (dir) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (name.endsWith('.db')) files.push(p); } };
walk(DATA);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true, mode: 0o700 });
const report = { day, started: new Date().toISOString(), databases: 0, bytes: 0, failed: [] };
for (const file of files) {
  const target = join(out, relative(DATA, file));
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    db.close();
    const copy = new DatabaseSync(target, { readOnly: true });
    const ok = copy.prepare('PRAGMA integrity_check').get();
    copy.close();
    if (Object.values(ok)[0] !== 'ok') throw new Error(`integrity check: ${JSON.stringify(ok)}`);
    report.databases++;
    report.bytes += statSync(target).size;
  } catch (e) {
    report.failed.push({ file: relative(DATA, file), error: e.message });
  }
}
if (existsSync(join(DATA, 'server.secret'))) copyFileSync(join(DATA, 'server.secret'), join(out, 'server.secret'));
report.finished = new Date().toISOString();
writeFileSync(join(out, 'backup.json'), JSON.stringify(report, null, 1));

// Keep the newest KEEP days.
const days = readdirSync(ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
for (const old of days.slice(0, Math.max(0, days.length - KEEP))) rmSync(join(ROOT, old), { recursive: true, force: true });

console.log(`backup ${day}: ${report.databases}/${files.length} databases, ${(report.bytes / 2 ** 20).toFixed(1)} MiB${report.failed.length ? `, FAILED: ${JSON.stringify(report.failed)}` : ''}`);
process.exit(report.failed.length ? 1 : 0);
