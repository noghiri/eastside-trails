"""Per-edge rules derived from OSM tags: access by mode, direction, surface, flags.

Access values: "yes", "no", "dismount", or "unknown" (no tag and no safe default).
Each access result carries `assumed=True` when it comes from a highway-type default rather
than an explicit tag, so the site can say so.
"""

ROADS = {"primary", "secondary", "tertiary", "unclassified", "residential", "service", "living_street",
         "primary_link", "secondary_link", "tertiary_link", "trunk", "trunk_link"}
PAVED = {"asphalt", "concrete", "paved", "paving_stones", "concrete:plates", "concrete:lanes", "wood", "metal",
         "chipseal", "sett"}
GROOMED = {"compacted", "fine_gravel"}
YES = {"yes", "designated", "permissive", "destination", "official"}

# defaults when no bicycle/foot tag says otherwise (OSM US conventions; footway is left
# unknown on purpose because bike legality on untagged footways varies by managing agency)
BIKE_DEFAULT = {"cycleway": "yes", "path": "yes", "track": "yes", "bridleway": "unknown",
                "footway": "unknown", "pedestrian": "unknown", "steps": "dismount"}
FOOT_DEFAULT = {"cycleway": "yes", "path": "yes", "track": "yes", "bridleway": "yes",
                "footway": "yes", "pedestrian": "yes", "steps": "yes"}

# per-sample flag bits, shared with the site
CLOSED, ROAD, DISMOUNT, BRIDGE = 1, 2, 4, 8
SURFACES = ["paved", "groomed", "rough", "unknown"]


def _access(t, key, defaults):
    h = t.get("highway")
    if h == "construction":
        return "no", False
    v = t.get(key)
    if v:
        if v in YES:
            return "yes", False
        if v == "dismount":
            return "dismount", False
        return "no", False
    if t.get("access") in ("no", "private"):
        return "no", False
    if h in ROADS:
        return ("unknown", True) if h in ("trunk", "trunk_link") else ("yes", True)
    return defaults.get(h, "unknown"), True


def bike(t):
    return _access(t, "bicycle", BIKE_DEFAULT)


def foot(t):
    return _access(t, "foot", FOOT_DEFAULT)


def bike_oneway(t):
    """1 = only along way direction, -1 = only against, 0 = both."""
    v = t.get("oneway:bicycle") or t.get("oneway")
    return {"yes": 1, "1": 1, "true": 1, "-1": -1}.get(v, 0)


VAGUE = {"unpaved"}  # says only "not paved": could be packed gravel or dirt


def surface(t):
    s = t.get("surface")
    if s in VAGUE:
        return "unknown"
    if s in PAVED:
        return "paved"
    if s in GROOMED:
        return "groomed"
    if s:
        return "rough"
    if t.get("highway") in ROADS and t.get("highway") != "service":
        return "paved"
    if t.get("tracktype") in ("grade1", "grade2"):
        return "groomed"
    if t.get("tracktype"):
        return "rough"
    return "unknown"


def flags(t):
    f = 0
    # closed = construction or an explicit "no"; private land is merely unusable, not a closure
    private = "private" in (t.get("access"), t.get("bicycle"), t.get("foot"))
    if t.get("highway") == "construction" or (bike(t)[0] == "no" and foot(t)[0] == "no" and not private):
        f |= CLOSED
    if t.get("highway") in ROADS and t.get("service") != "parking_aisle":
        f |= ROAD
    if bike(t)[0] == "dismount" or t.get("highway") == "steps":
        f |= DISMOUNT
    if t.get("bridge", "no") != "no" or t.get("tunnel", "no") != "no":
        f |= BRIDGE
    return f


def precise_elevation(t, curated_names=()):
    """Edges that get 1 m elevation: everything easy-bike mode might use, including sections
    that are closed or walk-only today (closures reopen; steep walk-ups need accurate grades),
    plus every edge of a hand-checked trail."""
    h = t.get("highway")
    if t.get("name") in curated_names:
        return True
    if h == "construction":
        return t.get("construction") in ("cycleway", "path", "footway") or t.get("surface") in PAVED | GROOMED
    return h == "cycleway" or t.get("surface") in PAVED | GROOMED
