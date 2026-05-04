const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const CLAUDE_FALLBACK_MODELS = [
  ANTHROPIC_MODEL,
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-latest",
].filter((model, index, models) => model && models.indexOf(model) === index);
const AI_MAX_TOKENS = Number(process.env.RADIO_CHARLIE_AI_MAX_TOKENS || 3000);
const configuredAiAttempts = Number(process.env.RADIO_CHARLIE_AI_ATTEMPTS || 2);
const AI_ATTEMPTS = Number.isFinite(configuredAiAttempts)
  ? Math.max(1, Math.min(3, configuredAiAttempts))
  : 2;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 55000);
const WEB_SEARCH_USES = Math.max(0, Math.min(5, Number(process.env.RADIO_CHARLIE_WEB_SEARCH_USES || 2)));
const DEBUG = process.env.RADIO_CHARLIE_DEBUG_AI === "true";
// RADIO_CHARLIE_QUALITY_GATE=false désactive le filtre qualité (ancien nom : RADIO_CHARLIE_STRICT_AI)
const STRICT_QUALITY =
  process.env.RADIO_CHARLIE_QUALITY_GATE !== "false" &&
  process.env.RADIO_CHARLIE_STRICT_AI !== "false";
const QUALITY_ERROR_MESSAGE = "Qualite editoriale insuffisante.";
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
const EPISODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "tracks"],
  properties: {
    title: { type: "string" },
    tracks: {
      type: "array",
      minItems: 8,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "artist", "title", "chronicle"],
        properties: {
          role: { type: "string", enum: PLAYLIST_ROLES },
          artist: { type: "string" },
          title: { type: "string" },
          chronicle: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT =
  "Tu es Radio Charlie, une redaction musicale francaise exigeante. Tu fabriques des chroniques radio avec anecdotes, dates, contexte historique, faits verifiables, paroles, production, reception et consequences culturelles. Ton style est oral, vivant, precis, jamais scolaire, jamais vague. Tu reponds uniquement en JSON valide.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Determine the active AI provider.
 * Priority: AI_PROVIDER env var > key presence (Claude > DeepSeek > OpenAI)
 */
function resolveProvider() {
  const explicit = (process.env.AI_PROVIDER || "").toLowerCase().trim();
  if (explicit === "anthropic" || explicit === "claude") return "claude";
  if (explicit === "deepseek") return "deepseek";
  if (explicit === "openai") return "openai";
  // Fall back to key presence
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Methode non autorisee." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Requete JSON invalide." });
  }

  const artist = cleanText(body.artist);
  const title = cleanText(body.title);
  const seed = { artist, title, album: cleanText(body.album) };

  if (!artist || !title) {
    return json(400, { error: "artist et title sont requis." });
  }

  const provider = resolveProvider();
  if (!provider) {
    return json(500, {
      error:
        "Aucune IA configuree. Ajoute ANTHROPIC_API_KEY, DEEPSEEK_API_KEY ou OPENAI_API_KEY (ou definis AI_PROVIDER).",
    });
  }

  console.log(`[plan] start provider=${provider} artist="${seed.artist}" title="${seed.title}"`);

  try {
    let episode;
    if (provider === "claude") {
      episode = await createClaudeEpisode(seed);
    } else if (provider === "deepseek") {
      episode = await createDeepSeekEpisode(seed);
    } else {
      episode = await createOpenAiEpisode(seed);
    }
    console.log(`[plan] success provider=${provider} episodeTitle="${episode.title}"`);
    return json(200, episode);
  } catch (error) {
    console.error(`[plan] error provider=${provider} message="${error.message}"`);
    return json(502, {
      error: getAiUserMessage(error),
      detail: DEBUG ? error.message : undefined,
    });
  }
};

// ---------------------------------------------------------------------------
// Fetch with timeout
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function createOpenAiEpisode(seed) {
  return createEpisodeWithQualityRetry((attempt) => requestOpenAiEpisode(seed, attempt));
}

async function requestOpenAiEpisode(seed, attempt) {
  const response = await fetchWithTimeout(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.78,
      max_tokens: AI_MAX_TOKENS,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "radio_charlie_episode",
          strict: true,
          schema: EPISODE_SCHEMA,
        },
      },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(seed, attempt) },
      ],
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || "Erreur OpenAI.");
  const content = payload?.choices?.[0]?.message?.content;
  return normalizeEpisode(parseEpisode(content));
}

