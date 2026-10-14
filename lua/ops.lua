-- Aseprite MCP operations.
-- Invoked as: aseprite -b --script-param op=<name> --script-param params=<json file> --script ops.lua
-- Prints a single line "__MCP_RESULT__<json>" to stdout.

local MARKER = "__MCP_RESULT__"

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

local function fail(msg)
  error({ mcp = true, message = msg }, 0)
end

local function readParams()
  local p = app.params["params"]
  if not p then return {} end
  local f = io.open(p, "r")
  if not f then fail("cannot open params file " .. p) end
  local text = f:read("a")
  f:close()
  return json.decode(text) or {}
end

local function hex2(n) return string.format("%02x", n) end

local function parseColor(s)
  if s == nil then fail("missing color") end
  if type(s) ~= "string" then fail("color must be a string like #rrggbb") end
  local str = s:lower():gsub("^%s+", ""):gsub("%s+$", "")
  if str == "transparent" or str == "none" or str == "clear" then
    return Color { r = 0, g = 0, b = 0, a = 0 }
  end
  str = str:gsub("^#", "")
  if #str == 3 or #str == 4 then
    str = str:gsub(".", "%0%0")
  end
  if not str:match("^%x+$") or (#str ~= 6 and #str ~= 8) then
    fail("invalid color '" .. s .. "' (use #rgb, #rrggbb, #rrggbbaa or 'transparent')")
  end
  local r = tonumber(str:sub(1, 2), 16)
  local g = tonumber(str:sub(3, 4), 16)
  local b = tonumber(str:sub(5, 6), 16)
  local a = #str == 8 and tonumber(str:sub(7, 8), 16) or 255
  return Color { r = r, g = g, b = b, a = a }
end

local function colorToHex(c)
  if c.alpha == 0 then return "transparent" end
  local h = "#" .. hex2(c.red) .. hex2(c.green) .. hex2(c.blue)
  if c.alpha < 255 then h = h .. hex2(c.alpha) end
  return h
end

local function nearestIndex(sprite, c)
  local pal = sprite.palettes[1]
  local best, bestD = 0, math.huge
  for i = 0, #pal - 1 do
    if i ~= sprite.transparentColor then
      local pc = pal:getColor(i)
      local dr, dg, db = pc.red - c.red, pc.green - c.green, pc.blue - c.blue
      local d = dr * dr + dg * dg + db * db
      if d < bestD then best, bestD = i, d end
      if d == 0 then break end
    end
  end
  return best
end

-- Color -> raw pixel value for the sprite's color mode.
local function toPixel(sprite, c)
  local mode = sprite.colorMode
  if mode == ColorMode.RGB then
    return app.pixelColor.rgba(c.red, c.green, c.blue, c.alpha)
  elseif mode == ColorMode.GRAY then
    local v = math.floor(0.299 * c.red + 0.587 * c.green + 0.114 * c.blue + 0.5)
    return app.pixelColor.graya(v, c.alpha)
  else
    if c.alpha == 0 then return sprite.transparentColor end
    return nearestIndex(sprite, c)
  end
end

-- Raw pixel value -> r,g,b,a for the sprite's color mode.
local function pixelRGBA(sprite, px, mode)
  mode = mode or sprite.colorMode
  local pc = app.pixelColor
  if mode == ColorMode.RGB then
    return pc.rgbaR(px), pc.rgbaG(px), pc.rgbaB(px), pc.rgbaA(px)
  elseif mode == ColorMode.GRAY then
    local v = pc.grayaV(px)
    return v, v, v, pc.grayaA(px)
  else
    if px == sprite.transparentColor then return 0, 0, 0, 0 end
    local pal = sprite.palettes[1]
    if px >= #pal then return 0, 0, 0, 0 end
    local c = pal:getColor(px)
    return c.red, c.green, c.blue, c.alpha
  end
end

local function rgbaHex(r, g, b, a)
  if a == 0 then return "transparent" end
  local h = "#" .. hex2(r) .. hex2(g) .. hex2(b)
  if a < 255 then h = h .. hex2(a) end
  return h
end

local function openSprite(path)
  if not path then fail("missing 'path'") end
  if not app.fs.isFile(path) then fail("file not found: " .. path) end
  local sprite = app.open(path)
  if not sprite then fail("could not open " .. path) end
  return sprite
end

local function allLayers(layers, out, prefix)
  out = out or {}
  for _, l in ipairs(layers) do
    local name = prefix and (prefix .. "/" .. l.name) or l.name
    table.insert(out, { layer = l, path = name })
    if l.isGroup then allLayers(l.layers, out, name) end
  end
  return out
end

-- Layer by name (or "Group/Child" path) or 1-based index among top-level layers.
-- Default: top-most image layer.
local function resolveLayer(sprite, ref)
  if ref == nil then
    for i = #sprite.layers, 1, -1 do
      local l = sprite.layers[i]
      if l.isImage then return l end
    end
    fail("sprite has no image layers")
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
    fail("frame " .. n .. " out of range (sprite has " .. #sprite.frames .. " frames, 1-based)")
  end
  return n
end

-- Returns cel and a full-canvas clone of its image to draw on.
local function editableImage(sprite, layer, frame)
  if not layer.isImage then fail("layer '" .. layer.name .. "' is not an image layer") end
  if layer.isTilemap then fail("tilemap layers are not supported") end
  local cel = layer:cel(frame)
  local img = Image(sprite.spec)
  if cel then
    img:drawImage(cel.image, cel.position)
  else
    cel = sprite:newCel(layer, frame, Image(sprite.spec), Point(0, 0))
  end
  return cel, img
end

local function commit(cel, img)
  cel.image = img
  cel.position = Point(0, 0)
end

local function inBounds(img, x, y)
  return x >= 0 and y >= 0 and x < img.width and y < img.height
end

local function put(img, x, y, px)
  if inBounds(img, x, y) then img:drawPixel(x, y, px) end
end

-- Composite of all visible layers for a frame, as a table of {r,g,b,a} rows.
local function compositeRGBA(sprite, frame)
  local img = Image(sprite.spec)
  img:drawSprite(sprite, frame)
  return img, sprite.colorMode
end

local function layerRGBA(sprite, layer, frame)
  local img = Image(sprite.spec)
  local cel = layer:cel(frame)
  if cel then img:drawImage(cel.image, cel.position) end
  return img, sprite.colorMode
end

local function plotLine(x0, y0, x1, y1, fn)
  local dx, dy = math.abs(x1 - x0), -math.abs(y1 - y0)
  local sx = x0 < x1 and 1 or -1
  local sy = y0 < y1 and 1 or -1
  local err = dx + dy
  while true do
    fn(x0, y0)
    if x0 == x1 and y0 == y1 then break end
    local e2 = 2 * err
    if e2 >= dy then err = err + dy; x0 = x0 + sx end
    if e2 <= dx then err = err + dx; y0 = y0 + sy end
  end
end

-- Pixel-perfect ellipse inside the bounding box [x0,x1]x[y0,y1].
local function plotEllipse(x0, y0, x1, y1, filled, fn)
  if x0 > x1 then x0, x1 = x1, x0 end
  if y0 > y1 then y0, y1 = y1, y0 end
  local cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
  local rx, ry = (x1 - x0 + 1) / 2, (y1 - y0 + 1) / 2
  local inside = {}
  for y = y0, y1 do
    inside[y] = {}
    for x = x0, x1 do
      local nx, ny = (x + 0.5 - (cx + 0.5)) / rx, (y + 0.5 - (cy + 0.5)) / ry
      inside[y][x] = (nx * nx + ny * ny) <= 1.0
    end
  end
  for y = y0, y1 do
    for x = x0, x1 do
      if inside[y][x] then
        if filled then
          fn(x, y)
        else
          local edge = not (inside[y][x - 1] and inside[y][x + 1]
            and inside[y - 1] and inside[y - 1][x]
            and inside[y + 1] and inside[y + 1][x])
          if edge then fn(x, y) end
        end
      end
    end
  end
end

local function layerInfo(sprite)
  local out = {}
  for _, e in ipairs(allLayers(sprite.layers)) do
    local l = e.layer
    table.insert(out, {
      name = e.path,
      type = l.isGroup and "group" or (l.isTilemap and "tilemap" or "image"),
      visible = l.isVisible,
      opacity = l.opacity,
      blendMode = l.blendMode,
      isBackground = l.isBackground,
    })
  end
  return out
end

local function layerNames(sprite)
  local out = {}
  for _, e in ipairs(allLayers(sprite.layers)) do table.insert(out, e.path) end
  return out
end

local function paletteHex(sprite)
  local pal = sprite.palettes[1]
  local out = {}
  for i = 0, #pal - 1 do table.insert(out, colorToHex(pal:getColor(i))) end
  return out
end

local function applyPalette(sprite, colors)
  local pal = Palette(#colors)
  for i, h in ipairs(colors) do pal:setColor(i - 1, parseColor(h)) end
  sprite:setPalette(pal)
end

local function modeName(m)
  if m == ColorMode.RGB then return "rgb" end
  if m == ColorMode.GRAY then return "grayscale" end
  if m == ColorMode.INDEXED then return "indexed" end
  return "tilemap"
end

local function info(sprite, withPalette)
  local frames = {}
  for i, f in ipairs(sprite.frames) do
    table.insert(frames, { frame = i, durationMs = math.floor(f.duration * 1000 + 0.5) })
  end
  local tags = {}
  for _, t in ipairs(sprite.tags) do
    table.insert(tags, {
      name = t.name, from = t.fromFrame.frameNumber, to = t.toFrame.frameNumber,
      direction = tostring(t.aniDir),
    })
  end
  return {
    path = sprite.filename,
    width = sprite.width,
    height = sprite.height,
    colorMode = modeName(sprite.colorMode),
    layers = layerInfo(sprite),
    frames = frames,
    tags = tags,
    paletteSize = #sprite.palettes[1],
    palette = withPalette and paletteHex(sprite) or nil,
  }
end

---------------------------------------------------------------------------
-- Operations
---------------------------------------------------------------------------

local ops = {}

function ops.create_sprite(ctx, p)
  if app.fs.isFile(ctx.path) and not p.overwrite then
    fail("file already exists: " .. ctx.path .. " (pass overwrite=true to replace)")
  end
  local mode = ColorMode.RGB
  if p.colorMode == "indexed" then mode = ColorMode.INDEXED
  elseif p.colorMode == "grayscale" then mode = ColorMode.GRAY end
  local sprite = Sprite(p.width, p.height, mode)
  if p.palette and #p.palette > 0 then applyPalette(sprite, p.palette) end
  local layer = sprite.layers[1]
  layer.name = p.layerName or "Layer 1"
  if p.background and p.background ~= "transparent" then
    local img = Image(sprite.spec)
    img:clear(toPixel(sprite, parseColor(p.background)))
    sprite:newCel(layer, 1, img, Point(0, 0))
  end
  app.fs.makeAllDirectories(app.fs.filePath(ctx.path))
  ctx.sprite = sprite
  return { width = sprite.width, height = sprite.height }
end

function ops.sprite_info(ctx, p)
  return info(ctx.sprite, p.palette)
end

function ops.draw_pixels(ctx, p)
  local sprite = ctx.sprite
  local layer = resolveLayer(sprite, p.layer)
  local frame = resolveFrame(sprite, p.frame)
  local cel, img = editableImage(sprite, layer, frame)
  local cache = {}
  local n = 0
  for _, px in ipairs(p.pixels or {}) do
    local x, y, key = px[1], px[2], px[3]
    local v = cache[key]
    if v == nil then v = toPixel(sprite, parseColor(key)); cache[key] = v end
    if inBounds(img, x, y) then
      img:drawPixel(x, y, v); n = n + 1
    end
  end
  commit(cel, img)
  return { drawn = n, skippedOutOfBounds = #(p.pixels or {}) - n }
end

function ops.draw_grid(ctx, p)
  local sprite = ctx.sprite
  local layer = resolveLayer(sprite, p.layer)
  local frame = resolveFrame(sprite, p.frame)
  local cel, img = editableImage(sprite, layer, frame)
  local skip = p.skipChar or "."
  local legend = {}
  for ch, col in pairs(p.legend or {}) do
    if #ch ~= 1 then fail("legend keys must be single characters, got '" .. ch .. "'") end
    legend[ch] = toPixel(sprite, parseColor(col))
  end
  local ox, oy = p.x or 0, p.y or 0
  local n = 0
  for row, line in ipairs(p.rows or {}) do
    for col = 1, #line do
      local ch = line:sub(col, col)
      if ch ~= skip and ch ~= " " then
        local v = legend[ch]
        if v == nil then
          fail(string.format("character '%s' at row %d col %d is not in the legend", ch, row, col))
        end
        local x, y = ox + col - 1, oy + row - 1
        if inBounds(img, x, y) then img:drawPixel(x, y, v); n = n + 1 end
      end
    end
  end
  commit(cel, img)
  return { drawn = n }
end

function ops.draw_shape(ctx, p)
  local sprite = ctx.sprite
  local layer = resolveLayer(sprite, p.layer)
  local frame = resolveFrame(sprite, p.frame)
  local cel, img = editableImage(sprite, layer, frame)
  local v = toPixel(sprite, parseColor(p.color))
  local fillV = p.fillColor and toPixel(sprite, parseColor(p.fillColor)) or v
  local x0, y0, x1, y1 = p.x1, p.y1, p.x2, p.y2
  local plot = function(x, y) put(img, x, y, v) end
  if p.shape == "line" then
    plotLine(x0, y0, x1, y1, plot)
  elseif p.shape == "rectangle" then
    if x0 > x1 then x0, x1 = x1, x0 end
    if y0 > y1 then y0, y1 = y1, y0 end
    for y = y0, y1 do
      for x = x0, x1 do
        local edge = x == x0 or x == x1 or y == y0 or y == y1
        if edge then put(img, x, y, v) elseif p.filled then put(img, x, y, fillV) end
      end
    end
  elseif p.shape == "ellipse" then
    if p.filled then plotEllipse(x0, y0, x1, y1, true, function(x, y) put(img, x, y, fillV) end) end
    plotEllipse(x0, y0, x1, y1, false, plot)
  else
    fail("unknown shape " .. tostring(p.shape))
  end
  commit(cel, img)
  return { ok = true }
end

function ops.fill(ctx, p)
  local sprite = ctx.sprite
  local layer = resolveLayer(sprite, p.layer)
  local frame = resolveFrame(sprite, p.frame)
  local cel, img = editableImage(sprite, layer, frame)
  if not inBounds(img, p.x, p.y) then fail("start point out of bounds") end
  local v = toPixel(sprite, parseColor(p.color))
  local target = img:getPixel(p.x, p.y)
  local n = 0
  if p.contiguous == false then
    for it in img:pixels() do
      if it() == target then it(v); n = n + 1 end
    end
  elseif target ~= v then
    local w, h = img.width, img.height
    local stack = { p.x, p.y }
    local seen = {}
    while #stack > 0 do
      local y = table.remove(stack); local x = table.remove(stack)
      local k = y * w + x
      if not seen[k] and x >= 0 and y >= 0 and x < w and y < h and img:getPixel(x, y) == target then
        seen[k] = true
        img:drawPixel(x, y, v); n = n + 1
        stack[#stack + 1] = x + 1; stack[#stack + 1] = y
        stack[#stack + 1] = x - 1; stack[#stack + 1] = y
        stack[#stack + 1] = x;     stack[#stack + 1] = y + 1
        stack[#stack + 1] = x;     stack[#stack + 1] = y - 1
      end
    end
  end
  commit(cel, img)
  return { filled = n }
end

function ops.replace_color(ctx, p)
  local sprite = ctx.sprite
  local from = toPixel(sprite, parseColor(p.from))
  local to = toPixel(sprite, parseColor(p.to))
  local layers = {}
  if p.layer then layers = { resolveLayer(sprite, p.layer) }
  else
    for _, e in ipairs(allLayers(sprite.layers)) do
      if e.layer.isImage and not e.layer.isTilemap then table.insert(layers, e.layer) end
    end
  end
  local frames = {}
  if p.frame then frames = { resolveFrame(sprite, p.frame) }
  else for i = 1, #sprite.frames do table.insert(frames, i) end end
  local n = 0
  for _, l in ipairs(layers) do
    for _, f in ipairs(frames) do
      local cel = l:cel(f)
      if cel then
        local img = cel.image:clone()
        for it in img:pixels() do
          if it() == from then it(to); n = n + 1 end
        end
        cel.image = img
      end
    end
  end
  return { replaced = n }
end

function ops.mirror(ctx, p)
  local sprite = ctx.sprite
  local layer = resolveLayer(sprite, p.layer)
  local frame = resolveFrame(sprite, p.frame)
  local cel, img = editableImage(sprite, layer, frame)
  local w, h = img.width, img.height
  local src = Image(img)
  if p.mode == "flip_horizontal" or p.mode == "flip_vertical" then
    for y = 0, h - 1 do
      for x = 0, w - 1 do
        local sx = p.mode == "flip_horizontal" and (w - 1 - x) or x
        local sy = p.mode == "flip_vertical" and (h - 1 - y) or y
        img:drawPixel(x, y, src:getPixel(sx, sy))
      end
    end
  else
    for y = 0, h - 1 do
      for x = 0, w - 1 do
        local mx, my = w - 1 - x, h - 1 - y
        if p.mode == "left_to_right" and x >= math.ceil(w / 2) then
          img:drawPixel(x, y, src:getPixel(mx, y))
        elseif p.mode == "right_to_left" and x < math.floor(w / 2) then
          img:drawPixel(x, y, src:getPixel(mx, y))
        elseif p.mode == "top_to_bottom" and y >= math.ceil(h / 2) then
          img:drawPixel(x, y, src:getPixel(x, my))
        elseif p.mode == "bottom_to_top" and y < math.floor(h / 2) then
          img:drawPixel(x, y, src:getPixel(x, my))
        end
      end
    end
  end
  commit(cel, img)
  return { ok = true }
end

local GRID_CHARS = "#@%&*+=ox~^ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnpqrstuvwyz0123456789$!?<>/\\|()[]{}:;,'\"-_`"

function ops.read_pixels(ctx, p)
  local sprite = ctx.sprite
  local frame = resolveFrame(sprite, p.frame)
  local img, mode
  if p.layer then img, mode = layerRGBA(sprite, resolveLayer(sprite, p.layer), frame)
  else img, mode = compositeRGBA(sprite, frame) end
  local x0, y0 = p.x or 0, p.y or 0
  local w = math.min(p.width or sprite.width, sprite.width - x0)
  local h = math.min(p.height or sprite.height, sprite.height - y0)
  if w <= 0 or h <= 0 then fail("region is outside the canvas") end
  local legend, byHex, nextChar = {}, {}, 1
  local rows = {}
  for y = y0, y0 + h - 1 do
    local line = {}
    for x = x0, x0 + w - 1 do
      local hex = rgbaHex(pixelRGBA(sprite, img:getPixel(x, y), mode))
      local ch
      if hex == "transparent" then ch = "."
      else
        ch = byHex[hex]
        if not ch then
          if nextChar > #GRID_CHARS then
            fail("too many distinct colors to encode as a grid; read a smaller region")
          end
          ch = GRID_CHARS:sub(nextChar, nextChar)
          nextChar = nextChar + 1
          byHex[hex] = ch
          legend[ch] = hex
        end
      end
      table.insert(line, ch)
    end
    table.insert(rows, table.concat(line))
  end
  return { x = x0, y = y0, width = w, height = h, rows = rows, legend = legend, transparent = "." }
end

-- Renders a scaled RGBA preview (with checkerboard + optional grid) to p.output.
function ops.preview(ctx, p)
  local sprite = ctx.sprite
  local frames = {}
  if p.frames == "all" then
    for i = 1, #sprite.frames do table.insert(frames, i) end
  else
    table.insert(frames, resolveFrame(sprite, p.frame))
  end
  local layer = p.layer and resolveLayer(sprite, p.layer) or nil
  local W, H = sprite.width, sprite.height
  local s = p.scale
  if not s then
    local maxSize = p.maxSize or 320
    s = math.max(1, math.min(32, maxSize // math.max(W * #frames, H)))
  end
  local gap = #frames > 1 and math.max(2, s) or 0
  local outW = #frames * W * s + (#frames - 1) * gap
  local out = Image(outW, H * s, ColorMode.RGB)
  out:clear(app.pixelColor.rgba(40, 40, 48, 255))
  local pc = app.pixelColor
  local c1, c2 = { 204, 204, 204 }, { 160, 160, 160 }
  local cb = math.max(1, math.floor(s / 2))
  local grid = s >= 4
  if p.grid ~= nil then grid = p.grid and s >= 3 end
  local gridC = { 0, 0, 0 }
  for fi, f in ipairs(frames) do
    local img, mode
    if layer then img, mode = layerRGBA(sprite, layer, f)
    else img, mode = compositeRGBA(sprite, f) end
    local offX = (fi - 1) * (W * s + gap)
    for y = 0, H - 1 do
      for x = 0, W - 1 do
        local r, g, b, a = pixelRGBA(sprite, img:getPixel(x, y), mode)
        for yy = 0, s - 1 do
          for xx = 0, s - 1 do
            local ox, oy = x * s + xx, y * s + yy
            local bg = ((math.floor(ox / cb) + math.floor(oy / cb)) % 2 == 0) and c1 or c2
            local fr = (r * a + bg[1] * (255 - a)) // 255
            local fg = (g * a + bg[2] * (255 - a)) // 255
            local fb = (b * a + bg[3] * (255 - a)) // 255
            if grid and (xx == 0 or yy == 0) then
              fr = (fr * 3 + gridC[1]) // 4
              fg = (fg * 3 + gridC[2]) // 4
              fb = (fb * 3 + gridC[3]) // 4
            end
            out:drawPixel(offX + ox, oy, pc.rgba(fr, fg, fb, 255))
          end
        end
      end
    end
  end
  out:saveAs(p.output)
  return { output = p.output, width = out.width, height = out.height, frames = frames, scale = s }
end

function ops.add_layer(ctx, p)
  local sprite = ctx.sprite
  local layer
  if p.group then layer = sprite:newGroup() else layer = sprite:newLayer() end
  layer.name = p.name
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
  return { layers = layerNames(sprite) }
end

function ops.update_layer(ctx, p)
  local sprite = ctx.sprite
  local layer = resolveLayer(sprite, p.layer)
  if p.delete then
    sprite:deleteLayer(layer)
  else
    if p.rename then layer.name = p.rename end
    if p.visible ~= nil then layer.isVisible = p.visible end
    if p.opacity then layer.opacity = p.opacity end
    if p.clear then
      for i = 1, #sprite.frames do
        local f = p.frame and resolveFrame(sprite, p.frame) or i
        if layer:cel(f) then sprite:deleteCel(layer, f) end
        if p.frame then break end
      end
    end
  end
  return { layers = layerNames(sprite) }
end

function ops.add_frame(ctx, p)
  local sprite = ctx.sprite
  local count = p.count or 1
  local after = p.after or #sprite.frames
  local created = {}
  for i = 1, count do
    local at = after + i
    local fr
    if p.copyFrom then
      local src = resolveFrame(sprite, p.copyFrom)
      fr = sprite:newFrame(src)
      if fr.frameNumber ~= at then
        -- newFrame(src) inserts after src; move content to requested position by re-inserting
        sprite:deleteFrame(fr)
        fr = sprite:newEmptyFrame(at)
        for _, e in ipairs(allLayers(sprite.layers)) do
          local l = e.layer
          if l.isImage then
            local c = l:cel(src < at and src or src + 1)
            if c then sprite:newCel(l, at, c.image:clone(), c.position) end
          end
        end
      end
    else
      fr = sprite:newEmptyFrame(at)
    end
    if p.durationMs then fr.duration = p.durationMs / 1000 end
    table.insert(created, fr.frameNumber)
  end
  return { created = created, totalFrames = #sprite.frames }
end

function ops.update_frames(ctx, p)
  local sprite = ctx.sprite
  if p.delete then
    local frames = p.frames or {}
    table.sort(frames, function(a, b) return a > b end)
    for _, n in ipairs(frames) do sprite:deleteFrame(resolveFrame(sprite, n)) end
  elseif p.durationMs then
    local frames = p.frames
    if not frames then frames = {}; for i = 1, #sprite.frames do table.insert(frames, i) end end
    for _, n in ipairs(frames) do sprite.frames[resolveFrame(sprite, n)].duration = p.durationMs / 1000 end
  end
  return info(sprite).frames
end

function ops.add_tag(ctx, p)
  local sprite = ctx.sprite
  local tag = sprite:newTag(resolveFrame(sprite, p.from), resolveFrame(sprite, p.to))
  tag.name = p.name
  local dirs = {
    forward = AniDir.FORWARD, reverse = AniDir.REVERSE,
    pingpong = AniDir.PING_PONG, pingpong_reverse = AniDir.PING_PONG_REVERSE,
  }
  if p.direction then tag.aniDir = dirs[p.direction] or AniDir.FORWARD end
  if p.repeats then tag.repeats = p.repeats end
  return info(sprite).tags
end

function ops.set_palette(ctx, p)
  local sprite = ctx.sprite
  applyPalette(sprite, p.palette or p.colors or {})
  return { palette = paletteHex(sprite) }
end

function ops.resize(ctx, p)
  local sprite = ctx.sprite
  if p.mode == "scale" then
    local w = p.width or math.floor(sprite.width * (p.factor or 1) + 0.5)
    local h = p.height or math.floor(sprite.height * (p.factor or 1) + 0.5)
    app.command.SpriteSize { ui = false, width = w, height = h, method = "nearest" }
  else
    -- canvas resize: anchor content
    local w, h = p.width or sprite.width, p.height or sprite.height
    local ax = p.anchor or "center"
    local dx, dy = 0, 0
    if ax:find("center") or ax == "top" or ax == "bottom" then dx = (w - sprite.width) // 2 end
    if ax:find("right") then dx = w - sprite.width end
    if ax:find("center") or ax == "left" or ax == "right" then dy = (h - sprite.height) // 2 end
    if ax:find("bottom") then dy = h - sprite.height end
    if ax == "top_left" or ax == "top" or ax == "top_right" then dy = 0 end
    if ax == "top_left" or ax == "left" or ax == "bottom_left" then dx = 0 end
    sprite:crop(-dx, -dy, w, h)
  end
  return { width = sprite.width, height = sprite.height }
end

-- User code runs with globals `sprite` (may be nil) and `params`; its return value is the result.
function ops.run_lua(ctx, p)
  local chunk, err = load(p.code, "run_lua", "t")
  if not chunk then fail("Lua syntax error: " .. tostring(err)) end
  sprite = ctx.sprite
  params = p.params
  return chunk()
end

---------------------------------------------------------------------------
-- Dispatch
---------------------------------------------------------------------------

-- Tool-shaped wrappers so batch steps use the same names/args as the MCP tools.
function ops.layer(ctx, p)
  if p.action == "add" then return ops.add_layer(ctx, p) end
  if p.action == "delete" then p.delete = true end
  if p.action == "clear" then p.clear = true end
  p.layer = p.layer or p.name
  return ops.update_layer(ctx, p)
end

function ops.frames(ctx, p)
  if p.action == "add" then return ops.add_frame(ctx, p) end
  if p.action == "tag" then return ops.add_tag(ctx, p) end
  if p.action == "delete" then p.delete = true end
  return ops.update_frames(ctx, p)
end

-- Ops that do not modify the sprite (no save needed).
local READ_ONLY = { sprite_info = true, read_pixels = true, preview = true }

-- Params: { path, steps = [{op=..., ...}], preview = {...}? }
-- Opens the sprite once, runs every step in order, saves once if anything changed.
-- A failing step aborts the batch and nothing is saved.
local function run(params)
  local ctx = { path = params.path }
  local steps = params.steps or {}
  if #steps == 0 then fail("no steps") end
  if steps[1].op ~= "create_sprite" and steps[1].op ~= "run_lua" then
    ctx.sprite = openSprite(ctx.path)
  elseif steps[1].op == "run_lua" and ctx.path and app.fs.isFile(ctx.path) then
    ctx.sprite = openSprite(ctx.path)
  end
  local results, dirty = {}, false
  for i, step in ipairs(steps) do
    local fn = ops[step.op]
    if not fn then fail("step " .. i .. ": unknown op " .. tostring(step.op)) end
    if step.op ~= "create_sprite" and step.op ~= "run_lua" and not ctx.sprite then
      fail("step " .. i .. ": no sprite open")
    end
    local ok, r = pcall(fn, ctx, step)
    if not ok then
      local msg = type(r) == "table" and r.message or tostring(r)
      fail("step " .. i .. " (" .. step.op .. "): " .. msg)
    end
    results[i] = r == nil and true or r
    if not READ_ONLY[step.op] and not (step.op == "run_lua" and step.save == false) then dirty = true end
  end
  if dirty and ctx.sprite then
    if not ctx.path then fail("missing 'path' to save to") end
    ctx.sprite:saveAs(ctx.path)
  end
  return results
end

local okRun, res = pcall(function() return run(readParams()) end)

if okRun then
  print(MARKER .. json.encode({ ok = true, results = res }))
else
  local msg = type(res) == "table" and res.message or tostring(res)
  print(MARKER .. json.encode({ ok = false, error = msg }))
end
