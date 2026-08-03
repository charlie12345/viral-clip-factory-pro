import json
import os
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch

import transcription_backends as backends


class OpenAIWhisperTests(unittest.TestCase):
    def test_normalizes_segments_words_language_and_log_probability(self):
        result = backends.normalize_openai_whisper_result(
            {
                "language": "en",
                "text": "Hello world",
                "segments": [
                    {
                        "start": 1,
                        "end": 2.25,
                        "text": " Hello world",
                        "avg_logprob": -0.2,
                        "words": [
                            {"word": " Hello", "start": 1, "end": 1.5, "probability": 0.8},
                            {"word": " world", "start": 1.5, "end": 2.25, "probability": 0.9},
                        ],
                    }
                ],
            },
            model="turbo",
        )
        self.assertEqual(result["provider"], "openai_whisper")
        self.assertEqual(result["model"], "turbo")
        self.assertEqual(result["language"], "en")
        self.assertEqual(result["topics"], [])
        self.assertEqual(result["segments"][0]["text"], "Hello world")
        self.assertEqual(result["segments"][0]["confidence"], 0.85)
        self.assertEqual(result["segments"][0]["words"][1]["start"], 1.5)

    def test_normalizes_transcript_only_wrapper(self):
        result = backends.normalize_openai_whisper_result(
            {
                "text": "One two",
                "words": [
                    {"word": "One", "start": 0, "end": 0.4},
                    {"word": "two", "start": 0.5, "end": 0.9},
                ],
            }
        )
        self.assertEqual(len(result["segments"]), 1)
        self.assertEqual(result["segments"][0]["end"], 0.9)

    def test_invokes_object_and_requests_word_timestamps(self):
        model = Mock()
        model.transcribe.return_value = {"language": "es", "segments": []}
        result = backends.transcribe_openai_whisper(
            "recording.mp4",
            whisper_model=model,
            model_name="turbo",
            language="es",
            transcribe_options={"temperature": 0},
        )
        model.transcribe.assert_called_once_with(
            "recording.mp4",
            temperature=0,
            language="es",
            word_timestamps=True,
        )
        self.assertEqual(result["language"], "es")

    def test_wraps_model_errors_with_backend_context(self):
        model = Mock()
        model.transcribe.side_effect = ValueError("bad audio")
        with self.assertRaisesRegex(RuntimeError, "OpenAI Whisper transcription failed: bad audio"):
            backends.transcribe_openai_whisper("x.mp4", whisper_model=model)


class WhisperCppParsingTests(unittest.TestCase):
    def test_parses_native_transcription_tokens_and_millisecond_offsets(self):
        result = backends.parse_whisper_cpp_json(
            {
                "result": {"language": "en"},
                "transcription": [
                    {
                        "timestamps": {"from": "00:00:01,000", "to": "00:00:02,500"},
                        "text": " Hello there",
                        "tokens": [
                            {
                                "text": " Hello",
                                "offsets": {"from": 1000, "to": 1600},
                                "p": 0.75,
                            },
                            {
                                "text": " there",
                                "offsets": {"from": 1600, "to": 2500},
                                "p": 0.95,
                            },
                            {"text": "[_EOS_]", "offsets": {"from": 2500, "to": 2500}},
                        ],
                    }
                ],
            },
            model="ggml-large-v3-turbo.bin",
        )
        segment = result["segments"][0]
        self.assertEqual((segment["start"], segment["end"]), (1.0, 2.5))
        self.assertEqual([word["word"] for word in segment["words"]], ["Hello", "there"])
        self.assertEqual(segment["confidence"], 0.85)
        self.assertEqual(result["language"], "en")

    def test_parses_generic_segment_and_t0_token_forms(self):
        result = backends.parse_whisper_cpp_json(
            [
                {
                    "start": 4.0,
                    "end": 5.25,
                    "tokens": [
                        {"token": "Hi", "t0": 400, "t1": 450, "probability": 0.6},
                        {"token": "all", "t0": 450, "t1": 525, "probability": 0.8},
                    ],
                }
            ]
        )
        segment = result["segments"][0]
        self.assertEqual(segment["text"], "Hi all")
        self.assertEqual(segment["words"][1]["end"], 5.25)
        self.assertEqual(segment["confidence"], 0.7)

    def test_parses_top_level_words_when_segments_are_absent(self):
        result = backends.parse_whisper_cpp_json(
            {
                "language": "fr",
                "text": "bonjour",
                "words": [{"word": "bonjour", "start_ms": 200, "end_ms": 800}],
            }
        )
        self.assertEqual(result["segments"][0]["start"], 0.2)
        self.assertEqual(result["segments"][0]["end"], 0.8)


class WhisperCppRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.source = root / "source.mp4"
        self.model = root / "model.bin"
        self.vad_model = root / "ggml-silero-v6.2.0.bin"
        self.executable = root / "whisper-cli"
        self.ffmpeg = root / "ffmpeg"
        for path in (self.source, self.model, self.vad_model, self.executable, self.ffmpeg):
            path.write_bytes(b"fixture")
        self.executable.chmod(0o755)
        self.ffmpeg.chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def test_model_name_is_inferred_from_standard_model_path(self):
        self.assertEqual(
            backends.whisper_cpp_model_name("/models/ggml-large-v3.bin"),
            "large-v3",
        )
        self.assertEqual(
            backends.whisper_cpp_model_name("/models/ggml-large-v3-turbo-q5_0.gguf"),
            "large-v3-turbo-q5_0",
        )

    @patch("transcription_backends._run_command")
    def test_extracts_pcm_runs_json_mode_and_cleans_temp_files(self, run_mock):
        observed = {}

        def run(command, *, timeout):
            if "pcm_s16le" in command:
                Path(command[-1]).write_bytes(b"wav")
                observed["wav"] = command[-1]
            else:
                prefix = Path(command[command.index("-of") + 1])
                prefix.with_suffix(".json").write_text(
                    json.dumps(
                        {
                            "result": {"language": "en"},
                            "transcription": [
                                {
                                    "offsets": {"from": 0, "to": 1000},
                                    "text": "test",
                                }
                            ],
                        }
                    ),
                    encoding="utf-8",
                )
                observed["cpp_command"] = command
            return subprocess.CompletedProcess(command, 0, "", "")

        run_mock.side_effect = run
        result = backends.transcribe_whisper_cpp(
            self.source,
            executable=self.executable,
            model_path=self.model,
            ffmpeg_bin=str(self.ffmpeg),
            language="en",
            extra_args=["--no-prints"],
        )
        extract_command = run_mock.call_args_list[0].args[0]
        self.assertIn("-ac", extract_command)
        self.assertEqual(extract_command[extract_command.index("-ac") + 1], "1")
        self.assertEqual(extract_command[extract_command.index("-ar") + 1], "16000")
        self.assertIn("-oj", observed["cpp_command"])
        self.assertEqual(observed["cpp_command"][-3:], ["-l", "en", "--no-prints"])
        self.assertFalse(Path(observed["wav"]).exists())
        self.assertEqual(result["segments"][0]["end"], 1.0)
        self.assertEqual(result["model"], "model")

    @patch("transcription_backends._run_command")
    def test_defaults_to_auto_language_and_skips_an_absent_vad_model(self, run_mock):
        commands = []

        def run(command, *, timeout):
            commands.append(command)
            if "pcm_s16le" not in command:
                prefix = Path(command[command.index("-of") + 1])
                prefix.with_suffix(".json").write_text(
                    json.dumps({"result": {"language": "es"}, "transcription": []}),
                    encoding="utf-8",
                )
            return subprocess.CompletedProcess(command, 0, "", "")

        run_mock.side_effect = run
        with patch.dict(
            os.environ,
            {
                "VCF_WHISPER_CPP_VAD_MODEL": str(Path(self.temp.name) / "missing-vad.bin"),
                "VCF_WHISPER_CPP_VAD_THRESHOLD": "0.6",
            },
            clear=True,
        ):
            result = backends.transcribe_whisper_cpp(
                self.source,
                executable=self.executable,
                model_path=self.model,
                ffmpeg_bin=str(self.ffmpeg),
            )

        cpp_command = commands[1]
        self.assertEqual(cpp_command[cpp_command.index("-l") + 1], "auto")
        self.assertNotIn("--vad", cpp_command)
        self.assertNotIn("--vad-threshold", cpp_command)
        self.assertEqual(result["language"], "es")

    @patch("transcription_backends._run_command")
    def test_vad_path_and_safe_options_accept_environment_and_argument_overrides(self, run_mock):
        commands = []

        def run(command, *, timeout):
            commands.append(command)
            if "pcm_s16le" not in command:
                prefix = Path(command[command.index("-of") + 1])
                prefix.with_suffix(".json").write_text(
                    json.dumps({"transcription": []}),
                    encoding="utf-8",
                )
            return subprocess.CompletedProcess(command, 0, "", "")

        run_mock.side_effect = run
        with patch.dict(
            os.environ,
            {
                "VCF_WHISPER_CPP_LANGUAGE": "fr",
                "VCF_WHISPER_CPP_VAD_MODEL": str(self.vad_model),
                "VCF_WHISPER_CPP_VAD_THRESHOLD": "0.55",
                "VCF_WHISPER_CPP_VAD_MIN_SILENCE_DURATION_MS": "140",
                "VCF_WHISPER_CPP_VAD_MAX_SPEECH_DURATION_S": "not-a-number",
            },
            clear=True,
        ):
            backends.transcribe_whisper_cpp(
                self.source,
                executable=self.executable,
                model_path=self.model,
                vad_options={
                    "threshold": 0.7,
                    "min_speech_duration_ms": 300,
                    "speech_pad_ms": 80,
                    "samples_overlap": 0.15,
                },
                ffmpeg_bin=str(self.ffmpeg),
            )

        cpp_command = commands[1]
        self.assertEqual(cpp_command[cpp_command.index("-l") + 1], "fr")
        self.assertEqual(
            cpp_command[cpp_command.index("--vad-model") + 1],
            str(self.vad_model.resolve()),
        )
        self.assertEqual(cpp_command[cpp_command.index("--vad-threshold") + 1], "0.7")
        self.assertEqual(
            cpp_command[cpp_command.index("--vad-min-speech-duration-ms") + 1],
            "300",
        )
        self.assertEqual(
            cpp_command[cpp_command.index("--vad-min-silence-duration-ms") + 1],
            "140",
        )
        self.assertEqual(cpp_command[cpp_command.index("--vad-speech-pad-ms") + 1], "80")
        self.assertEqual(cpp_command[cpp_command.index("--vad-samples-overlap") + 1], "0.15")
        self.assertNotIn("--vad-max-speech-duration-s", cpp_command)

    @patch("transcription_backends.subprocess.run")
    def test_low_level_runner_detaches_stdin_and_sets_timeout(self, run_mock):
        run_mock.return_value = subprocess.CompletedProcess([], 0, "", "")
        backends._run_command(["tool", "--json"], timeout=45)
        self.assertIs(run_mock.call_args.kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(run_mock.call_args.kwargs["timeout"], 45)
        self.assertFalse(run_mock.call_args.kwargs["check"])

    def test_missing_model_is_reported_before_process_launch(self):
        with self.assertRaisesRegex(RuntimeError, "model file was not found"):
            backends.transcribe_whisper_cpp(
                self.source,
                executable=self.executable,
                model_path=Path(self.temp.name) / "missing.bin",
                ffmpeg_bin=str(self.ffmpeg),
            )

    @patch("transcription_backends._run_command")
    def test_subprocess_timeout_is_clear(self, run_mock):
        run_mock.side_effect = subprocess.TimeoutExpired(["ffmpeg"], 2)
        with self.assertRaisesRegex(RuntimeError, "FFmpeg timed out"):
            backends.transcribe_whisper_cpp(
                self.source,
                executable=self.executable,
                model_path=self.model,
                ffmpeg_bin=str(self.ffmpeg),
                timeout=2,
            )


class DeepgramTests(unittest.TestCase):
    PAYLOAD = {
        "results": {
            "channels": [
                {
                    "detected_language": "en",
                    "alternatives": [
                        {
                            "transcript": "This is excellent.",
                            "words": [
                                {
                                    "word": "this",
                                    "punctuated_word": "This",
                                    "start": 0,
                                    "end": 0.2,
                                    "confidence": 0.9,
                                    "speaker": 1,
                                    "speaker_confidence": 0.94,
                                },
                                {
                                    "word": "excellent",
                                    "punctuated_word": "excellent.",
                                    "start": 0.2,
                                    "end": 0.8,
                                    "confidence": 0.8,
                                    "speaker": 1,
                                    "speaker_confidence": 0.9,
                                },
                            ],
                            "topics": {
                                "segments": [
                                    {
                                        "start_word": 0,
                                        "end_word": 1,
                                        "topics": [{"topic": "Product review", "confidence": 0.93}],
                                    }
                                ]
                            },
                            "sentiments": {
                                "segments": [
                                    {
                                        "start_word": 0,
                                        "end_word": 1,
                                        "sentiment": "positive",
                                        "sentiment_score": 0.7,
                                    }
                                ]
                            },
                        }
                    ],
                }
            ],
            "utterances": [
                {
                    "start": 0,
                    "end": 0.8,
                    "transcript": "This is excellent.",
                    "confidence": 0.87,
                    "speaker": 1,
                    "speaker_confidence": 0.92,
                    "sentiment": "positive",
                    "sentiment_score": 0.7,
                }
            ],
        }
    }

    def test_normalizes_utterances_topics_and_sentiment(self):
        result = backends.parse_deepgram_response(self.PAYLOAD, model="nova-3")
        self.assertEqual(result["provider"], "deepgram")
        self.assertEqual(result["language"], "en")
        self.assertEqual(result["segments"][0]["speaker"], 1)
        self.assertEqual(result["segments"][0]["speaker_confidence"], 0.92)
        self.assertEqual(result["segments"][0]["words"][1]["word"], "excellent.")
        self.assertEqual(result["segments"][0]["words"][1]["speaker"], 1)
        self.assertEqual(result["segments"][0]["words"][1]["speaker_confidence"], 0.9)
        self.assertEqual(result["segments"][0]["sentiment"], "positive")
        self.assertEqual(result["topics"][0]["topic"], "Product review")
        self.assertEqual(result["sentiments"][0]["score"], 0.7)

    def test_uses_paragraph_sentences_when_utterances_are_absent(self):
        payload = json.loads(json.dumps(self.PAYLOAD))
        payload["results"].pop("utterances")
        alt = payload["results"]["channels"][0]["alternatives"][0]
        alt["paragraphs"] = {
            "paragraphs": [
                {"sentences": [{"start": 0, "end": 0.8, "text": "This is excellent."}]}
            ]
        }
        result = backends.parse_deepgram_response(payload)
        self.assertEqual(len(result["segments"]), 1)
        self.assertEqual(len(result["segments"][0]["words"]), 2)
        self.assertEqual(result["segments"][0]["speaker"], 1)
        self.assertEqual(result["segments"][0]["words"][0]["speaker"], 1)

    def test_accepts_topics_and_average_sentiment_at_results_level(self):
        payload = json.loads(json.dumps(self.PAYLOAD))
        alternative = payload["results"]["channels"][0]["alternatives"][0]
        payload["results"]["topics"] = alternative.pop("topics")
        payload["results"]["sentiments"] = alternative.pop("sentiments")
        payload["results"]["sentiments"]["average"] = {
            "sentiment": "positive",
            "sentiment_score": 0.82,
        }
        result = backends.parse_deepgram_response(payload)
        self.assertEqual(result["topics"][0]["topic"], "Product review")
        self.assertEqual(result["sentiment"], {"sentiment": "positive", "score": 0.82})

    def test_missing_results_is_a_clear_error(self):
        with self.assertRaisesRegex(RuntimeError, "did not contain results"):
            backends.parse_deepgram_response({"request_id": "123"})

    def test_http_adapter_streams_file_and_enables_intelligence_options(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps(DeepgramTests.PAYLOAD).encode()

        captured = {}

        def urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["body"] = b"".join(request.data)
            captured["authorization"] = request.get_header("Authorization")
            captured["timeout"] = timeout
            return Response()

        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "recording.wav"
            source.write_bytes(b"audio fixture")
            with patch("transcription_backends.urllib.request.urlopen", side_effect=urlopen):
                result = backends.transcribe_deepgram(
                    source,
                    api_key="secret",
                    model="nova-3",
                    language="en-US",
                    timeout=20,
                )
        query = urllib_parse_query(captured["url"])
        self.assertEqual(captured["body"], b"audio fixture")
        self.assertEqual(captured["authorization"], "Token secret")
        self.assertEqual(captured["timeout"], 20)
        self.assertEqual(query["model"], ["nova-3"])
        self.assertEqual(query["topics"], ["true"])
        self.assertEqual(query["sentiment"], ["true"])
        self.assertEqual(query["diarize"], ["true"])
        self.assertEqual(result["segments"][0]["text"], "This is excellent.")

    def test_http_error_does_not_expose_api_key(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "recording.wav"
            source.write_bytes(b"fixture")
            error = urllib.error.HTTPError(
                "https://api.deepgram.com/v1/listen",
                401,
                "Unauthorized",
                {},
                None,
            )
            error.read = Mock(return_value=b'{"err_msg":"bad token"}')
            with patch("transcription_backends.urllib.request.urlopen", side_effect=error):
                with self.assertRaisesRegex(RuntimeError, "HTTP 401") as raised:
                    backends.transcribe_deepgram(source, api_key="do-not-print")
        self.assertNotIn("do-not-print", str(raised.exception))


def urllib_parse_query(url):
    from urllib.parse import parse_qs, urlsplit

    return parse_qs(urlsplit(url).query)


class CapabilityAndDispatchTests(unittest.TestCase):
    def test_cpp_probe_defaults_to_path_executable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            model_path = Path(temp_dir) / "ggml-medium.bin"
            vad_model_path = Path(temp_dir) / "ggml-silero-v6.2.0.bin"
            model_path.touch()
            vad_model_path.touch()
            with patch.dict(
                os.environ,
                {
                    "VCF_WHISPER_CPP_MODEL": str(model_path),
                    "VCF_WHISPER_CPP_VAD_MODEL": str(vad_model_path),
                },
                clear=True,
            ), patch(
                "transcription_backends.shutil.which",
                return_value="/home/user/.local/bin/whisper-cli",
            ) as which:
                result = backends.probe_whisper_cpp()

        self.assertTrue(result["available"])
        self.assertTrue(result["vad_model_configured"])
        self.assertTrue(result["vad_model_available"])
        self.assertEqual(result["executable"], "/home/user/.local/bin/whisper-cli")
        which.assert_called_once_with("whisper-cli")

    def test_missing_optional_vad_model_does_not_disable_whisper_cpp(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            executable = root / "whisper-cli"
            model = root / "ggml-medium.bin"
            executable.write_bytes(b"fixture")
            executable.chmod(0o755)
            model.touch()
            result = backends.probe_whisper_cpp(
                executable=executable,
                model_path=model,
                vad_model_path=root / "missing-vad.bin",
            )

        self.assertTrue(result["available"])
        self.assertFalse(result["vad_model_available"])
        self.assertIn("not found", result["vad_reason"])

    def test_cpp_dispatch_defaults_to_path_executable(self):
        with patch.dict(
            os.environ,
            {"VCF_WHISPER_CPP_MODEL": "/models/ggml-medium.bin"},
            clear=True,
        ), patch("transcription_backends.transcribe_whisper_cpp") as cpp:
            cpp.return_value = {"provider": "whisper_cpp"}
            result = backends.transcribe_media(
                "source.mp4",
                provider="whisper_cpp",
                whisper_cpp_vad_model_path="/models/ggml-silero-v6.2.0.bin",
                whisper_cpp_vad_options={"threshold": 0.65},
            )

        self.assertEqual(result["provider"], "whisper_cpp")
        self.assertEqual(cpp.call_args.kwargs["executable"], "whisper-cli")
        self.assertEqual(
            cpp.call_args.kwargs["vad_model_path"],
            "/models/ggml-silero-v6.2.0.bin",
        )
        self.assertEqual(cpp.call_args.kwargs["vad_options"], {"threshold": 0.65})

    def test_auto_selection_priority(self):
        self.assertEqual(
            backends.select_auto_provider(
                openai_available=True,
                openai_accelerated=True,
                whisper_cpp_available=True,
            ),
            "openai_whisper",
        )
        self.assertEqual(
            backends.select_auto_provider(
                openai_available=True,
                openai_accelerated=False,
                whisper_cpp_available=True,
            ),
            "whisper_cpp",
        )
        self.assertEqual(
            backends.select_auto_provider(
                openai_available=True,
                openai_accelerated=False,
                whisper_cpp_available=False,
            ),
            "openai_whisper",
        )

    def test_auto_accepts_explicit_availability_and_uses_cpp(self):
        with patch("transcription_backends.transcribe_whisper_cpp") as cpp:
            cpp.return_value = {"provider": "whisper_cpp"}
            result = backends.transcribe_media(
                "source.mp4",
                provider="auto",
                availability={
                    "openai_whisper": True,
                    "openai_whisper_accelerated": False,
                    "whisper_cpp": True,
                },
                whisper_model=Mock(),
                whisper_cpp_executable="whisper-cli",
                whisper_cpp_model_path="model.bin",
            )
        self.assertEqual(result["provider"], "whisper_cpp")
        cpp.assert_called_once()

    def test_auto_accepts_structured_probe_availability(self):
        callable_model = Mock(return_value={"segments": []})
        with patch("transcription_backends.transcribe_openai_whisper") as openai:
            openai.return_value = {"provider": "openai_whisper"}
            backends.transcribe_media(
                "source.mp4",
                provider="auto-local",
                availability={
                    "openai_whisper": {"available": True, "accelerated": True},
                    "whisper_cpp": {"available": True},
                },
                whisper_model=callable_model,
            )
        openai.assert_called_once()

    def test_auto_uses_accelerated_openai_before_cpp(self):
        callable_model = Mock(return_value={"segments": []})
        with patch("transcription_backends.transcribe_openai_whisper") as openai:
            openai.return_value = {"provider": "openai_whisper"}
            result = backends.transcribe_media(
                "source.mp4",
                availability={
                    "openai_whisper": True,
                    "openai_whisper_accelerated": True,
                    "whisper_cpp": True,
                },
                whisper_model=callable_model,
                whisper_cpp_executable="whisper-cli",
                whisper_cpp_model_path="model.bin",
            )
        self.assertEqual(result["provider"], "openai_whisper")
        openai.assert_called_once()

    def test_environment_names_supply_cpp_and_deepgram_configuration(self):
        with patch.dict(
            os.environ,
            {
                "VCF_WHISPER_CPP_PATH": "/opt/whisper-cli",
                "VCF_WHISPER_CPP_MODEL": "/models/ggml.bin",
                "DEEPGRAM_API_KEY": "configured",
            },
            clear=True,
        ):
            with patch("transcription_backends.transcribe_whisper_cpp") as cpp:
                cpp.return_value = {"provider": "whisper_cpp"}
                result = backends.transcribe_media(
                    "source.mp4",
                    provider="whisper_cpp",
                )
            self.assertEqual(result["provider"], "whisper_cpp")
            self.assertEqual(cpp.call_args.kwargs["executable"], "/opt/whisper-cli")
            self.assertEqual(cpp.call_args.kwargs["model_path"], "/models/ggml.bin")

            with patch("transcription_backends.transcribe_deepgram") as deepgram:
                deepgram.return_value = {"provider": "deepgram"}
                backends.transcribe_media("source.mp4", provider="deepgram")
            self.assertEqual(deepgram.call_args.kwargs["api_key"], "configured")

    def test_capability_probe_never_returns_deepgram_secret(self):
        result = backends.probe_transcription_capabilities(deepgram_api_key="secret")
        self.assertTrue(result["deepgram"]["available"])
        self.assertNotIn("secret", json.dumps(result))

    def test_unknown_provider_and_no_local_backend_fail_clearly(self):
        with self.assertRaisesRegex(ValueError, "Unsupported transcription provider"):
            backends.transcribe_media("x.mp4", provider="magic")
        with self.assertRaisesRegex(RuntimeError, "No local transcription backend"):
            backends.transcribe_media(
                "x.mp4",
                provider="auto",
                availability={
                    "openai_whisper": False,
                    "whisper_cpp": False,
                },
            )


if __name__ == "__main__":
    unittest.main()
