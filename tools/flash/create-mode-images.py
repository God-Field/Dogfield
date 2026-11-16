#!/usr/bin/env python3
"""Create functional replacements for absent Flash mode UI art; preserve originals."""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

repository = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=repository / 'public/flash/assets')
parser.add_argument('--font', type=Path, default=Path('/usr/share/fonts/noto-cjk/NotoSerifCJK-Regular.ttc'))
parser.add_argument('--latin-font', type=Path, default=Path('/usr/share/fonts/liberation/LiberationSerif-Regular.ttf'))
arguments = parser.parse_args()
created = []


def panel(relative, size, background, label=None, foreground='#ffffff', border='#808080', header=None):
    destination = arguments.output / 'images' / relative
    if destination.exists():
        return
    image = Image.new('RGB', size, background)
    drawing = ImageDraw.Draw(image)
    if header:
        drawing.rectangle((0, 0, size[0], 50), fill=header)
    drawing.rectangle((0, 0, size[0] - 1, size[1] - 1), outline=border, width=2)
    if label:
        font = ImageFont.truetype(str(arguments.font), 28)
        drawing.text((size[0] / 2, size[1] / 2), label, font=font, fill=foreground, anchor='mm')
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination)
    created.append(relative)


for mode, background in [('duel', '#492b45'), ('spirit', '#242d39')]:
    panel(f'component/{mode}/background.jpg', (1024, 708), background)
    panel(f'component/{mode}/bonus.png', (300, 200),
          '#f4eee0' if mode == 'duel' else background,
          header=background if mode == 'duel' else None)
panel('component/spirit/mode.png', (180, 600), '#414b59')
panel('component/charin/charge_help.png', (300, 90), '#f4eee0')
panel('component/duel/straight_help.png', (300, 50), '#f4eee0')
for state, color in [('up', '#f4eee0'), ('over', '#fff9eb'), ('down', '#dfd8c8')]:
    panel(f'component/charin/update_button_{state}.png', (100, 30), color)
# Additional surfaces referenced by the 2013 paid-mode classes.
panel('component/coin/god_coin.png', (100, 30), '#f4eee0')
panel('component/coin/charge_help.png', (300, 90), '#f4eee0')
panel('component/coin/duel_ticket.png', (45, 25), '#cda95a', 'D', '#222222')
panel('component/duel/score_bonus_help.png', (300, 50), '#f4eee0')
panel('component/duel/result.png', (1000, 700), '#f4eee0', header='#492b45')
for state, color in [('up', '#645088'), ('over', '#8069aa'), ('down', '#44355f')]:
    panel(f'component/duel/close_button_{state}.png', (25, 25), color, '×')
# Supplying a local identity activates the original top bar and lottery controls.
panel('component/offline/entrance/lottery.png', (300, 200), '#f4eee0')
# Reuse the original Flash skins so edges, bevels, gradients, and states match.
def button_skin(style, state, size):
    if style == 'emerald':
        template = f'component_en/offline/login_button_{state}.png'
        cap_width = 24
        sample_column = 32
    else:
        template = f'component_en/offline/entrance/logout_button_{state}.png'
        cap_width = 5
        sample_column = 8
    with Image.open(repository / 'public/flash/assets/images' / template) as original:
        source = original.convert('RGBA')
    source_width, source_height = source.size
    skin = Image.new('RGBA', (size[0], source_height))
    left_cap = source.crop((0, 0, cap_width, source_height))
    right_cap = source.crop((source_width - cap_width, 0, source_width, source_height))
    middle = source.crop((sample_column, 0, sample_column + 1, source_height))
    middle = middle.resize((size[0] - cap_width * 2, source_height))
    skin.paste(left_cap, (0, 0))
    skin.paste(middle, (cap_width, 0))
    skin.paste(right_cap, (size[0] - cap_width, 0))
    return skin.resize(size, Image.Resampling.LANCZOS)


