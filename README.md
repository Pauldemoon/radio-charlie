# Sillage FM

Sillage FM est une application web d’émission musicale par voix off.

L’utilisateur cherche un morceau, clique sur un résultat Deezer, puis l’application génère une émission musicale autour de ce titre :

- une playlist contextuelle de 8 morceaux ;
- des rôles éditoriaux pour chaque titre : ouverture, origine, rupture, contraste, influence cachée, point de bascule, conséquence, dernier mot ;
- une chronique radio lue avant chaque morceau ;
- une lecture automatique des previews Deezer de 30 secondes ;
- des contrôles pause, reprise, passage et arrêt de l’émission ;
- des liens Deezer pour retrouver le morceau en cours ;
- une voix off ElevenLabs pour lire les chroniques, sans afficher le texte éditorial dans l’interface ;
- un fallback `speechSynthesis` si ElevenLabs échoue.

Signature : **Après le morceau, le sillage.**

## Stack

- HTML
- CSS
- Vanilla JavaScript
- Node.js
- Railway
- Deezer API pour la recherche et les previews
- DeepSeek pour générer l’émission à coût maîtrisé
- OpenAI ou Claude en fournisseurs optionnels
- ElevenLabs pour la voix

## Installation locale

### Option simple

```bash
npm start
```

Puis ouvrez :

```text
http://127.0.0.1:8890
```

Sur Mac, vous pouvez aussi double-cliquer sur `Lancer Sillage FM.command`.
Si le port 8890 est déjà utilisé, le lanceur choisit automatiquement un port proche et ouvre la bonne adresse.

Vous pouvez aussi lancer directement :

```bash
node server.js
```

Pour vérifier rapidement la syntaxe et les handlers principaux :

```bash
npm run check
npm test
```

## Mode MVP Gemini 3

Sillage FM est prêt pour un MVP Railway avec Gemini 3 Flash Preview.
La clé Gemini reste côté serveur, dans `.env` en local ou dans les variables d’environnement Railway.
Elle n’est jamais exposée dans `app.js`.

1. Ouvrez Google AI Studio.
2. Créez une clé API Gemini.
3. Copiez `.env.example` vers `.env`.
4. Renseignez au minimum :

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3-flash-preview
GEMINI_THINKING_LEVEL=low
RADIO_CHARLIE_AI_MAX_TOKENS=4500
RADIO_CHARLIE_FREE_MODE=false
RADIO_CHARLIE_STRICT_AI=true
```

5. Lancez :

```bash
npm start
```

6. Vérifiez le statut sans afficher la clé :

```text
http://127.0.0.1:8890/api/status
```

Le statut doit afficher :

```json
{
  "aiProvider": "gemini",
  "geminiConfigured": true,
  "geminiModel": "gemini-3-flash-preview"
}
```

Pour une démo qui ne bloque jamais, gardez `RADIO_CHARLIE_STRICT_AI=false`.
Pour tester le vrai MVP IA, utilisez `RADIO_CHARLIE_STRICT_AI=true` : si le fournisseur configuré échoue, l’erreur sera visible au lieu de revenir à l’émission locale.

## Déploiement Railway

1. Créez un nouveau projet Railway depuis le dépôt GitHub `Pauldemoon/radio-charlie`.
2. Railway détecte `package.json` et lance automatiquement `npm start`.
3. Ajoutez les variables d’environnement dans Railway :
   - `AI_PROVIDER`
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL`
   - `GEMINI_THINKING_LEVEL`
   - `GEMINI_THINKING_BUDGET`
   - `DEEPSEEK_API_KEY`
   - `DEEPSEEK_MODEL`
   - `DEEPSEEK_THINKING`
   - `RADIO_CHARLIE_AI_MAX_TOKENS`
   - `TAVILY_API_KEY`
   - `TAVILY_ENABLED`
   - `TAVILY_SEARCH_DEPTH`
   - `TAVILY_MAX_RESULTS`
   - `TAVILY_TIMEOUT_MS`
   - `TAVILY_CACHE_TTL_MS`
   - `VOICE_PROVIDER`
   - `ELEVENLABS_API_KEY`
   - `ELEVENLABS_VOICE_ID`
   - `ELEVENLABS_MODEL`
   - `ELEVENLABS_LANGUAGE`
   - `ELEVENLABS_STABILITY`
   - `ELEVENLABS_SIMILARITY`
   - `ELEVENLABS_STYLE`
   - `ELEVENLABS_SPEED`
   - `ELEVENLABS_SPEAKER_BOOST`
   - `ELEVENLABS_TIMEOUT_MS`
   - `ELEVENLABS_MAX_CHARS`
   - `RADIO_CHARLIE_FREE_MODE`
   - `RADIO_CHARLIE_STRICT_AI`
   - `RADIO_CHARLIE_STRICT_WEB`
   - `RADIO_CHARLIE_ALLOWED_ORIGINS`
   - `RADIO_CHARLIE_BODY_LIMIT_BYTES`
   - `RADIO_CHARLIE_PLAN_RATE_LIMIT`
   - `RADIO_CHARLIE_PLAN_RATE_WINDOW_MS`
   - `RADIO_CHARLIE_SPEAK_RATE_LIMIT`
   - `RADIO_CHARLIE_SPEAK_RATE_WINDOW_MS`
