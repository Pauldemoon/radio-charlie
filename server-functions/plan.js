const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TAVILY_API_URL = process.env.TAVILY_API_URL || "https://api.tavily.com/search";
const EXA_API_URL = "https://api.exa.ai/search";
const AI_MAX_TOKENS = numberEnv("RADIO_CHARLIE_AI_MAX_TOKENS", 4500);
const TAVILY_TIMEOUT_MS = numberEnv("TAVILY_TIMEOUT_MS", 8000);
const TAVILY_MAX_RESULTS = clampNumber(numberEnv("TAVILY_MAX_RESULTS", 5), 1, 8);
const TAVILY_CACHE_TTL_MS = numberEnv("TAVILY_CACHE_TTL_MS", 60 * 60 * 1000);
const EXA_TIMEOUT_MS = numberEnv("EXA_TIMEOUT_MS", 8000);
const EXA_MAX_RESULTS = clampNumber(numberEnv("EXA_MAX_RESULTS", 5), 1, 8);
const EXA_CACHE_TTL_MS = numberEnv("EXA_CACHE_TTL_MS", 60 * 60 * 1000);
const MAX_SEED_FIELD_LENGTH = 160;
const tavilyCache = new Map();
const EPISODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "angle", "intro", "tracks"],
  properties: {
    title: { type: "string" },
    angle: { type: "string" },
    intro: { type: "string" },
    tracks: {
      type: "array",
      minItems: 6,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["artist", "title", "reason", "chronicle"],
        properties: {
          artist: { type: "string" },
          title: { type: "string" },
          reason: { type: "string" },
          chronicle: { type: "string" },
          transition: { type: "string" },
        },
      },
    },
  },
};
const GEMINI_EPISODE_SCHEMA = {
  type: "OBJECT",
  required: ["title", "angle", "intro", "tracks"],
  properties: {
    title: { type: "STRING" },
    angle: { type: "STRING" },
    intro: { type: "STRING" },
    tracks: {
      type: "ARRAY",
      minItems: 6,
      maxItems: 8,
      items: {
        type: "OBJECT",
        required: ["artist", "title", "reason", "chronicle"],
        properties: {
          artist: { type: "STRING" },
          title: { type: "STRING" },
          reason: { type: "STRING" },
          chronicle: { type: "STRING" },
          transition: { type: "STRING" },
        },
        propertyOrdering: ["artist", "title", "reason", "chronicle", "transition"],
      },
    },
  },
  propertyOrdering: ["title", "angle", "intro", "tracks"],
};
const SYSTEM_PROMPT =
  "Tu es Sillage FM. Tu construis des portraits d’artistes : une émission = un artiste, raconté à travers ses chansons comme un documentaire sonore. Ta seule valeur : dire aux auditeurs ce qu’ils ne savaient pas. Pas de descriptions, pas d’ambiances, pas d’adjectifs creux : des faits, des dates, des noms, des chiffres, des anecdotes vérifiables sur CET artiste. Tu réponds uniquement en JSON valide.";

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

  let body;

  try {
    body = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Requête JSON invalide." });
  }

  const artist = cleanText(body.artist);
  const title = cleanText(body.title);
  const seed = {
    artist,
    title,
    album: cleanText(body.album),
  };

  if (!artist || !title) {
    return json(400, { error: "artist et title sont requis." });
  }

  if ([seed.artist, seed.title, seed.album].some(isSeedFieldTooLong)) {
    return json(400, { error: "Les champs artist, title et album doivent rester courts." });
  }

  try {
    const episode = await createAiEpisode(seed);
    return json(200, episode);
  } catch (error) {
    logAiError(error);
    return json(502, {
      error: getAiUserMessage(error),
      detail: shouldExposeAiDebug() ? sanitizeErrorMessage(error) : undefined,
    });
  }
};

async function createAiEpisode(seed) {
  const provider = getAiProvider();

  if (provider === "local") {
    throw new Error("Aucun fournisseur IA configuré. Ajoute une clé API dans Railway.");
  }

  const webContext = await createEditorialWebContext(seed);

  return retryOnOverload(async () => {
    if (provider === "deepseek") return createDeepSeekEpisode(seed, webContext);
    if (provider === "openai") return createOpenAiEpisode(seed, webContext);
    if (provider === "claude") return createClaudeEpisode(seed, webContext);
    if (provider === "gemini") return createGeminiEpisode(seed, webContext);
    throw new Error(`Fournisseur IA inconnu : ${provider}.`);
  });
}

async function retryOnOverload(fn, maxAttempts = 3) {
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || "").toLowerCase();
      const isOverloaded =
        msg.includes("overloaded") ||
        msg.includes("529") ||
        msg.includes("503") ||
        msg.includes("high demand") ||
        msg.includes("capacity");

      if (isOverloaded && attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 3000));
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

async function createEditorialWebContext(seed) {
  const useExa = isExaEnabled();
  const useTavily = !useExa && isTavilyEnabled();

  if (!useExa && !useTavily) {
    return "";
  }

  const cacheKey = trackKey(seed);
  const cached = tavilyCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.context;
  }

  try {
    let context;

    if (useExa) {
      const queries = buildExaQueries(seed);
      const payloads = await Promise.all(
        queries.map((q) => searchExa(q).catch(() => null)),
      );
      context = formatExaContext(payloads, seed);
    } else {
      const queries = buildTavilyQueries(seed);
      const payloads = await Promise.all(
        queries.map((q) => searchTavily(q).catch(() => null)),
      );
      context = formatMultiTavilyContext(payloads, seed);
    }

    tavilyCache.set(cacheKey, {
      context,
      expiresAt: now + (useExa ? EXA_CACHE_TTL_MS : TAVILY_CACHE_TTL_MS),
    });
    cleanupTavilyCache(now);

    return context;
  } catch (error) {
    logTavilyError(error);

    if (process.env.RADIO_CHARLIE_STRICT_WEB === "true") {
      throw new Error(`Recherche web indisponible: ${sanitizeErrorMessage(error)}`);
    }

    return "";
  }
}

function isExaEnabled() {
  return Boolean(process.env.EXA_API_KEY);
}

function isTavilyEnabled() {
  return process.env.TAVILY_ENABLED !== "false" && Boolean(process.env.TAVILY_API_KEY);
}

function buildExaQueries(seed) {
  const { artist, title, album } = seed;
  const albumPart = album ? ` album ${album}` : "";

  return [
    `${artist} "${title}"${albumPart} recording production release history studio producer sample label`,
    `${artist} biography discography career influences collaborators cultural impact`,
  ];
}

