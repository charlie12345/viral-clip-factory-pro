import json
import os
import re
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHON_CANDIDATES = [
    os.path.join(ROOT, "venv", "bin", "python"),
    os.path.join(ROOT, ".venv", "bin", "python"),
    os.path.join(ROOT, "venv", "Scripts", "python.exe"),
    os.path.join(ROOT, ".venv", "Scripts", "python.exe"),
]
APP_PYTHON = next((path for path in PYTHON_CANDIDATES if os.path.exists(path)), sys.executable)


@unittest.skipUnless(os.path.exists(APP_PYTHON), "Application Python is required")
class CaptionStyleTests(unittest.TestCase):
    def test_every_registered_caption_style_generates_ass(self):
        program = textwrap.dedent(
            """
            import json
            import os
            import sys
            sys.argv = ['viral_factory.py', '--mode', 'rerender']
            import viral_factory as vf

            words = [
                {'word': 'Make', 'start': 12.0, 'end': 12.2},
                {'word': 'it', 'start': 12.22, 'end': 12.4},
                {'word': 'pop', 'start': 12.42, 'end': 12.6},
            ]
            generated = []
            for style in sorted(vf.KNOWN_SUBTITLE_STYLES - {'none'}):
                path = vf.generate_ass_subtitles(words, style, offset_time=10, pos_x=0.5, pos_y=0.5, animation='popIn')
                with open(path, encoding='utf-8') as handle:
                    contents = handle.read()
                    generated.append(style if '\\pos(540,960)' in contents and r'\t(2000' not in contents else f'{style}:invalid-timing')
                os.remove(path)
            plain_path = vf.generate_ass_subtitles(words, 'marker', offset_time=10)
            glow_path = vf.generate_ass_subtitles(words, 'marker', offset_time=10, glow=True)
            with open(plain_path, encoding='utf-8') as handle:
                plain_has_glow = "\\\\blur2" in handle.read()
            with open(glow_path, encoding='utf-8') as handle:
                glow_has_glow = "\\\\blur2" in handle.read()
            os.remove(plain_path)
            os.remove(glow_path)
            print(json.dumps({
                'generated': generated,
                'unknown': vf.normalize_subtitle_style('not-a-style'),
                'none': vf.generate_subtitle_file(words, 'none'),
                'plain_has_glow': plain_has_glow,
                'glow_has_glow': glow_has_glow,
            }))
            """
        )
        result = subprocess.run(
            [APP_PYTHON, "-c", program],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        frontend_source = Path(ROOT, "webui", "src", "lib", "subtitle-styles.ts").read_text(encoding="utf-8")
        frontend_styles = set(re.findall(r"\{\s*id:'([^']+)'", frontend_source))
        self.assertEqual(payload["generated"], sorted(frontend_styles))
        self.assertEqual(payload["unknown"], "classic")
        self.assertIsNone(payload["none"])
        self.assertFalse(payload["plain_has_glow"])
        self.assertTrue(payload["glow_has_glow"])


if __name__ == "__main__":
    unittest.main()
