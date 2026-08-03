import os
import shutil
import subprocess
import tempfile
import unittest

import longform_tools


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
class LongformProfessionalToolsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="vcf-longform-tools-")
        self.addCleanup(self.temporary.cleanup)
        self.source = os.path.join(self.temporary.name, "source.mp4")
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
                "anullsrc=channel_layout=stereo:sample_rate=48000:d=3",
                "-shortest",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                self.source,
            ],
            check=True,
            stdin=subprocess.DEVNULL,
            timeout=30,
        )

    def test_auto_grade_is_bounded_and_reproducible_for_source_frames(self):
        result = longform_tools.auto_grade(self.source, start=0, end=2.5, sample_count=8)
        grade = result["grade"]
        self.assertGreaterEqual(grade["exposure"], -0.3)
        self.assertLessEqual(grade["exposure"], 0.3)
        self.assertGreaterEqual(grade["gamma"], 0.82)
        self.assertLessEqual(grade["gamma"], 1.2)
        self.assertEqual(result["metrics"]["sampleCount"], 8)
        self.assertIn(result["metrics"]["detectedInput"], {"rec709", "log_like"})
        self.assertGreater(result["confidence"], 0)

    def test_background_tracking_and_audio_alignment_return_editor_data(self):
        background = longform_tools.suggest_background_key(self.source, time_sec=0.5)
        self.assertRegex(background["color"], r"^#[0-9A-F]{6}$")
        self.assertGreaterEqual(background["confidence"], 0)
        self.assertLessEqual(background["confidence"], 1)

        tracking = longform_tools.track_region(
            self.source,
            start=0,
            end=1,
            x=0.2,
            y=0.2,
            width=0.3,
            height=0.3,
            interval=0.25,
        )
        self.assertGreaterEqual(len(tracking["keyframes"]), 4)
        self.assertIn(tracking["status"], {"tracked", "partial"})
        self.assertTrue(all(0 <= keyframe["x"] <= 1 for keyframe in tracking["keyframes"]))

        alignment = longform_tools.align_audio(self.source)
        self.assertAlmostEqual(alignment["leadingSilenceSec"], 3, delta=0.15)

    def test_qc_detects_multiline_silence_ranges(self):
        parsed = longform_tools._ffmpeg_find_times(
            "silence_start: 0\nmetadata\nsilence_end: 3.0 | silence_duration: 3.0",
            r"silence_start:\s*([-+0-9.eE]+).*?silence_end:\s*([-+0-9.eE]+)",
        )
        self.assertEqual(parsed, [(0.0, 3.0)])

        report = longform_tools.qc_source(self.source, start=0, end=3)
        self.assertEqual(report["selection"], {"start": 0.0, "end": 3.0})
        self.assertTrue(any(issue["title"] == "Extended silence" for issue in report["issues"]))
        self.assertEqual(report["media"]["video"]["codec_type"], "video")
        self.assertEqual(report["media"]["audio"]["codec_type"], "audio")


if __name__ == "__main__":
    unittest.main()
