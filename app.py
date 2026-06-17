"""
FIFA Live — Flask backend powered by ESPN's public soccer API.

Product:   Real-time football scores, commentary, key events and stats
           across 10+ leagues. No API key required.
Process:   Client polls /api/scoreboard/<league> to list fixtures, then
           /api/match/<league>/<id> for full match detail. Server caches
           every ESPN response to stay well within rate limits.
Performance: Live-match cache TTL 20 s, pre/post-match 300 s.
           Target <50 ms from cache, <900 ms cold. Zero framework overhead.
"""

from flask import Flask, render_template, jsonify
import requests
import threading
import time

app = Flask(__name__)

# ── ESPN endpoints ────────────────────────────────────────────────
ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer"

LEAGUES = {
    "fifa.world":     "FIFA World Cup 2026",
    "eng.1":          "Premier League",
    "esp.1":          "La Liga",
    "ger.1":          "Bundesliga",
    "ita.1":          "Serie A",
    "fra.1":          "Ligue 1",
    "uefa.champions": "Champions League",
    "uefa.europa":    "Europa League",
    "usa.1":          "MLS",
    "fifa.friendly":  "Internationals",
}

# Key stats to surface prominently in the UI
SURFACE_STATS = [
    "POSSESSION", "SHOTS", "ON GOAL",
    "Corner Kicks", "Yellow Cards", "Red Cards",
    "Saves", "Fouls",
]

ESPN_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

# ── In-memory cache ───────────────────────────────────────────────
_cache: dict = {}
_lock = threading.Lock()


def cached(key: str, ttl: int, fetch):
    """Return (data, from_cache). Calls fetch() on a miss."""
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit["t"] < ttl:
            return hit["d"], True
    data = fetch()
    with _lock:
        _cache[key] = {"d": data, "t": time.monotonic()}
    return data, False


def espn(path: str) -> dict:
    r = requests.get(f"{ESPN_BASE}/{path}", headers=ESPN_HEADERS, timeout=10)
    r.raise_for_status()
    return r.json()


# ── Helpers ───────────────────────────────────────────────────────

def _competitor(competitors: list, side: str) -> dict:
    """Pull the home or away competitor dict."""
    return next(
        (c for c in competitors if c.get("homeAway") == side),
        competitors[0] if side == "home" else competitors[-1],
    )


def _team_shape(c: dict) -> dict:
    t = c["team"]
    return {
        "name":  t.get("displayName", ""),
        "short": t.get("abbreviation", ""),
        "logo":  t.get("logo", ""),
        "score": c.get("score", ""),
    }


def _clock_str(obj) -> str:
    if isinstance(obj, dict):
        return obj.get("displayValue", "")
    return str(obj) if obj else ""


def _poll_interval(state: str) -> int:
    return {"in": 20, "pre": 300}.get(state, 300)


# ── Routes ────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/leagues")
def leagues_route():
    return jsonify({
        "leagues": [{"id": k, "name": v} for k, v in LEAGUES.items()]
    })


@app.route("/api/scoreboard/<league>")
def scoreboard(league: str):
    if league not in LEAGUES:
        return jsonify({"error": "Unknown league"}), 400

    try:
        raw, from_cache = cached(
            f"sb:{league}", ttl=30,
            fetch=lambda: espn(f"{league}/scoreboard"),
        )
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502

    events = []
    for ev in raw.get("events", []):
        comp       = ev["competitions"][0]
        status     = ev["status"]
        state      = status["type"]["state"]          # pre / in / post
        home       = _team_shape(_competitor(comp["competitors"], "home"))
        away       = _team_shape(_competitor(comp["competitors"], "away"))

        events.append({
            "id":            ev["id"],
            "name":          ev["name"],
            "state":         state,
            "clock":         status.get("displayClock", ""),
            "period":        status.get("period", 0),
            "status_detail": status["type"].get("shortDetail", ""),
            "home":          home,
            "away":          away,
        })

    # Live → upcoming → finished
    _order = {"in": 0, "pre": 1, "post": 2}
    events.sort(key=lambda e: _order.get(e["state"], 9))
    any_live = any(e["state"] == "in" for e in events)

    return jsonify({
        "league":        league,
        "league_name":   LEAGUES[league],
        "events":        events,
        "cached":        from_cache,
        "poll_interval": 15 if any_live else 300,
    })


@app.route("/api/match/<league>/<event_id>")
def match_detail(league: str, event_id: str):
    if league not in LEAGUES:
        return jsonify({"error": "Unknown league"}), 400

    try:
        raw, from_cache = cached(
            f"match:{league}:{event_id}", ttl=20,
            fetch=lambda: espn(f"{league}/summary?event={event_id}"),
        )
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502

    # ── Score header ──────────────────────────────────────────────
    hcomp   = raw["header"]["competitions"][0]
    state   = hcomp["status"]["type"]["state"]
    home    = _team_shape(_competitor(hcomp["competitors"], "home"))
    away    = _team_shape(_competitor(hcomp["competitors"], "away"))

    match = {
        "id":            event_id,
        "state":         state,
        "clock":         hcomp["status"].get("displayClock", ""),
        "period":        hcomp["status"].get("period", 0),
        "status_detail": hcomp["status"]["type"].get("shortDetail", ""),
        "home":          home,
        "away":          away,
    }

    # ── Commentary (newest first) ─────────────────────────────────
    commentary = []
    for c in raw.get("commentary", []):
        text = (c.get("text") or "").strip()
        if not text:
            continue
        commentary.append({
            "sequence": c.get("sequence", 0),
            "time":     _clock_str(c.get("clock") or c.get("time", "")),
            "text":     text,
        })
    commentary.sort(key=lambda x: x["sequence"], reverse=True)

    # ── Key events ────────────────────────────────────────────────
    key_events = []
    skip_types = {"Start Delay", "End Delay"}
    for ke in raw.get("keyEvents", []):
        ev_type = (ke.get("type") or {}).get("text", "")
        if ev_type in skip_types:
            continue
        text = (ke.get("text") or "").strip()
        if not text:
            continue
        key_events.append({
            "clock":   _clock_str(ke.get("clock", "")),
            "type":    ev_type,
            "text":    text,
            "is_goal": "Goal" in ev_type or bool(ke.get("scoringPlay")),
            "is_card": "Card" in ev_type,
            "is_sub":  "Substitution" in ev_type,
        })

    # ── Stats ─────────────────────────────────────────────────────
    teams_stats = []
    for td in raw.get("boxscore", {}).get("teams", []):
        lookup = {s["label"]: s["displayValue"] for s in td.get("statistics", [])}
        teams_stats.append({
            "team":    td["team"]["displayName"],
            "is_home": td.get("homeAway", "home") == "home",
            "stats":   lookup,
        })

    # Ensure home team is first
    teams_stats.sort(key=lambda t: 0 if t["is_home"] else 1)

    # Build surface stats rows: [{label, home_val, away_val}]
    stat_rows = []
    if len(teams_stats) == 2:
        home_s = teams_stats[0]["stats"]
        away_s = teams_stats[1]["stats"]
        for label in SURFACE_STATS:
            hv = home_s.get(label, "")
            av = away_s.get(label, "")
            if hv or av:
                stat_rows.append({"label": label, "home": hv, "away": av})

    return jsonify({
        "match":         match,
        "commentary":    commentary,
        "key_events":    key_events,
        "stat_rows":     stat_rows,
        "cached":        from_cache,
        "poll_interval": _poll_interval(state),
        "league":        league,
        "league_name":   LEAGUES.get(league, league),
    })


if __name__ == "__main__":
    app.run(debug=True)
