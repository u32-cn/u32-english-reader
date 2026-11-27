"""生成 U32 favicon（方案 D：朗读波形）
用法: python make_icon.py
产物: favicon.ico(16/32/48), favicon-32.png, favicon-192.png, apple-touch-icon.png(180)
改色只需改 ACCENT；改图形改 BARS / BARS_SMALL。
"""
from PIL import Image, ImageDraw
from pathlib import Path

ACCENT = (0x0F, 0x76, 0x6E, 255)
WHITE = (255, 255, 255)
# 32 单位坐标系下的竖条: (x, y, w, h, opacity)
BARS = [
    (8.2, 12.5, 3.4, 7.0, 0.85),
    (14.4, 8.0, 3.2, 16.0, 1.00),
    (20.4, 11.0, 3.4, 10.0, 0.85),
]
SS = 16  # 超采样倍数（32 * 16 = 512 画布）
# 小尺寸专用：条加粗、间距收紧，避免 16px 下被抗锯齿摊薄成灰
BARS_SMALL = [
    (6.6, 12.0, 4.6, 8.0, 0.92),
    (13.7, 7.0, 4.6, 18.0, 1.00),
    (20.8, 10.0, 4.6, 12.0, 0.92),
]

OUT = Path(__file__).parent


def render(size: int, rounded: bool = True, inset: float = 1.0, bars=None) -> Image.Image:
    bars = bars or BARS
    canvas = size * SS
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = 8 / 32 * canvas * inset if rounded else 0
    if rounded:
        d.rounded_rectangle([0, 0, canvas - 1, canvas - 1], radius=r, fill=ACCENT)
    else:
        d.rectangle([0, 0, canvas - 1, canvas - 1], fill=ACCENT)

    # 图形层（支持 inset 缩放居中）
    k = canvas / 32 * inset
    off = (canvas - 32 * k) / 2
    for x, y, w, h, op in bars:
        box = [off + x * k, off + y * k, off + (x + w) * k, off + (y + h) * k]
        layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(
            box, radius=(w / 2) * k, fill=WHITE + (round(255 * op),)
        )
        img = Image.alpha_composite(img, layer)

    return img.resize((size, size), Image.LANCZOS)


# ICO：16 用手工加粗版，32/48 用标准版（Pillow 无法混合不同源图，手工打包 ICO 容器）
def ico_bytes(images) -> bytes:
    import io
    import struct
    pngs = []
    for im in images:
        b = io.BytesIO()
        im.save(b, format="PNG")
        pngs.append((im.size[0], b.getvalue()))
    head = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, blobs = b"", b""
    for size, data in pngs:
        entries += struct.pack(
            "<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset
        )
        blobs += data
        offset += len(data)
    return head + entries + blobs


(OUT / "favicon.ico").write_bytes(
    ico_bytes([render(16, bars=BARS_SMALL), render(32), render(48)])
)
render(32).save(OUT / "favicon-32.png")
render(512, inset=1.0).resize((192, 192), Image.LANCZOS).save(OUT / "favicon-192.png")
# iOS 自动加圆角，所以全铺背景
render(180, rounded=False, inset=0.94).save(OUT / "apple-touch-icon.png")

print("ok: favicon.ico (16/32/48), favicon-32.png, favicon-192.png, apple-touch-icon.png")
