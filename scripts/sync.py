"""Sync data/axies.json and data/cards.json with the wallet's Axies.

Run by .github/workflows/sync.yml. Prices live in data/prices.json and are never touched here.
Exits without writing anything if the Axie API fails, so a bad response can't wipe the shop.
"""
import io
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

from PIL import Image

WALLET = "0xe8a963a82a739e18319b89ac5d85971b0808a108"
API = "https://graphql-gateway.axieinfinity.com/graphql"
# sort is required: without it the API's paging order shifts between pages,
# so some Axies come back twice and others are skipped
QUERY = """{ axies(owner:"%s", from:%d, size:100, sort: IdAsc){ total results{ id name class breedCount bodyShape
  stats{hp speed skill morale}
  parts{ name class type stage abilities{ id name attack defense energy description backgroundUrl } } } } }"""


def curl(url, data=None):
    # curl, not urllib: the API's bot filter rejects Python's HTTP client
    cmd = ["curl", "-sS", "--fail", "-m", "60", url]
    if data is not None:
        cmd += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
    return subprocess.run(cmd, input=data, capture_output=True, check=True).stdout


def fetch_axies():
    out, start = [], 0
    while True:
        body = json.dumps({"query": QUERY % (WALLET, start)}).encode()
        page = json.loads(curl(API, body))["data"]["axies"]
        out += page["results"]
        start += 100
        if start >= page["total"]:
            return out


def thumb(url, path, size):
    # a missing image must not stop the sync; the site falls back to the CDN
    try:
        im = Image.open(io.BytesIO(curl(url)))
    except Exception as e:  # noqa: BLE001
        print("No image yet:", url, e)
        return
    im.thumbnail((size, size))
    im.save(path, optimize=True)


def main():
    try:
        raw = fetch_axies()
    except Exception as e:  # noqa: BLE001
        print("Axie API failed, nothing changed:", e)
        return 1
    if not raw:
        print("API returned 0 Axies, refusing to wipe the shop.")
        return 1

    with open("data/cards.json") as f:
        cards = json.load(f)
    axies, seen = [], set()
    for a in raw:
        # skip repeats and unhatched eggs (no class or parts yet); eggs show up once they hatch
        if a["id"] in seen or not a["class"] or not a["parts"]:
            continue
        seen.add(a["id"])
        parts = []
        for p in a["parts"]:
            ab = p["abilities"][0] if p["abilities"] else None
            if ab and ab["id"] not in cards:
                name = os.path.basename(ab["backgroundUrl"])
                thumb(ab["backgroundUrl"], f"cards/{name}", 200)
                cards[ab["id"]] = {"n": ab["name"], "a": ab["attack"], "d": ab["defense"],
                                   "e": ab["energy"], "t": ab["description"], "img": f"cards/{name}"}
            parts.append([p["type"], p["name"], p["class"], p["stage"], ab["id"] if ab else None])
        axies.append({"id": a["id"], "name": (a["name"] or "").strip() or f"Axie #{a['id']}",
                      "cls": a["class"], "breeds": a["breedCount"], "shape": a["bodyShape"],
                      "stats": a["stats"], "parts": parts})
        if not os.path.exists(f"img/{a['id']}.png"):
            thumb(f"https://axiecdn.axieinfinity.com/axies/{a['id']}/axie/axie-full-transparent.png",
                  f"img/{a['id']}.png", 280)

    with open("data/axies.json") as f:
        old = json.load(f)
    old_ids, new_ids = {a["id"] for a in old}, {a["id"] for a in axies}
    print("added:", sorted(new_ids - old_ids) or "none", "| removed:", sorted(old_ids - new_ids) or "none")

    with open("data/axies.json", "w") as f:
        json.dump(axies, f, ensure_ascii=False, separators=(",", ":"))
    with open("data/cards.json", "w") as f:
        json.dump(cards, f, ensure_ascii=False, separators=(",", ":"))
    with open("data/meta.json", "w") as f:
        json.dump({"syncedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "count": len(axies)}, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
