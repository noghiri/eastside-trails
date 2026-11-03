# Eastside Trails

Filterable map of bike-friendly trails (paved or groomed gravel) within 30 miles of
Newcastle, WA, aimed at finding easy rides for a new rider on a class 1/2 e-bike.

Site: https://noghiri.github.io/eastside-trails/

- Ride generator: pick round trip or one-way, a max grade tier (≤2/≤4/≤6%), and a length
  range. Rides start at a parking point and stop before closures, grade limits, or
  sections you choose to avoid.
- Elevation profile colored by grade (100 m windows), climb out and back, GPX download.
- Parking points with addresses (lat/lon fallback), Discover Pass flags, and sources.

Status: pilot with 4 trails (Preston-Snoqualmie, Snoqualmie Valley, Cedar River,
East Lake Sammamish).

## Sources and how they're used

| Source | Used for | Terms |
|---|---|---|
| Trail authorities (King County Parks, cities, SPU, WA State Parks) | Trailheads, addresses, closures, surface, rules | Cited per item in `data/curated.json` |
| OpenStreetMap via Overpass | Trail geometry, surface tags, crossings, toilets/water/viewpoints, lot locations | ODbL; sequential cached queries per the [Overpass usage policy](https://wiki.openstreetmap.org/wiki/Overpass_API) |
| Nominatim | Geocoding a handful of authority-published addresses | [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/): ≤1 req/s, cached |
| USGS 3DEP | Elevation (1 m lidar where available) | Public domain |
| WTA | Link only | WTA's terms limit content to internal informational use, so nothing is copied |

Where OSM has no surface tag, the build uses the authority's stated surface for the whole
trail (`untagged_surface` in `data/curated.json`) only when the authority describes the whole
trail that way.

## Building the data

Pilot pipeline (current site, `docs/data`):

```
cd pipeline
python fetch_osm.py      # trail geometry + nearby features via Overpass (cached in cache/)
python build.py          # elevation, gap handling, access points -> docs/data, docs/gpx
```

Network pipeline (in progress, `docs/net`): routable path network for loops, one-way trails
and other modes. Needs `pip install osmium rasterio`.

```
cd pipeline
# Geofabrik Washington extract -> cache/geofabrik/washington-latest.osm.pbf
python network.py        # all highways in the region, split at junctions
python network.py pois   # toilets, water, viewpoints, trailheads, parking
python prune.py          # paths + short road connectors + joins across tiny unmapped gaps
python elevate.py split  # per-area batches
python elevate.py run    # resumable; 1 m lidar for bike-relevant edges, 10 m elsewhere
python elevate.py merge  # bridge handling (levelled approaches, chained spans)
python validate.py       # compare against the pilot trails
python tiles.py          # docs/net/index.json + 0.1-degree tiles
```

Elevation blocks are read from USGS 3DEP cloud-optimized GeoTIFFs and cached under
`cache/dem/`; a rebuild never refetches a block.

## Known limitations

- Elevation models show the ground under bridges. Bridges tagged in OSM are interpolated;
  untagged bridges and culvert fills can show up as false V-shaped dips.
- OSM parking near trails is too noisy to use directly; parking points come from the
  curated list, with OSM used only to locate the lot.
- Closures change. Always check the authority's page before a ride.
