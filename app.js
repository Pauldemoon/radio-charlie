const DEEZER_SEARCH_URL = "https://api.deezer.com/search";
const DEEZER_FETCH_TIMEOUT_MS = 5000;
const SPEECH_CACHE_MAX = 30;
const LAST_QUERY_KEY = "radio-charlie-last-query";
const IOS_AUDIO_UNLOCK_URL =
  "data:audio/wav;base64,UklGRmQBAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const FALLBACK_COVER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 600'%3E%3Crect width='600' height='600' fill='%23141312'/%3E%3Ccircle cx='300' cy='300' r='190' fill='%23d8b36a' fill-opacity='.16'/%3E%3Ccircle cx='300' cy='300' r='78' fill='%23d8b36a' fill-opacity='.42'/%3E%3C/svg%3E";

const LOADING_MESSAGE = "Création du podcast en cours…";
const API_BASE_URL = cleanApiBaseUrl(window.RADIO_CHARLIE_API_BASE_URL || "");

const els = {
  homeScreen: document.querySelector("#home-screen"),
  loadingScreen: document.querySelector("#loading-screen"),
  radioScreen: document.querySelector("#radio-screen"),
  endScreen: document.querySelector("#end-screen"),
  errorScreen: document.querySelector("#error-screen"),
  searchForm: document.querySelector("#search-form"),
  searchInput: document.querySelector("#search-input"),
  searchButton: document.querySelector("#search-form button"),
  searchMessage: document.querySelector("#search-message"),
  results: document.querySelector("#results"),
  loadingMessage: document.querySelector("#loading-message"),
  loadingStep: document.querySelector("#loading-step"),
  radioTitle: document.querySelector("#radio-title"),
  pauseButton: document.querySelector("#pause-button"),
  audioUnlockButton: document.querySelector("#audio-unlock-button"),
  skipButton: document.querySelector("#skip-button"),
  stopButton: document.querySelector("#stop-button"),
  restartButton: document.querySelector("#restart-button"),
  errorMessage: document.querySelector("#error-message"),
  errorRetryButton: document.querySelector("#error-retry-button"),
  errorHomeButton: document.querySelector("#error-home-button"),
  currentCover: document.querySelector("#current-cover"),
  currentArtist: document.querySelector("#current-artist"),
  currentTitle: document.querySelector("#current-title"),
  currentLink: document.querySelector("#current-link"),
  playbackState: document.querySelector("#playback-state"),
  progress: document.querySelector("#progress"),
  queue: document.querySelector("#queue"),
};

const sharedAudio = new Audio();
sharedAudio.preload = "auto";
sharedAudio.setAttribute("playsinline", "");

const roleLabels = {
  opener: "Ouverture",
  origin: "Origine",
  rupture: "Rupture",
  contrast: "Contraste",
  "hidden influence": "Influence cachée",
  "turning point": "Point de bascule",
  consequence: "Conséquence",
  "closing statement": "Dernier mot",
};

const state = {
  runId: 0,
  searchId: 0,
  searchTimer: 0,
  playback: null,
  playbackLabel: "",
  isPaused: false,
  episode: null,
  playableTracks: [],
  audioUnlocked: false,
  audioUnlockPromise: null,
  pendingAudioStart: null,
  speechCache: new Map(),
  lastSeedTrack: null,
};

// ─── Init ────────────────────────────────────────────────────────────────────

els.searchInput.focus();

// Restore last query from session
const lastQuery = sessionStorage.getItem(LAST_QUERY_KEY);
if (lastQuery) {
  els.searchInput.value = lastQuery;
  searchTracks(lastQuery);
}

// ─── Search events ───────────────────────────────────────────────────────────

els.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  window.clearTimeout(state.searchTimer);
  searchTracks(els.searchInput.value);
});

els.searchInput.addEventListener("input", () => {
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => {
    searchTracks(els.searchInput.value);
  }, 300);
});

// ─── Playback control events ─────────────────────────────────────────────────

els.pauseButton.addEventListener("click", () => {
  togglePause();
});

els.audioUnlockButton.addEventListener("click", () => {
  if (state.pendingAudioStart) {
    state.pendingAudioStart();
    return;
  }
  primeAudioPlayback();
});

els.skipButton.addEventListener("click", () => {
  interruptCurrentStep();
});

els.stopButton.addEventListener("click", () => {
  stopEpisode();
});

els.restartButton.addEventListener("click", () => {
  stopEpisode();
});

