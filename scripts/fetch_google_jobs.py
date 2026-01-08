# scripts/fetch_google_jobs.py
import json
import re
import sys
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

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

DATA_DIR = Path("data")
DATA_DIR.mkdir(parents=True, exist_ok=True)

def localname(tag: str) -> str:
    # "{namespace}tag" -> "tag"
    if not tag:
        return ""
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag

def fetch_url(url: str) -> tuple[str, dict]:
    """
    Returns (text, meta)
    meta includes: status_code, content_type, final_url
    """
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; LanguageNeedsRadar/1.0)",
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
            "Accept-Language": "en-US,en;q=0.9",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            ct = r.headers.get("Content-Type", "")
            final_url = r.geturl()
            status_code = getattr(r, "status", 200)
            text = raw.decode("utf-8", errors="replace")
            return text, {"status_code": status_code, "content_type": ct, "final_url": final_url}
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return body, {
            "status_code": e.code,
            "content_type": e.headers.get("Content-Type", "") if e.headers else "",
            "final_url": getattr(e, "url", url),
            "error": f"HTTPError {e.code}",
        }
    except Exception as e:
        return "", {"status_code": None, "content_type": "", "final_url": url, "error": repr(e)}

def strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = re.sub(r"\s+", " ", s).strip()
    return s

def match_any(patterns, text: str) -> bool:
    for p in patterns:
        if re.search(p, text, flags=re.IGNORECASE):
            return True
    return False

def detect_and_extract_items(root: ET.Element):
    """
    Returns (feed_type, items)
    items is a list of Elements representing entries/items
    """
    root_ln = localname(root.tag).lower()

    # RSS
    if root_ln == "rss":
        items = root.findall(".//item")
        return ("rss", items)

    # Atom
    if root_ln == "feed":
        # atom:entry could be namespaced
        items = [el for el in root.iter() if localname(el.tag).lower() == "entry"]
        return ("atom", items)

    # HTML or unexpected XML
    if root_ln == "html":
        return ("html", [])

    # generic: try to find item/entry anywhere
    candidates = []
    for el in root.iter():
        ln = localname(el.tag).lower()
        if ln in ("item", "entry"):
            candidates.append(el)

    if candidates:
        # if mixed, just call it generic_xml
        return ("generic_xml", candidates)

    return ("none", [])

def get_text_child(el: ET.Element, name: str) -> str:
    """
    Finds first child by localname match (namespace-agnostic), returns .text or "".
    """
    name = name.lower()
    for c in list(el):
        if localname(c.tag).lower() == name:
            return (c.text or "").strip()
    return ""

def get_link_from_atom_entry(entry: ET.Element) -> str:
    # Atom: <link href="..."/>
    for c in entry.iter():
        if localname(c.tag).lower() == "link":
            href = c.attrib.get("href", "").strip()
            if href:
                return href
            # sometimes <link>text</link>
            if c.text and c.text.strip():
                return c.text.strip()
    return ""

def build_job_obj_from_item(el: ET.Element, feed_type: str):
    if feed_type in ("rss", "generic_xml"):
        title = get_text_child(el, "title")
        link = get_text_child(el, "link")
        desc_raw = get_text_child(el, "description")
        pub = get_text_child(el, "pubDate") or get_text_child(el, "published") or get_text_child(el, "updated")
    else:
        # atom
        title = get_text_child(el, "title")
        link = get_link_from_atom_entry(el)
        # atom uses <summary> or <content>
        desc_raw = get_text_child(el, "summary") or get_text_child(el, "content")
        pub = get_text_child(el, "updated") or get_text_child(el, "published")

    desc = strip_html(desc_raw)
    blob = f"{title} {desc}".lower()

    langs_hit = [k for k, pats in LANGS.items() if match_any(pats, blob)]
    types_hit = [k for k, pats in DATA_TYPES.items() if match_any(pats, blob)]

    return {
        "title": title,
        "link": link,
        "pubDate": pub,
        "langs_hit": langs_hit,
        "types_hit": types_hit,
    }

