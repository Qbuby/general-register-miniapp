import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, any>;

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });
  const instance = new DatabaseSync(config.databaseFile);
  instance.exec('PRAGMA journal_mode = WAL');
  instance.exec('PRAGMA foreign_keys = ON');
  // Concurrent writers in a single-process server are rare, but tests hammer
  // the capacity guard from several async callers.
  instance.exec('PRAGMA busy_timeout = 5000');
  instance.exec('PRAGMA synchronous = NORMAL');
  migrate(instance);
  db = instance;
  return instance;
}

export function migrate(instance: DatabaseSync): string[] {
  instance.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
  const applied = new Set(
    (instance.prepare('SELECT name FROM _migrations').all() as Row[]).map((r) => r.name as string),
  );
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const executed: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    instance.exec('BEGIN');
    try {
      instance.exec(sql);
      instance
        .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
      instance.exec('COMMIT');
      executed.push(file);
    } catch (error) {
      instance.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  return executed;
}

/**
 * Runs `fn` inside a write transaction. BEGIN IMMEDIATE takes the database
 * write lock up front, which is what makes the seat-count check-then-insert
 * safe against concurrent submissions (mirrors SELECT ... FOR UPDATE on the
 * project row under Postgres).
 */
export function tx<T>(fn: () => T): T {
  const instance = getDb();
  instance.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    instance.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      instance.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

export function all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: SqlValue[]): { changes: number } {
  return getDb().prepare(sql).run(...params) as unknown as { changes: number };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** SQLite reports constraint failures with these fragments. */
export function isUniqueViolation(error: unknown): boolean {
  const message = (error as Error)?.message ?? '';
  return message.includes('UNIQUE constraint failed') || message.includes('SQLITE_CONSTRAINT_UNIQUE');
}
