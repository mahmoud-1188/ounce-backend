import { Router } from "express";
import { withoutBranch } from "../db.js";
import { authenticateStore } from "../middleware/storeAuth.js";
import { buildConsolidatedReport } from "../domain/consolidatedReport.js";
import { aiConfig, aiMessages } from "../domain/aiProvider.js";

const router = Router();

/**
 * POST /api/store/ai/chat — مساعد الإدارة (المرجع 2026-10-12 ز: «يفهم البرنامجين صوتًا وكتابة»).
 *
 * نظير /api/ai/chat للفرع، لكن لمستخدم الإدارة: يُجيب عن أسئلة الفروع مجتمعةً من أرقامها
 * الفعلية. الخادم يبني السياق بنفسه (التقرير المجمّع لهذا الشهر والشهر الماضي لكل فرع)
 * ويرسله مع المحادثة — الواجهة ترسل نصّ المحادثة وحده، فلا يصل النموذج رقمٌ لم يقرأه الخادم.
 * قراءةٌ فقط: لا أدوات كتابة ولا SQL من النموذج.
 *
 * الصلاحية: المالك دائمًا، والموظف المركزي إن كانت «assistant» من شاشاته (أو بلا قيد شاشات).
 */
router.use("/store/ai", authenticateStore);

const canUseAssistant = (a) => a.role === "owner" || a.allowedPages == null || (Array.isArray(a.allowedPages) && a.allowedPages.includes("assistant"));

const ym = (d) => d.toISOString().slice(0, 7);

async function hqContext(storeId) {
  return withoutBranch(async (client) => {
    const { rows: branches } = await client.query(
      "select id, ref, name, is_hq from branches where store_id = $1 and deleted_at is null order by name", [storeId]);
    if (!branches.length) return { branches: [] };
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const [cur, last] = await Promise.all([
      buildConsolidatedReport(client, branches, `${ym(now)}-01`),
      buildConsolidatedReport(client, branches, `${ym(prev)}-01`),
    ]);
    return { branches: branches.map((b) => ({ ref: b.ref, name: b.name, isHq: !!b.is_hq })), thisMonth: { period: ym(now), ...cur }, lastMonth: { period: ym(prev), ...last } };
  });
}

const SYSTEM = [
  "أنت «أونصة» — مساعد الإدارة المركزية لمتجر ذهب له فروع. تجيب بالعربية بإيجاز ووضوح لشخصٍ ليس محاسبًا.",
  "أجب من الأرقام المرفقة وحدها (التقرير المجمّع لكل فرع لهذا الشهر والماضي). لا تخترع رقمًا؛ إن لم يكن في البيانات فقل ذلك واذكر أين يجده في التطبيق.",
  "الربح في الذهب بالوزن، والريال مبلغٌ لا ربح. اذكر اسم الفرع مع كل رقم، وقارن بالشهر الماضي حين يفيد.",
  "لا تنفّذ عمليات ولا تعد بتنفيذها — أنت تقرأ وتشرح فقط.",
].join("\n");

router.post("/store/ai/chat", async (req, res, next) => {
  try {
    if (!canUseAssistant(req.storeAuth)) return res.status(403).json({ error: "ai_not_allowed" });
    const cfg = aiConfig();
    if (!cfg.apiKey) return res.status(503).json({ error: "ai_not_configured" });

    // نصٌّ فقط، آخر ١٢ رسالة، وكل رسالةٍ بحدّ — لا صور ولا أدوات ولا أدوارٌ أخرى
    const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const messages = raw
      .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!messages.length || messages[messages.length - 1].role !== "user") return res.status(400).json({ error: "messages_required" });

    const ctx = await hqContext(req.storeAuth.storeId);
    const { ok, status, payload } = await aiMessages(cfg, {
      model: cfg.chatModel,
      max_tokens: 1200,
      system: `${SYSTEM}\n\nالبيانات (JSON):\n${JSON.stringify(ctx).slice(0, 60000)}`,
      messages,
    });
    if (!ok) {
      console.error(`HQ AI error (${cfg.provider}):`, status, payload);
      return res.status(502).json({ error: "ai_upstream_error" });
    }
    const text = (payload?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ text: text || "لم يصل ردّ — أعد صياغة السؤال." });
  } catch (err) {
    next(err);
  }
});

export default router;
