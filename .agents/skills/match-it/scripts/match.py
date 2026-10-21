import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone


TRANSFORM = r"""function transformedBox(box, matrix) {
  if (
    ![
      box.x,
      box.y,
      box.width,
      box.height,
      ...["a", "b", "c", "d", "e", "f"].map((k) => matrix[k]),
    ].every(Number.isFinite) ||
    box.width < 0 ||
    box.height < 0
  )
    throw new Error("Invalid box or transform")
  const points = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ].map(([x, y]) => [
    matrix.a * x + matrix.c * y + matrix.e,
    matrix.b * x + matrix.d * y + matrix.f,
  ])
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1])
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}"""

MEASURE = r"""async function measurePage(config, mapBox, names) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Font readiness deadline exceeded")),
      config.fontTimeoutMs ?? 10000,
    )
    document.fonts.ready.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
  const rect = (b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })
  const regions = Object.fromEntries(
    Object.entries(config.regions).map(([id, selector]) => {
      const found = document.querySelectorAll(selector)
    if (found.length !== 1) throw new Error(`${id}: selector must match exactly one element`)
    const el = found[0],
        box = rect(el.getBoundingClientRect()),
      cs = getComputedStyle(el)
    if (!el.isConnected || typeof el.checkVisibility !== "function")
      throw new Error(`${id}: connected-element visibility checking is unavailable`)
      const visible =
        box.width > 0 &&
        box.height > 0 &&
        cs.visibility === "visible" &&
        cs.display !== "none" &&
        cs.opacity !== "0" &&
        el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false
      if (!visible) throw new Error(`${id}: element is hidden or has no area`)
      if (
        box.x < 0 ||
        box.y < 0 ||
        box.x + box.width > innerWidth ||
        box.y + box.height > innerHeight
      )
        throw new Error(`${id}: region is not wholly inside the viewport capture`)
      const range = document.createRange()
      range.selectNodeContents(el)
      const svgBoxes = [
        ...el.querySelectorAll("svg :is(path,circle,ellipse,rect,line,polyline,polygon)"),
      ]
        .filter((s) => !s.closest("defs,clipPath,mask,symbol"))
        .map((s) => {
          const m = s.getScreenCTM()
          return m ? mapBox(s.getBBox(), m) : null
        })
      return [
        id,
        {
          box,
          visible,
          styles: Object.fromEntries(names.map((k) => [k, cs[k]])),
          rangeBoxes: [...range.getClientRects()].map(rect),
          svgBoxes,
          ink: "unmeasured",
        },
      ]
    }),
  )
  return {
    schema: 1,
    state: config.state,
    documentIdentity: performance.timeOrigin,
    context: {
      mode: "viewport",
      coordinates: "css-viewport",
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      scale: visualViewport?.scale ?? 1,
      scrollX,
      scrollY,
      visualOffsetX: visualViewport?.offsetLeft ?? 0,
      visualOffsetY: visualViewport?.offsetTop ?? 0,
      userAgent: navigator.userAgent,
      colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "reduce"
        : "no-preference",
    },
    fonts: {
      status: document.fonts.status,
      faces: [...document.fonts].map((f) => ({
        family: f.family,
        weight: f.weight,
        style: f.style,
        status: f.status,
      })),
    },
    regions,
  }
}"""

STYLES = ["fontFamily","fontSize","fontWeight","fontStyle","fontStretch","fontFeatureSettings","fontVariationSettings","lineHeight","letterSpacing","textTransform","textAlign","direction","whiteSpace","color","backgroundColor","borderRadius","borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth","borderTopColor","boxShadow","opacity","transform"]


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def decode(text):
    def invalid(value):
        raise ValueError("Nonfinite JSON constant: " + value)
    return json.loads(text, parse_constant=invalid)


def measurement_source(config):
    if not isinstance(config, dict) or not isinstance(config.get("state"), str) or not config["state"].strip():
        raise ValueError("Expected a nonempty state")
    regions = config.get("regions")
    if not isinstance(regions, dict) or not regions:
        raise ValueError("Expected nonempty named selectors")
    for key, value in regions.items():
        if not isinstance(key, str) or not key.strip() or not isinstance(value, str) or not value.strip():
            raise ValueError("Invalid region selector")
    timeout = config.get("fontTimeoutMs", 10000)
    if not finite(timeout) or not 1 <= timeout <= 30000:
        raise ValueError("fontTimeoutMs must be between 1 and 30000")
    return "(" + MEASURE + ")(" + json.dumps(config, allow_nan=False) + ", " + TRANSFORM + ", " + json.dumps(STYLES) + ")"


