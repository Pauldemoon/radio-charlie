const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";

// Voice settings — all overridable via env vars, with sensible radio defaults
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";
const VOICE_STABILITY = clamp(Number(process.env.ELEVENLABS_STABILITY ?? 0.28), 0, 1);
const VOICE_SIMILARITY = clamp(Number(process.env.ELEVENLABS_SIMILARITY ?? 0.72), 0, 1);
const VOICE_STYLE = clamp(Number(process.env.ELEVENLABS_STYLE ?? 0.42), 0, 1);
const VOICE_SPEED = clamp(Number(process.env.ELEVENLABS_SPEED ?? 1.0), 0.5, 2.0);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Methode non autorisee." });
  }

  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
    return json(500, { error: "Configuration ElevenLabs manquante." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Requete JSON invalide." });
  }

  const rawText = cleanText(body.text).slice(0, 5000);
  if (!rawText) return json(400, { error: "Le texte est vide." });

  const text = prepareForTTS(rawText);

  console.log(
    `[speak] chars=${text.length} voiceId=${process.env.ELEVENLABS_VOICE_ID}` +
    ` model=${ELEVENLABS_MODEL} stability=${VOICE_STABILITY} similarity=${VOICE_SIMILARITY}` +
    ` style=${VOICE_STYLE} speed=${VOICE_SPEED}`,
  );

  try {
    const response = await fetch(
      `${ELEVENLABS_API_URL}/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          Accept: "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text,
          model_id: ELEVENLABS_MODEL,
          voice_settings: {
            stability: VOICE_STABILITY,
            similarity_boost: VOICE_SIMILARITY,
            style: VOICE_STYLE,
            use_speaker_boost: true,
            // speed is supported by eleven_turbo_v2_5 and eleven_multilingual_v2
            speed: VOICE_SPEED,
          },
        }),
      },
    );

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error(
        `[speak] ElevenLabs error status=${response.status} body=${errBody.slice(0, 200)}`,
      );
      throw new Error(`Erreur ElevenLabs (${response.status})`);
    }

    const audioBuffer = await response.arrayBuffer();

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "audio/mpeg" },
      isBase64Encoded: true,
      body: Buffer.from(audioBuffer).toString("base64"),
    };
  } catch (error) {
    console.error(`[speak] error message="${error.message}"`);
    return json(502, { error: "Probleme avec ElevenLabs." });
  }
};

/**
 * Prepares text for natural radio TTS rendering.
 * - Strips residual HTML tags
 * - Converts ALL-CAPS words to Title Case (ElevenLabs reads them letter by letter otherwise)
 * - Converts ellipsis to em-dash pause (better ElevenLabs rendering)
 * - Removes parenthetical year/remaster info that sounds bad when read aloud
 * - Cleans up multiple spaces
 * - Ensures a closing punctuation mark
 */
function prepareForTTS(text) {
  // Abbreviations/acronyms that should stay uppercase
  const keepUpper = new Set([
    "DJ", "MC", "TV", "FM", "AM", "UK", "US", "NY", "LA", "RNB",
    "RAP", "BPM", "MTV", "BBC", "RFM", "NRJ", "ONU", "USA", "EP", "LP",
  ]);

  return text
    .replace(/<[^>]+>/g, "")                          // strip HTML
    .replace(/\([^)]*(?:remaster|remix|live|edit|version)[^)]*\)/gi, "") // strip (2014 Remaster) etc.
    .replace(/\b\S{2,}\b/gu, (word) => {              // ALL-CAPS → Title Case
      const upper = word.toUpperCase();
      const lower = word.toLowerCase();
      if (word === upper && word !== lower && !keepUpper.has(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return word;
    })
    .replace(/\.{3}/g, " — ")                         // ... → pause naturelle
    .replace(/\s{2,}/g, " ")                          // collapse spaces
    .replace(/([^.!?])$/, "$1.")                      // ensure terminal punctuation
    .trim();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
