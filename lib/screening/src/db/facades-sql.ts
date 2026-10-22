/**
 * H3.2 — façade segments from footprint geometry (PostGIS).
 *
 * For every building of one municipality, every edge of its footprint, with:
 *   - the edge's own azimuth (clockwise from grid north, degrees),
 *   - whether it lies on the outer ring or on a courtyard ring,
 *   - its length, and how much of that length is shared with a neighbouring
 *     building (a party wall, medianera) rather than exposed to the sky.
 *
 * Method, so the reader can check it:
 *   1. Patches of one building are merged by ST_MakeValid: two patches that
 *      share an edge make an invalid MultiPolygon, and making it valid
 *      dissolves the seam, so an internal edge between two patches of the
 *      same building is not a façade. (An ST_UnaryUnion here was removed on
 *      14 Oct 2026: mutation testing showed it changed nothing once
 *      ST_MakeValid had run — the integration test that splits a building
 *      in two is what pins this.)
 *   2. Rings are forced clockwise (ST_ForcePolygonCW): outer rings clockwise,
 *      courtyard rings counter-clockwise. With that orientation the building
 *      is always on the RIGHT of an edge walked from start to end, so the
 *      outward normal is the edge azimuth minus 90° (see orientation.ts).
 *   3. Neighbours are the other buildings within `tolerance` metres of an
 *      edge. The part of the edge inside any neighbour's footprint buffered
 *      by the same tolerance is a party wall; the rest is exposed. (First
 *      written as one merged zone per building; rewritten 14 Oct 2026 per
 *      edge after the merged zone took minutes on Córdoba's largest
 *      footprints. Same set, by distributivity: the edge ∩ ⋃ zones equals
 *      ⋃ (edge ∩ zone). The oracle test pins it.)
 *
 * Parameters: $1 INE municipality code, $2 tolerance in metres, $3 the refs
 * of this batch (the caller pages through a municipality so no single result
 * set holds every edge of 37,850 buildings).
 *
 * The tolerance is a parameter, not a constant buried in the query, because
 * it decides how much façade a dense historic block has. The Catastro states
 * a horizontal accuracy of 0.1 m on these footprints.
 *
 * This is inferred, not sourced (H3.2): no public register publishes which
 * walls of a building are exposed.
 */
export const FACADE_SEGMENTS_SQL = `
WITH target AS (
  SELECT ref, footprint
    FROM h3_buildings
   WHERE ine_municipality = $1
     AND ref = ANY($3::text[])
),
outline AS (
  SELECT ref,
         ST_ForcePolygonCW(
           ST_Multi(ST_CollectionExtract(ST_MakeValid(footprint), 3))
         ) AS g
    FROM target
),
segments AS (
  SELECT o.ref, d.path, d.geom AS s
    FROM outline o
   CROSS JOIN LATERAL ST_DumpSegments(o.g) AS d
   WHERE ST_Length(d.geom) > 0
),
-- Party-wall length per edge: the edge intersected with the union of the
-- buffered footprints of the neighbours near THAT edge. Pairs are found
-- through the GiST index (ST_DWithin), so a 2,667-vertex footprint costs its
-- own edges, not every edge times every neighbour vertex. The polygons are
-- merged before intersecting: merging the per-neighbour line pieces instead
-- left overlapping collinear pieces unmerged and counted 10.43 m of party
-- wall on a 10.23 m edge (caught by the oracle test, 14 Oct 2026).
shared AS (
  SELECT s.ref, s.path,
         ST_Length(ST_Intersection(s.s, ST_Union(ST_Buffer(n.footprint, $2)))) AS shared_m
    FROM segments s
    JOIN h3_buildings n
      ON n.ref <> s.ref
     AND ST_DWithin(n.footprint, s.s, $2)
   GROUP BY s.ref, s.path, s.s
)
SELECT s.ref,
       s.path[2] AS ring,
       degrees(ST_Azimuth(ST_StartPoint(s.s), ST_EndPoint(s.s))) AS azimuth_deg,
       ST_Length(s.s) AS length_m,
       -- No neighbour within tolerance of this edge is a measured fact (no row
       -- in \`shared\`), and its party-wall length is zero by definition — not
       -- a default standing in for a value that failed to compute.
       CASE WHEN sh.shared_m IS NULL THEN 0 ELSE sh.shared_m END AS shared_m
  FROM segments s
  LEFT JOIN shared sh USING (ref, path)
 ORDER BY s.ref, s.path
`;