// ─── Error screen events ──────────────────────────────────────────────────────

els.errorRetryButton.addEventListener("click", () => {
  if (state.lastSeedTrack) {
    startEpisode(state.lastSeedTrack);
  } else {
    showHome();
    els.searchInput.focus();
  }
});

els.errorHomeButton.addEventListener("click", () => {
  state.lastSeedTrack = null;
  showHome();
  els.searchInput.focus();
});

// ─── Keyboard shortcuts (radio screen only) ───────────────────────────────────

document.addEventListener("keydown", (event) => {
  if (!els.radioScreen.classList.contains("screen--active")) return;
  if (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA") return;

  if (event.code === "Space") {
    event.preventDefault();
    togglePause();
  } else if (event.code === "ArrowRight") {
    event.preventDefault();
    interruptCurrentStep();
  }
});

// ─── Search ───────────────────────────────────────────────────────────────────

async function searchTracks(query) {
  const searchId = resetSearch();
  const cleanQuery = query.trim();
  els.results.replaceChildren();

  if (!cleanQuery) {
    showSearchMessage("Entrez un morceau pour lancer une recherche.");
    setSearchBusy(false);
    return;
  }

  setSearchBusy(true);
  showSearchMessage("Recherche en cours…");

  try {
    const tracks = await deezerSearch(cleanQuery, 5);
    if (!isCurrentSearch(searchId)) return;

    const playableResults = tracks.filter(hasRequiredDeezerFields).slice(0, 5);

    if (!playableResults.length) {
      showSearchMessage("Aucun extrait Deezer disponible pour cette recherche.");
      return;
    }

    showSearchMessage("");
    renderSearchResults(playableResults);

    // Persist query for session restore
    try {
      sessionStorage.setItem(LAST_QUERY_KEY, cleanQuery);
    } catch (_) {}
  } catch (error) {
    if (!isCurrentSearch(searchId)) return;
    showSearchMessage(error.message || "Deezer ne répond pas pour le moment.");
  } finally {
    if (isCurrentSearch(searchId)) {
      setSearchBusy(false);
    }
  }
}

function renderSearchResults(tracks) {
  const fragment = document.createDocumentFragment();

  tracks.forEach((track) => {
    const card = document.createElement("button");
    const cover = document.createElement("img");
    const copy = document.createElement("span");
    const title = document.createElement("span");
    const artist = document.createElement("span");
    const cta = document.createElement("span");

    card.type = "button";
    card.className = "result-card";
    cover.src = track.album.cover_medium;
    cover.alt = `Pochette de ${track.title}`;
    title.className = "result-title";
    title.textContent = track.title;
    artist.className = "result-artist";
    artist.textContent = track.artist.name;
    cta.className = "result-cta";
    cta.textContent = "Lancer le podcast";

    copy.append(title, artist);
    card.append(cover, copy, cta);
    card.addEventListener("click", () => {
      primeAudioPlayback();
      startEpisode(track);
    });
    fragment.append(card);
  });

  els.results.replaceChildren(fragment);
}

// ─── Episode lifecycle ────────────────────────────────────────────────────────

async function startEpisode(seedTrack) {
  const runId = resetRun();
  state.lastSeedTrack = seedTrack;
  showLoading();
  setLoadingStep("Radio Charlie rédige les chroniques…");

  try {
    const episode = await fetchPlan({
      artist: seedTrack.artist.name,
      title: seedTrack.title,
      album: seedTrack.album?.title || "",
      deezerArtistId: seedTrack.artist?.id || "",
      deezerTrackId: seedTrack.id || "",
    });

    if (!isCurrentRun(runId)) return;

    // Preload TTS for track 0 immediately
    preloadSpeech(getTrackChronicle(episode.tracks[0])).catch(() => {});

    // Show radio screen right away with placeholder covers — no more loading screen
    const placeholders = episode.tracks.map((t) => ({
      ...t,
      cover: FALLBACK_COVER,
      preview: null,
      link: "",
    }));
    state.episode = episode;
    state.playableTracks = placeholders;
    showRadio(episode, placeholders);

    // Enrich with Deezer in background (fast, ~3-5s)
    const playableTracks = await enrichWithDeezer(episode.tracks);
    if (!isCurrentRun(runId)) return;

    if (!playableTracks.length) {
      throw new Error("Aucune preview disponible pour ce podcast.");
    }

    // Update queue with real covers + start playback
    state.playableTracks = playableTracks;
    renderQueue(playableTracks, 0);
    await playEpisode(runId, playableTracks);
  } catch (error) {
    if (!isCurrentRun(runId)) return;
    showError(error.message || "Impossible de générer le podcast.");
  }
}

async function fetchPlan(seed) {
  if (window.location.protocol === "file:" && !API_BASE_URL) {
    throw new Error(
      "Pour générer un podcast, ouvre l'app depuis Netlify, Railway ou configure l'URL API Railway."
    );
  }

  const response = await fetch(apiUrl("/plan"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(seed),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error || "L'IA ne répond pas pour le moment.");
  }

  if (!isValidEpisode(body)) {
    throw new Error("Le podcast généré n'a pas le bon format.");
  }

  return body;
}

async function enrichWithDeezer(tracks) {
  const enriched = await Promise.all(
    tracks.map(async (track) => {
      if (track.preview) {
        return {
          ...track,
          deezerId: track.deezerId || "",
          cover: track.cover || FALLBACK_COVER,
          link: track.link || "",
        };
      }

      const query = `${track.artist} ${track.title}`;
      const results = await deezerSearch(query, 8).catch(() => []);
      const match = findBestPlayableMatch(results, track);

      if (match?.preview) {
        return {
          ...track,
          deezerId: match.id,
          preview: match.preview,
          cover: match.album?.cover_medium || FALLBACK_COVER,
          link: match.link || "",
        };
      }

      return null;
    }),
  );

  return enriched.filter(Boolean).slice(0, 8);
}

async function playEpisode(runId, tracks) {
  const intro = state.episode?.intro;

  // Prefetch ALL speech in parallel immediately so ElevenLabs calls overlap
  // with the intro and each preview — by the time we need each chronicle it's
  // already downloaded (or nearly so).
  [
    ...(intro ? [intro] : []),
    ...tracks.map(getTrackChronicle),
  ]
    .filter(Boolean)
    .forEach((text) => preloadSpeech(text).catch(() => {}));

  // Lire l'intro editoriale avant le premier morceau
  if (intro) {
    setPlaybackState("Charlie raconte…");
    await speak(intro);
    if (!isCurrentRun(runId)) return;
    await wait(600);
    if (!isCurrentRun(runId)) return;
  }

  for (let index = 0; index < tracks.length; index += 1) {
    if (!isCurrentRun(runId)) return;

    const track = tracks[index];
    const chronicle = getTrackChronicle(track);
    updateCurrentTrack(track, index, tracks.length);
    setPlaybackState("Charlie raconte…");

    await speak(chronicle);
    if (!isCurrentRun(runId)) return;

    await wait(400);
    if (!isCurrentRun(runId)) return;

    setPlaybackState("En cours d'écoute");
    await playPreview(track.preview);
    if (!isCurrentRun(runId)) return;

    await wait(600);
  }

  if (isCurrentRun(runId)) {
    clearPlayback();
    showEnd();
  }
}

// ─── Speech ───────────────────────────────────────────────────────────────────

async function speak(text) {
  const cleanSpeechText = String(text || "").trim();

  try {
    const audioUrl = await preloadSpeech(cleanSpeechText);
    state.speechCache.delete(cleanSpeechText);
    await playAudio(audioUrl, () => URL.revokeObjectURL(audioUrl));
  } catch (error) {
    state.speechCache.delete(cleanSpeechText);
    await speakWithBrowser(cleanSpeechText);
  }
}

function preloadNextSpeech(tracks, currentIndex) {
  const nextTrack = tracks[currentIndex + 1];

  if (nextTrack) {
    preloadSpeech(getTrackChronicle(nextTrack)).catch(() => {});
  }
}

function preloadSpeech(text) {
  const cleanSpeechText = String(text || "").trim();

  if (!cleanSpeechText) {
    return Promise.reject(new Error("Texte vide."));
  }

  if (!state.speechCache.has(cleanSpeechText)) {
    // LRU eviction — drop oldest entry when cache is full
    if (state.speechCache.size >= SPEECH_CACHE_MAX) {
      const oldestKey = state.speechCache.keys().next().value;
      state.speechCache
        .get(oldestKey)
        .then((url) => URL.revokeObjectURL(url))
        .catch(() => {});
      state.speechCache.delete(oldestKey);
    }

    state.speechCache.set(cleanSpeechText, fetchSpeechAudio(cleanSpeechText));
  }

  return state.speechCache.get(cleanSpeechText);
}

async function fetchSpeechAudio(text) {
  const response = await fetch(apiUrl("/speak"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error("Voix ElevenLabs indisponible.");
  }

  const blob = await response.blob();

  if (!blob.size || !blob.type.includes("audio")) {
    throw new Error("Réponse audio ElevenLabs invalide.");
  }

  return URL.createObjectURL(blob);
}

function speakWithBrowser(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window) || !text) {
      resolve();
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "fr-FR";
    utterance.rate = 0.96;
    utterance.pitch = 0.92;

    let done = () => {};
    done = once(() => {
      clearPlayback();
      resolve();
    });

    utterance.onend = done;
    utterance.onerror = done;
    state.playback = {
      stop() {
        window.speechSynthesis.cancel();
        done();
      },
      pause() {
        window.speechSynthesis.pause();
      },
      resume() {
        window.speechSynthesis.resume();
      },
    };
    resetPauseControl(false);

    window.speechSynthesis.speak(utterance);
  });
}

