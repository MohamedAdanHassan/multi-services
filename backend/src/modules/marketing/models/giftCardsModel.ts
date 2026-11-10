import { execute, getConnection, query } from "../../../db/mysql";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

/**
 * Data access for the legacy `gift_cards` table (Marketing Tools → Manage Gift
 * Cards, #sub-111). Everything below was read off the live schema; the table
 * this dataset ships with is EMPTY (0 rows), so the column semantics are taken
 * from the DDL and from how the sibling legacy tables behave.
 *
 * Legacy quirks that shape this module:
 *  - MyISAM/utf8mb3 with `iGiftCardId int NOT NULL` and **no index of any kind**
 *    — no primary key, no unique key on `vGiftCardCode`. Ids are allocated with
 *    MAX+1, code uniqueness is a service-layer concern, and every write filters
 *    by id with `LIMIT 1` so a legacy duplicate cannot turn one edit into many.
 *  - `eStatus` HAS a 'Deleted' member and `delete-giftcard` is an Active
 *    permission, so deletes here are soft (like `coupon`, unlike
 *    `advertise_banners`). A soft-deleted row keeps its id and its code, which
 *    is why the code lookup includes deleted rows: reviving a retired code would
 *    re-attach the redemption history to a new card.
 *  - All 18 columns are NOT NULL and none has a column default (except
 *    `eRedeemed` 'No'), so the INSERT has to list every one of them under
 *    STRICT_TRANS_TABLES.
 *  - `dRedeemedDate` is `datetime NOT NULL`, and an unredeemed card has no
 *    redemption moment — the legacy zero datetime is what the apps leave there.
 *    The server runs with NO_ZERO_DATE, so writes go through `withZeroDates`.
 *  - Two id columns describe the recipient pair (`iMemberId` → register_user,
 *    `eReceiverId` → register_driver, note the `e` prefix on an int) plus
 *    `eUserType` (''/Anyone/UserSpecific/DriverSpecific) as the audience rule
 *    and `eReceiverUserType` (Passenger/Driver) as the account kind. Neither id
 *    is a real FK, so existence is validated in the service.
 *  - `iPaymentId`/`ePaymentOption`/`eRedeemed`/`dRedeemedDate` and
 *    `iCreatedById`/`eCreatedBy`/`dAddedDate` are owned by the apps and the
 *    audit trail. The admin panel reads them and never edits them; `Cash` is
 *    written on create only because `ePaymentOption` has no "not paid" member.
 */

export type GiftCardStatus = "Active" | "Inactive";
/** `eUserType` as the form offers it: '' is the legacy unset state, never written. */
export type GiftCardAudience = "Anyone" | "UserSpecific" | "DriverSpecific";
export type ReceiverKind = "Passenger" | "Driver";
/** The card's own status column also carries 'Deleted' for the soft-delete path. */
export type GiftCardStatusCode = GiftCardStatus | "Deleted";

/** The zero datetime an unredeemed card keeps in `dRedeemedDate`. */
export const NO_DATETIME = "0000-00-00 00:00:00";

export interface GiftCardRow {
  id: number; // iGiftCardId
  code: string; // vGiftCardCode
  amount: number; // fAmount
  status: GiftCardStatusCode; // eStatus
  addedDate: string; // dAddedDate (YYYY-MM-DD HH:mm, '' for the zero datetime)
  createdById: number; // iCreatedById
  createdBy: string; // eCreatedBy (Admin | User | Driver)
  receiverDetails: string; // tReceiverDetails (free-form contact memo)
  description: string; // tDescription (message printed on the card)
  imageId: number; // iGiftCardImageId (0 = no artwork)
  imageName: string; // resolved vImage of that row
  imageCode: string; // resolved vCode of that row (which language's row it is)
  audience: GiftCardAudience; // eUserType
  memberId: number; // iMemberId → register_user
  memberName: string; // resolved rider label
  receiverId: number; // eReceiverId → register_driver
  receiverName: string; // resolved driver label
  receiverKind: ReceiverKind; // eReceiverUserType
  paymentId: number; // iPaymentId (app-owned)
  paymentOption: string; // ePaymentOption (app-owned)
  redeemed: boolean; // eRedeemed ('Yes' | 'No')
  redeemedDate: string; // dRedeemedDate ('' when never redeemed)
}

/** Columns projected for a card. Dates are formatted in SQL so zero-datetime
 *  values survive as text instead of making the mysql2 parser throw. */
