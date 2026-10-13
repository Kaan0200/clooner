#!/usr/bin/env python3
# Generates the golden .crate files in ./golden using cratedigger's encoder.
# One-off provenance script: the app itself never needs Python.
# Usage: pip install <path to cratedigger> && python3 generate-golden.py
import json
import os
from cratedigger.serato.crate import SeratoCrate

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'golden')

CASES = {
  'empty': [],
  'basic': [
    'Music/8mm/8mm - Opener EP/01 - Opener.flac',
    'Music/8mm/8mm - Opener EP/02 - Liar Liar.mp3',
  ],
  'unicode-bmp': [
    'Music/Beyoncé/Déjà Vu.m4a',
    'Music/坂本龍一/Merry Christmas Mr. Lawrence.aif',
  ],
}

os.makedirs(OUT, exist_ok=True)
for name, tracks in CASES.items():
  crate = SeratoCrate()
  crate.crate_name = name
  crate.tracks = tracks
  crate.write_crate(OUT)

with open(os.path.join(OUT, 'cases.json'), 'w', encoding='utf-8') as f:
  json.dump(CASES, f, indent=2, ensure_ascii=False)
