import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest


AAF_AVAILABLE = importlib.util.find_spec("aaf2") is not None


@unittest.skipUnless(AAF_AVAILABLE and shutil.which("ffmpeg") and shutil.which("ffprobe"), "pyaaf2 and FFmpeg are required")
class LongformAafTests(unittest.TestCase):
    def test_writes_linked_picture_composition(self):
        import aaf2
        import longform_aaf

        with tempfile.TemporaryDirectory(prefix="vcf-longform-aaf-") as directory:
            source = os.path.join(directory, "source.mov")
            manifest_path = os.path.join(directory, "sequence.json")
            output = os.path.join(directory, "sequence.aaf")
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-nostdin",
                    "-y",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=24:duration=1",
                    "-c:v",
                    "prores_ks",
                    "-profile:v",
                    "2",
                    source,
                ],
                check=True,
                stdin=subprocess.DEVNULL,
                timeout=30,
            )
            with open(manifest_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "title": "AAF smoke",
                        "frameRate": 24,
                        "items": [{
                            "id": "clip-1",
                            "name": "Camera A",
                            "path": source,
                            "sourceStart": 0.1,
                            "sourceEnd": 0.8,
                            "timelineStart": 0,
                            "timelineEnd": 0.7,
                        }],
                    },
                    handle,
                )

            result = longform_aaf.write_aaf(manifest_path, output)
            self.assertEqual(result["linkedClips"], 1)
            self.assertEqual(result["offlineClips"], 0)
            self.assertGreater(os.path.getsize(output), 10_000)
            with aaf2.open(output, "r") as aaf:
                compositions = list(aaf.content.toplevel())
                self.assertEqual(len(compositions), 1)
                self.assertEqual(compositions[0].name, "AAF smoke")


if __name__ == "__main__":
    unittest.main()