def original_text_alignment(style, language):
    component = 'offline/login_button' if style == 'emerald' else 'offline/entrance/logout_button'
    template = repository / 'public/flash/assets/images' / f'component_{language}/{component}_up.png'
    with Image.open(template) as original:
        source = original.convert('RGBA')
    face_mask = Image.new('L', source.size)
    horizontal_margin = 24 if style == 'emerald' else 12
    for vertical in range(4, source.height - 4):
        for horizontal in range(horizontal_margin, source.width - horizontal_margin):
            red, green, blue, alpha = source.getpixel((horizontal, vertical))
            if style == 'emerald':
                is_face = red > 196 and green > 230 and blue > 196
            else:
                is_face = max(red, green, blue) - min(red, green, blue) < 4 and red < 200
            if alpha > 250 and is_face:
                face_mask.putpixel((horizontal, vertical), 255)
    bounds = face_mask.getbbox()
    if bounds is None:
        raise ValueError(f'Could not locate the original lettering: {template}')
    center_x = (bounds[0] + bounds[2]) / (2 * source.width)
    center_y = (bounds[1] + bounds[3]) / (2 * source.height)
    pressed_offset = 2 / source.height
    return center_x, center_y, pressed_offset


def mode_button(relative, size, label, language, style, state, font_size):
    image = button_skin(style, state, size)
    scale = 3
    text_layer = Image.new('RGBA', (size[0] * scale, size[1] * scale))
    font_path = arguments.font if language == 'ja' else arguments.latin_font
    font = ImageFont.truetype(str(font_path), font_size * scale)
    # Measure actual ink, excluding the font's empty side bearings and leading.
    layout_mask = Image.new('L', text_layer.size)
    ImageDraw.Draw(layout_mask).text((0, 0), label, font=font, fill=255)
    text_bounds = layout_mask.getbbox()
    if text_bounds is None:
        raise ValueError(f'Button label has no visible lettering: {label}')
    center_x, center_y, pressed_offset = original_text_alignment(style, language)
    if style == 'emerald':
        center_y = 0.5
    text_left = size[0] * scale * center_x - (text_bounds[0] + text_bounds[2]) / 2
    text_top = size[1] * scale * center_y - (text_bounds[1] + text_bounds[3]) / 2
    if state == 'down':
        text_top += size[1] * scale * pressed_offset
    # The original raised lettering uses a colored face, a lit upper-left
    # bevel, a darker lower-right bevel, and a soft shadow. Its hover/pressed
    # palettes brighten/darken the text along with the original button skin.
    if style == 'emerald':
        face_color = (221, 255, 221)
        highlight_color = (255, 255, 255)
        shade_color = (171, 205, 171)
        shadow_color = (111, 145, 111)
        shadow_blur = 0.65
        shadow_opacity = 0.45
    else:
        face_color = (79, 79, 79)
        highlight_color = (113, 113, 113)
        shade_color = (55, 55, 55)
        shadow_color = (0, 0, 0)
        shadow_blur = 1.2
        shadow_opacity = 0.65
    state_delta = {'up': 0, 'over': 50, 'down': -50}[state]

    def state_color(color):
        return tuple(max(0, min(255, channel + state_delta)) for channel in color)

    mask = Image.new('L', text_layer.size)
    mask_drawing = ImageDraw.Draw(mask)
    mask_drawing.text((text_left, text_top), label, font=font, fill=255)
    shadow_mask = mask.filter(ImageFilter.GaussianBlur(scale * shadow_blur))
    shadow_mask = ImageChops.offset(shadow_mask, scale, scale)
    shadow_mask = shadow_mask.point(lambda opacity: round(opacity * shadow_opacity))
    shadow_layer = Image.new('RGBA', text_layer.size, state_color(shadow_color))
    shadow_layer.putalpha(shadow_mask)
    text_layer.alpha_composite(shadow_layer)

    face_layer = Image.new('RGBA', text_layer.size, state_color(face_color))
    face_layer.putalpha(mask)
    text_layer.alpha_composite(face_layer)

    softened_mask = mask.filter(ImageFilter.GaussianBlur(scale * 0.35))
    bevel_offset = scale
    highlight_mask = ImageChops.subtract(
        softened_mask, ImageChops.offset(softened_mask, bevel_offset, bevel_offset),
    )
    shade_mask = ImageChops.subtract(
        softened_mask, ImageChops.offset(softened_mask, -bevel_offset, -bevel_offset),
    )
    for color, edge_mask in [(highlight_color, highlight_mask), (shade_color, shade_mask)]:
        bevel_layer = Image.new('RGBA', text_layer.size, state_color(color))
        bevel_layer.putalpha(ImageChops.multiply(edge_mask, mask))
        text_layer.alpha_composite(bevel_layer)

    text_layer = text_layer.resize(size, Image.Resampling.LANCZOS)
    image.alpha_composite(text_layer)
    destination = arguments.output / 'images' / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination)
    created.append(relative)


