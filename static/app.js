/* ═══════════════════════════════════════════════════════════════
   FIFA Live — app.js
   Drives the OLED redesign: league tabs, fixture strip, match hero,
   stats/events/commentary panels, incremental commentary, goal toast,
   tweet modal, auto-polling.
═══════════════════════════════════════════════════════════════ */

"use strict";

// ── State ──────────────────────────────────────────────────────────
let currentLeague    = "fifa.world";
let selectedEventId  = null;
let lastHomeScore    = null;
let lastAwayScore    = null;
let lastCommentarySeq = 0;
let pollTimer        = null;
let matchPollTimer   = null;
let isRefreshing     = false;

const MAX_TWEET_CHARS = 280;
const CIRCUMFERENCE   = 2 * Math.PI * 13; // r=13 on 32×32 SVG ≈ 81.7

// ── DOM refs ───────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Init ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadLeagues();
  wireModalEvents();
  wireTweetTextarea();
  wireRefreshButton();
  wireTabBar();
});

// ═══════════════════════════════════════════════════════════════════
//  LEAGUES
// ═══════════════════════════════════════════════════════════════════

async function loadLeagues() {
  try {
    const res  = await fetch("/api/leagues");
    const data = await res.json();
    renderLeagueTabs(data.leagues || []);
    selectLeague(data.leagues?.[0]?.id || "fifa.world");
  } catch (e) {
    showError("Could not load leagues — " + e.message);
  }
}

function renderLeagueTabs(leagues) {
  const rail = $("league-tabs");
  rail.innerHTML = "";
  leagues.forEach(league => {
    const btn = document.createElement("button");
    btn.className = "league-tab";
    btn.textContent = league.name;
    btn.dataset.id  = league.id;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.addEventListener("click", () => selectLeague(league.id));
    rail.appendChild(btn);
  });
}

function selectLeague(id) {
  currentLeague   = id;
  selectedEventId = null;
  lastCommentarySeq = 0;
  clearMatchPolling();

  document.querySelectorAll(".league-tab").forEach(btn => {
    const active = btn.dataset.id === id;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });

  $("hero-section").classList.add("hidden");
  $("match-detail").classList.add("hidden");
  clearError();
  loadScoreboard();
}

// ═══════════════════════════════════════════════════════════════════
//  SCOREBOARD
// ═══════════════════════════════════════════════════════════════════

