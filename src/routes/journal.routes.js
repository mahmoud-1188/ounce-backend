import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage } from "../middleware/auth.js";

const router = Router();

/**
 * القراءة الحقيقية لدفتر اليومية — تسدّ فجوة معمارية حقيقية لا نظرية.
 *
 * ⚠ الفجوة: كل عملية (بيع، شراء، مصروف، كسر...) تكتب فعليًا قيدًا متوازنًا
 * في journal_entries/journal_lines عبر postJournalEntry (انظر domain/journal.js
 * ومشغّل check_journal_balance في schema.sql — إنفاذ حقيقي على مستوى القاعدة،
 * لا افتراض). لكن GET /api/bootstrap لا يُرجع هذا الجدول إطلاقًا، فشاشات
 * الأستاذ العام/ميزان المراجعة/القوائم المالية المنقولة من مرجع العميل كانت
 * تعمل فعليًا على مصفوفة `journal` محلية في localStorage (window.storage) —
 * منفصلة تمامًا عن القيود الحقيقية التي يكتبها هذا الباك إند. هذا الملف هو
 * الإصلاح: قراءة حقيقية من نفس الجدول الذي يُكتب إليه فعلًا.
 *
 * ⚠ لا يوجد أي مسار كتابة هنا عمدًا (لا POST /journal): كل قيد يُكتب فقط
 * كأثر جانبي لعمليته الحقيقية (بيع، مصروف...) عبر مسارها الخاص، أبدًا
 * مباشرة. "الترحيل بأثر رجعي" (ميزة موجودة في مرجع العميل لتعويض قيود لم
 * تُكتب في تطبيق محلي بحت) لا معنى له هنا: كل عملية تمر عبر postJournalEntry
 * ذاتيًا وقت حدوثها، ولا يوجد مسار كتابة نقدية بلا قيد مرافق أصلًا.
 */
router.use("/journal", authenticate, requirePage("journal"));

/**
 * GET /api/journal?limit=500
 *
 * يُعيد القيود بترتيب الأحدث أولًا، بنفس الشكل الذي تتوقعه شاشات الأستاذ
 * العام/اليومية/ميزان المراجعة المنقولة (id، ref مُشتق، date، opType، label
 * من posting_rules، lines بصيغة {account, debit, credit} بدل {side, amount}
 * المطابقة لبنية القاعدة، note، createdBy، isReversal/reversed المُشتقّان من
 * reversed_of لا عمودين منفصلين).
 */
router.get("/journal", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);

    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: entries } = await client.query(
        `select e.id, e.op_type, e.ref_table, e.ref_id, e.description,
                e.created_by, e.created_at, e.reversed_of,
                u.name as created_by_name,
                coalesce(pr.label, e.op_type) as label
           from journal_entries e
           left join users u on u.id = e.created_by
           left join posting_rules pr on pr.op_type = e.op_type
          where e.branch_id = $1
          order by e.created_at desc
          limit $2`,
        [req.auth.branchId, limit]
      );
      if (!entries.length) return { entries: [], lines: [] };

      const ids = entries.map((e) => e.id);
      const { rows: lines } = await client.query(
        `select entry_id, account_code, side, amount
           from journal_lines
          where entry_id = any($1)
          order by entry_id`,
        [ids]
      );

      // ⚠ "رُحِّل هذا القيد" (reversed) يُشتقّ من وجود قيدٍ آخر يشير إليه
      // بـreversed_of — لا عمود منفصل في الجدول، فلا داعي لتخزينه مكرّرًا.
      const reversedIds = new Set(entries.filter((e) => e.reversed_of).map((e) => e.reversed_of));

      return { entries, lines, reversedIds };
    });

    if (!result.entries.length) return res.json({ entries: [] });

    const linesByEntry = new Map();
    for (const l of result.lines) {
      if (!linesByEntry.has(l.entry_id)) linesByEntry.set(l.entry_id, []);
      linesByEntry.get(l.entry_id).push({
        account: l.account_code,
        debit: l.side === "debit" ? Number(l.amount) : 0,
        credit: l.side === "credit" ? Number(l.amount) : 0,
      });
    }

    const out = result.entries.map((e) => ({
      id: e.id,
      ref: e.id.slice(0, 8).toUpperCase(),
      date: e.created_at,
      opType: e.op_type,
      label: e.label,
      lines: linesByEntry.get(e.id) || [],
      note: e.description || "",
      createdBy: e.created_by_name || "",
      posted: true,
      isReversal: !!e.reversed_of,
      reversalOf: e.reversed_of || null,
      reversed: result.reversedIds.has(e.id),
      refTable: e.ref_table || null,
      refId: e.ref_id || null,
    }));

    res.json({ entries: out });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/journal/gold-ledger?limit=500
 *
 * نفس الفجوة بالضبط لكن لدفتر الوزن (gold_ledger_entries) بدل النقد —
 * buildGoldByKaratLedger.js في الفرونت إند يتوقّع صفًّا واحدًا لكل حركة على
 * حساب واحد (accountCode/type: in|out)، بينما القاعدة تُسجّل التحويل بين
 * حسابين في صفٍّ واحد (from_account → to_account). نُوسّع كل صفٍّ من القاعدة
 * إلى صفّين منطقيّين حين يحمل الحسابين معًا (خروج من from، دخول في to)، أو
 * صفٍّ واحد حين يحمل طرفًا واحدًا فقط (كما يسمح قيد gold_ledger_has_side).
 */
router.get("/journal/gold-ledger", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);

    const rows = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `select g.id, g.op_type, g.karat, g.weight, g.fine_weight,
                g.from_account, g.to_account, g.ref_table, g.ref_id, g.note,
                g.created_at, u.name as created_by_name
           from gold_ledger_entries g
           left join users u on u.id = g.created_by
          where g.branch_id = $1
          order by g.created_at desc
          limit $2`,
        [req.auth.branchId, limit]
      );
      return rows;
    });

    const out = [];
    for (const r of rows) {
      const base = {
        id: r.id, at: r.created_at, ref: r.id.slice(0, 8).toUpperCase(),
        opType: r.op_type, karat: Number(r.karat), weight: Number(r.weight),
        note: r.note || "", createdBy: r.created_by_name || "",
      };
      if (r.from_account) out.push({ ...base, accountCode: r.from_account, type: "out" });
      if (r.to_account) out.push({ ...base, accountCode: r.to_account, type: "in" });
    }

    res.json({ entries: out });
  } catch (err) {
    next(err);
  }
});

export default router;
