const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const CLAUDE_FALLBACK_MODELS = [
  ANTHROPIC_MODEL,
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest",
].filter((model, index, models) => model && models.indexOf(model) === index);
const AI_MAX_TOKENS = Number(process.env.RADIO_CHARLIE_AI_MAX_TOKENS || 5200);
const configuredAiAttempts = Number(process.env.RADIO_CHARLIE_AI_ATTEMPTS || 2);
const AI_ATTEMPTS = Number.isFinite(configuredAiAttempts)
  ? Math.max(1, Math.min(3, configuredAiAttempts))
  : 2;
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
  "Tu es Radio Charlie, une rédaction musicale française exigeante. Tu ne produis jamais de généralités promotionnelles : tu fabriques des chroniques radio avec anecdotes, dates, contexte historique, faits vérifiables, paroles, production, réception et conséquences culturelles. Ton style est oral, vivant, précis, jamais scolaire, jamais vague. Tu réponds uniquement en JSON valide.";

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
  const hasAiProvider = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

  if (!artist || !title) {
    return json(400, { error: "artist et title sont requis." });
  }

  if (!hasAiProvider) {
    return json(500, {
      error: "Aucune IA n’est configurée. Ajoute ANTHROPIC_API_KEY ou OPENAI_API_KEY.",
    });
  }

  try {
    const episode = process.env.ANTHROPIC_API_KEY
      ? await createClaudeEpisode(seed)
      : await createOpenAiEpisode(seed);
    return json(200, episode);
  } catch (error) {
    return json(502, {
      error: getAiUserMessage(error),
      detail: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

async function createOpenAiEpisode(seed) {
  return createEpisodeWithQualityRetry((attempt) => requestOpenAiEpisode(seed, attempt));
}

async function requestOpenAiEpisode(seed, attempt) {
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
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "radio_charlie_episode",
          strict: true,
          schema: EPISODE_SCHEMA,
        },
      },
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildPrompt(seed, attempt),
        },
      ],
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error?.message || "Erreur OpenAI.");
  }

  const content = payload?.choices?.[0]?.message?.content;
  return normalizeEpisode(parseEpisode(content));
}

async function createClaudeEpisode(seed) {
  let lastError;

  for (const useWebSearch of [true, false]) {
    for (const model of CLAUDE_FALLBACK_MODELS) {
      try {
        return await createEpisodeWithQualityRetry((attempt) =>
          requestClaudeEpisode(seed, attempt, model, { useWebSearch }),
        );
      } catch (error) {
        lastError = error;

        if (!isClaudeFallbackError(error)) {
          throw error;
        }
      }
    }
  }

  throw lastError || new Error("Modèle Claude indisponible.");
}

