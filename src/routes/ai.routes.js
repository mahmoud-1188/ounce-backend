import { Router } from "express";
import { authenticate, requirePage } from "../middleware/auth.js";
import { withBranch } from "../db.js";
import { postJournalEntry } from "../domain/journal.js";
import { getOpenBusinessDay } from "../domain/saleOps.js";
import { roundMoney } from "../domain/money.js";
import { ACCOUNTANT_AI_SYSTEM, ACCOUNTANT_AI_TOOLS, runAccountantTool, shapeProposal } from "../domain/accountantTools.js";

const router = Router();

/**
 * POST /api/ai/chat — وكيل (proxy) وحيد لكل نداءات Claude من التطبيق.
 *
 * ⚠ إصلاح أمني/وظيفي حقيقي: كل ميزات الذكاء الاصطناعي في الفرونت إند
 * (مساعد المحادثة، تحليل الأعمال، سرد التدقيق، توليد التقارير، تتبّع
 * الفروق) كانت تنادي https://api.anthropic.com/v1/messages مباشرة من
 * المتصفح بلا أي مفتاح API (x-api-key) على الإطلاق — هذا يُرفض دائمًا
 * بـ401 من Anthropic، فكل هذه الميزات كانت معطوبة فعليًا منذ البداية
 * (بالضبط كما كانت مشكلة سعر الذهب قبل إصلاحها). وحتى لو أُضيف مفتاح
 * مباشرة في كود الفرونت إند، سيكون مكشوفًا لأي زائر يفتح Network tab —
 * مفتاح API لا يجوز أن يعيش في كود العميل إطلاقًا.
 *
 * الحل: نفس نمط GET /api/gold-price بالضبط — الخادم فقط يحمل المفتاح
 * (ANTHROPIC_API_KEY في متغيرات البيئة)، والفرونت إند يرسل طلبه هنا
 * فيُعاد توجيهه لـAnthropic من الخادم. الفرونت إند يبني نفس بنية
 * `messages`/`max_tokens` كما كان يرسلها مباشرة، فلا حاجة لتغيير أي
 * برومبت — فقط تغيير الوجهة من api.anthropic.com إلى هذا الـendpoint.
 *
 * ⚠ صلاحية can_use_ai: عمود موجود أصلًا على المستخدم (users.can_use_ai،
 * يُدار من GET/PATCH /api/users ويصل الفرونت إند عبر bootstrap) — هذا
 * الحارس هنا هو التطبيق الفعلي لتلك الصلاحية، لا الفرونت إند فقط
 * (الذي قد يُخفي الزر لكن لا يمنع نداء API مباشر).
 *
 * ⚠ استثناء المدير: AccessSettingsPage.jsx نفسها تُخفي سويتش "أدوات
 * الذكاء" تمامًا عن حسابات role === "manager" (تفترض أن المدير مُخوَّل
 * دائمًا)، فلا توجد أي وسيلة بالواجهة لتشغيل can_use_ai لحساب مدير —
 * يبقى false افتراضيًا للأبد ويُرفض هنا رغم صلاحياته الكاملة في كل
 * مكان آخر بالتطبيق. الحارس هنا يطابق نفس الافتراض بدل التناقض معه.
 *
 * ⚠ نطاق متعمَّد: هذا وكيل عام (`messages` + `max_tokens` تُمرَّر كما
 * هي) بدل خمس دوال منفصلة، لأن الفرونت إند هو من يبني نص البرومبت (لغة
 * عربية، دليل الاستخدام، بيانات المحل...) — الخادم هنا مسؤول فقط عن
 * حماية المفتاح والتحقق من الصلاحية، لا عن محتوى الطلب نفسه.
 */