CONTEXT_NUMBERS = ("width", "height", "dpr", "scale", "scrollX", "scrollY", "visualOffsetX", "visualOffsetY")
CONTEXT_ENUMS = {
    "mode": ("viewport", "full-page"),
    "coordinates": ("css-viewport", "css-document"),
    "colorScheme": ("light", "dark"),
    "reducedMotion": ("reduce", "no-preference"),
}
CONTEXT_KEYS = (*CONTEXT_NUMBERS, *CONTEXT_ENUMS, "userAgent")
BOX_KEYS = ("x", "y", "width", "height")


def validate_capture(capture, label):
    if not isinstance(capture, dict) or capture.get("schema") != 1 or type(capture.get("schema")) is bool:
        raise ValueError(label + ": invalid schema")
    if not isinstance(capture.get("state"), str) or not capture["state"].strip():
        raise ValueError(label + ": invalid state")
    if not isinstance(capture.get("regions"), dict):
        raise ValueError(label + ": invalid regions")
    fonts = capture.get("fonts")
    if not isinstance(fonts, dict) or not isinstance(fonts.get("faces"), list) or fonts.get("status") not in ("loaded", "loading"):
        raise ValueError(label + ": invalid fonts")
    context = capture.get("context")
    if not isinstance(context, dict):
        raise ValueError(label + ": missing context")
    for key in CONTEXT_NUMBERS:
        value = context.get(key)
        if not finite(value) or (key in ("width", "height", "dpr", "scale") and value <= 0):
            raise ValueError(label + ": invalid " + key)
    for key, choices in CONTEXT_ENUMS.items():
        if context.get(key) not in choices:
            raise ValueError(label + ": invalid " + key)
    if not isinstance(context.get("userAgent"), str) or not context["userAgent"].strip():
        raise ValueError(label + ": invalid userAgent")


def validate_check(check):
    if not isinstance(check, dict) or not isinstance(check.get("region"), str) or not check["region"].strip():
        raise ValueError("Expected a named region")
    metric = check.get("metric")
    geometry = metric in tuple("box." + key for key in BOX_KEYS)
    style = isinstance(metric, str) and metric.startswith("styles.") and metric[7:] in STYLES
    if not geometry and not style:
        raise ValueError("Unsupported metric; ink is not measured")
    if geometry:
        if set(check) != {"region", "metric", "tolerance"} or not finite(check["tolerance"]) or check["tolerance"] < 0:
            raise ValueError("Invalid geometry tolerance")
        return
    mapped = "reference" in check or "target" in check
    allowed = {"region", "metric", "reference", "target"} if mapped else {"region", "metric"}
    if set(check) != allowed:
        raise ValueError("Invalid style mapping or unknown check fields")
    if mapped and any(not isinstance(check[key], str) or not check[key] for key in ("reference", "target")):
        raise ValueError("Style mapping must constrain both observations")


def observed(capture, check, label, failures):
    region = capture["regions"].get(check["region"])
    name = label + ": " + check["region"] + "." + check["metric"]
    if not isinstance(region, dict) or region.get("visible") is not True:
        failures.append(name + " missing or hidden")
        return None
    box = region.get("box")
    if not isinstance(box, dict) or any(key not in box for key in BOX_KEYS):
        failures.append(name + " missing box")
        return None
    if any(not finite(box[key]) for key in BOX_KEYS):
        raise ValueError(name + " malformed box")
    if box["width"] <= 0 or box["height"] <= 0 or box["x"] < 0 or box["y"] < 0 or box["x"] + box["width"] > capture["context"]["width"] or box["y"] + box["height"] > capture["context"]["height"]:
        failures.append(name + " outside viewport or has no area")
        return None
    group, key = check["metric"].split(".")
    values = region.get(group)
    value = values.get(key) if isinstance(values, dict) else None
    if group == "styles" and (not isinstance(value, str) or not value):
        failures.append(name + " missing style")
        return None
    return value


