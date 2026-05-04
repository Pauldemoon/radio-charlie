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
const TAVILY_API_URL = "https://api.tavily.com/search";
const TAVILY_SNIPPET_CHARS = 450; // chars to keep per result in the prompt
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
  "turning point",
  "consequence",
  "closing statement",
];
const EPISODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "angle", "tracks"],
  properties: {
    title: { type: "string" },
    angle: { type: "string" },
    tracks: {
      type: "array",
      minItems: 6,
      maxItems: 6,
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
  "Tu es Radio Charlie, une redaction musicale francaise. Ta valeur est dans les faits precis et surprenants — pas dans les adjectifs ni les analyses. Pour chaque morceau, tu cherches ce que la plupart des gens ne savent pas : l'anecdote de studio, la connexion inattendue, le chiffre qui etonne, le contexte qui change tout. Style oral, vivant, jamais scolaire. JSON valide uniquement.";

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
// Tavily web search (provider-agnostic — used by DeepSeek and OpenAI)
// ---------------------------------------------------------------------------

async function searchWeb(query) {
  if (!process.env.TAVILY_API_KEY) return [];
  try {
    const response = await fetchWithTimeout(TAVILY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: "basic",
        max_results: 3,
        include_answer: false,
      }),
    });
    if (!response.ok) return [];
    const data = await response.json().catch(() => null);
    return data?.results || [];
  } catch (err) {
    console.warn(`[search] query="${query}" error="${err.message}"`);
    return [];
  }
}

