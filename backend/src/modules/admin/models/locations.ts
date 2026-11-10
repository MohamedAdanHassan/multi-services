import { query, execute, withTransaction } from "../../../db/mysql";
import type { RowDataPacket } from "mysql2/promise";

/** Location-based access control via the legacy `admin_locations` table. */

export async function locationIdsForAdmin(adminId: number): Promise<number[]> {
  const rows = await query<{ location_id: number }>(
    "SELECT location_id FROM admin_locations WHERE admin_id = ?",
    [adminId],
  );
  return rows.map((r) => r.location_id);
}

export async function hasLocationAccess(adminId: number, locationId: number): Promise<boolean> {
  const rows = await query<{ c: number }>(
    "SELECT COUNT(*) AS c FROM admin_locations WHERE admin_id = ? AND location_id = ?",
    [adminId, locationId],
  );
  return (rows[0]?.c ?? 0) > 0;
}

/** Replace an admin's assigned locations. */
export async function assignLocations(adminId: number, locationIds: number[]): Promise<void> {
  const unique = [...new Set(locationIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
  await withTransaction(async (conn) => {
    await conn.execute("DELETE FROM admin_locations WHERE admin_id = ?", [adminId]);
    if (unique.length === 0) return;
    const [maxRows] = await conn.query<RowDataPacket[]>(
      "SELECT COALESCE(MAX(id), 0) AS max FROM admin_locations",
    );
    let nextId = Number((maxRows[0] as { max: number }).max ?? 0);
    for (const locId of unique) {
      nextId += 1;
      await conn.execute(
        "INSERT INTO admin_locations (id, admin_id, location_id) VALUES (?, ?, ?)",
        [nextId, adminId, locId],
      );
    }
  });
}