async function loadScoreboard(silent = false) {
  if (!silent) showSpinner(true);
  clearError();

  try {
    const res  = await fetch(`/api/scoreboard/${currentLeague}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderFixtureStrip(data);
    updatePollBadge(data.events?.some(e => e.state === "in"));

    clearScoreboardPolling();
    const interval = (data.poll_interval || 300) * 1000;
    pollTimer = setTimeout(() => loadScoreboard(true), interval);
  } catch (e) {
    showError("Scoreboard error — " + e.message);
  } finally {
    showSpinner(false);
  }
}

function renderFixtureStrip(data) {
  const strip  = $("fixture-strip");
  const events = data.events || [];

  $("fixtures-league-name").textContent = data.league_name || "";
  $("fixtures-meta").textContent = events.length
    ? `${events.length} match${events.length !== 1 ? "es" : ""}`
    : "No fixtures today";

  if (!events.length) {
    strip.innerHTML = `<div class="panel-empty" style="padding:20px 0">No fixtures available for this competition today.</div>`;
    return;
  }

  strip.innerHTML = "";
  events.forEach(ev => {
    const pill = buildFixturePill(ev);
    strip.appendChild(pill);
  });
}

function buildFixturePill(ev) {
  const isLive   = ev.state === "in";
  const isPre    = ev.state === "pre";
  const hasScore = ev.home.score !== "" && ev.away.score !== "";

  const pill = document.createElement("div");
  pill.className = "fx-pill" + (isLive ? " is-live" : "");
  pill.setAttribute("role", "listitem");
  pill.setAttribute("tabindex", "0");
  pill.dataset.eventId = ev.id;
  pill.setAttribute("aria-label",
    `${ev.home.name} vs ${ev.away.name}${hasScore ? `, score ${ev.home.score}-${ev.away.score}` : ""}`
  );
  if (ev.id === selectedEventId) pill.classList.add("active");

  const teams = document.createElement("div");
  teams.className = "fx-teams";
  teams.innerHTML = `
    <span>${escHtml(ev.home.short || ev.home.name)}</span>
    <span class="fx-vs">vs</span>
    <span>${escHtml(ev.away.short || ev.away.name)}</span>
  `;

  const bottom = document.createElement("div");
  bottom.className = "fx-bottom";

  const score = document.createElement("span");
  score.className = "fx-score";
  score.textContent = hasScore ? `${ev.home.score} – ${ev.away.score}` : "– – –";

  const status = document.createElement("span");
  status.className = "fx-status" + (isLive ? " live" : isPre ? " pre" : "");
  if (isLive && ev.clock) {
    status.textContent = ev.clock + "'";
  } else {
    status.textContent = isLive ? "LIVE" : isPre ? (ev.status_detail || "Upcoming") : "FT";
  }

  bottom.appendChild(score);
  bottom.appendChild(status);
  pill.appendChild(teams);
  pill.appendChild(bottom);

  pill.addEventListener("click", () => selectMatch(ev.id));
  pill.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectMatch(ev.id); }
  });

  return pill;
}

// ═══════════════════════════════════════════════════════════════════
//  MATCH DETAIL
// ═══════════════════════════════════════════════════════════════════

function selectMatch(id) {
  selectedEventId   = id;
  lastCommentarySeq = 0;
  lastHomeScore     = null;
  lastAwayScore     = null;

  document.querySelectorAll(".fx-pill").forEach(p => {
    p.classList.toggle("active", p.dataset.eventId === id);
  });

  clearMatchPolling();
  loadMatchDetail();
}

async function loadMatchDetail(silent = false) {
  if (!selectedEventId) return;
  if (!silent) showSpinner(true);

  try {
    const res  = await fetch(`/api/match/${currentLeague}/${selectedEventId}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderScore(data.match, data.league_name);
    renderStats(data);
    renderKeyEvents(data.key_events || []);
    appendCommentary(data.commentary || []);
    updatePollBadge(data.match?.state === "in");

    $("hero-section").classList.remove("hidden");
    $("match-detail").classList.remove("hidden");

    clearMatchPolling();
    const interval = (data.poll_interval || 300) * 1000;
    matchPollTimer = setTimeout(() => loadMatchDetail(true), interval);
  } catch (e) {
    showError("Match detail error — " + e.message);
  } finally {
    showSpinner(false);
  }
}

// ── Score Hero ─────────────────────────────────────────────────────

function renderScore(match, leagueName) {
  if (!match) return;

  const isLive = match.state === "in";

  $("home-name").textContent = match.home.name || "—";
  $("away-name").textContent = match.away.name || "—";
  $("stat-home-abbr").textContent = (match.home.short || match.home.name || "HME").substring(0, 3).toUpperCase();
  $("stat-away-abbr").textContent = (match.away.short || match.away.name || "AWY").substring(0, 3).toUpperCase();

  setLogo($("home-logo"), match.home.logo, match.home.name);
  setLogo($("away-logo"), match.away.logo, match.away.name);

  const hs = match.home.score ?? "—";
  const as = match.away.score ?? "—";

  if (lastHomeScore !== null && hs !== "—" && hs !== lastHomeScore) {
    setScoreWithFlash($("home-score"), hs);
    showGoalToast(`GOAL! ${match.home.name}  ${hs}–${as}`);
  } else {
    $("home-score").textContent = hs;
  }

  if (lastAwayScore !== null && as !== "—" && as !== lastAwayScore) {
    setScoreWithFlash($("away-score"), as);
    showGoalToast(`GOAL! ${hs}–${as}  ${match.away.name}`);
  } else {
    $("away-score").textContent = as;
  }

  lastHomeScore = hs;
  lastAwayScore = as;

  const liveChip  = $("live-chip");
  const heroClock = $("hero-clock");
  const heroStatus = $("hero-status");

  liveChip.classList.toggle("hidden", !isLive);
  if (isLive && match.clock) {
    heroClock.textContent  = match.clock + "'";
    heroStatus.textContent = "";
  } else {
    heroClock.textContent  = "";
    heroStatus.textContent = match.status_detail || "";
  }

  const leagueEl = $("hero-league");
  if (leagueEl) leagueEl.textContent = leagueName || "";

  $("hero-updated").textContent = "Updated " + new Date().toLocaleTimeString();
}

function setLogo(img, src, alt) {
  if (src) {
    img.src = src;
    img.alt = alt || "";
    img.style.display = "";
  } else {
    img.src = "";
    img.style.display = "none";
  }
}

function setScoreWithFlash(el, value) {
  el.textContent = value;
  el.classList.remove("flashing");
  void el.offsetWidth;
  el.classList.add("flashing");
  el.addEventListener("animationend", () => el.classList.remove("flashing"), { once: true });
}

// ── Stats ──────────────────────────────────────────────────────────

function renderStats(data) {
  const rows    = data.stat_rows || [];
  const match   = data.match    || {};
  const content = $("stats-content");

  if (!rows.length) {
    content.innerHTML = `<div class="panel-empty">${
      match.state === "pre"
        ? "Stats available once the match kicks off."
        : "No statistics available."
    }</div>`;
    return;
  }

  content.innerHTML = rows.map(row => {
    const hv    = parseFloat(row.home) || 0;
    const av    = parseFloat(row.away) || 0;
    const total = hv + av;
    const hw    = total > 0 ? Math.min(50, (hv / total) * 50) : 0;
    const aw    = total > 0 ? Math.min(50, (av / total) * 50) : 0;

    return `
      <div class="stat-row">
        <span class="stat-val home">${escHtml(String(row.home || "0"))}</span>
        <div>
          <div class="stat-bar-track">
            <div class="stat-bar-home" style="width:${hw}%"></div>
            <div class="stat-bar-away" style="width:${aw}%"></div>
          </div>
          <div class="stat-label-wrap">${escHtml(row.label)}</div>
        </div>
        <span class="stat-val away">${escHtml(String(row.away || "0"))}</span>
      </div>
    `;
  }).join("");
}

// ── Key Events ─────────────────────────────────────────────────────

function renderKeyEvents(keyEvents) {
  const container = $("events-content");

  if (!keyEvents.length) {
    container.innerHTML = `<div class="panel-empty">Goals, cards and substitutions appear here during the match.</div>`;
    return;
  }

  container.innerHTML = keyEvents.map(ke => {
    const isRedCard = ke.type.toLowerCase().includes("red");
    const iconClass = ke.is_goal ? "goal"
      : ke.is_card ? (isRedCard ? "card-r" : "card-y")
      : ke.is_sub  ? "sub"
      : "";

    return `
      <div class="ke-item${ke.is_goal ? " is-goal" : ""}">
        <span class="ke-clock">${escHtml(ke.clock || "")}</span>
        <span class="ke-icon ${iconClass}" aria-hidden="true">${keIcon(ke)}</span>
        <span class="ke-text">${escHtml(ke.text)}</span>
      </div>
    `;
  }).join("");
}

function keIcon(ke) {
  if (ke.is_goal) return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 7l2.5 5-2.5 4-2.5-4L12 7z"/></svg>`;
  if (ke.is_card) return `<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><rect width="10" height="14" rx="1.5"/></svg>`;
  if (ke.is_sub)  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="7 16 2 12 7 8"/><polyline points="17 8 22 12 17 16"/></svg>`;
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
}

// ── Commentary ─────────────────────────────────────────────────────

function appendCommentary(commentary) {
  const feed = $("commentary-feed");

  if (!commentary.length) {
    feed.innerHTML = `<div class="feed-empty">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Commentary will appear here once the match starts.
    </div>`;
    updateCommentaryCount(0);
    return;
  }

  const newItems = commentary.filter(c => c.sequence > lastCommentarySeq);

  if (commentary.length > 0) {
    const maxSeq = Math.max(...commentary.map(c => c.sequence));
    if (maxSeq > lastCommentarySeq) lastCommentarySeq = maxSeq;
  }

  const isFirstLoad = !feed.querySelector(".commentary-card");

  if (isFirstLoad) {
    feed.innerHTML = "";
    commentary.forEach(c => feed.appendChild(buildCommentaryCard(c)));
  } else if (newItems.length) {
    newItems.sort((a, b) => b.sequence - a.sequence);
    newItems.forEach(c => feed.insertBefore(buildCommentaryCard(c), feed.firstChild));

    const tabCount = $("tab-count");
    if (tabCount) {
      tabCount.classList.remove("hidden");
      tabCount.textContent = `+${newItems.length}`;
      setTimeout(() => tabCount.classList.add("hidden"), 4000);
    }
  }

  updateCommentaryCount(commentary.length);
}

function buildCommentaryCard(c) {
  const card = document.createElement("div");
  card.className = "commentary-card";
  card.dataset.seq = c.sequence;

  const timeEl = document.createElement("span");
  timeEl.className = "c-time";
  timeEl.textContent = c.time || "";

  const body = document.createElement("div");
  body.className = "c-body";

  const text = document.createElement("p");
  text.className = "c-text";
  text.textContent = c.text;

  const tweetBtn = document.createElement("button");
  tweetBtn.className = "btn-tweet";
  tweetBtn.setAttribute("aria-label", "Post this to X");
  tweetBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path d="M15.2 2h2.76l-6.02 6.88 7.08 9.37H13.47l-3.93-5.19-4.5 5.19H2.3l6.44-7.37L1.05 2H7.4l3.55 4.69L15.2 2Z"/>
  </svg>Post`;

  tweetBtn.addEventListener("click", () => openModal(c.text, c.time));

  body.appendChild(text);
  body.appendChild(tweetBtn);
  card.appendChild(timeEl);
  card.appendChild(body);

  return card;
}

function updateCommentaryCount(n) {
  const el = $("commentary-count");
  if (el) el.textContent = n ? `${n} entries` : "";
}

// ═══════════════════════════════════════════════════════════════════
//  GOAL TOAST
// ═══════════════════════════════════════════════════════════════════

let toastTimer = null;

function showGoalToast(msg) {
  const toast = $("goal-toast");
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);

  toast.textContent = msg;
  toast.classList.remove("hidden", "leaving");

  toastTimer = setTimeout(() => {
    toast.classList.add("leaving");
    setTimeout(() => toast.classList.add("hidden"), 250);
  }, 4500);
}

