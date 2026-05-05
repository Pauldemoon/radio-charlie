#!/bin/zsh
cd "$(dirname "$0")"

LOG_FILE="./sillage-fm-diagnostic.log"

{
  echo "---- Diagnostic Sillage FM $(date) ----"
  echo ""
  echo "Dossier"
  pwd
  echo ""
  echo "Fichiers"
  ls -la
  echo ""
  echo "Node"
  command -v node || echo "node introuvable"
  node -v 2>&1 || true
  echo ""
  echo "Variables .env présentes"
  node - <<'NODE'
const fs = require("fs");
const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
for (const key of ["AI_PROVIDER", "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_THINKING_LEVEL", "GEMINI_THINKING_BUDGET", "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_THINKING", "TAVILY_API_KEY", "TAVILY_ENABLED", "TAVILY_SEARCH_DEPTH", "TAVILY_MAX_RESULTS", "VOICE_PROVIDER", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL", "ELEVENLABS_SPEED", "ELEVENLABS_TIMEOUT_MS", "ELEVENLABS_MAX_CHARS", "RADIO_CHARLIE_FREE_MODE", "RADIO_CHARLIE_STRICT_AI", "RADIO_CHARLIE_STRICT_WEB", "RADIO_CHARLIE_ALLOWED_ORIGINS", "RADIO_CHARLIE_PLAN_RATE_LIMIT", "RADIO_CHARLIE_SPEAK_RATE_LIMIT"]) {
  const match = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  const value = match ? match[1].trim() : "";
  console.log(`${key}: ${value ? (key.includes("KEY") ? "présent" : value) : "manquant"}`);
}
NODE
  echo ""
  echo "Test syntaxe"
  node --check server.js
  node --check app.js
  node --check server-functions/plan.js
  node --check server-functions/speak.js
  node --check server-functions/status.js
  echo ""
  echo "Test lancement serveur"
  TEST_PORT=""
  for CANDIDATE in 8890 8891 8892 8893 8894; do
    if ! lsof -iTCP:"$CANDIDATE" -sTCP:LISTEN >/dev/null 2>&1; then
      TEST_PORT="$CANDIDATE"
      break
    fi
  done
  TEST_PORT="${TEST_PORT:-8890}"
  echo "Port de test : $TEST_PORT"
  HOST=127.0.0.1 PORT="$TEST_PORT" node server.js &
  SERVER_PID=$!
  sleep 2
  curl -I "http://127.0.0.1:$TEST_PORT" 2>&1 || true
  echo ""
  echo "Statut IA"
  curl -s "http://127.0.0.1:$TEST_PORT/api/status" 2>&1 || true
  echo ""
  kill $SERVER_PID 2>/dev/null || true
  wait $SERVER_PID 2>/dev/null || true
} > "$LOG_FILE" 2>&1

open "$LOG_FILE"
echo "Diagnostic terminé. Le fichier s'ouvre : $LOG_FILE"
