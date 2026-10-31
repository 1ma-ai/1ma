"""Regenerate every derived 1ma brand asset from the owner's files in brand/source.

python3 -I scripts/brand/make-icons.py          write the assets
python3 -I scripts/brand/make-icons.py --check  fail when a committed asset is stale
"""

import argparse
import math
import re
import struct
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "brand" / "source"
BRAND_OUT = ROOT / "brand"
PLUGIN_ASSETS = ROOT / "plugins" / "1ma-brand" / "assets"
MARKETPLACE_ICON = ROOT / "marketplace" / "icons" / "1ma.svg"

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
APP_ICON_CANVAS = 1024
APP_ICON_TILE = 824
APP_ICON_RADIUS_RATIO = 0.225
FAVICON_RADIUS_RATIO = 0.171
FAVICON_SIZES = (16, 32)
FIGURE_THRESHOLD = 128
FIGURE_PADDING = 24
SVG_PADDING = 8.0
ICNS_ENTRIES = (
    ("icp4", 16),
    ("ic11", 32),
    ("icp5", 32),
    ("ic12", 64),
    ("ic07", 128),
    ("ic13", 256),
    ("ic08", 256),
    ("ic14", 512),
    ("ic09", 512),
    ("ic10", 1024),
)


@dataclass
class Image:
    width: int
    height: int
    gray: list
    alpha: list | None


@dataclass
class Rgba:
    width: int
    height: int
    pixels: bytes


def _chunks(data: bytes):
    if data[:8] != PNG_SIGNATURE:
        raise ValueError("not a PNG file")
    pos = 8
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        kind = data[pos + 4 : pos + 8]
        yield kind, data[pos + 8 : pos + 8 + length]
        pos += 12 + length


def decode_rgba(data: bytes) -> Rgba:
    idat = b""
    width = height = color_type = 0
    for kind, body in _chunks(data):
        if kind == b"IHDR":
            width, height, depth, color_type, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or interlace != 0 or color_type not in (0, 2, 4, 6):
                raise ValueError(f"unsupported PNG layout: depth {depth}, type {color_type}")
        elif kind == b"IDAT":
            idat += body
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[color_type]
    stride = width * channels
    raw = zlib.decompress(idat)
    previous = bytearray(stride)
    out = bytearray(width * height * 4)
    offset = 0
    for y in range(height):
        kind = raw[offset]
        offset += 1
        line = bytearray(raw[offset : offset + stride])
        offset += stride
        for x in range(stride):
            left = line[x - channels] if x >= channels else 0
            up = previous[x]
            corner = previous[x - channels] if x >= channels else 0
            if kind == 1:
                line[x] = (line[x] + left) & 255
            elif kind == 2:
                line[x] = (line[x] + up) & 255
            elif kind == 3:
                line[x] = (line[x] + (left + up) // 2) & 255
            elif kind == 4:
                guess = left + up - corner
                da, db, dc = abs(guess - left), abs(guess - up), abs(guess - corner)
                pick = left if da <= db and da <= dc else up if db <= dc else corner
                line[x] = (line[x] + pick) & 255
        previous = line
        for x in range(width):
            source = line[x * channels : x * channels + channels]
            target = (y * width + x) * 4
            if channels == 1:
                out[target : target + 4] = bytes((source[0], source[0], source[0], 255))
            elif channels == 2:
                out[target : target + 4] = bytes((source[0], source[0], source[0], source[1]))
            elif channels == 3:
                out[target : target + 4] = bytes((source[0], source[1], source[2], 255))
            else:
                out[target : target + 4] = bytes(source)
    return Rgba(width, height, bytes(out))


def load_image(path: Path) -> Image:
    rgba = decode_rgba(path.read_bytes())
    gray = []
    alpha = []
    opaque = True
    pixels = rgba.pixels
    for index in range(0, len(pixels), 4):
        red, green, blue, opacity = pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]
        luma = red if red == green == blue else 0.2126 * red + 0.7152 * green + 0.0722 * blue
        weight = opacity / 255
        opaque = opaque and opacity == 255
        gray.append(luma * weight)
        alpha.append(weight)
    return Image(rgba.width, rgba.height, gray, None if opaque else alpha)


