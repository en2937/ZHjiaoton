"""Build a compact preview from the actual browser screenshots and capture times."""
import json
import sys
from pathlib import Path
from PIL import Image

folder = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / 'ui-validation' / 'login-portal'
records = json.loads((folder / 'frames.json').read_text(encoding='utf-8'))
frames, durations = [], []
for index, record in enumerate(records):
    with Image.open(folder / record['file']) as source:
        frame = source.convert('RGB')
        frame.thumbnail((800, 800), Image.Resampling.LANCZOS)
        frames.append(frame.quantize(colors=128))
    delay = records[index + 1]['time'] - record['time'] if index + 1 < len(records) else 1200
    durations.append(max(50, min(500, delay)) if index + 1 < len(records) else delay)
durations[0] += 500
frames[0].save(folder / 'login-transition.gif', save_all=True, append_images=frames[1:], duration=durations,
               loop=0, disposal=2, optimize=False)
print('Browser screenshot sequence preview saved.')
