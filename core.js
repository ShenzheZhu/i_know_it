export function cropRect(a, b, displayed, pixels) {
  if (![displayed.width, displayed.height, pixels.width, pixels.height].every(n => Number.isFinite(n) && n > 0)
      || ![a.x, a.y, b.x, b.y].every(Number.isFinite)) throw new Error("Invalid capture dimensions.");
  const clamp = (v, max) => Math.max(0, Math.min(v, max));
  if (clamp(a.x, displayed.width) === clamp(b.x, displayed.width)
      || clamp(a.y, displayed.height) === clamp(b.y, displayed.height)) throw new Error("Drag to select a region.");
  const x1 = Math.floor(clamp(Math.min(a.x, b.x), displayed.width) / displayed.width * pixels.width);
  const y1 = Math.floor(clamp(Math.min(a.y, b.y), displayed.height) / displayed.height * pixels.height);
  const x2 = Math.ceil(clamp(Math.max(a.x, b.x), displayed.width) / displayed.width * pixels.width);
  const y2 = Math.ceil(clamp(Math.max(a.y, b.y), displayed.height) / displayed.height * pixels.height);
  if (x2 <= x1 || y2 <= y1) throw new Error("Drag to select a region.");
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function describe(context, rect, pixels, path) {
  const round = n => Math.round(n * 100) / 100;
  const x = round(rect.x / pixels.width * context.viewport.width);
  const y = round(rect.y / pixels.height * context.viewport.height);
  const width = round(rect.width / pixels.width * context.viewport.width);
  const height = round(rect.height / pixels.height * context.viewport.height);
  // JSON string values keep newlines and Markdown in page-controlled titles inert.
  return [
    "Read this local screenshot and use its source context to address my feedback.",
    "",
    "## Screenshot context",
    `- Local image path: ${JSON.stringify(path)}`,
    `- Page URL: ${JSON.stringify(context.url)}`,
    `- Page title: ${JSON.stringify(context.title)}`,
    `- Captured at: ${context.timestamp}`,
    `- Region (viewport CSS px): x=${x}, y=${y}, width=${width}, height=${height}`,
    `- Region origin (document CSS px): x=${round(x + context.scroll.x)}, y=${round(y + context.scroll.y)}`,
    `- Page scroll (CSS px): x=${context.scroll.x}, y=${context.scroll.y}`,
    `- Viewport (CSS px): ${context.viewport.width} × ${context.viewport.height}`,
    `- Browser zoom: ${round(context.zoom * 100)}%; devicePixelRatio=${context.devicePixelRatio}`,
    `- Image (px): ${rect.width} × ${rect.height}`,
    "",
    "My feedback:",
  ].join("\n");
}