// ---------------------------------------------------------------------------
// DeepSeek  (OpenAI-compatible API)
// ---------------------------------------------------------------------------

async function createDeepSeekEpisode(seed) {
  return createEpisodeWithQualityRetry((attempt) => requestDeepSeekEpisode(seed, attempt));
}

async function requestDeepSeekEpisode(seed, attempt) {
  const model = DEEPSEEK_MODEL;
  // deepseek-reasoner doesn't support temperature or response_format
  const isReasoner = model.includes("reasoner");
  console.log(`[plan/deepseek] attempt=${attempt} model=${model} reasoner=${isReasoner}`);

  const bodyObj = {
    model,
    max_tokens: AI_MAX_TOKENS,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildPrompt(seed, attempt) },
    ],
  };

  if (!isReasoner) {
    bodyObj.temperature = 0.78;
    bodyObj.response_format = { type: "json_object" };
  }

  const response = await fetchWithTimeout(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObj),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const errMsg = payload?.error?.message || `DeepSeek HTTP ${response.status}`;
    console.error(`[plan/deepseek] error status=${response.status} msg="${errMsg}"`);
    throw new Error(errMsg);
  }

  const content = payload?.choices?.[0]?.message?.content;

  if (!content) {
    console.error("[plan/deepseek] empty content payload=", JSON.stringify(payload)?.slice(0, 400));
    throw new Error("Reponse IA vide.");
  }

  if (DEBUG) console.log("[plan/deepseek] content preview:", content.slice(0, 300));
  return normalizeEpisode(parseEpisode(content));
}

// ---------------------------------------------------------------------------
// Claude (Anthropic)
// ---------------------------------------------------------------------------

async function createClaudeEpisode(seed) {
  let lastError;
  for (const model of CLAUDE_FALLBACK_MODELS) {
    try {
      return await createEpisodeWithQualityRetry((attempt) =>
        requestClaudeEpisode(seed, attempt, model),
      );
    } catch (error) {
      lastError = error;
      if (!isModelAvailabilityError(error)) throw error;
    }
  }
  throw lastError || new Error("Modele Claude indisponible.");
}

async function requestClaudeEpisode(seed, attempt, model) {
  console.log(`[plan/claude] attempt=${attempt} model=${model}`);
  const response = await fetchWithTimeout(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model,
      max_tokens: AI_MAX_TOKENS,
      temperature: 0.72,
      system: SYSTEM_PROMPT,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_USES }],
      messages: [{ role: "user", content: buildPrompt(seed, attempt, { useWebSearch: true }) }],
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(formatClaudeError(payload, model));

  const content = payload?.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return normalizeEpisode(parseEpisode(content));
}

// ---------------------------------------------------------------------------
// Quality retry loop
// ---------------------------------------------------------------------------

async function createEpisodeWithQualityRetry(createEpisode) {
  let lastError;
  let lastCompleteEpisode;

  for (let attempt = 1; attempt <= AI_ATTEMPTS; attempt += 1) {
    try {
      const episode = await createEpisode(attempt);

      if (!STRICT_QUALITY || isValidEpisode(episode)) {
        return episode;
      }

      if (isCompleteEpisode(episode)) {
        lastCompleteEpisode = episode;
      }

      console.warn(`[plan] quality check failed attempt=${attempt}/${AI_ATTEMPTS}`);
      lastError = new Error(QUALITY_ERROR_MESSAGE);
    } catch (error) {
      lastError = error;
      if (!isRetryableGenerationError(error)) throw error;
    }
  }

  if (lastCompleteEpisode) return lastCompleteEpisode;
  throw lastError || new Error(QUALITY_ERROR_MESSAGE);
}

// ---------------------------------------------------------------------------
// Prompt builder (few-shot)
// ---------------------------------------------------------------------------

