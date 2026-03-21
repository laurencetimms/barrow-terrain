# Habitation Generation — Claude Code Prompt

I'm building a terrain generator for a game called The Barrow. The project is a TypeScript/Vite app. The source files are in `src/`. Read all source files first to understand the current architecture.

The terrain generator currently produces geology, altitude, rivers, ice, vegetation, and water-lands. I now need to add the habitation layer: settlements, sacred sites, paths, seasonal camps, hunting group circuits, and wight territories — all derived from the terrain data and the world seed.

This is a large feature. Implement it incrementally, letting me review at each step. Here's the full algorithm:

---

## Step 1: Animal Distribution Overlay

Before placing settlements, generate a food-resource overlay on the terrain grid. Each land cell gets tags describing what food is available. This is a lookup from existing terrain data, not a simulation.

**Species and their habitats:**

**Red deer.** The major large game. Present across most land except ice and deep water-lands. Highest density at forest edges and transitional zones (woodland meeting open ground). In limestone dales (lush valleys with forest edges): high. Clay lowlands and chalk: moderate. Granite and sandstone: lower. Seasonal movement: summer density shifts uphill (above treeline grazing), winter shifts to valleys and forest edges.

**Boar.** Forest animal. Concentrated in clay lowlands and oak-hazel woodlands of limestone and slate country. Absent from open moorland and high ground. Density follows forest/vegetation density.

**Aurochs (wild cattle).** Open grassland and forest-edge grazers. Present on chalk downland, wider limestone dales, open areas of clay lowlands. Not in dense forest, not on high moorland. Fewer than deer but much more meat per animal.

**Hares.** Present across open ground — chalk grassland, moorland, heathland, field edges. Not in dense forest. Culturally significant — associated with the moon and with boundary-crossing in word-tellings.

**Fish.** River fish (salmon, trout, eels) in every significant river, concentrated at confluences, shallow runs, and tidal reaches near the coast. Sea fish along all coasts. Water-lands have abundant fish. Seasonal — salmon runs in specific months, eels migrate at specific times. Tag river cells and coastal cells with fish availability, weighted by river flow (larger rivers = more fish) and by features (confluence bonus, tidal reach bonus).

**Wildfowl.** Ducks, geese, wading birds. Concentrated in water-lands, river margins, coastal marshes, lakes. Highly seasonal — migrating birds present in huge numbers at certain times.

**Seals.** Rocky western coasts and offshore islands.

**Shellfish.** All coasts, especially productive on sheltered eastern shores and in the water-lands.

**Seabirds.** Cliff-nesting colonies on west coast granite headlands.

**Wolves.** Pack hunters. Present across most of the landscape, concentrated where deer are concentrated. Avoid large settlements. Most common in granite moorland, deep forests, northern margins. A wolf pack's territory covers several districts (coarse cells). Generate 8-15 wolf territories across the map, each centred on a high-deer-density area in less-settled terrain. Store as territory records: centre position, radius (~8-12 cells).

**Bears.** Solitary. Forest and mountain animals — clay lowlands, limestone dales, forested valleys of granite and slate country. Less common than wolves, more dangerous individually. Generate individual bear ranges — perhaps 20-40 across the map, each a centre point with a small radius (~4-6 cells), concentrated in forested areas away from large settlements.

**Implementation:** Add a `FoodResources` interface to the terrain system:

```typescript
interface FoodResources {
  deer: number;      // 0-1 density
  boar: number;      // 0-1 density
  aurochs: number;   // 0-1 density
  fish: number;      // 0-1 availability
  wildfowl: number;  // 0-1 density
  hares: number;     // 0-1 density
  shellfish: number; // 0-1 availability
  wolfRisk: number;  // 0-1 danger level
  bearRisk: number;  // 0-1 danger level
}
```

Compute this for each coarse cell based on geology, altitude, vegetation, proximity to water, and predator territory overlap. This data feeds into carrying capacity and into later steps. The values don't need to be stored on every TerrainCell — compute them in a separate grid or compute on demand during settlement placement.

---

## Step 2: Wight Territories

Generate before settlements — they create exclusion zones.

**Cave-wight territories.** Scan for limestone geology at moderate altitude (0.28-0.50) with terrain complexity (altitude variance within a radius, suggesting cave-forming terrain). Generate 10-15 candidate territories. Use the seeded RNG to select 8-12 as occupied. Each territory: centre position, core radius (~3-4 cells where almost nobody lives), peripheral radius (~6-8 cells where settlement is suppressed). Unoccupied candidates are still valid cave habitat but have no wight presence.

