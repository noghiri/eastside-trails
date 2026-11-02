"""Fetch pilot trail geometry and nearby features from Overpass; write cache/osm_pilot.json."""
import json
import pathlib

import net

TRAILS = [
    "Preston-Snoqualmie Trail",
    "Snoqualmie Valley Trail",
    "Cedar River Trail",
    "East Lake Sammamish Trail",
]
BBOX = "47.2,-122.4,47.8,-121.6"

QUERY = f"""[out:json][timeout:180];
way["name"~"^({'|'.join(TRAILS)})$"]["highway"]({BBOX})->.t;
.t out geom tags;
node(w.t)["highway"="crossing"];
out;
"""


def feature_query(elements, pad=0.004):
    """Build an amenity query over each trail's bounding box; distance filtering happens locally."""
    boxes = {}
    for e in elements:
        if e["type"] != "way":
            continue
        b = e["bounds"]
        n = e["tags"]["name"]
        s, w, nn, ee = boxes.get(n, (90, 180, -90, -180))
        boxes[n] = (min(s, b["minlat"]), min(w, b["minlon"]), max(nn, b["maxlat"]), max(ee, b["maxlon"]))
    parts = []
    for s, w, n, e in boxes.values():
        bb = f"{s - pad},{w - pad},{n + pad},{e + pad}"
        parts += [
            f'nwr["amenity"~"^(toilets|drinking_water|parking)$"]({bb});',
            f'nwr["tourism"="viewpoint"]({bb});',
            f'nwr["highway"="trailhead"]({bb});',
        ]
    return "[out:json][timeout:120];\n(\n" + "\n".join(parts) + "\n);\nout center tags;"


def main():
    cache = pathlib.Path(__file__).resolve().parent.parent / "cache"
    trails = net.overpass(QUERY)
    (cache / "osm_pilot.json").write_text(json.dumps(trails))
    features = net.overpass(feature_query(trails["elements"]))
    (cache / "osm_features.json").write_text(json.dumps(features))
    print(len(trails["elements"]), "trail elements,", len(features["elements"]), "features")


if __name__ == "__main__":
    main()


def gap_query(boxes):
    """All highway ways (incl. construction) inside small boxes around trail gaps."""
    parts = [f'way["highway"]({s},{w},{n},{e});' for s, w, n, e in boxes]
    return "[out:json][timeout:120];\n(\n" + "\n".join(parts) + "\n);\nout geom tags;"


def road_query(names, bbox):
    """Named roads used to locate street-defined access points."""
    rx = "|".join(n.replace("(", r"\(").replace(")", r"\)") for n in sorted(names))
    return f'[out:json][timeout:90];\nway["highway"]["name"~"^({rx})$"]({bbox});\nout geom tags;'
