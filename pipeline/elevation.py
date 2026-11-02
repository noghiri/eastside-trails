"""Elevation from the USGS 3DEP ImageServer (best available DEM, ~1 m lidar here).

Sequential, batched, cached requests.
"""
import json
import urllib.parse

import net

URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples"
BATCH = 500


def sample(points):
    """Elevations in metres for [(lat, lon), ...]; None where the service has no value."""
    out = []
    for i in range(0, len(points), BATCH):
        chunk = points[i:i + BATCH]
        geom = {"points": [[round(lon, 6), round(lat, 6)] for lat, lon in chunk],
                "spatialReference": {"wkid": 4326}}
        body = urllib.parse.urlencode({
            "geometry": json.dumps(geom, separators=(",", ":")),
            "geometryType": "esriGeometryMultipoint",
            "returnFirstValueOnly": "true",
            "interpolation": "RSP_BilinearInterpolation",
            "f": "json",
        })
        res = json.loads(net.fetch(URL, body))
        if "samples" not in res:
            raise RuntimeError(f"3DEP error: {res}")
        vals = [None] * len(chunk)
        for s in res["samples"]:
            try:
                vals[s["locationId"]] = float(s["value"])
            except ValueError:  # NoData
                pass
        out += vals
    return out
