import json
import os
import tempfile
import unittest
from urllib.error import URLError

import viral_intelligence as vi


class FakeResponse:
    def __init__(self, payload, headers=None):
        self.payload = json.dumps(payload).encode("utf-8")
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return self.payload


def transcript_for_duration(duration=120, step=5, special_at=None):
    segments = []
    for index, start in enumerate(range(0, duration, step)):
        text = f"Ordinary discussion number {index} continues with a complete thought."
        if special_at is not None and start == special_at:
            text = "The quiet design mistake nobody notices costs an entire day every week."
        segments.append({"start": start, "end": min(start + step, duration), "text": text})
    return {"segments": segments}


def semantic_result(candidate_id, score=8):
    return {
        "candidate_id": candidate_id,
        "scores": {name: score for name in vi.SEMANTIC_DIMENSIONS},
        "overall_score": score,
        "topics": ["design systems"],
        "reasons": ["Complete and surprising payoff"],
    }


class CandidateWindowTests(unittest.TestCase):
    def test_candidates_do_not_require_keyword_hits(self):
        transcript = transcript_for_duration(special_at=45)
        windows = vi.build_candidate_windows(transcript)
        self.assertGreater(len(windows), 1)
        self.assertTrue(any("quiet design mistake" in window["text"] for window in windows))
        self.assertTrue(all(15 <= window["duration"] <= 75 for window in windows))
        starts = [window["start"] for window in windows]
        self.assertTrue(any(10 <= later - earlier <= 20 for earlier, later in zip(starts, starts[1:])))

    def test_word_timestamps_make_sentence_aligned_edges(self):
        transcript = {"segments": [{
            "start": 0,
            "end": 40,
            "text": "First thought. Second thought continues. Third thought ends.",
            "words": [
                {"word": "First", "start": 0, "end": 2},
                {"word": "thought.", "start": 2, "end": 6},
                {"word": "Second", "start": 6, "end": 10},
                {"word": "thought", "start": 10, "end": 14},
                {"word": "continues.", "start": 14, "end": 20},
                {"word": "Third", "start": 20, "end": 26},
                {"word": "thought", "start": 26, "end": 32},
                {"word": "ends.", "start": 32, "end": 40},
            ],
        }]}
        windows = vi.build_candidate_windows(transcript, target_duration_sec=20)
        sentence_boundaries = {0, 6, 20, 40}
        self.assertTrue(all(window["start"] in sentence_boundaries for window in windows))
        self.assertTrue(all(window["end"] in sentence_boundaries for window in windows))

    def test_short_transcript_is_kept_as_fallback(self):
        windows = vi.build_candidate_windows({"segments": [{"start": 2, "end": 9, "text": "A compact answer."}]})
        self.assertEqual(len(windows), 1)
        self.assertTrue(windows[0]["short_fallback"])

    def test_semantic_selection_adds_timeline_diversity(self):
        candidates = [
            {"id": f"c{index}", "start": index * 10, "end": index * 10 + 30, "heuristic_score": 100 - index}
            for index in range(12)
        ]
        selected = vi.select_semantic_candidates(candidates, top_heuristic=2, time_diverse=3)
        self.assertEqual([item["id"] for item in selected[:2]], ["c0", "c1"])
        diverse = selected[2:]
        self.assertEqual(len(diverse), 3)
        self.assertTrue(all(item["semantic_selection"] == "time_diverse" for item in diverse))
        self.assertGreater(max(item["start"] for item in diverse), 80)


