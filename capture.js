import { cropRect, describe } from "./core.js";

const $ = id => document.getElementById(id);
const stage = $("stage"), shot = $("shot"), selection = $("selection"), status = $("status");
let context, start, busy = false;
const pixels = () => ({ width: shot.naturalWidth, height: shot.naturalHeight });
const point = event => {
  const box = shot.getBoundingClientRect();
  return { x: Math.max(0, Math.min(event.clientX - box.left, box.width)), y: Math.max(0, Math.min(event.clientY - box.top, box.height)) };
};

async function download(dataUrl) {
  const id = await chrome.downloads.download({
    url: dataUrl,
    filename: `i_know_it/${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.png`,
    saveAs: false, conflictAction: "uniquify",
  });
  // Read only this download. Wait for completion before exposing its real path.
  for (let attempt = 0; attempt < 300; attempt++) {
    const [item] = await chrome.downloads.search({ id });
    if (!item || item.state === "interrupted") throw new Error(`Could not save image: ${item?.error ?? "download canceled"}`);
    if (item.state === "complete") return item.filename;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Saving timed out. Check Chrome downloads before trying again.");
}

async function copy() {
  await navigator.clipboard.writeText($("text").value);
  status.textContent = "Copied. Paste into your local coding agent. You can close this tab.";
}

async function finish(rect) {
  if (busy) return;
  busy = true;
  $("full").disabled = true;
  status.textContent = "Saving image and copying context…";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = rect.width; canvas.height = rect.height;
    canvas.getContext("2d").drawImage(shot, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const path = await download(canvas.toDataURL("image/png"));
    $("text").value = describe(context, rect, pixels(), path);
    $("text").hidden = false;
    $("copy").hidden = false;
    try { await copy(); }
    catch { status.textContent = "Image saved. Click Copy Markdown, or copy the text below manually."; }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    busy = false;
    $("full").disabled = false;
  }
}

stage.addEventListener("pointerdown", event => {
  if (busy || event.button !== 0) return;
  event.preventDefault();
  start = point(event);
  stage.setPointerCapture(event.pointerId);
  selection.hidden = true;
});
stage.addEventListener("pointermove", event => {
  if (!start) return;
  const end = point(event);
  Object.assign(selection.style, {
    left: `${Math.min(start.x, end.x)}px`, top: `${Math.min(start.y, end.y)}px`,
    width: `${Math.abs(start.x - end.x)}px`, height: `${Math.abs(start.y - end.y)}px`,
  });
  selection.hidden = false;
});
stage.addEventListener("pointerup", event => {
  if (!start) return;
  const origin = start; start = undefined;
  try { void finish(cropRect(origin, point(event), shot.getBoundingClientRect(), pixels())); }
  catch (error) { status.textContent = error.message; }
});
stage.addEventListener("pointercancel", () => { start = undefined; selection.hidden = true; });
$("full").onclick = () => { selection.hidden = true; void finish({ x: 0, y: 0, ...pixels() }); };
$("copy").onclick = () => copy().catch(error => { status.textContent = `Copy failed. Copy the text below manually: ${error.message}`; });
$("close").onclick = () => window.close();
document.addEventListener("keydown", event => { if (event.key === "Escape" && !busy) window.close(); });

try {
  const id = location.hash.slice(1);
  if (id.startsWith("error=")) throw new Error(decodeURIComponent(id.slice(6)));
  const data = (await chrome.storage.session.get(id))[id];
  if (!data) throw new Error("This capture expired. Return to the page and capture again.");
  await chrome.storage.session.remove(id);
  context = data.context;
  shot.src = data.image;
  await shot.decode();
  stage.hidden = false;
  $("full").disabled = false;
  status.textContent = "Drag a region to save and copy. Or capture the entire visible page.";
} catch (error) {
  status.textContent = `Capture failed: ${error.message}`;
}
