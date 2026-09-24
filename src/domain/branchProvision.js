import { roundMoney } from "./money.js";

/**
 * تجهيز الفرع من الإدارة (HqBranchProvisionForm في المرجع): هويته على
 * المستندات، وإعداداته — والقفل يجعلها «مُدارة» فلا يغيّرها مدير الفرع.
 *
 *   • profile — يُحفظ على branches.profile ويصل الفرع في bootstrap.
 *   • server  — الضريبة ويوم العمل والاعتمادات: تُكتب في branch_settings
 *               نفسه، فيفرضها الخادم على كل بيعٍ وقيد كما هي.
 *   • local   — هوامش العيارات ومن يفحص الكسر: إعداداتُ واجهة تُطبَّق عند الدخول.
 */
const PROFILE_KEYS = ["storeName", "legalName", "crNumber", "vatNumber", "phone", "email", "city", "managerName", "address", "website"];
const KARATS = ["24", "22", "21", "18", "14"];
const LOGO_MAX = 300_000; // data:URL مصغَّر — لا صورٌ كاملة في كل bootstrap

function cleanProfile(p) {
  const out = {};
  for (const k of PROFILE_KEYS) {
    const v = String(p?.[k] ?? "").trim().slice(0, 200);
    if (v) out[k] = v;
  }
  const logo = p?.logoDataUrl;
  if (logo) {
    if (typeof logo !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(logo) || logo.length > LOGO_MAX) return { error: "invalid_logo" };
    out.logoDataUrl = logo;
  }
  return { profile: out };
}

function cleanSettings(s = {}) {
  const server = {};
  if (s.taxEnabled != null) server.taxEnabled = !!s.taxEnabled;
  if (s.taxRate != null) {
    const n = Number(s.taxRate);
    if (!(n >= 0) || n > 1) return { error: "invalid_tax_rate" };
    server.taxRate = n;
  }
  if (s.workdayMode != null) {
    if (!["required", "off"].includes(s.workdayMode)) return { error: "invalid_workday_mode" };
    server.workdayMode = s.workdayMode;
  }
  if (s.approvalsEnabled != null) server.approvalsEnabled = !!s.approvalsEnabled;
  if (s.approvalThresholds != null) {
    const t = {};
    for (const k of ["expense", "refund", "supplier_settle"]) {
      if (s.approvalThresholds[k] == null || s.approvalThresholds[k] === "") continue;
      const n = Number(s.approvalThresholds[k]);
      if (!Number.isFinite(n) || n < 0) return { error: "invalid_thresholds", kind: k };
      t[k] = roundMoney(n);
    }
    server.approvalThresholds = t;
  }
  const local = {};
  if (s.marginByKarat != null) {
    const m = {};
    for (const k of KARATS) {
      const e = s.marginByKarat[k];
      if (!e) continue;
      const perGram = Number(e.perGram) || 0, fixed = Number(e.fixed) || 0;
      if (perGram < 0 || fixed < 0) return { error: "invalid_margin", karat: k };
      m[k] = { perGram: roundMoney(perGram), fixed: roundMoney(fixed) };
    }
    local.marginByKarat = m;
  }
  if (s.scrapAssayMode != null) {
    if (!["hq", "branch"].includes(s.scrapAssayMode)) return { error: "invalid_scrap_assay_mode" };
    local.scrapAssayMode = s.scrapAssayMode;
  }
  return { server, local };
}

/** كل ما جُهِّز للفرع — للإدارة (تحرير) وللفرع (bootstrap). */
async function loadProvision(client, branchId) {
  const { rows } = await client.query(
    `select b.name, b.ref, b.profile, b.provision, b.settings_locked, b.provisioned_at, b.provisioned_by,
            s.tax_enabled, s.tax_rate, s.workday_mode, s.approvals_enabled, s.approval_thresholds
       from branches b left join branch_settings s on s.branch_id = b.id where b.id = $1`,
    [branchId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    branch: { name: r.name, ref: r.ref },
    profile: r.profile || {},
    settings: {
      taxEnabled: r.tax_enabled ?? true,
      taxRate: r.tax_rate != null ? Number(r.tax_rate) : 0.15,
      workdayMode: r.workday_mode || "required",
      approvalsEnabled: r.approvals_enabled !== false,
      approvalThresholds: r.approval_thresholds || {},
      ...(r.provision || {}),
    },
    local: r.provision || {},
    locked: !!r.settings_locked,
    at: r.provisioned_at || null,
    by: r.provisioned_by || null,
  };
}

/** يحفظ التجهيز — داخل withBranch(branchId). */
async function saveProvision(client, branchId, { profile, settings, locked, actorName }) {
  const p = cleanProfile(profile || {});
  if (p.error) return p;
  const s = cleanSettings(settings || {});
  if (s.error) return s;
  const { rows: cur } = await client.query("select * from branch_settings where branch_id = $1", [branchId]);
  const c = cur[0] || {};
  const sv = s.server;
  await client.query(
    `insert into branch_settings (branch_id, tax_enabled, tax_rate, workday_mode, approvals_enabled, approval_thresholds)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (branch_id) do update set
       tax_enabled = excluded.tax_enabled, tax_rate = excluded.tax_rate, workday_mode = excluded.workday_mode,
       approvals_enabled = excluded.approvals_enabled, approval_thresholds = excluded.approval_thresholds`,
    [
      branchId,
      sv.taxEnabled ?? c.tax_enabled ?? true,
      sv.taxRate ?? c.tax_rate ?? 0.15,
      sv.workdayMode ?? c.workday_mode ?? "required",
      sv.approvalsEnabled ?? (c.approvals_enabled !== false),
      JSON.stringify(sv.approvalThresholds ?? c.approval_thresholds ?? {}),
    ]
  );
  await client.query(
    `update branches set profile = $2, provision = $3, settings_locked = $4, provisioned_at = now(), provisioned_by = $5 where id = $1`,
    [branchId, JSON.stringify(p.profile), JSON.stringify(s.local), !!locked, actorName || null]
  );
  await client.query(
    `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
     values ($1,'update',null,'branch_provision',null,$2)`,
    [branchId, JSON.stringify({ by: actorName, byKind: "store", locked: !!locked, server: sv, local: s.local, profileKeys: Object.keys(p.profile) })]
  );
  return { provision: await loadProvision(client, branchId) };
}

/** هل يمسّ هذا الطلب إعداداتٍ تديرها الإدارة؟ — للرفض في مسارات إعدادات الفرع. */
async function provisionLocked(client, branchId) {
  const { rows } = await client.query("select settings_locked, provisioned_by from branches where id = $1", [branchId]);
  return rows[0]?.settings_locked ? { by: rows[0].provisioned_by || "الإدارة" } : null;
}

export { PROFILE_KEYS, loadProvision, saveProvision, provisionLocked };
