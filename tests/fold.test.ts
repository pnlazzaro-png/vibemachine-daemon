import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByPose, parseDisplays, poseOf } from "../src/fold.js";
import { parseProjectConfig } from "../src/project.js";

test("fold: screens grouped by pose, unposed first, then the views' order; each view a hinge angle and a turn", () => {
  const screens = [
    { name: "Desk", view: "desk" as const },
    { name: "Unfolded", view: "unfolded" as const },
    { name: "Folded", view: "folded" as const },
    { name: "Any" },
    { name: "Light", view: "unfolded" as const },
    { name: "Book", view: "book" as const },
  ];
  const groups = groupByPose(screens);
  assert.deepEqual(groups.map((g) => g.screens.map((s) => s.name)), [["Any"], ["Unfolded", "Light"], ["Book"], ["Desk"], ["Folded"]]);
  assert.equal(groups[0]!.pose, null);
  assert.deepEqual(poseOf("unfolded"), { angle: 180, orientation: "portrait" }, "holding the Duo upright and opening it gives the wide inner screen");
  assert.deepEqual(poseOf("desk"), { angle: 90, orientation: "landscape-left" });
  assert.deepEqual(poseOf("folded landscape"), { angle: 0, orientation: "landscape-left" });
});

test("fold: devicectl's displays, integrated ones only, active from the flag or else the backlight", () => {
  const result = {
    displays: [
      { name: "LCD", type: { integrated: {} }, active: true, backlightState: "activeOn", nativeSize: [1398, 2034] },
      { name: "LCD-1", type: { integrated: {} }, active: false, backlightState: "off", nativeSize: [2007, 2853] },
      { name: "AirPlay", type: { external: {} }, active: false, nativeSize: [1920, 1080] },
      { name: "Old", type: { integrated: {} }, backlightState: "activeOn", nativeSize: [10, 10] },
    ],
  };
  assert.deepEqual(parseDisplays(result), [
    { name: "LCD", active: true, backlight: "activeOn", area: 1398 * 2034 },
    { name: "LCD-1", active: false, backlight: "off", area: 2007 * 2853 },
    { name: "Old", active: true, backlight: "activeOn", area: 100 },
  ]);
  assert.deepEqual(parseDisplays(undefined), []);
});

test("project: a screen's view, and the display it implies", () => {
  const { preview } = parseProjectConfig({ preview: { bundle_id: "a.b", app: "x.app", screens: [
    { name: "Open", view: "unfolded" }, { name: "Shut", view: "folded landscape" }, { name: "Plain" },
  ] } }, "/tmp");
  assert.deepEqual(preview!.screens.map((s) => [s.name, s.view, s.display]), [["Open", "unfolded", "inner"], ["Shut", "folded landscape", "cover"], ["Plain", undefined, undefined]]);
  assert.throws(() => parseProjectConfig({ preview: { bundle_id: "a.b", app: "x.app", screens: [{ name: "Bad", view: "sideways" }] } }, "/tmp"), /view must be one of/);
});
