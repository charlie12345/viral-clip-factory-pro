import unittest

from shorts_yield import active_speech_duration, transcript_for_analysis_range


class ShortsRangeTests(unittest.TestCase):
    def test_analysis_range_filters_and_clamps_segments_and_words(self):
        transcript = {
            "segments": [
                {
                    "start": 0,
                    "end": 5,
                    "text": "before",
                    "words": [{"word": "before", "start": 1, "end": 2}],
                },
                {
                    "start": 8,
                    "end": 14,
                    "text": "inside edge",
                    "words": [
                        {"word": "inside", "start": 9, "end": 10.5},
                        {"word": "edge", "start": 12.5, "end": 14},
                    ],
                },
                {"start": 16, "end": 18, "text": "after", "words": []},
            ]
        }
        result = transcript_for_analysis_range(transcript, 10, 13)
        self.assertEqual(len(result["segments"]), 1)
        segment = result["segments"][0]
        self.assertEqual((segment["start"], segment["end"]), (10.0, 13.0))
        self.assertEqual(segment["words"][0]["start"], 10.0)
        self.assertEqual(segment["words"][-1]["end"], 13.0)

    def test_active_speech_duration_merges_overlap(self):
        duration = active_speech_duration([
            {"start": 0, "end": 3},
            {"start": 2, "end": 5},
            {"start": 8, "end": 10},
        ])
        self.assertEqual(duration, 7.0)
if __name__ == "__main__":
    unittest.main()