async function requestClaudeEpisode(seed, attempt, model, options = {}) {
  const tools = options.useWebSearch
    ? [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 3,
        },
      ]
    : undefined;

  const response = await fetch(ANTHROPIC_API_URL, {
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
      ...(tools ? { tools } : {}),
      messages: [
        {
          role: "user",
          content: buildPrompt(seed, attempt, { useWebSearch: options.useWebSearch }),
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

  return normalizeEpisode(parseEpisode(content));
}

async function createEpisodeWithQualityRetry(createEpisode) {
  let lastError;
  let lastCompleteEpisode;

  for (let attempt = 1; attempt <= AI_ATTEMPTS; attempt += 1) {
    try {
      const episode = await createEpisode(attempt);

      if (isValidEpisode(episode)) {
        return episode;
      }

      if (isCompleteEpisode(episode)) {
        lastCompleteEpisode = episode;
      }

      lastError = new Error(QUALITY_ERROR_MESSAGE);
    } catch (error) {
      lastError = error;

      if (!isRetryableGenerationError(error)) {
        throw error;
      }
    }
  }

  if (lastCompleteEpisode) {
    return lastCompleteEpisode;
  }

  throw lastError || new Error(QUALITY_ERROR_MESSAGE);
}

function buildPrompt({ artist, title, album }, attempt = 1, options = {}) {
  const researchRules = options.useWebSearch
    ? `
Règles de recherche web obligatoires :
- avant d’écrire les chroniques, utilise web_search ;
- cherche des informations factuelles sur l’artiste et le morceau choisi ;
- cherche le contexte de production, l’album, l’année, les collaborateurs, la réception, les paroles ou la scène associée ;
- utilise uniquement des faits trouvés dans les résultats ou des connaissances générales très établies ;
- si la recherche ne donne rien d’utile, reste prudent et général, n’invente jamais ;
- ne raconte pas tes recherches dans la réponse finale : retourne uniquement le JSON demandé.
`
    : "";

  return `
Titre choisi par l’utilisateur :
{
  "artist": "${artist}",
  "title": "${title}"
}
${album ? `Album Deezer du morceau choisi : "${album}".` : ""}
${attempt > 1 ? "IMPORTANT : la version précédente a été refusée car elle manquait de faits concrets. Recommence avec plus de dates, de contexte de sortie, de paroles, de production, de réception et d’anecdotes vérifiables dans chaque chronique." : ""}
${researchRules}

Tu es Radio Charlie, un moteur premium français de récit musical.

Radio Charlie crée des podcasts musicaux intelligents à partir d’un morceau choisi.
Le but n’est pas de décrire la musique.
Le but est de raconter ce qui existe au-delà du son :
l’histoire, le contexte, la tension humaine, les paroles, la scène, la production et l’impact culturel.

Niveau éditorial attendu :
- vise une vraie chronique documentée, pas une ambiance ;
- chaque intervention doit contenir des faits que l’auditeur pourrait vérifier ;
- cherche l’anecdote, le détail de studio, le moment de carrière, la réception, le malentendu public, la scène locale, la date qui change tout ;
- si tu n’as qu’une impression esthétique à dire, choisis un autre titre ou un autre angle.

Langue :
- français uniquement ;
- français parlé naturel ;
- dense, vivant, précis ;
- ton : France Culture + Radio Nova + Arte ;
- chaleureux, intelligent, jamais académique, jamais prétentieux.

Ta mission :
Créer un podcast éditorial complet en 8 titres.

Le titre choisi n’est pas forcément le sujet central.
Il sert de premier signal : à toi d’en tirer le parcours humain le plus intéressant.

Le podcast doit contenir :
- une playlist de 8 titres ;
- une chronique éditoriale riche avant chaque titre ;
- chaque chronique doit apprendre quelque chose de concret : une anecdote, un fait, une date, une relation artistique, une controverse ou un contexte de sortie ;
- chaque chronique doit apporter des informations nouvelles, sans répéter une autre chronique.

Règles pour l’angle éditorial :
L’angle doit être humain, pas abstrait.
Évite les angles vagues comme :
- "l’évolution du rap" ;
- "le minimalisme en musique" ;
- "les morceaux qui ont tout changé".

Préfère les angles liés à :
- un moment de carrière ;
- une contradiction ;
- une scène ;
- une tension personnelle ;
- un basculement culturel ;
- une controverse publique ;
- un changement dans la façon dont les artistes parlent, écrivent, enregistrent ou existent publiquement.

Règles pour la playlist :
- 8 titres au total ;
- le titre 1 doit généralement être le morceau sélectionné ;
- la playlist doit être culturellement cohérente ;
- privilégie la même langue, la même scène, la même époque ou une scène voisine clairement justifiée ;
- ne saute pas au hasard du rap français au rap américain, ou d’une scène à une autre, sans que l’angle l’explique clairement ;
- chaque titre doit avoir une raison éditoriale précise d’être là, qui doit se comprendre dans sa chronique ;
- évite les playlists génériques de "même genre" ;
- choisis des titres assez connus ou disponibles pour être retrouvés via l’API Deezer.

La playlist doit donner l’impression d’être pensée par un grand disquaire :
- cohérence d’ensemble ;
- surprise réelle, mais justifiée ;
- pertinence culturelle ;
- progression émotionnelle ;
- logique éditoriale lisible.

Chaque titre doit jouer un rôle précis dans le parcours, dans cet ordre exact :
1. "opener" : ouvre la porte et pose le trouble humain ;
2. "origin" : montre une source, une scène, une méthode ou une blessure initiale ;
3. "rupture" : introduit une cassure, une prise de risque ou un déplacement ;
4. "contrast" : éclaire l’angle par une opposition de ton, d’époque, de statut ou de langage ;
5. "hidden influence" : révèle une influence moins évidente, un souterrain, une dette ou un cousinage ;
6. "turning point" : marque le moment où quelque chose bascule publiquement ou artistiquement ;
7. "consequence" : montre ce que cette bascule produit ensuite ;
8. "closing statement" : ferme le podcast avec une idée forte, pas seulement avec un morceau calme.

Le champ "role" de chaque piste doit reprendre exactement l’un de ces 8 rôles, dans cet ordre.
Règles pour les chroniques :
Chaque chronique doit être dense, utile et assez développée pour porter une vraie écoute radio.
Objectif MVP privé : 120 à 170 mots par chronique.
Chaque chronique doit ressembler à un mini-récit oral, pas à une notice : une accroche humaine, une anecdote ou tension concrète, deux faits précis, puis une idée qui donne envie d’écouter le morceau autrement.

Structure obligatoire de chaque chronique :
1. une phrase d’accroche qui pose un moment, une scène ou une tension ;
2. au moins deux faits précis, dont au moins une date, une année ou une période claire ;
3. un détail de contexte parmi production, label, studio, clip, paroles, réception, classement, controverse, sample, collaboration ou scène locale ;
4. une conclusion qui explique pourquoi ce morceau sert le parcours éditorial.

Chaque chronique doit inclure au moins 4 catégories différentes parmi :
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
Privilégie les détails qui donnent de la chair : une époque, une scène, une tension biographique, une réception publique, un choix de studio, une phrase ou idée des paroles.

À rechercher explicitement :
- les dates de sortie, albums, labels, producteurs, studios, villes, scènes, collectifs ;
- les anecdotes de création ou de réception ;
- les paroles ou idées précises de la chanson ;
- les controverses, malentendus, accusations, ruptures de carrière, bascules de public ;
- les liens entre artistes : influence réelle, collaboration, opposition, héritage ou réponse culturelle.

Exemples de niveau de précision attendu :
- pas "le morceau révèle une époque", mais "en 1998, sur l’album concerné, le groupe durcit son son au moment où les tensions internes deviennent visibles" ;
- pas "la chanson est intime", mais "le texte parle d’une surveillance amoureuse, et le clip transforme cette jalousie en décor concret" ;
- pas "la production est moderne", mais "les percussions, la voix très proche et les choix de mix déplacent une tradition vers une architecture pop sèche".

Chaque chronique doit répondre :
"Qu’est-ce que l’auditeur apprend ici qu’il ne savait pas avant ?"

Si une chronique peut se résumer à "ce morceau est important parce qu’il est émotionnel / réussi / unique", réécris-la.

À éviter absolument :
- éloge générique ;
- analyse abstraite ;
- phrases vagues ;
- "ce morceau est emblématique" ;
- "l’artiste impose son univers" ;
- "une ambiance unique" ;
- "on continue le voyage" ;
- ton de dissertation scolaire.

Exactitude :
- l’exactitude passe avant le style ;
- ne cite jamais un producteur, label, studio, musicien, sample, réalisateur, année ou lieu si tu n’es pas sûr ;
- si tu as un doute, décris une clé d’écoute vérifiable dans le son au lieu d’inventer ;
- une chronique belle mais fausse est interdite ;
- vérifie mentalement chaque nom propre avant de l’écrire.

Format de sortie :
Retourne uniquement du JSON valide.
N’ajoute aucun commentaire, aucun markdown, aucun texte hors JSON.

Schéma :
{
  "title": "string",
  "tracks": [
    {
      "role": "opener",
      "artist": "string",
      "title": "string",
      "chronicle": "chronique orale française riche, documentée, 120 à 170 mots"
    }
  ]
}

Auto-vérification avant de répondre :
Pour chaque chronique, vérifie :
- y a-t-il au moins une date, année ou période claire ?
- y a-t-il au moins deux détails concrets parmi album, producteur, label, lieu, scène, clip, paroles, controverse, fait de classement, réception ou détail vérifiable ?
- y a-t-il une anecdote ou une tension humaine identifiable ?
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

  return JSON.parse(
    content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, ""),
  );
}

function normalizeEpisode(episode) {
  if (!episode) {
    return episode;
  }

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
          chronicle: track.chronicle || track.chronique || "",
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
  const hasDate = /\b(?:19|20)\d{2}\b|\bannées?\s+(?:60|70|80|90|2000|2010|2020)\b/i.test(text);
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
    /\bscène\b/i,
    /\bcollectif\b/i,
    /\bville\b/i,
    /\bsort(?:i|ie|ent)\b/i,
    /\bpubl(?:ie|ié|iée)\b/i,
  ].filter((pattern) => pattern.test(text)).length;

  return wordCount >= 90 && hasDate && concreteSignals >= 2;
}

function isRetryableGenerationError(error) {
  const message = String(error?.message || "").toLowerCase();

  return (
    message.includes("qualité éditoriale") ||
    message.includes("réponse ia vide") ||
    message.includes("json") ||
    message.includes("unexpected token")
  );
}

function isClaudeFallbackError(error) {
  const message = String(error?.message || "").toLowerCase();

  return (
    message.includes("model") ||
    message.includes("not available") ||
    message.includes("not found") ||
    message.includes("does not exist") ||
    message.includes("web_search") ||
    message.includes("web search") ||
    message.includes("tool")
  );
}

function normalizePlaylistRole(role, index) {
  return PLAYLIST_ROLES.includes(role) ? role : PLAYLIST_ROLES[index] || "opener";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function getAiUserMessage(error) {
  const message = String(error?.message || "");
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("quota") || lowerMessage.includes("billing")) {
    return "Le quota de la clé IA est épuisé. Vérifie le crédit ou la facturation du compte.";
  }

  if (
    lowerMessage.includes("invalid api key") ||
    lowerMessage.includes("incorrect api key") ||
    lowerMessage.includes("invalid x-api-key")
  ) {
    return "La clé IA est invalide. Vérifie ANTHROPIC_API_KEY ou OPENAI_API_KEY.";
  }

  if (lowerMessage.includes("web_search") || lowerMessage.includes("web search")) {
    return "La recherche web Claude n’est pas activée pour cette clé. Active Web Search dans la console Anthropic.";
  }

  if (lowerMessage.includes("model")) {
    return "Le modèle IA configuré n’est pas disponible pour cette clé.";
  }

  if (lowerMessage.includes("qualité éditoriale")) {
    return "L’IA a produit un podcast trop pauvre en faits. Relance la génération pour obtenir une version plus documentée.";
  }

  return "L’IA ne répond pas pour le moment.";
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