// ─── Audio playback ───────────────────────────────────────────────────────────

function playPreview(url) {
  return playAudio(url);
}

function primeAudioPlayback() {
  if (state.audioUnlocked) {
    return Promise.resolve();
  }

  if (state.audioUnlockPromise) {
    return state.audioUnlockPromise;
  }

  sharedAudio.dataset.unlocking = "true";
  sharedAudio.src = IOS_AUDIO_UNLOCK_URL;
  sharedAudio.load();

  state.audioUnlockPromise = sharedAudio
    .play()
    .then(() => {
      if (sharedAudio.dataset.unlocking === "true") {
        sharedAudio.pause();
        sharedAudio.currentTime = 0;
        sharedAudio.removeAttribute("src");
        sharedAudio.load();
        delete sharedAudio.dataset.unlocking;
      }

      state.audioUnlocked = true;
    })
    .catch(() => {
      delete sharedAudio.dataset.unlocking;
      state.audioUnlockPromise = null;
    });

  return state.audioUnlockPromise;
}

function playAudio(url, cleanup = () => {}) {
  return new Promise((resolve) => {
    if (!url) {
      resolve();
      return;
    }

    const audio = sharedAudio;
    delete audio.dataset.unlocking;
    state.audioUnlockPromise = null;
    let isWaitingForManualStart = false;

    const startAudio = () => {
      const playPromise = audio.play();

      if (playPromise?.then) {
        playPromise
          .then(() => {
            state.audioUnlocked = true;
          })
          .catch((error) => {
            if (isPlaybackBlocked(error) && !isWaitingForManualStart) {
              isWaitingForManualStart = true;
              requestManualAudioStart(startAudio);
              return;
            }

            done();
          });
      }
    };

    const done = once(() => {
      clearManualAudioStart();
      audio.pause();
      audio.removeEventListener("ended", done);
      audio.removeEventListener("error", done);
      audio.removeAttribute("src");
      audio.load();
      cleanup();
      clearPlayback();
      resolve();
    });

    audio.pause();
    audio.src = url;
    audio.load();
    audio.addEventListener("ended", done);
    audio.addEventListener("error", done);
    state.playback = {
      stop() {
        done();
      },
      pause() {
        audio.pause();
      },
      resume() {
        audio.play().catch(done);
      },
    };
    resetPauseControl(false);

    startAudio();
  });
}

