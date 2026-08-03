import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_PYTHON = os.path.join(ROOT, "venv", "bin", "python")
if not os.path.exists(APP_PYTHON):
    APP_PYTHON = sys.executable


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
class LongformCreativeRenderTests(unittest.TestCase):
    def _ffmpeg(self, *args):
        subprocess.run(
            ["ffmpeg", "-y", "-nostdin", "-v", "error", *args],
            check=True,
            stdin=subprocess.DEVNULL,
            timeout=30,
        )

    def test_titles_broll_music_and_audio_finish_render_together(self):
        with tempfile.TemporaryDirectory(prefix="vcf-longform-test-") as directory:
            source = os.path.join(directory, "source.mp4")
            broll = os.path.join(directory, "broll.mp4")
            music = os.path.join(directory, "music.wav")
            project_path = os.path.join(directory, "project.json")
            output = os.path.join(directory, "finished.mp4")

            self._ffmpeg(
                "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2.4",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2.4",
                "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
            )
            self._ffmpeg(
                "-f", "lavfi", "-i", "color=c=royalblue:size=320x180:rate=24:duration=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", broll,
            )
            self._ffmpeg(
                "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=1",
                "-c:a", "pcm_s16le", music,
            )

            project = {
                "source": source,
                "source_duration_sec": 2.4,
                "selected_range": {"start": 0, "end": 2.4},
                "cuts": [{"id": "pause", "start": 0.8, "end": 1.0, "enabled": True}],
                "silence": {
                    "enabled": True,
                    "audio_fade_sec": 0.02,
                    "video_fade_sec": 0,
                    "normalize_audio": True,
                    "target_lufs": -14,
                    "limiter_db": -1.5,
                    "denoise": True,
                },
                "creative": {
                    "exportPreset": "source",
                    "transitions": [
                        {
                            "id": "join",
                            "cutId": "pause",
                            "joinIndex": 0,
                            "type": "dissolve",
                            "duration": 0.2,
                        }
                    ],
                    "titles": [
                        {
                            "id": "title",
                            "text": "Test title",
                            "subtitle": "Professional finishing",
                            "start": 0.1,
                            "end": 0.7,
                            "style": "center_card",
                            "template": "broadcast",
                            "alignment": "center",
                            "animation": "fade",
                            "accentColor": "#22C55E",
                            "backgroundColor": "#09090B",
                            "textColor": "#FFFFFF",
                            "x": 0.18,
                            "y": 0.2,
                            "width": 0.64,
                            "scale": 0.82,
                        },
                        {
                            "id": "lower",
                            "text": "Ada Lovelace",
                            "subtitle": "Editor",
                            "start": 1.2,
                            "end": 1.9,
                            "style": "lower_third",
                            "template": "glass",
                            "alignment": "left",
                            "animation": "slide",
                            "accentColor": "#8B5CF6",
                            "backgroundColor": "#111827",
                            "textColor": "#FFFFFF",
                            "x": 0.34,
                            "y": 0.62,
                            "width": 0.52,
                            "scale": 0.72,
                        },
                    ],
                    "broll": [
                        {"id": "cutaway", "path": broll, "start": 1.1, "end": 1.6}
                    ],
                    "color": {
                        "exposure": 0.02,
                        "contrast": 1.06,
                        "saturation": 1.08,
                        "temperature": 0.12,
                        "sharpen": 0.2,
                    },
                    "musicPath": music,
                    "musicVolume": 0.08,
                    "musicDucking": True,
                },
            }
            with open(project_path, "w", encoding="utf-8") as handle:
                json.dump(project, handle)

            result = subprocess.run(
                [
                    APP_PYTHON,
                    os.path.join(ROOT, "viral_factory.py"),
                    source,
                    "--mode", "longform-edit",
                    "--longform-json", project_path,
                    "--longform-output", output,
                    "--video-encoder", "cpu",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                stdin=subprocess.DEVNULL,
                timeout=90,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(os.path.exists(output))

            probe = subprocess.run(
                [
                    "ffprobe", "-v", "error", "-show_entries", "format=duration",
                    "-show_entries", "stream=codec_type", "-of", "json", output,
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
            info = json.loads(probe.stdout)
            self.assertEqual({stream["codec_type"] for stream in info["streams"]}, {"video", "audio"})
            self.assertAlmostEqual(float(info["format"]["duration"]), 2.0, delta=0.18)

            with open(output.replace(".mp4", ".json"), encoding="utf-8") as handle:
                metadata = json.load(handle)
            self.assertNotIn("musicPath", metadata["creative"])
            self.assertNotIn("path", metadata["creative"]["broll"][0])
            self.assertNotIn("joinIndex", metadata["creative"]["transitions"][0])
            self.assertAlmostEqual(metadata["transition_overlap_sec"], 0.2, places=3)
            self.assertEqual(
                {
                    key: metadata["creative"]["titles"][1][key]
                    for key in ("x", "y", "width", "scale")
                },
                {"x": 0.34, "y": 0.62, "width": 0.52, "scale": 0.72},
            )

    def test_v2_motion_captions_adjustments_audio_offsets_and_multicam_render(self):
        with tempfile.TemporaryDirectory(prefix="vcf-longform-v2-test-") as directory:
            source = os.path.join(directory, "source.mp4")
            broll = os.path.join(directory, "broll.mp4")
            angle = os.path.join(directory, "angle.mp4")
            lut = os.path.join(directory, "identity.cube")
            project_path = os.path.join(directory, "project.json")
            output = os.path.join(directory, "finished.mp4")

            self._ffmpeg(
                "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=3",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
                "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
            )
            self._ffmpeg(
                "-f", "lavfi", "-i", "color=c=royalblue:size=240x180:rate=24:duration=1.2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", broll,
            )
            self._ffmpeg(
                "-f", "lavfi", "-i", "color=c=darkgreen:size=320x180:rate=24:duration=3",
                "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=3",
                "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", angle,
            )
            with open(lut, "w", encoding="utf-8") as handle:
                handle.write(
                    "TITLE \"Identity\"\n"
                    "LUT_3D_SIZE 2\n"
                    "DOMAIN_MIN 0 0 0\n"
                    "DOMAIN_MAX 1 1 1\n"
                    "0 0 0\n"
                    "1 0 0\n"
                    "0 1 0\n"
                    "1 1 0\n"
                    "0 0 1\n"
                    "1 0 1\n"
                    "0 1 1\n"
                    "1 1 1\n"
                )

            project = {
                "source": source,
                "source_duration_sec": 3,
                "selected_range": {"start": 0, "end": 3},
                "cuts": [],
                "render_segments": [
                    {"start": 0, "end": 1.2},
                    {"start": 1.2, "end": 3},
                ],
                "silence": {
                    "enabled": False,
                    "audio_fade_sec": 0,
                    "video_fade_sec": 0,
                    "normalize_audio": True,
                    "target_lufs": -14,
                    "limiter_db": -1.5,
                    "denoise": False,
                },
                "words": [
                    {"word": "Professional", "start": 0.2, "end": 0.6},
                    {"word": "captions", "start": 0.62, "end": 0.95},
                ],
                "creative": {
                    "exportPreset": "source",
                    "editPoints": [{"id": "blade", "time": 1.2, "label": "Blade"}],
                    "transitions": [{
                        "id": "jl",
                        "cutId": "blade",
                        "joinIndex": 0,
                        "type": "cut",
                        "duration": 0,
                        "audioOffsetSec": 0.12,
                    }],
                    "titles": [],
                    "broll": [{
                        "id": "motion",
                        "path": broll,
                        "start": 0.25,
                        "end": 0.95,
                        "sourceOffset": 0.1,
                        "layout": "pip",
                        "x": -0.2,
                        "y": 0.15,
                        "scale": 0.85,
                        "rotation": -3,
                        "opacity": 0.9,
                        "cropLeft": 0.02,
                        "cropTop": 0.02,
                        "cropRight": 0.02,
                        "cropBottom": 0.02,
                        "keyframes": [
                            {"time": 0.25, "x": -0.2, "y": 0.15, "scale": 0.85, "rotation": -3, "opacity": 0.9},
                            {"time": 0.95, "x": 0.2, "y": -0.1, "scale": 1.1, "rotation": 3, "opacity": 1},
                        ],
                    }],
                    "color": {
                        "exposure": 0.01,
                        "contrast": 1.02,
                        "saturation": 1.03,
                        "temperature": 0.04,
                        "tint": -0.03,
                        "sharpen": 0.1,
                        "lutPath": lut,
                    },
                    "audio": {
                        "dialogueGainDb": 0.5,
                        "masterGainDb": -0.5,
                        "pan": 0.05,
                        "eqLowDb": 1,
                        "eqMidDb": -0.5,
                        "eqHighDb": 1,
                        "compressor": True,
                        "deEsser": True,
                        "noiseGate": True,
                        "dialogueMuted": False,
                        "musicMuted": False,
                        "keyframes": [
                            {"time": 0, "gainDb": -1},
                            {"time": 2.5, "gainDb": 0},
                        ],
                    },
                    "captions": {
                        "enabled": True,
                        "burnIn": True,
                        "fontSize": 30,
                        "position": "bottom",
                        "textColor": "#FFFFFF",
                        "backgroundColor": "#09090B",
                        "highlightColor": "#FACC15",
                        "cues": [{
                            "id": "caption",
                            "start": 0.2,
                            "end": 1.0,
                            "text": "Editable caption",
                            "speaker": "Host",
                            "lowConfidence": False,
                        }],
                    },
                    "adjustmentLayers": [{
                        "id": "adjustment",
                        "name": "Shot polish",
                        "start": 0.1,
                        "end": 0.8,
                        "exposure": 0.01,
                        "contrast": 1.02,
                        "saturation": 1.02,
                        "temperature": 0.03,
                        "tint": 0.02,
                        "sharpen": 0.05,
                        "blur": 0.1,
                        "vignette": 0.1,
                        "grain": 1,
                    }],
                    "multicam": {
                        "angles": [{
                            "id": "angle-2",
                            "path": angle,
                            "assetId": "angle--test.mp4",
                            "name": "Camera 2",
                            "offsetSec": 0,
                            "speaker": "Host",
                        }],
                        "cuts": [{
                            "id": "switch",
                            "angleId": "angle-2",
                            "start": 1.5,
                            "end": 2.2,
                            "sourceStart": 1.5,
                            "useAudio": True,
                        }],
                    },
                    "musicPath": None,
                    "musicVolume": 0.1,
                    "musicDucking": True,
                },
            }
            with open(project_path, "w", encoding="utf-8") as handle:
                json.dump(project, handle)

            result = subprocess.run(
                [
                    APP_PYTHON,
                    os.path.join(ROOT, "viral_factory.py"),
                    source,
                    "--mode", "longform-edit",
                    "--longform-json", project_path,
                    "--longform-output", output,
                    "--video-encoder", "cpu",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                stdin=subprocess.DEVNULL,
                timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(os.path.exists(output))
            self.assertTrue(os.path.exists(output.replace(".mp4", ".srt")))
            with open(output.replace(".mp4", ".srt"), encoding="utf-8") as handle:
                self.assertIn("Host: Editable caption", handle.read())
            with open(output.replace(".mp4", ".json"), encoding="utf-8") as handle:
                metadata = json.load(handle)
            self.assertEqual(metadata["manifest_version"], 6)
            self.assertNotIn("lutPath", metadata["creative"]["color"])
            self.assertNotIn("path", metadata["creative"]["multicam"]["angles"][0])
            self.assertAlmostEqual(metadata["creative"]["transitions"][0]["audioOffsetSec"], 0.12, places=2)

    def test_v3_sequence_time_effects_masks_stabilization_and_color_render(self):
        with tempfile.TemporaryDirectory(prefix="vcf-longform-v3-test-") as directory:
            source = os.path.join(directory, "source.mp4")
            asset = os.path.join(directory, "asset.mp4")
            project_path = os.path.join(directory, "project.json")
            output = os.path.join(directory, "finished.mp4")
            self._ffmpeg(
                "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2.5",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2.5",
                "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
            )
            self._ffmpeg(
                "-f", "lavfi", "-i", "color=c=royalblue:size=240x180:rate=24:duration=1.5",
                "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=1.5",
                "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", asset,
            )
            project = {
                "manifest_version": 6,
                "source": source,
                "source_duration_sec": 2.5,
                "selected_range": {"start": 0, "end": 2.5},
                "cuts": [],
                "render_segments": [{"start": 0, "end": 2.5}],
                "silence": {
                    "enabled": False,
                    "audio_fade_sec": 0,
                    "video_fade_sec": 0,
                },
                "creative": {
                    "exportPreset": "source",
                    "delivery": {"aspect": "source", "reframe": "contain"},
                    "renderSequence": {
                        "enabled": True,
                        "mode": "composite",
                        "frameRate": 24,
                        "tracks": [{
                            "id": "v1",
                            "kind": "video",
                            "order": 0,
                            "clips": [{
                                "id": "clip-1",
                                "name": "Tracked reverse",
                                "enabled": True,
                                "sourceType": "asset",
                                "path": asset,
                                "sourceStart": 0,
                                "sourceEnd": 1.5,
                                "timelineStart": 0.2,
                                "timelineEnd": 2,
                                "includeAudio": True,
                                "fit": "contain",
                                "x": 0,
                                "y": 0,
                                "scale": 0.8,
                                "rotation": 2,
                                "opacity": 0.9,
                                "volumeDb": -3,
                                "fadeIn": 0.1,
                                "fadeOut": 0.1,
                                "transitionIn": {"type": "dissolve", "duration": 0.1},
                                "transitionOut": {"type": "dissolve", "duration": 0.1},
                                "speed": {
                                    "rate": 0.8,
                                    "reverse": True,
                                    "freeze": False,
                                    "opticalFlow": False,
                                    "pitchPreserve": True,
                                    "keyframes": [{"sourceTime": 0.7, "speed": 1.2}],
                                },
                                "stabilization": {"enabled": True, "strength": 4},
                                "chromaKey": {"enabled": False},
                                "masks": [{
                                    "id": "privacy",
                                    "enabled": True,
                                    "type": "ellipse",
                                    "effect": "blur",
                                    "x": 0.2,
                                    "y": 0.2,
                                    "width": 0.2,
                                    "height": 0.2,
                                    "strength": 6,
                                    "keyframes": [],
                                }],
                            }],
                        }],
                    },
                    "sequence": {
                        "enabled": True,
                        "mode": "composite",
                        "activeSequenceId": "main",
                        "sourceIn": None,
                        "sourceOut": None,
                        "sequences": [{
                            "id": "main",
                            "name": "Main",
                            "frameRate": 24,
                            "width": 320,
                            "height": 180,
                            "tracks": [],
                        }],
                        "markers": [{"id": "qc", "time": 1, "label": "Review", "source": "qc"}],
                    },
                    "color": {
                        "exposure": 0.01,
                        "contrast": 1.02,
                        "saturation": 1.05,
                        "vibrance": 0.1,
                        "gamma": 1.02,
                        "highlights": 0.05,
                        "shadows": 0.05,
                        "temperature": 0.02,
                        "tint": 0,
                        "sharpen": 0.05,
                    },
                    "colorWorkflow": {
                        "management": {
                            "inputSpace": "auto",
                            "workingSpace": "rec709",
                            "outputSpace": "rec709",
                            "toneMap": "mobius",
                            "legalize": False,
                        },
                        "versions": [{
                            "id": "before-auto",
                            "name": "Before auto grade",
                            "source": "auto",
                            "grade": {"exposure": 0},
                        }],
                        "selectedVersionId": "before-auto",
                        "groups": [],
                    },
                    "audio": {},
                    "captions": {},
                    "titles": [],
                    "broll": [],
                    "adjustmentLayers": [],
                    "multicam": {},
                    "musicPath": None,
                },
            }
            with open(project_path, "w", encoding="utf-8") as handle:
                json.dump(project, handle)

            result = subprocess.run(
                [
                    APP_PYTHON,
                    os.path.join(ROOT, "viral_factory.py"),
                    source,
                    "--mode", "longform-edit",
                    "--longform-json", project_path,
                    "--longform-output", output,
                    "--video-encoder", "cpu",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                stdin=subprocess.DEVNULL,
                timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            probe = subprocess.run(
                [
                    "ffprobe", "-v", "error",
                    "-show_entries", "format=duration:stream=codec_type,width,height",
                    "-of", "json", output,
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
            info = json.loads(probe.stdout)
            self.assertEqual({stream["codec_type"] for stream in info["streams"]}, {"video", "audio"})
            self.assertAlmostEqual(float(info["format"]["duration"]), 2.5, delta=0.18)
            with open(output.replace(".mp4", ".json"), encoding="utf-8") as handle:
                metadata = json.load(handle)
            self.assertEqual(metadata["manifest_version"], 6)
            self.assertNotIn("renderSequence", metadata["creative"])
            self.assertEqual(metadata["creative"]["sequence"]["markers"][0]["source"], "qc")
            self.assertEqual(metadata["creative"]["colorWorkflow"]["selectedVersionId"], "before-auto")


if __name__ == "__main__":
    unittest.main()