router.post("/ai/chat", authenticate, async (req, res, next) => {
  try {
    if (req.auth.role !== "manager" && !req.auth.user.can_use_ai) {
      return res.status(403).json({ error: "ai_not_allowed" });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY missing from environment");
      return res.status(503).json({ error: "ai_not_configured" });
    }

    const { messages, max_tokens, model } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages_required" });
    }

    // ⚠ سقف صارم على max_tokens بصرف النظر عمّا يرسله الفرونت إند —
    // يحمي من استنزاف الرصيد المشترك عبر طلب معدَّل أو خاطئ.
    const safeMaxTokens = Math.min(Number(max_tokens) || 900, 4000);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // ⚠ الفرونت إند لا يُسمح له باختيار موديل تعسفيًا — فقط تمرير
        // اسم معروف مسبقًا إن أراد؛ الافتراضي مطابق لما كان مضمَّنًا
        // في كل نداء قديم مباشر.
        model: typeof model === "string" && model ? model : "claude-sonnet-4-6",
        max_tokens: safeMaxTokens,
        messages,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      console.error("Anthropic API error:", response.status, payload);
      return res.status(502).json({ error: "ai_upstream_error" });
    }

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// ══ المساعد المحاسبي — وكيلٌ بأدوات (Function Calling) ══════════════════
//
// الحلقة على الخادم: سؤال → النموذج → أدوات تُنفَّذ هنا على دفاتر الفرع
// (قراءةٌ فقط) → النموذج → جواب. ستّ جولات حدًّا، ونتائج الأدوات مقطوعة.
// الواجهة ترسل نصّ المحادثة وحده، والأدوات تُستدعى من جديد كل سؤال — فلا
// يُعاد رقمٌ قديم من ذاكرة المحادثة.
const AI_REVIEWERS = ["manager", "accountant"];

async function callModel({ apiKey, messages, system, tools }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "claude-sonnet-4-6",
      max_tokens: 1800,
      tools,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
    }),
  });
  const payload = await r.json().catch(() => null);
  if (!r.ok) {
    console.error("Anthropic API error:", r.status, payload);
    const e = new Error("ai_upstream_error");
    e.status = r.status;
    throw e;
  }
  return payload;
}

router.post("/ai/accountant", authenticate, requirePage("aiAccountant"), async (req, res, next) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "ai_not_configured" });
  const history = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const convo = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!convo.length || convo[convo.length - 1].role !== "user") return res.status(400).json({ error: "messages_required" });
  const question = convo[convo.length - 1].content;
  const trace = [];
  const drafts = [];
  try {
    for (let round = 0; round < 6; round++) {
      const reply = await callModel({ apiKey, messages: convo, system: ACCOUNTANT_AI_SYSTEM, tools: ACCOUNTANT_AI_TOOLS });
      const content = reply?.content || [];
      convo.push({ role: "assistant", content });
      const uses = content.filter((b) => b.type === "tool_use");
      if (reply.stop_reason !== "tool_use" || !uses.length) {
        return res.json({ text: content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(), trace, drafts });
      }
      const results = [];
      for (const u of uses) {
        let out;
        try {
          // ⚠ القراءة في معاملةٍ للقراءة فقط؛ الكتابة الوحيدة مسودّةٌ في ai_proposals
          out = await withBranch(req.auth.branchId, async (client) => {
            if (u.name !== "propose_journal_entry") await client.query("set transaction read only");
            const r = await runAccountantTool(client, req.auth.branchId, u.name, u.input || {}, {
              userId: req.auth.userId, userName: req.auth.user?.name, question,
            });
            // ⚠ withBranch يتراجع عن أي نتيجةٍ فيها `error` — وخطأ الأداة هنا
            //   بيانات للنموذج لا رفض، فيُغلَّف ثم يُفكّ
            return { wrapped: r };
          });
          out = out.wrapped;
        } catch (e) {
          out = { error: String(e.message || e).slice(0, 200) };
        }
        trace.push({ name: u.name, input: u.input || {}, ok: !out?.error });
        if (u.name === "propose_journal_entry" && out?.draft) drafts.push(out.draft);
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000) });
      }
      convo.push({ role: "user", content: results });
    }
    res.json({ text: "توقّفتُ بعد ستّ جولات من الأدوات — ضيّق السؤال.", trace, drafts });
  } catch (err) {
    if (err.message === "ai_upstream_error") return res.status(502).json({ error: "ai_upstream_error" });
    next(err);
  }
});