const SELECT_COLUMNS = `gift_cards.iGiftCardId, gift_cards.vGiftCardCode, gift_cards.fAmount,
  gift_cards.eStatus, gift_cards.iCreatedById, gift_cards.eCreatedBy, gift_cards.tReceiverDetails,
  gift_cards.tDescription, gift_cards.iGiftCardImageId, gift_cards.iPaymentId,
  gift_cards.ePaymentOption, gift_cards.eRedeemed, gift_cards.eUserType, gift_cards.iMemberId,
  gift_cards.eReceiverId, gift_cards.eReceiverUserType,
  DATE_FORMAT(gift_cards.dAddedDate, '%Y-%m-%d %H:%i') AS addedDate,
  DATE_FORMAT(gift_cards.dRedeemedDate, '%Y-%m-%d %H:%i') AS redeemedDate,
  (SELECT gci.vImage FROM gift_card_images gci
     WHERE gci.iGiftCardImageId = gift_cards.iGiftCardImageId LIMIT 1) AS imageName,
  (SELECT gci.vCode FROM gift_card_images gci
     WHERE gci.iGiftCardImageId = gift_cards.iGiftCardImageId LIMIT 1) AS imageCode,
  (SELECT TRIM(CONCAT_WS(' ', u.vName, u.vLastName)) FROM register_user u
     WHERE u.iUserId = gift_cards.iMemberId LIMIT 1) AS memberName,
  (SELECT TRIM(CONCAT_WS(' ', d.vName, d.vLastName)) FROM register_driver d
     WHERE d.iDriverId = gift_cards.eReceiverId LIMIT 1) AS receiverName`;

/** Legacy zero datetimes format to "0000-00-00 00:00" — blank it, never Date it. */
function cleanDateTime(value: unknown): string {
  const v = value == null ? "" : String(value);
  return v.startsWith("0000") ? "" : v;
}

function mapRow(r: Record<string, string | number | null>): GiftCardRow {
  const audience = String(r.eUserType ?? "").trim();
  return {
    id: Number(r.iGiftCardId),
    code: String(r.vGiftCardCode ?? "").trim(),
    amount: Number(r.fAmount ?? 0),
    status: (String(r.eStatus ?? "Active") as GiftCardStatusCode),
    addedDate: cleanDateTime(r.addedDate),
    createdById: Number(r.iCreatedById ?? 0),
    createdBy: String(r.eCreatedBy ?? "").trim(),
    receiverDetails: String(r.tReceiverDetails ?? ""),
    description: String(r.tDescription ?? ""),
    imageId: Number(r.iGiftCardImageId ?? 0),
    imageName: String(r.imageName ?? "").trim(),
    imageCode: String(r.imageCode ?? "").trim(),
    audience: audience === "UserSpecific" || audience === "DriverSpecific" ? audience : "Anyone",
    memberId: Number(r.iMemberId ?? 0),
    memberName: String(r.memberName ?? "").trim(),
    receiverId: Number(r.eReceiverId ?? 0),
    receiverName: String(r.receiverName ?? "").trim(),
    receiverKind: String(r.eReceiverUserType ?? "") === "Driver" ? "Driver" : "Passenger",
    paymentId: Number(r.iPaymentId ?? 0),
    paymentOption: String(r.ePaymentOption ?? "").trim(),
    redeemed: String(r.eRedeemed ?? "No") === "Yes",
    redeemedDate: cleanDateTime(r.redeemedDate),
  };
}

/** Every card the admin can act on (soft-deleted rows are hidden). */
export async function listCards(): Promise<GiftCardRow[]> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM gift_cards
      WHERE gift_cards.eStatus <> 'Deleted'
      ORDER BY gift_cards.iGiftCardId DESC`,
  );
  return rows.map(mapRow);
}

/** One usable card, or null when the id is unknown or deleted. */
export async function findCard(id: number): Promise<GiftCardRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM gift_cards
      WHERE gift_cards.iGiftCardId = ? AND gift_cards.eStatus <> 'Deleted' LIMIT 1`,
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/**
 * Case-insensitive lookup of a code, INCLUDING soft-deleted rows: the collation
 * is utf8mb3_general_ci, so 'free50' and 'FREE50' collide the same way the apps
 * would treat them at redemption.
 */
