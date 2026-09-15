import { Router } from "express";
import { authenticate } from "../middleware/auth.js";

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

export default router;