def compare(reference, target, acceptance):
    if not isinstance(acceptance, dict) or not isinstance(acceptance.get("state"), str) or not acceptance["state"].strip():
        raise ValueError("Declare an acceptance state")
    checks = acceptance.get("checks")
    if not isinstance(checks, list) or not checks:
        raise ValueError("Declare at least one check")
    for check in checks:
        validate_check(check)
    validate_capture(reference, "reference")
    validate_capture(target, "target")
    failures = []
    if reference["state"] != target["state"] or reference["state"] != acceptance["state"]:
        failures.append("Capture/checklist state differs")
    for key in CONTEXT_KEYS:
        if reference["context"][key] != target["context"][key]:
            failures.append("Context differs: " + key)
    for label, capture in (("reference", reference), ("target", target)):
        if capture["fonts"]["status"] != "loaded":
            failures.append(label + ": fonts not settled")
        if capture["context"]["mode"] != "viewport" or capture["context"]["coordinates"] != "css-viewport":
            failures.append(label + ": unsupported capture area")
    for check in checks:
        left = observed(reference, check, "reference", failures)
        right = observed(target, check, "target", failures)
        if check["metric"].startswith("box."):
            matches = finite(left) and finite(right) and abs(left - right) <= check["tolerance"]
        elif "reference" in check:
            matches = left == check["reference"] and right == check["target"]
        else:
            matches = left is not None and right is not None and left == right
        if not matches:
            failures.append(check["region"] + "." + check["metric"] + ": observations do not meet declared check")
    return {"verdict": "FAIL" if failures else "MEASUREMENTS_PASS", "scope": "declared geometry/style checks", "checks": len(checks), "failures": failures}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def read_capture(path):
    if path.name != "measurement.json":
        raise ValueError("Expected a completed capture's measurement.json")
    manifest = decode((path.parent / "complete.json").read_text())
    measurement = path.read_bytes()
    image = (path.parent / "capture.png").read_bytes()
    if digest(measurement) != manifest.get("measurementSha256") or digest(image) != manifest.get("screenshotSha256"):
        raise ValueError("Capture artifact hashes differ")
    return decode(measurement)


def capture(session, config_path, directory):
    if not session.strip() or not directory.is_absolute():
        raise ValueError("Expected an active session and a new absolute directory")
    config_text = config_path.read_bytes()
    source = measurement_source(decode(config_text))

    def invoke(*args):
        child = subprocess.run(["agent-browser", "--session", session, "--pin-tab", "--json", *args],
            input=source, text=True, capture_output=True, timeout=35, check=False)
        if child.returncode != 0:
            raise ValueError("Browser " + args[0] + " failed; capture is incomplete")
        response = decode(child.stdout)
        data = response.get("data")
        if response.get("success") is not True or not isinstance(data, dict):
            raise ValueError("Browser response failed; capture is incomplete")
        lifecycle = data.get("lifecycle", {})
        if any(lifecycle.get(key) for key in ("launched", "relaunchedBrowser", "restartedBackground")):
            raise ValueError("Browser lifecycle changed; capture is incomplete")
        return data

    if session not in invoke("session", "list").get("sessions", []):
        raise ValueError("Session must already be active")
    info = invoke("session", "info")
    runtime = info.get("runtime", {})
    if info.get("active") is not True or runtime.get("browserLaunched") is not True or runtime.get("restoreStatus") != "not_configured":
        raise ValueError("Use an isolated owned session without auth restore")

    def active_tab():
        tabs = [tab for tab in invoke("tab", "list").get("tabs", []) if tab.get("active")]
        if len(tabs) != 1 or not tabs[0].get("targetId"):
            raise ValueError("Expected one active pinned target")
        return tabs[0]["targetId"]

    target_id = active_tab()
    before = invoke("eval", "--stdin").get("result")
    validate_capture(before, "capture")
    directory.mkdir()
    image = directory / "capture.png"
    invoke("screenshot", str(image))
    after = invoke("eval", "--stdin").get("result")
    if active_tab() != target_id or before != after or not image.is_file():
        raise ValueError("Observations changed around screenshot; capture is incomplete")
    measurement = json.dumps(before, indent=2, allow_nan=False).encode()
    with (directory / "measurement.json").open("xb") as output:
        output.write(measurement)
    manifest = {"targetId": target_id, "configSha256": digest(config_text), "screenshotSha256": digest(image.read_bytes()),
        "measurementSha256": digest(measurement), "createdAt": datetime.now(timezone.utc).isoformat(),
        "consistency": "Equal observations bracketing a viewport screenshot; not atomic or continuous evidence"}
    with (directory / "complete.json").open("x") as output:
        json.dump(manifest, output, indent=2)
    return str(directory / "complete.json")


def main(args):
    if len(args) == 2 and args[0] == "source":
        print(measurement_source(decode(Path(args[1]).read_text())))
        return 0
    if len(args) == 4 and args[0] == "capture":
        print(capture(args[1], Path(args[2]), Path(args[3])))
        return 0
    if len(args) == 4 and args[0] == "compare":
        acceptance = Path(args[3]).read_bytes()
        result = compare(read_capture(Path(args[1])), read_capture(Path(args[2])), decode(acceptance))
        result["acceptanceSha256"] = digest(acceptance)
        print(json.dumps(result, indent=2, allow_nan=False))
        return 0 if result["verdict"] == "MEASUREMENTS_PASS" else 1
    raise ValueError("Usage: python3 -B match.py source CONFIG | capture SESSION CONFIG ABSOLUTE_NEW_DIR | compare REFERENCE TARGET ACCEPTANCE")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
