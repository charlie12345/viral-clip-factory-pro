import json
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import longform_editor


class SilencedetectParsingTests(unittest.TestCase):
    def test_parser_keeps_beginning_and_open_ended_intervals(self):
        stderr = """
            [silencedetect @ 0x1] silence_end: 1.25 | silence_duration: 1.25
            [silencedetect @ 0x1] silence_start: 4
            [silencedetect @ 0x1] silence_end: 5.5 | silence_duration: 1.5
            [silencedetect @ 0x1] silence_start: 8.125
        """
        self.assertEqual(
            longform_editor.parse_silencedetect(stderr),
            [
                {"start": 0.0, "end": 1.25, "enabled": True},
                {"start": 4.0, "end": 5.5, "enabled": True},
                {"start": 8.125, "end": None, "enabled": True},
            ],
        )

    @patch("longform_editor._run")
    def test_runner_offsets_the_filter_clock_to_source_time(self, run_mock):
        run_mock.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="",
            stderr=(
                "silence_start: 0\n"
                "silence_end: 1.5 | silence_duration: 1.5\n"
                "silence_start: 3.5\n"
            ),
        )
        cuts = longform_editor.run_silencedetect(
            "source.mp4",
            threshold_db=-42,
            min_silence_sec=0.75,
            selected_start=10,
            selected_end=15,
        )
        self.assertEqual(
            cuts,
            [
                {"start": 10.0, "end": 11.5, "enabled": True},
                {"start": 13.5, "end": None, "enabled": True},
            ],
        )
        command = run_mock.call_args.args[0]
        self.assertIn("10.000000", command)
        self.assertIn("5.000000", command)
        self.assertIn("asetpts=N/SR/TB,silencedetect=noise=-42dB:d=0.75", command)


class SilenceCutTests(unittest.TestCase):
    def test_padding_shrinks_only_edges_next_to_retained_program(self):
        cuts = longform_editor.normalize_silence_cuts(
            [(0, 2), (4, 6), (8, None)],
            selected_start=0,
            selected_end=10,
            edge_padding_sec=0.1,
        )
        self.assertEqual(
            [(cut["start"], cut["end"]) for cut in cuts],
            [(0.0, 1.9), (4.1, 5.9), (8.1, 10.0)],
        )
        keep = longform_editor.cuts_to_keep_segments(
            cuts,
            selected_start=0,
            selected_end=10,
        )
        self.assertEqual(
            keep,
            [
                {"start": 1.9, "end": 4.1, "duration": 2.2},
                {"start": 5.9, "end": 8.1, "duration": 2.2},
            ],
        )

    def test_disabled_cut_is_retained_but_not_removed(self):
        cuts = longform_editor.normalize_silence_cuts(
            [
                {"id": "opening", "start": 0, "end": 2, "enabled": True},
                {"id": "middle", "start": 4, "end": 6, "enabled": False},
                {"id": "ending", "start": 8, "end": 10, "enabled": True},
            ],
            selected_start=0,
            selected_end=10,
            edge_padding_sec=0.1,
        )
        self.assertFalse(cuts[1]["enabled"])
        self.assertEqual(
            longform_editor.cuts_to_keep_segments(
                cuts,
                selected_start=0,
                selected_end=10,
            ),
            [{"start": 1.9, "end": 8.1, "duration": 6.2}],
        )

    def test_no_cuts_keeps_the_full_selection(self):
        self.assertEqual(
            longform_editor.cuts_to_keep_segments(
                [],
                selected_start=12.5,
                selected_end=20,
            ),
            [{"start": 12.5, "end": 20.0, "duration": 7.5}],
        )

    def test_overlapping_enabled_cuts_are_merged_for_complement(self):
        keep = longform_editor.cuts_to_keep_segments(
            [(2, 5), (4, 7), (8, 9, False)],
            selected_start=0,
            selected_end=10,
        )
        self.assertEqual(
            keep,
            [
                {"start": 0.0, "end": 2.0, "duration": 2.0},
                {"start": 7.0, "end": 10.0, "duration": 3.0},
            ],
        )


