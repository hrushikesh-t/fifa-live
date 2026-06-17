/* ════════════════════════════════════════════════════════════════
   FIFA Live — Frontend
   ────────────────────────────────────────────────────────────────
   Product:     Multi-league live football hub. Select any league,
                pick a match, get live score + stats + key events +
                commentary. Tweet any update in one click.

   Process:     1. On load: fetch /api/leagues → render tabs
                2. On tab select: fetch /api/scoreboard/<league> → fixtures
                3. On fixture click: fetch /api/match/<league>/<id> → detail
                4. Auto-poll: setInterval driven by poll_interval from server
                   (20 s live, 300 s pre/post). Only new commentary appended.

   Performance: Incremental commentary updates via sequence tracking.
                No full re-renders on poll. setInterval cleared on
                league switch or manual refresh to avoid double-polling.
   ════════════════════════════════════════════════════════════════ */

const TWEET_MAX  = 280;
const RING_CIRC  = 100.5;

/* ── App state ─────────────────────────────────────────────────── */
let state = {
  league:          "fifa.world",
  eventId:         null,
  eventLeague:     null,
  pollTimer:       null,
  lastCommentarySeq: -1,
  loading:         false,
};

/* ── Helpers ───────────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (text) e.textContent = text;
  return e;
};

function setLoading(on) {
  state.loading = on;
  $("spinner").classList.toggle("hidden", !on);
  $("refresh-icon").classList.toggle("hidden", on);
  $("refresh-btn").disabled = on;
}

function showError(msg) {
  const b = $("error-banner");
  b.textContent = "⚠ " + msg;
  b.classList.remove("hidden");
}
function hideError() { $("error-banner").classList.add("hidden"); }

function stamp() {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  $("poll-indicator").classList.add("hidden");
}

function startPolling(intervalSec) {
  stopPolling();
  if (intervalSec >= 300 || !state.eventId) return;
  $("poll-indicator").classList.remove("hidden");
  state.pollTimer = setInterval(() => loadMatchDetail(false), intervalSec * 1000);
}

/* ════════════════════════════════════════════════════════════════
   LEAGUES
   ════════════════════════════════════════════════════════════════ */
async function loadLeagues() {
  try {
    const data = await fetch("/api/leagues").then(r => r.json());
    const rail = $("league-tabs");
    rail.innerHTML = "";
    data.leagues.forEach(lg => {
      const btn = el("button", "league-tab", lg.name);
      btn.setAttribute("aria-label", lg.name);
      if (lg.id === state.league) btn.classList.add("active");
      btn.addEventListener("click", () => selectLeague(lg.id, btn));
      rail.appendChild(btn);
    });
  } catch (_) { /* silently skip — tabs just won't render */ }
}

function selectLeague(id, btn) {
  if (id === state.league && !btn) return;
  document.querySelectorAll(".league-tab").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  state.league    = id;
  state.eventId   = null;
  state.eventLeague = null;
  stopPolling();
  $("match-detail").classList.add("hidden");
  loadScoreboard();
}

/* ════════════════════════════════════════════════════════════════
   SCOREBOARD  (fixture list)
   ════════════════════════════════════════════════════════════════ */
async function loadScoreboard() {
  hideError();
  setLoading(true);
  showFixtureSkeletons();

  try {
    const data = await fetch(`/api/scoreboard/${state.league}`).then(r => r.json());
    if (data.error) { showError(data.error); renderFixtures([]); return; }

    $("fixtures-title").textContent = data.league_name + " — Fixtures";
    const liveCount = data.events.filter(e => e.state === "in").length;
    $("fixtures-meta").textContent = liveCount > 0
      ? `${liveCount} live · ${data.events.length} total`
      : `${data.events.length} fixture${data.events.length !== 1 ? "s" : ""}`;

    renderFixtures(data.events);
  } catch (_) {
    showError("Could not load fixtures.");
    renderFixtures([]);
  } finally {
    setLoading(false);
  }
}