4. Déployez.
5. Vérifiez le statut à l’adresse :

```url
https://VOTRE-DOMAINE-RAILWAY/api/status
```

## Variables d’environnement

```env
AI_PROVIDER=gemini
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_THINKING=disabled
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-20250514
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3-flash-preview
GEMINI_THINKING_LEVEL=low
GEMINI_THINKING_BUDGET=
RADIO_CHARLIE_AI_MAX_TOKENS=4500
TAVILY_API_KEY=
TAVILY_ENABLED=true
TAVILY_SEARCH_DEPTH=basic
TAVILY_MAX_RESULTS=5
TAVILY_TIMEOUT_MS=5500
TAVILY_CACHE_TTL_MS=3600000
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
VOICE_PROVIDER=elevenlabs
ELEVENLABS_MODEL=eleven_flash_v2_5
ELEVENLABS_LANGUAGE=fr
ELEVENLABS_STABILITY=0.42
ELEVENLABS_SIMILARITY=0.72
ELEVENLABS_STYLE=0.18
ELEVENLABS_SPEED=1.12
ELEVENLABS_SPEAKER_BOOST=false
ELEVENLABS_TIMEOUT_MS=6500
ELEVENLABS_MAX_CHARS=750
RADIO_CHARLIE_FREE_MODE=false
RADIO_CHARLIE_STRICT_AI=true
RADIO_CHARLIE_STRICT_WEB=false
RADIO_CHARLIE_DEBUG_AI=false
RADIO_CHARLIE_ALLOWED_ORIGINS=
RADIO_CHARLIE_BODY_LIMIT_BYTES=65536
RADIO_CHARLIE_PLAN_RATE_LIMIT=12
RADIO_CHARLIE_PLAN_RATE_WINDOW_MS=600000
RADIO_CHARLIE_SPEAK_RATE_LIMIT=80
RADIO_CHARLIE_SPEAK_RATE_WINDOW_MS=600000
```

`RADIO_CHARLIE_FREE_MODE=true` désactive les appels IA payants et utilise une émission locale.
`RADIO_CHARLIE_STRICT_AI=true` force une erreur visible si l’IA échoue au lieu de revenir au mode local.
`AI_PROVIDER=gemini` utilise Gemini.
`GEMINI_MODEL=gemini-3-flash-preview` utilise Gemini 3 Flash Preview.
`GEMINI_THINKING_LEVEL=low` limite la latence et le coût sur Gemini 3.
`GEMINI_THINKING_LEVEL=high` privilégie la qualité si vous acceptez plus de latence.
`GEMINI_THINKING_BUDGET` est surtout utile pour Gemini 2.5 ; laissez vide avec Gemini 3.
`AI_PROVIDER=deepseek` utilise DeepSeek.
`AI_PROVIDER=openai` utilise OpenAI.
`AI_PROVIDER=claude` utilise Claude si vous gardez une clé Anthropic.
`DEEPSEEK_THINKING=disabled` force DeepSeek à produire directement le JSON final au lieu de consommer la réponse en raisonnement.
`TAVILY_API_KEY` active un dossier factuel web côté serveur avant la génération éditoriale.
`TAVILY_SEARCH_DEPTH=basic` limite le coût à une recherche standard ; `advanced` est plus précis mais plus cher.
`TAVILY_MAX_RESULTS=5` contrôle le nombre de sources injectées dans le prompt.
`RADIO_CHARLIE_STRICT_WEB=true` force une erreur visible si Tavily échoue au lieu de continuer sans dossier web.
`VOICE_PROVIDER=browser` désactive ElevenLabs et utilise la voix native du navigateur.
`ELEVENLABS_MODEL=eleven_flash_v2_5` privilégie une voix rapide et moins chère pour l’usage radio interactif.
`ELEVENLABS_MAX_CHARS=750` évite qu’un appel externe demande une synthèse longue et coûteuse.
`RADIO_CHARLIE_DEBUG_AI=true` affiche un détail court de l’erreur IA et laisse aussi une trace lisible dans les logs Railway.
`RADIO_CHARLIE_ALLOWED_ORIGINS` peut contenir une liste d’origines autorisées séparées par des virgules.
Les variables `RADIO_CHARLIE_*_RATE_LIMIT` limitent les appels par adresse IP pour protéger les crédits IA et voix.
Les variables `RADIO_CHARLIE_*_RATE_WINDOW_MS` règlent la fenêtre de limitation en millisecondes.

