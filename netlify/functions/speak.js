const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";

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
    return json(405, { error: "Méthode non autorisée." });
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

  const rawText = cleanText(body.text).slice(0, 5000);
  if (!rawText) return json(400, { error: "Le texte est vide." });

  // Prépare le texte pour un rendu radio naturel
  const text = prepareForTTS(rawText);

  console.log(`[speak] chars=${text.length} voiceId=${process.env.ELEVENLABS_VOICE_ID}`);

  try {
    const response = await fetch(
      `${ELEVENLABS_API_URL}/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "Accept": "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text,
          // eleven_turbo_v2_5 : plus rapide et plus expressif qu'eleven_multilingual_v2
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            // stability bas = plus d'intonation, moins de monotonie
            stability: 0.28,
            // similarity_boost légèrement baissé pour plus de naturel
            similarity_boost: 0.72,
            // style : expressivité dramatique (rendu radio, pas TTS neutre)
            style: 0.42,
            // use_speaker_boost : clarté et présence de la voix
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error(`[speak] ElevenLabs error status=${response.status} body=${errBody.slice(0, 200)}`);
      throw new Error(`Erreur ElevenLabs (${response.status})`);
    }

    const audioBuffer = await response.arrayBuffer();

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
      },
      isBase64Encoded: true,
      body: Buffer.from(audioBuffer).toString("base64"),
    };
  } catch (error) {
    console.error(`[speak] error message="${error.message}"`);
    return json(502, { error: "Problème avec ElevenLabs." });
  }
};

/**
 * Prépare le texte pour un rendu TTS radio naturel.
 * - Supprime les balises HTML résiduelles
 * - Convertit les points de suspension en pause em-dash (meilleur rendu ElevenLabs)
 * - Assure une ponctuation finale propre
 */
function prepareForTTS(text) {
  return text
    .replace(/<[^>]+>/g, "")          // strip HTML
    .replace(/\.{3}/g, " — ")          // ... → pause naturelle
    .replace(/\s{2,}/g, " ")           // espaces multiples
    .replace(/([^.!?])$/, "$1.")        // ponctuation finale si absente
    .trim();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