async function gatherResearchContext(artist, title) {
  if (!process.env.TAVILY_API_KEY) return null;
  const queries = [
    `"${artist}" "${title}" anecdote recording story behind`,
    `"${artist}" biography interview unexpected`,
  ];
  const resultSets = await Promise.all(queries.map((q) => searchWeb(q)));
  const seen = new Set();
  const results = resultSets
    .flat()
    .filter((r) => r.content && !seen.has(r.url) && seen.add(r.url));
  if (!results.length) return null;
  return results
    .slice(0, 5)
    .map((r) => `[${r.title}]\n${r.content.slice(0, TAVILY_SNIPPET_CHARS)}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function createOpenAiEpisode(seed) {
  return createEpisodeWithQualityRetry((attempt) => requestOpenAiEpisode(seed, attempt));
}

async function requestOpenAiEpisode(seed, attempt) {
  const researchContext = attempt === 1 ? await gatherResearchContext(seed.artist, seed.title) : null;
  if (researchContext) console.log(`[plan/openai] research context: ${researchContext.length} chars`);

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
        { role: "user", content: buildPrompt(seed, attempt, { researchContext }) },
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
  // Web research via Tavily (first attempt only — retry uses the same context implicitly)
  const researchContext = attempt === 1 ? await gatherResearchContext(seed.artist, seed.title) : null;
  if (researchContext) console.log(`[plan/deepseek] research context: ${researchContext.length} chars`);

  const model = DEEPSEEK_MODEL;
  // Reasoning models: deepseek-reasoner, *-pro, *-r1 — they think before answering
  // and need a much larger token budget (reasoning chain + JSON output)
  const isReasoner = /reasoner|r1$|-pro$/i.test(model);
  const maxTokens = isReasoner ? Math.max(AI_MAX_TOKENS, 8000) : AI_MAX_TOKENS;
  console.log(`[plan/deepseek] attempt=${attempt} model=${model} reasoner=${isReasoner} maxTokens=${maxTokens}`);

  const bodyObj = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildPrompt(seed, attempt, { researchContext }) },
    ],
  };

  // Reasoning models don't support temperature or response_format
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
  const reasoningContent = payload?.choices?.[0]?.message?.reasoning_content;

  if (!content) {
    if (reasoningContent) {
      // Reasoning model used all its tokens thinking — content is empty
      console.error(`[plan/deepseek] reasoning model exhausted tokens: reasoning=${reasoningContent.length}chars, content empty`);
      throw new Error("Le modele de reflexion a epuise son budget de tokens avant d'ecrire le JSON. Augmente RADIO_CHARLIE_AI_MAX_TOKENS.");
    }
    console.error("[plan/deepseek] empty content payload=", JSON.stringify(payload)?.slice(0, 400));
    throw new Error("Reponse IA vide.");
  }

  if (DEBUG || isReasoner) console.log(`[plan/deepseek] content preview (${content.length}chars):`, content.slice(0, 200));
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

  lines.push("Morceau : " + artist + " - " + title + (album ? " (album : " + album + ")" : ""));
  lines.push("");

  if (attempt > 1) {
    lines.push(
      "ATTENTION : version precedente refusee. Les chroniques manquaient de faits precis et surprenants. Evite les generalites et les adjectifs. Recommence avec de vraies informations.",
    );
    lines.push("");
  }

  // ── RECHERCHE ──────────────────────────────────────────────────────────────
  if (useWebSearch) {
    // Claude : instructions pour sa recherche native
    lines.push("ETAPE 1 - RECHERCHE (fais 1-2 recherches) :");
    lines.push('- "' + artist + " " + title + ' anecdote recording story behind"');
    lines.push('- "' + artist + ' biography interview unexpected"');
    lines.push(
      "Cherche des faits qui etonnent : anecdotes de studio, connexions inattendues, contexte historique oublie, chiffres precis, tensions biographiques.",
    );
    lines.push("Utilise seulement des faits trouves ou tres etablis. Ne mentionne pas tes recherches dans le JSON. Pas de balises <cite>.");
    lines.push("");
  } else if (options && options.researchContext) {
    // DeepSeek / OpenAI : resultats Tavily injectes directement
    lines.push("=== INFORMATIONS TROUVEES SUR CET ARTISTE ===");
    lines.push(options.researchContext);
    lines.push("");
    lines.push(
      "Pour les dates, chiffres et anecdotes precises, utilise en priorite ces informations. Ne complete avec tes connaissances generales que pour des faits tres etablis et publics (ex: date de sortie d'un album majeur). Ne jamais inventer ni approximer.",
    );
    lines.push("");
  }

  // ── MISSION ────────────────────────────────────────────────────────────────
  lines.push("MISSION : Radio Charlie. Playlist de 6 titres avec une raison d'exister.");
  lines.push("");
  lines.push(
    "FIL CONDUCTEUR : une phrase qui explique pourquoi ces 6 titres ensemble — pas un genre, pas une epoque, pas 'Autour de X'.",
  );
  lines.push("Le titre du podcast exprime ce fil.");
  lines.push("");

  // ── EXEMPLE PARFAIT ────────────────────────────────────────────────────────
  lines.push("=== EXEMPLE PARFAIT (niveau attendu) ===");
  lines.push("Artiste: Daft Punk | Titre: Get Lucky | Role: opener");
  lines.push(
    'Chronique: "En 2013, Daft Punk revient apres huit ans de silence avec un choix paradoxal : les pionniers de l\'electronique enregistrent Random Access Memories entierement en instruments live. Get Lucky nait d\'une rencontre calculee — Nile Rodgers, guitariste de Chic, joue sa guitare sans click track pour retrouver le feeling flottant du funk des annees 70. Sorti en avril 2013, le titre devient leur premier top 10 britannique depuis vingt ans. Fait peu connu : c\'est la voix falsettee de Pharrell qui a convaincu Thomas Bangalter d\'abandonner les voix robotisees pour ce retour. Les architectes de la musique de machine avaient choisi la chair."',
  );
  lines.push("");
  lines.push("=== EXEMPLE INTERDIT (ne jamais ecrire ca) ===");
  lines.push(
    "Chronique: \"Get Lucky est un titre incontournable de Daft Punk qui revele leur univers sonore unique. Le morceau illustre parfaitement leur talent pour melanger les genres et creer une atmosphere envoûtante.\"",
  );
  lines.push("");
  lines.push(
    "MOTS INTERDITS : emblematique, univers sonore, chef-d'oeuvre, incontournable, transcende, envoûtant, unique en son genre, intemporel, fascinant, magistral.",
  );
  lines.push("");

  // ── PLAYLIST ───────────────────────────────────────────────────────────────
  lines.push("PLAYLIST : 6 titres. Melange OBLIGATOIRE d'artistes differents.");
  lines.push("- Titre 1 : le morceau de depart (" + artist + " - " + title + ")");
  lines.push("- Titres 2 a 6 : des artistes DIFFERENTS de " + artist + " — influences, contemporains, heritiers, connexions inattendues — choisis pour leur rapport au fil conducteur.");
  lines.push("Ne pas mettre plusieurs titres du meme artiste. La diversite est la valeur de la playlist.");
  lines.push("");
  lines.push("Les roles structurent le parcours :");
  lines.push("1. opener          - pose le sujet, le ton");
  lines.push("2. origin          - la source, l'influence fondatrice");
  lines.push("3. rupture         - un artiste qui a rompu avec quelque chose");
  lines.push("4. turning point   - le basculement, la connexion inattendue");
  lines.push("5. consequence     - ce qui en a decoule, les heritiers");
  lines.push("6. closing statement - ou ca nous amene");
  lines.push("");

  // ── REGLES CHRONIQUES ──────────────────────────────────────────────────────
  lines.push("REGLES CHRONIQUES (100-120 mots chacune) :");
  lines.push("- Ouvre sur une scene, un fait precis ou un moment — jamais une definition ni un adjectif");
  lines.push("- PRIORITE : des faits precis et verifiables — date, nom, chiffre, anecdote documentee");
  lines.push("- INTERDIT : inventer ou approximer un fait. Si tu n'es pas certain, ne l'inclus pas.");
  lines.push("  En cas de doute, decris le contexte artistique (la periode, la scene, l'influence) plutot qu'un detail incertain.");
  lines.push("- INTERDIT : mentionner un sample sauf si tu l'as trouve dans les informations de recherche fournies. Les samples sont tres souvent inventes par les IA. Ne jamais ecrire 'samplait', 'built on a sample', 'emprunte a', 'base sur un sample de' sans source certaine.");
  lines.push("- Au moins une annee ou date concrete que tu sais etre exacte");
  lines.push("- Ton oral et vivant — pas scolaire, pas encyclopedique, pas de jargon critique");
  lines.push("- Derniere phrase : lien avec le fil conducteur du podcast");
  lines.push("- Chaque chronique apporte des faits nouveaux — zero repetition entre les 6 titres");
  lines.push("");

  // ── FORMAT ─────────────────────────────────────────────────────────────────
  lines.push("FORMAT : JSON valide uniquement. Aucun texte hors JSON. Aucun markdown.");
  lines.push("");
  lines.push(
    'Schema : { "title": "string", "angle": "string (le fil conducteur en une phrase)", "tracks": [{ "role": "opener", "artist": "string", "title": "string", "chronicle": "string 100-120 mots" }, ...] }',
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
      episode.tracks.length === 6 &&
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
  return wordCount >= 70 && hasDate && concreteSignals >= 2;
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
