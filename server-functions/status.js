const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: "",
    };
  }

  if (event.httpMethod !== "GET") {
    return json(405, { error: "Méthode non autorisée." });
  }

  const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasTavily = Boolean(process.env.TAVILY_API_KEY);
  const aiProvider = getAiProvider({ hasDeepSeek, hasOpenAi, hasClaude, hasGemini });
  const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
  const voiceProvider = getVoiceProvider();

  return json(200, {
    aiProvider,
    deepseekConfigured: hasDeepSeek,
    deepseekModel,
    deepseekThinking: getDeepSeekThinking(deepseekModel),
    openaiConfigured: hasOpenAi,
    openaiModel: process.env.OPENAI_MODEL || "gpt-5-mini",
    claudeConfigured: hasClaude,
    claudeModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
    geminiConfigured: hasGemini,
    geminiModel: process.env.GEMINI_MODEL || "gemini-3-flash-preview",
    geminiThinkingLevel: getGeminiThinkingLevel(),
    geminiThinkingBudget: getGeminiThinkingBudget(),
    aiMaxTokens: Number(process.env.RADIO_CHARLIE_AI_MAX_TOKENS || 4500),
    voiceProvider,
    voiceModel: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
    voiceLanguage: process.env.ELEVENLABS_LANGUAGE || "fr",
    voiceSpeed: Number(process.env.ELEVENLABS_SPEED || 1.12),
    voiceTimeoutMs: Number(process.env.ELEVENLABS_TIMEOUT_MS || 6500),
    voiceSpeakerBoost: getBooleanEnv("ELEVENLABS_SPEAKER_BOOST", false),
    tavilyConfigured: hasTavily,
    tavilyEnabled: process.env.TAVILY_ENABLED !== "false" && hasTavily,
    tavilySearchDepth: getTavilySearchDepth(),
    tavilyMaxResults: Number(process.env.TAVILY_MAX_RESULTS || 5),
    strictAi: process.env.RADIO_CHARLIE_STRICT_AI === "true",
    strictWeb: process.env.RADIO_CHARLIE_STRICT_WEB === "true",
    freeMode: process.env.RADIO_CHARLIE_FREE_MODE === "true",
  });
};

function getAiProvider({ hasDeepSeek, hasOpenAi, hasClaude, hasGemini }) {
  const configuredProvider = String(process.env.AI_PROVIDER || "").trim().toLowerCase();

  if (configuredProvider === "anthropic") {
    return "claude";
  }

  if (configuredProvider === "google") {
    return "gemini";
  }

  if (["deepseek", "openai", "claude", "gemini", "local"].includes(configuredProvider)) {
    return configuredProvider;
  }

  if (hasGemini) {
    return "gemini";
  }

  if (hasDeepSeek) {
    return "deepseek";
  }

  if (hasOpenAi) {
    return "openai";
  }

  if (hasClaude) {
    return "claude";
  }

  return "local";
}

function getDeepSeekThinking(model) {
  const configured = String(process.env.DEEPSEEK_THINKING || "").trim().toLowerCase();

  if (configured) {
    return configured;
  }

  return String(model).toLowerCase().startsWith("deepseek-v4") ? "disabled" : "";
}

function getVoiceProvider() {
  const configured = String(
    process.env.VOICE_PROVIDER || process.env.RADIO_CHARLIE_VOICE_PROVIDER || "",
  )
    .trim()
    .toLowerCase();

  if (configured === "browser" || configured === "local") {
    return "browser";
  }

  return process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "browser";
}

function getBooleanEnv(name, fallback) {
  const value = String(process.env[name] || "").trim().toLowerCase();

  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value);
}

function getTavilySearchDepth() {
  const configured = String(process.env.TAVILY_SEARCH_DEPTH || "").trim().toLowerCase();

  if (["ultra-fast", "fast", "basic", "advanced"].includes(configured)) {
    return configured;
  }

  return "basic";
}

function getGeminiThinkingLevel() {
  const configured = String(process.env.GEMINI_THINKING_LEVEL || "").trim().toLowerCase();

  if (["minimal", "low", "medium", "high"].includes(configured)) {
    return configured;
  }

  return "low";
}

function getGeminiThinkingBudget() {
  const value = String(process.env.GEMINI_THINKING_BUDGET || "").trim();
  return value || "";
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}