function requestManualAudioStart(startAudio) {
  state.pendingAudioStart = () => {
    clearManualAudioStart();
    startAudio();
  };
  els.audioUnlockButton.hidden = false;
  els.playbackState.textContent = "Touchez « Activer le son » pour continuer";
}

function clearManualAudioStart() {
  state.pendingAudioStart = null;
  els.audioUnlockButton.hidden = true;
}

function isPlaybackBlocked(error) {
  return (
    error?.name === "NotAllowedError" ||
    /gesture|interaction|not allowed|autoplay/i.test(error?.message || "")
  );
}

// ─── Playback control ─────────────────────────────────────────────────────────

function interruptCurrentStep() {
  if (state.playback) {
    state.playback.stop();
  }
}

function togglePause() {
  if (!state.playback) {
    return;
  }

  if (state.isPaused) {
    state.playback.resume();
    resetPauseControl(false);
    els.playbackState.textContent = state.playbackLabel;
    return;
  }

  state.playback.pause();
  resetPauseControl(true);
  els.playbackState.textContent = "En pause";
}

function stopEpisode() {
  resetRun();
  clearSpeechCache();
  clearPlayback();
  state.episode = null;
  state.playableTracks = [];
  state.lastSeedTrack = null;
  els.searchInput.value = "";
  els.results.replaceChildren();
  showSearchMessage("");
  try {
    sessionStorage.removeItem(LAST_QUERY_KEY);
  } catch (_) {}
  showHome();
  els.searchInput.focus();
}

