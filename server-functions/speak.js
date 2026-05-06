const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
const ELEVENLABS_LANGUAGE = process.env.ELEVENLABS_LANGUAGE || "fr";
const ELEVENLABS_TIMEOUT_MS = numberEnv("ELEVENLABS_TIMEOUT_MS", 6500);
const ELEVENLABS_MAX_CHARS = numberEnv("ELEVENLABS_MAX_CHARS", 750);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Méthode non autorisée." });
  }

  if (getVoiceProvider() !== "elevenlabs") {
    return json(503, { error: "Voix navigateur configurée." });
  }

  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
    return json(500, { error: "Configuration ElevenLabs manquante." });
  }

  let body;

  try {
    body = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Requête JSON invalide." });
  }

  const text = prepareSpeechText(body.text);

  if (!text) {
    return json(400, { error: "text est requis." });
  }

  if (text.length > ELEVENLABS_MAX_CHARS) {
    return json(413, { error: "Texte trop long pour la voix antenne." });
  }

  try {
    const audio = await createSpeech(text);

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
      isBase64Encoded: true,
      body: Buffer.from(audio).toString("base64"),
    };
  } catch (error) {
    return json(502, {
      error: "ElevenLabs ne répond pas pour le moment.",
      detail: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

async function createSpeech(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(`${ELEVENLABS_API_URL}/${process.env.ELEVENLABS_VOICE_ID}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL,
        language_code: ELEVENLABS_LANGUAGE,
        voice_settings: {
          stability: numberEnv("ELEVENLABS_STABILITY", 0.42),
          similarity_boost: numberEnv("ELEVENLABS_SIMILARITY", 0.72),
          style: numberEnv("ELEVENLABS_STYLE", 0.18),
          speed: numberEnv("ELEVENLABS_SPEED", 1.12),
          use_speaker_boost: booleanEnv("ELEVENLABS_SPEAKER_BOOST", false),
        },
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`ElevenLabs a dépassé ${ELEVENLABS_TIMEOUT_MS}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(errorText || "Erreur ElevenLabs.");
  }

  return response.arrayBuffer();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function prepareSpeechText(value) {
  return cleanText(value)
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?])\s+/g, "$1 ")
    .replace(/;/g, ".")
    .replace(/ : /g, ". ")
    .replace(/\s+-\s+/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanEnv(name, fallback) {
  const value = cleanText(process.env[name]).toLowerCase();

  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value);
}

function getVoiceProvider() {
  const configured = cleanText(
    process.env.VOICE_PROVIDER || process.env.RADIO_CHARLIE_VOICE_PROVIDER,
  ).toLowerCase();

  if (configured === "browser" || configured === "local") {
    return "browser";
  }

  return "elevenlabs";
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
