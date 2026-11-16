#!/usr/bin/env python3
"""Create documented substitutes using the included Flash sounds."""
import argparse
import json
from pathlib import Path
import shutil

repository = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=repository / 'public/flash/assets')
arguments = parser.parse_args()
manifest = json.loads((repository / 'tools/flash/sound-aliases.json').read_text())
recovered_count = 0
for name, substitution in manifest['substitutions'].items():
    source = arguments.output / 'sounds' / substitution['sound']
    destination = arguments.output / 'sounds' / name
    if not source.is_file():
        raise FileNotFoundError(f'Missing included sound: {source}')
    shutil.copyfile(source, destination)
    recovered_count += 1

missing = [name for name in manifest['references']
           if not (arguments.output / 'sounds' / name).is_file()]
print(f'Prepared {recovered_count} sound substitutes; {len(missing)} referenced sounds remain unavailable.')