async function searchExa(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXA_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(EXA_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": process.env.EXA_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        numResults: EXA_MAX_RESULTS,
        contents: {
          highlights: {
            highlightsPerUrl: 3,
            numWords: 80,
          },
        },
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Exa a dépassé ${EXA_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text().catch(() => "");
  const payload = parseJsonSafely(responseText);

  if (!response.ok) {
    const apiMessage =
      payload?.error ||
      payload?.message ||
      responseText.slice(0, 500) ||
      "Réponse vide.";
    throw new Error(`Exa ${response.status}: ${apiMessage}`);
  }

  return payload || {};
}

function formatExaContext(payloads, seed) {
  const sectionLabels = [
    `Titre "${seed.artist} — ${seed.title}" : production, enregistrement, sortie, sample, label`,
    `Artiste "${seed.artist}" : biographie, scène, collaborateurs, anecdotes, impact culturel`,
  ];

  const sections = payloads
    .map((payload, i) => {
      if (!payload) return null;

      const results = Array.isArray(payload?.results) ? payload.results : [];
      const lines = results
        .filter((r) => r?.title && (Array.isArray(r?.highlights) ? r.highlights.length : r?.text))
        .slice(0, EXA_MAX_RESULTS)
        .map((r, j) => {
          const title = cleanText(r.title).slice(0, 120);
          const content = Array.isArray(r.highlights)
            ? r.highlights.map((h) => cleanText(h)).join(" ").slice(0, 600)
            : cleanText(r.text || "").slice(0, 600);
          return `  ${j + 1}. ${title} — ${content}`;
        });

      if (!lines.length) return null;

      return `### ${sectionLabels[i] || `Recherche ${i + 1}`}\n${lines.join("\n")}`;
    })
    .filter(Boolean);

  if (!sections.length) {
    return "";
  }

  return `
Dossier de recherche éditoriale pour "${seed.artist} — ${seed.title}".
Extrais les faits précis : dates, noms, chiffres, anecdotes vérifiables, contexte de production.
Ne cite pas les URL. Ne récite pas ces sources — transforme-les en matière éditoriale.
Si une information ne figure pas ici et que tu n'en es pas sûr, ne l'invente pas.

${sections.join("\n\n")}
`.trim();
}

function buildTavilyQueries(seed) {
  const { artist, title, album } = seed;
  const albumPart = album ? ` "${album}"` : "";

  return [
    // Requête 1 : le titre précis — production, sortie, sample, label, année
    `"${artist}" "${title}"${albumPart} recording production release year label sample producer studio`.slice(0, 400),
    // Requête 2 : l'artiste — biographie, scène, collaborateurs, anecdotes, impact culturel
    `"${artist}" biography career discography influences collaborators scene anecdotes cultural impact`.slice(0, 400),
  ];
}

async function searchTavily(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(TAVILY_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        topic: "general",
        search_depth: normalizeTavilySearchDepth(process.env.TAVILY_SEARCH_DEPTH),
        max_results: TAVILY_MAX_RESULTS,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_favicon: false,
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Tavily a dépassé ${TAVILY_TIMEOUT_MS}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text().catch(() => "");
  const payload = parseJsonSafely(responseText);

  if (!response.ok) {
    const apiMessage =
      payload?.error ||
      payload?.message ||
      responseText.slice(0, 500) ||
      "Réponse vide.";
    throw new Error(`Tavily ${response.status}: ${apiMessage}`);
  }

  return payload || {};
}

function normalizeTavilySearchDepth(value) {
  const depth = cleanText(value).toLowerCase();

  if (["ultra-fast", "fast", "basic", "advanced"].includes(depth)) {
    return depth;
  }

  return "advanced";
}

function formatMultiTavilyContext(payloads, seed) {
  const sectionLabels = [
    `Titre "${seed.artist} — ${seed.title}" : production, enregistrement, sortie, sample, label`,
    `Artiste "${seed.artist}" : biographie, scène, collaborateurs, anecdotes, impact culturel`,
  ];

  const sections = payloads
    .map((payload, i) => {
      if (!payload) return null;

      const results = Array.isArray(payload?.results) ? payload.results : [];
      const lines = results
        .filter((r) => r?.title && r?.content)
        .slice(0, TAVILY_MAX_RESULTS)
        .map((r, j) => {
          const title = cleanText(r.title).slice(0, 120);
          const content = cleanText(r.content).slice(0, 600);
          return `  ${j + 1}. ${title} — ${content}`;
        });

      if (!lines.length) return null;

      return `### ${sectionLabels[i] || `Recherche ${i + 1}`}\n${lines.join("\n")}`;
    })
    .filter(Boolean);

  if (!sections.length) {
    return "";
  }

  return `
Dossier de recherche éditoriale pour "${seed.artist} — ${seed.title}".
Extrais les faits précis : dates, noms, chiffres, anecdotes vérifiables, contexte de production.
Ne cite pas les URL. Ne récite pas ces sources — transforme-les en matière éditoriale.
Si une information ne figure pas ici et que tu n’en es pas sûr, ne l’invente pas.

${sections.join("\n\n")}
`.trim();
}

function cleanupTavilyCache(now) {
  if (tavilyCache.size < 100) {
    return;
  }

  tavilyCache.forEach((entry, key) => {
    if (entry.expiresAt <= now) {
      tavilyCache.delete(key);
    }
  });
}

function getAiProvider() {
  const configuredProvider = normalizeAiProvider(process.env.AI_PROVIDER);

  if (configuredProvider) {
    return configuredProvider;
  }

  if (process.env.DEEPSEEK_API_KEY) {
    return "deepseek";
  }

  if (process.env.OPENAI_API_KEY) {
    return "openai";
  }

  if (process.env.GEMINI_API_KEY) {
    return "gemini";
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return "claude";
  }

  return "local";
}

function normalizeAiProvider(value) {
  const provider = cleanText(value).toLowerCase();

  if (!provider) {
    return "";
  }

  if (provider === "anthropic") {
    return "claude";
  }

  if (provider === "google") {
    return "gemini";
  }

  if (["deepseek", "openai", "claude", "gemini", "local"].includes(provider)) {
    return provider;
  }

  throw new Error(`Fournisseur IA inconnu : ${value}.`);
}

async function createDeepSeekEpisode(seed, webContext) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("Configuration DeepSeek manquante.");
  }

  return createOpenAiCompatibleEpisode({
    apiName: "DeepSeek",
    apiUrl: process.env.DEEPSEEK_API_URL || DEEPSEEK_API_URL,
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: DEEPSEEK_MODEL,
    seed,
    webContext,
    responseFormat: {
      type: "json_object",
    },
    extraBody: getDeepSeekExtraBody(),
  });
}

function getDeepSeekExtraBody() {
  const thinking =
    cleanText(process.env.DEEPSEEK_THINKING).toLowerCase() ||
    (String(DEEPSEEK_MODEL).toLowerCase().startsWith("deepseek-v4") ? "disabled" : "");

  if (!thinking) {
    return {};
  }

  if (!["enabled", "disabled"].includes(thinking)) {
    throw new Error("DEEPSEEK_THINKING doit valoir enabled ou disabled.");
  }

  return {
    thinking: {
      type: thinking,
    },
  };
}

async function createOpenAiEpisode(seed, webContext) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Configuration OpenAI manquante.");
  }

  return createOpenAiCompatibleEpisode({
    apiName: "OpenAI",
    apiUrl: OPENAI_API_URL,
    apiKey: process.env.OPENAI_API_KEY,
    model: OPENAI_MODEL,
    seed,
    webContext,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "radio_charlie_episode",
        strict: true,
        schema: EPISODE_SCHEMA,
      },
    },
  });
}