function buildPrompt(seed, attempt, options) {
  const { artist, title, album } = seed;
  const useWebSearch = options && options.useWebSearch;

  const lines = [];

  lines.push(
    "Morceau choisi : " +
      artist +
      " - " +
      title +
      (album ? " (album : " + album + ")" : ""),
  );
  lines.push("");

  if (attempt > 1) {
    lines.push(
      "ATTENTION : version precedente refusee. Chaque chronique DOIT contenir une date, une anecdote concrete et deux details verifiables (album, label, studio, paroles, classement, scene). Recommence avec plus de faits.",
    );
    lines.push("");
  }

  if (useWebSearch) {
    lines.push("ETAPE 1 - RECHERCHE (fais 1-2 recherches avant d'ecrire) :");
    lines.push('- "' + artist + " " + title + ' contexte album production"');
    lines.push('- "' + artist + ' biographie date"');
    lines.push(
      "Utilise seulement des faits trouves ou des connaissances tres etablies. Ne cite jamais un fait incertain. Ne mentionne pas tes recherches dans le JSON. Pas de balises <cite>.",
    );
    lines.push("");
    lines.push("ETAPE 2 - REDACTION :");
    lines.push("");
  }

  lines.push("MISSION : Tu es Radio Charlie. Cree un podcast editorial de 8 titres.");
  lines.push(
    "Radio Charlie ne decrit pas la musique. Elle raconte ce qui existe au-dela du son : l'histoire, le contexte, les paroles, la scene, la production, l'impact.",
  );
  lines.push("");

  lines.push("=== EXEMPLE PARFAIT (niveau attendu) ===");
  lines.push("Artiste: Daft Punk | Titre: Get Lucky | Role: opener");
  lines.push(
    'Chronique: "En 2013, Daft Punk revient apres huit ans de silence avec un choix inattendu : enregistrer Random Access Memories entierement en instruments live. Get Lucky nait de la rencontre avec Nile Rodgers, guitariste de Chic, et Pharrell Williams. Sorti en avril 2013, c\'est le premier top 10 britannique du duo depuis vingt ans. Detail cle : Rodgers joue sans click track pour retrouver le feeling flottant du funk 70s. Paradoxe parfait — les architectes de la musique de machine choisissent la chair pour leur retour."',
  );
  lines.push("");
  lines.push("=== EXEMPLE INTERDIT (ne jamais ecrire ca) ===");
  lines.push(
    "Chronique: \"Get Lucky est un titre incontournable de Daft Punk qui revele leur univers sonore unique. Le morceau illustre parfaitement leur talent pour melanger les genres et creer une atmosphere envoûtante. C'est une chanson qui transcende les epoques et touche tous les publics. Un chef-d'oeuvre de la musique electronique.\"",
  );
  lines.push("");
  lines.push(
    "MOTS INTERDITS : emblematique, univers sonore, chef-d'oeuvre, incontournable, transcende, envoûtant, unique en son genre.",
  );
  lines.push("");

  lines.push("PLAYLIST : 8 titres, roles dans cet ordre :");
  lines.push("1. opener - ouvre et pose la tension humaine");
  lines.push("2. origin - une source, une scene, une blessure initiale");
  lines.push("3. rupture - une cassure, un risque, un deplacement");
  lines.push("4. contrast - opposition de ton, d'epoque ou de statut");
  lines.push("5. hidden influence - influence moins evidente, un cousinage");
  lines.push("6. turning point - moment ou quelque chose bascule");
  lines.push("7. consequence - ce que cette bascule produit ensuite");
  lines.push("8. closing statement - ferme avec une idee forte");
  lines.push("");
  lines.push(
    "Regles : Titre 1 = le morceau choisi. Coherence culturelle (meme langue/scene). Titres disponibles sur Deezer.",
  );
  lines.push("");

  lines.push("REGLES CHRONIQUES (70-90 mots chacune — pas plus) :");
  lines.push("- Accroche : une scene, un moment, une tension (pas une definition)");
  lines.push("- Au moins une date ou annee precise");
  lines.push(
    "- Au moins deux details concrets parmi : album, label, studio, producteur, paroles, classement, clip, sample, scene, collaboration, controverse",
  );
  lines.push("- Conclusion : pourquoi ce morceau est la dans ce podcast");
  lines.push("- Ton oral, vivant (France Culture + Radio Nova), jamais scolaire");
  lines.push("- Chaque chronique apporte des informations nouvelles (pas de repetition)");
  lines.push("");

  lines.push("FORMAT : JSON valide uniquement. Aucun texte hors JSON. Aucun markdown.");
  lines.push("");
  lines.push(
    'Schema : { "title": "string", "tracks": [{ "role": "opener", "artist": "string", "title": "string", "chronicle": "string 70-90 mots" }, ...] }',
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------

function parseEpisode(content) {
  if (!content) throw new Error("Reponse IA vide.");
  return JSON.parse(
    content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, ""),
  );
}

function normalizeEpisode(episode) {
  if (!episode) return episode;
  return {
    title: episode.title || episode.radioTitle || "",
    angle: episode.angle || "",
    intro: episode.intro || "",
    tracks: Array.isArray(episode.tracks)
      ? episode.tracks.map((track, index) => ({
          role: normalizePlaylistRole(track.role, index),
          artist: track.artist || "",
          title: track.title || "",
          reason: track.reason || "",
          chronicle: stripCitations(track.chronicle || track.chronique || ""),
        }))
      : episode.tracks,
  };
}

function isValidEpisode(episode) {
  return Boolean(
    isCompleteEpisode(episode) &&
      episode.tracks.every((track) => isEditorialChronicle(track.chronicle)),
  );
}

function isCompleteEpisode(episode) {
  return Boolean(
    episode &&
      typeof episode.title === "string" &&
      Array.isArray(episode.tracks) &&
      episode.tracks.length === 8 &&
      episode.tracks.every(
        (track) =>
          typeof track.artist === "string" &&
          typeof track.title === "string" &&
          typeof track.chronicle === "string" &&
          typeof track.role === "string" &&
          cleanText(episode.title) &&
          PLAYLIST_ROLES.includes(track.role) &&
          cleanText(track.artist) &&
          cleanText(track.title),
      ),
  );
}

function isEditorialChronicle(value) {
  const text = cleanText(value);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasDate =
    /\b(?:19|20)\d{2}\b|\bannees?\s+(?:60|70|80|90|2000|2010|2020)\b/i.test(text);
  const concreteSignals = [
    /\balbum\b/i,
    /\blabel\b/i,
    /\bproduct(?:eur|ion|rice)\b/i,
    /\bstudio\b/i,
    /\bclip\b/i,
    /\bparoles?\b/i,
    /\bsample\b/i,
    /\bclassement\b/i,
    /\bcontroverse\b/i,
    /\bscène\b|\bscene\b/i,
    /\bcollectif\b/i,
    /\bville\b/i,
    /\bsort(?:i|ie|ent)\b/i,
    /\bpubl(?:ie|ie|iee)\b/i,
  ].filter((pattern) => pattern.test(text)).length;
  return wordCount >= 50 && hasDate && concreteSignals >= 2;
}

function isRetryableGenerationError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("qualite") ||
    message.includes("reponse ia vide") ||
    message.includes("json") ||
    message.includes("unexpected token")
  );
}

