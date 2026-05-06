# Sillage FM

Application radio qui génère une émission musicale à partir d'un morceau Deezer.

## Commandes

- `npm start` lance le serveur local.
- `npm run check` vérifie la syntaxe du front et du back.
- `npm test` lance les tests de base sans appeler les APIs payantes.

## Endpoints

- `GET /health` vérifie que le serveur répond.
- `GET /api/status` affiche la configuration active sans exposer les clés.
- `POST /api/plan` génère le conducteur éditorial.
- `POST /api/speak` génère la voix si ElevenLabs est configuré.