def encode_png(image: Image) -> bytes:
    rows = []
    with_alpha = image.alpha is not None
    for y in range(image.height):
        row = bytearray(b"\x00")
        for x in range(image.width):
            index = y * image.width + x
            weight = 1.0 if image.alpha is None else image.alpha[index]
            value = image.gray[index] / weight if weight > 0 else 0.0
            level = max(0, min(255, round(value)))
            if with_alpha:
                row += bytes((level, level, level, max(0, min(255, round(weight * 255)))))
            else:
                row += bytes((level, level, level))
        rows.append(bytes(row))
    header = struct.pack(">IIBBBBB", image.width, image.height, 8, 6 if with_alpha else 2, 0, 0, 0)

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    return PNG_SIGNATURE + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


def _box_weights(source: int, target: int) -> list:
    scale = source / target
    table = []
    for index in range(target):
        start = index * scale
        end = start + scale
        weights = []
        for sample in range(int(math.floor(start)), min(source, int(math.ceil(end)))):
            overlap = min(end, sample + 1) - max(start, sample)
            if overlap > 0:
                weights.append((sample, overlap / scale))
        table.append(weights)
    return table


def _resample(values: list, width: int, height: int, new_width: int, new_height: int) -> list:
    columns = _box_weights(width, new_width)
    rows = _box_weights(height, new_height)
    horizontal = [0.0] * (new_width * height)
    for y in range(height):
        base = y * width
        out = y * new_width
        for x, weights in enumerate(columns):
            total = 0.0
            for sample, weight in weights:
                total += values[base + sample] * weight
            horizontal[out + x] = total
    result = [0.0] * (new_width * new_height)
    for y, weights in enumerate(rows):
        out = y * new_width
        for x in range(new_width):
            total = 0.0
            for sample, weight in weights:
                total += horizontal[sample * new_width + x] * weight
            result[out + x] = total
    return result


def resize(image: Image, width: int, height: int) -> Image:
    if width > image.width or height > image.height:
        raise ValueError("resize only downsamples")
    gray = _resample(image.gray, image.width, image.height, width, height)
    alpha = None if image.alpha is None else _resample(image.alpha, image.width, image.height, width, height)
    return Image(width, height, gray, alpha)


def invert(image: Image) -> Image:
    if image.alpha is None:
        return Image(image.width, image.height, [255.0 - value for value in image.gray], None)
    gray = [(255.0 * weight - value) for value, weight in zip(image.gray, image.alpha)]
    return Image(image.width, image.height, gray, list(image.alpha))


def rounded_tile(art: Image, size: int, tile: int, radius_ratio: float) -> Image:
    margin = (size - tile) // 2
    radius = radius_ratio * tile
    half = tile / 2
    center = margin + half
    straight = half - radius
    scaled = resize(art, tile, tile)
    gray = [0.0] * (size * size)
    alpha = [0.0] * (size * size)
    for y in range(size):
        dy = abs(y + 0.5 - center) - straight
        for x in range(size):
            dx = abs(x + 0.5 - center) - straight
            outside = math.hypot(max(dx, 0.0), max(dy, 0.0)) + min(max(dx, dy), 0.0) - radius
            coverage = 0.5 - outside
            if coverage <= 0:
                continue
            coverage = min(coverage, 1.0)
            index = y * size + x
            source = (y - margin) * tile + (x - margin)
            source_alpha = 1.0 if scaled.alpha is None else scaled.alpha[source]
            alpha[index] = coverage * source_alpha
            gray[index] = scaled.gray[source] * coverage
    return Image(size, size, gray, alpha)


