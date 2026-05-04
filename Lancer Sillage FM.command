#!/bin/zsh
cd "$(dirname "$0")"

LOG_FILE="./sillage-fm.log"
PORT="${PORT:-}"

if [ -z "$PORT" ]; then
  for CANDIDATE in 8890 8891 8892 8893 8894; do
    if ! lsof -iTCP:"$CANDIDATE" -sTCP:LISTEN >/dev/null 2>&1; then
      PORT="$CANDIDATE"
      break
    fi
  done
fi

PORT="${PORT:-8890}"
URL="http://127.0.0.1:$PORT"

echo "Sillage FM démarre..."
echo "Le serveur local va se lancer sur :"
echo "$URL"
echo ""
echo "Log : $LOG_FILE"
echo ""

{
  echo "---- Sillage FM launch $(date) ----"
  echo "Dossier : $(pwd)"
  echo "Adresse : $URL"
  echo "Node : $(command -v node || echo 'node introuvable')"
  node -v 2>/dev/null || true
  echo ""
} >> "$LOG_FILE"

HOST=127.0.0.1 PORT="$PORT" node server.js >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!

for i in {1..40}; do
  if curl -fsS "$URL" >/dev/null 2>&1; then
    open "$URL"
    echo "Sillage FM est prêt."
    wait $SERVER_PID
    exit $?
  fi
  sleep 0.25
done

echo "Impossible de lancer Sillage FM sur $URL"
echo "Garde cette fenêtre ouverte et copie le message d'erreur ci-dessus si besoin."
wait $SERVER_PID
