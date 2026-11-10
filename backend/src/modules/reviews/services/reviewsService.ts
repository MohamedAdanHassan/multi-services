import * as model from "../models/reviewsModel";
import type {
  OrderReviewRow,
  OrderSubject,
  RideReviewRow,
  RideSubject,
  ReviewFilters,
  SortDir,
  SortKey,
  TabCounts,
} from "../models/reviewsModel";
import { AppError } from "../../../errors/AppError";

/**
 * Rules for Reviews (group 24). Both sub-groups read `ratings_user_driver` and
 * grant exactly three capabilities each — a list, a comment edit and a CSV
 * export — so this service has three verbs per screen and nothing else: no
 * create (reviews come from the apps), no delete and no status change (the
 * sub-groups own no such permission), and no star-rating edit (legacy never
 * wrote `vRating1` from admin). The same filtering path feeds the table and the
 * download so they can never disagree.
 */

/** vMessage is varchar(2500); the same ceiling the column itself enforces. */
export const MAX_COMMENT_LEN = 2500;

const RIDE_SUBJECTS: readonly string[] = ["Driver", "Passenger"];
const ORDER_SUBJECTS: readonly string[] = ["Company", "Driver", "Passenger"];
const SORT_KEYS: readonly string[] = ["default", "ref", "subject", "reviewer", "rating", "date", "message"];

function cleanSubject(allowed: readonly string[], raw: unknown, fallback: string): string {
  const s = String(raw ?? "").trim();
  if (!s || s.toLowerCase() === "all") return fallback;
  const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
  if (!hit) throw AppError.badRequest(`Unknown review tab: ${s}`);
  return hit;
}

function cleanStatus(raw: unknown): string {
  const s = String(raw ?? "all").trim().toLowerCase();
  if (s === "active") return "Active";
  if (s === "deleted") return "Deleted";
  return "all";
}

function cleanSort(raw: unknown): SortKey {
  const s = String(raw ?? "default").trim().toLowerCase();
  return (SORT_KEYS as readonly string[]).includes(s) ? (s as SortKey) : "default";
}

function cleanDir(raw: unknown): SortDir {
  return String(raw ?? "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";
}

function readFilters(query: Record<string, unknown>): ReviewFilters {
  return {
    status: cleanStatus(query.status),
    search: String(query.search ?? "").trim(),
    sort: cleanSort(query.sort),
    dir: cleanDir(query.dir),
  };
}

/**
 * Normalise an edited comment: fold CRLF, trim, and reject anything the column
 * cannot hold. An empty comment is allowed — clearing a review's text is a real
 * edit the legacy form accepted.
 */
export function cleanComment(raw: unknown): string {
  if (typeof raw !== "string") throw AppError.badRequest("A comment string is required.");
  const message = raw.replace(/\r\n?/g, "\n").trim();
  if (message.length > MAX_COMMENT_LEN) {
    throw AppError.badRequest(`A review comment cannot exceed ${MAX_COMMENT_LEN} characters.`);
  }
  return message;
}

export interface RideReviewList {
  subject: RideSubject;
  reviews: RideReviewRow[];
  counts: TabCounts;
}

export async function listRides(query: Record<string, unknown>): Promise<RideReviewList> {
  const subject = cleanSubject(RIDE_SUBJECTS, query.subject, "Driver") as RideSubject;
  const filters = readFilters(query);
  const [reviews, counts] = await Promise.all([
    model.listRideReviews(subject, filters),
    model.rideCounts(subject),
  ]);
  return { subject, reviews, counts };
}

export interface OrderReviewList {
  subject: OrderSubject;
  reviews: OrderReviewRow[];
  counts: TabCounts;
}

export async function listOrders(query: Record<string, unknown>): Promise<OrderReviewList> {
  const subject = cleanSubject(ORDER_SUBJECTS, query.subject, "Company") as OrderSubject;
  const filters = readFilters(query);
  const [reviews, counts] = await Promise.all([
    model.listOrderReviews(subject, filters),
    model.orderCounts(subject),
  ]);
  return { subject, reviews, counts };
}

/** The rows the download should contain: identical filtering to the table. */
export async function exportRides(query: Record<string, unknown>): Promise<RideReviewRow[]> {
  const subject = cleanSubject(RIDE_SUBJECTS, query.subject, "Driver") as RideSubject;
  return model.listRideReviews(subject, readFilters(query));
}

export async function exportOrders(query: Record<string, unknown>): Promise<OrderReviewRow[]> {
  const subject = cleanSubject(ORDER_SUBJECTS, query.subject, "Company") as OrderSubject;
  return model.listOrderReviews(subject, readFilters(query));
}

export interface EditResult {
  id: number;
  message: string;
}

/**
 * Save a comment against a review that belongs to the named screen. The screen
 * check (ride review vs order review) keeps an `edit-review` admin from writing
 * to a row only the Orders screen shows and vice-versa, so each permission edits
 * precisely its own list.
 */
async function editComment(
  idRaw: unknown,
  messageRaw: unknown,
  belongs: (id: number) => Promise<boolean>,
  label: string,
): Promise<EditResult> {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest("A valid review id is required.");
  const message = cleanComment(messageRaw);
  if (!(await belongs(id))) {
    throw AppError.notFound(`No ${label} review with id ${id}.`);
  }
  const affected = await model.updateComment(id, message);
  if (affected === 0) throw AppError.notFound(`No ${label} review with id ${id}.`);
  return { id, message };
}

export function editRideComment(id: unknown, message: unknown): Promise<EditResult> {
  return editComment(id, message, model.rideReviewExists, "ride");
}

export function editOrderComment(id: unknown, message: unknown): Promise<EditResult> {
  return editComment(id, message, model.orderReviewExists, "order");
}
