import os from "node:os";
import { query } from "../../../db/mysql";

// ---------------------------------------------------------------------------
// Shapes returned to the admin dashboard (GET /api/dashboard/overview).
// Every number here is computed from real `ondemand` tables.
// ---------------------------------------------------------------------------

export interface NameValue {
  label: string;
  value: number;
}

export interface MonthlyEarning {
  ym: string;
  rides: number;
  orders: number;
  total: number;
}

export interface LatestRide {
  id: number;
  rideNo: string;
  type: string;
  status: string;
  fare: number;
  date: string | null;
}

export interface LatestOrder {
  id: number;
  orderNo: string;
  placedBy: string;
  status: string;
  netTotal: number;
  date: string | null;
}

export interface ContactRow {
  subject: string;
  name: string;
  email: string;
  date: string | null;
}

export interface PaymentRequestRow {
  id: number;
  rideNo: string;
  name: string;
  amount: number;
  currency: string;
  done: string;
  date: string | null;
}

export interface NotificationRow {
  id: number;
  userType: string;
  message: string;
  date: string | null;
}

export interface SosAlertRow {
  id: number;
  text: string;
  driverId: number;
  companyId: number;
  status: string;
  date: string | null;
}

export interface DashboardOverview {
  generatedAt: string;
  ridesJobs: {
    total: number;
    byStatus: NameValue[];
    byType: NameValue[];
    sumFare: number;
    avgFare: number;
  };
  orders: {
    total: number;
    netTotal: number;
    byPlacedBy: NameValue[];
    byStatus: NameValue[];
  };
  adminEarning: {
    tripsCommission: number;
    ordersCommission: number;
    total: number;
  };
  earningReport: {
    grossRides: number;
    grossOrders: number;
    total: number;
    months: MonthlyEarning[];
  };
  laterBookings: { total: number };
  contactUs: { total: number; latest: ContactRow[] };
  sos: { total: number; latest: SosAlertRow[] };
  paymentRequests: { count: number; amount: number; latest: PaymentRequestRow[] };
  notifications: { total: number; latest: NotificationRow[] };
  userProviderStore: { users: number; providers: number; stores: number };
  tripDetail: {
    total: number;
    finished: number;
    cancelled: number;
    sumFare: number;
    avgFare: number;
  };
  server: {
    hostname: string;
    platform: string;
    uptimeSeconds: number;
    cpuCores: number;
    cpuModel: string;
    load: number[];
    memoryUsedBytes: number;
    memoryTotalBytes: number;
  };
  latestRides: LatestRide[];
  latestOrders: LatestOrder[];
}

/** First row of a single-value aggregate, with sane defaults. */
async function first<T extends object>(sql: string, params?: unknown[]): Promise<T> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

/**
 * Aggregate every dashboard statistic in one round-trip. All heavy reads run in
 * parallel; date formatting is done in SQL so zero-dates ('0000-00-00') come
 * back as NULL instead of an invalid JS Date.
 */
