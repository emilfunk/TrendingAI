"""Match quotes from podcast-themes.json + security-events.json against
on-disk VTT captions to recover real timestamps.
"""
import json, re, bisect
from pathlib import Path

CAPTIONS_DIR = Path("data/captions")
STOP = set("the of and to a in is it for on with by that this from as at are was were be have has had not but or an its their our your you i we they all also can if into one out over so some such them then there these those will would just very most more much only than what when where which who how about while many upon what's why he she his her him hers itself within without other another after before through during because between against under above below upon".split())

def parse_vtt(path: Path):
    text = path.read_text(errors="replace")
    segs = []
    pat = re.compile(r"(\d+):(\d+):(\d+)\.(\d+)\s*-->\s*[^\n]+\n((?:[^\n]+\n?)*?)(?=\n\d+:|\Z)", re.MULTILINE)
    for m in pat.finditer(text):
        h, mi, s, _ = map(int, m.groups()[:4])
        secs = h*3600 + mi*60 + s
        clean = re.sub(r"<[^>]+>", "", m.group(5))
        clean = re.sub(r"\s+", " ", clean).strip()
        if clean:
            segs.append((secs, clean))
    out, prev = [], None
    for ts, txt in segs:
        if txt != prev:
            out.append((ts, txt)); prev = txt
    return out

def build_index(segs):
    """Return (full_text_lower, sorted [(char_offset, secs)] for bisect)."""
    parts, offsets, off = [], [], 0
    for ts, txt in segs:
        offsets.append((off, ts))
        t = txt.lower()
        parts.append(t)
        off += len(t) + 1
        parts.append(" ")
    full = "".join(parts)
    char_offs = [o for o, _ in offsets]
    secs_list = [s for _, s in offsets]
    return full, char_offs, secs_list

def ts_at(char_pos, char_offs, secs_list):
    i = bisect.bisect_right(char_offs, char_pos) - 1
    return secs_list[max(0, i)]

def distinctive_tokens(quote, min_len=5, max_n=10):
    q = re.sub(r"[^a-zA-Z0-9 ]", " ", quote.lower())
    toks = [t for t in q.split() if len(t) >= min_len and t not in STOP]
    seen, out = set(), []
    for t in toks:
        if t not in seen: seen.add(t); out.append(t)
        if len(out) >= max_n: break
    return out

def find_timestamp(segs, quote):
    tokens = distinctive_tokens(quote)
    if len(tokens) < 2:
        return None, 0, "few_tokens"
    full, char_offs, secs_list = build_index(segs)
    positions = {}
    for tok in tokens:
        ps = []
        for m in re.finditer(r"\b" + re.escape(tok) + r"\b", full):
            cp = m.start()
            ps.append((cp, ts_at(cp, char_offs, secs_list)))
        if ps: positions[tok] = ps
    if len(positions) < 2:
        return None, 0, "no_tokens_found"
    # For each occurrence of each token, count distinct other tokens within ±400 chars
    best_ts, best_score = None, 0
    for tok, ps in positions.items():
        for cp, ts in ps:
            uniq_others = 0
            for other, ops in positions.items():
                if other == tok: continue
                for ocp, _ in ops:
                    if abs(ocp - cp) <= 400:
                        uniq_others += 1; break
            score = uniq_others + 1
            if score > best_score:
                best_score, best_ts = score, ts
    if best_ts is None or best_score < 2:
        return None, best_score, "no_cluster"
    return max(0, best_ts - 5), best_score, "matched"

def vid_from_url(url):
    m = re.search(r"(?:v=|/shorts/|youtu\.be/)([A-Za-z0-9_-]{11})", url or "")
    return m.group(1) if m else None

# Process podcast-themes
themes = json.load(open("data/podcast-themes.json"))
pm, pt = 0, 0
miss_pod = []
for t in themes["themes"]:
    for ep in (t.get("episodes") or []):
        pt += 1
        vid = ep.get("video_id") or vid_from_url(ep.get("url"))
        if not vid:
            miss_pod.append(("no_vid", t.get("theme","?")[:60])); continue
        cap = CAPTIONS_DIR / f"{vid}.en.vtt"
        if not cap.exists():
            miss_pod.append(("no_cap", vid, t.get("theme","?")[:50])); continue
        segs = parse_vtt(cap)
        ts, score, status = find_timestamp(segs, ep.get("angle") or "")
        if ts is not None:
            ep["timestamp_seconds"] = ts
            ep["timestamp_match_score"] = score
            pm += 1
        else:
            miss_pod.append((status, vid, ep.get("angle","")[:60]))
json.dump(themes, open("data/podcast-themes.json","w"), indent=2)
print(f"podcast episodes matched: {pm}/{pt}")
for r in miss_pod[:10]: print("  miss:", r)

# Process security
sec = json.load(open("data/security-events.json"))
sm, st = 0, 0
miss_sec = []
for ev in sec.get("events", []):
    for ex in ev.get("excerpts", []) or []:
        st += 1
        vid = vid_from_url(ex.get("url"))
        if not vid:
            miss_sec.append(("no_vid", ev.get("headline","?")[:60])); continue
        cap = CAPTIONS_DIR / f"{vid}.en.vtt"
        if not cap.exists():
            miss_sec.append(("no_cap", vid)); continue
        segs = parse_vtt(cap)
        ts, score, status = find_timestamp(segs, ex.get("quote") or "")
        if ts is not None:
            ex["timestamp_seconds"] = ts
            ex["timestamp_match_score"] = score
            ex["is_mock_timestamp"] = False
            sm += 1
        else:
            miss_sec.append((status, vid))
json.dump(sec, open("data/security-events.json","w"), indent=2)
print(f"security excerpts matched: {sm}/{st}")
for r in miss_sec[:10]: print("  miss:", r)
