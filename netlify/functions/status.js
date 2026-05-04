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

  const explicit = (process.env.AI_PROVIDER || "").toLowerCase().trim();
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);

  let aiProvider;
  let aiModel;
  if (explicit === "anthropic" || explicit === "claude" || (!explicit && hasClaude)) {
    aiProvider = "claude";
    aiModel = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
  } else if (explicit === "deepseek" || (!explicit && hasDeepSeek)) {
    aiProvider = "deepseek";
    aiModel = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  } else if (explicit === "openai" || (!explicit && hasOpenAi)) {
    aiProvider = "openai";
    aiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  } else {
    aiProvider = "none";
    aiModel = null;
  }

  return json(200, {
    aiProvider,
    aiModel,
    aiMaxTokens: Number(process.env.RADIO_CHARLIE_AI_MAX_TOKENS || 3000),
    voiceProvider:
      process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID ? "elevenlabs" : "browser",
    qualityGate: process.env.RADIO_CHARLIE_QUALITY_GATE !== "false" && process.env.RADIO_CHARLIE_STRICT_AI !== "false",
  });
};

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
