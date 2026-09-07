import assert from "node:assert/strict";
import { cropRect, describe } from "./core.js";

const displayed = { width: 720, height: 450 }, pixels = { width: 2880, height: 1800 };
const rect = cropRect({ x: 300, y: 200 }, { x: 60, y: 40 }, displayed, pixels);
assert.deepEqual(rect, { x: 240, y: 160, width: 960, height: 640 });
assert.deepEqual(cropRect({ x: -5, y: -5 }, { x: 800, y: 500 }, displayed, pixels), { x: 0, y: 0, ...pixels });
assert.throws(() => cropRect({ x: 1, y: 1 }, { x: 1, y: 1 }, displayed, pixels));
assert.throws(() => cropRect({ x: 1.1, y: 1.1 }, { x: 1.1, y: 1.1 }, displayed, pixels));
assert.throws(() => cropRect({ x: 1.1, y: 1.1 }, { x: 10, y: 1.1 }, displayed, pixels));
assert.throws(() => cropRect({ x: NaN, y: 0 }, { x: 20, y: 10 }, displayed, pixels));
const markdown = describe({
  viewport: { width: 1440, height: 900 }, scroll: { x: 20, y: 800 },
  url: "https://example.com/settings?q=a&b=2#panel", title: "Title\n## injected",
  timestamp: "2026-09-07T12:00:00.000Z", zoom: 1.25, devicePixelRatio: 2.5,
}, rect, pixels, "/Users/example/My Downloads/café.png");
assert.ok(markdown.includes("x=120, y=80, width=480, height=320"));
assert.ok(markdown.includes("x=140, y=880"));
assert.ok(markdown.includes('"Title\\n## injected"'));
assert.ok(markdown.includes('"/Users/example/My Downloads/café.png"'));
assert.ok(markdown.includes("125%"));
console.log("PASS: reverse crop, clamping, empty/invalid selection, scaled coordinates, scrolling, metadata and paths.");