async function createOpenAiCompatibleEpisode({
  apiName,
  apiUrl,
  apiKey,
  model,
  seed,
  webContext,
  responseFormat,
  extraBody = {},
}) {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.72,
      max_tokens: AI_MAX_TOKENS,
      response_format: responseFormat,
      ...extraBody,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildPrompt(seed, webContext),
        },
      ],
    }),
  });

  const responseText = await response.text().catch(() => "");
  const payload = parseJsonSafely(responseText);

  if (!response.ok) {
    const apiMessage =
      payload?.error?.message ||
      payload?.message ||
      responseText.slice(0, 600) ||
      "Réponse vide.";
    throw new Error(`${apiName} ${response.status}: ${apiMessage}`);
  }

  const content = getAssistantContent(payload, responseText, apiName);
  let episode;

  try {
    episode = normalizeEpisode(parseEpisode(content));
  } catch (error) {
    episode = await repairEpisodeJson({
      apiName,
      apiUrl,
      apiKey,
      model,
      content,
      parseError: error,
      extraBody,
    });
  }

  if (!isValidEpisode(episode)) {
    episode = await repairEpisodeJson({
      apiName,
      apiUrl,
      apiKey,
      model,
      content: JSON.stringify(episode || content || {}),
      parseError: new Error(`Format d'émission ${apiName} invalide.`),
      extraBody,
    });
  }

  if (!isValidEpisode(episode)) {
    throw new Error(`Format d'émission ${apiName} invalide après réparation JSON.`);
  }

  if (!isSeedOpeningTrack(episode, seed)) {
    episode = await repairEpisodeJson({
      apiName,
      apiUrl,
      apiKey,
      model,
      content: JSON.stringify(episode),
      parseError: new Error(
        `Contrainte éditoriale: le premier titre doit être exactement ${seed.artist} - ${seed.title}.`,
      ),
      extraBody,
    });
  }

  if (!isValidEpisode(episode) || !isSeedOpeningTrack(episode, seed)) {
    throw new Error(`Format d'émission ${apiName} invalide: le morceau choisi doit ouvrir l'émission.`);
  }

  const contentIssues = validateEpisodeContentIssues(episode);
  if (contentIssues.length) {
    episode = await repairEpisodeJson({
      apiName,
      apiUrl,
      apiKey,
      model,
      content: JSON.stringify(episode),
      parseError: new Error(`Problèmes éditoriaux à corriger:\n${contentIssues.join("\n")}`),
      extraBody,
    });
  }

  return episode;
}

async function repairEpisodeJson({ apiName, apiUrl, apiKey, model, content, parseError, extraBody }) {
  if (!content) {
    throw parseError;
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: AI_MAX_TOKENS,
      response_format: {
        type: "json_object",
      },
      ...extraBody,
      messages: [
        {
          role: "system",
          content:
            "Tu répares une réponse JSON pour Sillage FM. Retourne uniquement un objet JSON valide qui respecte la contrainte donnée. Tu peux corriger titres, artistes, rôles, raisons ou chroniques si la contrainte l’exige, mais garde le même angle éditorial. Aucun markdown.",
        },
        {
          role: "user",
          content: `Erreur JSON: ${parseError.message}\n\nRéponse à réparer:\n${String(content).slice(0, 14000)}`,
        },
      ],
    }),
  });

  const responseText = await response.text().catch(() => "");
  const payload = parseJsonSafely(responseText);

  if (!response.ok) {
    const apiMessage =
      payload?.error?.message ||
      payload?.message ||
      responseText.slice(0, 600) ||
      "Réponse vide.";
    throw new Error(`${apiName} réparation JSON ${response.status}: ${apiMessage}`);
  }

  try {
    return normalizeEpisode(parseEpisode(getAssistantContent(payload, responseText, apiName)));
  } catch (repairError) {
    throw new Error(
      `${apiName} JSON invalide: ${parseError.message}. Réparation échouée: ${repairError.message}`,
    );
  }
}

function getAssistantContent(payload, responseText, apiName) {
  const choice = payload?.choices?.[0];
  const message = choice?.message || {};
  const content = normalizeAssistantContent(
    message.content ?? choice?.text ?? payload?.output_text ?? payload?.content,
  );

  if (content) {
    return content;
  }

  const summary = [
    `finish_reason=${choice?.finish_reason || "absent"}`,
    `choice_keys=${Object.keys(choice || {}).join(",") || "absent"}`,
    `message_keys=${Object.keys(message).join(",") || "absent"}`,
    `content_type=${typeof message.content}`,
    `reasoning_chars=${String(message.reasoning_content || "").length}`,
    `response_preview=${String(responseText || "").slice(0, 280)}`,
  ].join("; ");

  throw new Error(`${apiName} réponse finale vide: ${summary}`);
}

function normalizeAssistantContent(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        return part?.text || part?.content || "";
      })
      .join("\n")
      .trim();
  }

  if (value && typeof value === "object" && Array.isArray(value.content)) {
    return normalizeAssistantContent(value.content);
  }

  return "";
}

