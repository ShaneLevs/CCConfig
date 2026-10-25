#!/usr/bin/env python3
"""生成桌面版应用图标（白色圆角底板 + 主体轻微投影）。

为什么需要它：macOS 26+ 会给「带透明底」的旧式图标自动补一块系统灰色底板
（图标本身没有不透明背景 → 系统拿默认灰面兜住），Dock 里就出现一圈灰底。
所以这里自己画不透明底板：纯白圆角方块铺满画布，主体缩到 ~66% 居中，
再加一层模糊投影做出层次。

用法：
    python3 scripts/make-app-icon.py            # 生成 /tmp/app-icon.png（1024）
    cargo tauri icon /tmp/app-icon.png          # 由 CLI 产出 icons/ 全套尺寸 + icns

主体图形取 src-tauri/icons/icon.png（原始透明底版本），自动裁掉透明边。
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src-tauri" / "icons" / "tray.png"  # 原始透明底主体图（菜单栏也用这张）
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/app-icon.png")

SIZE = 1024
SS = 4  # 超采样倍数，圆角边缘更平滑
RADIUS_RATIO = 0.2237  # macOS 图标圆角 ≈ 22.37%
GLYPH_W_RATIO = 0.80  # 主体宽度占画布比例（留出 macOS 标准的四周留白）
PLATE = (222, 222, 223, 255)  # 底板 #DEDEDF


def main() -> None:
    src = Image.open(SOURCE).convert("RGBA")
    glyph = src.crop(src.getbbox())  # 去掉透明边，方便按比例摆放

    big = SIZE * SS
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    # 1) 白色圆角底板
    plate = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(plate).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=int(RADIUS_RATIO * big), fill=PLATE
    )
    canvas = Image.alpha_composite(canvas, plate)

    # 2) 主体缩放到目标宽度并居中（略微上移 1%，视觉重心更稳）
    target_w = int(GLYPH_W_RATIO * big)
    target_h = round(glyph.height * target_w / glyph.width)
    glyph = glyph.resize((target_w, target_h), Image.LANCZOS)
    x = (big - target_w) // 2
    y = (big - target_h) // 2 - int(big * 0.008)

    # 3) 投影：用主体 alpha 做黑色蒙版，模糊后下移一点
    alpha = glyph.getchannel("A").point(lambda a: int(a * 0.26))
    shadow = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 255), (x, y), alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=int(big * 0.010)))
    shadow_offset = (0, int(big * 0.008))
    shadow = shadow.transform(
        shadow.size, Image.AFFINE, (1, 0, 0, 0, 1, -shadow_offset[1])
    )
    canvas = Image.alpha_composite(canvas, shadow)

    # 4) 主体本体
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    layer.paste(glyph, (x, y), glyph)
    canvas = Image.alpha_composite(canvas, layer)

    canvas.resize((SIZE, SIZE), Image.LANCZOS).save(OUT)
    print(f"已生成 {OUT}（{SIZE}x{SIZE}）")
    print(f"下一步：cargo tauri icon {OUT}")


if __name__ == "__main__":
    main()
