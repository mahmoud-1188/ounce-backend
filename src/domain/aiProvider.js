/**
 * مزوّد الذكاء الصناعي — من متغيّرات البيئة وحدها، لا مفتاح في الكود.
 *
 * الترتيب (المرجع 2026-10-12 ح «تفعيل Anthropic بمفتاحها وحده»):
 *   ١) AI_PROVIDER إن ضُبط يثبّت المزوّد ويغلب المفاتيح (التراجع: AI_PROVIDER=deepseek بلا حذف مفتاح Anthropic)
 *   ٢) وإلا ANTHROPIC_API_KEY موجودٌ ⇒ Anthropic
 *   ٣) وإلا DEEPSEEK_API_KEY موجودٌ ⇒ DeepSeek (واجهةٌ بصيغة Anthropic على https://api.deepseek.com/anthropic —
 *      الأدوات مدعومة، و cache_control وترويسة anthropic-version تُتجاهلان هناك بلا ضرر)
 *
 *   AI_MODEL           موديل المساعد المحاسبي (Anthropic: claude-sonnet-5-5 · DeepSeek: deepseek-v4-pro)
 *   AI_CHAT_MODEL      موديل المحادثة والتقارير (Anthropic: claude-haiku-5-5 · DeepSeek: deepseek-flash)
 *   AI_HQ_MODEL        موديل مساعد الإدارة بين الفروع (الافتراضي: موديل المساعد المحاسبي)
 *   AI_BASE_URL        رابطٌ بديل (اختياري)
 */
function aiConfig() {
  const anKey = process.env.ANTHROPIC_API_KEY || "";
  const dsKey = process.env.DEEPSEEK_API_KEY || "";
  const pinned = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  const provider = pinned === "deepseek" || pinned === "anthropic" ? pinned : anKey ? "anthropic" : dsKey ? "deepseek" : "anthropic";
  if (provider === "deepseek") {
    const model = process.env.AI_MODEL || "deepseek-v4-pro";
    return {
      provider,
      apiKey: dsKey || process.env.AI_API_KEY || "",
      baseUrl: (process.env.AI_BASE_URL || "https://api.deepseek.com/anthropic").replace(/\/+$/, ""),
      model,
      chatModel: process.env.AI_CHAT_MODEL || process.env.AI_MODEL || "deepseek-flash",
      hqModel: process.env.AI_HQ_MODEL || model,
    };
  }
  const model = process.env.AI_MODEL || "claude-sonnet-5-5";
  return {
    provider: "anthropic",
    apiKey: anKey || process.env.AI_API_KEY || "",
    baseUrl: (process.env.AI_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, ""),
    model,
    chatModel: process.env.AI_CHAT_MODEL || process.env.AI_MODEL || "claude-haiku-5-5",
    hqModel: process.env.AI_HQ_MODEL || model,
  };
}

/** نداءٌ واحد لـ /v1/messages بصيغة Anthropic — يعمل مع DeepSeek و Claude معًا */
async function aiMessages(cfg, body) {
  const r = await fetch(`${cfg.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const payload = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, payload };
}

export { aiConfig, aiMessages };
