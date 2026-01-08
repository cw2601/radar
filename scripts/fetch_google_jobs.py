# scripts/fetch_google_jobs.py
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

FEED_URL = "https://www.google.com/about/careers/applications/jobs/feed.xml"

# Top20 언어 (English 제외: 노이즈 너무 큼)
LANGS = {
    "Chinese/Mandarin": [r"\bchinese\b", r"\bmandarin\b"],
    "Hindi": [r"\bhindi\b"],
    "Spanish": [r"\bspanish\b"],
    "French": [r"\bfrench\b"],
    "Arabic": [r"\barabic\b", r"\bmodern standard arabic\b", r"\bmsa\b"],
    "Bengali": [r"\bbengali\b", r"\bbangla\b"],
    "Portuguese": [r"\bportuguese\b"],
    "Russian": [r"\brussian\b"],
    "Urdu": [r"\burdu\b"],
    "Indonesian": [r"\bindonesian\b", r"\bbahasa indonesia\b"],
    "German": [r"\bgerman\b"],
    "Japanese": [r"\bjapanese\b"],
    "Korean": [r"\bkorean\b"],
    "Swahili": [r"\bswahili\b"],
    "Marathi": [r"\bmarathi\b"],
    "Telugu": [r"\btelugu\b"],
    "Turkish": [r"\bturkish\b"],
    "Tamil": [r"\btamil\b"],
    "Vietnamese": [r"\bvietnamese\b"],
}

DATA_TYPES = {
    "Speech/ASR/TTS": [
        r"\bspeech\b", r"\basr\b", r"\btts\b", r"\bvoice\b",
        r"\baccent\b", r"\bdialect\b", r"\btranscription\b",
        r"\bspeech data\b",
    ],
    "Text/Localization/Translation": [
        r"\blinguist\b", r"\blocali[sz]ation\b", r"\bi18n\b",
        r"\btranslation\b", r"\btranslator\b", r"\bterminology\b",
        r"\bmultilingual\b", r"\bcross[- ]lingual\b",
    ],
    "RLHF/Safety/Raters": [
        r"\brlhf\b", r"\bpreference\b", r"\bhuman feedback\b",
        r"\brater\b", r"\bred teaming\b", r"\bsafety\b", r"\bpolicy\b",
    ],
}

def fetch_text(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/xml,text/xml,*/*;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")

def strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = re.sub(r"\s+", " ", s).strip()
    return s

def match_any(patterns, text: str) -> bool:
    for p in patterns:
        if re.search(p, text, flags=re.IGNORECASE):
            return True
    return False

def localname(tag: str) -> str:
    # "{namespace}tag" -> "tag"
    return tag.split("}", 1)[-1] if "}" in tag else tag

def find_first_text(el: ET.Element, wanted_local_names):
    # wanted_local_names: ["title", "description", ...]
    wanted = set(wanted_local_names)
    for child in el.iter():
        if localname(child.tag) in wanted and (child.text and child.text.strip()):
            return child.text.strip()
    return ""

def find_link(el: ET.Element) -> str:
    # RSS: <link>https://...</link>
    # Atom: <link href="https://..." rel="alternate" />
    # Some feeds: multiple link tags
    # 1) try href attribute
    for child in el.iter():
        if localname(child.tag) == "link":
            href = (child.attrib.get("href") or "").strip()
            if href:
                return href
    # 2) fallback to text content
    for child in el.iter():
        if localname(child.tag) == "link" and child.text and child.text.strip():
            return child.text.strip()
    return ""

def find_published(el: ET.Element) -> str:
    # RSS: pubDate
    # Atom: published/updated
    txt = find_first_text(el, ["pubDate", "published", "updated"])
    return txt

def get_items(root: ET.Element):
    # handle namespaces + RSS/Atom
    # Try RSS items
    items = root.findall(".//{*}item")
    if items:
        return items, "rss"
    # Try Atom entries
    entries = root.findall(".//{*}entry")
    if entries:
        return entries, "atom"
    # Last resort: scan for tag endswith item/entry
    found = []
    for el in root.iter():
        ln = localname(el.tag)
        if ln in ("item", "entry"):
            found.append(el)
    if found:
        # guess type based on first localname
        return found, "unknown"
    return [], "none"

def main():
    xml = fetch_text(FEED_URL)
    root = ET.fromstring(xml)

    items, feed_type = get_items(root)

    # Debug info (shows in GitHub Actions logs)
    print("ROOT TAG:", root.tag)
    print("FEED TYPE:", feed_type)
    print("ITEMS FOUND:", len(items))

    jobs = []
    for it in items:
        # common fields across RSS/Atom (with fallbacks)
        title = find_first_text(it, ["title"]) or ""
        link = find_link(it) or ""
        desc_raw = (
            find_first_text(it, ["description", "summary", "content"])
            or ""
        )
        pub = find_published(it) or ""

        desc = strip_html(desc_raw)
        blob = f"{title} {desc}".lower()

        langs_hit = [k for k, pats in LANGS.items() if match_any(pats, blob)]
        types_hit = [k for k, pats in DATA_TYPES.items() if match_any(pats, blob)]

        jobs.append({
            "title": (title or "").strip(),
            "link": (link or "").strip(),
            "pubDate": (pub or "").strip(),
            "langs_hit": langs_hit,
            "types_hit": types_hit,
        })

    # Aggregate
    lang_counts = {k: 0 for k in LANGS.keys()}
    type_counts = {k: 0 for k in DATA_TYPES.keys()}
    cross = {k: {t: 0 for t in DATA_TYPES.keys()} for k in LANGS.keys()}

    for j in jobs:
        for l in j["langs_hit"]:
            lang_counts[l] += 1
            for t in j["types_hit"]:
                cross[l][t] += 1
        for t in j["types_hit"]:
            type_counts[t] += 1

    lang_sorted = sorted(lang_counts.items(), key=lambda x: x[1], reverse=True)
    type_sorted = sorted(type_counts.items(), key=lambda x: x[1], reverse=True)

    out = {
        "source": FEED_URL,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "feed_type_detected": feed_type,
        "total_jobs_in_feed": len(jobs),
        "language_counts": lang_sorted,
        "data_type_counts": type_sorted,
        "language_x_data_type": cross,
        "jobs_sample": jobs[:200],
    }

    # Ensure folder exists (in Actions, folder may not exist)
    import os
    os.makedirs("data", exist_ok=True)

    with open("data/google_jobs_summary.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    with open("data/google_jobs_raw.json", "w", encoding="utf-8") as f:
        json.dump(
            {"source": FEED_URL, "generated_at_utc": out["generated_at_utc"], "jobs": jobs},
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"OK: {len(jobs)} items -> data/google_jobs_summary.json, data/google_jobs_raw.json")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ERROR:", e)
        sys.exit(1)