function clearPlayback() {
  state.playback = null;
  clearManualAudioStart();
  resetPauseControl(false, true);
}

function clearSpeechCache() {
  state.speechCache.forEach((speechPromise) => {
    speechPromise.then((audioUrl) => URL.revokeObjectURL(audioUrl)).catch(() => {});
  });
  state.speechCache.clear();
}

// ─── Run / search IDs ─────────────────────────────────────────────────────────

function resetRun() {
  state.runId += 1;
  interruptCurrentStep();
  clearSpeechCache();
  return state.runId;
}

function resetSearch() {
  state.searchId += 1;
  return state.searchId;
}

function isCurrentRun(runId) {
  return state.runId === runId;
}

function isCurrentSearch(searchId) {
  return state.searchId === searchId;
}

// ─── Deezer ───────────────────────────────────────────────────────────────────

async function deezerSearch(query, limit = 5) {
  if (!query.trim()) {
    throw new Error("La recherche est vide.");
  }

  const params = new URLSearchParams({
    q: query,
    output: "jsonp",
    limit: String(limit),
  });
  const url = `${DEEZER_SEARCH_URL}?${params.toString()}`;

  // Use AbortController for a clean fetch timeout
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), DEEZER_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    window.clearTimeout(timeoutId);
    const text = await response.text();
    return normalizeDeezerResults(parseJsonp(text));
  } catch (error) {
    window.clearTimeout(timeoutId);

    if (error.name === "AbortError") {
      // Timeout → fall through to JSONP script tag fallback
    } else if (error.message?.includes("JSONP")) {
      throw error;
    }

    return deezerJsonpWithScript(query, limit);
  }
}

function parseJsonp(text) {
  const trimmed = text.trim();

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  const match = trimmed.match(
    /^(?:\/\*[\s\S]*?\*\/\s*)?[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)?\s*\(([\s\S]*)\)\s*;?$/,
  );

  if (!match) {
    throw new Error("Réponse JSONP Deezer invalide.");
  }

  return JSON.parse(match[1]);
}

function deezerJsonpWithScript(query, limit = 5) {
  return new Promise((resolve, reject) => {
    const callbackName = `radioCharlieDeezer_${Date.now()}_${Math.random()
      .toString(16)
      .slice(2)}`;
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Deezer ne répond pas pour le moment."));
    }, 9000);

    function cleanup() {
      window.clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
    }

    window[callbackName] = (payload) => {
      cleanup();
      resolve(normalizeDeezerResults(payload));
    };

    const params = new URLSearchParams({
      q: query,
      output: "jsonp",
      limit: String(limit),
      callback: callbackName,
    });

    script.onerror = () => {
      cleanup();
      reject(new Error("Deezer ne répond pas pour le moment."));
    };
    script.src = `${DEEZER_SEARCH_URL}?${params.toString()}`;
    document.body.append(script);
  });
}

