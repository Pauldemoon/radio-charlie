const GOOGLE_TTS_URL =
  "https://texttospeech.googleapis.com/v1/text:synthesize";

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

  if (!process.env.GOOGLE_TTS_API_KEY) {
    return json(500, { error: "Configuration Google TTS manquante." });
  }

  let body;

  try {
    body = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Requête JSON invalide." });
  }

  const text = cleanText(body.text).slice(0, 5000);

  if (!text) {
    return json(400, { error: "text est requis." });
  }

  try {
    const audioBase64 = await createSpeech(text);

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
      isBase64Encoded: true,
      body: audioBase64,
    };
  } catch (error) {
    return json(502, {
      error: "Google TTS ne répond pas pour le moment.",
      detail:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

async function createSpeech(text) {
  const response = await fetch(
    `${GOOGLE_TTS_URL}?key=${process.env.GOOGLE_TTS_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: "fr-FR",
          name: "fr-FR-Wavenet-D", // voix masculine française naturelle
          ssmlGender: "MALE",
        },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: 0.97,
          pitch: -1.5,
          effectsProfileId: ["headphone-class-device"],
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(errorText || "Erreur Google TTS.");
  }

  const data = await response.json();

  if (!data.audioContent) {
    throw new Error("Réponse Google TTS invalide : audioContent manquant.");
  }

  // Google TTS renvoie déjà du base64 — on le retourne directement
  return data.audioContent;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
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
