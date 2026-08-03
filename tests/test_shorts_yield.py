import copy
import unittest

import shorts_yield as sy


def candidate(candidate_id, score, start, end=None, text=None, topics=None):
    return {
        "id": candidate_id,
        "score": score,
        "start": start,
        "end": end if end is not None else start + 24,
        "text": text or f"Distinct complete thought for {candidate_id}",
        "topics": topics or [candidate_id],
    }


class YieldPlanTests(unittest.TestCase):
    def test_volume_modes_scale_with_active_speech(self):
        seconds = 36.8 * 60
        self.assertEqual(sy.calculate_yield_plan(seconds, volume="curated")["target"], 8)
        self.assertEqual(sy.calculate_yield_plan(seconds, volume="balanced")["target"], 13)
        self.assertEqual(sy.calculate_yield_plan(seconds, volume="more")["target"], 19)

        balanced = sy.calculate_yield_plan(seconds, volume="balanced")
        self.assertEqual(balanced["soft_min"], 9)

    def test_short_speech_gets_minimum_but_silence_does_not(self):
        self.assertEqual(sy.calculate_yield_plan(30, volume="balanced")["target"], 3)
        self.assertEqual(sy.calculate_yield_plan(0, volume="balanced")["target"], 0)
        self.assertEqual(sy.calculate_yield_plan("not-a-number", volume="balanced")["target"], 0)

    def test_caps_and_exact_mode(self):
        self.assertEqual(
            sy.calculate_yield_plan(10_000, volume="more", max_clips=7)["target"],
            7,
        )
        exact = sy.calculate_yield_plan(60, volume="exact", exact_count="6", max_clips=5)
        self.assertEqual((exact["target"], exact["soft_min"]), (5, 5))
        with self.assertRaisesRegex(ValueError, "exact_count"):
            sy.calculate_yield_plan(60, volume="exact")
        with self.assertRaisesRegex(ValueError, "volume"):
            sy.calculate_yield_plan(60, volume="flood")

    def test_confidence_tier_boundaries(self):
        self.assertEqual(sy.confidence_tier(6.5), "best")
        self.assertEqual(sy.confidence_tier("5.2"), "strong")
        self.assertEqual(sy.confidence_tier(4.3), "review")
        self.assertIsNone(sy.confidence_tier(4.299))
        self.assertIsNone(sy.confidence_tier(float("nan")))


