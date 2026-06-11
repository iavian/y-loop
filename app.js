"use strict";

/* ---------------- state ---------------- */

const state = {
  player: null,
  apiReady: false,
  playerReady: false,
  videoId: null,
  videoTitle: "",
  duration: 0,
  a: 0,
  b: 0,            // 0 means "not set yet" until duration known
  looping: true,
  loopCount: 0,
  rate: 1,
  pendingLoad: null, // {videoId, a, b, rate} queued before API ready
};

const $ = (sel) => document.querySelector(sel);

const els = {
  app: $("#app"),
  hero: $("#hero"),
  urlInput: $("#url-input"),
  track: $("#track"),
  range: $("#range"),
  progressFill: $("#progress-fill"),
  playhead: $("#playhead"),
  handleA: $("#handle-a"),
  handleB: $("#handle-b"),
  handleATime: $("#handle-a-time"),
  handleBTime: $("#handle-b-time"),
  timeCurrent: $("#time-current"),
  timeDuration: $("#time-duration"),
  btnPlay: $("#btn-play"),
  btnLoop: $("#btn-loop"),
  inputA: $("#input-a"),
  inputB: $("#input-b"),
  loopLength: $("#loop-length"),
  loopCount: $("#loop-count"),
  speedSlider: $("#speed-slider"),
  speedLabel: $("#speed-label"),
  loopsList: $("#loops-list"),
  recentList: $("#recent-list"),
  notes: $("#notes"),
  toast: $("#toast"),
  helpDialog: $("#help-dialog"),
};

/* ---------------- helpers ---------------- */

function fmt(t, decis = false) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (decis) {
    return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
  }
  const si = Math.floor(s);
  return `${m}:${si < 10 ? "0" : ""}${si}`;
}

function parseTime(str) {
  str = String(str).trim();
  if (!str) return NaN;
  const parts = str.split(":").map(Number);
  if (parts.some(isNaN)) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function parseVideoId(input) {
  input = input.trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input.includes("://") ? input : "https://" + input);
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    // youtu.be/ID, /shorts/ID, /embed/ID, /live/ID
    const m = url.pathname.match(/^\/(?:shorts\/|embed\/|live\/)?([\w-]{11})(?:$|\/)/);
    if (m) return m[1];
  } catch (_) { /* not a URL */ }
  return null;
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("show"), 2200);
}

/* ---------------- storage ---------------- */

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch (_) { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
};

const loopsKey = (id) => `looplab:loops:${id}`;
const notesKey = (id) => `looplab:notes:${id}`;
const RECENT_KEY = "looplab:recent";
const LAST_KEY = "looplab:last";

/* ---------------- YouTube player ---------------- */

window.onYouTubeIframeAPIReady = function () {
  state.apiReady = true;
  if (state.pendingLoad) {
    const p = state.pendingLoad;
    state.pendingLoad = null;
    createPlayer(p);
  }
};

function loadYTApi() {
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
}

function createPlayer({ videoId, a, b, rate }) {
  state.videoId = videoId;
  state.a = a || 0;
  state.b = b || 0;
  state.rate = rate || 1;
  state.loopCount = 0;
  state.duration = 0;
  state.videoTitle = "";

  if (state.player) {
    state.player.cueVideoById(videoId);
    return;
  }
  state.playerReady = false;
  state.player = new YT.Player("player", {
    videoId,
    playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
    },
  });
}

function onPlayerReady() {
  state.playerReady = true;
  onVideoLoaded();
}

function onPlayerStateChange(e) {
  if (e.data === YT.PlayerState.PLAYING) {
    els.btnPlay.textContent = "⏸";
    if (!state.duration) onVideoLoaded();
    acquireWakeLock();
  } else {
    els.btnPlay.textContent = "▶";
    if (e.data === YT.PlayerState.CUED && !state.duration) onVideoLoaded();
    releaseWakeLock();
  }
  if (e.data === YT.PlayerState.ENDED && state.looping) {
    state.player.seekTo(state.a, true);
    state.player.playVideo();
  }
  // Title may only be available once playback metadata loads
  const data = state.player.getVideoData && state.player.getVideoData();
  if (data && data.title && data.title !== state.videoTitle) {
    state.videoTitle = data.title;
    document.title = `${data.title} — LoopLab`;
    addToRecent();
  }
}

function onVideoLoaded() {
  state.duration = state.player.getDuration() || 0;
  if (!state.b || state.b > state.duration) state.b = state.duration;
  if (state.a >= state.b) state.a = 0;
  state.player.setPlaybackRate(state.rate);
  els.speedSlider.value = state.rate;
  els.timeDuration.textContent = fmt(state.duration);
  renderLoopUI();
  renderSavedLoops();
  loadNotes();
  saveLastSession();
}

