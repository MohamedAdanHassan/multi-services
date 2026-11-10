import { Router } from "express";
import { query, pingDatabase } from "../db/mysql";
import { env } from "../config/env";

export const healthRouter = Router();

/** Lightweight liveness check (no DB access). */
healthRouter.get("/", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

/** Deep health check: verifies the MySQL connection is live. */
healthRouter.get("/db", async (_req, res) => {
  try {
    await pingDatabase();
    const [countRow] = await query<{ tables: number }>(
      "SELECT COUNT(*) AS tables FROM information_schema.tables WHERE table_schema = ?",
      [env.db.database],
    );
    const [versionRow] = await query<{ version: string }>("SELECT VERSION() AS version");
    res.json({
      status: "ok",
      database: env.db.database,
      mysqlVersion: versionRow.version,
      tables: countRow.tables,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(503).json({ status: "error", message });
  }
});