def figure_squares(art: Image) -> list:
    width, height = art.width, art.height
    lit = bytearray(1 if value >= FIGURE_THRESHOLD else 0 for value in art.gray)
    seen = bytearray(width * height)
    squares = []
    for start in range(width * height):
        if not lit[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = 1
        count = 0
        left = top = 1 << 30
        right = bottom = -1
        while stack:
            point = stack.pop()
            count += 1
            y, x = divmod(point, width)
            left, right, top, bottom = min(left, x), max(right, x), min(top, y), max(bottom, y)
            for neighbour in (
                point - 1 if x > 0 else -1,
                point + 1 if x < width - 1 else -1,
                point - width if y > 0 else -1,
                point + width if y < height - 1 else -1,
            ):
                if neighbour >= 0 and lit[neighbour] and not seen[neighbour]:
                    seen[neighbour] = 1
                    stack.append(neighbour)
        box = (right - left + 1) * (bottom - top + 1)
        if count / box < 0.95:
            raise ValueError(f"figure part at {left},{top} is not a square; vectorizing would distort it")
        squares.append((left, top, right - left + 1, bottom - top + 1))
    return sorted(squares, key=lambda square: (square[1], square[0]))


def figure_svg(squares: list) -> str:
    left = min(x for x, _, _, _ in squares)
    top = min(y for _, y, _, _ in squares)
    right = max(x + w for x, _, w, _ in squares)
    bottom = max(y + h for _, y, _, h in squares)
    side = max(right - left, bottom - top) + 2 * FIGURE_PADDING
    origin_x = (left + right - side) / 2
    origin_y = (top + bottom - side) / 2
    body = "\n".join(f'<rect x="{x}" y="{y}" width="{w}" height="{h}"/>' for x, y, w, h in squares)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{origin_x:g} {origin_y:g} {side} {side}" '
        f'fill="currentColor" role="img" aria-label="1ma">\n{body}\n</svg>\n'
    )


def build_icns(render) -> bytes:
    body = b""
    for kind, size in ICNS_ENTRIES:
        payload = render(size)
        body += kind.encode("ascii") + struct.pack(">I", len(payload) + 8) + payload
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def parse_icns(data: bytes) -> list:
    if data[:4] != b"icns":
        raise ValueError("not an icns file")
    entries = []
    pos = 8
    while pos < len(data):
        kind = data[pos : pos + 4].decode("ascii")
        length = struct.unpack(">I", data[pos + 4 : pos + 8])[0]
        entries.append((kind, data[pos + 8 : pos + length]))
        pos += length
    return entries


_TOKEN = re.compile(r"[MmCcLlZz]|-?\d+(?:\.\d+)?")


def _path_bounds(d: str) -> tuple:
    xs = []
    ys = []
    x = y = 0.0
    start = (0.0, 0.0)
    command = None
    numbers = []

    def flush():
        nonlocal x, y, start, numbers, command
        if command in ("M", "m", "L", "l"):
            for index in range(0, len(numbers), 2):
                nx, ny = numbers[index], numbers[index + 1]
                if command in ("m", "l"):
                    nx, ny = x + nx, y + ny
                x, y = nx, ny
                xs.append(x)
                ys.append(y)
                if command in ("M", "m") and index == 0:
                    start = (x, y)
                    command = "L" if command == "M" else "l"
        elif command in ("C", "c"):
            for index in range(0, len(numbers), 6):
                points = [numbers[index + k : index + k + 2] for k in (0, 2, 4)]
                for px, py in points:
                    if command == "c":
                        px, py = x + px, y + py
                    xs.append(px)
                    ys.append(py)
                ex, ey = points[2]
                x, y = (x + ex, y + ey) if command == "c" else (ex, ey)
        numbers = []

    for token in _TOKEN.findall(d):
        if token in "MmCcLlZz":
            flush()
            if token in "Zz":
                x, y = start
                command = None
            else:
                command = token
        else:
            numbers.append(float(token))
    flush()
    return min(xs), min(ys), max(xs), max(ys)


def _transform(text: str) -> tuple:
    translate = re.search(r"translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)", text)
    scale = re.search(r"scale\(\s*([-\d.]+)(?:[\s,]+([-\d.]+))?\s*\)", text)
    tx, ty = (float(translate.group(1)), float(translate.group(2))) if translate else (0.0, 0.0)
    sx = float(scale.group(1)) if scale else 1.0
    sy = float(scale.group(2)) if scale and scale.group(2) else sx
    return tx, ty, sx, sy


def _user_bounds(bounds: tuple, transform: tuple) -> tuple:
    tx, ty, sx, sy = transform
    left, top, right, bottom = bounds
    xs = (tx + sx * left, tx + sx * right)
    ys = (ty + sy * top, ty + sy * bottom)
    return (min(xs), min(ys), max(xs), max(ys))


