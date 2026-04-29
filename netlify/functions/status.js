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

  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);

  return json(200, {
    aiProvider: hasClaude ? "claude" : hasOpenAi ? "openai" : "local",
    claudeConfigured: hasClaude,
    claudeModel: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5",
    aiMaxTokens: Number(process.env.RADIO_CHARLIE_AI_MAX_TOKENS || 2200),
    voiceProvider: process.env.GOOGLE_TTS_API_KEY ? "google-tts" : "browser",
    strictAi: process.env.RADIO_CHARLIE_STRICT_AI === "true",
    freeMode: process.env.RADIO_CHARLIE_FREE_MODE === "true",
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
