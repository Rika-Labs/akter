import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "match.py"
SPEC = importlib.util.spec_from_file_location("match_it_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

SCOPE = "declared geometry/style checks"
STATE = "welcome/top/light"
GEOMETRY = {
    "state": STATE,
    "checks": [{"region": "title", "metric": "box.x", "tolerance": 0.5}],
}
FAMILY = {
    "state": STATE,
    "checks": [{"region": "title", "metric": "styles.fontFamily"}],
}
MAPPED = {
    "state": STATE,
    "checks": [{
        "region": "title",
        "metric": "styles.color",
        "reference": "rgb(0, 0, 0)",
        "target": "rgb(1, 2, 3)",
    }],
}


def capture():
    return {
        "schema": 1,
        "state": STATE,
        "context": {
            "mode": "viewport",
            "coordinates": "css-viewport",
            "visualOffsetX": 0,
            "visualOffsetY": 0,
            "width": 1000,
            "height": 1000,
            "dpr": 2,
            "scale": 1,
            "scrollX": 0,
            "scrollY": 0,
            "userAgent": "fixture-browser",
            "colorScheme": "light",
            "reducedMotion": "no-preference",
        },
        "fonts": {"status": "loaded", "faces": []},
        "regions": {
            "title": {
                "box": {"x": 10, "y": 20, "width": 30, "height": 12},
                "styles": {
                    "fontFamily": "Fixture Sans",
                    "color": "rgb(0, 0, 0)",
                },
                "visible": True,
            },
        },
    }


def node_json(script, payload):
    result = subprocess.run(
        ["node", "-e", script],
        input=json.dumps(payload, allow_nan=False),
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    return json.loads(result.stdout)


class MatchTests(unittest.TestCase):
    def assert_verdict(self, reference, target, acceptance, expected):
        result = MODULE.compare(reference, target, acceptance)
        self.assertIsInstance(result, dict)
        self.assertEqual(result["verdict"], expected)
        self.assertEqual(result["scope"], SCOPE)
        self.assertIsInstance(result["failures"], list)
        if expected == "MEASUREMENTS_PASS":
            self.assertEqual(result["failures"], [])
        else:
            self.assertGreater(len(result["failures"]), 0)
            self.assertTrue(all(
                isinstance(value, str) and value.strip()
                for value in result["failures"]
            ))
        return result

    def test_geometry_tolerance_is_inclusive_symmetric_and_unrounded(self):
        for x, expected in [
            (10, "MEASUREMENTS_PASS"),
            (10.5, "MEASUREMENTS_PASS"),
            (9.5, "MEASUREMENTS_PASS"),
            (10.5001, "FAIL"),
            (9.4999, "FAIL"),
        ]:
            with self.subTest(x=x):
                target = capture()
                target["regions"]["title"]["box"]["x"] = x
                self.assert_verdict(capture(), target, GEOMETRY, expected)

    def test_zero_tolerance_is_not_replaced_by_a_default(self):
        acceptance = {
            "state": STATE,
            "checks": [{"region": "title", "metric": "box.x", "tolerance": 0}],
        }
        self.assert_verdict(capture(), capture(), acceptance, "MEASUREMENTS_PASS")
        target = capture()
        target["regions"]["title"]["box"]["x"] += 0.000001
        self.assert_verdict(capture(), target, acceptance, "FAIL")

    def test_all_declared_box_dimensions_are_evaluated(self):
        for metric in ["x", "y", "width", "height"]:
            with self.subTest(metric=metric):
                target = capture()
                target["regions"]["title"]["box"][metric] += 2
                acceptance = {
                    "state": STATE,
                    "checks": [{
                        "region": "title", "metric": f"box.{metric}",
                        "tolerance": 0.5,
                    }],
                }
                self.assert_verdict(capture(), target, acceptance, "FAIL")

    def test_geometry_rejects_invalid_tolerances_and_nonfinite_observations(self):
        for tolerance in [
            -0.1, float("nan"), float("inf"), -float("inf"),
            None, "0.5", True, False,
        ]:
            with self.subTest(tolerance=tolerance):
                acceptance = {
                    "state": STATE,
                    "checks": [{
                        "region": "title", "metric": "box.x",
                        "tolerance": tolerance,
                    }],
                }
                with self.assertRaises(ValueError):
                    MODULE.compare(capture(), capture(), acceptance)
        for x in [float("nan"), float("inf"), -float("inf"), None, "10", True, False]:
            for side in ["reference", "target"]:
                with self.subTest(x=x, side=side):
                    reference, target = capture(), capture()
                    changed = reference if side == "reference" else target
                    changed["regions"]["title"]["box"]["x"] = x
                    with self.assertRaises(ValueError):
                        MODULE.compare(reference, target, GEOMETRY)

    def test_empty_missing_and_mixed_unknown_checks_cannot_pass(self):
        invalid = [{"state": STATE}] + [
            {"state": STATE, "checks": checks}
            for checks in [None, [], {}, [None]]
        ]
        for acceptance in invalid:
            with self.subTest(acceptance=acceptance):
                with self.assertRaises(ValueError):
                    MODULE.compare(capture(), capture(), acceptance)
        for metric in ["ink.x", "canvasInk.width", "box.widht", "styles.notAStyle"]:
            with self.subTest(metric=metric):
                acceptance = {
                    "state": STATE,
                    "checks": GEOMETRY["checks"] + [{
                        "region": "title", "metric": metric, "tolerance": 0.5,
                    }],
                }
                with self.assertRaises(ValueError):
                    MODULE.compare(capture(), capture(), acceptance)

    def test_malformed_captures_raise_instead_of_returning_a_verdict(self):
        for bad in [None, {}, {**capture(), "schema": 2}, {**capture(), "schema": True}]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    MODULE.compare(bad, capture(), GEOMETRY)
                with self.assertRaises(ValueError):
                    MODULE.compare(capture(), bad, GEOMETRY)
        bad = capture()
        del bad["context"]["dpr"]
        with self.assertRaises(ValueError):
            MODULE.compare(capture(), bad, GEOMETRY)
        for key in [
            "width", "height", "dpr", "scale", "scrollX", "scrollY",
            "visualOffsetX", "visualOffsetY",
        ]:
            for value in [True, False]:
                for side in ["reference", "target"]:
                    with self.subTest(key=key, value=value, side=side):
                        reference, target = capture(), capture()
                        changed = reference if side == "reference" else target
                        changed["context"][key] = value
                        with self.assertRaises(ValueError):
                            MODULE.compare(reference, target, GEOMETRY)

    def test_missing_and_hidden_regions_fail_on_either_side(self):
        for side in ["reference", "target"]:
            for change in ["missing", "hidden"]:
                with self.subTest(side=side, change=change):
                    reference, target = capture(), capture()
                    changed = reference if side == "reference" else target
                    if change == "missing":
                        del changed["regions"]["title"]
                    else:
                        changed["regions"]["title"]["visible"] = False
                    self.assert_verdict(reference, target, GEOMETRY, "FAIL")

    def test_computed_fonts_match_and_manifest_cannot_override_them(self):
        self.assert_verdict(capture(), capture(), FAMILY, "MEASUREMENTS_PASS")
        target = capture()
        target["regions"]["title"]["styles"]["fontFamily"] = "Wrong Sans"
        target["fonts"]["faces"] = [{"family": "Fixture Sans", "status": "loaded"}]
        self.assert_verdict(capture(), target, FAMILY, "FAIL")
        del target["regions"]["title"]["styles"]["fontFamily"]
        self.assert_verdict(capture(), target, FAMILY, "FAIL")

    def test_style_mappings_constrain_both_captured_observations(self):
        target = capture()
        target["regions"]["title"]["styles"]["color"] = "rgb(1, 2, 3)"
        self.assert_verdict(capture(), target, MAPPED, "MEASUREMENTS_PASS")
        self.assert_verdict(capture(), target, {
            "state": STATE,
            "checks": [{"region": "title", "metric": "styles.color"}],
        }, "FAIL")
        wrong_reference = capture()
        wrong_reference["regions"]["title"]["styles"]["color"] = "rgb(9, 9, 9)"
        self.assert_verdict(wrong_reference, target, MAPPED, "FAIL")
        target["regions"]["title"]["styles"]["color"] = "rgb(9, 9, 9)"
        self.assert_verdict(capture(), target, MAPPED, "FAIL")

    def test_one_sided_mappings_raise(self):
        for key in ["reference", "target"]:
            with self.subTest(key=key):
                acceptance = copy.deepcopy(MAPPED)
                del acceptance["checks"][0][key]
                with self.assertRaises(ValueError):
                    MODULE.compare(capture(), capture(), acceptance)

    def test_acceptance_requires_explicit_state(self):
        acceptance = copy.deepcopy(GEOMETRY)
        del acceptance["state"]
        with self.assertRaises(ValueError):
            MODULE.compare(capture(), capture(), acceptance)

    def test_acceptance_state_matches_both_captures_not_just_their_agreement(self):
        self.assert_verdict(capture(), capture(), {
            **GEOMETRY, "state": "welcome/menu/light",
        }, "FAIL")
        for side in ["reference", "target", "both"]:
            with self.subTest(side=side):
                reference, target = capture(), capture()
                if side != "target":
                    reference["state"] = "welcome/menu/light"
                if side != "reference":
                    target["state"] = "welcome/menu/light"
                self.assert_verdict(reference, target, GEOMETRY, "FAIL")

    def test_mode_coordinates_and_visual_offsets_required_on_both_sides(self):
        for key in ["mode", "coordinates", "visualOffsetX", "visualOffsetY"]:
            for side in ["reference", "target", "both"]:
                with self.subTest(key=key, side=side):
                    reference, target = capture(), capture()
                    if side != "target":
                        del reference["context"][key]
                    if side != "reference":
                        del target["context"][key]
                    with self.assertRaises(ValueError):
                        MODULE.compare(reference, target, GEOMETRY)

    def test_state_readiness_and_every_context_mismatch_fail(self):
        changes = {
            "mode": "full-page", "coordinates": "css-document",
            "visualOffsetX": 3, "visualOffsetY": 7,
            "width": 999, "height": 999, "dpr": 1, "scale": 1.25,
            "scrollX": 1, "scrollY": 1, "userAgent": "other-browser",
            "colorScheme": "dark", "reducedMotion": "reduce",
        }
        for key, value in changes.items():
            for side in ["reference", "target"]:
                with self.subTest(key=key, side=side):
                    reference, target = capture(), capture()
                    changed = reference if side == "reference" else target
                    changed["context"][key] = value
                    self.assert_verdict(reference, target, GEOMETRY, "FAIL")
        wrong_state = capture()
        wrong_state["state"] = "welcome/menu/light"
        self.assert_verdict(capture(), wrong_state, GEOMETRY, "FAIL")
        unready = capture()
        unready["fonts"]["status"] = "loading"
        self.assert_verdict(capture(), unready, GEOMETRY, "FAIL")

    def test_one_failed_check_cannot_be_averaged_away(self):
        target = capture()
        target["regions"]["title"]["box"]["x"] = 13
        self.assert_verdict(capture(), target, {
            "state": STATE,
            "checks": FAMILY["checks"] + GEOMETRY["checks"],
        }, "FAIL")

    def test_tiny_shift_fails_despite_99_9992_percent_pixel_agreement(self):
        reference = capture()
        reference["regions"]["title"]["box"]["width"] = 2
        reference["regions"]["title"]["box"]["height"] = 2
        target = copy.deepcopy(reference)
        target["regions"]["title"]["box"]["x"] += 3
        self.assertEqual(8 / (1000 * 1000), 0.000008)
        self.assert_verdict(reference, target, GEOMETRY, "FAIL")

    def test_exported_browser_transform_uses_every_corner(self):
        self.assertIsInstance(MODULE.TRANSFORM, str)
        box = {"x": 1, "y": 2, "width": 3, "height": 4}
        oracles = [
            ({"a": 1, "b": 0, "c": 0, "d": 1, "e": 0, "f": 0}, box),
            ({"a": 0, "b": 1, "c": -1, "d": 0, "e": 10, "f": 20},
             {"x": 4, "y": 21, "width": 4, "height": 3}),
            ({"a": 1, "b": 1, "c": -1, "d": 1, "e": 10, "f": 20},
             {"x": 5, "y": 23, "width": 7, "height": 7}),
            ({"a": 1, "b": 0, "c": -2, "d": 1, "e": 5, "f": -3},
             {"x": -6, "y": -1, "width": 11, "height": 4}),
        ]
        actual = node_json("""
const fs = require('node:fs');
const vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const transform = vm.runInNewContext('(' + input.transform + ')', {}, {timeout: 1000});
const output = input.cases.map(value => transform(value.box, value.matrix));
process.stdout.write(JSON.stringify(output));
""", {
            "transform": MODULE.TRANSFORM,
            "cases": [{"box": box, "matrix": matrix} for matrix, _ in oracles],
        })
        self.assertEqual(actual, [expected for _, expected in oracles])

    def test_measurement_source_compiles_with_quoted_selector_data(self):
        source = MODULE.measurement_source({
            "state": STATE,
            "regions": {"title": "[data-label=\"it's quoted\"]"},
        })
        self.assertIsInstance(source, str)
        self.assertTrue(source.strip())
        compiled = node_json("""
const fs = require('node:fs');
const vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
new vm.Script('(' + input.source + ')');
process.stdout.write(JSON.stringify(true));
""", {"source": source})
        self.assertIs(compiled, True)


    def test_unknown_context_vocabularies_raise_on_either_or_both_sides(self):
        keys = ["mode", "coordinates", "colorScheme", "reducedMotion"]
        changes = [{key: "unsupported-value"} for key in keys]
        changes.append({key: "unsupported-value" for key in keys})
        for change in changes:
            for side in ["reference", "target", "both"]:
                with self.subTest(change=change, side=side):
                    reference, target = capture(), capture()
                    if side != "target":
                        reference["context"].update(change)
                    if side != "reference":
                        target["context"].update(change)
                    with self.assertRaises(ValueError):
                        MODULE.compare(reference, target, FAMILY)

    def test_supported_nonviewport_mode_fails_even_when_both_captures_agree(self):
        for side in ["reference", "target", "both"]:
            with self.subTest(side=side):
                reference, target = capture(), capture()
                if side != "target":
                    reference["context"]["mode"] = "full-page"
                if side != "reference":
                    target["context"]["mode"] = "full-page"
                self.assert_verdict(reference, target, FAMILY, "FAIL")

    def test_offscreen_region_fails_despite_visible_flag_and_matching_styles(self):
        for side in ["reference", "target", "both"]:
            with self.subTest(side=side):
                reference, target = capture(), capture()
                if side != "target":
                    reference["regions"]["title"]["box"]["x"] = -5000
                if side != "reference":
                    target["regions"]["title"]["box"]["x"] = -5000
                self.assertIs(reference["regions"]["title"]["visible"], True)
                self.assertIs(target["regions"]["title"]["visible"], True)
                self.assert_verdict(reference, target, FAMILY, "FAIL")

    def test_exact_viewport_edges_pass_but_one_pixel_past_each_edge_fails(self):
        edges = [
            ("left", {"x": 0, "y": 29, "width": 30, "height": 12}, "x", -1),
            ("right", {"x": 287, "y": 29, "width": 30, "height": 12}, "x", 288),
            ("top", {"x": 43, "y": 0, "width": 30, "height": 12}, "y", -1),
            ("bottom", {"x": 43, "y": 199, "width": 30, "height": 12}, "y", 200),
        ]
        for edge, box, axis, outside in edges:
            for side in ["reference", "target", "both"]:
                with self.subTest(edge=edge, side=side):
                    reference, target = capture(), capture()
                    for value in [reference, target]:
                        value["context"]["width"] = 317
                        value["context"]["height"] = 211
                    if side != "target":
                        reference["regions"]["title"]["box"] = dict(box)
                    if side != "reference":
                        target["regions"]["title"]["box"] = dict(box)
                    self.assert_verdict(
                        reference, target, FAMILY, "MEASUREMENTS_PASS",
                    )
                    if side != "target":
                        reference["regions"]["title"]["box"][axis] = outside
                    if side != "reference":
                        target["regions"]["title"]["box"][axis] = outside
                    self.assert_verdict(reference, target, FAMILY, "FAIL")


if __name__ == "__main__":
    unittest.main()
