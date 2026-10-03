/**
 * Re-encrypts participant CNICs from the legacy/previous key to the CURRENT ENCRYPTION_KEY, without ever
 * losing data.
 *
 *   1. Deploy the backend with CnicCipher (decrypt falls back to the legacy default key).
 *   2. Set ENCRYPTION_KEY on the backend to a new random secret (32+ chars). Old rows keep working.
 *   3. DRY RUN (default, writes nothing):   npm run rotate:cnic
 *   4. APPLY:                               npm run rotate:cnic -- --apply
 *   5. UNDO (if ever needed):               npm run rotate:cnic -- --rollback=<backup-file>
 *
 * Safety guarantees
 *  - Before the first write, a backup file `cnic-rotation-backup-<timestamp>.json` (old ciphertexts) is written
 *    and fsynced. KEEP IT until you are sure; it only contains ciphertext, but treat it as sensitive.
 *  - Every row is re-encrypted, decrypted back and compared with the original plaintext BEFORE the write, then
 *    read back from the DB and verified AFTER the write; on any mismatch the old ciphertext is restored.
 *  - Each write is a compare-and-set on the old ciphertext, so concurrent edits are never overwritten.
 *  - A row whose digits do not match `cnicHash` is still rotated (the plaintext is preserved exactly; the hash is
 *    an independent column) and is listed as an informational "hash discrepancy".
 *  - Rows that cannot be decrypted with any known key are NEVER touched; they are listed for manual follow-up.
 *  - Re-running is safe: rows already on the current key are skipped.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { CnicCipher } from '../src/common/cnic-cipher';

const BATCH = 200;
type Row = { id: string; cnic: string; cnicHash: string | null };

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function sha256(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex');
}

async function updatedRows(ds: DataSource, id: string, next: string, expected: string): Promise<number> {
  const out: unknown = await ds.query(
    `UPDATE participations SET cnic = $1 WHERE id = $2 AND cnic = $3`,
    [next, id, expected],
  );
  return Array.isArray(out) ? Number(out[1]) : 0;
}

async function rollback(ds: DataSource, cipher: CnicCipher, file: string) {
  const backup: { id: string; cnic: string }[] = JSON.parse(fs.readFileSync(file, 'utf8')).rows;
  const stats = { inBackup: backup.length, restored: 0, alreadyOriginal: 0, skippedChanged: 0 };
  for (const b of backup) {
    const [cur]: { cnic: string }[] = await ds.query(`SELECT cnic FROM participations WHERE id = $1`, [b.id]);
    if (!cur) continue;
    if (cur.cnic === b.cnic) {
      stats.alreadyOriginal++;
      continue;
    }
    // Only restore when the current value still holds the SAME CNIC as the backup (never undo a real edit).
    const before = cipher.tryDecrypt(b.cnic)?.value;
    const now = cipher.tryDecrypt(cur.cnic)?.value;
    if (!before || before !== now) {
      stats.skippedChanged++;
      console.warn(`not restored (value changed since rotation): ${b.id}`);
      continue;
    }
    if ((await updatedRows(ds, b.id, b.cnic, cur.cnic)) === 1) stats.restored++;
  }
  console.log('ROLLBACK DONE');
  console.table(stats);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const rollbackFile = argValue('rollback');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const config = app.get(ConfigService);
    const cipher = new CnicCipher({
      current: config.get<string>('ENCRYPTION_KEY'),
      previous: config.get<string>('ENCRYPTION_KEY_PREVIOUS'),
    });
    const ds = app.get(DataSource);

    if (rollbackFile) {
      await rollback(ds, cipher, rollbackFile);
      return;
    }
    if (!cipher.usesCustomKey) {
      console.error(
        'ENCRYPTION_KEY is not set (or equals the public default). Set a new secret first — otherwise there is nothing to rotate to.',
      );
      process.exitCode = 1;
      return;
    }

    // Pass 1: classify every row (read-only).
    const stats = { scanned: 0, alreadyCurrent: 0, toRotate: 0, hashDiscrepancy: 0, undecryptable: 0 };
    const plan: { row: Row; plain: string }[] = [];
    const undecryptable: string[] = [];
    let lastId = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const rows: Row[] = await ds.query(
        `SELECT id, cnic, "cnicHash" FROM participations
         WHERE cnic LIKE '%:%' AND id > $1 ORDER BY id ASC LIMIT ${BATCH}`,
        [lastId],
      );
      if (!rows.length) break;
      for (const row of rows) {
        lastId = row.id;
        stats.scanned++;
        const res = cipher.tryDecrypt(row.cnic);
        if (!res) {
          stats.undecryptable++;
          undecryptable.push(row.id);
          continue;
        }
        if (res.usedCurrentKey) {
          stats.alreadyCurrent++;
          continue;
        }
        if (row.cnicHash && sha256(res.value) !== row.cnicHash) stats.hashDiscrepancy++;
        stats.toRotate++;
        plan.push({ row, plain: res.value });
      }
    }

    const written = { rotated: 0, raceSkipped: 0, restoredAfterFailedVerify: 0 };
    let backupFile: string | null = null;
    if (apply && plan.length) {
      backupFile = `cnic-rotation-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const fd = fs.openSync(backupFile, 'w', 0o600);
      fs.writeSync(fd, JSON.stringify({ createdAt: new Date().toISOString(), rows: plan.map((p) => ({ id: p.row.id, cnic: p.row.cnic })) }));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      console.log(`Backup written: ${backupFile}`);

      for (const { row, plain } of plan) {
        const next = cipher.encrypt(plain);
        if (cipher.decrypt(next) !== plain) throw new Error(`Round-trip check failed for ${row.id}; aborting (nothing further written)`);
        const n = await updatedRows(ds, row.id, next, row.cnic);
        if (n !== 1) {
          written.raceSkipped++;
          continue;
        }
        const [after]: { cnic: string }[] = await ds.query(`SELECT cnic FROM participations WHERE id = $1`, [row.id]);
        if (!after || cipher.tryDecrypt(after.cnic)?.value !== plain) {
          await updatedRows(ds, row.id, row.cnic, after?.cnic ?? next);
          written.restoredAfterFailedVerify++;
          throw new Error(`Post-write verification failed for ${row.id}; restored its old value and aborted`);
        }
        written.rotated++;
      }
    }

    console.log(apply ? 'APPLIED' : 'DRY RUN (nothing written — add --apply to rotate)');
    console.table({ ...stats, ...(apply ? written : {}) });
    if (undecryptable.length) {
      console.warn(`Undecryptable rows (left untouched, need manual follow-up):\n  ${undecryptable.join('\n  ')}`);
      process.exitCode = 2;
    }
    if (backupFile) console.log(`To undo: npm run rotate:cnic -- --rollback=${backupFile}`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
