import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { env } from "../../../config/env";
import { AppError } from "../../../errors/AppError";
import * as model from "../models/dbBackupModel";
import type { BackupRow } from "../models/dbBackupModel";

/**
 * Business layer for Utility → DB Backup (#sub-133). A "create" shells out to
 * the MySQL `mysqldump` client, streams the dump into the configured backups
 * directory, and records a `backup_database` row. Downloads and deletes are
 * resolved strictly against that directory (basenames only) so a stored or
 * crafted filename can never escape it.
 */

function backupRoot(): string {
  return path.resolve(env.backup.root);
}

/** `ondemand-YYYYMMDD-HHMMSS.sql` in local time. */
function timestampFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
  return `ondemand-${stamp}.sql`;
}

/** Resolve a stored filename to an absolute path guaranteed inside the root. */
function resolveInsideRoot(file: string): string {
  const root = backupRoot();
  const abs = path.resolve(root, path.basename(file));
  if (!abs.startsWith(root + path.sep)) {
    throw AppError.badRequest("Invalid backup filename.");
  }
  return abs;
}

/** Run mysqldump to `absFile`; reject with the client's stderr on failure. */
function runDump(absFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const out = fs.createWriteStream(absFile);
    const args = [
      `--host=${env.db.host}`,
      `--port=${env.db.port}`,
      `--user=${env.db.user}`,
      "--quick",
      "--routines",
      "--triggers",
      env.db.database,
    ];
    // Password is passed via MYSQL_PWD so it never appears in the process list.
    const child = spawn(env.backup.mysqldumpPath, args, {
      env: { ...process.env, MYSQL_PWD: env.db.password },
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.pipe(out);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(err);
    });
    out.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on("close", (code) => {
      out.end(() => {
        if (settled) return;
        settled = true;
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `mysqldump exited with code ${code}`));
      });
    });
  });
}

/** List every recorded backup, newest first. */
export function listBackups(): Promise<BackupRow[]> {
  return model.listBackups();
}

/** Create a manual dump: write the file, then record and return its row. */
export async function createBackup(): Promise<BackupRow> {
  const root = backupRoot();
  fs.mkdirSync(root, { recursive: true });
  const file = timestampFilename();
  const abs = path.resolve(root, file);
  try {
    await runDump(abs);
  } catch (err) {
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* best-effort cleanup of the partial dump */
    }
    const message = err instanceof Error ? err.message : String(err);
    throw AppError.badRequest("Database backup failed.", [message]);
  }
  const id = await model.insertBackup(file, "Manual");
  const row = await model.getBackup(id);
  if (!row) throw AppError.badRequest("Backup was created but could not be recorded.");
  return row;
}

/** Absolute path + download name for a backup, or throws when unavailable. */
export async function resolveForDownload(id: number): Promise<{ absPath: string; filename: string }> {
  const row = await model.getBackup(id);
  if (!row) throw AppError.notFound("Backup not found.");
  const absPath = resolveInsideRoot(row.file);
  if (!fs.existsSync(absPath)) {
    throw AppError.notFound("The backup file is missing from disk.");
  }
  return { absPath, filename: row.file };
}

/** Delete the dump file (if present) and its row. Returns affected rows. */
export async function removeBackup(id: number): Promise<number> {
  const row = await model.getBackup(id);
  if (!row) return 0;
  try {
    const abs = resolveInsideRoot(row.file);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    /* a missing/unremovable file must not block deleting the row */
  }
  return model.deleteBackup(id);
}