/* ---------------- wake lock ---------------- */

// Keep the screen on while looping: iOS Safari pauses playback and freezes
// timers once the screen locks, which kills the A–B loop.
let wakeLock = null;

async function acquireWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock || acquireWakeLock._pending) return;
  acquireWakeLock._pending = true;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (_) { /* denied (low battery, hidden page, …) */ }
  acquireWakeLock._pending = false;
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.playerReady) return;
  if (state.player.getPlayerState() === YT.PlayerState.PLAYING) {
    // The OS drops the wake lock when the page is hidden
    acquireWakeLock();
  }
  // Timers were suspended while hidden; snap back if playback escaped the loop
  if (state.looping && state.b > state.a && state.duration) {
    const t = state.player.getCurrentTime();
    if (t >= state.b || t < state.a - 2) state.player.seekTo(state.a, true);
  }
});

/* ---------------- loop engine ---------------- */

// Poll frequently: YouTube exposes no timeupdate event.
setInterval(() => {
  if (!state.playerReady || !state.duration) return;
  const t = state.player.getCurrentTime();

  if (state.looping && state.b > state.a) {
    if (t >= state.b || t < state.a - 2) {
      state.player.seekTo(state.a, true);
      if (t >= state.b) {
        state.loopCount++;
        els.loopCount.textContent = `${state.loopCount} play${state.loopCount === 1 ? "" : "s"}`;
      }
    }
  }

  // timeline paint
  const pct = (x) => `${(x / state.duration) * 100}%`;
  els.playhead.style.left = pct(Math.min(t, state.duration));
  els.timeCurrent.textContent = fmt(t);
  try {
    els.progressFill.style.width = pct(state.player.getVideoLoadedFraction() * state.duration);
  } catch (_) { /* ignore */ }
}, 60);

function renderLoopUI() {
  const d = state.duration || 1;
  const aPct = (state.a / d) * 100;
  const bPct = (state.b / d) * 100;
  els.handleA.style.left = `${aPct}%`;
  els.handleB.style.left = `${bPct}%`;
  els.handleATime.textContent = fmt(state.a, true);
  els.handleBTime.textContent = fmt(state.b, true);
  els.range.style.left = `${aPct}%`;
  els.range.style.width = `${Math.max(0, bPct - aPct)}%`;
  if (document.activeElement !== els.inputA) els.inputA.value = fmt(state.a, true);
  if (document.activeElement !== els.inputB) els.inputB.value = fmt(state.b, true);
  els.loopLength.textContent = state.b > state.a ? `${(state.b - state.a).toFixed(1)}s loop` : "—";
  els.btnLoop.classList.toggle("on", state.looping);
}

function setA(t) {
  state.a = Math.max(0, Math.min(t, state.duration));
  if (state.a >= state.b) state.b = Math.min(state.duration, state.a + 1);
  state.loopCount = 0;
  renderLoopUI();
  saveLastSession();
}

function setB(t) {
  state.b = Math.max(0, Math.min(t, state.duration));
  if (state.b <= state.a) state.a = Math.max(0, state.b - 1);
  state.loopCount = 0;
  renderLoopUI();
  saveLastSession();
}

function clearLoop() {
  state.a = 0;
  state.b = state.duration;
  state.loopCount = 0;
  els.loopCount.textContent = "0 plays";
  renderLoopUI();
  saveLastSession();
  toast("Loop cleared");
}

function setRate(r) {
  state.rate = Math.min(2, Math.max(0.25, Math.round(r * 20) / 20));
  if (state.playerReady) state.player.setPlaybackRate(state.rate);
  els.speedSlider.value = state.rate;
  els.speedLabel.textContent = `${state.rate.toFixed(2)}×`;
  saveLastSession();
}

/* ---------------- timeline dragging ---------------- */

function trackTime(clientX) {
  const rect = els.track.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return frac * state.duration;
}

function bindHandle(handle, setter) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => setter(trackTime(ev.clientX));
    const up = (ev) => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

bindHandle(els.handleA, setA);
bindHandle(els.handleB, setB);

els.track.addEventListener("pointerdown", (e) => {
  if (e.target.classList.contains("handle")) return;
  if (!state.duration) return;
  state.player.seekTo(trackTime(e.clientX), true);
});

/* ---------------- saved loops ---------------- */

function renderSavedLoops() {
  const loops = store.get(loopsKey(state.videoId), []);
  els.loopsList.innerHTML = "";
  if (!loops.length) {
    els.loopsList.innerHTML = `<li class="empty">No saved loops for this video yet.</li>`;
    return;
  }
  loops.forEach((loop, i) => {
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `
      <span class="title"></span>
      <span class="meta">${fmt(loop.a, true)}–${fmt(loop.b, true)} · ${loop.rate}×</span>
      <button class="del" title="Delete">✕</button>`;
    li.querySelector(".title").textContent = loop.name;
    li.addEventListener("click", () => applyLoop(loop));
    li.querySelector(".del").addEventListener("click", (e) => {
      e.stopPropagation();
      loops.splice(i, 1);
      store.set(loopsKey(state.videoId), loops);
      renderSavedLoops();
    });
    els.loopsList.appendChild(li);
  });
}

