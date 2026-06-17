/* ── Constants ────────────────────────────────────────────────── */
const TWEET_MAX   = 280;
const RING_CIRC   = 100.5; // 2π × r=16
let   pendingText = "";

/* ── Loading state ────────────────────────────────────────────── */
function setLoading(on) {
  const btn = document.getElementById("refresh-btn");
  document.getElementById("spinner").classList.toggle("hidden", !on);
  document.getElementById("refresh-icon").classList.toggle("hidden", on);
  btn.disabled = on;
}

/* ── Error ─────────────────────────────────────────────────────── */
function showError(msg) {
  const el = document.getElementById("error-banner");
  el.textContent = "⚠ " + msg;
  el.classList.remove("hidden");
}
function hideError() {
  document.getElementById("error-banner").classList.add("hidden");
}

/* ── Render scoreboard ─────────────────────────────────────────── */
function renderScore(match, pageTitle) {
  const section   = document.getElementById("scoreboard-section");
  const titleBar  = document.getElementById("page-title-bar");

  if (match && (match.home_team || match.away_team)) {
    document.getElementById("home-team").textContent  = match.home_team  || "—";
    document.getElementById("away-team").textContent  = match.away_team  || "—";
    document.getElementById("home-score").textContent = match.home_score ?? "—";
    document.getElementById("away-score").textContent = match.away_score ?? "—";

    const t = document.getElementById("match-time");
    t.textContent = match.time ? match.time + "'" : "";

    const s = document.getElementById("match-status");
    s.textContent = match.status || "";

    section.classList.remove("hidden");
    titleBar.classList.add("hidden");
  } else {
    section.classList.add("hidden");
    if (pageTitle) {
      document.getElementById("page-title-text").textContent = pageTitle;
      titleBar.classList.remove("hidden");
    }
  }
}

/* ── Build commentary card (NO inline onclick — closures only) ─── */
function buildCard(item) {
  const card = document.createElement("div");
  card.className = "commentary-card" + (item.is_key ? " is-key" : "");

  // Time column
  const timeDiv      = document.createElement("div");
  timeDiv.className  = "card-time";
  timeDiv.textContent = item.time || "";

  // Body column
  const bodyDiv   = document.createElement("div");
  bodyDiv.className = "card-body";

  const textEl    = document.createElement("p");
  textEl.className = "card-text";
  textEl.textContent = item.text || "";

  // Tweet button — closure captures item values safely
  const btn = document.createElement("button");
  btn.className = "btn-tweet";
  btn.setAttribute("aria-label", "Tweet this update");
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.911-5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>Tweet`;

  btn.addEventListener("click", () => openModal(item.text, item.time));

  bodyDiv.appendChild(textEl);
  bodyDiv.appendChild(btn);
  card.appendChild(timeDiv);
  card.appendChild(bodyDiv);
  return card;
}

/* ── Empty state ──────────────────────────────────────────────── */
function renderEmpty() {
  const feed = document.getElementById("commentary-feed");
  feed.innerHTML = `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 8v4l3 3"/>
      </svg>
      <p>No live updates found right now.<br>Hit Refresh to try again.</p>
    </div>`;
}

/* ── Load data ─────────────────────────────────────────────────── */
async function loadData() {
  hideError();
  setLoading(true);

  // Show skeletons, hide real feed
  document.getElementById("skeleton-container").classList.remove("hidden");
  document.getElementById("commentary-feed").classList.add("hidden");
  document.getElementById("feed-header").classList.add("hidden");

  try {
    const res  = await fetch("/api/football");
    const data = await res.json();

    if (!res.ok || data.error) {
      showError(data.error || "Unable to load live data. Please try refreshing.");
      renderEmpty();
    } else {
      renderScore(data.match, data.page_title);

      const feed  = document.getElementById("commentary-feed");
      const items = data.commentary || [];
      feed.innerHTML = "";

      if (items.length === 0) {
        renderEmpty();
      } else {
        const frag = document.createDocumentFragment();
        items.forEach(item => frag.appendChild(buildCard(item)));
        feed.appendChild(frag);

        const countEl = document.getElementById("update-count");
        countEl.textContent = items.length + " update" + (items.length !== 1 ? "s" : "");
        document.getElementById("feed-header").classList.remove("hidden");
      }

      feed.classList.remove("hidden");
    }
  } catch (_) {
    showError("Network error — check your connection and try again.");
    renderEmpty();
    document.getElementById("commentary-feed").classList.remove("hidden");
  } finally {
    document.getElementById("skeleton-container").classList.add("hidden");
    setLoading(false);
  }
}

/* ════════════════════════════════════════════════════════════════
   TWEET MODAL
   ════════════════════════════════════════════════════════════════ */

function buildTweetText(text, time) {
  const tag    = " #FIFA2026 #Football ⚽";
  const prefix = time ? `${time}' — ` : "";
  const budget = TWEET_MAX - prefix.length - tag.length;
  const body   = text.length > budget ? text.slice(0, budget - 1) + "…" : text;
  return prefix + body + tag;
}

function openModal(text, time) {
  const composed    = buildTweetText(text, time);
  pendingText       = composed;
  const ta          = document.getElementById("tweet-text");
  ta.value          = composed;
  updateCharUI(composed.length);
  document.getElementById("tweet-modal").classList.remove("hidden");
  requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
}

function closeModal() {
  document.getElementById("tweet-modal").classList.add("hidden");
  pendingText = "";
}

function updateCharUI(len) {
  const remaining = TWEET_MAX - len;
  const el        = document.getElementById("char-count");
  el.textContent  = remaining;
  el.className    = "char-num" + (remaining < 0 ? " over" : remaining < 30 ? " warn" : "");

  // Circular ring progress
  const ring   = document.getElementById("char-ring");
  const ratio  = Math.min(len / TWEET_MAX, 1);
  const offset = RING_CIRC * (1 - ratio);
  ring.style.strokeDashoffset = offset;
  ring.style.stroke = remaining < 0 ? "#ff3b30" : remaining < 30 ? "#f5a623" : "#0071e3";
}

/* Wire up textarea */
document.getElementById("tweet-text").addEventListener("input", function () {
  pendingText = this.value;
  updateCharUI(this.value.length);
});

/* Close on backdrop click */
document.getElementById("tweet-modal").addEventListener("click", function (e) {
  if (e.target === this) closeModal();
});

/* Close on Escape */
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeModal();
});

/* Wire close / cancel / post buttons */
document.getElementById("modal-close").addEventListener("click",  closeModal);
document.getElementById("modal-cancel").addEventListener("click", closeModal);
document.getElementById("modal-post").addEventListener("click", () => {
  const text = document.getElementById("tweet-text").value.trim();
  if (!text) return;
  window.open(
    "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text),
    "_blank",
    "noopener,width=600,height=520"
  );
  closeModal();
});

/* ── Init ──────────────────────────────────────────────────────── */
document.getElementById("refresh-btn").addEventListener("click", loadData);
loadData();