class CandidateSelectionTests(unittest.TestCase):
    def test_strong_candidates_fill_target_and_reviews_become_reserves(self):
        candidates = [
            candidate("a", 8.0, 0),
            candidate("b", 7.0, 180),
            candidate("c", 6.2, 360),
            candidate("d", 5.7, 540),
            candidate("e", 5.2, 720),
            candidate("f", 4.9, 900),
        ]
        result = sy.select_yield_candidates(candidates, target=6, soft_min=4, reserve_count=2)

        self.assertEqual(len(result["selected"]), 5)
        self.assertTrue(result["soft_min_met"])
        self.assertFalse(result["target_met"])
        self.assertEqual([item["id"] for item in result["reserves"]], ["f"])
        self.assertTrue(all(item["yield_role"] == "primary" for item in result["selected"]))

    def test_review_tier_fills_soft_min_and_exact_fills_full_target(self):
        candidates = [
            candidate("best", 7.0, 0),
            candidate("r1", 5.0, 180),
            candidate("r2", 4.9, 360),
            candidate("r3", 4.8, 540),
            candidate("r4", 4.7, 720),
            candidate("r5", 4.6, 900),
        ]
        balanced = sy.select_yield_candidates(
            candidates, target=6, soft_min=4, reserve_count=2
        )
        self.assertEqual(len(balanced["selected"]), 4)
        self.assertEqual(len(balanced["reserves"]), 2)

        exact = sy.select_yield_candidates(
            candidates, target=6, soft_min=6, exact=True, reserve_count=2
        )
        self.assertEqual(len(exact["selected"]), 6)
        self.assertTrue(exact["target_met"])

    def test_temporal_duplicates_are_removed_and_diverse_moments_survive(self):
        repeated = "The same complete insight with the same surprising conclusion"
        candidates = [
            candidate("winner", 8.0, 0, 40, repeated, ["ai"]),
            candidate("duplicate", 7.5, 5, 42, repeated, ["ai"]),
            candidate("later", 6.8, 240, 270, "A different story and payoff", ["design"]),
            candidate("latest", 6.6, 480, 510, "Another independent useful idea", ["business"]),
        ]
        result = sy.select_yield_candidates(candidates, target=3, soft_min=2, reserve_count=0)

        selected_ids = {item["id"] for item in result["selected"]}
        self.assertEqual(selected_ids, {"winner", "later", "latest"})
        self.assertEqual(result["stats"]["duplicates"], 1)
        self.assertEqual(result["duplicates"][0]["id"], "duplicate")
        self.assertEqual(result["duplicates"][0]["duplicate_of"], "winner")
        winner = next(item for item in result["selected"] if item["id"] == "winner")
        duplicate = result["duplicates"][0]
        self.assertEqual(duplicate["cluster_id"], winner["cluster_id"])
        self.assertEqual((winner["variant_rank"], duplicate["variant_rank"]), (1, 2))
        self.assertIsNone(winner["duplicate_of"])

    def test_overlapping_story_variants_allow_only_one_primary(self):
        candidates = [
            candidate(
                "story-winner",
                8.2,
                0,
                40,
                "A founder discovered pricing was destroying retention",
                ["startup"],
            ),
            candidate(
                "alternate-window",
                7.8,
                20,
                60,
                "Customer interviews revealed a hidden churn problem",
                ["startup"],
            ),
            candidate(
                "independent-story",
                7.2,
                180,
                215,
                "A completely separate lesson about hiring a first designer",
                ["hiring"],
            ),
        ]
        result = sy.select_yield_candidates(
            candidates,
            target=3,
            soft_min=2,
            exact=True,
            reserve_count=2,
        )

        self.assertEqual(
            {item["id"] for item in result["selected"]},
            {"story-winner", "independent-story"},
        )
        alternate = next(item for item in result["reserves"] if item["id"] == "alternate-window")
        winner = next(item for item in result["selected"] if item["id"] == "story-winner")
        self.assertEqual(alternate["cluster_id"], winner["cluster_id"])
        self.assertEqual(alternate["variant_rank"], 2)
        self.assertEqual(alternate["duplicate_of"], winner["yield_id"])
        self.assertEqual(result["stats"]["unique_stories"], 2)
        self.assertEqual(result["stats"]["story_variants"], 1)
        self.assertEqual(result["stats"]["primary_stories"], 2)
        self.assertFalse(result["target_met"])

    def test_selection_reaches_lower_ranked_unique_stories(self):
        candidates = [
            candidate("top-window", 8.5, 0, 40, "Opening claim", ["launch"]),
            candidate("top-variant-a", 8.3, 15, 55, "Customer reaction", ["launch"]),
            candidate("top-variant-b", 8.1, 18, 58, "Revenue consequence", ["launch"]),
            candidate("unique-b", 7.0, 180, 215, "A sales story", ["sales"]),
            candidate("unique-c", 6.8, 360, 395, "A product story", ["product"]),
        ]
        result = sy.select_yield_candidates(
            candidates,
            target=3,
            soft_min=3,
            reserve_count=2,
        )

        self.assertEqual(
            {item["id"] for item in result["selected"]},
            {"top-window", "unique-b", "unique-c"},
        )
        self.assertEqual(
            len({item["cluster_id"] for item in result["selected"]}),
            len(result["selected"]),
        )
        self.assertEqual(result["stats"]["unique_stories"], 3)

    def test_reserves_exhaust_unused_stories_before_alternate_variants(self):
        candidates = [
            candidate("primary", 8.4, 0, 40, "Primary opening", ["launch"]),
            candidate("primary-alt", 8.0, 20, 60, "Primary consequence", ["launch"]),
            candidate("unused-b", 7.2, 180, 215, "Second story", ["sales"]),
            candidate("unused-c", 7.0, 360, 395, "Third story", ["product"]),
        ]
        result = sy.select_yield_candidates(
            candidates,
            target=1,
            soft_min=1,
            reserve_count=3,
        )

        primary_cluster = result["selected"][0]["cluster_id"]
        self.assertEqual(
            {item["id"] for item in result["reserves"][:2]},
            {"unused-b", "unused-c"},
        )
        self.assertTrue(
            all(item["cluster_id"] != primary_cluster for item in result["reserves"][:2])
        )
        self.assertEqual(result["reserves"][2]["id"], "primary-alt")
        self.assertEqual(result["reserves"][2]["cluster_id"], primary_cluster)
        self.assertEqual(result["reserves"][2]["duplicate_of"], "primary")
        self.assertEqual(result["stats"]["reserve_stories"], 3)

    def test_malformed_dicts_are_reported_without_mutating_inputs(self):
        inputs = [
            candidate("good", "6.7", 0),
            {"id": "no-score", "start": 10, "end": 20},
            {"id": "bad-range", "score": 8, "start": 20, "end": 10},
            {"id": "low", "score": 4.2, "start": 30, "end": 40},
            "not a dict",
        ]
        original = copy.deepcopy(inputs)
        result = sy.select_yield_candidates(inputs, target=3, soft_min=2)

        self.assertEqual([item["id"] for item in result["selected"]], ["good"])
        self.assertEqual(result["stats"]["rejected"], 4)
        self.assertEqual(inputs, original)

    def test_mapping_input_and_duration_fallback_are_supported(self):
        result = sy.select_yield_candidates(
            {"id": "single", "score": 6, "start": 2, "duration": 20},
            target=3,
            soft_min=2,
        )
        self.assertEqual(result["selected"][0]["id"], "single")