function showFixtureSkeletons() {
  $("fixtures-grid").innerHTML = `
    <div class="fixture-skel"><div class="fs-team s-block"></div><div class="fs-score s-block"></div><div class="fs-team s-block"></div></div>
    <div class="fixture-skel"><div class="fs-team s-block"></div><div class="fs-score s-block"></div><div class="fs-team s-block"></div></div>
    <div class="fixture-skel"><div class="fs-team s-block"></div><div class="fs-score s-block"></div><div class="fs-team s-block"></div></div>`;
}

function renderFixtures(events) {
  const grid = $("fixtures-grid");
  grid.innerHTML = "";

  if (events.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
      <p>No fixtures found for this competition today.</p></div>`;
    return;
  }

  events.forEach(ev => {
    const card = el("div", "fixture-card");
    if (ev.state === "in")   card.classList.add("live-match");
    if (ev.id === state.eventId) card.classList.add("active");

    const scoreText  = (ev.state === "pre")
      ? "vs"
      : `${ev.home.score} - ${ev.away.score}`;
    const statusText = ev.state === "in"
      ? (ev.clock ? ev.clock + "'" : "LIVE")
      : ev.status_detail || "";

    // Home team column
    const homeCol = el("div", "fixture-team home");
    if (ev.home.logo) {
      const img = document.createElement("img");
      img.src = ev.home.logo; img.alt = ev.home.short;
      img.className = "fixture-team-logo"; img.loading = "lazy";
      homeCol.appendChild(img);
    }
    homeCol.appendChild(el("span", "fixture-team-name", ev.home.name));

    // Center
    const center = el("div", "fixture-center");
    center.appendChild(el("div", "fixture-score", scoreText));
    const statusEl = el("div",
      "fixture-status" + (ev.state === "in" ? " is-live" : ev.state === "pre" ? " is-pre" : ""),
      statusText
    );
    center.appendChild(statusEl);

    // Away team column
    const awayCol = el("div", "fixture-team away");
    if (ev.away.logo) {
      const img = document.createElement("img");
      img.src = ev.away.logo; img.alt = ev.away.short;
      img.className = "fixture-team-logo"; img.loading = "lazy";
      awayCol.appendChild(img);
    }
    awayCol.appendChild(el("span", "fixture-team-name", ev.away.name));

    card.appendChild(homeCol);
    card.appendChild(center);
    card.appendChild(awayCol);

    card.addEventListener("click", () => {
      document.querySelectorAll(".fixture-card").forEach(c => c.classList.remove("active"));
      card.classList.add("active");
      selectMatch(ev.id, state.league);
    });

    grid.appendChild(card);
  });
}

/* ════════════════════════════════════════════════════════════════
   MATCH DETAIL
   ════════════════════════════════════════════════════════════════ */
function selectMatch(eventId, league) {
  stopPolling();
  state.eventId        = eventId;
  state.eventLeague    = league;
  state.lastCommentarySeq = -1;
  $("match-detail").classList.remove("hidden");
  $("commentary-feed").innerHTML = "";
  $("key-events-list").innerHTML = "";
  $("stats-section").classList.add("hidden");
  $("key-events-section").classList.add("hidden");
  loadMatchDetail(true);
  $("match-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadMatchDetail(isFirstLoad = false) {
  if (!state.eventId) return;
  if (isFirstLoad) setLoading(true);
  hideError();

  try {
    const data = await fetch(
      `/api/match/${state.eventLeague}/${state.eventId}`
    ).then(r => r.json());

    if (data.error) { showError(data.error); return; }

    renderScore(data.match, data.league_name);
    renderStats(data.stat_rows);
    renderKeyEvents(data.key_events);
    appendCommentary(data.commentary, isFirstLoad);

    $("last-updated").textContent = "Updated " + stamp();
    startPolling(data.poll_interval);

  } catch (_) {
    showError("Could not load match detail.");
  } finally {
    if (isFirstLoad) setLoading(false);
  }
}

/* ── Score ─────────────────────────────────────────────────────── */
function renderScore(m, leagueName) {
  const isLive = m.state === "in";

  $("live-chip").classList.toggle("hidden", !isLive);
  $("match-clock").textContent = m.clock ? m.clock + "'" : "";
  $("match-status-detail").textContent = m.status_detail || "";
  $("league-badge").textContent = leagueName || "";

  setTeam("home", m.home);
  setTeam("away", m.away);
}

function setTeam(side, team) {
  $(`${side}-team`).textContent  = team.name  || "—";
  $(`${side}-score`).textContent = team.score !== "" ? team.score : "—";
  const logo = $(`${side}-logo`);
  if (team.logo) { logo.src = team.logo; logo.alt = team.name; logo.style.display = ""; }
  else { logo.style.display = "none"; }
}

/* ── Stats ─────────────────────────────────────────────────────── */
function renderStats(rows) {
  if (!rows || rows.length === 0) { $("stats-section").classList.add("hidden"); return; }
  $("stats-section").classList.remove("hidden");
  const strip = $("stats-strip");
  strip.innerHTML = "";

  rows.forEach(r => {
    // Parse possession-style floats (ESPN returns 53.3 for 53.3%)
    const hRaw = parseFloat(r.home) || 0;
    const aRaw = parseFloat(r.away) || 0;
    const total = hRaw + aRaw || 1;
    const hPct  = (hRaw / total * 50).toFixed(1);   // width as % of half
    const aPct  = (aRaw / total * 50).toFixed(1);

    const row = el("div");
    row.innerHTML = `
      <div class="stat-row">
        <div class="stat-val home">${r.home || "—"}</div>
        <div>
          <div class="stat-bar-wrap">
            <div class="stat-bar-home" style="width:${hPct}%"></div>
            <div class="stat-bar-away" style="width:${aPct}%"></div>
          </div>
          <div class="stat-label-row">${r.label}</div>
        </div>
        <div class="stat-val away">${r.away || "—"}</div>
      </div>`;
    strip.appendChild(row);
  });
}

/* ── Key Events ────────────────────────────────────────────────── */
const KE_ICON = {
  goal: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="icon-goal"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm0 2c.88 0 1.72.12 2.52.34L12 7.27 9.48 4.34C10.28 4.12 11.12 4 12 4zm-4 1.27l2.97 4.08L7 10.9V8.6A8.03 8.03 0 0 1 8 5.27zm8 0A8.03 8.03 0 0 1 17 8.6v2.29l-3.97-1.54L14 5.27zM6.1 12.5 10 11l-1.28 4.3-2.44-1.62A8.03 8.03 0 0 1 6.1 12.5zm11.8 0a8.03 8.03 0 0 1-.18 1.18l-2.44 1.62L14 11l3.9 1.5zm-7.66 5.9L12 15.4l1.76 3.01A8.07 8.07 0 0 1 12 18.5a8.07 8.07 0 0 1-1.76-.1z" fill="rgba(0,0,0,.2)"/></svg>`,
  yellow: `<svg width="12" height="15" viewBox="0 0 12 15" class="icon-card-y"><rect width="12" height="15" rx="2" fill="#f5a623"/></svg>`,
  red:    `<svg width="12" height="15" viewBox="0 0 12 15" class="icon-card-r"><rect width="12" height="15" rx="2" fill="#ff3b30"/></svg>`,
  sub:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="icon-sub"><path d="M17 3l4 4-4 4"/><path d="M21 7H9M7 21l-4-4 4-4"/><path d="M3 17h12"/></svg>`,
  other:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="icon-other"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>`,
};

function renderKeyEvents(events) {
  if (!events || events.length === 0) { $("key-events-section").classList.add("hidden"); return; }
  $("key-events-section").classList.remove("hidden");
  const list = $("key-events-list");
  list.innerHTML = "";

  events.forEach(ke => {
    const item = el("div", "key-event" + (ke.is_goal ? " is-goal" : ""));

    const icon = ke.is_goal   ? KE_ICON.goal
               : ke.is_card && ke.type.includes("Yellow") ? KE_ICON.yellow
               : ke.is_card   ? KE_ICON.red
               : ke.is_sub    ? KE_ICON.sub
               : KE_ICON.other;

    item.innerHTML = `
      <div class="ke-clock">${ke.clock || ""}</div>
      <div class="ke-icon">${icon}</div>
      <div class="ke-text">${escText(ke.text)}</div>`;
    list.appendChild(item);
  });
}

/* ── Commentary (incremental) ──────────────────────────────────── */
function appendCommentary(items, isFirstLoad) {
  const feed    = $("commentary-feed");
  const newItems = items.filter(c => c.sequence > state.lastCommentarySeq);

  if (isFirstLoad) {
    feed.innerHTML = "";
    state.lastCommentarySeq = -1;
  }

  if (items.length === 0 && isFirstLoad) {
    feed.innerHTML = `<div class="empty-state">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
      <p>No commentary yet.</p></div>`;
    return;
  }

  // On first load render all; on poll render only new
  const toRender = isFirstLoad ? items : newItems;
  if (toRender.length === 0) return;

  const frag = document.createDocumentFragment();
  toRender.forEach(item => {
    const card = el("div", "commentary-card");
    const timeDiv = el("div", "card-time", item.time || "");
    const bodyDiv = el("div", "card-body");
    const textEl  = el("p",   "card-text",  item.text);
    const btn     = el("button", "btn-tweet");
    btn.setAttribute("aria-label", "Tweet this update");
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width="11" height="11"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.911-5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>Tweet`;
    btn.addEventListener("click", () => openModal(item.text, item.time));
    bodyDiv.appendChild(textEl);
    bodyDiv.appendChild(btn);
    card.appendChild(timeDiv);
    card.appendChild(bodyDiv);
    frag.appendChild(card);
  });

  if (isFirstLoad) {
    feed.appendChild(frag);
  } else {
    feed.insertBefore(frag, feed.firstChild); // new items at top
  }

  if (toRender.length > 0) {
    state.lastCommentarySeq = Math.max(...toRender.map(c => c.sequence));
  }

  $("commentary-count").textContent =
    feed.querySelectorAll(".commentary-card").length + " updates";
}

function escText(str) {
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ════════════════════════════════════════════════════════════════
   TWEET MODAL
   ════════════════════════════════════════════════════════════════ */
let pendingText = "";

function buildTweet(text, time) {
  const tag    = " #FIFA2026 #Football ⚽";
  const prefix = time ? `${time}' — ` : "";
  const budget = TWEET_MAX - prefix.length - tag.length;
  const body   = text.length > budget ? text.slice(0, budget - 1) + "…" : text;
  return prefix + body + tag;
}

function openModal(text, time) {
  const composed = buildTweet(text, time);
  pendingText    = composed;
  const ta       = $("tweet-text");
  ta.value       = composed;
  updateCharUI(composed.length);
  $("tweet-modal").classList.remove("hidden");
  requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
}

function closeModal() {
  $("tweet-modal").classList.add("hidden");
  pendingText = "";
}

function updateCharUI(len) {
  const rem   = TWEET_MAX - len;
  const el2   = $("char-count");
  el2.textContent = rem;
  el2.className   = "char-num" + (rem < 0 ? " over" : rem < 30 ? " warn" : "");
  const offset    = RING_CIRC * (1 - Math.min(len / TWEET_MAX, 1));
  const ring      = $("char-ring");
  ring.style.strokeDashoffset = offset;
  ring.style.stroke = rem < 0 ? "#ff3b30" : rem < 30 ? "#f5a623" : "#0071e3";
}

$("tweet-text").addEventListener("input", function () {
  pendingText = this.value;
  updateCharUI(this.value.length);
});
$("tweet-modal").addEventListener("click", e => { if (e.target === $("tweet-modal")) closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
$("modal-close").addEventListener("click",  closeModal);
$("modal-cancel").addEventListener("click", closeModal);
$("modal-post").addEventListener("click", () => {
  const text = $("tweet-text").value.trim();
  if (!text) return;
  window.open("https://twitter.com/intent/tweet?text=" + encodeURIComponent(text), "_blank", "noopener,width=600,height=520");
  closeModal();
});

/* ════════════════════════════════════════════════════════════════
   REFRESH BUTTON  — reloads scoreboard, re-fetches current match
   ════════════════════════════════════════════════════════════════ */
$("refresh-btn").addEventListener("click", () => {
  stopPolling();
  state.lastCommentarySeq = -1;
  loadScoreboard();
  if (state.eventId) loadMatchDetail(true);
});

/* ════════════════════════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════════════════════════ */
(async () => {
  await loadLeagues();
  await loadScoreboard();
})();