function applyLoop(loop) {
  state.a = loop.a;
  state.b = loop.b;
  state.looping = true;
  state.loopCount = 0;
  setRate(loop.rate);
  renderLoopUI();
  state.player.seekTo(loop.a, true);
  state.player.playVideo();
  toast(`Loop “${loop.name}” loaded`);
}

function saveCurrentLoop() {
  if (!state.videoId || state.b <= state.a) return toast("Set A and B points first");
  const name = prompt("Name this loop:", `${fmt(state.a)}–${fmt(state.b)}`);
  if (name === null) return;
  const loops = store.get(loopsKey(state.videoId), []);
  loops.push({ name: name || `Loop ${loops.length + 1}`, a: state.a, b: state.b, rate: state.rate });
  store.set(loopsKey(state.videoId), loops);
  renderSavedLoops();
  toast("Loop saved");
}

/* ---------------- recent videos ---------------- */

function addToRecent() {
  let recent = store.get(RECENT_KEY, []);
  recent = recent.filter((r) => r.id !== state.videoId);
  recent.unshift({ id: state.videoId, title: state.videoTitle });
  store.set(RECENT_KEY, recent.slice(0, 12));
  renderRecent();
}

function renderRecent() {
  const recent = store.get(RECENT_KEY, []);
  els.recentList.innerHTML = "";
  if (!recent.length) {
    els.recentList.innerHTML = `<li class="empty">Videos you load will appear here.</li>`;
    return;
  }
  recent.forEach((r) => {
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `
      <img src="https://i.ytimg.com/vi/${r.id}/default.jpg" alt="">
      <span class="title"></span>
      <button class="del" title="Remove">✕</button>`;
    li.querySelector(".title").textContent = r.title || r.id;
    li.addEventListener("click", () => loadVideo({ videoId: r.id }));
    li.querySelector(".del").addEventListener("click", (e) => {
      e.stopPropagation();
      store.set(RECENT_KEY, store.get(RECENT_KEY, []).filter((x) => x.id !== r.id));
      renderRecent();
    });
    els.recentList.appendChild(li);
  });
}

/* ---------------- notes ---------------- */

function loadNotes() {
  els.notes.value = store.get(notesKey(state.videoId), "");
}

els.notes.addEventListener("input", () => {
  if (state.videoId) store.set(notesKey(state.videoId), els.notes.value);
});

function insertTimestamp() {
  if (!state.playerReady) return;
  const stamp = `[${fmt(state.player.getCurrentTime(), true)}] `;
  const { selectionStart: s, selectionEnd: e, value } = els.notes;
  els.notes.value = value.slice(0, s) + stamp + value.slice(e);
  els.notes.selectionStart = els.notes.selectionEnd = s + stamp.length;
  els.notes.focus();
  store.set(notesKey(state.videoId), els.notes.value);
}

/* ---------------- session / share ---------------- */

function saveLastSession() {
  if (!state.videoId) return;
  store.set(LAST_KEY, { videoId: state.videoId, a: state.a, b: state.b, rate: state.rate });
  syncUrl();
}

function buildLoopUrl() {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("v", state.videoId);
  if (state.b > state.a && (state.a > 0 || state.b < state.duration)) {
    url.searchParams.set("a", state.a.toFixed(1));
    url.searchParams.set("b", state.b.toFixed(1));
  }
  if (state.rate !== 1) url.searchParams.set("rate", state.rate);
  return url;
}

function syncUrl() {
  try { history.replaceState(null, "", buildLoopUrl()); }
  catch (_) { /* e.g. file:// in some browsers */ }
}

function shareLoop() {
  if (!state.videoId) return;
  const url = buildLoopUrl();
  navigator.clipboard.writeText(url.toString())
    .then(() => toast("Loop link copied to clipboard"))
    .catch(() => prompt("Copy this link:", url.toString()));
}

/* ---------------- load flow ---------------- */

function loadVideo({ videoId, a = 0, b = 0, rate = 1 }) {
  els.app.classList.remove("hidden");
  els.hero.classList.add("hidden");
  els.urlInput.value = "";
  const params = { videoId, a, b, rate };
  if (!state.apiReady) {
    state.pendingLoad = params;
    return;
  }
  createPlayer(params);
}

