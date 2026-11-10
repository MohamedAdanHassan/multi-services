// What does the Genie slice of `banners` actually look like? (#sub-142)
import { config } from "dotenv";
config({ path: "/home/ataa/mohamed/multiservice/backend/.env" });
import mysql from "mysql2/promise";

const c = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const show = (label, rows) => {
  console.log(`--- ${label} ---`);
  for (const r of rows) console.log(JSON.stringify(r));
};

show(
  "genie rows",
  await c
    .query(
      `SELECT iFaqcategoryId id, iUniqueId uid, vCode, vTitle, vImage, eStatus, iDisplayOrder,
              iServiceId, iLocationid, vStatusBarColor, eBuyAnyService, eFor,
              iVehicleCategoryId, iMasterServiceCategoryId
         FROM banners WHERE eType='Genie' ORDER BY iUniqueId, vCode LIMIT 30`,
    )
    .then((r) => r[0]),
);

show(
  "genie group summary",
  await c
    .query(
      `SELECT iUniqueId, COUNT(*) n, COUNT(DISTINCT vCode) codes, MIN(iDisplayOrder) ord,
              COUNT(DISTINCT vImage) imgs, COUNT(DISTINCT eStatus) st
         FROM banners WHERE eType='Genie' GROUP BY iUniqueId`,
    )
    .then((r) => r[0]),
);

show(
  "runner rows (the #sub-143 twin)",
  await c
    .query(
      `SELECT iFaqcategoryId id, iUniqueId uid, vCode, vTitle, vImage, eStatus, iDisplayOrder,
              iServiceId, iLocationid, vStatusBarColor, eBuyAnyService, eFor,
              iVehicleCategoryId, iMasterServiceCategoryId
         FROM banners WHERE eType='Runner'`,
    )
    .then((r) => r[0]),
);

show(
  "deliver rows for comparison (#sub-140)",
  await c
    .query(
      `SELECT iUniqueId uid, COUNT(*) n, MIN(vTitle) t, MIN(vImage) img, MIN(eStatus) st,
              MIN(iServiceId) svc, MIN(iLocationid) loc, MIN(vStatusBarColor) sbc,
              MIN(eBuyAnyService) bas, MIN(eFor) fo, MIN(iVehicleCategoryId) vc,
              MIN(iMasterServiceCategoryId) msc
         FROM banners WHERE eType='Deliver' GROUP BY iUniqueId`,
    )
    .then((r) => r[0]),
);

show(
  "distinct vCode count overall",
  await c.query(`SELECT COUNT(DISTINCT vCode) codes FROM banners`).then((r) => r[0]),
);

await c.end();