button_specs = [
    ('duel/entry_button', (300, 80), 'Enter', '入場', 'emerald', 64, 54),
    ('duel/result_button', (300, 45), 'Records', '成績', 'gold', 38, 34),
    ('spirit/entry_button', (160, 70), 'Enter', '入場', 'emerald', 44, 46),
    ('offline/entrance/lottery_button', (160, 45), 'Lottery', 'おみくじ', 'gold', 36, 30),
]
for component, size, english_label, japanese_label, style, english_size, japanese_size in button_specs:
    for language in ['en', 'ja']:
        label = english_label if language == 'en' else japanese_label
        font_size = english_size if language == 'en' else japanese_size
        for state in ['up', 'over', 'down']:
            relative = f'component_{language}/{component}_{state}.png'
            mode_button(relative, size, label, language, style, state, font_size)

# The newer backup's draw button says ten points; the legacy client charges five.
for language in ['en', 'ja']:
    label = 'Draw (5 points)' if language == 'en' else '神器を引く（5個消費）'
    for state in ['up', 'over', 'down', 'disabled']:
        skin_state = 'up' if state == 'disabled' else state
        relative = f'component_{language}/freefight/book/element_add_button_{state}.png'
        mode_button(relative, (300, 80), label, language, 'emerald', skin_state, 24)
        if state == 'disabled':
            destination = arguments.output / 'images' / relative
            with Image.open(destination) as original:
                image = original.convert('RGBA')
            gray = image.convert('L').convert('RGBA')
            gray.putalpha(image.getchannel('A'))
            Image.blend(image, gray, 0.8).save(destination)

# Legacy room filters draw their own labels over a shared checkbox skin.
for selected in [False, True]:
    selection = 'selected_' if selected else ''
    for state in ['up', 'over', 'down', 'disabled']:
        skin_state = 'up' if state == 'disabled' else state
        image = button_skin('gold', skin_state, (200, 40))
        drawing = ImageDraw.Draw(image)
        drawing.rectangle((7, 10, 25, 28), fill='#efffef', outline='#245b54', width=2)
        if selected:
            drawing.line([(10, 19), (15, 24), (23, 13)], fill='#245b54', width=3)
        relative = f'component/freefight/condition_toggle_{selection}{state}.png'
        destination = arguments.output / 'images' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        image.save(destination)
        created.append(relative)

# The legacy client has a compact top-bar book button and a paid-room toggle.
for language in ['en', 'ja']:
    label = 'Encyclopedia' if language == 'en' else '図鑑'
    for state in ['up', 'over', 'down']:
        mode_button(f'component_{language}/freefight/book/book_button_{state}.png',
                    (120, 30), label, language, 'gold', state, 18)
for selected in [False, True]:
    selection = 'selected_' if selected else ''
    label = '[x] ¥125' if selected else '[ ] ¥125'
    for state in ['up', 'over', 'down', 'disabled']:
        skin_state = 'up' if state == 'disabled' else state
        mode_button(f'component/freefight/charge_toggle_{selection}{state}.png',
                    (110, 40), label, 'en', 'gold', skin_state, 19)



def erase_tab_lettering(image):
    """Restore the lettering area from its clean surrounding cyan texture."""
    pixels = image.load()
    pending = set()
    for vertical in range(10, 45):
        for horizontal in range(25, 134):
            pending.add((horizontal, vertical))
    # Fill inward from the letter outlines using adjacent original texture.
    while pending:
        replacements = {}
        for horizontal, vertical in pending:
            neighbors = []
            for offset_x, offset_y in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                adjacent = (horizontal + offset_x, vertical + offset_y)
                if adjacent not in pending:
                    neighbors.append(pixels[adjacent])
            if neighbors:
                replacements[horizontal, vertical] = tuple(
                    round(sum(pixel[channel] for pixel in neighbors) / len(neighbors))
                    for channel in range(4))
        if not replacements:
            raise ValueError('Could not restore encyclopedia tab texture')
        for position, color in replacements.items():
            pixels[position] = color
        pending.difference_update(replacements)
    # Smooth the filled region so individual boundary pixels do not leave
    # straight bands where the original lettering used to be.
    restored = image.filter(ImageFilter.GaussianBlur(3))
    blend_mask = Image.new('L', image.size)
    ImageDraw.Draw(blend_mask).rectangle((27, 12, 132, 43), fill=255)
    blend_mask = blend_mask.filter(ImageFilter.GaussianBlur(2))
    restored.putalpha(image.getchannel('A'))
    return Image.composite(restored, image, blend_mask)


