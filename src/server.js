import express from "express";
import helmet from "helmet";
import cors from "cors";
import "dotenv/config";

import authRoutes from "./routes/auth.routes.js";
import usersRoutes from "./routes/users.routes.js";
import salesRoutes from "./routes/sales.routes.js";
import purchasesRoutes from "./routes/purchases.routes.js";
import scrapRoutes from "./routes/scrap.routes.js";
import safeRoutes from "./routes/safe.routes.js";
import inventoryRoutes from "./routes/inventory.routes.js";
import dayRoutes from "./routes/day.routes.js";
import settingsRoutes from "./routes/settings.routes.js";
import expensesRoutes from "./routes/expenses.routes.js";
import taskirRoutes from "./routes/taskir.routes.js";
import miscRoutes from "./routes/misc.routes.js";
import bootstrapRoutes from "./routes/bootstrap.routes.js";
import rfidRoutes from "./routes/rfid.routes.js";
import fixedAssetsRoutes from "./routes/fixed-assets.routes.js";
import payrollRoutes from "./routes/payroll.routes.js";
import hqRoutes from "./routes/hq.routes.js";
import priceFixRoutes from "./routes/price-fix.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import journalRoutes from "./routes/journal.routes.js";
import storeAuthRoutes from "./routes/storeAuth.routes.js";
import storeRoutes from "./routes/store.routes.js";
import hqTransactionsRoutes from "./routes/hqTransactions.routes.js";
import itemsRoutes from "./routes/items.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import platformRoutes from "./routes/platform.routes.js";
import openingRoutes from "./routes/opening.routes.js";

const app = express();

// ⚠ الإنتاج: CORS_ORIGIN من متغيرات البيئة يحصر الطلبات على دومين
// الفرونت إند الفعلي فقط (أو أكثر من دومين مفصول بفواصل). بلا هذا
// المتغير (كما في التطوير محليًا) يُسمح لأي origin — مقبول محليًا فقط.
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
  : null;

app.use(helmet());
app.use(
  cors(
    allowedOrigins
      ? {
          origin: (origin, callback) => {
            // بلا origin (curl، health checks) يُسمح دائمًا.
            if (!origin || allowedOrigins.includes(origin)) callback(null, true);
            else callback(new Error("not_allowed_by_cors"));
          },
        }
      : {}
  )
);
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api", authRoutes);
app.use("/api", usersRoutes);
app.use("/api", salesRoutes);
app.use("/api", purchasesRoutes);
app.use("/api", scrapRoutes);
app.use("/api", safeRoutes);
app.use("/api", inventoryRoutes);
app.use("/api", dayRoutes);
app.use("/api", settingsRoutes);
app.use("/api", expensesRoutes);
app.use("/api", taskirRoutes);
app.use("/api", miscRoutes);
app.use("/api", bootstrapRoutes);
app.use("/api", rfidRoutes);
app.use("/api", fixedAssetsRoutes);
app.use("/api", payrollRoutes);
app.use("/api", hqRoutes);
app.use("/api", priceFixRoutes);
app.use("/api", aiRoutes);
app.use("/api", journalRoutes);
app.use("/api", storeAuthRoutes);
app.use("/api", storeRoutes);
app.use("/api", hqTransactionsRoutes);
app.use("/api", itemsRoutes);
app.use("/api", categoriesRoutes);
app.use("/api", openingRoutes);
app.use("/api", platformRoutes);

// Centralized error handler — keeps internal error details out of the
// response (they go to the server log instead), matching the "never leak
// stack traces to the client" default for a production API.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: "internal_error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`ounce-backend listening on :${port}`);
});
