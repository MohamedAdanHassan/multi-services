import type { Request, Response } from "express";
import type { GiftCardStatus } from "../models/giftCardsModel";
import * as service from "../services/giftCardsService";
import type { CardInput } from "../services/giftCardsService";
import * as audit from "../../audit/services/auditService";

/**
 * HTTP layer for Marketing Tools → Manage Gift Cards (#sub-111), the cards half.
 * Reads and writes go through the service; this file only maps request fields,
 * applies the listing filters and audits the mutations.
 *
 * There is no export route: the sub-group grants view / create / edit /
 * delete / update-status for cards and the same five for images, and nothing
 * else — so the panel offers exactly those capabilities.
 */

/** Audit events for gift cards. */
export const GiftCardEvents = {
  Created: "gift_card_created",
  Updated: "gift_card_updated",
  StatusChanged: "gift_card_status_changed",
  Deleted: "gift_card_deleted",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** Pull the write fields out of a request body. */
function readInput(body: Record<string, unknown>): CardInput {
  return {
    code: body.code,
    amount: body.amount,
    audience: body.audience,
    memberId: body.memberId,
    receiverId: body.receiverId,
    receiverDetails: body.receiverDetails,
    description: body.description,
    imageId: body.imageId,
  };
}

/** Listing filters, already cleaned by the query schema on the route. */
function readFilters(query: Record<string, unknown>): service.CardFilters {
  return {
    status: String(query.status ?? "all"),
    redeemed: String(query.redeemed ?? "all"),
    search: String(query.search ?? ""),
  };
}

/** GET /api/gift-cards/list — every card, newest first, filtered. */
export async function list(req: Request, res: Response) {
  const all = await service.listCards();
  const cards = service.filterCards(all, readFilters(req.query as Record<string, unknown>));
  res.json({ cards, total: cards.length, issued: all.length });
}

/** GET /api/gift-cards/options — artwork designs for the form's select. */
export async function options(req: Request, res: Response) {
  const imageId = Number((req.query as Record<string, unknown>).imageId ?? 0);
  res.json(await service.getCardOptions(Number.isInteger(imageId) && imageId > 0 ? imageId : 0));
}

/** GET /api/gift-cards/:id — one card (edit-page loader). */
export async function getOne(req: Request, res: Response) {
  res.json({ card: await service.getCard(Number(req.params.id)) });
}

/** POST /api/gift-cards — issue a card. */
export async function create(req: Request, res: Response) {
  const body = req.body as Record<string, unknown>;
  const status = (body.status as GiftCardStatus) ?? "Active";
  const card = await service.createCard(readInput(body), status, req.auth?.adminId ?? 0);
  await writeAudit(req, GiftCardEvents.Created);
  res.status(201).json({ card });
}

/** PUT /api/gift-cards/:id — edit (status and redemption have their own paths). */
export async function update(req: Request, res: Response) {
  const card = await service.updateCard(
    Number(req.params.id),
    readInput(req.body as Record<string, unknown>),
  );
  await writeAudit(req, GiftCardEvents.Updated);
  res.json({ card });
}

/** PATCH /api/gift-cards/:id/status — activate / deactivate. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: GiftCardStatus };
  const card = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, GiftCardEvents.StatusChanged);
  res.json({ card });
}

/** DELETE /api/gift-cards/:id — soft delete (`eStatus` = 'Deleted'). */
export async function remove(req: Request, res: Response) {
  const id = Number(req.params.id);
  await service.deleteCard(id);
  await writeAudit(req, GiftCardEvents.Deleted);
  res.json({ ok: true });
}