// ═══════════════════════════════════════════════════════════════════
//  MOBILE TAB BAR
// ═══════════════════════════════════════════════════════════════════

function wireTabBar() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;

      document.querySelectorAll(".tab-btn").forEach(b => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });

      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        const panelMap = {
          stats:      $("stats-panel"),
          events:     $("events-panel"),
          commentary: $("commentary-panel"),
        };
        Object.entries(panelMap).forEach(([key, panel]) => {
          if (panel) panel.style.display = key === target ? "block" : "none";
        });
      }

      if (target === "commentary") {
        const tabCount = $("tab-count");
        if (tabCount) tabCount.classList.add("hidden");
      }
    });
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) {
      ["stats-panel", "events-panel", "commentary-panel"].forEach(id => {
        const el = $(id);
        if (el) el.style.display = "";
      });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
//  TWEET MODAL
// ═══════════════════════════════════════════════════════════════════

function wireModalEvents() {
  $("modal-close")?.addEventListener("click", closeModal);
  $("modal-cancel")?.addEventListener("click", closeModal);
  $("modal-post")?.addEventListener("click", postTweet);

  $("tweet-modal")?.addEventListener("click", e => {
    if (e.target === $("tweet-modal")) closeModal();
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeModal();
  });
}

function wireTweetTextarea() {
  $("tweet-text")?.addEventListener("input", updateCharRing);
}

function openModal(text, time) {
  const modal = $("tweet-modal");
  const ta    = $("tweet-text");
  if (!modal || !ta) return;

  const prefix = time ? `${time}' — ` : "";
  ta.value = (prefix + text).substring(0, MAX_TWEET_CHARS);
  modal.classList.remove("hidden");
  updateCharRing();
  setTimeout(() => ta.focus(), 50);
}

function closeModal() {
  $("tweet-modal")?.classList.add("hidden");
}

function postTweet() {
  const text = ($("tweet-text")?.value || "").trim();
  if (!text) return;
  const url = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text);
  window.open(url, "_blank", "noopener,noreferrer,width=550,height=420");
  closeModal();
}

