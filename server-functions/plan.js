const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const TAVILY_API_URL = process.env.TAVILY_API_URL || "https://api.tavily.com/search";
const AI_MAX_TOKENS = numberEnv("RADIO_CHARLIE_AI_MAX_TOKENS", 4500);
const TAVILY_TIMEOUT_MS = numberEnv("TAVILY_TIMEOUT_MS", 5500);
const TAVILY_MAX_RESULTS = clampNumber(numberEnv("TAVILY_MAX_RESULTS", 5), 1, 8);
const TAVILY_CACHE_TTL_MS = numberEnv("TAVILY_CACHE_TTL_MS", 60 * 60 * 1000);
const MAX_SEED_FIELD_LENGTH = 160;
const tavilyCache = new Map();
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
  required: ["title", "angle", "intro", "tracks"],
  properties: {
    title: { type: "string" },
    angle: { type: "string" },
    intro: { type: "string" },
    tracks: {
      type: "array",
      minItems: 8,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "artist", "title", "reason", "chronicle"],
        properties: {
          role: { type: "string", enum: PLAYLIST_ROLES },
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

  if (process.env.RADIO_CHARLIE_FREE_MODE === "true") {
    return json(200, createFreeEpisode(seed));
  }

  try {
    const episode = await createAiEpisode(seed);
    return json(200, episode);
  } catch (error) {
    logAiError(error);

    if (process.env.RADIO_CHARLIE_STRICT_AI !== "true") {
      return json(200, createFreeEpisode(seed));
    }

    return json(502, {
      error: getAiUserMessage(error),
      detail: shouldExposeAiDebug() ? sanitizeErrorMessage(error) : undefined,
    });
  }
};

async function createAiEpisode(seed) {
  const provider = getAiProvider();

  if (provider === "local") {
    return createFreeEpisode(seed);
  }

  const webContext = await createEditorialWebContext(seed);

  if (provider === "deepseek") {
    return createDeepSeekEpisode(seed, webContext);
  }

  if (provider === "openai") {
    return createOpenAiEpisode(seed, webContext);
  }

  if (provider === "claude") {
    return createClaudeEpisode(seed, webContext);
  }

  return createFreeEpisode(seed);
}

async function createEditorialWebContext(seed) {
  if (!isTavilyEnabled()) {
    return "";
  }

  const cacheKey = trackKey(seed);
  const cached = tavilyCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.context;
  }

  try {
    const payload = await searchTavily(buildTavilyQuery(seed));
    const context = formatTavilyContext(payload, seed);

    tavilyCache.set(cacheKey, {
      context,
      expiresAt: now + TAVILY_CACHE_TTL_MS,
    });
    cleanupTavilyCache(now);

    return context;
  } catch (error) {
    logTavilyError(error);

    if (process.env.RADIO_CHARLIE_STRICT_WEB === "true") {
      throw new Error(`Tavily indisponible: ${sanitizeErrorMessage(error)}`);
    }

    return "";
  }
}

function isTavilyEnabled() {
  return process.env.TAVILY_ENABLED !== "false" && Boolean(process.env.TAVILY_API_KEY);
}

function buildTavilyQuery(seed) {
  const parts = [
    `"${seed.artist}"`,
    `"${seed.title}"`,
    seed.album ? `"${seed.album}"` : "",
    "song release album producer label context lyrics meaning reception",
  ];

  return parts.filter(Boolean).join(" ").slice(0, 360);
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

  return "basic";
}

