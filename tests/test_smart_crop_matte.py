import json
import os
import subprocess
import textwrap
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_PYTHON = os.path.join(ROOT, "venv", "bin", "python")


@unittest.skipUnless(os.path.exists(APP_PYTHON), "Application virtualenv is required")
class SmartCropMatteTests(unittest.TestCase):
    def test_crop_fits_between_meeting_header_and_footer(self):
        program = textwrap.dedent(
            """
            import json
            import sys
            sys.argv = ['viral_factory.py', 'x', '--mode', 'longform-edit']
            import numpy as np
            import viral_factory as vf

            frame = np.full((600, 800, 3), 155, dtype=np.uint8)
            frame[:84] = (24, 20, 20)
            frame[84:88] = (20, 240, 20)
            frame[540:544] = (20, 240, 20)
            frame[544:] = (24, 20, 20)
            top, height = vf._detect_top_matte_bottom(
                frame, 260, 120, 254, 454, face_top=220, return_height=True
            )
            print(json.dumps({'top': top, 'height': height}))
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
        self.assertEqual(json.loads(result.stdout), {"top": 88, "height": 452})


if __name__ == "__main__":
    unittest.main()