function updateCharRing() {
  const ta      = $("tweet-text");
  const ring    = $("char-ring");
  const counter = $("char-count");
  if (!ta || !ring || !counter) return;

  const used   = ta.value.length;
  const left   = MAX_TWEET_CHARS - used;
  const offset = CIRCUMFERENCE * (1 - used / MAX_TWEET_CHARS);

  ring.style.strokeDashoffset = offset;
  ring.style.stroke = left < 0 ? "var(--red)" : left < 20 ? "var(--gold)" : "var(--blue)";

  counter.textContent = left;
  counter.className   = "char-num" + (left < 0 ? " over" : left < 20 ? " warn" : "");
}

// ═══════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════

function wireRefreshButton() {
  $("refresh-btn")?.addEventListener("click", () => {
    if (isRefreshing) return;
    if (selectedEventId) loadMatchDetail();
    else loadScoreboard();
  });
}

function showSpinner(on) {
  isRefreshing = on;
  $("spinner")?.classList.toggle("hidden", !on);
  $("refresh-icon")?.classList.toggle("hidden", on);
  const btn = $("refresh-btn");
  if (btn) btn.disabled = on;
}

function updatePollBadge(hasLive) {
  $("poll-badge")?.classList.toggle("hidden", !hasLive);
}

function showError(msg) {
  const el = $("error-banner");
  if (!el) return;
  el.setAttribute("data-msg", msg);
  el.classList.remove("hidden");
}

function clearError() {
  $("error-banner")?.classList.add("hidden");
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clearScoreboardPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function clearMatchPolling() {
  if (matchPollTimer) { clearTimeout(matchPollTimer); matchPollTimer = null; }
}