function formatTavilyContext(payload, seed) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const sourceLines = results
    .filter((result) => result?.title && result?.url && result?.content)
    .slice(0, TAVILY_MAX_RESULTS)
    .map((result, index) => {
      const title = cleanText(result.title).slice(0, 140);
      const url = cleanText(result.url).slice(0, 260);
      const content = cleanText(result.content).slice(0, 430);

      return `${index + 1}. ${title} — ${url} — ${content}`;
    });

  if (!sourceLines.length) {
    return "";
  }

  return `
Dossier web Tavily pour "${seed.artist} - ${seed.title}".
Utilise ce dossier comme garde-fou factuel, pas comme texte à réciter.
Ne cite pas les URL à l’antenne.
Si une information n’est pas confirmée ici ou par ta connaissance fiable, reste prudent.
Sources et extraits :
${sourceLines.join("\n")}
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

  if (["deepseek", "openai", "claude", "anthropic", "local"].includes(provider)) {
    return provider === "anthropic" ? "claude" : provider;
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

async function createClaudeEpisode(seed, webContext) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Configuration Claude manquante.");
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
      temperature: 0.72,
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
  const episode = normalizeEpisode(parseEpisode(content));

  if (!isValidEpisode(episode) || !isSeedOpeningTrack(episode, seed)) {
    throw new Error("Format d'émission invalide.");
  }

  return episode;
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
- français uniquement ;
- français parlé naturel, pas français écrit ;
- phrases respirables, une idée par phrase ;
- attaque directe dès la première phrase ;
- mots simples quand ils sont plus justes ;
- ton : radio musicale cultivée, proche, alerte ;
- chaleureux, intelligent, jamais académique, jamais prétentieux ;
- vivant sans être publicitaire ;
- pas d’empilement d’adjectifs, pas de formule décorative.

Ta mission :
Créer un portrait d’artiste en 8 morceaux — un documentaire sonore sur UN artiste.

Le titre choisi est le point d’entrée. C’est lui qui donne la porte.
La question n’est pas "quels morceaux vont bien ensemble ?" mais "quelle est l’histoire de cet artiste, et quels morceaux la racontent le mieux ?"

L’émission doit contenir :
- un angle humain sur cet artiste — pas son genre musical, mais un moment, une contradiction, une bascule dans sa vie ;
- 8 morceaux qui tracent son parcours comme des chapitres ;
- une chronique parlée avant chaque morceau, avec au moins un fait que l’auditeur ne savait pas ;
- une progression narrative que l’auditeur ressent sans avoir lu le programme.

Règle d’or éditoriale :
Chaque morceau doit répondre à : "À quel moment de la vie de cet artiste sommes-nous ici, et pourquoi ce morceau-là ?"

L’angle éditorial doit être humain, pas abstrait.
Évite :
- "l’évolution du rap" ;
- "le minimalisme en musique" ;
- "les morceaux qui ont tout changé".

Préfère :
- un moment de carrière précis ;
- une contradiction personnelle ;
- une blessure ou une reconquête ;
- une rencontre qui a changé la trajectoire ;
- une controverse ou un basculement public.

Règles pour la playlist — portrait d’artiste :
Le fil conducteur est l’histoire D’UN artiste. Mais la playlist peut inclure d’autres artistes quand ils éclairent cette histoire.
- 8 titres au total ;
- le titre 1 doit être exactement le morceau sélectionné : même artiste, même titre ;
- les autres titres peuvent être : d’autres morceaux du même artiste, ses influences directes, ses collaborations, ses contemporains qui contextualisent son histoire, ou ses héritiers qui montrent son impact ;
- chaque titre doit servir le portrait — la question est toujours "en quoi ce morceau éclaire-t-il l’histoire de cet artiste ?" ;
- la playlist doit tracer un ARC NARRATIF lisible : d’où il vient, ce qui l’a formé, le moment où tout a basculé, ce qu’il a produit ;
- évite les titres qui n’ont aucun lien narratif avec l’artiste central ;
- choisis des titres assez connus pour être retrouvés via l’API Deezer.

Chaque titre doit jouer un rôle précis dans le portrait, dans cet ordre exact :
1. "opener" : le morceau choisi — ouvre la porte sur qui est cet artiste ;
2. "origin" : d’où il vient — ses débuts, ses influences formatrices, sa scène d’origine ;
3. "rupture" : le moment où il a rompu avec ce qu’il était avant ;
4. "contrast" : une facette moins connue, un registre inattendu, une contradiction ;
5. "hidden influence" : ce qui l’a formé en secret — un artiste, un lieu, une rencontre ;
6. "turning point" : la bascule publique — l’album, le morceau ou l’événement qui a tout changé ;
7. "consequence" : ce que cette bascule a produit — la suite, l’impact, les héritiers ;
8. "closing statement" : où il en est — son état actuel ou son legs définitif.

Le champ "role" de chaque piste doit reprendre exactement l’un de ces 8 rôles, dans cet ordre.
Le champ "reason" doit expliquer pourquoi ce titre illustre ce chapitre précis de la vie de l’artiste.

Règles pour les chroniques :
Chaque chronique doit être écrite pour être dite à voix haute.
Objectif antenne rapide : 36 à 48 mots par chronique.
Deux ou trois phrases maximum.
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
Le champ "intro" est une ouverture antenne de 28 à 42 mots : elle pose l’angle sans résumer toute l’émission.

Schéma :
{
  "title": "string",
  "angle": "string",
  "intro": "string",
  "tracks": [
    {
      "role": "opener",
      "artist": "string",
      "title": "string",
      "reason": "pourquoi ce titre appartient à l’émission",
      "chronicle": "chronique radio française naturelle, 36 à 48 mots, directe et rythmée",
      "transition": "1 phrase max 18 mots, pont vers ce titre (optionnel, absent sur le titre 1)"
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
      ? episode.tracks.map((track, index) => ({
          role: normalizePlaylistRole(track.role, index),
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
      episode.tracks.length === 8 &&
      episode.tracks.every(
        (track, index) =>
          typeof track.artist === "string" &&
          typeof track.title === "string" &&
          typeof track.chronicle === "string" &&
          typeof track.role === "string" &&
          typeof track.reason === "string" &&
          cleanText(episode.title) &&
          cleanText(episode.angle) &&
          cleanText(episode.intro) &&
          track.role === PLAYLIST_ROLES[index] &&
          cleanText(track.artist) &&
          cleanText(track.title) &&
          cleanText(track.chronicle) &&
          cleanText(track.reason),
      ),
  );
}

function normalizePlaylistRole(role, index) {
  return PLAYLIST_ROLES.includes(role) ? role : PLAYLIST_ROLES[index] || "opener";
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

  if (lowerMessage.includes("rate limit") || lowerMessage.includes("429")) {
    return "Le fournisseur IA limite temporairement les requêtes. Réessaie dans quelques secondes.";
  }

  if (
    lowerMessage.includes("réponse finale vide") ||
    lowerMessage.includes("finish_reason=length") ||
    lowerMessage.includes("reasoning_content") ||
    lowerMessage.includes("reasoning_chars")
  ) {
    return "DeepSeek a produit du raisonnement mais pas la réponse finale. Mets DEEPSEEK_THINKING=disabled dans Railway, puis redéploie.";
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
    return "DeepSeek refuse la requête actuelle. On doit ajuster le modèle ou les paramètres envoyés.";
  }

  if (
    lowerMessage.includes("model") ||
    lowerMessage.includes("not found") ||
    lowerMessage.includes("404")
  ) {
    return "Le modèle IA configuré n’est pas disponible pour cette clé.";
  }

  if (lowerMessage.includes("insufficient_system_resource")) {
    return "DeepSeek est temporairement saturé. Réessaie dans quelques instants.";
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

function createFreeEpisode(seed) {
  const key = trackKey(seed);

  if (key.includes("rosalia") || key.includes("malamente")) {
    return buildCuratedEpisode({
      title: "Rosalía : le flamenco au moment du choc",
      angle:
        "Une traversée de l’Espagne qui cesse de choisir entre tradition, pop, rue, studio et image.",
      intro:
        "Ici, la tension n’est pas entre ancien et moderne. Elle est plus nerveuse : comment une langue très ancienne, le flamenco, supporte la caméra, le beat numérique, la célébrité globale et le récit d’une femme qui reprend la main sur sa propre mythologie.",
      tracks: [
        {
          artist: "Rosalía",
          title: "Malamente",
          reason: "Ouverture : le choc public, quand El Mal Querer transforme une intuition flamenca en événement pop.",
          chronicle:
            "Malamente arrive en 2018 comme le premier coup de marteau d’El Mal Querer. Le morceau ouvre le disque, le clip met en circulation motos, toreros, bitume et gestes de procession, et Rosalía n’a pas encore le statut mondial qu’elle aura quelques années plus tard. Ce qui frappe, c’est la contradiction : une chanson courte, presque sèche, avec des palmas et une architecture de pop contemporaine, mais qui raconte déjà le mauvais présage, la relation qui enferme, le corps qui sent le danger avant de pouvoir le nommer. El Guincho est au centre de cette production avec Rosalía : le son ne cherche pas à imiter un tableau flamenco, il découpe l’espace, laisse les mains claquer, pose la voix très près, comme si l’intime devenait une affaire publique.",
        },
        {
          artist: "Camarón de la Isla",
          title: "La Leyenda del Tiempo",
          reason: "Origine : le précédent historique qui prouve que le scandale peut devenir patrimoine.",
          chronicle:
            "En 1979, Camarón publie La Leyenda del Tiempo et une partie du public flamenco reçoit le disque comme une provocation. Basse électrique, batterie, poésie de Federico García Lorca, arrangements ouverts : le disque déplace la frontière de ce qu’un chanteur flamenco peut se permettre. Ce n’est pas un simple ancêtre noble placé là pour faire savant. C’est une mémoire de la rupture. Rosalía arrive dans une Espagne où cette blessure a déjà existé : le moment où l’on accuse un artiste de trahir une tradition, avant de reconnaître que cette trahison l’a aussi maintenue vivante. Le morceau rappelle que la modernisation du flamenco n’a jamais été douce ; elle s’est toujours jouée dans la dispute.",
        },
        {
          artist: "Rosalía",
          title: "Pienso En Tu Mirá",
          reason: "Rupture : le langage amoureux devient surveillance, menace et mise en scène du contrôle.",
          chronicle:
            "Pienso En Tu Mirá pousse El Mal Querer vers un endroit plus dur. Le morceau parle de jalousie, mais pas comme un sentiment romantique : comme un système de contrôle. Le refrain insiste sur le regard, sur ce que l’autre imagine, surveille, anticipe. Dans le clip, l’imagerie devient presque industrielle : camions, hommes armés, symboles religieux, gestes de séduction et de menace. Musicalement, la production garde la précision sèche des palmas et des voix empilées, mais l’ensemble avance comme une mécanique. C’est une rupture importante dans le parcours : Rosalía ne chante pas seulement une peine, elle montre comment une relation peut devenir décor, économie, spectacle et piège.",
        },
        {
          artist: "Las Grecas",
          title: "Te Estoy Amando Locamente",
          reason: "Contraste : deux sœurs gitanes dans l’Espagne des années 70, la rue et l’électricité avant la pop globale.",
          chronicle:
            "Te Estoy Amando Locamente sort en 1974 et porte une autre forme de mélange : rumba, rock, guitares électriques, voix gitanes, radio populaire. Las Grecas n’ont pas le même dispositif que Rosalía, pas la même époque, pas la même stratégie visuelle, mais elles rappellent qu’en Espagne la modernité musicale passe aussi par des femmes qui font entrer la rue dans la pop. Le morceau est frontal, presque insolent dans sa manière de répéter l’obsession amoureuse. Le contraste est précieux : là où Rosalía organise chaque image avec une précision d’école d’art, Las Grecas font entendre une énergie plus brute, plus sociale, une modernité qui vient d’abord du frottement entre quartier, radio et scène.",
        },
        {
          artist: "Lole y Manuel",
          title: "Todo Es De Color",
          reason: "Influence cachée : la douceur psychédélique andalouse, moins spectaculaire mais essentielle.",
          chronicle:
            "Todo Es De Color appartient à cette Andalousie des années 70 où le flamenco dialogue avec la contre-culture sans toujours le dire frontalement. Lole Montoya et Manuel Molina ouvrent un espace plus mystique, plus lumineux, presque suspendu. Leur importance tient à une autre manière d’être moderne : pas seulement ajouter des machines ou de l’électricité, mais changer la respiration, laisser la voix flotter, faire de la tradition un paysage intérieur. Dans une émission autour de Rosalía, ce titre évite de réduire l’influence à la rupture violente. Il montre une filiation plus secrète : la possibilité d’un flamenco qui s’élargit sans perdre son centre émotionnel.",
        },
        {
          artist: "Rosalía",
          title: "Con Altura",
          reason: "Point de bascule : la chanteuse quitte le cadre du manifeste et entre dans la pop mondiale.",
          chronicle:
            "Con Altura paraît en 2019 avec J Balvin et El Guincho, et change la taille de l’histoire. Après El Mal Querer, Rosalía aurait pu rester dans le rôle de l’artiste conceptuelle adoubée par la critique. Elle choisit un morceau de club, court, brillant, répétitif, bâti pour circuler vite. La référence au reggaeton et à la culture latino globale déplace les soupçons : après l’accusation de toucher au flamenco, voici l’artiste qui refuse d’être assignée à un musée. Le morceau révèle une stratégie : ne pas défendre son sérieux en ralentissant, mais prouver que l’intelligence peut aussi passer par la vitesse, le refrain et la chorégraphie.",
        },
        {
          artist: "C. Tangana",
          title: "Tú Me Dejaste De Querer",
          reason: "Conséquence : la pop espagnole comprend qu’elle peut redevenir locale sans renoncer au marché mondial.",
          chronicle:
            "Quand C. Tangana sort Tú Me Dejaste De Querer en 2020, avec La Húngara et Niño de Elche, on entend une conséquence culturelle du moment Rosalía : l’Espagne pop n’a plus besoin de cacher ses références locales pour paraître contemporaine. Rumba, mélancolie populaire, production très nette, clip de grande circulation : le morceau assume un langage espagnol, presque sentimental, mais avec une finition globale. Ce n’est pas une imitation de Rosalía ; c’est plutôt le signe que le centre de gravité a bougé. Après El Mal Querer, le folklore n’est plus seulement un patrimoine à protéger ou un costume à éviter : il devient un matériau pop majeur.",
        },
        {
          artist: "Rosalía",
          title: "Sakura",
          reason: "Dernier mot : après l’ascension, la lucidité sur la gloire, la scène et ce qui fane.",
          chronicle:
            "Sakura ferme Motomami en 2022 avec une idée presque anti-triomphale. Rosalía y chante la beauté brève, la fleur qui tombe, le concert comme moment qui existe puis disparaît. Après les motos, les clips, les débats et les tubes, ce morceau remet la voix au centre, dans une forme dépouillée, presque vulnérable. C’est une conclusion juste parce qu’elle ne célèbre pas simplement la victoire. Elle rappelle que l’artiste qui a transformé son image en langage sait aussi que toute image s’use. La trajectoire se referme sur une tension humaine : devenir immense sans croire que l’immensité protège de la fin.",
        },
      ],
    });
  }

  if (key.includes("daft punk") || key.includes("veridis quo")) {
    return buildCuratedEpisode({
      title: "Daft Punk : la mélancolie derrière la machine",
      angle:
        "Une émission sur les robots qui ont compris que la technologie française pouvait parler de mémoire, de corps et de disparition.",
      intro:
        "Veridis Quo n’est pas seulement une belle boucle de Discovery. C’est une porte entrouverte sur le versant le plus étrange de Daft Punk : le moment où la machine danse moins qu’elle ne se souvient.",
      tracks: [
        {
          artist: "Daft Punk",
          title: "Veridis Quo",
          reason: "Ouverture : le morceau installe le cœur de l’épisode, une électronique française presque funèbre sous ses habits lumineux.",
          chronicle:
            "Veridis Quo sort en 2001 sur Discovery, l’album où Daft Punk transforme la house filtrée en grande machine pop. Le morceau est instrumental, répétitif, presque processionnel. Rien n’y cherche l’explosion : le motif tourne, avance, revient, comme une marche lente dans un décor de science-fiction intime. C’est une contradiction précieuse chez Daft Punk : le duo porte des casques, fabrique une mythologie robotique, mais touche souvent quelque chose de très humain, le souvenir, la perte, la naïveté. Dans Discovery, entouré de tubes beaucoup plus directs, Veridis Quo joue le rôle du couloir secret.",
        },
        {
          artist: "Kraftwerk",
          title: "Computer Love",
          reason: "Origine : la matrice européenne où la machine devient langage sentimental.",
          chronicle:
            "Computer Love paraît en 1981 sur Computer World. Kraftwerk y installe une idée décisive : l’ordinateur n’est pas seulement froid, il peut devenir le décor d’une solitude amoureuse. La mélodie est simple, presque enfantine, mais le dispositif est radical pour l’époque : voix tenue à distance, synthétiseurs, rythme programmé, émotion filtrée. Pour comprendre Veridis Quo, il faut passer par là : cette tradition européenne où la technologie ne sert pas seulement à faire danser, mais à donner une forme neuve au manque. Daft Punk héritera de cette grammaire, en la rendant plus pop, plus française, plus cinématographique.",
        },
        {
          artist: "Giorgio Moroder",
          title: "Chase",
          reason: "Rupture : la disco quitte la chanson et devient moteur de film, vitesse pure.",
          chronicle:
            "Chase est composé par Giorgio Moroder pour le film Midnight Express en 1978. Ici, la machine ne rêve pas encore : elle poursuit. Le morceau réduit la disco à une tension motorique, synthétiseurs en avant, pulsation fixe, sensation de fuite. C’est une rupture parce qu’il montre comment l’électronique peut devenir narration sans paroles. Daft Punk retiendra beaucoup de cette leçon : un motif peut suffire à créer un monde, un rythme peut devenir scénario. Là où Veridis Quo ralentit la machine, Chase en révèle le nerf initial, cette promesse de cinéma qui traverse ensuite toute la French touch.",
        },
        {
          artist: "Air",
          title: "La femme d'argent",
          reason: "Contraste : une autre France électronique, plus domestique, plus sensuelle, moins masquée.",
          chronicle:
            "La femme d’argent ouvre Moon Safari en 1998. Air vient de Versailles, comme Daft Punk vient de la banlieue parisienne, mais le geste est presque opposé : pas de robot, pas de club frontal, plutôt une lenteur luxueuse, basse ronde, claviers, respiration lounge. Ce contraste est important. À la fin des années 90, la France électronique ne raconte pas une seule histoire. Elle peut être filtrée, ironique, dansante, ou au contraire cotonneuse et contemplative. Air montre le côté salon, velours, lumière basse ; Daft Punk garde le casque et la mythologie. Les deux prouvent que la France peut exporter une sensibilité, pas seulement un son.",
        },
        {
          artist: "Cerrone",
          title: "Supernature",
          reason: "Influence cachée : la piste française disco où le futur arrive par le corps avant d’arriver par les robots.",
          chronicle:
            "Supernature sort en 1977 et rappelle que la modernité électronique française ne commence pas avec les années 90. Cerrone pense la disco comme une machine spectaculaire : batterie large, synthés, sensualité assumée, science-fiction dansante. Les paroles imaginent une nature modifiée, presque inquiétante, ce qui donne au morceau une couleur étrange derrière l’efficacité du groove. Pour Daft Punk, cette généalogie compte : le corps et le futur ne sont pas séparés. Avant les casques, avant les vocoders de Discovery, il y a cette idée française d’une piste de danse où la technologie devient décor mental.",
        },
        {
          artist: "Daft Punk",
          title: "One More Time",
          reason: "Point de bascule : le filtre devient langage mondial, pas simple effet de club.",
          chronicle:
            "One More Time paraît en 2000 et prépare l’arrivée de Discovery. Avec la voix de Romanthony fortement traitée, Daft Punk transforme un outil de production en émotion collective. Le morceau peut sembler euphorique, mais il garde une ambiguïté : cette joie est compressée, filtrée, presque irréelle. C’est le basculement où le duo cesse d’être seulement un nom majeur de la house française pour devenir une mythologie pop mondiale. Le morceau dit aussi quelque chose d’essentiel sur eux : la fête n’est jamais totalement naturelle, elle est fabriquée, montée, répétée, et c’est précisément cette fabrication qui touche.",
        },
        {
          artist: "Justice",
          title: "D.A.N.C.E.",
          reason: "Conséquence : une génération française reprend la puissance graphique et pop ouverte par Daft Punk.",
          chronicle:
            "D.A.N.C.E. sort en 2007 sur le label Ed Banger, avec Justice comme héritiers turbulents d’un monde que Daft Punk a rendu possible. La filiation n’est pas seulement sonore ; elle est aussi visuelle, graphique, presque publicitaire. Le morceau regarde vers Michael Jackson, vers le chœur enfantin, vers la saturation rock, et transforme l’électronique française en objet pop immédiatement reconnaissable. Après Daft Punk, il devient possible pour un duo français de penser en clips, logos, pochettes, refrains mondiaux. Justice montre la conséquence : la French touch n’est plus seulement une scène de club, c’est une esthétique exportable.",
        },
        {
          artist: "Daft Punk",
          title: "Touch",
          reason: "Dernier mot : la machine finit par avouer qu’elle cherchait une émotion presque humaine.",
          chronicle:
            "Touch paraît en 2013 sur Random Access Memories, avec Paul Williams, et ressemble à un testament avant l’heure. Le morceau est excessif, théâtral, presque comédie musicale cosmique. Après des années à perfectionner le robot, Daft Punk y laisse entrer une fragilité très directe : le besoin du contact, du toucher, de la mémoire incarnée. C’est le dernier mot idéal après Veridis Quo, parce qu’il révèle le secret du duo. Derrière les machines, derrière les samples, derrière le contrôle absolu de l’image, il y avait une vieille question : comment fabriquer de l’humain avec des outils qui semblent faits pour le masquer ?",
        },
      ],
    });
  }

  if (key.includes("massive attack") || key.includes("teardrop")) {
    return buildCuratedEpisode(createMassiveAttackEpisode(seed));
  }

  return buildCuratedEpisode(createMassiveAttackEpisode(seed));
}

function createMassiveAttackEpisode(seed) {
  return {
    title: `${seed.title} : Bristol, la douceur sous pression`,
    angle:
      "Une émission sur des musiques qui murmurent, mais qui viennent de villes, de studios et d’époques traversés par la tension.",
    intro:
      "Ici, la nuit n’est pas une ambiance. C’est une méthode : ralentir le tempo, rapprocher les voix, laisser la basse raconter ce que les paroles ne disent pas encore.",
    tracks: [
      {
        artist: seed.artist,
        title: seed.title,
        reason: "Ouverture : la voix fragile et le battement retenu installent immédiatement le conflit entre beauté et menace.",
        chronicle: `${seed.title} tient sur une contradiction rare : tout semble doux, mais rien n’est vraiment apaisé. Chez Massive Attack, surtout à l’époque de Mezzanine en 1998, la lenteur n’est pas décorative ; elle devient une pression. La voix d’Elizabeth Fraser, connue pour son travail avec Cocteau Twins, flotte au-dessus d’une pulsation qui avance comme un cœur inquiet. Ce que l’on entend, c’est une manière très britannique de transformer l’intime en architecture sonore : peu de gestes, beaucoup d’espace, et cette impression que la chanson regarde quelque chose qu’elle ne peut pas réparer.`,
      },
      {
        artist: "Massive Attack",
        title: "Unfinished Sympathy",
        reason: "Origine : Bristol avant l’ombre totale, quand le collectif invente une soul urbaine et orchestralement immense.",
        chronicle:
          "Unfinished Sympathy sort en 1991 sur Blue Lines, premier album de Massive Attack. Le groupe vient de l’écosystème du Wild Bunch à Bristol, une scène de sound systems, de hip-hop, de dub, de reggae et de culture club. Avec la voix de Shara Nelson et les cordes arrangées par Wil Malone, le morceau refuse déjà les cases : ce n’est ni simplement de la soul, ni du rap, ni de la dance. C’est une ville entière qui ralentit pour trouver sa gravité. Cette origine compte parce qu’elle montre que la noirceur de Mezzanine n’arrive pas de nulle part : elle vient d’un collectif qui a toujours cherché à faire tenir la rue, le studio et la blessure dans un même espace.",
      },
      {
        artist: "Tricky",
        title: "Black Steel",
        reason: "Rupture : Bristol devient plus claustrophobe, plus politique, plus dangereux.",
        chronicle:
          "Black Steel paraît sur Maxinquaye en 1995. Tricky reprend Black Steel in the Hour of Chaos de Public Enemy, mais au lieu d’en faire un manifeste frontal, il l’enferme dans une chambre enfumée, avec Martina Topley-Bird en voix centrale. La rupture est là : le rap de combat américain devient, à Bristol, une paranoïa intime. Le morceau garde la charge politique du texte, l’idée d’un corps noir face à l’État, mais il change la température. La production avance de travers, sèche, presque malade. Pour l’épisode, c’est le moment où la ville cesse d’être seulement un creuset élégant : elle devient un lieu mental où l’oppression se respire.",
      },
      {
        artist: "Portishead",
        title: "Roads",
        reason: "Contraste : une autre réponse de Bristol, moins collective, plus nue, presque immobile.",
        chronicle:
          "Roads sort sur Dummy en 1994. Portishead partage avec Massive Attack un territoire, Bristol, et un goût pour les tempos lents, mais Beth Gibbons ne chante pas comme une voix invitée dans un paysage. Elle semble seule au milieu de la pièce. Les cordes, l’orgue, la batterie retenue : tout laisse de la place à une fatigue presque physique. Le contraste est essentiel. Massive Attack construit souvent une architecture de voix et de textures ; Portishead donne l’impression que le décor s’est vidé et qu’il ne reste qu’une personne face à son propre vertige. La même ville, deux façons de faire entendre l’après-coup.",
      },
      {
        artist: "Isaac Hayes",
        title: "Ike's Rap II",
        reason: "Influence cachée : la soul orchestrale et parlée qui irrigue plusieurs ombres du trip-hop.",
        chronicle:
          "Ike’s Rap II date de 1971, sur l’album Black Moses d’Isaac Hayes. C’est un morceau qui parle plus qu’il ne chante d’abord, avec cette voix grave, lente, enveloppée par les cordes. Son importance dans cette émission tient à sa vie souterraine : ce type de soul cinématographique, ample, sensuelle, a nourri la grammaire du trip-hop, jusque dans l’usage des boucles et des climats. On comprend ici que Bristol ne surgit pas seulement du hip-hop ou du dub ; la ville recycle aussi une mémoire soul, des introductions parlées, des orchestrations qui installent un drame avant même que le refrain existe.",
      },
      {
        artist: "Massive Attack",
        title: "Angel",
        reason: "Point de bascule : Mezzanine fait entrer le groupe dans une noirceur plus massive, presque rock.",
        chronicle:
          "Angel ouvre Mezzanine en 1998 et change immédiatement la masse du groupe. Horace Andy chante, mais autour de lui la basse devient énorme, la guitare plus menaçante, le mix plus opaque. Ce n’est plus la soul panoramique de Blue Lines : c’est un bâtiment noir qui avance lentement. Le morceau marque aussi une période de tension interne pour Massive Attack, avec des désaccords artistiques autour de l’album et une esthétique plus dure. Angel sert de point de bascule parce qu’il annonce que la beauté de Teardrop ne sera pas décorative. Sur Mezzanine, même les moments les plus lumineux semblent traversés par une ombre industrielle.",
      },
      {
        artist: "Burial",
        title: "Archangel",
        reason: "Conséquence : Londres reprend l’héritage nocturne et le transforme en fantôme post-rave.",
        chronicle:
          "Archangel sort en 2007 sur Untrue, disque central de Burial. On n’est plus à Bristol, mais le lien est culturel : même goût pour les voix fantomatiques, les rythmes ralentis par la mémoire, les villes entendues la nuit. Burial vient après le garage, après la rave, après l’euphorie collective ; il fait sonner la fête comme un souvenir abîmé. Là où Massive Attack sculptait une lenteur dub et soul, Burial travaille les craquements, les voix pitchées, les bruits de rue. C’est une conséquence, pas une copie : la mélancolie urbaine a changé de décennie, de ville et de technologie.",
      },
      {
        artist: "The xx",
        title: "Angels",
        reason: "Dernier mot : la grande architecture nocturne se réduit à presque rien, une voix, une guitare, un aveu.",
        chronicle:
          "Angels ouvre Coexist en 2012. Après Bristol, après Mezzanine, après Burial, The xx proposent une conclusion par retrait. Le morceau est presque nu : guitare claire, voix de Romy, espace immense autour de chaque note. Ce qui relie ce titre à l’épisode, ce n’est pas le genre, mais une conséquence émotionnelle : la musique britannique nocturne a appris qu’elle pouvait être intense en disant moins. Angels ferme le parcours parce qu’il enlève la basse monumentale, les samples, l’épaisseur du studio, et garde l’idée centrale : une intimité très simple peut devenir immense si le silence autour d’elle est bien réglé.",
      },
    ],
  };
}

function buildCuratedEpisode(episode) {
  return {
    ...episode,
    tracks: episode.tracks.slice(0, 8).map((track, index) => ({
      ...track,
      role: PLAYLIST_ROLES[index],
    })),
  };
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
