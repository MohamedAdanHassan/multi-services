// Ad-hoc DB probe for the Delivery Genie Banners screen (#sub-142).
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

const [sgCols] = await c.query(`SHOW COLUMNS FROM admin_pro_permission_display_sub_groups`);
show("sub-group columns", sgCols.map((x) => x.Field));

const [sg] = await c.query(
  `SELECT * FROM admin_pro_permission_display_sub_groups WHERE id IN (141,142,143)`,
);
show("sub groups 141-143", sg);

const [types] = await c.query(
  `SELECT eType, COUNT(*) rows_, COUNT(DISTINCT iUniqueId) groups_ FROM banners GROUP BY eType ORDER BY rows_ DESC`,
);
show("banners by eType", types);

const [cols] = await c.query(`SHOW COLUMNS FROM banners`);
show(
  "banners columns",
  cols.map((x) => ({ F: x.Field, T: x.Type, N: x.Null, D: x.Default, E: x.Extra })),
);

await c.end();