## Notes sécurité

Les routes `/api/plan` et `/api/speak` appellent des services payants.
Le serveur applique donc :

- une limite de taille de requête ;
- un contrôle d’origine HTTP ;
- une limitation simple par adresse IP ;
- une limite de caractères pour la synthèse vocale ElevenLabs.

Pour un lancement public plus exposé, ajoutez aussi une solution persistante de rate limiting côté plateforme ou reverse proxy.

## Obtenir une clé DeepSeek

1. Créez ou ouvrez un compte DeepSeek.
2. Ouvrez la console API DeepSeek.
3. Créez une clé API.
4. Ajoutez cette clé dans `DEEPSEEK_API_KEY`.
5. Gardez `DEEPSEEK_MODEL=deepseek-v4-pro` pour une meilleure qualité éditoriale.

La clé DeepSeek reste côté serveur dans l’API `plan.js`.
Elle n’est jamais exposée dans le JavaScript front.

## OpenAI optionnel

OpenAI peut rester configuré comme autre fournisseur économique.
Utilisez `AI_PROVIDER=openai` avec `OPENAI_API_KEY`.

La clé OpenAI reste côté serveur dans l’API `plan.js`.
Elle n’est jamais exposée dans le JavaScript front.

## Claude optionnel

Claude peut rester configuré en fournisseur premium, mais il n’est plus prioritaire.
Utilisez `AI_PROVIDER=claude` avec `ANTHROPIC_API_KEY` si vous voulez le réactiver.

## Obtenir une clé ElevenLabs

1. Créez ou ouvrez un compte ElevenLabs.
2. Allez dans les paramètres de votre compte.
3. Créez ou copiez votre clé API.
4. Ajoutez cette clé dans `ELEVENLABS_API_KEY`.

La clé ElevenLabs reste côté serveur dans l’API `speak.js`.
Elle n’est jamais exposée dans le JavaScript front.

Pour une voix plus rapide, utilisez `ELEVENLABS_MODEL=eleven_flash_v2_5`.
Si vous voulez zéro attente, utilisez `VOICE_PROVIDER=browser`.
Si la voix devient trop théâtrale, baissez `ELEVENLABS_STYLE`.
Si elle paraît trop molle, montez `ELEVENLABS_SPEED` entre `1.12` et `1.18`.

## Récupérer un ELEVENLABS_VOICE_ID

1. Ouvrez ElevenLabs.
2. Allez dans la section des voix.
3. Choisissez une voix.
4. Copiez son identifiant de voix.
5. Ajoutez cet identifiant dans `ELEVENLABS_VOICE_ID`.

## Deezer

Sillage FM utilise l’API publique Deezer :

```text
https://api.deezer.com/search?q=QUERY&output=jsonp
```

Deezer ne fournit que des previews de 30 secondes via l’API publique.
L’application ne lit pas de morceaux complets.

## Notes produit

- Aucun login.
- Aucun compte utilisateur.
- Aucune inscription.
- Pas de Spotify.
- Pas de YouTube.
- Uniquement les previews Deezer de 30 secondes.
