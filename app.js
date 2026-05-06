const DEEZER_SEARCH_URL = "https://api.deezer.com/search";
const SPEECH_TIMEOUT_MS = 5500;
const BROWSER_SPEECH_RATE = 1.12;
const MAX_SPOKEN_WORDS = 52;
const FALLBACK_COVER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 600'%3E%3Crect width='600' height='600' fill='%23020817'/%3E%3Ccircle cx='300' cy='300' r='190' fill='%23f2b51d' fill-opacity='.16'/%3E%3Ccircle cx='300' cy='300' r='78' fill='%23f2b51d' fill-opacity='.42'/%3E%3C/svg%3E";

const loadingMessages = [
  "Sillage prépare l’émission…",
  "Recherche des morceaux…",
  "Écriture de la voix antenne…",
  "Sélection des extraits…",
];

const els = {
  homeScreen: document.querySelector("#home-screen"),
  loadingScreen: document.querySelector("#loading-screen"),
  radioScreen: document.querySelector("#radio-screen"),
  endScreen: document.querySelector("#end-screen"),
  searchForm: document.querySelector("#search-form"),
  searchInput: document.querySelector("#search-input"),
  searchButton: document.querySelector("#search-form button"),
  searchMessage: document.querySelector("#search-message"),
  results: document.querySelector("#results"),
  loadingMessage: document.querySelector("#loading-message"),
  radioTitle: document.querySelector("#radio-title"),
  pauseButton: document.querySelector("#pause-button"),
  skipButton: document.querySelector("#skip-button"),
  stopButton: document.querySelector("#stop-button"),
  restartButton: document.querySelector("#restart-button"),
  currentCover: document.querySelector("#current-cover"),
  currentRole: document.querySelector("#current-role"),
  currentArtist: document.querySelector("#current-artist"),
  currentTitle: document.querySelector("#current-title"),
  currentLink: document.querySelector("#current-link"),
  playbackState: document.querySelector("#playback-state"),
  progress: document.querySelector("#progress"),
  queue: document.querySelector("#queue"),
};

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
  loadingTimer: 0,
  playback: null,
  playbackLabel: "",
  isPaused: false,
  episode: null,
  playableTracks: [],
  speechCache: new Map(),
  browserVoiceOnly: false,
};

els.searchInput.focus();

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


els.pauseButton.addEventListener("click", () => {
  togglePause();
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
    cta.textContent = "Lancer l’émission";

    copy.append(title, artist);
    card.append(cover, copy, cta);
    card.addEventListener("click", () => startEpisode(track));
    fragment.append(card);
  });

  els.results.replaceChildren(fragment);
}

async function startEpisode(seedTrack) {
  const runId = resetRun();
  showLoading();

  try {
    const episode = await fetchPlan({
      artist: seedTrack.artist.name,
      title: seedTrack.title,
      album: seedTrack.album?.title || "",
      deezerArtistId: seedTrack.artist?.id || "",
      deezerTrackId: seedTrack.id || "",
    });

    if (!isCurrentRun(runId)) return;

    setLoadingMessage("Sélection des extraits…");
    const playableTracks = await enrichWithDeezer(episode.tracks);

    if (!isCurrentRun(runId)) return;

    if (!playableTracks.length) {
      throw new Error("Aucune preview disponible pour cette émission.");
    }

    state.episode = episode;
    state.playableTracks = playableTracks;
    stopLoadingMessages();
    showRadio(episode, playableTracks);
    await playEpisode(runId, playableTracks);
  } catch (error) {
    if (!isCurrentRun(runId)) return;
    stopLoadingMessages();
    showHome();
    showSearchMessage(error.message || "Impossible de générer l’émission.");
  }
}

async function fetchPlan(seed) {
  if (window.location.protocol === "file:") {
    throw new Error(
      "Pour utiliser l’IA et ElevenLabs, lance Sillage FM en local, puis ouvre l’adresse indiquée."
    );
  }

  const response = await fetch("/api/plan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(seed),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(formatApiError(body));
  }

  if (!isValidEpisode(body)) {
    throw new Error("L’émission générée n’a pas le bon format.");
  }

  return body;
}

function formatApiError(body) {
  const message = body?.error || "L’IA ne répond pas pour le moment.";
  const detail = body?.detail ? ` Détail : ${body.detail}` : "";
  return `${message}${detail}`;
}

