import json
import os
import subprocess
import sys
import textwrap
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHON_CANDIDATES = [
    os.path.join(ROOT, "venv", "bin", "python"),
    os.path.join(ROOT, ".venv", "bin", "python"),
    os.path.join(ROOT, "venv", "Scripts", "python.exe"),
    os.path.join(ROOT, ".venv", "Scripts", "python.exe"),
]
APP_PYTHON = next((path for path in PYTHON_CANDIDATES if os.path.exists(path)), sys.executable)


@unittest.skipUnless(os.path.exists(APP_PYTHON), "Application Python is required")
class SpeakerDiarizationIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        program = textwrap.dedent(
            """
            import inspect
            import json
            import sys
            sys.argv = ['viral_factory.py', '--mode', 'rerender']
            import viral_factory as vf

            words = vf.collect_word_timestamps([
                {
                    'start': 10.0,
                    'end': 11.0,
                    'speaker': 'speaker_0',
                    'speaker_confidence': 0.78,
                    'words': [
                        {'word': 'hello', 'start': 10.0, 'end': 10.4},
                        {
                            'word': 'there', 'start': 10.45, 'end': 10.9,
                            'speaker': 'speaker_1', 'speaker_confidence': 0.96,
                        },
                    ],
                }
            ])
            segment = {
                'start': 20.0,
                'end': 21.0,
                'text': 'speaker metadata survives',
                'speaker': 'speaker_0',
                'speaker_confidence': 0.88,
                'speakers': ['speaker_0'],
                'candidate_score': 7.0,
                'reasons': ['Clear Payoff'],
                'words': [{
                    'word': 'survives', 'start': 20.2, 'end': 20.8,
                    'speaker': 'speaker_0', 'speaker_confidence': 0.9,
                }],
            }
            clip = vf.clip_from_intelligence_window(
                {'id': 'window', 'start': 20.0, 'end': 21.0}, [segment]
            )
            layout = vf.normalize_frame_layout(
                {
                    'mode': 'smart_switch',
                    'static_center': 600,
                    'switch_segments': [{
                        'start': 0.0, 'end': 1.0, 'track_id': 2,
                        'center_x': 600, 'center_y': 320, 'crop_height': 700,
                        'speaker': 'speaker_0', 'speaker_confidence': 0.91,
                        'speakers': ['speaker_0'],
                    }],
                },
                1920,
                1080,
            )
            signature = inspect.signature(vf.analyze_speaker_layout)
            print(json.dumps({
                'words': words,
                'clip': clip,
                'layout_segment': layout['switch_segments'][0],
                'has_clip_words': 'clip_words' in signature.parameters,
                'clip_words_default_is_none': signature.parameters['clip_words'].default is None,
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
        cls.payload = json.loads(result.stdout.strip().splitlines()[-1])

    def test_word_collection_preserves_segment_and_word_speaker_confidence(self):
        words = self.payload["words"]
        self.assertEqual(words[0]["speaker"], "speaker_0")
        self.assertEqual(words[0]["speaker_confidence"], 0.78)
        self.assertEqual(words[1]["speaker"], "speaker_1")
        self.assertEqual(words[1]["speaker_confidence"], 0.96)

    def test_candidate_merge_preserves_diarized_words_and_segment_fields(self):
        clip = self.payload["clip"]
        self.assertEqual(clip["words"][0]["speaker"], "speaker_0")
        self.assertEqual(clip["words"][0]["speaker_confidence"], 0.9)
        self.assertEqual(clip["segments"][0]["speaker"], "speaker_0")
        self.assertEqual(clip["segments"][0]["speaker_confidence"], 0.88)

    def test_layout_normalization_preserves_merged_speaker_fields(self):
        segment = self.payload["layout_segment"]
        self.assertEqual(segment["speaker"], "speaker_0")
        self.assertEqual(segment["speaker_confidence"], 0.91)
        self.assertEqual(segment["speakers"], ["speaker_0"])

    def test_layout_api_accepts_clip_words_without_breaking_existing_callers(self):
        self.assertTrue(self.payload["has_clip_words"])
        self.assertTrue(self.payload["clip_words_default_is_none"])


if __name__ == "__main__":
    unittest.main()
