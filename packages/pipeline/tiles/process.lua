--[[
  Wayfinder GN tile schema.

  Written from scratch rather than using tilemaker's bundled OpenMapTiles profile, for a
  concrete reason: that profile sources ocean polygons, Natural Earth urban areas, glaciers and
  ice shelves from external shapefiles. Those are downloads this project does not have and does
  not want (zero external services), and three of the four are meaningless for an inland
  district in the Indian plains.

  So this is a lean, navigation-first schema. Layer names and attribute names here are the
  contract with the hand-written MapLibre style: change one and the other must change with it.

  Input is data/clipped.osm.pbf, the deduped BUILD_AREA subset written by our own PBF writer.
  That is why nothing here has to worry about the Central/Northern seam: the doubled elements
  were removed before tilemaker ever saw them.
]]--

-- Nodes are only passed to node_function if they carry one of these keys. Everything else is
-- geometry for ways and never needs its own tile feature.
node_keys = { "place", "amenity", "shop", "tourism", "leisure", "healthcare", "office",
              "highway", "railway", "aeroway", "barrier", "natural" }

function Set(list)
  local s = {}
  for _, v in ipairs(list) do s[v] = true end
  return s
end

-- Road classes we care about, with the zoom each first appears at. A motorway must be visible
-- when zoomed out; a service road must not be, or the low zooms turn into grey mud.
roadMinZoom = {
  motorway = 6, trunk = 6, primary = 8, secondary = 10, tertiary = 11,
  unclassified = 12, residential = 12, living_street = 13, service = 14,
  motorway_link = 9, trunk_link = 9, primary_link = 10, secondary_link = 11,
  tertiary_link = 12, road = 13, pedestrian = 13, footway = 14, path = 14,
  cycleway = 14, steps = 15, track = 14,
}

placeMinZoom = { city = 6, town = 8, suburb = 10, village = 10, neighbourhood = 12,
                 quarter = 12, hamlet = 12, locality = 13, isolated_dwelling = 14 }
placeRank    = { city = 1, town = 2, suburb = 3, village = 4, neighbourhood = 5,
                 quarter = 5, hamlet = 6, locality = 7, isolated_dwelling = 8 }

waterwayClasses = Set { "river", "stream", "canal", "drain", "ditch" }
landuseClasses  = Set { "residential", "industrial", "commercial", "retail", "farmland",
                        "farmyard", "orchard", "cemetery", "quarry", "military", "construction" }
leisureAsLanduse = Set { "park", "garden", "playground", "pitch", "sports_centre", "stadium",
                         "golf_course", "recreation_ground" }
poiClasses = Set { "hospital", "clinic", "doctors", "pharmacy", "school", "college",
                   "university", "bank", "atm", "fuel", "police", "fire_station",
                   "post_office", "place_of_worship", "restaurant", "cafe", "fast_food",
                   "bus_station", "marketplace", "townhall", "library", "parking" }

-- Names: keep the local-script name AND the Latin one. Many names here are Devanagari, and a
-- style that can only render Latin must still have something to draw. Never drop the original.
function writeNames(obj)
  local name = obj:Find("name")
  if name ~= "" then obj:Attribute("name", name) end
  local en = obj:Find("name:en")
  if en ~= "" then obj:Attribute("name:en", en) end
  local hi = obj:Find("name:hi")
  if hi ~= "" then obj:Attribute("name:hi", hi) end
end

function node_function(node)
  local place = node:Find("place")
  if place ~= "" and placeMinZoom[place] ~= nil then
    node:Layer("place", false)
    node:Attribute("class", place)
    node:AttributeNumeric("rank", placeRank[place])
    writeNames(node)
    node:MinZoom(placeMinZoom[place])
    return
  end

  local amenity = node:Find("amenity")
  local shop = node:Find("shop")
  local healthcare = node:Find("healthcare")
  local cls = ""
  if amenity ~= "" and poiClasses[amenity] then cls = amenity
  elseif shop ~= "" then cls = "shop"
  elseif healthcare ~= "" then cls = healthcare
  elseif node:Find("tourism") ~= "" then cls = node:Find("tourism")
  end
  if cls ~= "" and node:Find("name") ~= "" then
    node:Layer("poi", false)
    node:Attribute("class", cls)
    writeNames(node)
    node:MinZoom(14)
  end
end

function way_function(way)
  local highway = way:Find("highway")
  local isClosed = way:IsClosed()

  if highway ~= "" then
    local mz = roadMinZoom[highway]
    if mz ~= nil then
      way:Layer("transportation", false)
      way:Attribute("class", highway)
      way:MinZoom(mz)
      -- oneway is written so the style can draw direction arrows, and so a visual check can
      -- confirm the tile agrees with the graph. Charter item 3 is easiest to catch by eye.
      local oneway = way:Find("oneway")
      if oneway == "yes" or oneway == "1" or oneway == "true" then
        way:AttributeNumeric("oneway", 1)
      elseif oneway == "-1" or oneway == "reverse" then
        way:AttributeNumeric("oneway", -1)
      end
      if way:Find("bridge") ~= "" then way:AttributeNumeric("bridge", 1) end
      if way:Find("tunnel") ~= "" then way:AttributeNumeric("tunnel", 1) end
      if way:Find("junction") == "roundabout" then way:AttributeNumeric("roundabout", 1) end
      local ref = way:Find("ref")
      if ref ~= "" then way:Attribute("ref", ref) end

      -- Road labels ride in their own layer so the style can place them independently of the
      -- casing and fill, which is what stops labels fighting the line at every zoom.
      if way:Find("name") ~= "" then
        way:Layer("transportation_name", false)
        way:Attribute("class", highway)
        writeNames(way)
        if ref ~= "" then way:Attribute("ref", ref) end
        way:MinZoom(math.max(mz, 12))
      end
    end
    return
  end

  local waterway = way:Find("waterway")
  if waterwayClasses[waterway] then
    way:Layer("waterway", false)
    way:Attribute("class", waterway)
    writeNames(way)
    if waterway == "river" then way:MinZoom(8) else way:MinZoom(12) end
    return
  end

  if way:Find("natural") == "water" or way:Find("landuse") == "reservoir" or waterway == "riverbank" then
    way:Layer("water", true)
    way:Attribute("class", way:Find("water") ~= "" and way:Find("water") or "lake")
    writeNames(way)
    way:MinZoom(8)
    return
  end

  local landuse = way:Find("landuse")
  local leisure = way:Find("leisure")
  if landuseClasses[landuse] then
    way:Layer("landuse", true)
    way:Attribute("class", landuse)
    writeNames(way)
    way:MinZoom(10)
    return
  end
  if leisureAsLanduse[leisure] then
    way:Layer("landuse", true)
    way:Attribute("class", leisure)
    writeNames(way)
    way:MinZoom(11)
    return
  end

  if way:Find("building") ~= "" and isClosed then
    way:Layer("building", true)
    way:MinZoom(14)
    return
  end

  if way:Find("boundary") == "administrative" then
    local level = tonumber(way:Find("admin_level"))
    if level ~= nil and level <= 6 then
      way:Layer("boundary", false)
      way:AttributeNumeric("admin_level", level)
      way:MinZoom(6)
    end
  end
end

-- Boundary relations are accepted so their member ways carry admin_level through to the
-- boundary layer. Multipolygon areas are assembled by tilemaker itself and arrive at
-- way_function, so they need no handling here.
function relation_scan_function(relation)
  if relation:Find("type") == "boundary" and relation:Find("boundary") == "administrative" then
    relation:Accept()
  end
end