export async function getDashboardOverview(): Promise<DashboardOverview> {
  const [
    ridesTotal,
    ridesByStatus,
    ridesByType,
    rideFares,
    tripsCommission,
    ordersAgg,
    orderByPlacedBy,
    orderByStatus,
    ordersCommission,
    laterBookings,
    contactTotal,
    contactLatest,
    sosTotal,
    sosLatest,
    paymentAgg,
    paymentLatest,
    notificationsTotal,
    notificationsLatest,
    usersAgg,
    monthlyRides,
    monthlyOrders,
    latestRides,
    latestOrders,
  ] = await Promise.all([
    first<{ c: number }>("SELECT COUNT(*) AS c FROM trips"),
    query<NameValue>(
      "SELECT IFNULL(iActive,'Unknown') AS label, COUNT(*) AS value FROM trips GROUP BY iActive ORDER BY value DESC",
    ),
    query<NameValue>(
      "SELECT eType AS label, COUNT(*) AS value FROM trips GROUP BY eType ORDER BY value DESC",
    ),
    first<{ sum: number; avg: number }>(
      "SELECT ROUND(COALESCE(SUM(iFare),0),2) AS sum, ROUND(COALESCE(AVG(iFare),0),2) AS avg FROM trips",
    ),
    first<{ c: number }>("SELECT ROUND(COALESCE(SUM(fCommision),0),2) AS c FROM trips"),
    first<{ c: number; net: number }>(
      "SELECT COUNT(*) AS c, ROUND(COALESCE(SUM(fNetTotal),0),2) AS net FROM orders",
    ),
    query<NameValue>(
      "SELECT eOrderplaced_by AS label, COUNT(*) AS value FROM orders GROUP BY eOrderplaced_by ORDER BY value DESC",
    ),
    query<NameValue>(
      `SELECT
         COALESCE(
           (SELECT os.vStatus FROM order_status os WHERE os.iStatusCode = o.iStatusCode LIMIT 1),
           CONCAT('code ', o.iStatusCode)
         ) AS label,
         COUNT(*) AS value
         FROM orders o
        GROUP BY o.iStatusCode
        ORDER BY value DESC`,
    ),
    first<{ c: number }>("SELECT ROUND(COALESCE(SUM(fCommision),0),2) AS c FROM orders"),
    first<{ c: number }>(
      "SELECT COUNT(*) AS c FROM published_rides WHERE eStatus = 'Active'",
    ),
    first<{ c: number }>("SELECT COUNT(*) AS c FROM contactus"),
    query<ContactRow>(
      `SELECT vSubject AS subject,
              IF(vFirstname <=> vLastname, vFirstname, CONCAT_WS(' ', vFirstname, vLastname)) AS name,
              vEmail AS email,
              DATE_FORMAT(tRequestDate, '%Y-%m-%d %H:%i') AS date
         FROM contactus ORDER BY iContactusId DESC LIMIT 5`,
    ),
    first<{ c: number }>("SELECT COUNT(*) AS c FROM admin_alerts"),
    query<SosAlertRow>(
      `SELECT iAlertId AS id, IFNULL(tAlertText,'') AS text,
              iDriverId AS driverId, iCompanyId AS companyId,
              IFNULL(eStatus,'') AS status,
              DATE_FORMAT(dDate, '%Y-%m-%d %H:%i') AS date
         FROM admin_alerts ORDER BY iAlertId DESC LIMIT 6`,
    ),
    first<{ c: number; amt: number }>(
      "SELECT COUNT(*) AS c, ROUND(COALESCE(SUM(fAmount),0),2) AS amt FROM payment_requests",
    ),
    query<PaymentRequestRow>(
      `SELECT iPaymentRequestsId AS id, vRideNo AS rideNo,
              CONCAT_WS(' ', vName, vLastName) AS name,
              fAmount AS amount, vCurrency AS currency, eMarkAsDone AS done,
              DATE_FORMAT(tRequestDate, '%Y-%m-%d %H:%i') AS date
         FROM payment_requests ORDER BY iPaymentRequestsId DESC LIMIT 5`,
    ),
    first<{ c: number }>("SELECT COUNT(*) AS c FROM pushnotification_log"),
    query<NotificationRow>(
      `SELECT iPushnotificationId AS id, eUserType AS userType,
              tMessage AS message,
              DATE_FORMAT(dDateTime, '%Y-%m-%d %H:%i') AS date
         FROM pushnotification_log ORDER BY iPushnotificationId DESC LIMIT 6`,
    ),
    first<{ users: number; providers: number; stores: number }>(
      `SELECT
         (SELECT COUNT(*) FROM register_user)  AS users,
         (SELECT COUNT(*) FROM register_driver) AS providers,
         (SELECT COUNT(*) FROM company)         AS stores`,
    ),
    query<{ ym: string; rides: number }>(
      `SELECT DATE_FORMAT(tStartDate, '%Y-%m') AS ym, ROUND(COALESCE(SUM(iFare),0),2) AS rides
         FROM trips
        WHERE tStartDate > '2000-01-01'
        GROUP BY ym`,
    ),
    query<{ ym: string; orders: number }>(
      `SELECT DATE_FORMAT(dDate, '%Y-%m') AS ym, ROUND(COALESCE(SUM(fNetTotal),0),2) AS orders
         FROM orders
        WHERE dDate > '2000-01-01'
        GROUP BY ym`,
    ),
    query<LatestRide>(
      `SELECT iTripId AS id, vRideNo AS rideNo, eType AS type,
              IFNULL(iActive,'Unknown') AS status, iFare AS fare,
              DATE_FORMAT(tStartDate, '%Y-%m-%d %H:%i') AS date
         FROM trips ORDER BY iTripId DESC LIMIT 6`,
    ),
    query<LatestOrder>(
      `SELECT o.iOrderId AS id, o.vOrderNo AS orderNo, o.eOrderplaced_by AS placedBy,
              COALESCE(
                (SELECT os.vStatus FROM order_status os WHERE os.iStatusCode = o.iStatusCode LIMIT 1),
                CONCAT('code ', o.iStatusCode)
              ) AS status,
              o.fNetTotal AS netTotal,
              DATE_FORMAT(o.dDate, '%Y-%m-%d %H:%i') AS date
         FROM orders o
        ORDER BY o.iOrderId DESC LIMIT 6`,
    ),
  ]);

  // Merge the two monthly series into a single sorted list (most recent first).
  const monthMap = new Map<string, MonthlyEarning>();
  for (const r of monthlyRides) {
    monthMap.set(r.ym, { ym: r.ym, rides: Number(r.rides), orders: 0, total: Number(r.rides) });
  }
  for (const o of monthlyOrders) {
    const entry = monthMap.get(o.ym) ?? { ym: o.ym, rides: 0, orders: 0, total: 0 };
    entry.orders = Number(o.orders);
    entry.total = Number(entry.rides) + Number(o.orders);
    monthMap.set(o.ym, entry);
  }
  const months = [...monthMap.values()].sort((a, b) => (a.ym < b.ym ? 1 : -1)).slice(0, 12);

  const totalRides = Number(ridesTotal.c);
  const free = os.freemem();
  const total = os.totalmem();

  return {
    generatedAt: new Date().toISOString(),
    ridesJobs: {
      total: totalRides,
      byStatus: ridesByStatus.map((r) => ({ label: String(r.label), value: Number(r.value) })),
      byType: ridesByType.map((r) => ({ label: String(r.label), value: Number(r.value) })),
      sumFare: Number(rideFares.sum),
      avgFare: Number(rideFares.avg),
    },
    orders: {
      total: Number(ordersAgg.c),
      netTotal: Number(ordersAgg.net),
      byPlacedBy: orderByPlacedBy.map((r) => ({ label: String(r.label), value: Number(r.value) })),
      byStatus: orderByStatus.map((r) => ({ label: String(r.label), value: Number(r.value) })),
    },
    adminEarning: {
      tripsCommission: Number(tripsCommission.c),
      ordersCommission: Number(ordersCommission.c),
      total: Number((Number(tripsCommission.c) + Number(ordersCommission.c)).toFixed(2)),
    },
    earningReport: {
      grossRides: Number(rideFares.sum),
      grossOrders: Number(ordersAgg.net),
      total: Number((Number(rideFares.sum) + Number(ordersAgg.net)).toFixed(2)),
      months,
    },
    laterBookings: { total: Number(laterBookings.c) },
    contactUs: { total: Number(contactTotal.c), latest: contactLatest },
    sos: { total: Number(sosTotal.c), latest: sosLatest },
    paymentRequests: {
      count: Number(paymentAgg.c),
      amount: Number(paymentAgg.amt),
      latest: paymentLatest,
    },
    notifications: { total: Number(notificationsTotal.c), latest: notificationsLatest },
    userProviderStore: {
      users: Number(usersAgg.users),
      providers: Number(usersAgg.providers),
      stores: Number(usersAgg.stores),
    },
    tripDetail: {
      total: totalRides,
      finished: Number(ridesByStatus.find((r) => r.label === "Finished")?.value ?? 0),
      cancelled: Number(ridesByStatus.find((r) => r.label === "Canceled")?.value ?? 0),
      sumFare: Number(rideFares.sum),
      avgFare: Number(rideFares.avg),
    },
    server: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      uptimeSeconds: os.uptime(),
      cpuCores: os.cpus().length,
      cpuModel: os.cpus()[0]?.model?.trim() ?? "Unknown",
      load: os.loadavg().map((n) => Number(n.toFixed(2))),
      memoryUsedBytes: total - free,
      memoryTotalBytes: total,
    },
    latestRides,
    latestOrders,
  };
}
