#!/usr/bin/env python3
"""Fill missing 2010 card images from matching 2013 art, then reviewed HTML5 art."""
import argparse
import csv
import json
from pathlib import Path
import shutil

from PIL import Image

repository = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=repository / 'public/flash/assets')
arguments = parser.parse_args()
aliases = json.loads((repository / 'tools/flash/image-aliases.json').read_text())
html5_aliases = json.loads((repository / 'tools/flash/html5-image-aliases.json').read_text())
items = list(csv.reader((repository / 'server/flash/data/items-2010.csv').read_text().splitlines()))
names = list(csv.reader((repository / 'server/flash/data/names-2010.csv').read_text().splitlines()))
recovered_count = 0
missing_count = 0
seen_images = set()

for fields, name in zip(items, names, strict=True):
    if float(fields[10] or 0) <= 0:
        continue
    category = fields[0].lower()
    image_name = name[0]
    relative = Path('images/card') / category / f'{image_name}.png'
    if relative in seen_images:
        continue
    seen_images.add(relative)
    destination = arguments.output / relative
    alias = aliases.get(image_name)
    html5_alias = html5_aliases.get(image_name)
    if alias:
        source = arguments.output / 'images/card' / category / f'{alias["image"]}.png'
        source_kind = 'flash-2013'
    elif html5_alias:
        source = repository / 'public/images/items' / html5_alias['category'] / f'{html5_alias["image"]}.webp'
        source_kind = 'html5'
    else:
        if not destination.exists():
            missing_count += 1
        continue
    if not source.is_file():
        raise FileNotFoundError(f'Missing reviewed artwork source: {source}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source_kind == 'flash-2013':
        shutil.copyfile(source, destination)
    else:
        with Image.open(source) as image:
            if image.size != (80, 80):
                raise ValueError(f'Expected 80x80 card artwork: {source}')
            image.save(destination, format='PNG')

    recovered_count += 1

print(f'Prepared {recovered_count} replacement images; {missing_count} unique active 2010 card images remain unavailable.')
