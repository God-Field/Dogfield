#!/usr/bin/env python3
"""Copy the original 2013 SWF encyclopedia CSV tables from a JPEXS binaryData export."""
import argparse
from pathlib import Path
import shutil

repository = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary-dir', type=Path, required=True)
parser.add_argument('--output-dir', type=Path, default=repository / 'server/flash/data/book')
arguments = parser.parse_args()
exports = {'BookItem': 'net.godfield.client.offline.book.BookItem_CSV'}
for language in ['English', 'Japanese']:
    for category in ['Item', 'Harm', 'Assistant', 'AssistantItem', 'Mystery']:
        name = f'{language}Data_{category}'
        exports[name] = f'net.godfield.client.data.{name}'

sources = {}
for name, class_name in exports.items():
    matches = list(arguments.binary_dir.glob(f'*_{class_name}.bin'))
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one binary export for {class_name}')
    sources[name] = matches[0]

arguments.output_dir.mkdir(parents=True, exist_ok=True)
for name, source in sources.items():
    shutil.copyfile(source, arguments.output_dir / f'{name}.csv')
print(f'Copied {len(sources)} unmodified SWF CSV tables to {arguments.output_dir}')