document.getElementById("url-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = parseVideoId(els.urlInput.value);
  if (!id) return toast("Couldn't find a YouTube video in that link");
  loadVideo({ videoId: id });
});

/* ---------------- controls wiring ---------------- */

function togglePlay() {
  if (!state.playerReady) return;
  const s = state.player.getPlayerState();
  s === YT.PlayerState.PLAYING ? state.player.pauseVideo() : state.player.playVideo();
}

function toggleLoop() {
  state.looping = !state.looping;
  renderLoopUI();
  toast(state.looping ? "Looping on" : "Looping off");
}

function jumpToA() {
  if (!state.playerReady) return;
  state.player.seekTo(state.a, true);
  state.player.playVideo();
}

function seekBy(dt) {
  if (!state.playerReady) return;
  state.player.seekTo(Math.max(0, Math.min(state.duration, state.player.getCurrentTime() + dt)), true);
}

$("#btn-play").addEventListener("click", togglePlay);
$("#btn-loop").addEventListener("click", toggleLoop);
$("#btn-to-a").addEventListener("click", jumpToA);
$("#btn-set-a").addEventListener("click", () => {
  if (!state.playerReady) return;
  setA(state.player.getCurrentTime());
  toast(`A = ${fmt(state.a, true)}`);
});
$("#btn-set-b").addEventListener("click", () => {
  if (!state.playerReady) return;
  setB(state.player.getCurrentTime());
  toast(`B = ${fmt(state.b, true)}`);
});
$("#btn-clear").addEventListener("click", clearLoop);
$("#btn-save-loop").addEventListener("click", saveCurrentLoop);
$("#btn-share").addEventListener("click", shareLoop);
$("#btn-stamp").addEventListener("click", insertTimestamp);
$("#speed-up").addEventListener("click", () => setRate(state.rate + 0.05));
$("#speed-down").addEventListener("click", () => setRate(state.rate - 0.05));
$("#speed-reset").addEventListener("click", () => setRate(1));
els.speedSlider.addEventListener("input", () => setRate(parseFloat(els.speedSlider.value)));
$("#help-btn").addEventListener("click", () => els.helpDialog.showModal());

for (const [input, setter] of [[els.inputA, setA], [els.inputB, setB]]) {
  input.addEventListener("change", () => {
    const t = parseTime(input.value);
    if (!isNaN(t)) setter(t);
    else renderLoopUI();
    input.blur();
  });
}

setInterval(() => {
  // keep the "+ 0:00" stamp button label live
  if (state.playerReady) $("#btn-stamp").textContent = `+ ${fmt(state.player.getCurrentTime())}`;
}, 1000);

/* ---------------- keyboard shortcuts ---------------- */

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;

  const key = e.key;
  let handled = true;
  switch (key.toLowerCase()) {
    case " ": case "k": togglePlay(); break;
    case "a": state.playerReady && setA(state.player.getCurrentTime()); toast(`A = ${fmt(state.a, true)}`); break;
    case "b": state.playerReady && setB(state.player.getCurrentTime()); toast(`B = ${fmt(state.b, true)}`); break;
    case "l": toggleLoop(); break;
    case "r": case "0": jumpToA(); break;
    case "s": saveCurrentLoop(); break;
    case "c": clearLoop(); break;
    case "t": insertTimestamp(); break;
    case "[": setRate(state.rate - 0.05); break;
    case "]": setRate(state.rate + 0.05); break;
    case "=": setRate(1); break;
    case "arrowleft": seekBy(e.shiftKey ? -1 : -5); break;
    case "arrowright": seekBy(e.shiftKey ? 1 : 5); break;
    case "?": els.helpDialog.showModal(); break;
    default:
      if (/^[1-9]$/.test(key) && state.duration) {
        state.player.seekTo(state.duration * (Number(key) / 10), true);
      } else {
        handled = false;
      }
  }
  if (handled) e.preventDefault();
});

/* ---------------- boot ---------------- */

(function boot() {
  loadYTApi();
  renderRecent();
  setRate(1);

  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("v") && parseVideoId(params.get("v"));
  if (fromUrl) {
    loadVideo({
      videoId: fromUrl,
      a: parseFloat(params.get("a")) || 0,
      b: parseFloat(params.get("b")) || 0,
      rate: parseFloat(params.get("rate")) || 1,
    });
    return;
  }
  // Restore last session if there was one
  const last = store.get(LAST_KEY, null);
  if (last && last.videoId) {
    els.urlInput.placeholder = "Paste a YouTube URL or video ID…  (Enter to reload last video)";
    els.urlInput.addEventListener("keydown", function restoreHint(e) {
      if (e.key === "Enter" && !els.urlInput.value.trim()) {
        e.preventDefault();
        loadVideo(last);
        els.urlInput.removeEventListener("keydown", restoreHint);
      }
    });
  }
})();