async function createGeminiEpisode(seed, webContext) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Configuration Gemini manquante.");
  }

  const response = await fetch(
    `${GEMINI_API_URL}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [SYSTEM_PROMPT, buildPrompt(seed, webContext)].join("\n\n"),
              },
            ],
          },
        ],
        generationConfig: getGeminiGenerationConfig(),
      }),
    },
  );

  const responseText = await response.text().catch(() => "");
  const payload = parseJsonSafely(responseText);

  if (!response.ok) {
    const apiMessage =
      payload?.error?.message ||
      payload?.message ||
      responseText.slice(0, 600) ||
      "Réponse vide.";
    throw new Error(`Gemini ${response.status}: ${apiMessage}`);
  }

  const content = getGeminiContent(payload, responseText);
  let episode;

  try {
    episode = normalizeEpisode(parseEpisode(content));
  } catch (error) {
    episode = await repairGeminiEpisodeJson({ content, parseError: error });
  }

  if (!isValidEpisode(episode)) {
    episode = await repairGeminiEpisodeJson({
      content: JSON.stringify(episode || content || {}),
      parseError: new Error("Format d'émission Gemini invalide."),
    });
  }

  if (!isValidEpisode(episode)) {
    throw new Error("Format d'émission Gemini invalide après réparation JSON.");
  }

  if (!isSeedOpeningTrack(episode, seed)) {
    episode = await repairGeminiEpisodeJson({
      content: JSON.stringify(episode),
      parseError: new Error(
        `Contrainte éditoriale: le premier titre doit être exactement ${seed.artist} - ${seed.title}.`,
      ),
    });
  }

  if (!isValidEpisode(episode) || !isSeedOpeningTrack(episode, seed)) {
    throw new Error("Format d'émission Gemini invalide: le morceau choisi doit ouvrir l'émission.");
  }

  const contentIssues = validateEpisodeContentIssues(episode);
  if (contentIssues.length) {
    episode = await repairGeminiEpisodeJson({
      content: JSON.stringify(episode),
      parseError: new Error(`Problèmes éditoriaux à corriger:\n${contentIssues.join("\n")}`),
    });
  }

  return episode;
}

async function repairGeminiEpisodeJson({ content, parseError }) {
  if (!content) {
    throw parseError;
  }

  const response = await fetch(
    `${GEMINI_API_URL}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [
                  "Tu répares une réponse JSON pour Sillage FM. Retourne uniquement un objet JSON valide qui respecte la contrainte donnée. Tu peux corriger titres, artistes, rôles, raisons ou chroniques si la contrainte l'exige, mais garde le même angle éditorial. Aucun markdown.",
                  `Erreur JSON: ${parseError.message}\n\nRéponse à réparer:\n${String(content).slice(0, 14000)}`,
                ].join("\n\n"),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: AI_MAX_TOKENS,
          responseMimeType: "application/json",
          responseSchema: GEMINI_EPISODE_SCHEMA,
        },
      }),
    },
  );

  const responseText = await response.text().catch(() => "");
  const payload = parseJsonSafely(responseText);

  if (!response.ok) {
    const apiMessage =
      payload?.error?.message ||
      payload?.message ||
      responseText.slice(0, 600) ||
      "Réponse vide.";
    throw new Error(`Gemini réparation JSON ${response.status}: ${apiMessage}`);
  }

  try {
    return normalizeEpisode(parseEpisode(getGeminiContent(payload, responseText)));
  } catch (repairError) {
    throw new Error(
      `Gemini JSON invalide: ${parseError.message}. Réparation échouée: ${repairError.message}`,
    );
  }
}

function getGeminiGenerationConfig() {
  return {
    temperature: 0.72,
    maxOutputTokens: AI_MAX_TOKENS,
    responseMimeType: "application/json",
    responseSchema: GEMINI_EPISODE_SCHEMA,
    thinkingConfig: getGeminiThinkingConfig(),
  };
}

function getGeminiThinkingConfig() {
  const model = GEMINI_MODEL.toLowerCase();

  if (model.includes("gemini-3")) {
    const thinkingLevel = cleanText(process.env.GEMINI_THINKING_LEVEL).toLowerCase() || "low";

    if (["minimal", "low", "medium", "high"].includes(thinkingLevel)) {
      return { thinkingLevel };
    }

    return { thinkingLevel: "low" };
  }

  const rawBudget = cleanText(process.env.GEMINI_THINKING_BUDGET);

  if (!rawBudget) {
    return {};
  }

  const thinkingBudget = Number(rawBudget);

  if (!Number.isInteger(thinkingBudget)) {
    return {};
  }

  return { thinkingBudget };
}

function getGeminiContent(payload, responseText) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const content = parts
    .map((part) => part?.text || "")
    .join("\n")
    .trim();

  if (content) {
    return content;
  }

  const reason = payload?.candidates?.[0]?.finishReason || "absent";
  throw new Error(`Gemini réponse finale vide: finishReason=${reason}; response_preview=${String(responseText || "").slice(0, 280)}`);
}
function getClaudeThinkingConfig() {
  const rawBudget = cleanText(process.env.ANTHROPIC_THINKING_BUDGET);
  if (!rawBudget) return null;
  const budget = Number(rawBudget);
  if (!Number.isInteger(budget) || budget < 1024) return null;
  return { type: "enabled", budget_tokens: budget };
}

async function createClaudeEpisode(seed, webContext) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Configuration Claude manquante.");
  }

  const thinking = getClaudeThinkingConfig();
  const maxTokens = thinking
    ? Math.max(AI_MAX_TOKENS + thinking.budget_tokens, 16000)
    : AI_MAX_TOKENS;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      temperature: thinking ? 1 : 0.72,
      ...(thinking ? { thinking } : {}),
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildPrompt(seed, webContext),
        },
      ],
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error?.message || "Erreur Claude.");
  }

  const content = payload?.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  let episode;

  try {
    episode = normalizeEpisode(parseEpisode(content));
  } catch (error) {
    episode = await repairClaudeEpisodeJson({ content, parseError: error });
  }

  if (!isValidEpisode(episode)) {
    episode = await repairClaudeEpisodeJson({
      content: JSON.stringify(episode || content || {}),
      parseError: new Error("Format d'émission Claude invalide."),
    });
  }

  if (!isValidEpisode(episode)) {
    throw new Error("Format d'émission Claude invalide après réparation JSON.");
  }

  if (!isSeedOpeningTrack(episode, seed)) {
    episode = await repairClaudeEpisodeJson({
      content: JSON.stringify(episode),
      parseError: new Error(
        `Contrainte éditoriale: le premier titre doit être exactement ${seed.artist} - ${seed.title}.`,
      ),
    });
  }

  if (!isValidEpisode(episode) || !isSeedOpeningTrack(episode, seed)) {
    throw new Error("Format d'émission Claude invalide: le morceau choisi doit ouvrir l'émission.");
  }

  const contentIssues = validateEpisodeContentIssues(episode);
  if (contentIssues.length) {
    episode = await repairClaudeEpisodeJson({
      content: JSON.stringify(episode),
      parseError: new Error(`Problèmes éditoriaux à corriger:\n${contentIssues.join("\n")}`),
    });
  }

  return episode;
}

