import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { env } from "../config/env";

let pool: Pool | undefined;

/** Lazily-created, shared MySQL connection pool. */
export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database: env.db.database,
      waitForConnections: true,
      connectionLimit: env.db.connectionLimit,
      // Bound the wait queue instead of growing it without end (fail fast).
      queueLimit: 200,
      namedPlaceholders: true,
      // The DB can be remote/on-demand: TCP keep-alives stop MySQL from
      // dropping pooled connections between admin request bursts.
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      connectTimeout: 20_000,
    });
  }
  return pool;
}

/** Run a parameterized query and return the resulting rows. */
export async function query<T = unknown>(
  sql: string,
  params?: unknown[] | object,
): Promise<T[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(sql, params as never);
  return rows as unknown as T[];
}

/** Run a parameterized statement and return the result header (insertId, affectedRows...). */
export async function execute(
  sql: string,
  params?: unknown[] | object,
): Promise<ResultSetHeader> {
  const [result] = await getPool().execute<ResultSetHeader>(sql, params as never);
  return result;
}

/** Run a set of statements inside a single transaction. */
export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Get a dedicated connection from the pool (caller must release it). */
export async function getConnection(): Promise<PoolConnection> {
  return getPool().getConnection();
}

/** Verify connectivity by running a trivial query. */
export async function pingDatabase(): Promise<void> {
  await query("SELECT 1 + 1 AS result");
}

/** Close the pool (used on graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
