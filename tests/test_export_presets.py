import unittest

from export_presets import get_export_preset, safe_output_name


class ExportPresetTests(unittest.TestCase):
    def test_unknown_preset_falls_back_to_generic(self):
        self.assertEqual(get_export_preset("unknown")["id"], "generic")

    def test_output_name_is_sanitized(self):
        name = safe_output_name(
            "{source} {platform} {index} {score}",
            "/tmp/My unsafe video!.mp4",
            "youtube_shorts",
            2,
            8.25,
        )
        self.assertEqual(name, "My_unsafe_video_youtube_shorts_2_8.2.mp4")

    def test_invalid_template_falls_back(self):
        name = safe_output_name("{missing}", "source.mp4", "tiktok", 1, 4)
        self.assertEqual(name, "source_tiktok_1_4.0.mp4")


if __name__ == "__main__":
    unittest.main()
