#!/usr/bin/env python3
"""Extract the original 2010 SWF item and assistant distribution CSVs."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

repository = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--swf', type=Path, required=True, help='Original godfield-201005.swf or godfield-201008.swf')
parser.add_argument('--ffdec', type=Path, default=os.environ.get('FFDEC_JAR'), help='Path to ffdec.jar (or set FFDEC_JAR)')
parser.add_argument('--java', default='java', help='Java executable')
parser.add_argument('--output-dir', type=Path, default=repository / 'server/flash/data')
arguments = parser.parse_args()

swf = arguments.swf.resolve()
if not swf.is_file():
    raise FileNotFoundError(f'2010 SWF not found: {swf}')
if not arguments.ffdec:
    parser.error('Provide --ffdec=/path/to/ffdec.jar or set FFDEC_JAR')
ffdec = Path(arguments.ffdec).resolve()
if not ffdec.is_file():
    raise FileNotFoundError(f'JPEXS FFDec jar not found: {ffdec}')

exports = {
    'items-2010.csv': 'net.godfield.game.ItemData_CSV',
    'assistants-2010.csv': 'net.godfield.game.AssistantItemData_CSV',
}
for language in ("English", "Japanese"):
    for category in ("Item", "Harm", "Assistant", "AssistantItem", "Mystery"):
        exports[f"book-2010/{language}Data_{category}.csv"] = f"net.godfield.client.data.{language}Data_{category}"

with tempfile.TemporaryDirectory(prefix='dogfield-flash-2010-') as temporary_directory:
    binary_directory = Path(temporary_directory)
    subprocess.run(
        [arguments.java, '-jar', str(ffdec), '-export', 'binaryData', str(binary_directory), str(swf)],
        check=True,
    )

    sources = {}
    for file_name, class_name in exports.items():
        matches = list(binary_directory.glob(f'*_{class_name}.bin'))
        if len(matches) != 1:
            raise ValueError(f'Expected exactly one binary export for {class_name} from {swf}')
        sources[file_name] = matches[0]

    arguments.output_dir.mkdir(parents=True, exist_ok=True)
    for file_name, source in sources.items():
        target = arguments.output_dir / file_name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)

print(f'Extracted {len(sources)} unmodified CSV tables from {swf} to {arguments.output_dir}')