function normalizeDeezerResults(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

function hasRequiredDeezerFields(track) {
  return Boolean(
    track?.id &&
      track?.title &&
      track?.artist?.name &&
      track?.album?.cover_medium &&
      track?.preview,
  );
}

function findBestPlayableMatch(results, wantedTrack) {
  const playable = results.filter(hasRequiredDeezerFields);

  if (!playable.length) {
    return null;
  }

  const wantedArtist = normalizeText(wantedTrack.artist);
  const wantedTitle = normalizeText(wantedTrack.title);

  return (
    playable.find((track) => {
      const artist = normalizeText(track.artist.name);
      const title = normalizeText(track.title);
      return artist.includes(wantedArtist) && title.includes(wantedTitle);
    }) ||
    playable.find((track) => normalizeText(track.title).includes(wantedTitle)) ||
    playable[0]
  );
}

// ─── Episode validation ───────────────────────────────────────────────────────

function isValidEpisode(value) {
  return Boolean(
    value &&
      typeof getEpisodeTitle(value) === "string" &&
      getEpisodeTitle(value).trim() &&
      Array.isArray(value.tracks) &&
      value.tracks.length >= 1 &&
      value.tracks.length <= 8 &&
      value.tracks.every(
        (track) =>
          typeof track.artist === "string" &&
          typeof track.title === "string" &&
          typeof getTrackChronicle(track) === "string" &&
          getTrackChronicle(track).trim(),
      ),
  );
}

// ─── UI: track & queue ────────────────────────────────────────────────────────

function updateCurrentTrack(track, index, total) {
  els.progress.textContent = `${index + 1} / ${total}`;
  els.currentCover.src = track.cover || FALLBACK_COVER;
  els.currentCover.alt = `Pochette de ${track.title}`;
  els.currentArtist.textContent = track.artist;
  els.currentTitle.textContent = track.title;

  if (track.link) {
    els.currentLink.href = track.link;
    els.currentLink.hidden = false;
  } else {
    els.currentLink.hidden = true;
  }

  renderQueue(state.playableTracks, index);
}

function renderQueue(tracks, activeIndex) {
  const fragment = document.createDocumentFragment();

  tracks.forEach((track, index) => {
    const item = document.createElement("li");
    const number = document.createElement("em");
    const copy = document.createElement("span");
    const title = document.createElement("span");
    const artist = document.createElement("span");

    item.className = index === activeIndex ? "is-active" : "";
    number.className = "queue-index";
    number.textContent = String(index + 1);
    title.className = "queue-title";
    title.textContent = track.title;
    artist.className = "queue-artist";
    artist.textContent = track.artist;

    copy.append(title, artist);
    item.append(number, copy);
    fragment.append(item);
  });

  els.queue.replaceChildren(fragment);
}

// ─── UI: screen transitions ───────────────────────────────────────────────────

function showRadio(episode, tracks) {
  els.radioTitle.textContent = getEpisodeTitle(episode);
  renderQueue(tracks, 0);
  showScreen(els.radioScreen);
}

function showLoading() {
  showSearchMessage("");
  els.results.replaceChildren();
  showScreen(els.loadingScreen);
  setLoadingMessage(LOADING_MESSAGE);
  setLoadingStep("");
}

function showHome() {
  showScreen(els.homeScreen);
}

function showEnd() {
  showScreen(els.endScreen);
}

function showError(message) {
  if (els.errorMessage) {
    els.errorMessage.textContent = message;
  }
  showScreen(els.errorScreen);
}

function showScreen(screen) {
  [
    els.homeScreen,
    els.loadingScreen,
    els.radioScreen,
    els.endScreen,
    els.errorScreen,
  ].forEach((item) => {
    item.classList.toggle("screen--active", item === screen);
  });
}

// ─── UI: messages & state ─────────────────────────────────────────────────────

function showSearchMessage(message) {
  els.searchMessage.textContent = message;
}

function setLoadingMessage(message) {
  els.loadingMessage.textContent = message;
}

function setLoadingStep(message) {
  if (els.loadingStep) {
    els.loadingStep.textContent = message;
  }
}

function setPlaybackState(text) {
  state.playbackLabel = text;

  if (!state.isPaused) {
    els.playbackState.textContent = text;
  }
}

function setSearchBusy(isBusy) {
  els.searchButton.disabled = isBusy;
  els.searchButton.textContent = isBusy ? "Recherche…" : "Rechercher";
  els.searchForm.setAttribute("aria-busy", String(isBusy));
}

function resetPauseControl(isPaused, isDisabled = false) {
  state.isPaused = isPaused;
  els.pauseButton.disabled = isDisabled;
  els.pauseButton.textContent = isPaused ? "Reprendre" : "Pause";
  els.pauseButton.setAttribute("aria-pressed", String(isPaused));
}

// ─── Getters ──────────────────────────────────────────────────────────────────

function getEpisodeTitle(episode) {
  return episode.title || episode.radioTitle || "";
}

function getTrackChronicle(track) {
  return track.chronicle || track.chronique || "";
}

function getTrackRole(track, index = 0) {
  return track.role || Object.keys(roleLabels)[index] || "opener";
}

function getRoleLabel(role) {
  return roleLabels[role] || role;
}

function apiUrl(path) {
  if (API_BASE_URL) {
    return `${API_BASE_URL}${path}`;
  }

  return `/.netlify/functions${path}`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function cleanApiBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function once(fn) {
  let called = false;

  return (...args) => {
    if (called) {
      return;
    }

    called = true;
    fn(...args);
  };
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