async function repairClaudeEpisodeJson({ content, parseError }) {
  if (!content) {
    throw parseError;
  }

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
      temperature: 0,
      system:
        "Tu répares une réponse JSON pour Sillage FM. Retourne uniquement un objet JSON valide qui respecte la contrainte donnée. Tu peux corriger titres, artistes, rôles, raisons ou chroniques si la contrainte l'exige, mais garde le même angle éditorial. Aucun markdown.",
      messages: [
        {
          role: "user",
          content: `Erreur JSON: ${parseError.message}\n\nRéponse à réparer:\n${String(content).slice(0, 14000)}`,
        },
      ],
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error?.message || "Erreur Claude réparation.");
  }

  const repairContent = payload?.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  try {
    return normalizeEpisode(parseEpisode(repairContent));
  } catch (repairError) {
    throw new Error(
      `Claude JSON invalide: ${parseError.message}. Réparation échouée: ${repairError.message}`,
    );
  }
}

function buildPrompt({ artist, title, album }, webContext = "") {
  return `
Titre choisi par l’utilisateur :
{
  "artist": "${artist}",
  "title": "${title}"
}
${album ? `Album Deezer du morceau choisi : "${album}".` : ""}
${webContext ? `\n${webContext}\n` : ""}

Tu es Sillage FM, une radio française de récit musical.

Sillage FM crée des émissions radio à partir d’un morceau choisi.
Le but n’est pas de décrire la musique.
Le but est de raconter ce qui existe au-delà du son :
l’histoire, le contexte, la tension humaine, les paroles, la scène, la production et l’impact culturel.

Langue :
- français uniquement, zéro anglicisme ;
- français parlé naturel, pas français écrit ;
- vocabulaire varié et précis — bannis "chose", "problème", "faire" et tout terme générique ;
- une idée par phrase, jamais deux ;
- attaque directe dès la première phrase, sans préambule ;
- mots simples quand ils sont plus justes ;
- ton : radio musicale cultivée, proche, alerte ;
- chaleureux, intelligent, jamais académique, jamais prétentieux ;
- vivant sans être publicitaire ;
- pas d’empilement d’adjectifs, pas de formule décorative.

Loi du français irréprochable :
- Aucune phrase d’amorce inutile : supprime "Voici", "Bien sûr", "En résumé", "Il convient de noter".
- Mots interdits : "presque", "notamment", "généralement", "semble", "peut-être", "environ", "il est important de noter".
- Sois affirmatif : pas d’adverbes de précaution, pas de conditionnels de prudence.
- Une information = une seule phrase. Aucune paraphrase, aucune répétition.
- Élimine toute phrase sans valeur informative concrète.
- Ne qualifie pas les faits avec des adjectifs subjectifs ("incroyable", "légendaire", "efficace") : décris-les.
- Processus interne avant d’écrire : extrais les faits bruts → retire 50 % des mots du brouillon → reformule pour densité maximale.
- Si une chronique peut tenir en deux phrases, elle ne doit pas en faire trois.

Ta mission :
Créer un documentaire sonore en 8 morceaux à partir du titre choisi.

Le titre choisi est la porte d’entrée. L’émission peut raconter :
- le portrait d’un artiste : son parcours, ses bascules, ses contradictions ;
- ou l’histoire d’un mouvement, d’une scène, d’un moment musical précis.

C’est toi qui choisis l’angle le plus fort selon ce que tu sais de cet artiste et de son contexte.
La seule règle : il doit y avoir une histoire à raconter, avec un début, une tension, et une résolution.

L’émission doit contenir :
- un angle narratif précis — pas un genre, une histoire ;
- 8 morceaux qui tracent ce parcours comme des chapitres ;
- une chronique avant chaque morceau, avec au moins un fait que l’auditeur ne savait pas ;
- une progression que l’auditeur ressent sans avoir lu le programme.

Règle d’or éditoriale :
Chaque morceau doit répondre à une question concrète :
"Qu’est-ce que ce morceau révèle sur cette histoire, à cet endroit précis du récit ?"

L’angle doit être concret, pas abstrait.
Évite :
- "l’évolution du rap" ;
- "le minimalisme en musique" ;
- "les morceaux qui ont tout changé".

Préfère :
- un moment précis dans la carrière ou la vie d’un artiste ;
- une scène musicale à un instant donné (Paris 1993, Compton 1988, Manchester 1979) ;
- une rencontre, une controverse, un basculement culturel daté ;
- une contradiction entre l’image publique et la réalité.

Règles pour la playlist :
- 8 titres au total ;
- le titre 1 doit être exactement le morceau sélectionné : même artiste, même titre ;
- maximum 2 autres morceaux du même artiste que le titre 1 — les 5 restants doivent être d’artistes différents ;
- les autres titres doivent servir le récit : influences, collaborations, contemporains, héritiers, ou morceaux d’une même scène selon l’angle choisi ;
- la playlist doit tracer un ARC NARRATIF lisible — chaque morceau est un chapitre, pas une illustration de genre ;
- la cohérence est narrative, pas musicale : deux morceaux peuvent sonner différemment s’ils racontent le même fil ;
- évite les titres sans lien avec le récit, même s’ils sont du même genre ou de la même époque ;
- choisis des titres assez connus pour être retrouvés via l’API Deezer.

La structure narrative est libre — c’est toi qui définis les chapitres selon l’histoire que tu racontes.
Il n’y a pas de rôles imposés. Ce qui compte : chaque morceau doit faire avancer le récit.
Le champ "reason" doit expliquer en une phrase pourquoi ce morceau appartient à cet endroit du récit.

Règles pour les chroniques :
Chaque chronique doit être écrite pour être dite à voix haute.
Objectif : 80 à 120 mots par chronique, soit 30 à 45 secondes d’antenne.
Trois à cinq phrases.
La première phrase doit être courte, moins de 14 mots si possible.
Le rythme doit être naturel, presque conversationnel, avec de l’élan.
La première phrase doit accrocher vite, sans préambule.
Alterner phrases courtes et phrases moyennes.
Évite les phrases longues avec plusieurs subordonnées.
Évite les deux-points, parenthèses, incises lourdes et mots abstraits en série.
Évite aussi le ton endormi, contemplatif ou trop solennel.

Architecture recommandée pour chaque chronique :
1. une accroche qui donne immédiatement la tension humaine ;
2. un fait concret vérifiable ou un détail de contexte ;
3. une phrase qui relie ce fait au rôle du morceau dans l’émission.

Répertoire de structures narratives :
Pour chaque chronique, choisis une structure dans ce répertoire comme point de départ.
La structure sert le récit — ne la nomme pas, ne l’explique pas : habite-la.

L’Erreur Sacrée : un accident technique (larsen, voix qui déraille) que l’artiste garde et qui devient la signature du titre.
Le Transfert : la chanson était destinée à une autre star qui l’a refusée ; l’artiste l’enregistre par dépit et décroche le tube de sa vie.
La Fausse Piste : le public adore le morceau pour son énergie joyeuse, mais le texte cache une tragédie ou une noirceur absolue.
Le Cobaye : l’artiste utilise un nouvel instrument ou une technologie qu’il ne maîtrise pas ; ce tâtonnement crée un son révolutionnaire.
La Réponse Directe : un titre écrit pour répliquer à une attaque d’un autre groupe ou d’un critique — un clash musical qui entre dans l’histoire.
Le Chant du Cygne : le groupe est sur le point de se séparer ; ils jettent leurs dernières forces dans un enregistrement final désespéré et sublime.
L’Obsession : l’artiste passe des mois à peaufiner un seul détail ; tout le monde craque en studio, mais ce détail fait le succès.
La Lettre Ouverte : le texte s’adresse directement à une personne réelle, souvent une célébrité ou un politicien, sans la nommer.
Le Déguisement : l’artiste change radicalement de style ou de nom pour sortir un disque à l’opposé de son image habituelle.
Le Vol Inconscient : une mélodie chipée à la radio ou dans un souvenir d’enfance, transformée jusqu’à devenir méconnaissable.
La Séance de Nuit : la fatigue et l’isolement des heures creuses donnent au morceau une couleur magnétique et floue.
Le Duel de Studio : la guerre entre l’ingénieur du son et l’artiste pour imposer une vision ; le disque est le résultat de ce conflit.
L’Oublié de la Pochette : le musicien de studio qui improvise le solo légendaire pour quelques billets et disparaît.
La Prophétie : les paroles décrivent un événement qui ne s’est pas encore produit, mais qui arrive quelques mois après la sortie.
Le Retour de Flamme : un titre qui subit un échec total à sa parution, avant de devenir un hymne mondial grâce au cinéma ou à la publicité.
L’Angle Mort : un détail technique ou sonore ignoré du grand public (un bruit de porte, une erreur de studio) qui devient la signature du titre.
Le Duel des Charts : comment un "petit" morceau a terrassé un monstre sacré de l’époque.
La Métamorphose : l’artiste dans un genre opposé juste avant le déclic — comment un rockeur finit par signer une ballade acoustique.
Le Flash : la création d’un tube écrit en une heure, sur un coin de table, sous la pression d’un producteur.
Le Paradoxe : une mélodie joyeuse sur un texte sombre — le public danse sur une tragédie personnelle.
Le Snapshot Géographique : une adresse précise, une rue ou une chambre d’hôtel comme point de départ.
La Note de Frais : une dette, une taxe ou une banqueroute qui force l’artiste à composer son plus grand succès pour survivre.
L’Héritage Volé : partez d’un sample actuel pour remonter à la source originale oubliée et méconnue.
Le Masque : l’artiste utilise un alter ego pour hurler une vérité qu’il n’ose pas dire en son nom propre.
Le Déclic Anodin : un moment banal (une discussion avec un enfant, un titre de journal) qui devient le refrain d’une génération.
La Séance Fantôme : une dispute entre musiciens ou un invité mystère qui change le destin du morceau.
Le Pari Perdu : personne ne croyait au titre, sauf l’artiste qui a tout misé sur une intuition.
Le Miroir Social : la chanson liée à un événement historique précis — l’artiste comme haut-parleur de son époque.
La Dernière Chance : le groupe au bord de la rupture, le contrat qui va s’arrêter, l’ultime enregistrement qui sauve tout.
L’Effet Papillon : un petit événement à l’autre bout du monde qui a fini par inspirer le titre.
Le Vol à l’Arraché : l’artiste entend un riff dans un bar, le mémorise et le transforme avant que son auteur ne réalise son potentiel.
Le Syndrome de l’Imposteur : l’artiste déteste le morceau, refuse de le sortir ; son entourage le force, créant malgré lui son plus grand classique.
Le Duel Fratricide : deux membres enregistrent leurs parties séparément ; la tension entre les deux pistes crée une énergie que l’harmonie n’aurait jamais produite.
Le Sample Fantôme : remonter d’un tube actuel à la boucle de trois secondes volée à un vieux disque de soul dont l’auteur vit dans l’anonymat.
La Mise au Banni : le morceau interdit de radio ; le scandale provoque l’hystérie et propulse les ventes sous le manteau.
L’Objet Unique : tout repose sur un instrument déniché aux puces ou un synthétiseur cassé que personne n’arrive à imiter.
La Lettre de Rupture : le texte est un message direct laissé sur un répondeur, mis en musique sans modification.
Le Naufrage Évité : la bande magnétique a failli être effacée ; le sauvetage in extremis quelques heures avant le pressage.
L’Éclair de Génie Solitaire : tout le groupe est parti manger ; le chanteur reste seul, enregistre une prise unique brute qui devient le succès.
Le Voyage Initiatique : l’artiste fuit sa ville, s’isole dans un pays étranger ; le morceau est le résultat de ce dépaysement.
Le Témoin Oculaire : l’artiste au milieu d’une émeute ou d’une révolution — le texte est un reportage en direct.
Le Message Codé : sous une chanson d’amour se cache une attaque politique ; l’artiste berne la censure avec un double sens.
Le Choc des Générations : le morceau comme ligne de front entre anciens et nouveaux, qui définit "ringard" et "branché" du jour au lendemain.
Le Scanner Social : la chanson décrit les vêtements, les habitudes et les galères d’un groupe social précis à un instant T.
La Rupture Technologique : une invention permet de créer un son physiquement impossible à produire un an plus tôt.
L’Inspiratrice Fantôme : qui est la personne réelle derrière le prénom du refrain — la muse, l’ex ou le politicien, et ce qu’il est devenu.
Le Climat Politique : une loi, une taxe ou une guerre froide comme contexte ; sans cette tension, la chanson n’aurait aucune force.
La Géographie Urbaine : le morceau appartient à un quartier précis — l’odeur du bitume, la fermeture des usines qui ont donné naissance au son.
Le Slang et l’Argot : l’origine d’une expression culte du refrain qui a fini par entrer dans le dictionnaire.
La Fin d’un Monde : le morceau sort juste avant une catastrophe ou un changement radical — la bande-son du dernier soir avant la tempête.

Écris comme une voix radio qui sait couper.
Pas comme une note de programme.
Pas comme une critique de presse.

Chaque chronique doit inclure au moins 2 catégories différentes parmi :
- contexte de sortie : date, album, moment de carrière ;
- situation de l’artiste : pression, controverse, percée, déclin, réinvention ;
- paroles : ce que la chanson dit réellement ;
- contradiction : ce qui ne s’aligne pas complètement entre image, texte, son ou contexte ;
- production : producteur, beat, sample, studio, choix d’enregistrement, choix de mix ;
- scène : ville, label, collectif, écosystème musical ;
- réception : classement, streams, certifications, réaction publique, viralité ;
- impact culturel : ce que le morceau a changé ou révélé.

Règle critique :
Chaque paragraphe doit introduire un nouveau type d’information.
Ne répète pas la même idée avec d’autres mots.
Ne répète pas l’angle principal dans chaque chronique.
N’écris pas de remplissage.

RÈGLE ABSOLUE : chaque chronique doit contenir au moins UN fait concret que la plupart des gens ne connaissent pas — une date précise, un chiffre, une anecdote vérifiable, un détail de contexte inattendu.
Si une chronique ne contient pas ce fait, elle est invalide. Réécris-la.

Chaque chronique doit répondre :
"Qu’est-ce que l’auditeur apprend ici qu’il ne savait pas avant ?"

Si une chronique peut se résumer à "ce morceau est important parce qu’il est émotionnel / réussi / unique", réécris-la.

À éviter absolument :
- éloge générique ;
- analyse abstraite ;
- phrases vagues ;
- phrases qui sonnent comme une plaquette culturelle ;
- mots qui ne vont pas ensemble ;
- métaphores jolies mais floues ;
- "ce morceau est emblématique" ;
- "l’artiste impose son univers" ;
- "une ambiance unique" ;
- "on continue le voyage" ;
- "une tension humaine" si tu ne dis pas laquelle ;
- ton de dissertation scolaire.

Exactitude :
- l’exactitude passe avant le style ;
- ne cite jamais un producteur, label, studio, musicien, sample, réalisateur, année ou lieu si tu n’es pas sûr ;
- si tu as un doute, décris une clé d’écoute vérifiable dans le son au lieu d’inventer ;
- une chronique belle mais fausse est interdite ;
- vérifie mentalement chaque nom propre avant de l’écrire ;
- exemple de vigilance : pour Rosalía / El Mal Querer, le producteur central connu est El Guincho.

Transitions entre morceaux :
Les titres 2 à 8 peuvent avoir un champ "transition" optionnel.
Ce champ est lu à voix haute après la fin du morceau précédent, avant la chronique du titre suivant.
Il doit faire exactement 1 phrase, maximum 18 mots.
Il crée un pont sonore entre deux morceaux : pourquoi on passe de l’un à l’autre.
Ne pas paraphraser la chronique suivante : la transition doit ajouter un lien, pas un résumé.
Exemple acceptable : "C’est cette rupture que Jay-Z avait anticipée trois ans plus tôt."
Exemple à éviter : "Maintenant, voici un autre morceau qui illustre l’angle de l’émission."

Format de sortie :
Retourne uniquement du JSON valide.
N’ajoute aucun commentaire, aucun markdown, aucun texte hors JSON.
Dans les valeurs textuelles du JSON, n’utilise jamais le caractère guillemet double.
Ne cite pas de paroles exactes entre guillemets.
Si tu dois rapporter une idée de paroles, paraphrase sans guillemets.
Évite les retours à la ligne à l’intérieur des champs texte.
Le champ "intro" est une ouverture antenne parlée de 28 à 42 mots. Elle pose la promesse de l’histoire — pas un résumé, pas une liste. Elle donne envie d’écouter. Elle peut commencer par un fait frappant, une date, une image concrète. C’est la première phrase que l’auditeur entend.

Schéma :
{
  "title": "string",
  "angle": "string",
  "intro": "string",
  "tracks": [
    {
      "artist": "string",
      "title": "string",
      "reason": "pourquoi ce morceau appartient à cet endroit du récit",
      "chronicle": "chronique radio française naturelle, 36 à 48 mots, directe et rythmée",
      "transition": "1 phrase max 18 mots, pont sonore vers ce titre (optionnel, absent sur le titre 1)"
    }
  ]
}

Auto-vérification avant de répondre :
Pour chaque chronique, vérifie :
- y a-t-il au moins une date précise, un album, un producteur, un label, un lieu, une controverse, un fait de classement ou un détail vérifiable ?
- contient-elle des paroles ou du contexte, pas seulement de la production ?
- évite-t-elle de répéter une autre chronique ?
- ressemble-t-elle à une vraie histoire, pas à une description ?

Si une chronique échoue, réécris-la avant de retourner le JSON.
`.trim();
}

