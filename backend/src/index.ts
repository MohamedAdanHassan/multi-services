import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import compression from "compression";

import { env } from "./config/env";
import { pingDatabase, closePool } from "./db/mysql";
import { migrate } from "./db/migrate";
import { healthRouter } from "./routes/health";
import { authRouter } from "./routes/auth.routes";
import { adminRouter } from "./routes/admin.routes";
import { adminGroupRouter } from "./routes/admin-group.routes";
import { userRouter } from "./routes/user.routes";
import { companyRouter } from "./routes/company.routes";
import { hotelRouter } from "./routes/hotel.routes";
import { storeRouter } from "./routes/store.routes";
import { driverRouter } from "./routes/driver.routes";
import { driverVehicleRouter } from "./routes/driverVehicle.routes";
import { driverRewardRouter } from "./routes/driverReward.routes";
import { documentRouter } from "./routes/document.routes";
import { geoRouter } from "./routes/geo.routes";
import { settingsRouter } from "./routes/settings.routes";
import { currencyRouter } from "./routes/currency.routes";
import { languageRouter } from "./routes/language.routes";
import { seoRouter } from "./routes/seo.routes";
import { vehicleMakeRouter } from "./routes/vehicleMake.routes";
import { vehicleModelRouter } from "./routes/vehicleModel.routes";
import { donationRouter } from "./routes/donation.routes";
import { serviceContentRouter } from "./routes/serviceContent.routes";
import { genieServiceContentRouter } from "./routes/genieServiceContent.routes";
import { serviceCategoryRouter } from "./routes/serviceCategory.routes";
import { masterServiceCategoryRouter } from "./routes/masterServiceCategory.routes";
import { subServiceCategoryRouter } from "./routes/subServiceCategory.routes";
import { vehicleTypeRouter } from "./routes/vehicleType.routes";
import { deliveryChargeRouter } from "./routes/deliveryCharge.routes";
import { distanceChargeRouter } from "./routes/distanceCharge.routes";
import { packageTypeRouter } from "./routes/packageType.routes";
import { bannerRouter } from "./routes/banner.routes";
import { tripReasonRouter } from "./routes/tripReason.routes";
import { rideProfileRouter } from "./routes/rideProfile.routes";
import { organizationRouter } from "./routes/organization.routes";
import { adBannerRouter } from "./routes/adBanners.routes";
import { promoCodeRouter } from "./routes/promoCodes.routes";
import { referralSettingsRouter } from "./routes/referralSettings.routes";
import { giftCardRouter } from "./routes/giftCards.routes";
import { giftCardImageRouter } from "./routes/giftCardImages.routes";
import { newsRouter } from "./routes/news.routes";
import { newsletterRouter } from "./routes/newsletter.routes";
import { pushRouter } from "./routes/push.routes";
import { reviewsRouter } from "./routes/reviews.routes";
import { supportRequestsRouter } from "./routes/supportRequests.routes";
import { reportsRouter } from "./routes/reports.routes";
import { mapsApiRouter } from "./routes/mapsApi.routes";
import { dbBackupRouter } from "./routes/dbBackup.routes";
import { permissionRouter } from "./routes/permission.routes";
import { dashboardRouter } from "./routes/dashboard.routes";
import { standardLimiter } from "./middleware/rateLimit";
import { requireCsrf } from "./middleware/csrf";
import { cachePolicy } from "./middleware/cachePolicy";
import { requestMetrics, getMetricsSummary } from "./middleware/requestMetrics";
import { requireAuth } from "./middleware/auth";
import { notFound, errorHandler } from "./middleware/errorHandler";

const app = express();

// Honour X-Forwarded-* only when deployed behind a trusted proxy.
app.set("trust proxy", env.trustProxy ? 1 : false);
app.disable("x-powered-by");
// Strong ETags on generated bodies: with `private, no-cache` this makes repeat
// GETs cost a free 304 instead of a full payload.
app.set("etag", "strong");

// Latency accounting for every response; first so it brackets the full stack.
app.use(requestMetrics);