**Small-folk territories.** Scan for warm wet habitat — low-altitude clay or water-lands cells with high moisture (near rivers, in the water-lands zone, near coastline). Generate 5-10 candidates, select 3-7 as occupied. Each territory: centre position, radius (~3-5 cells). Settlement is NOT suppressed in small-folk territory (water-people coexist with them) but sacred site placement is influenced.

Store territories as data that influences subsequent generation but is NOT rendered on the map.

---

## Step 3: Carrying Capacity

For each coarse cell, calculate a habitability score (0 to 1):

**Base geology productivity:**
- Clay: 1.0
- Chalk: 0.85
- Limestone: 0.65
- Sandstone: 0.45
- Slate: 0.35
- Granite: 0.2
- Glacial: 0.05
- Ice: 0
- Water: 0

**Altitude modifier:** Full productivity below the treeline (~altitude 0.45). Multiply by 0.3 above treeline. Multiply by 0.1 well above treeline (~altitude 0.55+).

**Water access modifier:** Cells within 3 cells of a river: multiply by 1.3. Cells within 3 cells of coast: multiply by 1.2 (fishing access). Cells far from any water (>8 cells): multiply by 0.6.

**Animal bonus:** Add the food resource overlay values — cells with high deer/boar/fish density get a small bonus (up to +0.15) on top of geology-based productivity.

**Cave-wight suppression:** Cells in cave-wight core territory: multiply by 0.1. Cells in peripheral territory: multiply by 0.5.

**Water-lands modifier:** Water-lands cells use a different model — base productivity 0.3 (fishing/fowling) instead of geology-based, but only for cells on raised ground within the water-lands (not submerged cells).

Result: a habitability grid driving all settlement placement. The total should calibrate to support roughly 100,000-250,000 people across the whole map.

---

## Step 4: Permanent Settlements

**Identify candidates.** A cell is a settlement candidate if:
- Habitability > 0.3
- Not water, ice, or in cave-wight core territory
- Within 3 cells of: a river, a spring-line (chalk-clay geology boundary), or coastline
- Not already claimed by another settlement's catchment

**Score candidates** by suitability:
- Cell's own habitability
- Average habitability within 5-cell catchment radius (the hinterland)
- Proximity to ford (river cell where bank-to-bank altitude gradient is small and flow < 300): +0.3 bonus
- Proximity to river confluence (where two river cells with flow > threshold meet): +0.2 bonus
- Proximity to geological boundary: +0.1 bonus
- Proximity to coast: +0.15 bonus

**Ford identification:** Scan river cells. A ford exists where: the cell has riverFlow > threshold, AND the altitude difference between the cell and at least one non-river neighbour across the river is < 0.02, AND riverFlow < 300 (not too deep/fast). Mark ford cells — they're important for both settlement placement and path routing.

**Place settlements greedily**, highest score first:
1. Place settlement at the best remaining candidate
2. Calculate catchment radius based on geology productivity — larger catchment in less productive areas (people need more land), smaller in productive areas. Roughly: radius = 3 + (1 - averageHabitability) * 4 cells
3. Sum habitability within the catchment × density factor → population
4. Assign size: homestead (5-15 pop), hamlet (15-40), village (40-100), large village/town (100+)
5. Mark catchment cells as claimed
6. Continue until no candidate scores above minimum threshold or total population reaches target

**The walled town:** The single highest-scoring placement gets tagged as the walled town. Maximum one or two settlements of this scale. Should end up on the chalk south or clay lowlands near a major ford.

**Water-lands settlements:** Use different criteria — settlement candidates must be on raised ground (islands) within the water-lands zone. Score by: island size, proximity to channels (boat access), fish/wildfowl density. These are smaller (crannog/raised mound type, 10-30 people).

---

## Step 5: Abandoned Settlements

After placing active settlements, make a second pass using a "historical landscape" modification:
- Temporarily lower the water level in the water-lands by 0.03 altitude (exposing more land)
- Temporarily shift the ice margin north by ~0.05 ny (exposing more northern land)
- Temporarily improve the habitability of marginal cells by 20%

Run the same candidate-scoring on these modified conditions. Any new candidates that:
- Don't overlap with active settlement catchments
- Would have scored above the minimum threshold under historical conditions
- Score BELOW the minimum threshold under current conditions

...are marked as abandoned settlements. Assign a size (based on historical capacity) and implied abandonment reason (water rose, ice advanced, land became marginal).

