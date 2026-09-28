/**
 * مزوّد الذكاء الصناعي — من متغيّرات البيئة وحدها، لا مفتاح في الكود.
 *
 *   DeepSeek (الافتراضي متى وُجد مفتاحه): واجهةٌ بصيغة Anthropic نفسها على
 *   https://api.deepseek.com/anthropic — الأدوات (tools · tool_use · tool_result) مدعومة،
 *   و cache_control وترويسة anthropic-version تُتجاهلان هناك بلا ضرر.
 *
 *   DEEPSEEK_API_KEY   مفتاح DeepSeek (أو AI_API_KEY)
 *   AI_PROVIDER        deepseek | anthropic (اختياري — يُستنتج من المفتاح الموجود)
 *   AI_MODEL           موديل المساعد المحاسبي (الافتراضي deepseek-v4-pro)
 *   AI_CHAT_MODEL      موديل المحادثة والتقارير (الافتراضي deepseek-flash — أرخص وأسرع)
 *   AI_BASE_URL        رابطٌ بديل (اختياري)
 *   ANTHROPIC_API_KEY  يبقى مدعومًا: بلا مفتاح DeepSeek يعود الخادم إلى Claude كما كان.
 */
function aiConfig() {
  const dsKey = process.env.DEEPSEEK_API_KEY || (process.env.AI_PROVIDER === "deepseek" ? process.env.AI_API_KEY : "");
  const provider = process.env.AI_PROVIDER || (dsKey ? "deepseek" : "anthropic");
  if (provider === "deepseek") {
    return {
      provider,
      apiKey: dsKey || process.env.AI_API_KEY || "",
      baseUrl: (process.env.AI_BASE_URL || "https://api.deepseek.com/anthropic").replace(/\/+$/, ""),
      model: process.env.AI_MODEL || "deepseek-v4-pro",
      chatModel: process.env.AI_CHAT_MODEL || process.env.AI_MODEL || "deepseek-flash",
    };
  }
  return {
    provider: "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY || "",
    baseUrl: (process.env.AI_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, ""),
    model: process.env.AI_MODEL || "claude-sonnet-4-6",
    chatModel: process.env.AI_CHAT_MODEL || process.env.AI_MODEL || "claude-sonnet-4-6",
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
