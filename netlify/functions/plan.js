const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const AI_MAX_TOKENS = Number(process.env.RADIO_CHARLIE_AI_MAX_TOKENS || 2800);
const AI_ATTEMPTS = 1;
const QUALITY_ERROR_MESSAGE = "Qualité éditoriale insuffisante.";
const PLAYLIST_ROLES = [
  "opener",
  "origin",
  "rupture",
  "contrast",
  "hidden influence",
  "turning point",
  "consequence",
  "closing statement",
];
const SYSTEM_PROMPT =
  "Tu es Radio Charlie, une émission de radio musicale française. Tu crées des playlists éditoriales de 8 titres avec une chronique orale vivante pour chaque morceau. Tu réponds uniquement en JSON valide.";

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
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Requête JSON invalide." });
  }
  const artist = cleanText(body.artist);
  const title = cleanText(body.title);
  const seed = { artist, title, album: cleanText(body.album) };
  const hasAiProvider = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  if (!artist || !title) {
    return json(400, { error: "artist et title sont requis." });
  }
  if (!hasAiProvider) {
    return json(500, { error: "Aucune IA n'est configurée. Ajoute ANTHROPIC_API_KEY ou OPENAI_API_KEY." });
  }
  try {
    const episode = process.env.ANTHROPIC_API_KEY
      ? await createClaudeEpisode(seed)
      : await createOpenAiEpisode(seed);
    return json(200, episode);
  } catch (error) {
    return json(502, { error: getAiUserMessage(error) });
  }
};

async function createClaudeEpisode(seed) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: AI_MAX_TOKENS,
      temperature: 0.72,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPrompt(seed) }],
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || "Erreur Claude.");
  const content = payload?.content?.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const episode = normalizeEpisode(parseEpisode(content));
  if (!isValidEpisode(episode)) throw new Error(QUALITY_ERROR_MESSAGE);
  return episode;
}

async function createOpenAiEpisode(seed) {
  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.78,
      max_tokens: AI_MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(seed) },
      ],
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || "Erreur OpenAI.");
  const content = payload?.choices?.[0]?.message?.content;
  const episode = normalizeEpisode(parseEpisode(content));
  if (!isValidEpisode(episode)) throw new Error(QUALITY_ERROR_MESSAGE);
  return episode;
}

function buildPrompt({ artist, title, album }) {
  return `Tu es Radio Charlie, une émission de radio musicale française de qualité.

Morceau de départ : ${artist} - ${title}${album ? " (" + album + ")" : ""}

Crée une émission radio complète en 8 titres autour de ce morceau.

Règles :
- Le titre 1 doit être le morceau choisi par l'utilisateur
- Les 7 autres titres doivent être cohérents (même scène, même époque, ou lien artistique clair)
- Chaque chronique doit faire 60 à 90 mots, en français oral et vivant
- Chaque chronique doit mentionner au moins une date ou année, et un fait concret
- Chaque titre joue un rôle : opener, origin, rupture, contrast, hidden influence, turning point, consequence, closing statement

Retourne uniquement du JSON valide :
{
  "title": "titre de l'émission",
  "tracks": [
    { "role": "opener", "artist": "...", "title": "...", "chronicle": "..." }
  ]
}`.trim();
}

function parseEpisode(content) {
  if (!content) throw new Error("Réponse IA vide.");
  return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
}

function normalizeEpisode(episode) {
  if (!episode) return episode;
  return {
    title: episode.title || "",
    angle: episode.angle || "",
    intro: episode.intro || "",
    tracks: Array.isArray(episode.tracks)
      ? episode.tracks.map((track, i) => ({
          role: PLAYLIST_ROLES.includes(track.role) ? track.role : PLAYLIST_ROLES[i] || "opener",
          artist: track.artist || "",
          title: track.title || "",
          reason: track.reason || "",
          chronicle: track.chronicle || track.chronique || "",
        }))
      : [],
  };
}

function isValidEpisode(episode) {
  return Boolean(
    episode &&
    typeof episode.title === "string" &&
    Array.isArray(episode.tracks) &&
    episode.tracks.length === 8 &&
    episode.tracks.every((t) =>
      typeof t.artist === "string" && typeof t.title === "string" &&
      typeof t.chronicle === "string" && PLAYLIST_ROLES.includes(t.role) &&
      cleanText(t.artist) && cleanText(t.title) &&
      t.chronicle.split(/\s+/).filter(Boolean).length >= 40
    )
  );
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getAiUserMessage(error) {
  const msg = String(error?.message || "").toLowerCase();
  if (msg.includes("quota") || msg.includes("billing"))
    return "Le quota de la clé IA est épuisé. Vérifie le crédit ou la facturation du compte.";
  if (msg.includes("invalid api key") || msg.includes("invalid x-api-key"))
    return "La clé IA est invalide. Vérifie ANTHROPIC_API_KEY ou OPENAI_API_KEY.";
  if (msg.includes("model"))
    return "Le modèle IA configuré n'est pas disponible pour cette clé.";
  if (msg.includes("qualité éditoriale"))
    return "L'IA a produit une émission trop pauvre en faits. Relance la génération.";
  return "L'IA ne répond pas pour le moment.";
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}
