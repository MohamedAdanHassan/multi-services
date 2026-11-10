import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../../../errors/AppError";
import { resolveStoredMedia, uploadDir } from "../../../utils/media";
import type { NewsStatus } from "../models/newsModel";
import * as model from "../models/newsModel";
import * as service from "../services/newsService";
import * as audit from "../../audit/services/auditService";

/**
 * HTTP layer for Marketing Tools → News (#sub-112), the legacy `newsfeed` table.
 *
 * The sub-group's five live capabilities map one-to-one onto these handlers:
 * `view-news` reads, `create-news` inserts, `edit-news` covers the content edit
 * plus the translation batch and the picture, `update-status-news` toggles, and
 * `delete-news` soft-deletes. There is no hard-delete route: `eStatus` has a
 * 'Deleted' member, so retiring an article does not have to destroy it.
 */

/** Audit events for news management. */
export const NewsEvents = {
  Created: "news_created",
  Updated: "news_updated",
  Translated: "news_translations_updated",
  StatusChanged: "news_status_changed",
  Deleted: "news_deleted",
  ImageUploaded: "news_image_uploaded",
} as const;

async function writeAudit(req: Request, event: string) {
  if (!req.auth) return;
  audit.logQuiet(req, event, { adminId: req.auth.adminId, email: req.auth.email });
}

/** GET /api/news/list — live articles, newest first. */
export async function list(_req: Request, res: Response) {
  const news = await service.listNews();
  res.json({ news, total: news.length });
}

/** GET /api/news/:id — one article (edit-page loader). */
export async function getOne(req: Request, res: Response) {
  res.json({ news: await service.getNews(Number(req.params.id)) });
}

/** POST /api/news — create (English texts; the image attaches separately). */
export async function create(req: Request, res: Response) {
  const row = await service.createNews(
    req.body as {
      title: unknown;
      description?: unknown;
      type?: "News" | "Notification";
      audience?: "driver" | "rider" | "company" | "all";
      status?: NewsStatus;
    },
  );
  await writeAudit(req, NewsEvents.Created);
  res.status(201).json({ news: row });
}

/** PUT /api/news/:id — English texts, type and audience (other languages preserved). */
export async function update(req: Request, res: Response) {
  const row = await service.updateNews(
    Number(req.params.id),
    req.body as {
      title: unknown;
      description?: unknown;
      type?: "News" | "Notification";
      audience?: "driver" | "rider" | "company" | "all";
    },
  );
  await writeAudit(req, NewsEvents.Updated);
  res.json({ news: row });
}

/** GET /api/news/:id/translations — per-language title/description batch. */
export async function translations(req: Request, res: Response) {
  const id = Number(req.params.id);
  res.json({ id, languages: await service.getTranslations(id) });
}

/** PUT /api/news/:id/translations — merge a per-language batch. */
export async function updateTranslations(req: Request, res: Response) {
  const id = Number(req.params.id);
  const { titles, descriptions } = req.body as {
    titles?: Record<string, string>;
    descriptions?: Record<string, string>;
  };
  const row = await service.updateTranslations(id, { titles, descriptions });
  await writeAudit(req, NewsEvents.Translated);
  res.json({ news: row });
}

/** PATCH /api/news/:id/status — activate / deactivate. */
export async function setStatus(req: Request, res: Response) {
  const { status } = req.body as { status: NewsStatus };
  const row = await service.changeStatus(Number(req.params.id), status);
  await writeAudit(req, NewsEvents.StatusChanged);
  res.json({ news: row });
}

/** DELETE /api/news/:id — soft delete. */
export async function remove(req: Request, res: Response) {
  await service.deleteNews(Number(req.params.id));
  await writeAudit(req, NewsEvents.Deleted);
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Image: streamed from `<webImagesRoot>/newsfeed/` — the folder the legacy panel
// filled. Most stored rows name a file that is no longer there, so a missing
// file is an ordinary 404 the listing renders as a neutral box, not an error.
// ---------------------------------------------------------------------------

const IMAGE_DIR = "newsfeed";
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function imageContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

/** Resolve a news image on disk: upload dir first, then the legacy dir. */
function resolveImage(filename: string): string | null {
  return resolveStoredMedia(IMAGE_DIR, path.basename(filename));
}

/** GET /api/news/:id/image — stream the stored image (cookie auth). */
export async function image(req: Request, res: Response) {
  const row = await model.findNews(Number(req.params.id));
  if (!row || !row.image) throw AppError.notFound("No image on file");
  const abs = resolveImage(row.image);
  if (!abs) throw AppError.notFound("Image file missing");
  res.setHeader("Content-Type", imageContentType(abs));
  res.setHeader("Cache-Control", "private, max-age=3600");
  createReadStream(abs).pipe(res);
}

const imageStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    try {
      cb(null, uploadDir(IMAGE_DIR));
    } catch (err) {
      cb(err as Error, "");
    }
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const rand = Math.random().toString(36).slice(2, 8);
    cb(null, `${Date.now()}_${rand}${ext}`);
  },
});

const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: IMAGE_MAX_BYTES },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMAGE_EXT.has(ext) && /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(AppError.badRequest("Unsupported file type. Use JPG, PNG, WEBP or GIF."));
    }
  },
});

/** Multer single-file middleware translating upload errors into AppError. */
export function imageUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  imageUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(AppError.badRequest("File too large (max 5 MB)."));
    }
    return next(err);
  });
}

/** POST /api/news/:id/image — attach or replace the article image. */
export async function uploadImage(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!req.file) throw AppError.badRequest("No file uploaded.");
  try {
    const row = await service.attachImage(id, req.file.filename);
    await writeAudit(req, NewsEvents.ImageUploaded);
    res.json({ news: row });
  } catch (err) {
    // Don't leave an orphaned file behind when the DB write fails.
    try {
      unlinkSync(req.file.path);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

