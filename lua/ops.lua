-- Aseprite MCP operations, executed inside Aseprite.
--
-- One-shot: aseprite -b --script-param params=<json file> --script ops.lua
-- Worker:   aseprite -b --script-param worker=1 --script ops.lua
--           (reads one JSON request per stdin line, writes one result line per request)
--
-- Request: { id?, path?, steps = [{op=..., ...}] }
-- Result line: "__MCP_RESULT__" .. json { id, ok, results | error }

local MARKER = "__MCP_RESULT__"
local pc = app.pixelColor
local floor, abs, min, max, sin, cos = math.floor, math.abs, math.min, math.max, math.sin, math.cos

---------------------------------------------------------------------------
-- Basics
---------------------------------------------------------------------------

local function fail(msg) error({ mcp = true, message = msg }, 0) end
local function clamp(v, a, b) return v < a and a or (v > b and b or v) end
local function round(v) return floor(v + 0.5) end
local function hex2(n) return string.format("%02x", n) end

local function rgbaHex(r, g, b, a)
  if a == 0 then return "transparent" end
  local h = "#" .. hex2(r) .. hex2(g) .. hex2(b)
  if a < 255 then h = h .. hex2(a) end
  return h
end

-- Returns r, g, b, a (0-255).
local function parseRGBA(s)
  if type(s) ~= "string" then fail("color must be a string like #rrggbb, got " .. tostring(s)) end
  local str = s:lower():gsub("%s", "")
  if str == "transparent" or str == "none" or str == "clear" then return 0, 0, 0, 0 end
  str = str:gsub("^#", "")
  if #str == 3 or #str == 4 then str = str:gsub(".", "%0%0") end
  if not str:match("^%x+$") or (#str ~= 6 and #str ~= 8) then
    fail("invalid color '" .. s .. "' (use #rgb, #rrggbb, #rrggbbaa or 'transparent')")
  end
  return tonumber(str:sub(1, 2), 16), tonumber(str:sub(3, 4), 16), tonumber(str:sub(5, 6), 16),
    #str == 8 and tonumber(str:sub(7, 8), 16) or 255
end

-- HSV (h 0-360, s/v 0-1)
local function rgb2hsv(r, g, b)
  r, g, b = r / 255, g / 255, b / 255
  local mx, mn = max(r, g, b), min(r, g, b)
  local d = mx - mn
  local h = 0
  if d > 0 then
    if mx == r then h = 60 * (((g - b) / d) % 6)
    elseif mx == g then h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4) end
  end
  return h, mx == 0 and 0 or d / mx, mx
end

local function hsv2rgb(h, s, v)
  local c = v * s
  local x = c * (1 - abs((h / 60) % 2 - 1))
  local m = v - c
  local r, g, b
  if h < 60 then r, g, b = c, x, 0
  elseif h < 120 then r, g, b = x, c, 0
  elseif h < 180 then r, g, b = 0, c, x
  elseif h < 240 then r, g, b = 0, x, c
  elseif h < 300 then r, g, b = x, 0, c
  else r, g, b = c, 0, x end
  return round((r + m) * 255), round((g + m) * 255), round((b + m) * 255)
end

-- Hue-shifted lighten/darken, the classic pixel-art ramp technique.
-- a < 0 darkens (hue toward blue/purple, more saturation); a > 0 lightens (toward yellow, less saturation).
local function shiftColor(r, g, b, a, hueShift)
  local h, s, v = rgb2hsv(r, g, b)
  local target = a < 0 and 250 or 55
  local amt = abs(a) * (hueShift or 20)
  if s < 0.06 then
    h = target; s = s + abs(a) * 0.06
  else
    local d = ((target - h + 540) % 360) - 180
    h = (h + clamp(d, -amt, amt)) % 360
  end
  v = clamp(v + a * 0.3, 0, 1)
  s = clamp(s + (a < 0 and 0.12 or -0.12) * abs(a), 0, 1)
  return hsv2rgb(h, s, v)
end

-- sRGB -> CIELAB (for perceptual nearest-color matching)
local function lin(c)
  c = c / 255
  return c <= 0.04045 and c / 12.92 or ((c + 0.055) / 1.055) ^ 2.4
end
local function labf(t) return t > 0.008856 and t ^ (1 / 3) or (7.787 * t + 16 / 116) end
local function rgb2lab(r, g, b)
  local R, G, B = lin(r), lin(g), lin(b)
  local x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
  local y = (R * 0.2126 + G * 0.7152 + B * 0.0722)
  local z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  local fx, fy, fz = labf(x), labf(y), labf(z)
  return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)
end

-- 4x4 Bayer matrix thresholds in (0,1)
local BAYER = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 }
local function bayer(x, y) return (BAYER[(y % 4) * 4 + (x % 4) + 1] + 0.5) / 16 end

---------------------------------------------------------------------------
-- Pixel codec per color mode
---------------------------------------------------------------------------

local function nearestIndex(sprite, r, g, b)
  local pal = sprite.palettes[1]
  local best, bestD = 0, math.huge
  for i = 0, #pal - 1 do
    if i ~= sprite.transparentColor then
      local c = pal:getColor(i)
      local dr, dg, db = c.red - r, c.green - g, c.blue - b
      local d = dr * dr + dg * dg + db * db
      if d < bestD then best, bestD = i, d end
      if d == 0 then break end
    end
  end
  return best
end

-- codec.enc(r,g,b,a) -> pixel, codec.dec(pixel) -> r,g,b,a, codec.clear(pixel) -> bool, codec.none = transparent pixel
local function makeCodec(sprite)
  local mode = sprite.colorMode
  local c = { rgb = mode == ColorMode.RGB }
  if mode == ColorMode.RGB then
    c.none = 0
    c.enc = function(r, g, b, a) return pc.rgba(r, g, b, a) end
    c.dec = function(px) return pc.rgbaR(px), pc.rgbaG(px), pc.rgbaB(px), pc.rgbaA(px) end
    c.clear = function(px) return pc.rgbaA(px) == 0 end
  elseif mode == ColorMode.GRAY then
    c.none = 0
    c.enc = function(r, g, b, a) return pc.graya(round(0.299 * r + 0.587 * g + 0.114 * b), a) end
    c.dec = function(px) local v = pc.grayaV(px); return v, v, v, pc.grayaA(px) end
    c.clear = function(px) return pc.grayaA(px) == 0 end
  else
    local tr = sprite.transparentColor
    local pal = sprite.palettes[1]
    local cache = {}
    c.none = tr
    c.enc = function(r, g, b, a)
      if a == 0 then return tr end
      local k = r * 65536 + g * 256 + b
      local v = cache[k]
      if not v then v = nearestIndex(sprite, r, g, b); cache[k] = v end
      return v
    end
    c.dec = function(px)
      if px == tr or px >= #pal then return 0, 0, 0, 0 end
      local col = pal:getColor(px)
      return col.red, col.green, col.blue, col.alpha
    end
    c.clear = function(px) return px == tr end
  end
  c.parse = function(s) return c.enc(parseRGBA(s)) end
  c.hex = function(px) return rgbaHex(c.dec(px)) end
  return c
end

---------------------------------------------------------------------------
-- Sprite / layer / frame helpers
---------------------------------------------------------------------------

local function readFile(path)
  local f = io.open(path, "r")
  if not f then fail("cannot open " .. path) end
  local t = f:read("a"); f:close()
  return t
end

local function openSprite(path)
  if not app.fs.isFile(path) then fail("file not found: " .. path) end
  local sprite = app.open(path)
  if not sprite then fail("could not open " .. path) end
  return sprite
end

local function need(ctx)
  if not ctx.sprite then fail("no sprite open (missing or nonexistent 'path')") end
  return ctx.sprite
end