async function enrichWithDeezer(tracks) {
  const enriched = [];

  for (const track of tracks) {
    if (track.preview) {
      enriched.push({
        ...track,
        deezerId: track.deezerId || "",
        cover: track.cover || FALLBACK_COVER,
        link: track.link || "",
      });
      continue;
    }

    const query = `${track.artist} ${track.title}`;
    const results = await deezerSearch(query, 8).catch(() => []);
    const match = findBestPlayableMatch(results, track);

    if (match?.preview) {
      enriched.push({
        ...track,
        deezerId: match.id,
        preview: match.preview,
        cover: match.album?.cover_medium || FALLBACK_COVER,
        link: match.link || "",
      });
    }
  }

  return enriched.slice(0, 8);
}

async function playEpisode(runId, tracks) {
  // Prefetch ALL speech (intro + chronicles + transitions) in parallel at episode start
  const intro = getEpisodeIntro(state.episode);
  tracks.forEach((t) => {
    prefetchSpeech(getTrackChronicle(t));
    if (t.transition) prefetchSpeech(t.transition);
  });

  // Spoken intro — sets the story before the first track
  if (intro) {
    updateCurrentTrack(tracks[0], 0, tracks.length);
    setPlaybackState("Ouverture antenne");
    await speak(intro);
    if (!isCurrentRun(runId)) return;
    await wait(300);
    if (!isCurrentRun(runId)) return;
  }

  for (let index = 0; index < tracks.length; index += 1) {
    if (!isCurrentRun(runId)) return;

    const track = tracks[index];
    const chronicle = getTrackChronicle(track);
    const nextTrack = tracks[index + 1];
    updateCurrentTrack(track, index, tracks.length);
    setPlaybackState("Voix antenne");

    await speak(chronicle);
    if (!isCurrentRun(runId)) return;

    await wait(180);
    if (!isCurrentRun(runId)) return;

    setPlaybackState("En cours d’écoute");
    await playPreview(track.preview);
    if (!isCurrentRun(runId)) return;

    if (nextTrack?.transition) {
      await wait(400);
      if (!isCurrentRun(runId)) return;
      setPlaybackState("Voix antenne");
      await speak(nextTrack.transition);
      if (!isCurrentRun(runId)) return;
    }

    await wait(320);
  }

  if (isCurrentRun(runId)) {
    clearPlayback();
    showEnd();
  }
}

async function speak(text) {
  const speechText = prepareOnAirText(text);

  try {
    const audioUrl = await getSpeechAudioUrl(speechText);

    if (!audioUrl) {
      throw new Error("Voix ElevenLabs indisponible.");
    }

    await playAudio(audioUrl, () => releaseSpeechAudio(speechText));
  } catch (error) {
    await speakWithBrowser(speechText);
  }
}

function prefetchSpeech(text) {
  const speechText = prepareOnAirText(text);

  if (!speechText || state.browserVoiceOnly) {
    return null;
  }

  const key = getSpeechKey(speechText);
  const existing = state.speechCache.get(key);

  if (existing) {
    return existing;
  }

  const controller = new AbortController();
  const entry = {
    controller,
    url: "",
    promise: fetchSpeechAudioUrl(speechText, controller.signal)
      .then((url) => {
        entry.url = url;
        return url;
      })
      .catch(() => {
        state.speechCache.delete(key);
        return "";
      }),
  };

  state.speechCache.set(key, entry);
  return entry;
}

async function getSpeechAudioUrl(text) {
  const speechText = prepareOnAirText(text);

  if (!speechText || state.browserVoiceOnly) {
    return "";
  }

  const entry = prefetchSpeech(speechText);
  return entry ? entry.promise : "";
}

async function fetchSpeechAudioUrl(text, signal) {
  const abort = createSpeechAbort(signal);

  try {
    const response = await fetch("/api/speak", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      if ([500, 503].includes(response.status)) {
        state.browserVoiceOnly = true;
      }

      throw new Error("Voix ElevenLabs indisponible.");
    }

    const blob = await response.blob();

    if (!blob.size || !blob.type.includes("audio")) {
      throw new Error("Réponse audio ElevenLabs invalide.");
    }

    return URL.createObjectURL(blob);
  } finally {
    abort.cleanup();
  }
}