Generate 5-15 abandoned settlements. These are important sites for the player — poignant, atmospheric, connected to themes of loss and deep time.

---

## Step 6: Paths

Connect settlements with a path network.

**Phase 1 — Local connections.** For each settlement, connect to its 2-3 nearest neighbours by straight-line distance. Use A* pathfinding on the terrain grid where movement cost per cell = base cost × slope penalty × vegetation penalty × water barrier penalty:
- Base cost: 1.0
- Slope penalty: 1.0 + abs(altitude difference to neighbour) × 15
- Vegetation penalty: dense forest (clay) = 1.8, moderate forest (limestone/slate valleys) = 1.4, open (chalk/granite/sandstone) = 1.0
- Water barrier: water cells cost 50 (effectively impassable without a ford), ford cells cost 2.0
- Ice cells: impassable (cost 999)

**Phase 2 — River paths.** Settlements along the same river system (connected by river flow) get bankside paths. Trace the river between them — the path follows cells adjacent to the river.

**Phase 3 — Ridge paths.** Identify ridgelines by scanning for cells that are local altitude maxima in the east-west direction (higher than both the cell to the east and the cell to the west). Connect settlements that lie near the same ridgeline with a path that follows the ridge. These are the long-distance routes.

**Phase 4 — Ford convergence.** Ensure that paths from settlements on opposite sides of a river route through the nearest ford. If two settlements are on opposite banks and both within 10 cells of a ford, connect them through that ford.

**Path properties:** Each path segment gets a traffic score = sum of the populations of the settlements it connects (directly and indirectly through the network). High-traffic paths are major trade routes. Low-traffic paths are local tracks. Store paths as sequences of cell coordinates with a traffic score.

---

## Step 7: Sacred Sites

Place after settlements and paths — sacred sites relate to both.

**Major ceremonial sites (3-5 total).** Score all cells by:
- Terrain prominence: how much higher than surrounding terrain within a large radius (20+ cells)
- Visibility: estimated area visible from this point (simplified — altitude advantage over surroundings)
- Path network proximity: distance to nearest major path (high-traffic)
- Geological significance: at a boundary between two geology types (+bonus), on the chalk escarpment (+bonus)
- Near but not inside cave-wight territory: +bonus (the sacred site may originate from the wight relationship)

Select the top 3-5. The single best gets tagged as the great complex (the Avebury-equivalent). Others get large stone circles.

**Significant local sites (20-40 total).** Score cells by:
- Local prominence: highest point within 8-cell radius
- Chalk escarpment crest: cells on the chalk escarpment ridge get barrows
- River confluence: +bonus
- Geological boundary: +bonus
- Coastal headlands (granite/slate at coast): +bonus
- Cave-wight territory periphery: +bonus
- Not too close to another significant site (minimum spacing of 8 cells)

Distribute to ensure coverage — every broad region should have at least a few. Use seeded RNG weighted by score.

**Small sacred features (80-150 total).** Place at:
- Spring lines (chalk-clay boundaries near rivers)
- Small hilltops and notable outcrops
- Cave entrances (limestone at moderate altitude with terrain complexity)
- Large erratic boulders (glacial debris zone, isolated granite cells outside granite zone)
- Pools (low points near rivers or in limestone, cells lower than all neighbours)
- Near small-folk territories: natural features (pools, springs) more likely to be sacred

Many of these should NOT be visible on the map at coarse zoom — they're discovery content. Mark them with a visibility threshold: visible at zoom > 5, or zoom > 10, or walker-only.

**Assign types to sacred sites:**
- Major: stone circle, henge, great complex
- Significant: standing stone, barrow, small stone circle, cairn
- Small: marked stone, sacred spring, offering pool, cave entrance, sacred tree, carved rock face

Use the seeded RNG for type assignment, weighted by geology (barrows on chalk, cairns on granite, marked stones on sandstone, cave entrances on limestone, sacred springs at geology boundaries).

---

## Step 8: Seasonal Camps

**Upland grazing camps.** For each settlement below the treeline that has high-altitude terrain within 8 cells: place a seasonal camp on the nearest suitable high-ground cell (above treeline, near water, not too steep). Link it to the parent settlement with a path.

**Fishing camps.** At river cells with high fish availability (high flow at confluences, tidal reaches within 10 cells of coast) that are near but not at a permanent settlement: place a seasonal fishing camp. 10-20 across the map.

