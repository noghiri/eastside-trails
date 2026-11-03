"""Elevation from USGS 3DEP 1/3 arc-second (~10 m) cloud-optimized GeoTIFFs.

Only the 512x512 blocks that sampled points fall in are downloaded (HTTP range reads via
GDAL), and each block is cached under cache/dem/ so a rebuild never refetches it.
Tiles are NAD83 (EPSG:4269); the ~1 m offset from WGS84 is ignored at this resolution.
"""
import math
import pathlib
from collections import OrderedDict

import numpy as np
import rasterio
from rasterio.windows import Window

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache" / "dem"
URL = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/{t}/USGS_13_{t}.tif"
ENV = {"GDAL_HTTP_USERAGENT": "eastside-trails/0.2 (+https://github.com/noghiri/eastside-trails)",
       "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR"}
BLOCK = 512
MAX_BLOCKS = 256  # in-memory LRU cap (~256 MB); evicted blocks reload from the disk cache


def tile_name(lat, lon):
    return f"n{math.floor(lat) + 1:02d}w{-math.floor(lon):03d}"


class DEM:
    def __init__(self):
        self._open = {}
        self._blocks = OrderedDict()
        self._env = rasterio.Env(**ENV)
        self._env.__enter__()

    def _ds(self, t):
        if t not in self._open:
            self._open[t] = rasterio.open(URL.format(t=t))
        return self._open[t]

    def _cache_path(self, t, br, bc):
        return CACHE / t / f"{br}_{bc}.npy"

    def _block(self, t, br, bc):
        key = (t, br, bc)
        if key in self._blocks:
            self._blocks.move_to_end(key)
        else:
            path = self._cache_path(t, br, bc)
            if path.exists():
                arr = np.load(path)
            else:
                ds = self._ds(t)
                arr = ds.read(1, window=Window(bc * BLOCK, br * BLOCK, BLOCK, BLOCK), boundless=True,
                              fill_value=ds.nodata if ds.nodata is not None else np.nan).astype(np.float32)
                if ds.nodata is not None:
                    arr[arr == ds.nodata] = np.nan
                path.parent.mkdir(parents=True, exist_ok=True)
                np.save(path, arr)
            self._blocks[key] = arr
            if len(self._blocks) > MAX_BLOCKS:
                self._blocks.popitem(last=False)
        return self._blocks[key]

    def _pixel(self, t, row, col):
        br, bc = int(row) // BLOCK, int(col) // BLOCK
        return self._block(t, br, bc)[int(row) - br * BLOCK, int(col) - bc * BLOCK]

    def sample(self, lat, lon):
        """Bilinear elevation in metres, or nan."""
        t = tile_name(lat, lon)
        ds = self._ds(t)
        col, row = ~ds.transform * (lon, lat)
        col, row = col - 0.5, row - 0.5  # pixel centres
        c0, r0 = math.floor(col), math.floor(row)
        fc, fr = col - c0, row - r0
        v = [[self._pixel(t, r0 + i, c0 + j) for j in (0, 1)] for i in (0, 1)]
        return float((v[0][0] * (1 - fc) + v[0][1] * fc) * (1 - fr) + (v[1][0] * (1 - fc) + v[1][1] * fc) * fr)

    def close(self):
        for ds in self._open.values():
            ds.close()
        self._env.__exit__(None, None, None)


class DEM1m(DEM):
    """USGS 3DEP 1 m lidar DEMs: 10 km UTM tiles published per lidar project.

    Where projects overlap, the most recently published tile wins. Points with no 1 m
    coverage return nan so callers can fall back to the 10 m DEM.
    """

    TNM = "https://tnmaccess.nationalmap.gov/api/v1/products"

    def __init__(self, bbox):
        super().__init__()
        self._tiles = self._index(bbox)

    def _index(self, bbox):
        import json
        import urllib.parse

        import net

        s, w, n, e = bbox
        items, offset = [], 0
        while True:
            q = urllib.parse.urlencode({"datasets": "Digital Elevation Model (DEM) 1 meter",
                                        "bbox": f"{w},{s},{e},{n}", "prodFormats": "GeoTIFF",
                                        "max": 500, "offset": offset})
            res = json.loads(net.fetch(f"{self.TNM}?{q}"))
            items += res["items"]
            offset += len(res["items"])
            if not res["items"] or offset >= res["total"]:
                break
        best = {}
        for it in items:
            # title like "USGS 1 Meter 10 x56y527 WA_KingCounty_2021_B21"
            parts = it["title"].split()
            zone, cell = parts[3], parts[4]
            key = (zone, cell)
            if key not in best or it["publicationDate"] > best[key]["publicationDate"]:
                best[key] = it
        return {k: v["downloadURL"] for k, v in best.items()}

    def sample_many(self, pts):
        """Elevations for [(lat, lon)], nan where no 1 m tile covers the point."""
        from rasterio.warp import transform

        out = [math.nan] * len(pts)
        if not pts:
            return out
        by_zone = {}
        for i, (lat, lon) in enumerate(pts):
            by_zone.setdefault(int((lon + 180) // 6) + 1, []).append(i)
        for zone, ids in by_zone.items():
            xs, ys = transform("EPSG:4326", f"EPSG:269{zone:02d}",
                               [pts[i][1] for i in ids], [pts[i][0] for i in ids])
            for i, x, y in zip(ids, xs, ys):
                # tile cells are named by the 10 km grid corner: x = floor(E/10km), y = ceil(N/10km)
                cell = f"x{int(x // 10000)}y{int(-(-y // 10000))}"
                url = self._tiles.get((str(zone), cell))
                if url:
                    out[i] = self._at(url, x, y)
        return out

    def _ds(self, t):
        if t not in self._open:
            self._open[t] = rasterio.open(t)
        return self._open[t]

    def _cache_path(self, t, br, bc):
        return CACHE / "1m" / t.rsplit("/", 1)[1].removesuffix(".tif") / f"{br}_{bc}.npy"

    def _at(self, url, x, y):
        ds = self._ds(url)
        col, row = ~ds.transform * (x, y)
        col, row = col - 0.5, row - 0.5
        c0, r0 = math.floor(col), math.floor(row)
        if not (0 <= c0 < ds.width - 1 and 0 <= r0 < ds.height - 1):
            return math.nan
        fc, fr = col - c0, row - r0
        v = [[self._pixel(url, r0 + i, c0 + j) for j in (0, 1)] for i in (0, 1)]
        return float((v[0][0] * (1 - fc) + v[0][1] * fc) * (1 - fr) + (v[1][0] * (1 - fc) + v[1][1] * fc) * fr)