class SchemaAndSemanticClientTests(unittest.TestCase):
    def test_schema_requires_all_semantic_dimensions(self):
        schema = vi.semantic_response_schema()
        self.assertEqual(set(schema["properties"]["candidates"]["items"]["properties"]["scores"]["required"]), set(vi.SEMANTIC_DIMENSIONS))
        result = vi.validate_semantic_results({"candidates": [semantic_result("one", 7.5)]}, allowed_candidate_ids={"one"})
        self.assertEqual(result[0]["semantic_score"], 7.5)
        broken = semantic_result("one")
        del broken["scores"]["hook"]
        with self.assertRaises(ValueError):
            vi.validate_semantic_results({"candidates": [broken]})

    def test_fenced_json_is_parsed(self):
        content = "```json\n" + json.dumps({"candidates": [semantic_result("one")]}) + "\n```"
        result = vi.validate_semantic_results(content, allowed_candidate_ids={"one"})
        self.assertEqual(result[0]["candidate_id"], "one")

    def test_local_openai_compatible_request_and_response(self):
        captured = {}

        def opener(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            response_content = "```json\n" + json.dumps({"candidates": [semantic_result("one", 9)]}) + "\n```"
            return FakeResponse({"choices": [{"message": {"content": response_content}}]})

        client = vi.LocalSemanticClient(
            "http://127.0.0.1:8080",
            "local-model",
            api_key="test-token",
            opener=opener,
        )
        result = client.rank_candidates([{"id": "one", "start": 0, "end": 30, "text": "A complete insight."}])
        self.assertEqual(result[0]["semantic_score"], 9)
        self.assertEqual(captured["request"].full_url, "http://127.0.0.1:8080/v1/chat/completions")
        self.assertEqual(captured["request"].headers["Authorization"], "Bearer test-token")
        body = json.loads(captured["request"].data)
        self.assertEqual(body["response_format"]["type"], "json_schema")
        self.assertEqual(captured["timeout"], 60.0)

    def test_environment_factory_uses_documented_names_and_v1_base(self):
        client = vi.LocalSemanticClient.from_environment({
            "VCF_LOCAL_LLM_URL": "http://127.0.0.1:8080/v1",
            "VCF_LOCAL_LLM_MODEL": "configured-model",
            "VCF_LOCAL_LLM_API_KEY": "configured-key",
        })
        self.assertEqual(client.endpoint, "http://127.0.0.1:8080/v1/chat/completions")
        self.assertEqual(client.model, "configured-model")
        self.assertEqual(client.api_key, "configured-key")

    def test_local_client_rejects_missing_candidate(self):
        client = vi.LocalSemanticClient(
            "http://localhost:8080/v1",
            "model",
            opener=lambda *_args, **_kwargs: FakeResponse({"choices": [{"message": {"content": '{"candidates": []}'}}]}),
        )
        with self.assertRaises(vi.ProviderError) as raised:
            client.rank_candidates([{"id": "one", "start": 0, "end": 20, "text": "Text"}])
        self.assertEqual(raised.exception.code, "invalid_response")


class GeminiClientTests(unittest.TestCase):
    def test_timestamp_mapping_and_proxy_offset(self):
        response_payload = {
            "candidates": [{
                "content": {"parts": [{"text": json.dumps({
                    "candidates": [{
                        "start": "01:02.500",
                        "end": "00:01:20",
                        "score": 8.5,
                        "summary": "A visual reveal",
                        "topics": ["craft"],
                        "reasons": ["Clear payoff"],
                    }]
                })}]}
            }]
        }
        client = vi.GeminiVideoClient("secret", opener=lambda *_args, **_kwargs: FakeResponse(response_payload))
        results = client.analyze_proxy(file_uri="https://files.example/proxy", duration_sec=100, time_offset_sec=10)
        self.assertEqual(results[0]["start"], 72.5)
        self.assertEqual(results[0]["end"], 90.0)
        self.assertEqual(results[0]["gemini_score"], 8.5)

    def test_inline_proxy_is_encoded_and_http_is_mockable(self):
        captured = {}

        def opener(request, timeout):
            captured["url"] = request.full_url
            captured["body"] = json.loads(request.data)
            return FakeResponse({"candidates": [{"content": {"parts": [{"text": '{"candidates": []}'}]}}]})

        client = vi.GeminiVideoClient("not-live", model="gemini-test", opener=opener)
        self.assertEqual(client.analyze_proxy(inline_data=b"proxy"), [])
        media = captured["body"]["contents"][0]["parts"][0]["inline_data"]
        self.assertEqual(media["data"], "cHJveHk=")
        self.assertIn("gemini-test:generateContent", captured["url"])

    def test_environment_factory_uses_gemini_api_key(self):
        client = vi.GeminiVideoClient.from_environment({"GEMINI_API_KEY": "configured-secret"})
        self.assertEqual(client.api_key, "configured-secret")
        self.assertEqual(client.model, "gemini-3.5-flash")

    def test_files_api_upload_poll_analysis_and_cleanup(self):
        calls = []
        completion = {"candidates": [{"content": {"parts": [{"text": '{"candidates": []}'}]}}]}

        def opener(request, timeout):
            calls.append((request.method, request.full_url, request))
            if len(calls) == 1:
                return FakeResponse({}, {"X-Goog-Upload-URL": "https://upload.example/session"})
            if len(calls) == 2:
                self.assertEqual(b"".join(request.data), b"video-bytes")
                return FakeResponse({"file": {"name": "files/test", "uri": "https://files.example/test", "state": "PROCESSING"}})
            if len(calls) == 3:
                return FakeResponse({"name": "files/test", "uri": "https://files.example/test", "state": "ACTIVE"})
            if len(calls) == 4:
                return FakeResponse(completion)
            return FakeResponse({})

        handle = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        try:
            handle.write(b"video-bytes")
            handle.close()
            client = vi.GeminiVideoClient("secret", opener=opener, sleeper=lambda _seconds: None)
            self.assertEqual(client.analyze_media_path(handle.name, duration_sec=10), [])
        finally:
            try:
                os.remove(handle.name)
            except OSError:
                pass

        self.assertIn("/upload/v1beta/files?key=secret", calls[0][1])
        self.assertEqual(calls[1][1], "https://upload.example/session")
        self.assertEqual(calls[-1][0], "DELETE")


class ScoringAndDedupeTests(unittest.TestCase):
    def test_ensemble_weight_rules(self):
        self.assertEqual(vi.ensemble_score(8), (8.0, {"heuristic": 1.0, "semantic": 0.0, "gemini": 0.0}))
        self.assertEqual(vi.ensemble_score(8, semantic_score=6)[0], 7.1)
        score, weights = vi.ensemble_score(8, semantic_score=6, gemini_score=10)
        self.assertEqual(score, 8.3)
        self.assertEqual(weights, {"heuristic": 0.35, "semantic": 0.25, "gemini": 0.4})
        score, weights = vi.ensemble_score(8, gemini_score=10)
        self.assertEqual(score, 8.8)
        self.assertEqual(weights["heuristic"], 0.6)

    def test_overlap_dedupe_keeps_score_and_unions_topics(self):
        candidates = [
            {"id": "high", "start": 0, "end": 30, "ensemble_score": 9, "topics": ["AI"], "reasons": ["Hook"]},
            {"id": "lower", "start": 2, "end": 31, "ensemble_score": 7, "topics": ["Jobs"], "reasons": ["Payoff"]},
            {"id": "separate", "start": 40, "end": 70, "ensemble_score": 8, "topics": ["Design"]},
        ]
        result = vi.dedupe_temporal_candidates(candidates)
        self.assertEqual([item["id"] for item in result], ["high", "separate"])
        self.assertEqual(result[0]["topics"], ["AI", "Jobs"])
        self.assertEqual(result[0]["merged_candidate_ids"], ["lower"])
        self.assertEqual(candidates[0]["topics"], ["AI"])


class ProviderFailureTests(unittest.TestCase):
    def test_network_error_is_normalized_and_falls_back(self):
        client = vi.LocalSemanticClient(
            "http://localhost:8080",
            "model",
            opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(URLError("offline")),
        )
        with self.assertRaises(vi.ProviderError) as raised:
            client.rank_candidates([{"id": "one", "start": 0, "end": 20, "text": "Text"}])
        self.assertEqual(raised.exception.code, "network_error")
        self.assertTrue(raised.exception.retryable)

        result, metadata = vi.call_with_fallback(
            lambda: (_ for _ in ()).throw(raised.exception),
            lambda: ["local result"],
            primary_provider="local_semantic",
            fallback_provider="hybrid_heuristic",
        )
        self.assertEqual(result, ["local result"])
        self.assertEqual(metadata["status"], "failed")
        self.assertEqual(metadata["fallback"]["status"], "success")


if __name__ == "__main__":
    unittest.main()
