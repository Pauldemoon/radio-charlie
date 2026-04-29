const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const AI_MAX_TOKENS = Number(process.env.RADIO_CHARLIE_AI_MAX_TOKENS || 5200);
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

  const curatedEpisode = createCuratedEpisode(seed);
  if (process.env.RADIO_CHARLIE_USE_CURATED === "true" && curatedEpisode) {
    return json(200, curatedEpisode);
  }

  if (process.env.RADIO_CHARLIE_FREE_MODE === "true") {
    return json(200, createFreeEpisode(seed));
  }

  try {
    const episode = process.env.ANTHROPIC_API_KEY
      ? await createClaudeEpisode(seed)
      : process.env.OPENAI_API_KEY
        ? await createOpenAiEpisode(seed)
        : createFreeEpisode(seed);
    return json(200, episode);
  } catch (error) {
    if (!hasAiProvider || shouldUseFreeEpisode(error)) {
      return json(200, createFreeEpisode(seed));
    }

    return json(502, {
      error: getAiUserMessage(error),
      detail: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

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
          content: buildPrompt(seed),
        },
      ],
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error?.message || "Erreur OpenAI.");
  }

  const content = payload?.choices?.[0]?.message?.content;
  const episode = normalizeEpisode(parseEpisode(content));

  if (!isValidEpisode(episode)) {
    throw new Error("Qualité éditoriale insuffisante.");
  }

  return episode;
}

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
      messages: [
        {
          role: "user",
          content: buildPrompt(seed),
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

  if (!isValidEpisode(episode)) {
    throw new Error("Qualité éditoriale insuffisante.");
  }

  return episode;
}

function buildPrompt({ artist, title, album }) {
  return `
Titre choisi par l’utilisateur :
{
  "artist": "${artist}",
  "title": "${title}"
}
${album ? `Album Deezer du morceau choisi : "${album}".` : ""}

Tu es Radio Charlie, un moteur premium français de récit musical.

Radio Charlie crée des émissions radio intelligentes à partir d’un morceau choisi.
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
Créer une émission éditoriale complète en 8 titres.

Le titre choisi n’est pas forcément le sujet central.
Il sert de premier signal : à toi d’en tirer le parcours humain le plus intéressant.

L’émission doit contenir :
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
8. "closing statement" : ferme l’émission avec une idée forte, pas seulement avec un morceau calme.

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
- pas "le morceau révèle une époque", mais "en 1998, sur Mezzanine, Massive Attack durcit son son au moment où les tensions internes du groupe deviennent visibles" ;
- pas "la chanson est intime", mais "le texte parle d’une surveillance amoureuse, et le clip transforme cette jalousie en décor de camions, d’armes et de gestes religieux" ;
- pas "la production est moderne", mais "les palmas, la voix très proche et la production d’El Guincho déplacent le flamenco vers une architecture pop sèche".

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
- vérifie mentalement chaque nom propre avant de l’écrire ;
- exemple de vigilance : pour Rosalía / El Mal Querer, le producteur central connu est El Guincho.

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
          cleanText(track.title) &&
          isEditorialChronicle(track.chronicle),
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

function normalizePlaylistRole(role, index) {
  return PLAYLIST_ROLES.includes(role) ? role : PLAYLIST_ROLES[index] || "opener";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
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

  if (lowerMessage.includes("quota") || lowerMessage.includes("billing")) {
    return "Le quota de la clé IA est épuisé. Vérifie le crédit ou la facturation du compte.";
  }

  if (
    lowerMessage.includes("invalid api key") ||
    lowerMessage.includes("incorrect api key") ||
    lowerMessage.includes("invalid x-api-key")
  ) {
    return "La clé Claude est invalide. Crée une nouvelle clé Anthropic et remplace ANTHROPIC_API_KEY.";
  }

  if (lowerMessage.includes("model")) {
    return "Le modèle IA configuré n’est pas disponible pour cette clé.";
  }

  if (lowerMessage.includes("qualité éditoriale")) {
    return "L’IA a produit une émission trop pauvre en faits. Relance la génération pour obtenir une version plus documentée.";
  }

  return "L’IA ne répond pas pour le moment.";
}

function shouldUseFreeEpisode(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("quota") ||
    message.includes("billing") ||
    message.includes("credit") ||
    message.includes("api key") ||
    message.includes("401") ||
    message.includes("429") ||
    message.includes("fetch failed")
  );
}

function createCuratedEpisode(seed) {
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

  return null;
}

function createFreeEpisode(seed) {
  return createCuratedEpisode(seed) || buildCuratedEpisode(createMassiveAttackEpisode(seed));
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
