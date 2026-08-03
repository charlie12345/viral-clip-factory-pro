import json
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import action_compilation
from action_compilation import (
    Candidate,
    SourceInfo,
    build_join_filter,
    choose_subject_focus,
    compile_manifest,
    estimated_duration,
    normalize_settings,
    portrait_crop,
    portrait_framing,
    render_timeline,
    select_timeline,
    snap_window_to_safe_boundaries,
    validate_rendered_output,
)


def candidate(source: int, index: int, score: float, motion: float = 0.5) -> Candidate:
    return Candidate(
        id=f"s{source}-{index}", source_id=f"s{source}", source_order=source,
        source_path=f"/tmp/s{source}.mp4", source_name=f"source-{source}.mp4",
        start=index * 3.0, end=index * 3.0 + 2.0, score=score,
        motion=motion, scene_change=0.2, reasons=["motion peak"],
    )


class ActionCompilationUnitTests(unittest.TestCase):
    def test_settings_are_bounded_and_wordless_specific(self):
        result = normalize_settings({
            "goal": "cosplay_showcase", "targetDurationSec": 999,
            "pacing": "rapid", "transitionMode": "minimal",
            "output_width": 181, "output_height": 321,
        })
        self.assertEqual(result["goal"], "cosplay_showcase")
        self.assertEqual(result["target_duration_sec"], 180)
        self.assertEqual((result["output_width"], result["output_height"]), (180, 320))

    def test_horizontal_longform_settings_have_independent_defaults_and_bounds(self):
        defaults = normalize_settings({"format": "horizontal_longform"})
        self.assertEqual(defaults["format"], "horizontal_longform")
        self.assertEqual(defaults["target_duration_sec"], 300)
        self.assertEqual(defaults["pacing"], "balanced")
        self.assertEqual(
            (defaults["output_width"], defaults["output_height"]),
            (1920, 1080),
        )

        minimum = normalize_settings({
            "format": "horizontal_longform",
            "target_duration_sec": 1,
            "output_width": 321,
            "output_height": 181,
        })
        maximum = normalize_settings({
            "format": "horizontal_longform",
            "target_duration_sec": 9999,
        })
        self.assertEqual(minimum["target_duration_sec"], 180)
        self.assertEqual(maximum["target_duration_sec"], 900)
        self.assertEqual(
            (minimum["output_width"], minimum["output_height"]),
            (320, 180),
        )
        self.assertEqual(
            action_compilation._shot_range("balanced", "horizontal_longform"),
            (4.0, 7.0),
        )

    def test_invalid_format_preserves_vertical_short_defaults(self):
        settings = normalize_settings({"format": "cinemascope"})
        self.assertEqual(settings["format"], "vertical_short")
        self.assertEqual(settings["target_duration_sec"], 30)
        self.assertEqual(
            (settings["output_width"], settings["output_height"]),
            (1080, 1920),
        )

    def test_probe_media_swaps_coded_dimensions_for_quarter_turn_rotation(self):
        cases = [
            ({"side_data_list": [{"rotation": 90}]}, (2160, 3840)),
            ({"tags": {"rotate": "-90"}}, (2160, 3840)),
        ]
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "rotated.mp4"
            source.touch()
            for metadata, expected in cases:
                with self.subTest(metadata=metadata):
                    payload = {
                        "streams": [{
                            "codec_type": "video", "width": 3840, "height": 2160,
                            "duration": "1.0", **metadata,
                        }],
                        "format": {"duration": "1.0"},
                    }
                    completed = subprocess.CompletedProcess(
                        ["ffprobe"], 0, json.dumps(payload), "",
                    )
                    with mock.patch.object(action_compilation, "run_command", return_value=completed):
                        result = action_compilation.probe_media(source)
                    self.assertEqual((result.width, result.height), expected)

    def test_probe_media_reads_first_frame_rotation_for_orientation_sei(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "sei-rotated.mp4"
            source.touch()
            stream_payload = {
                "streams": [{
                    "codec_type": "video", "width": 200, "height": 100,
                    "duration": "1.0",
                }],
                "format": {"duration": "1.0"},
            }
            frame_payload = {
                "frames": [{
                    "width": 200, "height": 100,
                    "side_data_list": [{"rotation": 90}],
                }],
            }
            results = [
                subprocess.CompletedProcess(["ffprobe"], 0, json.dumps(stream_payload), ""),
                subprocess.CompletedProcess(["ffprobe"], 0, json.dumps(frame_payload), ""),
            ]
            with mock.patch.object(action_compilation, "run_command", side_effect=results) as runner:
                result = action_compilation.probe_media(source)
            self.assertEqual((result.width, result.height), (100, 200))
            self.assertEqual(runner.call_count, 2)

    def test_selection_uses_every_source_and_avoids_adjacent_duplicates(self):
        settings = normalize_settings({
            "target_duration_sec": 8,
            "pacing": "fast",
            "selection_mode": "use_every_clip",
            "order_mode": "ai",
            "transition_mode": "auto",
        })
        pools = [
            [candidate(0, 0, 0.95), candidate(0, 1, 0.7)],
            [candidate(1, 0, 0.9), candidate(1, 1, 0.6)],
            [candidate(2, 0, 0.8), candidate(2, 1, 0.5)],
        ]
        timeline = select_timeline(pools, settings)
        self.assertEqual({item.source_id for item in timeline}, {"s0", "s1", "s2"})
        self.assertTrue(all(left.source_id != right.source_id for left, right in zip(timeline, timeline[1:])))
        self.assertEqual(timeline[-1].transition_out, {"kind": "cut", "duration": 0.0})

    def test_horizontal_longform_can_select_distinct_nonoverlapping_moments_from_one_source(self):
        settings = normalize_settings({
            "format": "horizontal_longform",
            "target_duration_sec": 180,
            "pacing": "cinematic",
            "selection_mode": "use_every_clip",
            "order_mode": "manual",
            "transition_mode": "none",
        })
        pool = []
        for index in range(24):
            shot = candidate(0, index, 0.95 - index * 0.02)
            shot.start = index * 9.0
            shot.end = shot.start + 8.0
            pool.append(shot)

        timeline = select_timeline([pool], settings)

        self.assertEqual(len(timeline), 22)
        self.assertTrue(all(item.source_id == "s0" for item in timeline))
        self.assertEqual(len({item.id for item in timeline}), len(timeline))
        self.assertTrue(all(
            left.end <= right.start
            for left, right in zip(timeline, timeline[1:])
        ))
        self.assertGreaterEqual(estimated_duration(timeline), 180.0 * 0.96)

    def test_horizontal_manual_order_keeps_uploaded_sources_in_chronological_blocks(self):
        settings = normalize_settings({
            "format": "horizontal_longform",
            "target_duration_sec": 180,
            "pacing": "cinematic",
            "selection_mode": "use_every_clip",
            "order_mode": "manual",
            "transition_mode": "none",
        })
        pools = []
        for source in range(2):
            source_pool = []
            for index in range(4):
                shot = candidate(source, index, 0.9 - index * 0.05)
                shot.start = index * 9.0
                shot.end = shot.start + 8.0
                source_pool.append(shot)
            pools.append(source_pool)

        timeline = select_timeline(pools, settings)

        self.assertEqual(
            [item.source_id for item in timeline],
            ["s0", "s0", "s0", "s0", "s1", "s1", "s1", "s1"],
        )
        for source_id in ("s0", "s1"):
            starts = [item.start for item in timeline if item.source_id == source_id]
            self.assertEqual(starts, sorted(starts))

    def test_horizontal_longform_selection_is_not_limited_to_eighty_shots(self):
        settings = normalize_settings({
            "format": "horizontal_longform",
            "target_duration_sec": 300,
            "pacing": "fast",
            "selection_mode": "use_every_clip",
            "order_mode": "manual",
            "transition_mode": "none",
        })
        pools = [
            [candidate(source, index, 0.99 - index * 0.001) for index in range(60)]
            for source in range(2)
        ]

        timeline = select_timeline(pools, settings)

        self.assertEqual(len(timeline), 86)
        self.assertGreater(len(timeline), 80)
        self.assertEqual(
            [item.source_id for item in timeline],
            ["s0"] * 43 + ["s1"] * 43,
        )

    def test_repeated_source_moments_are_evenly_spaced_across_timeline(self):
        settings = normalize_settings({
            "target_duration_sec": 180,
            "pacing": "fast",
            "selection_mode": "use_every_clip",
            "order_mode": "manual",
            "transition_mode": "none",
        })
        pools = [
            [candidate(0, index, 0.95 - index * 0.03) for index in range(4)],
            [candidate(1, index, 0.82 - index * 0.03) for index in range(2)],
            [candidate(2, index, 0.76 - index * 0.03) for index in range(2)],
        ]
        timeline = select_timeline(pools, settings)
        sequence = [item.source_id for item in timeline]
        self.assertEqual(sequence, ["s0", "s1", "s2", "s0", "s1", "s0", "s2", "s0"])
        self.assertTrue(all(left != right for left, right in zip(sequence, sequence[1:])))
        repeated_positions = [index for index, source_id in enumerate(sequence) if source_id == "s0"]
        self.assertEqual(repeated_positions, [0, 3, 5, 7])
        self.assertEqual(
            [item.start for item in timeline if item.source_id == "s0"],
            sorted(item.start for item in timeline if item.source_id == "s0"),
        )

    def test_impossible_source_imbalance_drops_weak_excess_instead_of_repeating_adjacent(self):
        settings = normalize_settings({
            "target_duration_sec": 180,
            "pacing": "fast",
            "selection_mode": "use_every_clip",
            "order_mode": "ai",
            "transition_mode": "none",
        })
        pools = [
            [candidate(0, index, 0.95 - index * 0.03) for index in range(6)],
            [candidate(1, 0, 0.70)],
        ]
        timeline = select_timeline(pools, settings)
        sequence = [item.source_id for item in timeline]
        self.assertEqual(sequence, ["s0", "s1", "s0"])
        self.assertEqual(len({item.id for item in timeline}), len(timeline))
        self.assertTrue(all(left != right for left, right in zip(sequence, sequence[1:])))

    def test_selection_backfills_separator_source_to_reach_requested_duration(self):
        settings = normalize_settings({
            "target_duration_sec": 24,
            "pacing": "fast",
            "selection_mode": "use_every_clip",
            "order_mode": "ai",
            "transition_mode": "none",
        })
        pools = [
            [candidate(0, index, 0.99 - index * 0.005) for index in range(12)],
            [candidate(1, index, 0.08 - index * 0.001) for index in range(12)],
        ]
        timeline = select_timeline(pools, settings)
        sequence = [item.source_id for item in timeline]
        self.assertEqual(len(timeline), 12)
        self.assertGreaterEqual(estimated_duration(timeline), 24.0)
        self.assertEqual(sequence.count("s0"), 6)
        self.assertEqual(sequence.count("s1"), 6)
        self.assertTrue(all(left != right for left, right in zip(sequence, sequence[1:])))

    def test_singleton_source_is_placed_near_middle_instead_of_at_tail(self):
        settings = normalize_settings({
            "target_duration_sec": 20,
            "pacing": "fast",
            "selection_mode": "use_every_clip",
            "order_mode": "manual",
            "transition_mode": "none",
        })
        pools = [
            [candidate(0, index, 0.9) for index in range(5)],
            [candidate(1, index, 0.8) for index in range(4)],
            [candidate(2, 0, 0.7)],
        ]
        timeline = select_timeline(pools, settings)
        sequence = [item.source_id for item in timeline]
        singleton_position = sequence.index("s2")
        self.assertIn(singleton_position, {4, 5})
        self.assertTrue(all(left != right for left, right in zip(sequence, sequence[1:])))

    def test_overlapping_windows_from_same_upload_are_not_both_selected(self):
        settings = normalize_settings({
            "target_duration_sec": 12,
            "pacing": "fast",
            "selection_mode": "use_every_clip",
            "order_mode": "ai",
            "transition_mode": "none",
        })
        first = candidate(0, 0, 0.95)
        overlapping = candidate(0, 1, 0.92)
        overlapping.start = 1.2
        overlapping.end = 3.2
        pools = [
            [first, overlapping],
            [candidate(1, index, 0.8 - index * 0.02) for index in range(4)],
        ]
        timeline = select_timeline(pools, settings)
        source_zero = [item for item in timeline if item.source_id == "s0"]
        self.assertEqual(len(source_zero), 1)
        self.assertEqual(source_zero[0].id, first.id)

    def test_auto_transitions_follow_sparse_deterministic_decorative_cadence(self):
        settings = normalize_settings({
            "target_duration_sec": 180,
            "pacing": "fast",
            "selection_mode": "use_every_clip",
            "order_mode": "manual",
            "transition_mode": "auto",
        })

        def build_timeline():
            pools = [[candidate(source, 0, 1.0 - source * 0.01)] for source in range(18)]
            return select_timeline(pools, settings)

        first = build_timeline()
        second = build_timeline()
        expected_decorative = {
            3: "wipeleft",
            7: "wiperight",
            10: "slideup",
            14: "slidedown",
            17: "wipeleft",
        }
        self.assertEqual(len(first), 18)
        self.assertEqual(
            [item.transition_out for item in first],
            [item.transition_out for item in second],
        )
        for clip_number, item in enumerate(first, start=1):
            transition = item.transition_out or {}
            if clip_number in expected_decorative:
                self.assertEqual(transition.get("kind"), expected_decorative[clip_number])
                self.assertGreater(float(transition.get("duration", 0.0)), 0.0)
            else:
                self.assertEqual(
                    transition.get("kind"),
                    "cut",
                    f"clip {clip_number} should use a clean join",
                )
                self.assertEqual(float(transition.get("duration", -1.0)), 0.0)

    def test_none_mode_and_final_clip_always_use_hard_cuts(self):
        none_settings = normalize_settings({
            "target_duration_sec": 180,
            "selection_mode": "use_every_clip",
            "order_mode": "manual",
            "transition_mode": "none",
        })
        none_timeline = select_timeline(
            [[candidate(source, 0, 0.9)] for source in range(6)],
            none_settings,
        )
        self.assertTrue(none_timeline)
        self.assertTrue(all(
            item.transition_out == {"kind": "cut", "duration": 0.0}
            for item in none_timeline
        ))

        auto_settings = {**none_settings, "transition_mode": "auto"}
        auto_timeline = select_timeline(
            [[candidate(source, 0, 0.9)] for source in range(4)],
            auto_settings,
        )
        self.assertEqual(auto_timeline[2].transition_out.get("kind"), "wipeleft")
        self.assertEqual(auto_timeline[-1].transition_out, {"kind": "cut", "duration": 0.0})

    def test_timeline_duration_subtracts_transition_overlaps(self):
        first = candidate(0, 0, 0.9)
        second = candidate(1, 0, 0.8)
        first.transition_out = {"kind": "fade", "duration": 0.25}
        second.transition_out = {"kind": "cut", "duration": 0.0}
        self.assertAlmostEqual(estimated_duration([first, second]), 3.75)
        graph, video, audio = build_join_filter([first, second], transitions=True)
        self.assertIn("xfade=transition=fade:duration=0.250:offset=1.750", graph)
        self.assertEqual((video, audio), ("[v1]", "[a1]"))

    def test_subject_focus_locks_to_one_cosplayer_instead_of_the_midpoint(self):
        features = [
            {
                "time": 0.0,
                "subjects": [
                    {"kind": "face", "x": 0.22, "y": 0.30, "area": 0.02, "confidence": 0.9},
                    {"kind": "face", "x": 0.78, "y": 0.31, "area": 0.018, "confidence": 0.9},
                ],
            },
            {
                "time": 0.4,
                "subjects": [
                    {"kind": "face", "x": 0.225, "y": 0.305, "area": 0.021, "confidence": 0.9},
                    {"kind": "face", "x": 0.775, "y": 0.31, "area": 0.022, "confidence": 0.9},
                ],
            },
            {
                "time": 0.8,
                "subjects": [
                    {"kind": "face", "x": 0.23, "y": 0.30, "area": 0.02, "confidence": 0.9},
                    {"kind": "face", "x": 0.77, "y": 0.31, "area": 0.019, "confidence": 0.9},
                ],
            },
        ]
        framing = choose_subject_focus(features, 0, 0.0, 0.8)
        self.assertEqual(framing["kind"], "face")
        self.assertAlmostEqual(framing["x"], 0.225, delta=0.01)
        self.assertGreater(abs(framing["x"] - 0.5), 0.20)
        self.assertEqual(framing["count"], 2)

    def test_large_foreground_person_beats_tiny_background_face(self):
        features = []
        for index in range(3):
            features.append({
                "time": index * 0.4,
                "subjects": [
                    {
                        "kind": "person", "x": 0.705, "y": 0.515,
                        "left": 0.48, "top": 0.05, "right": 0.93, "bottom": 0.98,
                        "area": 0.40, "confidence": 0.86,
                    },
                    {
                        "kind": "face", "x": 0.12, "y": 0.18,
                        "left": 0.10, "top": 0.15, "right": 0.14, "bottom": 0.21,
                        "area": 0.0015, "confidence": 0.90,
                    },
                ],
            })
        framing = choose_subject_focus(features, 1, 0.0, 0.8)
        self.assertEqual(framing["kind"], "person")
        self.assertAlmostEqual(framing["x"], 0.705, delta=0.01)
        self.assertAlmostEqual(framing["left"], 0.48, delta=0.01)
        self.assertAlmostEqual(framing["right"], 0.93, delta=0.01)

    def test_tracking_does_not_switch_to_same_x_background_person(self):
        features = []
        for index in range(4):
            shift = index * 0.006
            features.append({
                "time": index * 0.3,
                "subjects": [
                    {
                        "kind": "person", "x": 0.70 + shift, "y": 0.50,
                        "left": 0.49 + shift, "top": 0.04,
                        "right": 0.91 + shift, "bottom": 0.97,
                        "area": 0.39, "confidence": 0.84,
                    },
                    {
                        "kind": "person", "x": 0.69, "y": 0.57,
                        "left": 0.62, "top": 0.42, "right": 0.76, "bottom": 0.72,
                        "area": 0.042, "confidence": 0.88,
                    },
                ],
            })
        framing = choose_subject_focus(features, 2, 0.0, 0.9)
        self.assertEqual(framing["kind"], "person")
        self.assertLess(framing["left"], 0.52)
        self.assertGreater(framing["right"], 0.90)
        self.assertLess(framing["top"], 0.10)

    def test_person_detection_still_runs_when_a_background_face_exists(self):
        if importlib.util.find_spec("cv2") is None:
            self.skipTest("OpenCV is required")
        try:
            import numpy as np
        except ImportError:
            self.skipTest("NumPy is required")
        face_backend = mock.Mock()
        face_backend.face_locations.return_value = [(5, 16, 16, 5)]
        box = mock.Mock()
        box.xyxy = [mock.Mock()]
        box.xyxy[0].tolist.return_value = [42.0, 4.0, 96.0, 98.0]
        box.conf = [mock.Mock()]
        box.conf[0].item.return_value = 0.87
        result = mock.Mock()
        result.boxes = [box]
        model = mock.Mock()
        model.predict.return_value = [result]
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        with (
            mock.patch.object(action_compilation, "_load_face_recognition", return_value=face_backend),
            mock.patch.object(action_compilation, "_load_person_model", return_value=model),
        ):
            subjects = action_compilation.detect_visual_subjects(frame)
        self.assertEqual({item["kind"] for item in subjects}, {"person", "face"})
        person = next(item for item in subjects if item["kind"] == "person")
        self.assertAlmostEqual(person["left"], 0.42, delta=0.001)
        self.assertGreater(person["area"], 0.50)

    def test_portrait_crop_places_left_and_right_subjects_on_thirds(self):
        source_width, source_height = 3840, 2160
        left = portrait_crop(
            source_width, source_height, 1080, 1920,
            subject_x=0.25, subject_y=0.3, subject_kind="face",
        )
        right = portrait_crop(
            source_width, source_height, 1080, 1920,
            subject_x=0.75, subject_y=0.3, subject_kind="face",
        )
        left_width, _, left_x, _ = left
        right_width, _, right_x, _ = right
        self.assertAlmostEqual((source_width * 0.25 - left_x) / left_width, 1 / 3, delta=0.01)
        self.assertAlmostEqual((source_width * 0.75 - right_x) / right_width, 2 / 3, delta=0.01)
        self.assertLess(left_x, (source_width - left_width) / 2)
        self.assertGreater(right_x, (source_width - right_width) / 2)

    def test_portrait_crop_stays_centered_without_a_detected_subject(self):
        crop_width, _, crop_x, _ = portrait_crop(3840, 2160, 1080, 1920)
        self.assertAlmostEqual(crop_x, (3840 - crop_width) / 2, delta=1)

    def test_portrait_framing_contains_a_croppable_foreground_body(self):
        framing = portrait_framing(
            3840, 2160, 1080, 1920,
            subject_x=0.665, subject_y=0.50, subject_kind="person",
            subject_left=0.55, subject_top=0.08,
            subject_right=0.78, subject_bottom=0.98,
        )
        self.assertEqual(framing["mode"], "subject_crop")
        crop_width, _, crop_x, _ = framing["crop"]
        safe_left, _, safe_right, _ = framing["safe_bbox"]
        self.assertLessEqual(crop_x / 3840, safe_left)
        self.assertGreaterEqual((crop_x + crop_width) / 3840, safe_right)

    def test_edge_foreground_body_is_contained_instead_of_centering_background(self):
        framing = portrait_framing(
            3840, 2160, 1080, 1920,
            subject_x=0.125, subject_y=0.5, subject_kind="person",
            subject_left=0.0, subject_top=0.04,
            subject_right=0.25, subject_bottom=0.98,
        )
        self.assertEqual(framing["mode"], "subject_crop")
        crop_width, _, crop_x, _ = framing["crop"]
        self.assertEqual(crop_x, 0)
        self.assertGreaterEqual(crop_width / 3840, 0.25)

    def test_wide_foreground_body_uses_contextual_contain_fallback(self):
        framing = portrait_framing(
            3840, 2160, 1080, 1920,
            subject_x=0.705, subject_y=0.51, subject_kind="person",
            subject_left=0.48, subject_top=0.05,
            subject_right=0.93, subject_bottom=0.98,
        )
        self.assertEqual(framing["mode"], "contextual_contain")
        region_width, region_height, _, _ = framing["region"]
        self.assertGreater(region_width, framing["crop"][0])
        self.assertGreater(region_height, 0)

    def test_portrait_source_uses_blurred_contextual_contain_on_horizontal_canvas(self):
        framing = portrait_framing(1080, 1920, 320, 180)
        self.assertEqual(framing["mode"], "contextual_contain")
        self.assertEqual(framing["region"], (1080, 1920, 0, 0))

        source = SourceInfo("portrait", "/tmp/portrait.mp4", "portrait.mp4", 0, 8.0, 1080, 1920, True)
        shot = candidate(0, 0, 0.9)
        graph = action_compilation._normalization_video_filter(
            source, shot, 320, 180, 12,
        )
        self.assertIn("split=2[background-source][foreground-source]", graph)
        self.assertIn("boxblur=20:1", graph)
        self.assertIn("overlay=(W-w)/2:(H-h)/2", graph)

    def test_hard_cut_filter_uses_normalized_audio_and_video_pairs(self):
        shots = [candidate(0, 0, 0.9), candidate(1, 0, 0.8)]
        graph, video, audio = build_join_filter(shots, transitions=False)
        self.assertIn("[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1", graph)
        self.assertEqual((video, audio), ("[vout]", "[aout]"))

    def test_mixed_join_graph_uses_true_cuts_between_sparse_decorative_transitions(self):
        shots = [candidate(source, 0, 0.9) for source in range(8)]
        transitions = [
            {"kind": "cut", "duration": 0.0},
            {"kind": "cut", "duration": 0.0},
            {"kind": "wipeleft", "duration": 0.2},
            {"kind": "cut", "duration": 0.0},
            {"kind": "cut", "duration": 0.0},
            {"kind": "cut", "duration": 0.0},
            {"kind": "wiperight", "duration": 0.15},
            {"kind": "cut", "duration": 0.0},
        ]
        for shot, transition in zip(shots, transitions):
            shot.transition_out = transition

        graph, video, audio = build_join_filter(shots, transitions=True)

        self.assertEqual(graph.count("xfade="), 2)
        self.assertEqual(graph.count("acrossfade="), 2)
        self.assertEqual(graph.count("concat=n=2:v=1:a=0"), 5)
        self.assertEqual(graph.count("concat=n=2:v=0:a=1"), 5)
        self.assertIn("xfade=transition=wipeleft", graph)
        self.assertIn("xfade=transition=wiperight", graph)
        self.assertNotEqual(video, "[0:v:0]")
        self.assertNotEqual(audio, "[0:a:0]")
        self.assertAlmostEqual(estimated_duration(shots), 15.65)

    def test_cut_boundaries_snap_to_motion_valleys_around_action_peak(self):
        features = [
            {"time": 0.0, "motion": 0.5, "scene": 0.0},
            {"time": 0.8, "motion": 0.05, "scene": 0.1},
            {"time": 1.4, "motion": 0.9, "scene": 0.0},
            {"time": 2.2, "motion": 0.04, "scene": 0.1},
            {"time": 2.8, "motion": 0.5, "scene": 0.0},
        ]
        start, end = snap_window_to_safe_boundaries(features, 2, 1.6, 3.0)
        self.assertEqual((start, end), (0.8, 2.2))

    def test_failed_transition_render_retries_with_hard_cuts(self):
        shots = [candidate(0, 0, 0.9), candidate(1, 0, 0.8)]
        shots[0].transition_out = {"kind": "fade", "duration": 0.2}
        shots[1].transition_out = {"kind": "cut", "duration": 0.0}
        sources = {
            "s0": SourceInfo("s0", "/tmp/s0.mp4", "s0.mp4", 0, 2.0, 160, 90, True),
            "s1": SourceInfo("s1", "/tmp/s1.mp4", "s1.mp4", 1, 2.0, 160, 90, True),
        }
        settings = normalize_settings({"transition_mode": "auto", "output_width": 180, "output_height": 320})
        with tempfile.TemporaryDirectory() as directory:
            commands = []

            def fake_run(command, **_kwargs):
                commands.append(command)
                if len(commands) == 1:
                    raise RuntimeError("synthetic xfade failure")
                return subprocess.CompletedProcess(command, 0, "", "")

            with mock.patch.object(action_compilation, "render_intermediate"), mock.patch.object(action_compilation, "run_command", side_effect=fake_run):
                fallback = render_timeline(
                    shots, sources, Path(directory) / "result.mp4", settings,
                    work_dir=Path(directory),
                )
        self.assertTrue(fallback)
        self.assertIn("xfade=", commands[0][commands[0].index("-filter_complex") + 1])
        self.assertIn("concat=n=2", commands[1][commands[1].index("-filter_complex") + 1])
        self.assertEqual(commands[0][commands[0].index("-pix_fmt") + 1], "yuv420p")
        self.assertEqual(commands[1][commands[1].index("-pix_fmt") + 1], "yuv420p")

    def test_failed_playback_validation_never_publishes_partial_media(self):
        settings = normalize_settings({
            "transition_mode": "none",
            "output_width": 180,
            "output_height": 320,
        })
        sources = [
            SourceInfo("s0", "/tmp/s0.mp4", "s0.mp4", 0, 2.0, 160, 90, True),
            SourceInfo("s1", "/tmp/s1.mp4", "s1.mp4", 1, 2.0, 160, 90, True),
        ]
        shots = [candidate(0, 0, 0.9), candidate(1, 0, 0.8)]
        shots[-1].transition_out = {"kind": "cut", "duration": 0.0}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            manifest.write_text("{}", encoding="utf-8")
            output = root / "montage.mp4"

            def fake_render(_timeline, _sources, partial, _settings, **_kwargs):
                partial.write_bytes(b"not playable" * 200)
                return False

            with (
                mock.patch.object(action_compilation, "load_manifest", return_value=({"settings": settings}, sources)),
                mock.patch.object(action_compilation, "analyze_source", side_effect=[[shots[0]], [shots[1]]]),
                mock.patch.object(action_compilation, "select_timeline", return_value=shots),
                mock.patch.object(action_compilation, "render_timeline", side_effect=fake_render),
                mock.patch.object(action_compilation, "validate_rendered_output", side_effect=RuntimeError("invalid media")),
            ):
                with self.assertRaisesRegex(RuntimeError, "invalid media"):
                    compile_manifest(manifest, output)

            self.assertFalse(output.exists())
            self.assertFalse(output.with_suffix(".json").exists())
            self.assertFalse(output.with_suffix(".mp4.part").exists())
            self.assertFalse(output.with_suffix(".json.part").exists())


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required")
class ActionCompilationTransitionCompatibilityTests(unittest.TestCase):
    def test_ffmpeg_accepts_all_decorative_transition_names(self):
        for transition in ("wipeleft", "wiperight", "slideup", "slidedown"):
            with self.subTest(transition=transition):
                result = subprocess.run([
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                    "-f", "lavfi", "-i", "color=red:size=64x64:rate=10:duration=1",
                    "-f", "lavfi", "-i", "color=blue:size=64x64:rate=10:duration=1",
                    "-filter_complex",
                    f"[0:v][1:v]xfade=transition={transition}:duration=0.1:offset=0.5",
                    "-f", "null", "-",
                ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=10,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe") and importlib.util.find_spec("cv2"),
    "FFmpeg and OpenCV are required",
)
class ActionCompilationRenderTests(unittest.TestCase):
    def _source(self, path: Path, pattern: str, frequency: int | None, audio_duration: float = 2.6) -> None:
        command = [
            "ffmpeg", "-y", "-nostdin", "-v", "error",
            "-f", "lavfi", "-i", f"{pattern}=size=160x90:rate=12",
        ]
        if frequency is not None:
            command += [
                "-f", "lavfi", "-i",
                f"sine=frequency={frequency}:sample_rate=48000:duration={audio_duration}",
            ]
        command += ["-t", "2.6", "-c:v", "libx264", "-pix_fmt", "yuv420p"]
        if frequency is not None:
            command += ["-c:a", "aac"]
        command += [str(path)]
        subprocess.run(command, check=True)

    def test_two_sources_render_to_vertical_compilation_with_sidecar(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.mp4"
            second = root / "second.mp4"
            # Exercise both an audio stream shorter than its video and a
            # video-only source. The renderer must normalize both to full,
            # equal-length stereo streams before building transitions.
            self._source(first, "testsrc2", 440, audio_duration=0.7)
            self._source(second, "smptebars", None)
            manifest = root / "manifest.json"
            output = root / "montage.mp4"
            manifest.write_text(json.dumps({
                "name": "Synthetic action",
                "settings": {
                    "goal": "fast_action", "target_duration_sec": 4,
                    "pacing": "rapid", "transition_mode": "auto",
                    "selection_mode": "use_every_clip", "order_mode": "ai",
                    "output_width": 180, "output_height": 320, "fps": 12,
                },
                "sources": [
                    {"id": "first", "path": str(first), "name": first.name},
                    {"id": "second", "path": str(second), "name": second.name},
                ],
            }), encoding="utf-8")

            result = compile_manifest(manifest, output)
            self.assertTrue(output.is_file())
            self.assertGreater(output.stat().st_size, 1000)
            self.assertEqual(result["source_kind"], "action_compilation")
            self.assertGreaterEqual(len(result["shots"]), 2)
            self.assertEqual({shot["source_id"] for shot in result["shots"]}, {"first", "second"})
            sidecar = json.loads(output.with_suffix(".json").read_text(encoding="utf-8"))
            self.assertEqual(sidecar["compilation_name"], "Synthetic action")
            self.assertTrue(all("path" not in source for source in sidecar["sources"]))
            self.assertTrue(all("source_path" not in shot for shot in sidecar["shots"]))
            self.assertFalse(output.with_suffix(".mp4.part").exists())
            self.assertFalse(output.with_suffix(".json.part").exists())
            probe = subprocess.run([
                "ffprobe", "-v", "error",
                "-show_entries", "stream=codec_type,width,height,pix_fmt",
                "-of", "json", str(output),
            ], check=True, text=True, stdout=subprocess.PIPE)
            streams = json.loads(probe.stdout)["streams"]
            video = next(stream for stream in streams if stream["codec_type"] == "video")
            self.assertEqual((video["width"], video["height"]), (180, 320))
            self.assertEqual(video["pix_fmt"], "yuv420p")
            self.assertTrue(any(stream["codec_type"] == "audio" for stream in streams))
            duration_probe = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(output),
            ], check=True, text=True, stdout=subprocess.PIPE)
            self.assertAlmostEqual(float(duration_probe.stdout.strip()), sidecar["duration"], delta=0.2)
            self.assertTrue(sidecar["media_validation"]["passed"])
            self.assertEqual(sidecar["media_validation"]["pixel_format"], "yuv420p")
            self.assertTrue(sidecar["source_spacing"]["unique_moments"])
            self.assertFalse(sidecar["source_spacing"]["adjacent_repeats"])
            self.assertLessEqual(sidecar["source_spacing"]["maximum_reused_source_overlap"], 0.08)
            if sidecar["source_spacing"]["repeated_source_count"]:
                self.assertGreaterEqual(sidecar["source_spacing"]["minimum_intervening_shots"], 1)
            else:
                self.assertIsNone(sidecar["source_spacing"]["minimum_intervening_shots"])

    def test_single_source_renders_to_horizontal_longform_compilation_with_sidecar(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "long-source.mp4"
            self._source(source, "testsrc2", 440)
            manifest = root / "manifest.json"
            output = root / "horizontal-montage.mp4"
            manifest.write_text(json.dumps({
                "name": "Synthetic long-form montage",
                "format": "horizontal_longform",
                "settings": {
                    "format": "horizontal_longform",
                    "goal": "cinematic", "target_duration_sec": 60,
                    "pacing": "balanced", "transition_mode": "none",
                    "selection_mode": "best_moments", "order_mode": "ai",
                    "output_width": 320, "output_height": 180, "fps": 12,
                },
                "sources": [
                    {"id": "only", "path": str(source), "name": source.name},
                ],
            }), encoding="utf-8")

            result = compile_manifest(manifest, output)

            self.assertTrue(output.is_file())
            self.assertEqual(result["kind"], "longform")
            self.assertEqual(result["source_kind"], "action_compilation")
            self.assertEqual(result["montage_format"], "horizontal_longform")
            self.assertEqual(result["export_preset"], "youtube_1080p")
            self.assertEqual(len(result["sources"]), 1)
            self.assertTrue(result["shots"])
            sidecar = json.loads(output.with_suffix(".json").read_text(encoding="utf-8"))
            self.assertEqual(sidecar["kind"], "longform")
            self.assertEqual(sidecar["montage_format"], "horizontal_longform")
            self.assertEqual(sidecar["settings"]["format"], "horizontal_longform")
            probe = subprocess.run([
                "ffprobe", "-v", "error",
                "-show_entries", "stream=codec_type,width,height,pix_fmt",
                "-of", "json", str(output),
            ], check=True, text=True, stdout=subprocess.PIPE)
            streams = json.loads(probe.stdout)["streams"]
            video = next(stream for stream in streams if stream["codec_type"] == "video")
            self.assertEqual((video["width"], video["height"]), (320, 180))
            self.assertEqual(video["pix_fmt"], "yuv420p")
            self.assertTrue(any(stream["codec_type"] == "audio" for stream in streams))

    def test_contextual_contain_path_renders_a_playable_vertical_shot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "wide-subject.mp4"
            self._source(source_path, "testsrc2", 440)
            source = SourceInfo(
                "wide", str(source_path), source_path.name, 0,
                2.6, 160, 90, True,
            )
            shot = Candidate(
                id="wide-001", source_id=source.id, source_order=0,
                source_path=source.path, source_name=source.name,
                start=0.1, end=1.1, score=0.9, motion=0.5,
                scene_change=0.2, reasons=["full-costume safe framing"],
                subject_x=0.68, subject_y=0.50, subject_kind="person",
                subject_confidence=0.85, subject_count=3,
                subject_left=0.42, subject_top=0.03,
                subject_right=0.95, subject_bottom=0.99,
                framing_mode="contextual_contain",
            )
            output = root / "contained.mp4"
            settings = normalize_settings({
                "output_width": 180, "output_height": 320, "fps": 12,
            })
            action_compilation.render_intermediate(
                shot, source, output, settings, ffmpeg_bin="ffmpeg",
            )
            probe = subprocess.run([
                "ffprobe", "-v", "error",
                "-show_entries", "stream=codec_type,width,height,pix_fmt:format=duration",
                "-of", "json", str(output),
            ], check=True, text=True, stdout=subprocess.PIPE)
            media = json.loads(probe.stdout)
            video = next(stream for stream in media["streams"] if stream["codec_type"] == "video")
            self.assertEqual((video["width"], video["height"]), (180, 320))
            self.assertEqual(video["pix_fmt"], "yuv420p")
            self.assertAlmostEqual(float(media["format"]["duration"]), 1.0, delta=0.2)

    def test_rotated_phone_metadata_uses_display_dimensions_before_cropping(self):
        help_result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-h", "full"],
            check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        if "display_rotation" not in help_result.stdout:
            self.skipTest("FFmpeg display_rotation support is required")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            encoded = root / "encoded-landscape.mp4"
            rotated = root / "phone-portrait.mp4"
            subprocess.run([
                "ffmpeg", "-y", "-nostdin", "-v", "error",
                "-f", "lavfi", "-i", "testsrc2=size=200x100:rate=12:duration=1.4",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.4",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                str(encoded),
            ], check=True)
            subprocess.run([
                "ffmpeg", "-y", "-nostdin", "-v", "error",
                "-display_rotation", "90", "-i", str(encoded),
                "-c", "copy", str(rotated),
            ], check=True)

            probed = action_compilation.probe_media(rotated)
            self.assertEqual((probed.width, probed.height), (100, 200))
            source = SourceInfo(
                "rotated", probed.path, rotated.name, 0, probed.duration,
                probed.width, probed.height, probed.has_audio,
            )
            shot = Candidate(
                id="rotated-001", source_id=source.id, source_order=0,
                source_path=source.path, source_name=source.name,
                start=0.1, end=1.1, score=0.9, motion=0.5,
                scene_change=0.2, reasons=["rotation-safe framing"],
                subject_x=0.5, subject_y=0.5, subject_kind="person",
                subject_confidence=0.9, subject_count=1,
                subject_left=0.05, subject_top=0.03,
                subject_right=0.95, subject_bottom=0.98,
            )
            output = root / "rotation-safe.mp4"
            settings = normalize_settings({
                "output_width": 180, "output_height": 320, "fps": 12,
            })
            self.assertEqual(
                portrait_framing(
                    source.width, source.height, 180, 320,
                    subject_x=shot.subject_x, subject_y=shot.subject_y,
                    subject_kind=shot.subject_kind,
                    subject_left=shot.subject_left, subject_top=shot.subject_top,
                    subject_right=shot.subject_right, subject_bottom=shot.subject_bottom,
                )["mode"],
                "contextual_contain",
            )
            action_compilation.render_intermediate(
                shot, source, output, settings, ffmpeg_bin="ffmpeg",
            )
            media = json.loads(subprocess.run([
                "ffprobe", "-v", "error",
                "-show_entries", "stream=codec_type,width,height,pix_fmt:format=duration",
                "-of", "json", str(output),
            ], check=True, text=True, stdout=subprocess.PIPE).stdout)
            video = next(stream for stream in media["streams"] if stream["codec_type"] == "video")
            self.assertEqual((video["width"], video["height"]), (180, 320))
            self.assertEqual(video["pix_fmt"], "yuv420p")

    def test_mixed_creator_cadence_renders_all_four_effects_without_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "creator-source.mp4"
            self._source(source_path, "testsrc2", 440)
            source = SourceInfo(
                "creator", str(source_path), source_path.name, 0,
                2.6, 160, 90, True,
            )
            settings = normalize_settings({
                "pacing": "fast", "transition_mode": "auto",
                "output_width": 160, "output_height": 160, "fps": 12,
            })
            timeline = []
            for index in range(15):
                start = (index % 3) * 0.55
                shot = Candidate(
                    id=f"creator-{index}", source_id=source.id,
                    source_order=0, source_path=source.path,
                    source_name=source.name, start=start, end=start + 0.90,
                    score=0.8, motion=0.5, scene_change=0.2,
                    reasons=["creator cadence smoke"],
                )
                shot.transition_out = action_compilation._transition_for(shot, index, settings)
                timeline.append(shot)
            timeline[-1].transition_out = {"kind": "cut", "duration": 0.0}

            output = root / "creator-mix.mp4"
            fallback = render_timeline(
                timeline, {source.id: source}, output, settings,
                work_dir=root / "work",
            )
            self.assertFalse(fallback)
            self.assertTrue(output.is_file())
            self.assertEqual(
                {item.transition_out.get("kind") for item in timeline if item.transition_out.get("kind") != "cut"},
                {"wipeleft", "wiperight", "slideup", "slidedown"},
            )
            probe = subprocess.run([
                "ffprobe", "-v", "error",
                "-show_entries", "stream=codec_type,pix_fmt:format=duration",
                "-of", "json", str(output),
            ], check=True, text=True, stdout=subprocess.PIPE)
            media = json.loads(probe.stdout)
            video = next(stream for stream in media["streams"] if stream["codec_type"] == "video")
            self.assertEqual(video["pix_fmt"], "yuv420p")
            self.assertAlmostEqual(
                float(media["format"]["duration"]), estimated_duration(timeline), delta=0.35,
            )

    def test_validation_rejects_incompatible_yuv444p_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "incompatible.mp4"
            subprocess.run([
                "ffmpeg", "-y", "-nostdin", "-v", "error",
                "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=1",
                "-vf", "format=yuv444p", "-c:v", "libx264", "-pix_fmt", "yuv444p",
                str(output),
            ], check=True)
            with self.assertRaisesRegex(RuntimeError, "incompatible pixel format yuv444p"):
                validate_rendered_output(
                    output,
                    expected_duration=1.0,
                    expected_width=160,
                    expected_height=90,
                )


if __name__ == "__main__":
    unittest.main()
