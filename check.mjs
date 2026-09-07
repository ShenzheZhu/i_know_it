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
for (const [width, height, dpr, zoom, previewWidth] of [
  [390, 844, 1, 1, 250],
  [1024, 768, 1.25, 1.25, 613],
  [1440, 900, 2, 1, 720],
  [1536, 864, 2.5, 1.25, 877],
  [2560, 1440, 1.5, 0.75, 1000],
]) {
  const viewport = { width, height };
  const bitmap = { width: width * dpr, height: height * dpr };
  const preview = { width: previewWidth, height: previewWidth * height / width };
  const point = (x, y) => ({ x: x / width * preview.width, y: y / height * preview.height });
  const region = cropRect(point(64, 96), point(192, 256), preview, bitmap);
  // Outward pixel rounding must contain the requested CSS region, within one image pixel.
  for (const [actual, requested, start] of [
    [region.x / dpr, 64, true], [region.y / dpr, 96, true],
    [(region.x + region.width) / dpr, 192, false],
    [(region.y + region.height) / dpr, 256, false],
  ]) {
    assert.ok(Math.abs(actual - requested) <= 1 / dpr + 1e-8);
    assert.ok(start ? actual <= requested + 1e-8 : actual >= requested - 1e-8);
  }
  const full = cropRect(point(0, 0), point(width, height), preview, bitmap);
  assert.deepEqual(full, { x: 0, y: 0, ...bitmap });
  const text = describe({ viewport, scroll: { x: 10, y: 500 }, zoom, devicePixelRatio: dpr }, full, bitmap, "/tmp/capture.png");
  assert.ok(text.includes(`x=0, y=0, width=${width}, height=${height}`));
  assert.ok(text.includes("x=10, y=500"));
  assert.ok(text.includes(`Browser zoom: ${zoom * 100}%; devicePixelRatio=${dpr}`));
}
console.log("PASS: reverse crop, clamping, empty/invalid selection, scaled coordinates, scrolling, metadata, paths, and five viewport/DPR/zoom combinations.");