function isModelAvailabilityError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("model") ||
    message.includes("not available") ||
    message.includes("not found") ||
    message.includes("does not exist")
  );
}

function formatClaudeError(payload, model) {
  const message = payload?.error?.message || "Erreur Claude.";
  return `Claude ${model}: ${message}`;
}

function normalizePlaylistRole(role, index) {
  return PLAYLIST_ROLES.includes(role) ? role : PLAYLIST_ROLES[index] || "opener";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCitations(value) {
  return cleanText(
    String(value || "")
      .replace(/<cite\b[^>]*>/gi, "")
      .replace(/<\/cite>/gi, ""),
  );
}

function getAiUserMessage(error) {
  const message = String(error?.message || "");
  const lower = message.toLowerCase();
  console.error(`[plan] getAiUserMessage raw="${message}"`);
  if (lower.includes("quota") || lower.includes("billing") || lower.includes("insufficient balance") || lower.includes("credit"))
    return "Le quota ou le credit DeepSeek est epuise. Recharge le compte sur platform.deepseek.com.";
  if (lower.includes("invalid api key") || lower.includes("incorrect api key") || lower.includes("invalid x-api-key") || lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("401"))
    return "La cle API est invalide ou expiree. Verifie DEEPSEEK_API_KEY dans Railway.";
  if (lower.includes("model") || lower.includes("not found") || lower.includes("404"))
    return "Le modele IA n'existe pas ou n'est pas accessible. Verifie DEEPSEEK_MODEL dans Railway.";
  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many"))
    return "Trop de requetes. Attends quelques secondes et reessaie.";
  if (lower.includes("web_search") || lower.includes("web search"))
    return "La recherche web n'est pas activee pour cette cle.";
  if (lower.includes("qualite"))
    return "Podcast trop pauvre en faits. Relance pour une version plus documentee.";
  if (lower.includes("abort") || lower.includes("timeout") || lower.includes("socket") || lower.includes("503") || lower.includes("502"))
    return "DeepSeek ne repond pas. Reessaie dans quelques instants.";
  if (lower.includes("json") || lower.includes("unexpected token") || lower.includes("syntax"))
    return "La reponse de l'IA n'etait pas du JSON valide. Reessaie.";
  return `Erreur IA : ${message.slice(0, 120)}`;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}