function createSpeechAbort(signal) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
  const abort = () => controller.abort();

  if (signal) {
    signal.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup() {
      window.clearTimeout(timeout);

      if (signal) {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

function releaseSpeechAudio(text) {
  const key = getSpeechKey(text);
  const entry = state.speechCache.get(key);

  if (entry?.url) {
    URL.revokeObjectURL(entry.url);
  }

  state.speechCache.delete(key);
}

function clearSpeechCache() {
  state.speechCache.forEach((entry) => {
    entry.controller?.abort();

    if (entry.url) {
      URL.revokeObjectURL(entry.url);
    }
  });
  state.speechCache.clear();
}

function getSpeechKey(text) {
  return prepareOnAirText(text);
}

function prepareOnAirText(text) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) {
    return "";
  }

  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  const selected = [];
  let wordCount = 0;

  for (const sentence of sentences) {
    const sentenceText = sentence.trim();
    const sentenceWords = sentenceText.split(/\s+/).filter(Boolean).length;

    if (selected.length && wordCount + sentenceWords > MAX_SPOKEN_WORDS) {
      break;
    }

    selected.push(sentenceText);
    wordCount += sentenceWords;

    if (wordCount >= 34) {
      break;
    }
  }

  const spokenText = selected.join(" ").trim() || clean;
  return spokenText.split(/\s+/).slice(0, MAX_SPOKEN_WORDS).join(" ");
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
    utterance.voice = getFrenchVoice();
    utterance.rate = BROWSER_SPEECH_RATE;
    utterance.pitch = 1;

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

function getFrenchVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  return (
    voices.find((voice) => voice.lang?.toLowerCase() === "fr-fr" && voice.localService) ||
    voices.find((voice) => voice.lang?.toLowerCase().startsWith("fr")) ||
    null
  );
}

function playPreview(url) {
  return playAudio(url);
}

function playAudio(url, cleanup = () => {}) {
  return new Promise((resolve) => {
    if (!url) {
      resolve();
      return;
    }

    const audio = new Audio(url);
    const done = once(() => {
      audio.pause();
      audio.removeAttribute("src");
      cleanup();
      clearPlayback();
      resolve();
    });

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

    audio.play().catch(done);
  });
}

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
  stopLoadingMessages();
  clearPlayback();
  state.episode = null;
  state.playableTracks = [];
  els.searchInput.value = "";
  els.results.replaceChildren();
  showSearchMessage("");
  showHome();
  els.searchInput.focus();
}

function clearPlayback() {
  state.playback = null;
  resetPauseControl(false, true);
}

function resetRun() {
  state.runId += 1;
  interruptCurrentStep();
  clearSpeechCache();
  state.browserVoiceOnly = false;
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

  try {
    const response = await fetch(url);
    const text = await response.text();
    return normalizeDeezerResults(parseJsonp(text));
  } catch (error) {
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
    const callbackName = `sillageFmDeezer_${Date.now()}_${Math.random()
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

function isValidEpisode(value) {
  return Boolean(
    value &&
      typeof getEpisodeTitle(value) === "string" &&
      getEpisodeTitle(value).trim() &&
      typeof value.angle === "string" &&
      typeof value.intro === "string" &&
      Array.isArray(value.tracks) &&
      value.tracks.length === 8 &&
      value.tracks.every(
        (track) =>
          typeof track.artist === "string" &&
          typeof track.title === "string" &&
          typeof getTrackChronicle(track) === "string" &&
          getTrackChronicle(track).trim() &&
          typeof track.reason === "string",
      ),
  );
}

function updateCurrentTrack(track, index, total) {
  els.progress.textContent = `${index + 1} / ${total}`;
  els.currentRole.textContent = "";
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

function showRadio(episode, tracks) {
  els.radioTitle.textContent = getEpisodeTitle(episode) || "Émission en cours";
  renderQueue(tracks, 0);
  showScreen(els.radioScreen);
}

function getEpisodeTitle(episode) {
  return episode.title || episode.radioTitle || "";
}

function getEpisodeIntro(episode) {
  return episode?.intro || "";
}

function getTrackChronicle(track) {
  return track?.chronicle || track?.chronique || "";
}

function getTrackRole(track, index = 0) {
  return track?.role || Object.keys(roleLabels)[index] || "opener";
}

function getRoleLabel(role) {
  return roleLabels[role] || role;
}

function showLoading() {
  showSearchMessage("");
  els.results.replaceChildren();
  showScreen(els.loadingScreen);
  startLoadingMessages();
}

function showHome() {
  showScreen(els.homeScreen);
}

function showEnd() {
  showScreen(els.endScreen);
}

function showScreen(screen) {
  [els.homeScreen, els.loadingScreen, els.radioScreen, els.endScreen].forEach((item) => {
    item.classList.toggle("screen--active", item === screen);
  });
}

function showSearchMessage(message) {
  els.searchMessage.textContent = message;
}

function setLoadingMessage(message) {
  els.loadingMessage.textContent = message;
}

function startLoadingMessages() {
  let index = 0;
  setLoadingMessage(loadingMessages[index]);
  stopLoadingMessages();
  state.loadingTimer = window.setInterval(() => {
    index = (index + 1) % loadingMessages.length;
    setLoadingMessage(loadingMessages[index]);
  }, 1400);
}

function stopLoadingMessages() {
  window.clearInterval(state.loadingTimer);
  state.loadingTimer = 0;
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
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
