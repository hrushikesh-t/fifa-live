from flask import Flask, render_template, jsonify
import requests
from bs4 import BeautifulSoup
import json
import re
from datetime import datetime, timezone

app = Flask(__name__)

BBC_URL = "https://www.bbc.com/sport/football/live/cp36z3qpzrxt"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}


# ── Helpers ─────────────────────────────────────────────────────────────────

def to_sentences(text, n=4):
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    parts = re.split(r"(?<=[.!?])\s+", text)
    parts = [p.strip() for p in parts if len(p.strip()) > 8]
    return " ".join(parts[:n])


def fmt_time(ts):
    if not ts:
        return ""
    if isinstance(ts, (int, float)):
        try:
            dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
            return dt.strftime("%H:%M")
        except Exception:
            return ""
    ts = str(ts)
    if "T" in ts or ts.endswith("Z"):
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return dt.strftime("%H:%M")
        except Exception:
            pass
    m = re.match(r"\d{1,2}:\d{2}", ts)
    return m.group() if m else ts[:8]


# ── JSON recursive walker ────────────────────────────────────────────────────

def walk(obj, c, depth=0):
    """Recursively mine __NEXT_DATA__ for match info and commentary."""
    if depth > 15 or not isinstance(obj, (dict, list)):
        return

    if isinstance(obj, list):
        for item in obj:
            walk(item, c, depth + 1)
        return

    t = str(obj.get("type") or obj.get("componentType") or "").upper()

    # ── Score detection ──────────────────────────────────────────
    if not c["match"]:
        home = obj.get("homeTeam") or obj.get("home") or {}
        away = obj.get("awayTeam") or obj.get("away") or {}
        if isinstance(home, dict) and isinstance(away, dict):
            hn = home.get("name") or home.get("fullName") or home.get("abbr") or ""
            an = away.get("name") or away.get("fullName") or away.get("abbr") or ""
            if hn and an:
                c["match"] = {
                    "home_team": hn,
                    "away_team": an,
                    "home_score": home.get("score", home.get("goals", "?")),
                    "away_score": away.get("score", away.get("goals", "?")),
                    "time": str(obj.get("time") or obj.get("minute") or obj.get("matchTime") or ""),
                    "status": str(obj.get("status") or obj.get("state") or "LIVE"),
                }

    # ── Post detection ───────────────────────────────────────────
    if any(k in t for k in ("POST", "UPDATE", "ITEM", "ARTICLE", "ENTRY", "LIVEBLOG")):
        text = deep_text(obj)
        if len(text.strip()) > 30:
            ts = (
                obj.get("publishedAt") or obj.get("timestamp") or
                obj.get("time") or obj.get("updated") or ""
            )
            label = obj.get("label") or obj.get("minute") or obj.get("matchTime") or ""
            is_key = bool(
                obj.get("isKeyEvent") or obj.get("isKeyMoment") or
                obj.get("isPinned") or obj.get("pinned") or obj.get("important")
            )
            c["commentary"].append({
                "time": fmt_time(ts) or str(label),
                "text": to_sentences(text, 4),
                "is_key": is_key,
            })
            return  # don't recurse into already-processed posts

    for v in obj.values():
        walk(v, c, depth + 1)


def deep_text(obj, depth=0):
    if depth > 10:
        return ""
    if isinstance(obj, str):
        return re.sub(r"<[^>]+>", " ", obj)
    if isinstance(obj, list):
        return " ".join(deep_text(x, depth + 1) for x in obj if x)
    if isinstance(obj, dict):
        for key in ("text", "value", "body", "content", "description", "summary", "paragraph", "html"):
            v = obj.get(key)
            if v:
                result = deep_text(v, depth + 1).strip()
                if result:
                    return result
        return " ".join(
            deep_text(v, depth + 1) for v in obj.values()
            if v and not isinstance(v, (bool, int, float))
        )
    return ""


# ── HTML fallback ────────────────────────────────────────────────────────────

def parse_html(soup):
    c = {"match": None, "commentary": []}

    # Try score header
    for testid_pat in [r"match-score", r"fixture", r"score-block"]:
        score_el = soup.find(attrs={"data-testid": re.compile(testid_pat, re.I)})
        if score_el:
            teams = score_el.find_all(class_=re.compile(r"team", re.I))
            nums = score_el.find_all(class_=re.compile(r"number|score|goal", re.I))
            if len(teams) >= 2 and len(nums) >= 2:
                c["match"] = {
                    "home_team": teams[0].get_text(strip=True),
                    "away_team": teams[1].get_text(strip=True),
                    "home_score": nums[0].get_text(strip=True),
                    "away_score": nums[1].get_text(strip=True),
                    "time": "", "status": "LIVE",
                }
                break

    # Find posts — try several selectors in order of specificity
    posts = []
    for selector in [
        lambda s: s.find_all(attrs={"data-testid": re.compile(r"live[-_]?post|stream[-_]?post", re.I)}),
        lambda s: s.find_all(attrs={"data-component": re.compile(r"lx-stream|live|sport-post", re.I)}),
        lambda s: s.find_all(class_=re.compile(r"lx-stream__post|stream-post|live-post", re.I)),
        lambda s: s.find_all("article"),
    ]:
        posts = selector(soup)
        if posts:
            break

    for post in posts[:30]:
        time_el = (
            post.find("time") or
            post.find(attrs={"data-testid": re.compile(r"time|stamp", re.I)}) or
            post.find(class_=re.compile(r"timestamp|time-stamp", re.I))
        )
        ts = ""
        if time_el:
            ts = time_el.get("datetime", "") or time_el.get_text(strip=True)

        paras = post.find_all(["p", "h2", "h3", "li"])
        raw = " ".join(el.get_text(" ", strip=True) for el in paras)
        text = re.sub(r"\s+", " ", raw).strip()

        if len(text) < 20:
            continue

        c["commentary"].append({
            "time": fmt_time(ts),
            "text": to_sentences(text, 4),
            "is_key": False,
        })

    return c


# ── Routes ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/football")
def football():
    try:
        resp = requests.get(BBC_URL, headers=HEADERS, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as e:
        return jsonify({"error": str(e), "match": None, "commentary": []}), 502

    soup = BeautifulSoup(resp.text, "html.parser")
    c = {"match": None, "commentary": []}

    # 1. __NEXT_DATA__ (primary)
    script = soup.find("script", id="__NEXT_DATA__")
    if script and script.string:
        try:
            walk(json.loads(script.string), c)
        except json.JSONDecodeError:
            pass

    # 2. Other embedded JSON blobs
    if not c["commentary"]:
        for s in soup.find_all("script", type="application/json"):
            try:
                walk(json.loads(s.string or "{}"), c)
                if c["commentary"]:
                    break
            except json.JSONDecodeError:
                pass

    # 3. HTML fallback
    if not c["commentary"]:
        c = parse_html(soup)

    title_el = soup.find("title")
    c["page_title"] = title_el.get_text(strip=True) if title_el else "Live Football"
    c["source_url"] = BBC_URL
    return jsonify(c)


if __name__ == "__main__":
    app.run(debug=True)