def main():
    xml_text, meta = fetch_url(FEED_URL)

    # Save raw response for debugging (always)
    debug_path = DATA_DIR / "google_feed_debug.txt"
    with open(debug_path, "w", encoding="utf-8") as f:
        f.write(f"URL: {FEED_URL}\n")
        f.write(f"Final URL: {meta.get('final_url')}\n")
        f.write(f"Status: {meta.get('status_code')}\n")
        f.write(f"Content-Type: {meta.get('content_type')}\n")
        if meta.get("error"):
            f.write(f"Error: {meta.get('error')}\n")
        f.write("\n---- BODY (first 20000 chars) ----\n")
        f.write((xml_text or "")[:20000])

    generated_at = datetime.now(timezone.utc).isoformat()

    # Try parse as XML
    try:
        root = ET.fromstring(xml_text)
    except Exception as e:
        out = {
            "source": FEED_URL,
            "generated_at_utc": generated_at,
            "fetch_meta": meta,
            "feed_type_detected": "parse_error",
            "parse_error": repr(e),
            "total_jobs_in_feed": 0,
            "language_counts": sorted({k: 0 for k in LANGS.keys()}.items(), key=lambda x: x[1], reverse=True),
            "data_type_counts": sorted({k: 0 for k in DATA_TYPES.keys()}.items(), key=lambda x: x[1], reverse=True),
            "language_x_data_type": {k: {t: 0 for t in DATA_TYPES.keys()} for k in LANGS.keys()},
            "jobs_sample": [],
            "debug_file": str(debug_path),
        }
        with open(DATA_DIR / "google_jobs_summary.json", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        # Fail fast so you notice in Actions
        print("ERROR: feed.xml is not valid XML. See data/google_feed_debug.txt")
        sys.exit(1)

    feed_type, items = detect_and_extract_items(root)

    # If HTML/none → that means “this is not a job feed anymore (or blocked/redirected)”
    if feed_type in ("html", "none"):
        out = {
            "source": FEED_URL,
            "generated_at_utc": generated_at,
            "fetch_meta": meta,
            "feed_type_detected": feed_type,
            "root_tag": localname(root.tag),
            "total_jobs_in_feed": 0,
            "language_counts": sorted({k: 0 for k in LANGS.keys()}.items(), key=lambda x: x[1], reverse=True),
            "data_type_counts": sorted({k: 0 for k in DATA_TYPES.keys()}.items(), key=lambda x: x[1], reverse=True),
            "language_x_data_type": {k: {t: 0 for t in DATA_TYPES.keys()} for k in LANGS.keys()},
            "jobs_sample": [],
            "debug_file": str(debug_path),
            "note": "feed.xml에서 RSS/Atom item/entry가 발견되지 않았습니다. 응답이 HTML(리다이렉트/봇차단/페이지)일 가능성이 큽니다.",
        }
        with open(DATA_DIR / "google_jobs_summary.json", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        with open(DATA_DIR / "google_jobs_raw.json", "w", encoding="utf-8") as f:
            json.dump({"source": FEED_URL, "generated_at_utc": generated_at, "jobs": []}, f, ensure_ascii=False, indent=2)

        print("WARN: No RSS/Atom items detected. Likely HTML/blocked/deprecated feed. See data/google_feed_debug.txt")
        # Actions는 성공 처리로 두고 싶으면 exit(0), 실패로 띄우고 싶으면 exit(1)
        # 일단 너가 빨리 알아차리게 실패로 처리해줄게.
        sys.exit(1)

    jobs = [build_job_obj_from_item(it, feed_type) for it in items]

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
        "generated_at_utc": generated_at,
        "fetch_meta": meta,
        "feed_type_detected": feed_type,
        "total_jobs_in_feed": len(jobs),
        "language_counts": lang_sorted,
        "data_type_counts": type_sorted,
        "language_x_data_type": cross,
        "jobs_sample": jobs[:200],
        "debug_file": str(debug_path),
    }

    with open(DATA_DIR / "google_jobs_summary.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    with open(DATA_DIR / "google_jobs_raw.json", "w", encoding="utf-8") as f:
        json.dump(
            {"source": FEED_URL, "generated_at_utc": generated_at, "feed_type_detected": feed_type, "jobs": jobs},
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"OK: {len(jobs)} items (type={feed_type}) -> data/google_jobs_summary.json, data/google_jobs_raw.json")

if __name__ == "__main__":
    main()
