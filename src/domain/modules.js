/**
 * الوحدات الاختيارية (migration 050 — المرجع: MODULES · modOn · moduleOptions).
 * كل وحدةٍ مطفأةٌ افتراضًا، ولها إعداداتٌ افتراضية تُدمج مع ما حفظه المدير.
 */
const MODULES = {
  discountLimit: { label: "حدّ الخصم", cfg: { maxPct: { employee: 3, assistant: 7, accountant: 0 } } },
  reorderAlerts: { label: "حدود إعادة الطلب", cfg: { mins: {} } },
  branchTransfer: { label: "التحويل بين الفروع", cfg: {} },
  giftCards: { label: "بطاقات الهدايا", cfg: {} },
  loyalty: { label: "نقاط الولاء", cfg: { sarPerPoint: 100, pointValue: 1 } },
  zatca: { label: "رمز QR الضريبي على الفاتورة", cfg: {} },
  thermalReceipt: { label: "إيصال حراري 80مم", cfg: {} },
  bilingualInvoice: { label: "فاتورة بلغتين", cfg: {} },
  customOrders: { label: "الطلبات الخاصة والتصنيع", cfg: {} },
  purchaseOrders: { label: "أوامر الشراء", cfg: {} },
  aml: { label: "مكافحة غسل الأموال — هوية العميل", cfg: { cashThreshold: 50000 } },
  gemstones: { label: "الألماس والأحجار الكريمة", cfg: {} },
  watches: { label: "الساعات", cfg: { warrantyMonths: 24 } },
};

function sanitizeModules(input = {}) {
  const out = {};
  for (const [id, def] of Object.entries(MODULES)) {
    const v = input[id];
    if (!v) continue;
    const cfg = { ...def.cfg, ...(v.cfg && typeof v.cfg === "object" ? v.cfg : {}) };
    if (id === "discountLimit") {
      const m = {};
      for (const r of ["employee", "assistant", "accountant"]) {
        const n = Number(cfg.maxPct?.[r]);
        m[r] = Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n * 10) / 10)) : 0;
      }
      cfg.maxPct = m;
    }
    if (id === "reorderAlerts") {
      const mins = {};
      for (const [k, n] of Object.entries(cfg.mins || {})) {
        const q = Math.max(0, Math.round(Number(n) || 0));
        if (q > 0 && /^[\w-]+:(24|22|21|18|14)$/.test(k)) mins[k] = q;
      }
      cfg.mins = mins;
    }
    if (id === "aml") cfg.cashThreshold = Math.max(0, Number(cfg.cashThreshold) || 0);
    if (id === "loyalty") {
      cfg.sarPerPoint = Math.max(1, Number(cfg.sarPerPoint) || 100);
      cfg.pointValue = Math.max(0, Number(cfg.pointValue) || 0);
    }
    out[id] = { on: !!v.on, cfg };
  }
  return out;
}

async function loadModules(client, branchId) {
  const { rows } = await client.query("select modules from branch_settings where branch_id = $1", [branchId]);
  return sanitizeModules(rows[0]?.modules || {});
}

const modOn = (mods, id) => !!mods?.[id]?.on;
const modCfg = (mods, id) => ({ ...(MODULES[id]?.cfg || {}), ...(mods?.[id]?.cfg || {}) });

export { MODULES, sanitizeModules, loadModules, modOn, modCfg };