class AnalysisContractTests(unittest.TestCase):
    def test_summary_reports_duration_totals_and_join_count(self):
        cuts = longform_editor.normalize_silence_cuts(
            [(0, 2), (4, 6), (8, 10)],
            selected_start=0,
            selected_end=10,
            edge_padding_sec=0.1,
        )
        result = longform_editor.summarize_analysis(
            "source.mp4",
            original_duration_sec=30,
            selected_start=0,
            selected_end=10,
            cuts=cuts,
            threshold_db=-35,
            min_silence_sec=0.5,
            edge_padding_sec=0.1,
        )
        self.assertEqual(result["original_duration_sec"], 30.0)
        self.assertEqual(result["selected_duration_sec"], 10.0)
        self.assertEqual(result["removed_duration_sec"], 5.6)
        self.assertEqual(result["estimated_duration_sec"], 4.4)
        self.assertEqual(result["join_count"], 1)
        self.assertEqual(result["enabled_cut_count"], 3)
        json.dumps(result)

    @patch("longform_editor.run_silencedetect")
    @patch("longform_editor.probe_duration", return_value=20)
    def test_analyze_source_can_enable_individual_cuts(self, _, detect_mock):
        detect_mock.return_value = [
            {"start": 2, "end": 4, "enabled": True},
            {"start": 8, "end": 10, "enabled": True},
        ]
        result = longform_editor.analyze_source(
            "source.mp4",
            edge_padding_sec=0,
            enabled_cut_indices=[1],
        )
        self.assertEqual([cut["enabled"] for cut in result["cuts"]], [False, True])
        self.assertEqual(
            result["keep_segments"],
            [
                {"start": 0.0, "end": 8.0, "duration": 8.0},
                {"start": 10.0, "end": 20.0, "duration": 10.0},
            ],
        )

    @patch("longform_editor._run")
    def test_probe_duration_uses_stream_fallback(self, run_mock):
        run_mock.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps(
                {
                    "format": {"duration": "N/A"},
                    "streams": [{"duration": "9.5"}, {"duration": "10.25"}],
                }
            ),
            stderr="",
        )
        self.assertEqual(longform_editor.probe_duration("source.mp4"), 10.25)


class EditedTimelineSidecarTests(unittest.TestCase):
    def test_source_times_and_words_are_remapped_across_cuts(self):
        keep = [(0, 5), (10, 15)]
        self.assertEqual(longform_editor.remap_source_time(12, keep), 7.0)
        self.assertIsNone(longform_editor.remap_source_time(7, keep))
        self.assertEqual(longform_editor.remap_source_time(7, keep, snap_removed_to_next=True), 5.0)
        words = longform_editor.remap_words_to_edits(
            [
                {"word": "keep", "start": 1, "end": 1.4},
                {"word": "remove", "start": 7, "end": 7.4},
                {"word": "again", "start": 11, "end": 11.5},
            ],
            keep,
        )
        self.assertEqual([word["word"] for word in words], ["keep", "again"])
        self.assertEqual(words[-1]["start"], 6.0)

    def test_transition_overlap_shifts_later_words_and_chapters(self):
        keep = [(0, 5), (10, 15)]
        overlaps = [0.4]
        self.assertEqual(
            longform_editor.remap_source_time(
                12,
                keep,
                transition_durations=overlaps,
            ),
            6.6,
        )
        words = longform_editor.remap_words_to_edits(
            [{"word": "again", "start": 11, "end": 11.5}],
            keep,
            transition_durations=overlaps,
        )
        self.assertEqual(words[0]["start"], 5.6)

    def test_writes_transcript_caption_and_chapter_sidecars(self):
        with tempfile.TemporaryDirectory() as directory:
            output_path = os.path.join(directory, "edited.mp4")
            written = longform_editor.write_longform_sidecars(
                output_path,
                words=[
                    {"word": "Hello", "start": 0.2, "end": 0.6},
                    {"word": "world.", "start": 0.7, "end": 1.1},
                    {"word": "Next", "start": 5.2, "end": 5.6},
                    {"word": "topic.", "start": 5.7, "end": 6.2},
                ],
                chapters=[
                    {"time": 0, "title": "Opening"},
                    {"time": 5, "title": "Second topic"},
                ],
                keep_segments=[(0, 2), (5, 8)],
            )
            self.assertEqual(set(written), {"transcript", "srt", "vtt", "chapters"})
            for path in written.values():
                self.assertTrue(os.path.exists(path))
            with open(written["chapters"], encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "0:00 Opening\n0:02 Second topic\n")
            with open(written["vtt"], encoding="utf-8") as handle:
                self.assertTrue(handle.read().startswith("WEBVTT\n\n"))

    def test_custom_caption_sidecars_do_not_require_transcript_words(self):
        with tempfile.TemporaryDirectory() as directory:
            output_path = os.path.join(directory, "edited.mp4")
            written = longform_editor.write_longform_sidecars(
                output_path,
                words=[],
                chapters=[],
                keep_segments=[(0, 4)],
                caption_cues=[{
                    "start": 0.5,
                    "end": 2.0,
                    "speaker": "Host",
                    "text": "Custom corrected caption",
                }],
            )
            self.assertEqual(set(written), {"srt", "vtt"})
            with open(written["srt"], encoding="utf-8") as handle:
                self.assertIn("Host: Custom corrected caption", handle.read())


if __name__ == "__main__":
    unittest.main()