export async function findCardByCode(code: string): Promise<GiftCardRow | null> {
  const rows = await query<Record<string, string | number | null>>(
    `SELECT ${SELECT_COLUMNS} FROM gift_cards WHERE gift_cards.vGiftCardCode = ? LIMIT 1`,
    [code],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Next free id. Soft deletes leave rows in place, so MAX+1 is never reused. */
export async function nextCardId(): Promise<number> {
  const rows = await query<{ nid: number | null }>(
    "SELECT COALESCE(MAX(iGiftCardId), 0) + 1 AS nid FROM gift_cards",
  );
  return Number(rows[0]?.nid ?? 1);
}

/**
 * What the panel writes. `added` carries the audit/payment placeholders the
 * create path needs, because the table has no column defaults to lean on.
 */
export interface GiftCardWrite {
  code: string;
  amount: number;
  audience: GiftCardAudience;
  memberId: number;
  receiverId: number;
  receiverKind: ReceiverKind;
  receiverDetails: string;
  description: string;
  imageId: number;
}

export interface GiftCardCreateAudit {
  status: GiftCardStatus;
  createdById: number;
}

/**
 * Explicit INSERT listing every column. Redemption/payment columns get the
 * neutral values the apps overwrite later; `dRedeemedDate` is the legacy zero
 * datetime, which needs the relaxed session (see `withZeroDates` in
 * promoCodesModel — the same reason, copied here rather than shared because it
 * is private to that module).
 *
 * The VALUES list mixes placeholders with SQL literals (NOW(), 'Admin', 'Cash',
 * 'No'), so the parameter array below has ONE value per `?` in column order —
 * 14 of them — and a mismatch is a mysql2 "Incorrect arguments to
 * COM_STMT_EXECUTE" 500 rather than a type error.
 */
export async function createCard(
  id: number,
  d: GiftCardWrite,
  audit: GiftCardCreateAudit,
): Promise<void> {
  await withZeroDates(async (conn) => {
    await conn.execute(
      `INSERT INTO gift_cards
         (iGiftCardId, vGiftCardCode, fAmount, eStatus, dAddedDate, iCreatedById, eCreatedBy,
          tReceiverDetails, iGiftCardImageId, iPaymentId, ePaymentOption, eRedeemed,
          dRedeemedDate, eReceiverUserType, iMemberId, eUserType, tDescription, eReceiverId)
       VALUES (?, ?, ?, ?, NOW(), ?, 'Admin', ?, ?, ?, 'Cash', 'No', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        d.code,
        d.amount,
        audit.status,
        audit.createdById,
        d.receiverDetails,
        d.imageId,
        0,
        NO_DATETIME,
        d.receiverKind,
        d.memberId,
        d.audience,
        d.description,
        d.receiverId,
      ],
    );
  });
}

/**
 * Edit path — status is owned by PATCH /status, the redemption and payment
 * columns are app-owned and `dAddedDate`/`iCreatedById` never change.
 */
export async function updateCard(id: number, d: GiftCardWrite): Promise<void> {
  await withZeroDates(async (conn) => {
    await conn.execute(
      `UPDATE gift_cards
          SET vGiftCardCode = ?, fAmount = ?, tReceiverDetails = ?, iGiftCardImageId = ?,
              eReceiverUserType = ?, iMemberId = ?, eUserType = ?, tDescription = ?,
              eReceiverId = ?
        WHERE iGiftCardId = ?
        LIMIT 1`,
      [
        d.code,
        d.amount,
        d.receiverDetails,
        d.imageId,
        d.receiverKind,
        d.memberId,
        d.audience,
        d.description,
        d.receiverId,
        id,
      ],
    );
  });
}

export async function setCardStatus(id: number, status: GiftCardStatus): Promise<void> {
  await execute("UPDATE gift_cards SET eStatus = ? WHERE iGiftCardId = ? LIMIT 1", [status, id]);
}

/** Soft delete — `eStatus` has a 'Deleted' member, so the row stays for history. */
export async function deleteCard(id: number): Promise<void> {
  await execute("UPDATE gift_cards SET eStatus = 'Deleted' WHERE iGiftCardId = ? LIMIT 1", [id]);
}

// ---------------------------------------------------------------------------
// Existence checks for the FK-less recipient / artwork ids.
// ---------------------------------------------------------------------------

/** Rider label, or null when the id is not a member of `register_user`. */
export async function findMember(id: number): Promise<{ name: string } | null> {
  const rows = await query<{ name: string | null }>(
    `SELECT TRIM(CONCAT_WS(' ', vName, vLastName)) AS name
       FROM register_user WHERE iUserId = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  return { name: String(rows[0].name ?? "").trim() };
}

/** Driver label, or null when the id is not a member of `register_driver`. */
export async function findDriver(id: number): Promise<{ name: string } | null> {
  const rows = await query<{ name: string | null }>(
    `SELECT TRIM(CONCAT_WS(' ', vName, vLastName)) AS name
       FROM register_driver WHERE iDriverId = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  return { name: String(rows[0].name ?? "").trim() };
}

/**
 * Does this artwork row exist and is it not retired? Cards may reference a
 * design, and a reference to a soft-deleted image would render a broken
 * thumbnail, so the create/edit path only accepts Active/Inactive rows.
 */
export async function findImageRow(id: number): Promise<{ status: string } | null> {
  const rows = await query<{ eStatus: string }>(
    "SELECT eStatus FROM gift_card_images WHERE iGiftCardImageId = ? LIMIT 1",
    [id],
  );
  if (!rows.length) return null;
  return { status: String(rows[0].eStatus ?? "") };
}

/**
 * Run a write on a dedicated connection with the session sql_mode relaxed, so
 * the legacy zero datetime can be stored. The connection's own previous value
 * is captured and restored before it returns to the pool — the pool is shared
 * with every other module.
 */
async function withZeroDates<T>(
  run: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await getConnection();
  let previous: string | null = null;
  try {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT @@SESSION.sql_mode AS m");
    const raw = (rows[0] as { m: string | null } | undefined)?.m;
    previous = typeof raw === "string" ? raw : null;
    await conn.query("SET SESSION sql_mode = ''");
    return await run(conn);
  } finally {
    if (previous !== null) {
      try {
        await conn.query("SET SESSION sql_mode = ?", [previous]);
      } catch {
        /* a connection that cannot be restored is released anyway */
      }
    }
    conn.release();
  }
}
