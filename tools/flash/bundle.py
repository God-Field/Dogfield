#!/usr/bin/env python3
"""Package the already built SWF and local assets without downloading anything."""
from pathlib import Path
import argparse
import os
import zipfile

repository = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=repository / 'artifacts/godfield-flash.zip')
parser.add_argument('--with-ruffle', action='store_true')
arguments = parser.parse_args()
assets = repository / 'public/flash/assets'
if not (assets / 'images').is_dir():
    parser.error('Import the historical assets first with npm run flash:setup.')
ruffle = Path(os.environ.get('FLASH_RUFFLE_DIR', repository / 'node_modules/@ruffle-rs/ruffle'))
if arguments.with_ruffle and not (ruffle / 'ruffle.js').is_file():
    parser.error('Install npm dependencies or set FLASH_RUFFLE_DIR first.')
arguments.output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(arguments.output, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
    for name in ['godfield.swf', 'godfield-201005.swf', 'godfield-201008.swf', 'ipamp.swf']:
        bundle.write(repository / 'public/flash' / name, name)
    bundle.write(repository / 'docs/FLASH.md', 'README.md')
    for source in sorted(assets.rglob('*')):
        if source.is_file():
            bundle.write(source, Path('assets') / source.relative_to(assets))
    if arguments.with_ruffle:
        for source in sorted(ruffle.rglob('*')):
            if source.is_file() and source.suffix != '.map':
                bundle.write(source, Path('ruffle') / source.relative_to(ruffle))
print(arguments.output)
