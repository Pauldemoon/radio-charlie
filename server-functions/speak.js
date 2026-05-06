const GEMINI_TTS_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const GEMINI_TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Charon";
const GEMINI_TTS_TIMEOUT_MS = numberEnv("GEMINI_TTS_TIMEOUT_MS", 15000);
const GEMINI_TTS_MAX_CHARS = numberEnv("GEMINI_TTS_MAX_CHARS", 800);
const GEMINI_TTS_SAMPLE_RATE = 24000;

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

  if (!process.env.GEMINI_API_KEY) {
    return json(500, { error: "Configuration TTS manquante (GEMINI_API_KEY)." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Requête JSON invalide." });
  }

  const text = prepareSpeechText(body.text);

  if (!text) {
    return json(400, { error: "text est requis." });
  }

  if (text.length > GEMINI_TTS_MAX_CHARS) {
    return json(413, { error: "Texte trop long pour la voix antenne." });
  }

  try {
    const wavBuffer = await createSpeechGemini(text);
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store",
      },
      isBase64Encoded: true,
      body: wavBuffer.toString("base64"),
    };
  } catch (error) {
    return json(502, {
      error: "La synthèse vocale ne répond pas pour le moment.",
      detail: process.env.RADIO_CHARLIE_DEBUG_AI === "true" ? error.message : undefined,
    });
  }
};

async function createSpeechGemini(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TTS_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(
      `${GEMINI_TTS_API_URL}/${encodeURIComponent(GEMINI_TTS_MODEL)}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE },
              },
            },
          },
        }),
      },
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Gemini TTS a dépassé ${GEMINI_TTS_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Gemini TTS ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const payload = await response.json();
  const audioData = payload?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (!audioData) {
    throw new Error("Gemini TTS: réponse audio vide.");
  }

  return pcmToWav(Buffer.from(audioData, "base64"), GEMINI_TTS_SAMPLE_RATE);
}

function pcmToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  const dataSize = pcmBuffer.length;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitDepth, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wav, 44);

  return wav;
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

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}
