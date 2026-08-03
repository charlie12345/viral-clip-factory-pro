import unittest

from speaker_tracking import (
    SmartSpeakerTracker,
    TrackingConfig,
    build_diarization_timeline,
    diarization_cue_at_time,
    merge_speaker_samples,
)


def face(cx, cy, motion=0.0, width=180, height=190):
    return {
        "cx": cx,
        "cy": cy,
        "left": cx - width / 2,
        "right": cx + width / 2,
        "top": cy - height / 2,
        "bottom": cy + height / 2,
        "area": width * height,
        "kind": "face",
        "motion": motion,
    }


def person(cx, cy, motion=0.0, width=320, height=650):
    result = face(cx, cy, motion, width, height)
    result["kind"] = "person"
    return result


def quick_config(**overrides):
    values = {
        "mouth_motion_threshold": 1.0,
        "live_window_samples": 5,
        "live_min_face_samples": 2,
        "live_min_motion_hits": 2,
        "switch_confirm_samples": 2,
        "min_switch_interval_sec": 0.0,
        "hold_missing_sec": 2.0,
    }
    values.update(overrides)
    return TrackingConfig(**values)


class SmartSpeakerTrackerTests(unittest.TestCase):
    def test_static_avatar_never_becomes_live_or_wins_by_area(self):
        tracker = SmartSpeakerTracker(1920, 1080, quick_config())
        samples = []
        for index in range(4):
            sample = tracker.update(
                index * 0.45,
                [
                    face(430, 350, motion=0.0, width=390, height=390),
                    face(1320 + (index % 2) * 5, 360, motion=2.4),
                ],
            )
            if sample:
                samples.append(sample)

        self.assertTrue(samples)
        self.assertTrue(all(sample["center_x"] > 1200 for sample in samples))
        snapshots = tracker.track_snapshots()
        avatar = min(snapshots, key=lambda item: item["center_x"])
        self.assertFalse(avatar["verified_live"])
        self.assertEqual(avatar["motion_hits"], 0)

    def test_person_detection_cannot_start_or_qualify_camera_track(self):
        tracker = SmartSpeakerTracker(1920, 1080, quick_config())
        self.assertIsNone(tracker.update(0.0, [person(600, 500, motion=9.0)]))
        self.assertEqual(tracker.track_snapshots(), [])
        self.assertIsNone(tracker.update(0.45, [face(600, 350, motion=2.0)]))
        selected = tracker.update(0.9, [face(604, 352, motion=2.0)])
        self.assertIsNotNone(selected)
        self.assertEqual(len(tracker.track_snapshots()), 1)

    def test_vertical_alignment_keeps_two_distinct_2d_tracks(self):
        tracker = SmartSpeakerTracker(1920, 1080, quick_config())
        tracker.update(0.0, [face(810, 260, 2.0), face(806, 790, 0.0)])
        tracker.update(0.45, [face(811, 792, 2.0), face(804, 264, 2.0)])
        snapshots = tracker.track_snapshots()

        self.assertEqual(len(snapshots), 2)
        self.assertNotEqual(snapshots[0]["track_id"], snapshots[1]["track_id"])
        self.assertGreater(abs(snapshots[0]["center_y"] - snapshots[1]["center_y"]), 450)

    def test_holds_verified_speaker_during_quiet_and_missed_samples(self):
        tracker = SmartSpeakerTracker(1920, 1080, quick_config())
        tracker.update(0.0, [face(550, 360, 2.0)])
        live = tracker.update(0.45, [face(554, 362, 2.0)])
        quiet = tracker.update(0.9, [face(551, 359, 0.0)])
        missed = tracker.update(1.35, [])

        self.assertEqual(live["track_id"], quiet["track_id"])
        self.assertEqual(live["track_id"], missed["track_id"])
        self.assertFalse(quiet["held"])
        self.assertTrue(missed["held"])
        self.assertLess(abs(missed["center_x"] - 552), 6)

    def test_switch_requires_consecutive_challenger_frames(self):
        tracker = SmartSpeakerTracker(1920, 1080, quick_config())
        tracker.update(0.0, [face(550, 360, 2.5), face(1320, 360, 2.0)])
        first = tracker.update(0.45, [face(552, 360, 2.5), face(1318, 360, 2.0)])
        first_id = first["track_id"]

        # One spike is not enough to leave the current speaker.
        spike = tracker.update(0.9, [face(551, 360, 0.0), face(1321, 360, 3.0)])
        reset = tracker.update(1.35, [face(550, 360, 2.5), face(1320, 360, 0.0)])
        challenge_one = tracker.update(1.8, [face(549, 360, 0.0), face(1322, 360, 3.0)])
        switched = tracker.update(2.25, [face(551, 360, 0.0), face(1319, 360, 3.0)])

        self.assertEqual(spike["track_id"], first_id)
        self.assertEqual(reset["track_id"], first_id)
        self.assertEqual(challenge_one["track_id"], first_id)
        self.assertNotEqual(switched["track_id"], first_id)
        self.assertGreater(switched["center_x"], 1250)

    def test_jittered_switch_segments_never_create_midpoint_crop(self):
        tracker = SmartSpeakerTracker(1920, 1080, quick_config())
        samples = []
        frames = [
            (0.00, 548, 1317, 2.4, 0.0),
            (0.45, 554, 1323, 2.5, 0.0),
            (0.90, 546, 1318, 2.1, 0.0),
            (1.35, 552, 1325, 0.0, 2.6),
            (1.80, 549, 1316, 0.0, 2.8),
            (2.25, 555, 1322, 0.0, 2.7),
            (2.70, 547, 1319, 0.0, 2.5),
        ]
        for time_sec, left_x, right_x, left_motion, right_motion in frames:
            sample = tracker.update(
                time_sec,
                [face(left_x, 360, left_motion), face(right_x, 362, right_motion)],
            )
            if sample:
                samples.append(sample)

        segments = merge_speaker_samples(samples, clip_duration=3.2, min_segment_sec=0.5)
        centers = [segment["center_x"] for segment in segments]
        self.assertTrue(any(abs(center - 550) < 20 for center in centers))
        self.assertTrue(any(abs(center - 1320) < 20 for center in centers))
        self.assertTrue(all(not 850 < center < 1100 for center in centers))
        self.assertTrue(all("center_y" in segment for segment in segments))
        self.assertTrue(all(segment["suggested_crop_height"] > 0 for segment in segments))

    def test_short_foreign_segment_is_suppressed_without_center_mixing(self):
        samples = [
            {"time": 0.0, "track_id": 1, "center_x": 548, "center_y": 350, "suggested_crop_height": 720},
            {"time": 1.0, "track_id": 1, "center_x": 552, "center_y": 354, "suggested_crop_height": 724},
            {"time": 1.2, "track_id": 2, "center_x": 1320, "center_y": 360, "suggested_crop_height": 700},
            {"time": 1.35, "track_id": 1, "center_x": 550, "center_y": 352, "suggested_crop_height": 722},
            {"time": 2.5, "track_id": 1, "center_x": 549, "center_y": 351, "suggested_crop_height": 721},
        ]
        segments = merge_speaker_samples(samples, clip_duration=3.0, min_segment_sec=0.5)

        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["track_id"], 1)
        self.assertLess(abs(segments[0]["center_x"] - 550), 4)
        self.assertNotAlmostEqual(segments[0]["center_x"], 961, delta=100)

    def test_detected_crop_top_is_preserved_per_speaker_segment(self):
        samples = [
            {"time": 0.0, "track_id": 1, "center_x": 600, "center_y": 320, "suggested_crop_height": 454, "crop_top": 82},
            {"time": 0.5, "track_id": 1, "center_x": 604, "center_y": 324, "suggested_crop_height": 454, "crop_top": 88},
            {"time": 1.0, "track_id": 1, "center_x": 602, "center_y": 322, "suggested_crop_height": 454, "crop_top": 86},
        ]

        segments = merge_speaker_samples(samples, clip_duration=1.5, min_segment_sec=0.2)

        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["crop_top"], 86)

    def test_diarization_preference_can_select_a_verified_visible_track(self):
        tracker = SmartSpeakerTracker(1920, 1080, quick_config(switch_confirm_samples=3))
        tracker.update(0.0, [face(520, 350, 2.5), face(1360, 350, 2.5)])
        initial = tracker.update(0.45, [face(520, 350, 2.5), face(1360, 350, 2.5)])
        snapshots = tracker.track_snapshots()
        right_id = max(snapshots, key=lambda item: item["center_x"])["track_id"]

        preferred = tracker.update(
            0.9,
            [face(520, 350, 2.0), face(1360, 350, 1.5)],
            preferred_track_id=right_id,
        )

        self.assertNotEqual(initial["track_id"], right_id)
        self.assertEqual(preferred["track_id"], right_id)

    def test_diarization_labels_learn_tracks_then_override_conflicting_motion(self):
        tracker = SmartSpeakerTracker(
            1920,
            1080,
            quick_config(switch_confirm_samples=4, diarization_confirm_samples=2),
        )
        tracker.update(
            0.0,
            [face(520, 350, 3.0), face(1360, 350, 1.2)],
            speaker_label="Speaker A",
        )
        tracker.update(
            0.45,
            [face(520, 350, 3.0), face(1360, 350, 1.2)],
            speaker_label="Speaker A",
        )
        tracker.update(
            0.9,
            [face(520, 350, 3.0), face(1360, 350, 1.2)],
            speaker_label="Speaker A",
        )

        tracker.update(
            1.35,
            [face(520, 350, 0.0), face(1360, 350, 3.2)],
            speaker_label="Speaker B",
        )
        learned_b = tracker.update(
            1.8,
            [face(520, 350, 0.0), face(1360, 350, 3.2)],
            speaker_label="Speaker B",
            speaker_confidence=0.93,
        )

        self.assertGreater(learned_b["center_x"], 1300)
        self.assertEqual(learned_b["speaker"], "Speaker B")
        self.assertEqual(learned_b["speaker_confidence"], 0.93)
        self.assertEqual(set(tracker.speaker_track_map), {"speaker a", "speaker b"})

        low_confidence = tracker.update(
            2.025,
            [face(520, 350, 0.1), face(1360, 350, 3.3)],
            speaker_label="Speaker A",
            speaker_confidence=0.2,
        )
        self.assertGreater(low_confidence["center_x"], 1300)

        preferred_a = tracker.update(
            2.25,
            [face(520, 350, 0.1), face(1360, 350, 3.3)],
            speaker_label="Speaker A",
        )
        self.assertLess(preferred_a["center_x"], 600)

    def test_ambiguous_motion_does_not_create_a_speaker_mapping(self):
        tracker = SmartSpeakerTracker(1920, 1080, quick_config())
        for index in range(4):
            tracker.update(
                index * 0.45,
                [face(520, 350, 2.5), face(1360, 350, 2.5)],
                speaker_label="Speaker A",
            )
        self.assertEqual(tracker.speaker_track_map, {})

    def test_relative_diarization_words_are_mapped_to_source_time(self):
        timeline = build_diarization_timeline(
            [
                {"word": "hello", "start": 0.0, "end": 0.4, "speaker": 0, "speaker_confidence": 0.8},
                {"word": "there", "start": 0.45, "end": 0.9, "speaker": 1, "speaker_confidence": 0.95},
            ],
            clip_start=100.0,
            clip_end=102.0,
        )

        self.assertEqual((timeline[0]["start"], timeline[0]["end"]), (100.0, 100.4))
        self.assertEqual(diarization_cue_at_time(timeline, 100.2)["speaker"], 0)
        cue = diarization_cue_at_time(timeline, 100.7)
        self.assertEqual(cue["speaker"], 1)
        self.assertEqual(cue["speaker_confidence"], 0.95)

    def test_merged_segments_preserve_diarization_metadata(self):
        samples = [
            {
                "time": 0.0,
                "track_id": 1,
                "center_x": 600,
                "center_y": 330,
                "suggested_crop_height": 700,
                "speaker": "speaker_0",
                "speaker_confidence": 0.8,
            },
            {
                "time": 0.5,
                "track_id": 1,
                "center_x": 604,
                "center_y": 332,
                "suggested_crop_height": 704,
                "speaker": "speaker_0",
                "speaker_confidence": 0.9,
            },
        ]
        segments = merge_speaker_samples(samples, clip_duration=1.0, min_segment_sec=0.2)

        self.assertEqual(segments[0]["speaker"], "speaker_0")
        self.assertEqual(segments[0]["speaker_confidence"], 0.85)


if __name__ == "__main__":
    unittest.main()