def encyclopedia_lettering(image, lines, state, tab=False, pressed_offset=0):
    scale = 3
    layer = Image.new('RGBA', (image.width * scale, image.height * scale))
    drawing = ImageDraw.Draw(layer)
    for label, font_size, center_y, raised in lines:
        font = ImageFont.truetype(str(arguments.latin_font), font_size * scale)
        bounds = drawing.textbbox((0, 0), label, font=font)
        center_x = image.width / 2 + (7 if tab else 0)
        text_left = center_x * scale - (bounds[0] + bounds[2]) / 2
        text_top = center_y * scale - (bounds[1] + bounds[3]) / 2
        # Only the entrance button shifts its lettering when pressed.
        if state == 'down':
            text_top += pressed_offset * scale
        if tab:
            face = '#686f60' if state in ['over', 'selected_disabled'] else '#171f13'
            shadow = '#d6e6cb'
        else:
            face = '#c5dec5' if state in ['down', 'disabled'] else '#f4fff4'
            shadow = '#264b39'
        if raised:
            mask = Image.new('L', layer.size)
            ImageDraw.Draw(mask).text((text_left + 2 * scale, text_top + 2 * scale),
                                     label, font=font, fill=210)
            shadow_layer = Image.new('RGBA', layer.size, shadow)
            shadow_layer.putalpha(mask.filter(ImageFilter.GaussianBlur(scale * 0.7)))
            layer.alpha_composite(shadow_layer)
        drawing.text((text_left, text_top), label, font=font, fill=face)
    image.alpha_composite(layer.resize(image.size, Image.Resampling.LANCZOS))
    return image


def save_encyclopedia_image(relative, image):
    destination = arguments.output / 'images' / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination)
    created.append(relative)


# Keep the entrance button's rectangular encyclopedia skin as well.
for state in ['up', 'over', 'down']:
    relative = f'offline/entrance/book_button_{state}.png'
    original = repository / 'public/flash/assets/images/component_ja' / relative
    with Image.open(original) as template:
        image = template.convert('RGBA')
    clean_face = image.crop((10, 7, 11, 73)).resize((286, 66))
    image.paste(clean_face, (7, 7))
    image = encyclopedia_lettering(image, [('Artifact Book', 40, 40, True)], state,
                                   pressed_offset=2)
    save_encyclopedia_image(f'component_en/{relative}', image)


encyclopedia_labels = ['+', 'Neutral 1', 'Neutral 2', 'Neutral 3', 'Neutral 4',
                       'Elemental 1', 'Elemental 2', 'Other', 'Guardians 1', 'Guardians 2']
for index, label in enumerate(encyclopedia_labels):
    for state in ['up', 'over', 'down', 'selected_disabled']:
        relative = f'offline/book/tab/{index}_{state}.png'
        original = repository / 'public/flash/assets/images/component_ja' / relative
        with Image.open(original) as template:
            image = template.convert('RGBA')
        if index != 0:
            image = erase_tab_lettering(image)
            image = encyclopedia_lettering(image, [(label, 22, 26, True)], state, tab=True)
        save_encyclopedia_image(f'component_en/{relative}', image)

for state in ['up', 'over', 'down', 'disabled']:
    relative = f'offline/book/element_add_button_{state}.png'
    original = repository / 'public/flash/assets/images/component_ja' / relative
    with Image.open(original) as template:
        image = template.convert('RGBA')
    # The face gradient is constant across each row. Its untouched left column
    # restores the lettering area while retaining all four original bevels.
    clean_face = image.crop((10, 7, 11, 113)).resize((286, 106))
    image.paste(clean_face, (7, 7))
    image = encyclopedia_lettering(image, [('Draw a new artifact', 31, 39, True),
                                           ('(Cost: 10 beads)', 29, 83, False)], state)
    save_encyclopedia_image(f'component_en/{relative}', image)

print(f'Prepared {len(created)} replacement interface images; original assets preserved.')