local function allLayers(layers, out, prefix)
  out = out or {}
  for _, l in ipairs(layers) do
    local name = prefix and (prefix .. "/" .. l.name) or l.name
    out[#out + 1] = { layer = l, path = name }
    if l.isGroup then allLayers(l.layers, out, name) end
  end
  return out
end

local function imageLayers(sprite)
  local out = {}
  for _, e in ipairs(allLayers(sprite.layers)) do
    if e.layer.isImage and not e.layer.isTilemap then out[#out + 1] = e end
  end
  return out
end

-- Layer by name, "Group/Child" path, or 1-based top-level index. Default: top-most image layer.
local function resolveLayer(sprite, ref)
  if ref == nil then
    local ls = imageLayers(sprite)
    if #ls == 0 then fail("sprite has no image layers") end
    return ls[#ls].layer
  end
  if type(ref) == "number" then
    local l = sprite.layers[ref]
    if not l then fail("no layer at index " .. ref) end
    return l
  end
  for _, e in ipairs(allLayers(sprite.layers)) do
    if e.path == ref or e.layer.name == ref then return e.layer end
  end
  fail("layer not found: " .. tostring(ref))
end

local function resolveFrame(sprite, n)
  n = n or 1
  if n < 1 or n > #sprite.frames then
    fail("frame " .. n .. " out of range (1.." .. #sprite.frames .. ")")
  end
  return n
end

-- Cel plus a full-canvas copy of its image to draw on.
local function editableImage(sprite, layer, frame)
  if not layer.isImage then fail("layer '" .. layer.name .. "' is not an image layer") end
  if layer.isTilemap then fail("tilemap layers are not supported") end
  local cel = layer:cel(frame)
  local img = Image(sprite.spec)
  if cel then img:drawImage(cel.image, cel.position)
  else cel = sprite:newCel(layer, frame, Image(sprite.spec), Point(0, 0)) end
  return cel, img
end

local function commit(cel, img)
  cel.image = img
  cel.position = Point(0, 0)
end

-- Runs fn(img, codec) on the target layer/frame and commits it.
local function withImage(ctx, p, fn)
  local sprite = need(ctx)
  local cel, img = editableImage(sprite, resolveLayer(sprite, p.layer), resolveFrame(sprite, p.frame))
  local r = fn(img, makeCodec(sprite), sprite)
  commit(cel, img)
  return r
end

-- Applies fn(img) to every cel (or only the given layer/frame).
local function forEachCel(sprite, p, fn)
  local layers = {}
  if p.layer then layers = { resolveLayer(sprite, p.layer) }
  else for _, e in ipairs(imageLayers(sprite)) do layers[#layers + 1] = e.layer end end
  local n = 0
  for _, l in ipairs(layers) do
    for f = 1, #sprite.frames do
      if not p.frame or p.frame == f then
        local cel = l:cel(f)
        if cel then
          local img = cel.image:clone()
          n = n + (fn(img) or 0)
          cel.image = img
        end
      end
    end
  end
  return n
end

-- Flattened RGB render of a frame (optionally a single layer).
local function renderRGB(sprite, frame, onlyLayer)
  local img = Image(sprite.width, sprite.height, ColorMode.RGB)
  if onlyLayer then
    local saved = {}
    for _, e in ipairs(allLayers(sprite.layers)) do
      saved[#saved + 1] = { e.layer, e.layer.isVisible }
      local keep = e.layer == onlyLayer
      local p = onlyLayer.parent
      while not keep and p and p ~= sprite do
        if p == e.layer then keep = true end
        p = p.parent
      end
      e.layer.isVisible = keep
    end
    img:drawSprite(sprite, frame)
    for _, s in ipairs(saved) do s[1].isVisible = s[2] end
  else
    img:drawSprite(sprite, frame)
  end
  return img
end

local function inb(img, x, y) return x >= 0 and y >= 0 and x < img.width and y < img.height end
local function put(img, x, y, px) if inb(img, x, y) then img:drawPixel(x, y, px) end end

local function layerNames(sprite)
  local out = {}
  for _, e in ipairs(allLayers(sprite.layers)) do out[#out + 1] = e.path end
  return out
end

local function paletteHex(sprite)
  local pal = sprite.palettes[1]
  local out = {}
  for i = 0, #pal - 1 do
    local c = pal:getColor(i)
    out[#out + 1] = rgbaHex(c.red, c.green, c.blue, c.alpha)
  end
  return out
end

local function applyPalette(sprite, colors)
  local pal = Palette(#colors)
  for i, h in ipairs(colors) do
    local r, g, b, a = parseRGBA(h)
    pal:setColor(i - 1, Color { r = r, g = g, b = b, a = a })
  end
  sprite:setPalette(pal)
end

local function modeName(m)
  if m == ColorMode.RGB then return "rgb" end
  if m == ColorMode.GRAY then return "grayscale" end
  return "indexed"
end

local DIRS = { forward = AniDir.FORWARD, reverse = AniDir.REVERSE, pingpong = AniDir.PING_PONG,
  pingpong_reverse = AniDir.PING_PONG_REVERSE }
local DIR_NAMES = {}
for k, v in pairs(DIRS) do DIR_NAMES[v] = k end

---------------------------------------------------------------------------
-- Drawing primitives
---------------------------------------------------------------------------

local function plotLine(x0, y0, x1, y1, fn)
  local dx, dy = abs(x1 - x0), -abs(y1 - y0)
  local sx, sy = x0 < x1 and 1 or -1, y0 < y1 and 1 or -1
  local err = dx + dy
  while true do
    fn(x0, y0)
    if x0 == x1 and y0 == y1 then break end
    local e2 = 2 * err
    if e2 >= dy then err = err + dy; x0 = x0 + sx end
    if e2 <= dx then err = err + dx; y0 = y0 + sy end
  end
end

-- Pixel-perfect ellipse inside the box. fn(x, y, isEdge)
local function plotEllipse(x0, y0, x1, y1, fn)
  if x0 > x1 then x0, x1 = x1, x0 end
  if y0 > y1 then y0, y1 = y1, y0 end
  local cx, cy = (x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2
  local rx, ry = (x1 - x0 + 1) / 2, (y1 - y0 + 1) / 2
  local function inside(x, y)
    if x < x0 or x > x1 or y < y0 or y > y1 then return false end
    local nx, ny = (x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry
    return nx * nx + ny * ny <= 1.0
  end
  for y = y0, y1 do
    for x = x0, x1 do
      if inside(x, y) then
        fn(x, y, not (inside(x - 1, y) and inside(x + 1, y) and inside(x, y - 1) and inside(x, y + 1)))
      end
    end
  end
end

-- Dithered multi-stop gradient over a box. dir: "v" (top->bottom), "h" (left->right), "r" (radial from center)
local function drawGradient(img, codec, x0, y0, x1, y1, stops, dir)
  if x0 > x1 then x0, x1 = x1, x0 end
  if y0 > y1 then y0, y1 = y1, y0 end
  local px = {}
  for i, s in ipairs(stops) do px[i] = codec.parse(s) end
  local n = #px
  if n < 2 then fail("gradient needs at least 2 colors") end
  local w, h = max(1, x1 - x0), max(1, y1 - y0)
  local cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
  local rmax = math.sqrt((w / 2) ^ 2 + (h / 2) ^ 2)
  for y = y0, y1 do
    for x = x0, x1 do
      local t
      if dir == "h" then t = (x - x0) / w
      elseif dir == "r" then t = math.sqrt((x - cx) ^ 2 + (y - cy) ^ 2) / rmax
      else t = (y - y0) / h end
      local f = clamp(t, 0, 1) * (n - 1)
      local k = min(floor(f), n - 2)
      local frac = f - k
      put(img, x, y, frac > bayer(x, y) and px[k + 2] or px[k + 1])
    end
  end
end

---------------------------------------------------------------------------
-- Palette analysis
---------------------------------------------------------------------------

-- Unique opaque colors with counts from a list of RGB images.
local function colorHistogram(images)
  local hist, list = {}, {}
  for _, img in ipairs(images) do
    for it in img:pixels() do
      local v = it()
      if pc.rgbaA(v) >= 128 then
        local k = pc.rgbaR(v) * 65536 + pc.rgbaG(v) * 256 + pc.rgbaB(v)
        local e = hist[k]
        if e then e.n = e.n + 1
        else
          e = { r = pc.rgbaR(v), g = pc.rgbaG(v), b = pc.rgbaB(v), n = 1 }
          hist[k] = e; list[#list + 1] = e
        end
      end
    end
  end
  return list
end

-- Median cut + k-means refinement in Lab. Returns colors sorted dark -> light.
local function extractPalette(list, maxColors)
  for _, c in ipairs(list) do c.L, c.A, c.B = rgb2lab(c.r, c.g, c.b) end
  local out = {}
  if #list <= maxColors then
    for _, c in ipairs(list) do out[#out + 1] = { c.r, c.g, c.b, c.L } end
  else
    local boxes = { list }
    local keys = { "L", "A", "B" }
    while #boxes < maxColors do
      local bi, bk, brange = nil, nil, -1
      for i, box in ipairs(boxes) do
        if #box > 1 then
          local total = 0
          for _, c in ipairs(box) do total = total + c.n end
          for _, k in ipairs(keys) do
            local lo, hi = math.huge, -math.huge
            for _, c in ipairs(box) do lo = min(lo, c[k]); hi = max(hi, c[k]) end
            local score = (hi - lo) * math.sqrt(total)
            if score > brange then bi, bk, brange = i, k, score end
          end
        end
      end
      if not bi then break end
      local box = table.remove(boxes, bi)
      table.sort(box, function(a, b) return a[bk] < b[bk] end)
      local total, acc, cut = 0, 0, 1
      for _, c in ipairs(box) do total = total + c.n end
      for i, c in ipairs(box) do
        acc = acc + c.n
        if acc >= total / 2 then cut = min(max(i, 1), #box - 1); break end
      end
      local a, b = {}, {}
      for i, c in ipairs(box) do if i <= cut then a[#a + 1] = c else b[#b + 1] = c end end
      boxes[#boxes + 1] = a; boxes[#boxes + 1] = b
    end
    -- centroids
    local cents = {}
    for _, box in ipairs(boxes) do
      local L, A, B, n = 0, 0, 0, 0
      for _, c in ipairs(box) do L = L + c.L * c.n; A = A + c.A * c.n; B = B + c.B * c.n; n = n + c.n end
      cents[#cents + 1] = { L / n, A / n, B / n }
    end
    -- k-means refinement
    for _ = 1, 6 do
      local sums = {}
      for i = 1, #cents do sums[i] = { 0, 0, 0, 0, 0, 0, 0 } end
      for _, c in ipairs(list) do
        local bi, bd = 1, math.huge
        for i, k in ipairs(cents) do
          local d = (c.L - k[1]) ^ 2 + (c.A - k[2]) ^ 2 + (c.B - k[3]) ^ 2
          if d < bd then bi, bd = i, d end
        end
        local s = sums[bi]
        s[1] = s[1] + c.L * c.n; s[2] = s[2] + c.A * c.n; s[3] = s[3] + c.B * c.n; s[4] = s[4] + c.n
        s[5] = s[5] + c.r * c.n; s[6] = s[6] + c.g * c.n; s[7] = s[7] + c.b * c.n
      end
      for i, s in ipairs(sums) do
        if s[4] > 0 then cents[i] = { s[1] / s[4], s[2] / s[4], s[3] / s[4], s[5] / s[4], s[6] / s[4], s[7] / s[4] } end
      end
    end
    for _, k in ipairs(cents) do
      if k[4] then out[#out + 1] = { round(k[4]), round(k[5]), round(k[6]), k[1] } end
    end
  end
  table.sort(out, function(a, b) return a[4] < b[4] end)
  local hex, seen = {}, {}
  for _, c in ipairs(out) do
    local h = rgbaHex(c[1], c[2], c[3], 255)
    if not seen[h] then seen[h] = true; hex[#hex + 1] = h end
  end
  return hex
end

-- Nearest palette color in Lab, cached by rgb key. Returns r,g,b.
local function makeMatcher(colors)
  local pal = {}
  for i, h in ipairs(colors) do
    local r, g, b = parseRGBA(h)
    local L, A, B = rgb2lab(r, g, b)
    pal[i] = { r, g, b, L, A, B }
  end
  if #pal == 0 then fail("empty palette") end
  local cache = {}
  return function(r, g, b)
    r, g, b = clamp(round(r), 0, 255), clamp(round(g), 0, 255), clamp(round(b), 0, 255)
    local k = r * 65536 + g * 256 + b
    local e = cache[k]
    if not e then
      local L, A, B = rgb2lab(r, g, b)
      local bd = math.huge
      for _, c in ipairs(pal) do
        local d = (L - c[4]) ^ 2 + (A - c[5]) ^ 2 + (B - c[6]) ^ 2
        if d < bd then bd, e = d, c end
      end
      cache[k] = e
    end
    return e[1], e[2], e[3]
  end
end

-- Upscale factor of "big pixel" art (largest k where nearly all color runs are multiples of k).
local function detectScale(img)
  local W, H = img.width, img.height
  local runs = {}
  local function addRun(len) runs[len] = (runs[len] or 0) + len end
  for y = 0, H - 1, max(1, H // 64) do
    local prev, len = img:getPixel(0, y), 1
    for x = 1, W - 1 do
      local v = img:getPixel(x, y)
      if v == prev then len = len + 1 else addRun(len); prev, len = v, 1 end
    end
    addRun(len)
  end
  for x = 0, W - 1, max(1, W // 64) do
    local prev, len = img:getPixel(x, 0), 1
    for y = 1, H - 1 do
      local v = img:getPixel(x, y)
      if v == prev then len = len + 1 else addRun(len); prev, len = v, 1 end
    end
    addRun(len)
  end
  local total = 0
  for _, n in pairs(runs) do total = total + n end
  for k = 32, 2, -1 do
    if W % k == 0 and H % k == 0 then
      local ok = 0
      for len, n in pairs(runs) do if len % k == 0 then ok = ok + n end end
      if ok / total >= 0.95 then return k end
    end
  end
  return 1
end

---------------------------------------------------------------------------
-- Operations
---------------------------------------------------------------------------

local ops = {}

function ops.create_sprite(ctx, p)
  if app.fs.isFile(ctx.path) and not p.overwrite then
    fail("file already exists: " .. ctx.path .. " (pass overwrite=true)")
  end
  local sprite
  local scale = 1
  if p.from then
    -- Import an image (png/gif/...): undo pixel upscaling, or pixelate to a target size.
    local src = openSprite(p.from)
    local first = renderRGB(src, 1)
    local fx, fy
    if p.width or p.height then
      fx = src.width / (p.width or round(src.width * p.height / src.height))
      fy = src.height / (p.height or round(src.height * p.width / src.width))
    else
      local k = (p.downscale == nil or p.downscale == "auto") and detectScale(first) or p.downscale
      fx, fy = k, k
    end
    scale = fx
    local W, H = round(src.width / fx), round(src.height / fy)
    sprite = Sprite(W, H, ColorMode.RGB)
    for f = 1, #src.frames do
      if f > 1 then sprite:newEmptyFrame(f) end
      sprite.frames[f].duration = src.frames[f].duration
      local full = f == 1 and first or renderRGB(src, f)
      local img = Image(W, H, ColorMode.RGB)
      for y = 0, H - 1 do
        local sy0, sy1 = floor(y * fy), max(floor(y * fy), floor((y + 1) * fy) - 1)
        for x = 0, W - 1 do
          local sx0, sx1 = floor(x * fx), max(floor(x * fx), floor((x + 1) * fx) - 1)
          -- majority color of the block keeps thin lines and avoids blending new colors
          local counts, best, bestN = {}, 0, 0
          for yy = sy0, min(sy1, full.height - 1) do
            for xx = sx0, min(sx1, full.width - 1) do
              local v = full:getPixel(xx, yy)
              if pc.rgbaA(v) == 0 then v = 0 end
              local n = (counts[v] or 0) + 1
              counts[v] = n
              if n > bestN then best, bestN = v, n end
            end
          end
          img:drawPixel(x, y, best)
        end
      end
      sprite:newCel(sprite.layers[1], f, img, Point(0, 0))
    end
    src:close()
    sprite.layers[1].name = p.layerName or "art"
  else
    if not p.width or not p.height then fail("width and height are required (or from=image)") end
    local mode = ColorMode.RGB
    if p.colorMode == "indexed" then mode = ColorMode.INDEXED
    elseif p.colorMode == "grayscale" then mode = ColorMode.GRAY end
    sprite = Sprite(p.width, p.height, mode)
    sprite.layers[1].name = p.layerName or "Layer 1"
  end
  if p.palette and #p.palette > 0 then applyPalette(sprite, p.palette) end
  if p.background and p.background ~= "transparent" then
    local layer = sprite:newLayer()
    layer.name = "background"
    layer.stackIndex = 1
    local img = Image(sprite.spec)
    img:clear(makeCodec(sprite).parse(p.background))
    sprite:newCel(layer, 1, img, Point(0, 0))
  end
  app.fs.makeAllDirectories(app.fs.filePath(ctx.path))
  ctx.sprite = sprite
  return { w = sprite.width, h = sprite.height, frames = #sprite.frames,
    downscaled = scale ~= 1 and (floor(scale * 100 + 0.5) / 100) or nil }
end

function ops.sprite_info(ctx, p)
  local sprite = need(ctx)
  local layers = {}
  for _, e in ipairs(allLayers(sprite.layers)) do
    local l = e.layer
    local s = e.path
    if l.isGroup then s = s .. " [group]" end
    if not l.isVisible then s = s .. " [hidden]" end
    if l.opacity and l.opacity < 255 then s = s .. " [opacity " .. l.opacity .. "]" end
    layers[#layers + 1] = s
  end
  local durs = {}
  for i, f in ipairs(sprite.frames) do durs[i] = round(f.duration * 1000) end
  local tags = {}
  for _, t in ipairs(sprite.tags) do
    tags[#tags + 1] = t.name .. " " .. t.fromFrame.frameNumber .. "-" .. t.toFrame.frameNumber ..
      (t.aniDir ~= AniDir.FORWARD and (" " .. DIR_NAMES[t.aniDir]) or "")
  end
  return {
    size = sprite.width .. "x" .. sprite.height,
    mode = modeName(sprite.colorMode),
    layers = layers,
    frameMs = durs,
    tags = #tags > 0 and tags or nil,
    paletteSize = #sprite.palettes[1],
    palette = p.palette and paletteHex(sprite) or nil,
  }
end

-- Shapes, then grid rows, then single pixels.
function ops.draw(ctx, p)
  return withImage(ctx, p, function(img, codec)
    local n = 0
    for i, s in ipairs(p.shapes or {}) do
      local kind = s[1]
      local x1, y1, x2, y2 = s[2], s[3], s[4], s[5]
      if kind == "gradient" then
        local list = type(s[6]) ~= "string"
        local stops = list and s[6] or { s[6], s[7] }
        local dir = list and s[7] or s[8]
        drawGradient(img, codec, x1, y1, x2, y2, stops, dir)
      else
        local v = codec.parse(s[6])
        local fillV = s[7] and codec.parse(s[7]) or nil
        if kind == "line" then
          plotLine(x1, y1, x2, y2, function(x, y) put(img, x, y, v) end)
        elseif kind == "rect" then
          if x1 > x2 then x1, x2 = x2, x1 end
          if y1 > y2 then y1, y2 = y2, y1 end
          for y = y1, y2 do
            for x = x1, x2 do
              if x == x1 or x == x2 or y == y1 or y == y2 then put(img, x, y, v)
              elseif fillV then put(img, x, y, fillV) end
            end
          end
        elseif kind == "ellipse" then
          plotEllipse(x1, y1, x2, y2, function(x, y, edge)
            if edge then put(img, x, y, v) elseif fillV then put(img, x, y, fillV) end
          end)
        else
          fail("shape " .. i .. ": unknown kind '" .. tostring(kind) .. "' (line|rect|ellipse|gradient)")
        end
      end
      n = n + 1
    end
    if p.rows then
      local legend = {}
      for ch, col in pairs(p.legend or {}) do
        if #ch ~= 1 then fail("legend keys must be single characters, got '" .. ch .. "'") end
        legend[ch] = codec.parse(col)
      end
      local ox, oy = p.x or 0, p.y or 0
      for row, line in ipairs(p.rows) do
        for col = 1, #line do
          local ch = line:sub(col, col)
          if ch ~= "." and ch ~= " " then
            local v = legend[ch]
            if v == nil then fail(string.format("char '%s' (row %d, col %d) not in legend", ch, row, col)) end
            put(img, ox + col - 1, oy + row - 1, v)
          end
        end
      end
      n = n + #p.rows
    end
    if p.pixels then
      local cache = {}
      for _, px in ipairs(p.pixels) do
        local v = cache[px[3]]
        if v == nil then v = codec.parse(px[3]); cache[px[3]] = v end
        put(img, px[1], px[2], v)
      end
      n = n + #p.pixels
    end
    return true
  end)
end

---------------------------------------------------------------------------
-- edit actions
---------------------------------------------------------------------------

local edit = {}

function edit.fill(ctx, p)
  return withImage(ctx, p, function(img, codec)
    if not inb(img, p.x, p.y) then fail("start point out of bounds") end
    local v = codec.parse(p.color)
    local target = img:getPixel(p.x, p.y)
    local n = 0
    if p.contiguous == false then
      for it in img:pixels() do if it() == target then it(v); n = n + 1 end end
    elseif target ~= v then
      local w, h = img.width, img.height
      local stack, seen = { p.x, p.y }, {}
      while #stack > 0 do
        local y = table.remove(stack); local x = table.remove(stack)
        local k = y * w + x
        if not seen[k] and x >= 0 and y >= 0 and x < w and y < h and img:getPixel(x, y) == target then
          seen[k] = true
          img:drawPixel(x, y, v); n = n + 1
          stack[#stack + 1] = x + 1; stack[#stack + 1] = y
          stack[#stack + 1] = x - 1; stack[#stack + 1] = y
          stack[#stack + 1] = x; stack[#stack + 1] = y + 1
          stack[#stack + 1] = x; stack[#stack + 1] = y - 1
        end
      end
    end
    return { filled = n }
  end)
end

function edit.replace(ctx, p)
  local sprite = need(ctx)
  local codec = makeCodec(sprite)
  local from, to = codec.parse(p.from), codec.parse(p.to)
  return { replaced = forEachCel(sprite, p, function(img)
    local n = 0
    for it in img:pixels() do if it() == from then it(to); n = n + 1 end end
    return n
  end) }
end

function edit.mirror(ctx, p)
  return withImage(ctx, p, function(img)
    local w, h = img.width, img.height
    local src = Image(img)
    local m = p.mode or "left_to_right"
    for y = 0, h - 1 do
      for x = 0, w - 1 do
        local mx, my = w - 1 - x, h - 1 - y
        if m == "flip_h" then img:drawPixel(x, y, src:getPixel(mx, y))
        elseif m == "flip_v" then img:drawPixel(x, y, src:getPixel(x, my))
        elseif m == "left_to_right" and x >= math.ceil(w / 2) then img:drawPixel(x, y, src:getPixel(mx, y))
        elseif m == "right_to_left" and x < w // 2 then img:drawPixel(x, y, src:getPixel(mx, y))
        elseif m == "top_to_bottom" and y >= math.ceil(h / 2) then img:drawPixel(x, y, src:getPixel(x, my))
        elseif m == "bottom_to_top" and y < h // 2 then img:drawPixel(x, y, src:getPixel(x, my)) end
      end
    end
    return true
  end)
end

-- Outline around (outside) or along the edge of (inside) the content.
-- color "auto" = a darkened, hue-shifted version of the adjacent color (selective outline).
function edit.outline(ctx, p)
  return withImage(ctx, p, function(img, codec)
    local src = Image(img)
    local w, h = img.width, img.height
    local auto = p.color == nil or p.color == "auto"
    local fixed = not auto and codec.parse(p.color) or nil
    local nb = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }
    if p.corners then nb[5] = { 1, 1 }; nb[6] = { -1, 1 }; nb[7] = { 1, -1 }; nb[8] = { -1, -1 } end
    local cache = {}
    local function darker(v)
      local e = cache[v]
      if not e then
        local r, g, b = codec.dec(v)
        e = codec.enc(r, g, b, 255)
        local nr, ng, nb2 = shiftColor(r, g, b, -(p.strength or 1.3), p.hueShift)
        e = codec.enc(nr, ng, nb2, 255)
        cache[v] = e
      end
      return e
    end
    local inside = p.mode == "inside"
    local n = 0
    for y = 0, h - 1 do
      for x = 0, w - 1 do
        local v = src:getPixel(x, y)
        local clear = codec.clear(v)
        if inside ~= clear then
          local hit
          for _, d in ipairs(nb) do
            local nx, ny = x + d[1], y + d[2]
            if inside then
              if not inb(src, nx, ny) or codec.clear(src:getPixel(nx, ny)) then hit = v; break end
            elseif inb(src, nx, ny) then
              local q = src:getPixel(nx, ny)
              if not codec.clear(q) then hit = q; break end
            end
          end
          if hit then img:drawPixel(x, y, fixed or darker(hit)); n = n + 1 end
        end
      end
    end
    return { outlined = n }
  end)
end

local LIGHT = {
  top_left = { -1, -1 }, top = { 0, -1 }, top_right = { 1, -1 }, left = { -1, 0 },
  right = { 1, 0 }, bottom_left = { -1, 1 }, bottom = { 0, 1 }, bottom_right = { 1, 1 },
}

-- Edge shading from a light direction: shadow on edges facing away, highlight on edges facing the light.
-- Each color region is shaded separately; outline-colored pixels are treated as edges and left alone.
function edit.shade(ctx, p)
  return withImage(ctx, p, function(img, codec)
    local src = Image(img)
    local w, h = img.width, img.height
    local L = LIGHT[p.light or "top_left"] or fail("unknown light direction " .. tostring(p.light))
    local lx, ly = L[1], L[2]
    local depth, hdepth = p.depth or 1, p.highlightDepth or 1
    local skip = {}
    for _, c in ipairs(type(p.ignore) == "string" and { p.ignore } or (p.ignore or {})) do skip[codec.parse(c)] = true end
    local perRegion = p.perRegion ~= false
    local function edge(x, y, base)
      if not inb(src, x, y) then return true end
      local q = src:getPixel(x, y)
      return codec.clear(q) or skip[q] or (perRegion and q ~= base)
    end
    local cache = {}
    local function shifted(v, a, fixed)
      if fixed and fixed ~= "auto" then return codec.parse(fixed) end
      local k = v .. ":" .. a
      local e = cache[k]
      if not e then
        local r, g, b = codec.dec(v)
        local nr, ng, nb = shiftColor(r, g, b, a, p.hueShift)
        e = codec.enc(nr, ng, nb, 255)
        cache[k] = e
      end
      return e
    end
    local n = 0
    for y = 0, h - 1 do
      for x = 0, w - 1 do
        local v = src:getPixel(x, y)
        if not codec.clear(v) and not skip[v] then
          local out
          if p.shadow ~= false then
            for k = 1, depth do
              if (lx ~= 0 and edge(x - lx * k, y, v)) or (ly ~= 0 and edge(x, y - ly * k, v)) then
                out = shifted(v, -(p.strength or 0.55), p.shadow); break
              end
            end
          end
          if not out and p.highlight ~= false then
            for k = 1, hdepth do
              if (lx ~= 0 and edge(x + lx * k, y, v)) or (ly ~= 0 and edge(x, y + ly * k, v)) then
                out = shifted(v, (p.strength or 0.55) * 0.8, p.highlight); break
              end
            end
          end
          if out then img:drawPixel(x, y, out); n = n + 1 end
        end
      end
    end
    return { shaded = n }
  end)
end

-- Copy a region (optionally from another layer/frame, optionally flipped).
function edit.copy(ctx, p)
  local sprite = need(ctx)
  local srcLayer = resolveLayer(sprite, p.fromLayer or p.layer)
  local srcFrame = resolveFrame(sprite, p.fromFrame or p.frame)
  local src = Image(sprite.spec)
  local sc = srcLayer:cel(srcFrame)
  if sc then src:drawImage(sc.image, sc.position) end
  return withImage(ctx, p, function(img, codec)
    local x0, y0 = p.x or 0, p.y or 0
    local w, h = p.width or sprite.width, p.height or sprite.height
    for y = 0, h - 1 do
      for x = 0, w - 1 do
        local sx = p.flip == "h" and (x0 + w - 1 - x) or (x0 + x)
        local sy = p.flip == "v" and (y0 + h - 1 - y) or (y0 + y)
        if inb(src, sx, sy) then
          local v = src:getPixel(sx, sy)
          if p.opaqueOnly == false or not codec.clear(v) then put(img, p.toX + x, p.toY + y, v) end
        end
      end
    end
    return true
  end)
end

-- Move content by dx,dy; wrap=true for seamless tile editing.
function edit.shift(ctx, p)
  return withImage(ctx, p, function(img, codec)
    local src = Image(img)
    local w, h = img.width, img.height
    img:clear(codec.none)
    local dx, dy = p.dx or 0, p.dy or 0
    for y = 0, h - 1 do
      for x = 0, w - 1 do
        local nx, ny = x + dx, y + dy
        if p.wrap then nx, ny = nx % w, ny % h end
        put(img, nx, ny, src:getPixel(x, y))
      end
    end
    return true
  end)
end

-- Pull colors to a palette (Lab nearest), optional ordered or Floyd-Steinberg dithering.
-- strength < 1 only moves part of the way (keeps the original feel).
function edit.quantize(ctx, p)
  local sprite = need(ctx)
  if sprite.colorMode ~= ColorMode.RGB then fail("quantize needs an RGB sprite") end
  local colors = p.palette
  if colors == "sprite" or colors == nil then colors = paletteHex(sprite) end
  local match = makeMatcher(colors)
  local strength = p.strength or 1
  local dither = p.dither or "none"
  local spread = (p.ditherAmount or 0.5) * 64
  local n = forEachCel(sprite, p, function(img)
    local w, h = img.width, img.height
    local errR, errG, errB = {}, {}, {}
    local count = 0
    for y = 0, h - 1 do
      for x = 0, w - 1 do
        local v = img:getPixel(x, y)
        local a = pc.rgbaA(v)
        if a > 0 then
          local r, g, b = pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v)
          local k = y * w + x
          local tr, tg, tb = r, g, b
          if dither == "bayer" then
            local o = (bayer(x, y) - 0.5) * spread
            tr, tg, tb = r + o, g + o, b + o
          elseif dither == "fs" then
            tr, tg, tb = r + (errR[k] or 0), g + (errG[k] or 0), b + (errB[k] or 0)
          end
          local mr, mg, mb = match(tr, tg, tb)
          if dither == "fs" then
            local er, eg, eb = tr - mr, tg - mg, tb - mb
            local function push(dx, dy, f)
              local nx, ny = x + dx, y + dy
              if nx >= 0 and nx < w and ny < h then
                local j = ny * w + nx
                errR[j] = (errR[j] or 0) + er * f; errG[j] = (errG[j] or 0) + eg * f; errB[j] = (errB[j] or 0) + eb * f
              end
            end
            push(1, 0, 7 / 16); push(-1, 1, 3 / 16); push(0, 1, 5 / 16); push(1, 1, 1 / 16)
          end
          if strength < 1 then
            mr = round(r + (mr - r) * strength); mg = round(g + (mg - g) * strength); mb = round(b + (mb - b) * strength)
          end
          if p.binaryAlpha then a = a >= 128 and 255 or 0 end
          local nv = pc.rgba(mr, mg, mb, a)
          if nv ~= v then img:drawPixel(x, y, nv); count = count + 1 end
        end
      end
    end
    return count
  end)
  if p.setPalette then applyPalette(sprite, colors) end
  return { changed = n }
end

-- Split the background from the subject: flood in from the borders through background colors
-- (given, or auto-detected from the border) and move those pixels to their own layer (or delete them).
function edit.separate(ctx, p)
  local sprite = need(ctx)
  local layer = resolveLayer(sprite, p.layer)
  local frame = resolveFrame(sprite, p.frame)
  local cel, img = editableImage(sprite, layer, frame)
  local codec = makeCodec(sprite)
  local w, h = img.width, img.height
  local set, hexes = {}, {}
  if p.colors then
    for _, c in ipairs(p.colors) do set[codec.parse(c)] = true; hexes[#hexes + 1] = c end
  else
    local counts, list, total = {}, {}, 0
    local function count(x, y)
      local v = img:getPixel(x, y)
      if not codec.clear(v) then
        if not counts[v] then counts[v] = 0; list[#list + 1] = v end
        counts[v] = counts[v] + 1; total = total + 1
      end
    end
    for x = 0, w - 1 do count(x, 0); count(x, h - 1) end
    for y = 1, h - 2 do count(0, y); count(w - 1, y) end
    table.sort(list, function(a, b) return counts[a] > counts[b] end)
    local acc = 0
    for i, v in ipairs(list) do
      if i > (p.maxColors or 3) or acc >= total * 0.9 then break end
      set[v] = true; hexes[#hexes + 1] = codec.hex(v); acc = acc + counts[v]
    end
  end
  local mask, n = {}, 0
  if p.contiguous == false then
    for y = 0, h - 1 do for x = 0, w - 1 do
      if set[img:getPixel(x, y)] then mask[y * w + x] = true; n = n + 1 end
    end end
  else
    local stack = {}
    local function seed(x, y) stack[#stack + 1] = x; stack[#stack + 1] = y end
    if p.seeds then for _, sd in ipairs(p.seeds) do seed(sd[1], sd[2]) end
    else
      for x = 0, w - 1 do seed(x, 0); seed(x, h - 1) end
      for y = 0, h - 1 do seed(0, y); seed(w - 1, y) end
    end
    while #stack > 0 do
      local y = table.remove(stack); local x = table.remove(stack)
      local k = y * w + x
      if x >= 0 and y >= 0 and x < w and y < h and not mask[k] and set[img:getPixel(x, y)] then
        mask[k] = true; n = n + 1
        seed(x + 1, y); seed(x - 1, y); seed(x, y + 1); seed(x, y - 1)
      end
    end
  end
  -- small islands fully surrounded by background (stars, specks) belong to the background
  local islands = p.islands or 6
  if islands > 0 then
    local seen = {}
    for y0 = 0, h - 1 do
      for x0 = 0, w - 1 do
        local k0 = y0 * w + x0
        if not mask[k0] and not seen[k0] and not codec.clear(img:getPixel(x0, y0)) then
          local comp, stack, touchesClear = {}, { k0 }, false
          seen[k0] = true
          while #stack > 0 and #comp <= islands do
            local k = table.remove(stack)
            comp[#comp + 1] = k
            local x, y = k % w, k // w
            for _, d in ipairs({ { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) do
              local nx, ny = x + d[1], y + d[2]
              if nx >= 0 and ny >= 0 and nx < w and ny < h then
                local nk = ny * w + nx
                if not mask[nk] and not seen[nk] then
                  if codec.clear(img:getPixel(nx, ny)) then touchesClear = true
                  else seen[nk] = true; stack[#stack + 1] = nk end
                end
              end
            end
          end
          if #comp <= islands and #stack == 0 and not touchesClear then
            for _, k in ipairs(comp) do mask[k] = true; n = n + 1 end
          end
        end
      end
    end
  end
  local bg = p.toLayer ~= false and Image(sprite.spec) or nil
  for k in pairs(mask) do
    local x, y = k % w, k // w
    if bg then bg:drawPixel(x, y, img:getPixel(x, y)) end
    img:drawPixel(x, y, codec.none)
  end
  commit(cel, img)
  if bg and p.fillHole ~= false then
    -- inpaint where the subject was: grow background colors inward (majority of filled neighbors)
    local hole = {}
    for y = 0, h - 1 do for x = 0, w - 1 do
      if not mask[y * w + x] and not codec.clear(img:getPixel(x, y)) then hole[#hole + 1] = y * w + x end
    end end
    local filled = {}
    for k in pairs(mask) do
      local v = bg:getPixel(k % w, k // w)
      if set[v] then filled[k] = v end
    end
    while #hole > 0 do
      local nextHole, updates = {}, {}
      for _, k in ipairs(hole) do
        local x, y = k % w, k // w
        local counts, best, bestN = {}, nil, 0
        for _, d in ipairs({ { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) do
          local nx, ny = x + d[1], y + d[2]
          if nx >= 0 and ny >= 0 and nx < w and ny < h then
            local v = filled[ny * w + nx]
            if v then
              local c = (counts[v] or 0) + 1
              counts[v] = c
              if c > bestN then best, bestN = v, c end
            end
          end
        end
        if best then updates[#updates + 1] = { k, best } else nextHole[#nextHole + 1] = k end
      end
      if #updates == 0 then break end
      for _, u in ipairs(updates) do filled[u[1]] = u[2]; bg:drawPixel(u[1] % w, u[1] // w, u[2]) end
      hole = nextHole
    end
  end
  if bg then
    local bl = sprite:newLayer()
    bl.name = p.toLayer or "background"
    bl.parent = layer.parent
    bl.stackIndex = layer.stackIndex
    sprite:newCel(bl, frame, bg, Point(0, 0))
  end
  return { moved = n, colors = hexes }
end

-- Cut a region (rects and/or a char mask) out of a layer onto its own layer: rig a sprite into parts.
-- backfill grows the remaining pixels n px into the cut so moving parts don't reveal holes.
function edit.split(ctx, p)
  local sprite = need(ctx)
  local layer = resolveLayer(sprite, p.layer)
  local frame = resolveFrame(sprite, p.frame)
  local cel, img = editableImage(sprite, layer, frame)
  local codec = makeCodec(sprite)
  local w, h = img.width, img.height
  local region = {}
  for _, r in ipairs(p.rects or {}) do
    for y = max(0, min(r[2], r[4])), min(h - 1, max(r[2], r[4])) do
      for x = max(0, min(r[1], r[3])), min(w - 1, max(r[1], r[3])) do region[y * w + x] = true end
    end
  end
  if p.rows then
    local ox, oy = p.x or 0, p.y or 0
    for row, line in ipairs(p.rows) do
      for col = 1, #line do
        local ch = line:sub(col, col)
        local x, y = ox + col - 1, oy + row - 1
        if ch ~= "." and ch ~= " " and inb(img, x, y) then region[y * w + x] = true end
      end
    end
  end
  local part = Image(sprite.spec)
  local moved, n = {}, 0
  for k in pairs(region) do
    local x, y = k % w, k // w
    local v = img:getPixel(x, y)
    if not codec.clear(v) then
      part:drawPixel(x, y, v)
      img:drawPixel(x, y, codec.none)
      moved[k] = true; n = n + 1
    end
  end
  for _ = 1, p.backfill or 1 do
    local updates = {}
    for k in pairs(moved) do
      local x, y = k % w, k // w
      if codec.clear(img:getPixel(x, y)) then
        local counts, best, bestN = {}, nil, 0
        for _, d in ipairs({ { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) do
          local nx, ny = x + d[1], y + d[2]
          if inb(img, nx, ny) then
            local v = img:getPixel(nx, ny)
            if not codec.clear(v) then
              local c = (counts[v] or 0) + 1
              counts[v] = c
              if c > bestN then best, bestN = v, c end
            end
          end
        end
        if best and bestN >= (p.backfillMin or 2) then updates[#updates + 1] = { x, y, best } end
      end
    end
    for _, u in ipairs(updates) do img:drawPixel(u[1], u[2], u[3]) end
  end
  commit(cel, img)
  local target
  for _, e in ipairs(allLayers(sprite.layers)) do if e.layer.name == p.toLayer then target = e.layer end end
  if target then
    local tcel, timg = editableImage(sprite, target, frame)
    timg:drawImage(part, Point(0, 0))
    commit(tcel, timg)
  else
    target = sprite:newLayer()
    target.name = p.toLayer or "part"
    target.parent = layer.parent
    target.stackIndex = p.below and layer.stackIndex or layer.stackIndex + 1
    sprite:newCel(target, frame, part, Point(0, 0))
  end
  return { moved = n, layers = layerNames(sprite) }
end

function ops.edit(ctx, p)
  local fn = edit[p.action]
  if not fn then fail("unknown edit action " .. tostring(p.action)) end
  return fn(ctx, p)
end

---------------------------------------------------------------------------
-- palette
---------------------------------------------------------------------------

-- extract: {max, frame?} -> colors from the sprite/image; ramps: [{base, steps, hueShift, contrast}];
-- colors: explicit list. set=true writes the combined list to the sprite palette.
function ops.palette(ctx, p)
  local res = {}
  local combined = {}
  local function add(list) for _, c in ipairs(list) do combined[#combined + 1] = c end end
  if p.colors then add(p.colors) end
  if p.extract then
    local sprite = need(ctx)
    local imgs = {}
    if p.extract.frame then imgs[1] = renderRGB(sprite, resolveFrame(sprite, p.extract.frame))
    else for f = 1, #sprite.frames do imgs[#imgs + 1] = renderRGB(sprite, f) end end
    local list = colorHistogram(imgs)
    res.uniqueColors = #list
    res.extracted = extractPalette(list, p.extract.max or 16)
    add(res.extracted)
  end
  if p.ramps then
    res.ramps = {}
    for _, rp in ipairs(p.ramps) do
      local r, g, b = parseRGBA(rp.base)
      local steps = rp.steps or 5
      local contrast = rp.contrast or 1
      local ramp = {}
      for i = 1, steps do
        local a = steps == 1 and 0 or ((i - 1) / (steps - 1) * 2 - 1) * contrast
        local nr, ng, nb = shiftColor(r, g, b, a * 1.2, rp.hueShift)
        ramp[i] = rgbaHex(nr, ng, nb, 255)
      end
      res.ramps[#res.ramps + 1] = ramp
      add(ramp)
    end
  end
  if p.set then
    local sprite = need(ctx)
    if #combined == 0 then fail("nothing to set: give colors, extract or ramps") end
    applyPalette(sprite, combined)
    ctx.dirty = true
    res.set = #combined
  end
  if not p.extract and not p.ramps and not p.set and ctx.sprite then res.palette = paletteHex(ctx.sprite) end
  return res
end

---------------------------------------------------------------------------
-- read_pixels / preview
---------------------------------------------------------------------------

local GRID_CHARS = "#@%&*+=ox~^ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnpqrstuvwyz0123456789$!?<>/\\|()[]{}:;,'\"-_`"

function ops.read_pixels(ctx, p)
  local sprite = need(ctx)
  local frame = resolveFrame(sprite, p.frame)
  local img = renderRGB(sprite, frame, p.layer and resolveLayer(sprite, p.layer) or nil)
  local x0, y0 = p.x or 0, p.y or 0
  local w = min(p.width or sprite.width, sprite.width - x0)
  local h = min(p.height or sprite.height, sprite.height - y0)
  if w <= 0 or h <= 0 then fail("region is outside the canvas") end
  local legend, byPx, nextChar = {}, {}, 1
  local rows = {}
  for y = y0, y0 + h - 1 do
    local line = {}
    for x = x0, x0 + w - 1 do
      local v = img:getPixel(x, y)
      local ch
      if pc.rgbaA(v) == 0 then ch = "."
      else
        ch = byPx[v]
        if not ch then
          if nextChar > #GRID_CHARS then fail("too many colors for a grid; read a smaller region") end
          ch = GRID_CHARS:sub(nextChar, nextChar)
          nextChar = nextChar + 1
          byPx[v] = ch
          legend[ch] = rgbaHex(pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), pc.rgbaA(v))
        end
      end
      line[#line + 1] = ch
    end
    rows[#rows + 1] = table.concat(line)
  end
  return { x = x0, y = y0, w = w, h = h, rows = rows, legend = legend }
end

-- Scaled RGBA contact sheet: checkerboard behind transparency, pixel grid when zoomed.
-- Rows: tags=true -> one row per tag; tag=name -> that tag; frames="all" -> every frame; else one frame.
function ops.preview(ctx, p)
  local sprite = need(ctx)
  local rows = {}
  local function range(a, b) local r = {} for f = a, b do r[#r + 1] = f end return r end
  if p.tags and #sprite.tags > 0 then
    for _, t in ipairs(sprite.tags) do rows[#rows + 1] = range(t.fromFrame.frameNumber, t.toFrame.frameNumber) end
  elseif p.tag then
    for _, t in ipairs(sprite.tags) do
      if t.name == p.tag then rows[1] = range(t.fromFrame.frameNumber, t.toFrame.frameNumber) end
    end
    if #rows == 0 then fail("tag not found: " .. p.tag) end
  elseif p.frames == "all" or p.tags then
    local cols = p.columns or 8
    for f = 1, #sprite.frames do
      local r = (f - 1) // cols + 1
      rows[r] = rows[r] or {}
      table.insert(rows[r], f)
    end
  else
    rows[1] = { resolveFrame(sprite, p.frame) }
  end
  local W, H = sprite.width, sprite.height
  local maxCols = 0
  for _, r in ipairs(rows) do maxCols = max(maxCols, #r) end
  local s = p.scale
  if not s then
    local maxSize = p.maxSize or 320
    s = max(1, min(32, maxSize // max(W * maxCols, H * #rows)))
  end
  local gap = (maxCols > 1 or #rows > 1) and max(2, s // 2) or 0
  local cw, ch = W * s, H * s
  local out = Image(maxCols * (cw + gap) - gap, #rows * (ch + gap) - gap, ColorMode.RGB)
  out:clear(pc.rgba(40, 40, 48, 255))
  -- checkerboard cell background, built once
  local cb = max(2, s // 2)
  local checker = Image(cw, ch, ColorMode.RGB)
  local c1, c2 = pc.rgba(204, 204, 204, 255), pc.rgba(160, 160, 160, 255)
  for it in checker:pixels() do it(((it.x // cb + it.y // cb) % 2 == 0) and c1 or c2) end
  local grid = s >= 4
  if p.grid ~= nil then grid = p.grid and s >= 3 end
  local layer = p.layer and resolveLayer(sprite, p.layer) or nil
  for ri, r in ipairs(rows) do
    for ci, f in ipairs(r) do
      local ox, oy = (ci - 1) * (cw + gap), (ri - 1) * (ch + gap)
      local img = renderRGB(sprite, f, layer)
      if s > 1 then img:resize { width = cw, height = ch, method = "nearest" } end
      out:drawImage(checker, Point(ox, oy))
      out:drawImage(img, Point(ox, oy), 255, BlendMode.NORMAL)
      if grid then
        for y = 0, ch - 1 do
          local full = y % s == 0
          for x = 0, cw - 1, full and 1 or s do
            local v = out:getPixel(ox + x, oy + y)
            out:drawPixel(ox + x, oy + y,
              pc.rgba(pc.rgbaR(v) * 3 // 4, pc.rgbaG(v) * 3 // 4, pc.rgbaB(v) * 3 // 4, 255))
          end
        end
      end
    end
  end
  out:saveAs(p.output)
  return { w = out.width, h = out.height, scale = s }
end

---------------------------------------------------------------------------
-- layers / frames / resize
---------------------------------------------------------------------------

function ops.layer(ctx, p)
  local sprite = need(ctx)
  local a = p.action
  if a == "add" then
    local layer = p.group and sprite:newGroup() or sprite:newLayer()
    layer.name = p.name or "Layer"
    if p.parent then
      local parent = resolveLayer(sprite, p.parent)
      if not parent.isGroup then fail("parent '" .. p.parent .. "' is not a group") end
      layer.parent = parent
    end
    if p.below then
      local ref = resolveLayer(sprite, p.below)
      layer.parent = ref.parent
      layer.stackIndex = ref.stackIndex
    end
    if p.opacity then layer.opacity = p.opacity end
  else
    local layer = resolveLayer(sprite, p.layer or p.name)
    if a == "delete" then
      sprite:deleteLayer(layer)
    elseif a == "clear" then
      for f = #sprite.frames, 1, -1 do
        if (not p.frame or p.frame == f) and layer:cel(f) then sprite:deleteCel(layer, f) end
      end
    elseif a == "merge_down" then
      app.layer = layer
      app.command.MergeDownLayer()
    else
      if p.rename then layer.name = p.rename end
      if p.visible ~= nil then layer.isVisible = p.visible end
      if p.opacity then layer.opacity = p.opacity end
    end
  end
  return { layers = layerNames(sprite) }
end

function ops.frames(ctx, p)
  local sprite = need(ctx)
  local a = p.action
  if a == "add" then
    local count = p.count or 1
    local at = (p.after or #sprite.frames) + 1
    for i = 0, count - 1 do
      local fr = sprite:newEmptyFrame(at + i)
      if p.copyFrom then
        local src = resolveFrame(sprite, p.copyFrom >= at + i and p.copyFrom + 1 or p.copyFrom)
        sprite.frames[at + i].duration = sprite.frames[src].duration
        for _, e in ipairs(imageLayers(sprite)) do
          local c = e.layer:cel(src)
          if c then sprite:newCel(e.layer, at + i, c.image:clone(), c.position) end
        end
        if p.copyFrom >= at + i then p.copyFrom = p.copyFrom + 1 end
      end
      if p.durationMs then fr.duration = p.durationMs / 1000 end
    end
  elseif a == "delete" then
    local fs = p.frames or {}
    table.sort(fs, function(x, y) return x > y end)
    for _, n in ipairs(fs) do sprite:deleteFrame(resolveFrame(sprite, n)) end
  elseif a == "duration" then
    local fs = p.frames
    if not fs then fs = {}; for i = 1, #sprite.frames do fs[i] = i end end
    for _, n in ipairs(fs) do sprite.frames[resolveFrame(sprite, n)].duration = p.durationMs / 1000 end
  elseif a == "tag" then
    local tag = sprite:newTag(resolveFrame(sprite, p.from), resolveFrame(sprite, p.to))
    tag.name = p.name or "tag"
    if p.direction then tag.aniDir = DIRS[p.direction] or AniDir.FORWARD end
  else
    fail("unknown frames action " .. tostring(a))
  end
  local durs = {}
  for i, f in ipairs(sprite.frames) do durs[i] = round(f.duration * 1000) end
  return { frameMs = durs }
end

function ops.resize(ctx, p)
  local sprite = need(ctx)
  if p.mode == "scale" then
    local w = p.width or round(sprite.width * (p.factor or 1))
    local h = p.height or round(sprite.height * (p.factor or 1))
    app.sprite = sprite
    app.command.SpriteSize { ui = false, width = w, height = h, method = "nearest" }
  else
    local w, h = p.width or sprite.width, p.height or sprite.height
    local an = p.anchor or "center"
    local dx, dy = (w - sprite.width) // 2, (h - sprite.height) // 2
    if an:find("left") then dx = 0 elseif an:find("right") then dx = w - sprite.width end
    if an:find("top") then dy = 0 elseif an:find("bottom") then dy = h - sprite.height end
    sprite:crop(-dx, -dy, w, h)
  end
  return { w = sprite.width, h = sprite.height }
end

-- User code runs with globals `sprite` (may be nil) and `params`; its return value is the result.
function ops.run_lua(ctx, p)
  local chunk, err = load(p.code, "run_lua", "t")
  if not chunk then fail("Lua syntax error: " .. tostring(err)) end
  sprite = ctx.sprite
  params = p.params
  local r = chunk()
  if ctx.sprite == nil and app.sprite then ctx.sprite = app.sprite end
  return r
end

---------------------------------------------------------------------------
-- animate: procedural animation from static (or hand-drawn) frames
---------------------------------------------------------------------------

local function ease(e, f)
  if e == "in" then return f * f end
  if e == "out" then return 1 - (1 - f) * (1 - f) end
  if e == "inout" then return f < 0.5 and 2 * f * f or 1 - (-2 * f + 2) ^ 2 / 2 end
  if e == "step" then return f < 1 and 0 or 1 end
  if e == "back" then local c1 = 1.70158; return 1 + (c1 + 1) * (f - 1) ^ 3 + c1 * (f - 1) ^ 2 end
  return f
end

-- Curve: number | {seq=[...]} (per frame) | {keys=[[t,v,ease?],...], ease?} | {wave, amp, base, phase, cycles}
local function evalCurve(c, t, i)
  if c == nil then return nil end
  local tc = type(c)
  if tc == "number" or tc == "boolean" then return c end
  if c.seq then return c.seq[((i - 1) % #c.seq) + 1] end
  if c.keys then
    local k = c.keys
    if t <= k[1][1] then return k[1][2] end
    for j = 2, #k do
      if t <= k[j][1] then
        local t0, v0, t1, v1 = k[j - 1][1], k[j - 1][2], k[j][1], k[j][2]
        local f = t1 > t0 and (t - t0) / (t1 - t0) or 1
        return v0 + (v1 - v0) * ease(k[j][3] or c.ease or "linear", f)
      end
    end
    return k[#k][2]
  end
  if c.wave then
    local ph = (t * (c.cycles or 1) + (c.phase or 0)) % 1
    local w
    if c.wave == "triangle" then w = ph < 0.25 and 4 * ph or (ph < 0.75 and 2 - 4 * ph or 4 * ph - 4)
    elseif c.wave == "square" then w = ph < 0.5 and 1 or -1
    elseif c.wave == "saw" then w = 2 * ph - 1
    else w = sin(ph * 2 * math.pi) end
    return (c.base or 0) + (c.amp or 1) * w
  end
  fail("invalid curve: " .. json.encode(c))
end

local function layerMatches(tr, name, path)
  local L = tr.layer or "*"
  local m = false
  if L == "*" then m = true
  elseif type(L) ~= "string" then for _, n in ipairs(L) do if n == name or n == path then m = true end end
  else m = (L == name or L == path) end
  if m and tr.exclude then
    for _, n in ipairs(tr.exclude) do if n == name or n == path then return false end end
  end
  return m
end

local function composeTransform(tracks, name, path, t, i, loop)
  local tf = { x = 0, y = 0, sx = 1, sy = 1, sxPx = 0, syPx = 0, rot = 0, shear = 0, waveAmp = 0, waveLen = 8,
    wavePhase = 0, alpha = 1, flash = 0, dissolve = 0, visible = true }
  for _, tr in ipairs(tracks) do
    if layerMatches(tr, name, path) then
      local tt = t + (tr.timeOffset or 0)
      if loop then tt = tt % 1 else tt = clamp(tt, 0, 1) end
      local function ev(k, d) local v = evalCurve(tr[k], tt, i); if v == nil then return d end return v end
      tf.x = tf.x + ev("x", 0)
      tf.y = tf.y + ev("y", 0)
      tf.sx = tf.sx * ev("sx", 1)
      tf.sy = tf.sy * ev("sy", 1)
      tf.sxPx = tf.sxPx + ev("sxPx", 0)
      tf.syPx = tf.syPx + ev("syPx", 0)
      tf.rot = tf.rot + ev("rot", 0)
      tf.shear = tf.shear + ev("shear", 0)
      if tr.waveAmp then
        tf.waveAmp = tf.waveAmp + ev("waveAmp", 0)
        tf.waveLen = tr.waveLen or tf.waveLen
        tf.wavePhase = tt * (tr.waveSpeed or 1)
      end
      tf.alpha = tf.alpha * ev("alpha", 1)
      local fl = ev("flash", 0)
      if fl > tf.flash then tf.flash = fl; tf.flashColor = tr.flashColor end
      tf.dissolve = max(tf.dissolve, ev("dissolve", 0))
      local vis = ev("visible", true)
      if vis == false or (type(vis) == "number" and vis < 0.5) then tf.visible = false end
      if tr.cycle then tf.cycle = tr.cycle; tf.cycleShift = (i - 1) * (tr.cycleStep or 1) end
      if tr.pivot then tf.pivot = tr.pivot end
      if tr.smooth ~= nil then tf.smooth = tr.smooth end
    end
  end
  return tf
end

-- Scale2x x3 (8x) upsample of a region: RotSprite-style smooth rotation for pixel art.
local function upsample8(img, bbox, clearV, isClear)
  local x0, y0 = bbox.x - 1, bbox.y - 1
  local w, h = bbox.width + 2, bbox.height + 2
  local src = {}
  for y = 0, h - 1 do
    for x = 0, w - 1 do
      local ix, iy = x0 + x, y0 + y
      local v = clearV
      if inb(img, ix, iy) then v = img:getPixel(ix, iy); if isClear(v) then v = clearV end end
      src[y * w + x + 1] = v
    end
  end
  for _ = 1, 3 do
    local dst, W2 = {}, w * 2
    for y = 0, h - 1 do
      for x = 0, w - 1 do
        local i = y * w + x + 1
        local P = src[i]
        local A = y > 0 and src[i - w] or clearV
        local B = x < w - 1 and src[i + 1] or clearV
        local C = x > 0 and src[i - 1] or clearV
        local D = y < h - 1 and src[i + w] or clearV
        local E0, E1, E2, E3 = P, P, P, P
        if C == A and C ~= D and A ~= B then E0 = A end
        if A == B and A ~= C and B ~= D then E1 = B end
        if D == C and D ~= B and C ~= A then E2 = C end
        if B == D and B ~= A and D ~= C then E3 = D end
        local o = 2 * y * W2 + 2 * x + 1
        dst[o] = E0; dst[o + 1] = E1; dst[o + W2] = E2; dst[o + W2 + 1] = E3
      end
    end
    src, w, h = dst, w * 2, h * 2
  end
  return { data = src, x0 = x0, y0 = y0, w = w, h = h }
end

local function renderLayer(rest, tf, pivot, content, sprite, codec)
  if not tf.visible or not rest.bbox then return nil end
  local W, H = sprite.width, sprite.height
  local sx = tf.sx * (1 + tf.sxPx / content.width)
  local sy = tf.sy * (1 + tf.syPx / content.height)
  if abs(sx) < 1e-3 or abs(sy) < 1e-3 then return nil end
  local tx, ty = round(tf.x), round(tf.y)
  local px, py = pivot[1], pivot[2]
  if tf.pivot then px, py = tf.pivot[1], tf.pivot[2] end
  local out = Image(sprite.spec)
  local bb = rest.bbox
  if sx == 1 and sy == 1 and tf.rot == 0 and tf.shear == 0 and tf.waveAmp == 0 then
    out:drawImage(rest.img, Point(tx, ty))
  else
    local rad = math.rad(tf.rot)
    local cs, sn = cos(rad), sin(rad)
    -- destination bounds: forward-transform the source bbox corners
    local x0, y0, x1, y1 = math.huge, math.huge, -math.huge, -math.huge
    for _, c in ipairs({ { bb.x, bb.y }, { bb.x + bb.width, bb.y }, { bb.x, bb.y + bb.height },
      { bb.x + bb.width, bb.y + bb.height } }) do
      local vx, vy = (c[1] - px) * sx, (c[2] - py) * sy
      vx = vx + tf.shear * vy
      local rx, ry = vx * cs - vy * sn, vx * sn + vy * cs
      x0 = min(x0, rx); x1 = max(x1, rx); y0 = min(y0, ry); y1 = max(y1, ry)
    end
    local m = math.ceil(abs(tf.waveAmp)) + 1
    x0 = max(0, floor(px + tx + x0) - m); x1 = min(W - 1, math.ceil(px + tx + x1) + m)
    y0 = max(0, floor(py + ty + y0) - 1); y1 = min(H - 1, math.ceil(py + ty + y1) + 1)
    local up
    if tf.rot % 90 ~= 0 and tf.smooth ~= false then
      rest.up = rest.up or upsample8(rest.img, bb, codec.none, codec.clear)
      up = rest.up
    end
    local img = rest.img
    local bx0, by0, bx1, by1 = bb.x, bb.y, bb.x + bb.width - 1, bb.y + bb.height - 1
    for dy = y0, y1 do
      local wv = tf.waveAmp ~= 0 and round(tf.waveAmp * sin(2 * math.pi * (dy / tf.waveLen + tf.wavePhase))) or 0
      for dx = x0, x1 do
        local vx = dx + 0.5 - px - tx - wv
        local vy = dy + 0.5 - py - ty
        if tf.rot ~= 0 then vx, vy = vx * cs + vy * sn, -vx * sn + vy * cs end
        vx = vx - tf.shear * vy
        local fx, fy = px + vx / sx, py + vy / sy
        local v
        if up then
          local ux, uy = floor((fx - up.x0) * 8), floor((fy - up.y0) * 8)
          if ux >= 0 and uy >= 0 and ux < up.w and uy < up.h then v = up.data[uy * up.w + ux + 1] end
        else
          local ix, iy = floor(fx), floor(fy)
          if ix >= bx0 and iy >= by0 and ix <= bx1 and iy <= by1 then v = img:getPixel(ix, iy) end
        end
        if v and not codec.clear(v) then out:drawPixel(dx, dy, v) end
      end
    end
  end
  -- per-pixel effects
  local alphaAsDither = not codec.rgb and tf.alpha < 1
  if tf.cycle or tf.flash > 0 or tf.alpha < 1 or tf.dissolve > 0 then
    local cmap
    if tf.cycle then
      cmap = {}
      local n = #tf.cycle
      for j, c in ipairs(tf.cycle) do
        cmap[codec.parse(c)] = codec.parse(tf.cycle[((j - 1 + tf.cycleShift) % n) + 1])
      end
    end
    local fr, fg, fb = 255, 255, 255
    if tf.flashColor then fr, fg, fb = parseRGBA(tf.flashColor) end
    local d = max(tf.dissolve, alphaAsDither and (1 - tf.alpha) or 0)
    for it in out:pixels() do
      local v = it()
      if not codec.clear(v) then
        if d > 0 and bayer(it.x, it.y) < d then
          it(codec.none)
        else
          if cmap then v = cmap[v] or v end
          if tf.flash > 0 or (codec.rgb and tf.alpha < 1) then
            local r, g, b, a = codec.dec(v)
            local f = tf.flash
            if not codec.rgb then f = f >= 0.5 and 1 or 0 end
            r, g, b = round(r + (fr - r) * f), round(g + (fg - g) * f), round(b + (fb - b) * f)
            if codec.rgb then a = round(a * tf.alpha) end
            v = codec.enc(r, g, b, a)
          end
          it(v)
        end
      end
    end
  end
  return out
end

local function resolvePivot(pv, content, pad)
  local cx = content.x + content.width / 2
  if pv ~= nil and type(pv) ~= "string" then return { pv[1] + pad[1], pv[2] + pad[2] } end
  if pv == "center" then return { cx, content.y + content.height / 2 } end
  if pv == "top" then return { cx, content.y } end
  return { cx, content.y + content.height }
end

-- p: { output, padding, animations = [{ name, frames, durationMs, durations, loop, direction,
--      sourceFrames | sourceTag | sourceFrame, pivot, tracks = [...] }] }
function ops.animate(ctx, p)
  local sprite = need(ctx)
  local pad = p.padding or 0
  if type(pad) == "number" then pad = { pad, pad, pad, pad } end
  local pl, pt, pr, pb = pad[1] or 0, pad[2] or 0, pad[3] or 0, pad[4] or 0
  if pl + pt + pr + pb > 0 then sprite:crop(-pl, -pt, sprite.width + pl + pr, sprite.height + pt + pb) end
  local codec = makeCodec(sprite)
  local layers = imageLayers(sprite)
  local N0 = #sprite.frames
  local srcTags = {}
  for _, t in ipairs(sprite.tags) do srcTags[t.name] = { t.fromFrame.frameNumber, t.toFrame.frameNumber } end
  for i = #sprite.tags, 1, -1 do sprite:deleteTag(sprite.tags[i]) end

  local restCache = {}
  local function rest(li, f)
    local key = li * 100000 + f
    local r = restCache[key]
    if not r then
      local img = Image(sprite.spec)
      local cel = layers[li].layer:cel(f)
      if cel then img:drawImage(cel.image, cel.position) end
      local bb = img:shrinkBounds()
      r = { img = img, bbox = (bb.width > 0 and bb.height > 0) and bb or nil }
      restCache[key] = r
    end
    return r
  end

  local summary, pendingTags = {}, {}
  for ai, anim in ipairs(p.animations or {}) do
    local name = anim.name or ("anim" .. ai)
    local src = anim.sourceFrames
    if not src and anim.sourceTag then
      local t = srcTags[anim.sourceTag] or fail("source tag not found: " .. anim.sourceTag)
      src = {}
      for f = t[1], t[2] do src[#src + 1] = f end
    end
    src = src or { anim.sourceFrame or 1 }
    for _, f in ipairs(src) do
      if f < 1 or f > N0 then fail(name .. ": source frame " .. f .. " out of range (1.." .. N0 .. ")") end
    end
    local n = anim.frames or (#src > 1 and #src or 8)
    local loop = anim.loop ~= false
    -- content bounds (union over layers and source frames) for pivots and px-based scaling
    local cb
    for li = 1, #layers do
      for _, f in ipairs(src) do
        local bb = rest(li, f).bbox
        if bb then cb = cb and cb:union(bb) or Rectangle(bb) end
      end
    end
    cb = cb or Rectangle(0, 0, sprite.width, sprite.height)
    local pivot = resolvePivot(anim.pivot, cb, { pl, pt })
    local tracks = anim.tracks or {}
    for _, tr in ipairs(tracks) do
      if tr.pivot then tr.pivot = resolvePivot(tr.pivot, cb, { pl, pt }) end
    end
    local first = #sprite.frames + 1
    for i = 1, n do
      local fr = sprite:newEmptyFrame(#sprite.frames + 1)
      local dur = anim.durations and anim.durations[((i - 1) % #anim.durations) + 1] or anim.durationMs or 100
      fr.duration = dur / 1000
      local t = loop and (i - 1) / n or (n > 1 and (i - 1) / (n - 1) or 0)
      local sf = src[((i - 1) % #src) + 1]
      for li, e in ipairs(layers) do
        local tf = composeTransform(tracks, e.layer.name, e.path, t, i, loop)
        local img = renderLayer(rest(li, sf), tf, pivot, cb, sprite, codec)
        if img and not img:isEmpty() then
          -- store trimmed cels: smaller files, faster saves and exports
          local bb = img:shrinkBounds()
          sprite:newCel(e.layer, fr, Image(img, bb), Point(bb.x, bb.y))
        end
      end
    end
    -- tags are created at the end: appending frames would otherwise grow the previous tag
    pendingTags[#pendingTags + 1] = { first - N0, #sprite.frames - N0, name, anim.direction, loop }
    summary[#summary + 1] = name .. " " .. (first - N0) .. "-" .. (#sprite.frames - N0)
  end
  for _ = 1, N0 do sprite:deleteFrame(sprite.frames[1]) end
  for _, t in ipairs(pendingTags) do
    local tag = sprite:newTag(t[1], t[2])
    tag.name = t[3]
    if t[4] then tag.aniDir = DIRS[t[4]] or AniDir.FORWARD end
    if not t[5] then pcall(function() tag.repeats = 1 end) end
  end
  if p.output then ctx.path = p.output end
  return { size = sprite.width .. "x" .. sprite.height, tags = summary }
end

---------------------------------------------------------------------------
-- Runner
---------------------------------------------------------------------------

local READ_ONLY = { sprite_info = true, read_pixels = true, preview = true, palette = true }

-- Opens the sprite once, runs every step, saves once if anything changed.
-- A failing step aborts the request and nothing is saved.
local function run(req)
  local ctx = { path = req.path }
  local steps = req.steps or {}
  if #steps == 0 then fail("no steps") end
  if ctx.path and steps[1].op ~= "create_sprite" and app.fs.isFile(ctx.path) then
    ctx.sprite = openSprite(ctx.path)
    ctx.opened = ctx.path
  elseif ctx.path and steps[1].op ~= "create_sprite" and steps[1].op ~= "run_lua" and steps[1].op ~= "palette" then
    fail("file not found: " .. ctx.path)
  end
  local results, dirty = {}, false
  for i, step in ipairs(steps) do
    local fn = ops[step.op]
    if not fn then fail("step " .. i .. ": unknown op " .. tostring(step.op)) end
    local ok, r = pcall(fn, ctx, step)
    if not ok then
      local msg = type(r) == "table" and r.message or tostring(r)
      fail(#steps > 1 and ("step " .. i .. " (" .. step.op .. "): " .. msg) or msg)
    end
    results[i] = r == nil and true or r
    if not READ_ONLY[step.op] and not (step.op == "run_lua" and step.save == false) then dirty = true end
  end
  if (dirty or ctx.dirty) and ctx.sprite then
    if not ctx.path then fail("missing 'path' to save to") end
    local ext = app.fs.fileExtension(ctx.path):lower()
    if ctx.opened == ctx.path and ext ~= "aseprite" and ext ~= "ase" and not req.allowImageWrites then
      fail("refusing to overwrite image " .. ctx.path .. " (import it with create_sprite from=... into an .aseprite file," ..
        " edit that, then export; or set ASEPRITE_MCP_ALLOW_IMAGE_WRITES=1)")
    end
    ctx.sprite:saveAs(ctx.path)
  end
  return results
end

local function respond(id, ok, res)
  local out = { id = id, ok = ok }
  if ok then out.results = res else out.error = type(res) == "table" and res.message or tostring(res) end
  print(MARKER .. json.encode(out))
  io.stdout:flush()
end

local function closeAll()
  while #app.sprites > 0 do app.sprites[1]:close() end
end

if app.params["worker"] then
  while true do
    local line = io.read("l")
    if not line or line == "" then break end
    local id
    local ok, res = pcall(function()
      local req = json.decode(line)
      id = req.id
      return run(req)
    end)
    pcall(closeAll)
    respond(id, ok, res)
  end
else
  local ok, res = pcall(function() return run(json.decode(readFile(app.params["params"]))) end)
  respond(nil, ok, res)
end