// Security headers. CSP is tuned for an API; the admin SPA sets its own CSP.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
  }),
);

// CORS: allowlist origins, permit credentials (needed for httpOnly cookies).
app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser clients (no Origin header) and allowlisted origins.
      if (!origin || env.cors.origins.includes(origin)) return cb(null, true);
      return cb(new Error("Origin not allowed by CORS"));
    },
    credentials: env.cors.credentials,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  }),
);

app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

// Payload compression: gzip, and brotli when the client advertises `br`.
// Bodies under 1KB cost more to compress than to ship.
app.use(compression({ threshold: 1024 }));

// Global rate limit, then CSRF defense for cookie-authenticated mutations,
// then the tiered cache headers (mutations no-store, reference GETs public,
// everything else private + ETag revalidation).
app.use(standardLimiter);
app.use(requireCsrf);
app.use(cachePolicy);

// In-process latency summary (p50/p95/p99 per route); admin-authenticated.
app.get("/api/metrics", requireAuth(), (_req, res) => {
  res.json(getMetricsSummary());
});

// Routes.
app.use("/health", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/admins", adminRouter);
app.use("/api/admin-groups", adminGroupRouter);
app.use("/api/users", userRouter);
app.use("/api/company", companyRouter);
app.use("/api/hotel", hotelRouter);
app.use("/api/store", storeRouter);
app.use("/api/drivers", driverRouter);
app.use("/api/driver-vehicles", driverVehicleRouter);
app.use("/api/driver-rewards", driverRewardRouter);
app.use("/api/documents", documentRouter);
app.use("/api/geo", geoRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/currencies", currencyRouter);
app.use("/api/languages", languageRouter);
app.use("/api/seo", seoRouter);
app.use("/api/vehicle-makes", vehicleMakeRouter);
app.use("/api/vehicle-models", vehicleModelRouter);
app.use("/api/donations", donationRouter);
app.use("/api/service-content", serviceContentRouter);
app.use("/api/genie-service-content", genieServiceContentRouter);
app.use("/api/service-category", serviceCategoryRouter);
app.use("/api/master-service-category", masterServiceCategoryRouter);
app.use("/api/sub-service-category", subServiceCategoryRouter);
app.use("/api/vehicle-type", vehicleTypeRouter);
app.use("/api/delivery-charge", deliveryChargeRouter);
app.use("/api/distance-charge", distanceChargeRouter);
app.use("/api/package-type", packageTypeRouter);
app.use("/api/banner", bannerRouter);
app.use("/api/advertise-banners", adBannerRouter);
app.use("/api/promocodes", promoCodeRouter);
app.use("/api/referral-settings", referralSettingsRouter);
app.use("/api/gift-cards", giftCardRouter);
app.use("/api/gift-card-images", giftCardImageRouter);
app.use("/api/news", newsRouter);
app.use("/api/newsletter", newsletterRouter);
app.use("/api/push-notifications", pushRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/support-requests", supportRequestsRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/maps-api", mapsApiRouter);
app.use("/api/db-backups", dbBackupRouter);
app.use("/api/permissions", permissionRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/trip-reason", tripReasonRouter);
app.use("/api/ride-profile", rideProfileRouter);
app.use("/api/organization", organizationRouter);

app.use(notFound);
app.use(errorHandler);

function createServer() {
  if (env.tls.enabled && env.tls.keyPath && env.tls.certPath) {
    const options = {
      key: fs.readFileSync(env.tls.keyPath),
      cert: fs.readFileSync(env.tls.certPath),
    };
    return https.createServer(options, app);
  }
  return http.createServer(app);
}

async function main() {
  await pingDatabase(); // fail fast if MySQL is unreachable
  await migrate(); // ensure additive side-tables exist (idempotent)

  const server = createServer();
  server.listen(env.port, () => {
    const scheme = env.tls.enabled ? "https" : "http";
    console.log(`Backend listening on ${scheme}://localhost:${env.port}`);
    console.log(`Connected to MySQL database "${env.db.database}" (${env.nodeEnv})`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => shutdown(sig));
  }
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

export { app };