**Gathering camps.** In forested areas (clay geology, moderate altitude) near paths but away from settlements: scatter 15-25 small gathering camps using seeded RNG. These represent seasonal nut-gathering, plant-gathering sites.

**Flint-mining camps.** On chalk geology at moderate altitude (where flint occurs): place 2-4 mining camps. These are larger than other seasonal camps — significant seasonal work sites.

**Trading gathering sites.** At intersections of major paths, and at major sacred sites: place 3-6 trading sites. These are where people from different regions meet.

---

## Step 9: Hunting Group Circuits

Generate 5-10 hunting group circuits in the less-settled parts of the landscape.

For each circuit:
1. Find a starting area in low-settlement-density terrain (granite, deep forest, northern margins, geological transition zones)
2. Select 4-6 seasonal waypoints forming a rough loop:
   - Spring: near a river with high fish availability
   - Summer: on high ground with high deer density
   - Autumn: in oak forest (clay or limestone) with high boar density and nut resources
   - Winter: in a sheltered valley (low altitude, near forest) with good deer density and firewood
3. Route the circuit path between waypoints using the same A* pathfinding as settlement paths
4. Assign a group size (8-20 people) using seeded RNG
5. Place temporary camp markers at each waypoint — the smallest settlement type

Circuits should avoid the densely settled core (chalk south, major clay settlements) but pass near enough to some settlements that trade contact is plausible (within 5-10 cells of at least one settlement).

---

## Step 10: Validation

After all placement:

**Connectivity check.** Every active settlement must be reachable from every other through the path network. If any are isolated, add connecting paths.

**Population check.** Total active population should be 100,000-250,000. Adjust by adding or removing the smallest/most marginal settlements.

**Coverage check.** Every broad region (divide the map into a 4×6 grid of regions) should have at least one significant sacred site and several small features.

**Density gradient check.** Count settlements per region. The south should be denser than the north, lowlands denser than uplands, chalk and clay denser than granite. If the gradient is wrong, the carrying capacity needs adjustment.

---

## Step 11: Rendering

Render the results as map markers on top of the existing terrain:

**Permanent settlements:** Warm amber-brown dots (`#b08850`). Size varies with population:
- Homestead: 2px radius
- Hamlet: 3px radius
- Village: 4px radius
- Walled town: 6px radius with a thin outline ring
Visible at all zoom levels for hamlet and above. Homesteads visible at zoom > 2.

**Abandoned settlements:** Same shape as active but hollow outline in faded grey-brown (`#8a7a6a`). Visible at zoom > 3.

**Major sacred sites:** Pale gold circles (`#c8b070`), 4-5px radius. Visible at all zoom levels.

**Significant local sacred sites:** Smaller pale gold dots (`#c8b070`), 2-3px radius. Visible at zoom > 2.

**Small sacred features:** Tiny pale dots, 1-2px. Visible only at zoom > 5.

**Seasonal camps:** Small lighter dots (`#c0a870`), 1.5px radius. Visible at zoom > 3.

**Paths:** Thin lines connecting settlements.
- Major trade routes (traffic > 500): rendered as 1.5px warm brown lines (`#7a6a50`). Visible at zoom > 1.5.
- Local paths (traffic > 100): 1px lines in a lighter brown (`#9a8a70`). Visible at zoom > 3.
- Minor paths: 0.5px faint lines. Visible at zoom > 5.

**Fords:** Small blue-brown marks at river crossing points. Visible at zoom > 3.

**Hunting circuits, wolf territories, bear ranges, wight territories:** NOT rendered. Invisible data that affects placement.

**Hover inspection:** Update the cursor info to show settlement name/size, sacred site type, or path traffic when hovering over these features. At minimum show "Hamlet · pop ~25" or "Standing stone" or "Trade route."

---

## Implementation Order

1. Animal distribution overlay (compute food resources from terrain)
2. Wight territories (scan and place)
3. Carrying capacity grid (combine geology + altitude + water + animals + wight suppression)
4. Ford identification (scan rivers)
5. Permanent settlement placement (greedy with catchment claiming)
6. Abandoned settlement placement (historical conditions pass)
7. Path network generation (local + river + ridge + ford convergence)
8. Sacred site placement (major → significant → small)
9. Seasonal camps (grazing + fishing + gathering + mining + trading)
10. Hunting group circuits
11. Validation passes
12. Rendering (markers + paths + hover info)

Implement each step, let me review the results on the map, then proceed to the next. Start by reading all source files and proposing your approach for step 1.