function parseEpisode(content) {
  if (!content) {
    throw new Error("Réponse IA vide.");
  }

  const cleanContent = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(cleanContent);
  } catch (error) {
    const jsonObject = extractJsonObject(cleanContent);

    if (jsonObject) {
      return JSON.parse(jsonObject);
    }

    throw error;
  }
}

function parseJsonSafely(content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

function extractJsonObject(content) {
  const start = content.indexOf("{");

  if (start === -1) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  return "";
}

function normalizeEpisode(episode) {
  if (!episode) {
    return episode;
  }

  return {
    title: cleanText(episode.title || episode.radioTitle || ""),
    angle: cleanText(episode.angle || ""),
    intro: cleanText(episode.intro || ""),
    tracks: Array.isArray(episode.tracks)
      ? episode.tracks.map((track) => ({
          artist: cleanText(track.artist || ""),
          title: cleanText(track.title || ""),
          reason: cleanText(track.reason || ""),
          chronicle: cleanText(track.chronicle || track.chronique || ""),
          ...(track.transition ? { transition: cleanText(track.transition) } : {}),
        }))
      : episode.tracks,
  };
}

function isValidEpisode(episode) {
  return Boolean(
    episode &&
      typeof episode.title === "string" &&
      typeof episode.angle === "string" &&
      typeof episode.intro === "string" &&
      Array.isArray(episode.tracks) &&
      episode.tracks.length >= 6 &&
      episode.tracks.length <= 8 &&
      cleanText(episode.title) &&
      cleanText(episode.angle) &&
      cleanText(episode.intro) &&
      episode.tracks.every(
        (track) =>
          typeof track.artist === "string" &&
          typeof track.title === "string" &&
          typeof track.chronicle === "string" &&
          typeof track.reason === "string" &&
          cleanText(track.artist) &&
          cleanText(track.title) &&
          cleanText(track.chronicle) &&
          cleanText(track.reason),
      ),
  );
}

function validateEpisodeContentIssues(episode) {
  const FORBIDDEN = [
    "notamment", "presque", "semble", "peut-être", "environ",
    "généralement", "il est important de noter", "voici", "bien sûr",
    "en résumé", "il convient de noter", "incroyable", "légendaire",
    "emblématique", "c'est une ambiance", "on continue le voyage",
  ];
  const issues = [];

  episode.tracks.forEach((track, i) => {
    const label = `${track.artist} — ${track.title}`;
    const words = countWords(track.chronicle);

    if (words < 60) {
      issues.push(`Chronique ${i + 1} (${label}): trop courte (${words} mots, minimum 80).`);
    } else if (words > 150) {
      issues.push(`Chronique ${i + 1} (${label}): trop longue (${words} mots, maximum 120).`);
    }

    const found = FORBIDDEN.filter((w) => track.chronicle.toLowerCase().includes(w));
    if (found.length) {
      issues.push(`Chronique ${i + 1} (${label}): mots interdits — ${found.join(", ")}.`);
    }

    if (track.transition && countWords(track.transition) > 18) {
      issues.push(`Transition ${i + 1} (${label}): trop longue (${countWords(track.transition)} mots, maximum 18).`);
    }
  });

  return issues;
}

function countWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function isSeedOpeningTrack(episode, seed) {
  const firstTrack = episode?.tracks?.[0];

  if (!firstTrack) {
    return false;
  }

  return (
    comparableText(firstTrack.artist) === comparableText(seed.artist) &&
    comparableText(firstTrack.title) === comparableText(seed.title)
  );
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

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function comparableText(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isSeedFieldTooLong(value) {
  return cleanText(value).length > MAX_SEED_FIELD_LENGTH;
}

function trackKey(track) {
  return `${track.artist} ${track.title}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getAiUserMessage(error) {
  const message = String(error?.message || "");
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes("quota") ||
    lowerMessage.includes("billing") ||
    lowerMessage.includes("credit") ||
    lowerMessage.includes("balance") ||
    lowerMessage.includes("payment")
  ) {
    return "Le quota de la clé IA est épuisé. Vérifie le crédit ou la facturation du fournisseur configuré.";
  }

  if (
    lowerMessage.includes("invalid api key") ||
    lowerMessage.includes("incorrect api key") ||
    lowerMessage.includes("invalid x-api-key") ||
    lowerMessage.includes("unauthorized") ||
    lowerMessage.includes("authentication") ||
    lowerMessage.includes("auth") ||
    lowerMessage.includes("credential") ||
    lowerMessage.includes("401")
  ) {
    return "La clé IA est invalide. Vérifie la clé du fournisseur configuré dans Railway.";
  }

  if (
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("429") ||
    lowerMessage.includes("503") ||
    lowerMessage.includes("high demand") ||
    lowerMessage.includes("overloaded") ||
    lowerMessage.includes("capacity")
  ) {
    return "Le fournisseur IA est surchargé en ce moment. Réessaie dans quelques secondes.";
  }

  if (
    lowerMessage.includes("réponse finale vide") ||
    lowerMessage.includes("finish_reason=length") ||
    lowerMessage.includes("reasoning_content") ||
    lowerMessage.includes("reasoning_chars")
  ) {
    return "Le fournisseur IA a produit du raisonnement mais pas la réponse finale. Réduis le niveau de raisonnement, puis redéploie.";
  }

  if (
    lowerMessage.includes("fetch failed") ||
    lowerMessage.includes("network") ||
    lowerMessage.includes("econn") ||
    lowerMessage.includes("etimedout") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("could not resolve") ||
    lowerMessage.includes("dns")
  ) {
    return "Railway n’arrive pas à joindre le fournisseur IA. Vérifie l’URL API et réessaie.";
  }

  if (
    lowerMessage.includes("unsupported") ||
    lowerMessage.includes("invalid request") ||
    lowerMessage.includes("invalid parameter") ||
    lowerMessage.includes("unrecognized") ||
    lowerMessage.includes("bad request") ||
    lowerMessage.includes("400") ||
    lowerMessage.includes("response_format") ||
    lowerMessage.includes("thinking")
  ) {
    return "Le fournisseur IA refuse la requête actuelle. On doit ajuster le modèle ou les paramètres envoyés.";
  }

  if (
    lowerMessage.includes("model") ||
    lowerMessage.includes("not found") ||
    lowerMessage.includes("404")
  ) {
    return "Le modèle IA configuré n’est pas disponible pour cette clé.";
  }

  if (lowerMessage.includes("insufficient_system_resource")) {
    return "Le fournisseur IA est temporairement saturé. Réessaie dans quelques instants.";
  }

  if (
    lowerMessage.includes("json") ||
    lowerMessage.includes("unexpected token") ||
    lowerMessage.includes("réponse ia vide") ||
    lowerMessage.includes("format d'émission") ||
    lowerMessage.includes("format d’émission")
  ) {
    return "L’IA a répondu, mais pas dans le bon format. On doit ajuster le prompt ou le modèle.";
  }

  return "L’IA ne répond pas pour le moment.";
}

function logAiError(error) {
  const provider = safeGetAiProvider();
  const model = getAiModelName(provider);

  console.error(
    JSON.stringify({
      event: "sillage_fm_ai_error",
      provider,
      model,
      message: sanitizeErrorMessage(error),
    }),
  );
}

function safeGetAiProvider() {
  try {
    return getAiProvider();
  } catch (error) {
    return "unknown";
  }
}

function getAiModelName(provider) {
  if (provider === "deepseek") {
    return DEEPSEEK_MODEL;
  }

  if (provider === "openai") {
    return OPENAI_MODEL;
  }

  if (provider === "claude") {
    return ANTHROPIC_MODEL;
  }

  if (provider === "gemini") {
    return GEMINI_MODEL;
  }

  return "local";
}

function shouldExposeAiDebug() {
  return process.env.NODE_ENV === "development" || process.env.RADIO_CHARLIE_DEBUG_AI === "true";
}

function sanitizeErrorMessage(error) {
  return String(error?.message || error || "")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-...")
    .slice(0, 900);
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