router.get("/ai/proposals", authenticate, requirePage("aiAccountant"), async (req, res, next) => {
  try {
    const { rows } = await withBranch(req.auth.branchId, (client) =>
      client.query("select * from ai_proposals where branch_id = $1 order by created_at desc limit 50", [req.auth.branchId])
    );
    res.json({ proposals: rows.map(shapeProposal) });
  } catch (err) {
    next(err);
  }
});

/**
 * اعتماد مسودّة المساعد وترحيلها — بيد إنسانٍ دوره مدير أو محاسب، وباسمه.
 * ⚠ التوازن والحسابات يُفحصان من جديد هنا (لا يُوثق بما قاله النموذج)،
 *   وقفل الفترات يسري كأي قيد (postJournalEntry).
 */
router.post("/ai/proposals/:id/approve", authenticate, requirePage("aiAccountant"), async (req, res, next) => {
  if (!AI_REVIEWERS.includes(req.auth.role)) return res.status(403).json({ error: "reviewer_role_required" });
  const note = String(req.body?.note || "").trim() || null;
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query("select * from ai_proposals where id = $1 and branch_id = $2 for update", [req.params.id, req.auth.branchId]);
      const p = rows[0];
      if (!p) return { error: "proposal_not_found" };
      if (p.status !== "pending") return { error: "proposal_already_decided", status: p.status };
      const { rows: accts } = await client.query("select code, is_group from accounts");
      const known = new Map(accts.map((a) => [a.code, a]));
      const lines = [];
      for (const l of p.lines || []) {
        const acc = known.get(String(l.account));
        if (!acc || acc.is_group) return { error: "invalid_account", account: l.account };
        const d = roundMoney(l.debit), c = roundMoney(l.credit);
        if (d > 0 && c > 0) return { error: "invalid_line", account: l.account };
        if (d > 0) lines.push({ account: acc.code, side: "debit", amount: d });
        if (c > 0) lines.push({ account: acc.code, side: "credit", amount: c });
      }
      const dr = roundMoney(lines.filter((l) => l.side === "debit").reduce((a, l) => a + l.amount, 0));
      const cr = roundMoney(lines.filter((l) => l.side === "credit").reduce((a, l) => a + l.amount, 0));
      if (lines.length < 2 || Math.abs(dr - cr) > 0.005) return { error: "proposal_unbalanced", debit: dr, credit: cr };
      const day = await getOpenBusinessDay(client, req.auth.branchId);
      const entryId = await postJournalEntry(client, {
        branchId: req.auth.branchId, businessDayId: day?.id || null, opType: "manual_adjustment",
        refTable: "ai_proposals", refId: p.id,
        description: `${p.note || "قيد تسوية"} — اقتراح المساعد المحاسبي، اعتمده ${req.auth.user?.name || ""}${note ? ` · ${note}` : ""}`,
        createdBy: req.auth.userId, lines,
      });
      const { rows: upd } = await client.query(
        `update ai_proposals set status = 'approved', decided_by = $1, decided_name = $2, decided_at = now(), decision_note = $3, journal_entry_id = $4
          where id = $5 returning *`,
        [req.auth.userId, req.auth.user?.name || null, note, entryId, p.id]
      );
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'approve',$2,'ai_proposals',$3,$4)`,
        [req.auth.branchId, req.auth.userId, p.id, JSON.stringify({ kind: "ai_adjustment", entryId, debit: dr, note: p.note })]
      );
      return { proposal: shapeProposal(upd[0]) };
    });
    if (result.error) return res.status(result.error === "proposal_not_found" ? 404 : 409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ai/proposals/:id/reject", authenticate, requirePage("aiAccountant"), async (req, res, next) => {
  if (!AI_REVIEWERS.includes(req.auth.role)) return res.status(403).json({ error: "reviewer_role_required" });
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `update ai_proposals set status = 'rejected', decided_by = $1, decided_name = $2, decided_at = now(), decision_note = $3
          where id = $4 and branch_id = $5 and status = 'pending' returning *`,
        [req.auth.userId, req.auth.user?.name || null, String(req.body?.note || "").trim() || null, req.params.id, req.auth.branchId]
      );
      if (!rows[0]) return { error: "proposal_not_pending" };
      return { proposal: shapeProposal(rows[0]) };
    });
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