def logo_svgs(source: str) -> dict:
    transform = re.search(r'<g transform="([^"]+)"', source).group(1)
    matrix = _transform(transform)
    paths = re.findall(r'<path d="([^"]+)"', source)
    if not paths:
        raise ValueError("logo.svg has no paths")
    boxes = [_user_bounds(_path_bounds(path), matrix) for path in paths]
    word = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))

    def svg(view: tuple, chosen: list) -> str:
        x, y, w, h = view
        body = "\n".join(f'<path d="{path}"/>' for path in chosen)
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x:.1f} {y:.1f} {w:.1f} {h:.1f}" '
            f'fill="currentColor" role="img" aria-label="1ma">\n'
            f'<g transform="{transform}">\n{body}\n</g>\n</svg>\n'
        )

    pad = SVG_PADDING
    return {
        "wordmark.svg": svg((word[0] - pad, word[1] - pad, word[2] - word[0] + 2 * pad, word[3] - word[1] + 2 * pad), paths),
    }


def build_outputs() -> dict:
    art = load_image(SOURCE / "app-icon.png")
    if art.alpha is not None or art.width != art.height:
        raise ValueError("brand/source/app-icon.png must be an opaque square")
    master = rounded_tile(art, APP_ICON_CANVAS, APP_ICON_TILE, APP_ICON_RADIUS_RATIO)
    tiles = {master.width: encode_png(master)}

    def tile_png(size: int) -> bytes:
        if size not in tiles:
            tiles[size] = encode_png(resize(master, size, size))
        return tiles[size]

    outputs = {}
    for size in FAVICON_SIZES:
        favicon = rounded_tile(art, size, size, FAVICON_RADIUS_RATIO)
        outputs[PLUGIN_ASSETS / f"favicon-{size}.png"] = encode_png(favicon)
    for size in (192, 512):
        outputs[PLUGIN_ASSETS / f"app-icon-{size}.png"] = tile_png(size)
        outputs[PLUGIN_ASSETS / f"app-icon-{size}-maskable.png"] = encode_png(resize(art, size, size))
    outputs[PLUGIN_ASSETS / "apple-touch-icon.png"] = encode_png(resize(art, 180, 180))
    outputs[BRAND_OUT / "app-icon-1024.png"] = tile_png(APP_ICON_CANVAS)
    outputs[BRAND_OUT / "1ma.icns"] = build_icns(tile_png)
    outputs[PLUGIN_ASSETS / "icon.svg"] = figure_svg(figure_squares(art)).encode("utf-8")
    for name, text in logo_svgs((SOURCE / "logo.svg").read_text(encoding="utf-8")).items():
        outputs[PLUGIN_ASSETS / name] = text.encode("utf-8")
    outputs[MARKETPLACE_ICON] = outputs[PLUGIN_ASSETS / "icon.svg"]
    return outputs


def _same(path: Path, expected: bytes) -> bool:
    if not path.exists():
        return False
    actual = path.read_bytes()
    if path.suffix == ".png":
        a, b = decode_rgba(actual), decode_rgba(expected)
        return (a.width, a.height, a.pixels) == (b.width, b.height, b.pixels)
    if path.suffix == ".icns":
        left, right = parse_icns(actual), parse_icns(expected)
        if [kind for kind, _ in left] != [kind for kind, _ in right]:
            return False
        for (_, x), (_, y) in zip(left, right):
            a, b = decode_rgba(x), decode_rgba(y)
            if (a.width, a.height, a.pixels) != (b.width, b.height, b.pixels):
                return False
        return True
    return actual == expected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    outputs = build_outputs()
    if args.check:
        stale = [path for path, data in outputs.items() if not _same(path, data)]
        produced = {path.name for path in outputs if path.parent == PLUGIN_ASSETS}
        leftovers = sorted(p.name for p in PLUGIN_ASSETS.iterdir() if p.name not in produced)
        for path in stale:
            print(f"stale: {path.relative_to(ROOT)}", file=sys.stderr)
        for name in leftovers:
            print(f"not generated, remove it: plugins/1ma-brand/assets/{name}", file=sys.stderr)
        if stale or leftovers:
            print("run: python3 -I scripts/brand/make-icons.py", file=sys.stderr)
            return 1
        print(f"brand assets up to date: {len(outputs)} files")
        return 0
    for path, data in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        print(f"wrote {path.relative_to(ROOT)} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
