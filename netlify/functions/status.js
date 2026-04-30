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
    claudeModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    aiMaxTokens: Number(process.env.RADIO_CHARLIE_AI_MAX_TOKENS || 5200),
    voiceProvider:
      process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID ? "elevenlabs" : "browser",
    strictAi: process.env.RADIO_CHARLIE_STRICT_AI === "true",
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
