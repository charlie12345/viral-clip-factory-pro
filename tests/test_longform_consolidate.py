import json
import os
import shutil
import subprocess
import tempfile
import unittest

import longform_consolidate


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
class LongformConsolidationTests(unittest.TestCase):
    def test_trims_media_with_bounded_handles_and_writes_turnover_manifest(self):
        with tempfile.TemporaryDirectory(prefix="vcf-longform-consolidate-") as directory:
            source = os.path.join(directory, "source.mp4")
            manifest_path = os.path.join(directory, "request.json")
            package_path = os.path.join(directory, "package")
            project_path = os.path.join(directory, "project.json")
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
                    "testsrc2=size=320x180:rate=24:duration=3",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=3",
                    "-shortest",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    source,
                ],
                check=True,
                stdin=subprocess.DEVNULL,
                timeout=30,
            )
            with open(project_path, "w", encoding="utf-8") as handle:
                json.dump({"kind": "longform", "manifest_version": 6}, handle)
            with open(manifest_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "projectName": "episode.mp4",
                        "title": "Episode",
                        "projectPath": project_path,
                        "codec": "h264",
                        "handlesSec": 0.5,
                        "frameRate": 24,
                        "items": [{
                            "id": "clip-1",
                            "name": "Camera A",
                            "path": source,
                            "sourceStart": 0.25,
                            "sourceEnd": 2.75,
                            "timelineStart": 0,
                            "timelineEnd": 2.5,
                            "trackName": "V1",
                            "trackKind": "video",
                        }],
                    },
                    handle,
                )

            result = longform_consolidate.consolidate(manifest_path, package_path)
            self.assertEqual(result["status"], "complete")
            self.assertEqual(result["summary"], {"total": 1, "complete": 1, "failed": 0})
            item = result["items"][0]
            self.assertEqual(item["headHandleSec"], 0.25)
            self.assertEqual(item["tailHandleSec"], 0.25)
            self.assertTrue(os.path.exists(item["consolidatedPath"]))
            self.assertTrue(os.path.exists(os.path.join(package_path, "project", "project.json")))
            self.assertTrue(os.path.exists(os.path.join(package_path, "manifest.json")))

            probe = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "json",
                    item["consolidatedPath"],
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertAlmostEqual(float(json.loads(probe.stdout)["format"]["duration"]), 3, delta=0.15)

    def test_missing_media_is_reported_without_unsafe_failure(self):
        with tempfile.TemporaryDirectory(prefix="vcf-longform-consolidate-offline-") as directory:
            manifest_path = os.path.join(directory, "request.json")
            with open(manifest_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "codec": "copy",
                        "items": [{
                            "id": "offline",
                            "name": "Offline clip",
                            "path": os.path.join(directory, "missing.mp4"),
                            "sourceStart": 0,
                            "sourceEnd": 1,
                        }],
                    },
                    handle,
                )
            result = longform_consolidate.consolidate(
                manifest_path,
                os.path.join(directory, "package"),
            )
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["items"][0]["status"], "offline")
            self.assertIn("missing", result["items"][0]["error"].lower())


if __name__ == "__main__":
    unittest.main()