class ReserveBackfillTests(unittest.TestCase):
    def test_reserve_promotes_after_render_failure(self):
        selected = [
            {"id": "a", "yield_id": "a", "yield_role": "primary"},
            {"id": "b", "yield_id": "b", "yield_role": "primary"},
        ]
        reserves = [
            {"id": "c", "yield_id": "c", "yield_role": "reserve"},
            {"id": "d", "yield_id": "d", "yield_role": "reserve"},
        ]
        result = sy.backfill_failed_renders(selected, reserves, {"a"})

        self.assertEqual([item["id"] for item in result["selected"]], ["b", "c"])
        self.assertEqual(result["backfilled"][0]["yield_role"], "backfill")
        self.assertEqual([item["id"] for item in result["reserves"]], ["d"])
        self.assertEqual(result["unfilled"], 0)

    def test_backfill_skips_variant_of_a_surviving_story(self):
        selected = [
            {
                "id": "a",
                "yield_id": "a",
                "yield_role": "primary",
                "cluster_id": "story-a",
            },
            {
                "id": "b",
                "yield_id": "b",
                "yield_role": "primary",
                "cluster_id": "story-b",
            },
        ]
        reserves = [
            {
                "id": "b-alt",
                "yield_id": "b-alt",
                "yield_role": "reserve",
                "cluster_id": "story-b",
                "variant_rank": 2,
                "duplicate_of": "b",
            },
            {
                "id": "c",
                "yield_id": "c",
                "yield_role": "reserve",
                "cluster_id": "story-c",
                "variant_rank": 1,
                "duplicate_of": None,
            },
        ]
        result = sy.backfill_failed_renders(selected, reserves, {"a"})

        self.assertEqual([item["id"] for item in result["selected"]], ["b", "c"])
        self.assertEqual([item["id"] for item in result["reserves"]], ["b-alt"])
        self.assertEqual(result["backfilled"][0]["cluster_id"], "story-c")

    def test_backfill_can_use_an_alternate_of_the_failed_story(self):
        selected = [
            {"id": "a", "yield_id": "a", "cluster_id": "story-a"},
            {"id": "b", "yield_id": "b", "cluster_id": "story-b"},
        ]
        reserves = [
            {
                "id": "a-alt",
                "yield_id": "a-alt",
                "cluster_id": "story-a",
                "variant_rank": 2,
                "duplicate_of": "a",
            }
        ]
        result = sy.backfill_failed_renders(selected, reserves, {"a"})

        self.assertEqual([item["id"] for item in result["selected"]], ["b", "a-alt"])
        self.assertEqual(result["backfilled"][0]["yield_role"], "backfill")
        self.assertEqual(result["unfilled"], 0)

    def test_build_yield_batch_combines_plan_and_selection(self):
        candidates = [candidate(f"c{i}", 7 - (i * 0.1), i * 120) for i in range(8)]
        batch = sy.build_yield_batch(
            candidates,
            15 * 60,
            volume="balanced",
            max_clips=10,
            reserve_count=2,
        )
        self.assertEqual(batch["target"], 5)
        self.assertEqual(len(batch["selected"]), 5)
        self.assertEqual(len(batch["reserves"]), 2)


if __name__ == "__main__":
    unittest.main()
