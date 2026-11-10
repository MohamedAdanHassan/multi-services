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

const [perms] = await c.query(
  `SELECT id, permission_name, name, display_group_id g, display_sub_group_id sg, display_order ord
     FROM admin_pro_permissions
    WHERE display_group_id = 33 AND display_sub_group_id IN (141, 142)
    ORDER BY display_sub_group_id, display_order`,
);
show("perms group 33 / sub 141+142", perms);

const [sg] = await c.query(
  `SELECT id, name, display_group_id g FROM admin_pro_permission_display_sub_groups WHERE id IN (141,142,143)`,
);
show("sub groups", sg);

const [types] = await c.query(
  `SELECT eType, COUNT(*) rows_, COUNT(DISTINCT iUniqueId) groups_ FROM banners GROUP BY eType ORDER BY rows_ DESC`,
);
show("banners by eType", types);

const [cols] = await c.query(`SHOW COLUMNS FROM banners`);
show(
  "banners columns",
  cols.map((x) => ({ Field: x.Field, Type: x.Type, Null: x.Null, Default: x.Default })),
);

await c.end();
