/**
 * Build subtitle overlay PNGs from Scribe word-level timestamps.
 *
 * Two styles:
 *  - "karaoke": one word at a time, replacing the previous one. TikTok-style.
 *  - "phrase":  up to a few words shown together for the chunk's duration.
 *
 * Each event becomes a transparent PNG with the text drawn (white fill or
 * accent colour, thick black outline). The render step composites them onto
 * the source video with ffmpeg's overlay filter.
 */

import { createCanvas } from "@napi-rs/canvas";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const KARAOKE_MAX_WORDS = 1;     // pure popup style; "1" = one word visible
const PHRASE_MAX_WORDS = 5;
const PHRASE_GAP_SEC = 0.45;     // start a new chunk after a pause this long
const PAD_OUT_SEC = 0.04;        // extend each event slightly so they butt-join

// Strip trailing/leading punctuation so karaoke captions don't end every word
// with a period or comma. Keeps internal apostrophes/hyphens (e.g. "don't", "well-known").
function stripPunct(s) {
  return s.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

function extractWords(rawWords) {
  if (!Array.isArray(rawWords)) return [];
  return rawWords
    .filter((w) => w && w.type === "word" && typeof w.start === "number" && typeof w.end === "number")
    .map((w) => ({ text: stripPunct(String(w.text || "").trim()), start: w.start, end: w.end }))
    .filter((w) => w.text.length > 0);
}

function applyScript(words, script) {
  const tokens = (script || "").replace(/[\r\n]+/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return words;
  if (Math.abs(tokens.length - words.length) > Math.max(5, words.length * 0.25)) return words;
  return words.map((w, i) => (i < tokens.length ? { ...w, text: tokens[i] } : w));
}

function chunkWords(words, maxWords) {
  const chunks = [];
  let cur = [];
  for (const w of words) {
    if (cur.length === 0) { cur.push(w); continue; }
    const gap = w.start - cur[cur.length - 1].end;
    if (cur.length >= maxWords || gap > PHRASE_GAP_SEC) {
      chunks.push(cur);
      cur = [w];
    } else {
      cur.push(w);
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Render one PNG containing the given text. Returns { pngPath, width, height }.
 */
export async function renderPng({ text, font, fontSize, fillColor, outlineColor, outlineWidth, outPath }) {
  // Measure first.
  const measureCanvas = createCanvas(1, 1);
  const mctx = measureCanvas.getContext("2d");
  mctx.font = `${fontSize}px "${font.family}"`;
  const m = mctx.measureText(text);

  const pad = Math.max(outlineWidth * 2 + 8, 24);
  const ascent = m.actualBoundingBoxAscent || fontSize * 0.8;
  const descent = m.actualBoundingBoxDescent || fontSize * 0.25;
  const width = Math.ceil(m.width + pad * 2);
  const height = Math.ceil(ascent + descent + pad * 2);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontSize}px "${font.family}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  const cx = width / 2;
  const cy = height / 2;

  // Soft shadow for a touch of depth.
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 4;

  // Thick outline.
  ctx.strokeStyle = outlineColor;
  ctx.lineWidth = outlineWidth;
  ctx.strokeText(text, cx, cy);

  // Reset shadow before fill so the inner text stays crisp.
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Fill.
  ctx.fillStyle = fillColor;
  ctx.fillText(text, cx, cy);

  const buf = await canvas.encode("png");
  await writeFile(outPath, buf);
  return { pngPath: outPath, width, height };
}

/**
 * Top-level: build all caption PNG events for a job.
 *
 * Returns an array of events: { pngPath, width, height, start, end, posV }
 */
export async function buildCaptionEvents({
  words,
  style = "karaoke",
  font,
  fontSize = 84,
  color = "#FFFFFF",
  uppercase = false,
  script = "",
  tmpDir,
  jobId,
}) {
  let cleanWords = extractWords(words);
  if (script) cleanWords = applyScript(cleanWords, script);
  if (uppercase) cleanWords = cleanWords.map((w) => ({ ...w, text: w.text.toUpperCase() }));

  const maxWords = style === "karaoke" ? KARAOKE_MAX_WORDS : PHRASE_MAX_WORDS;
  const chunks = chunkWords(cleanWords, maxWords);

  const outlineWidth = Math.max(6, Math.round(fontSize * 0.12));
  const events = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const text = chunk.map((w) => w.text).join(" ");
    const start = chunk[0].start;
    const nextStart = i + 1 < chunks.length ? chunks[i + 1][0].start : Infinity;
    // Hold each event until just before the next one starts (no gaps in karaoke mode).
    const end = Math.min(chunk[chunk.length - 1].end + PAD_OUT_SEC, nextStart - 0.01);

    const pngPath = join(tmpDir, `${jobId}-cap-${i.toString().padStart(4, "0")}.png`);
    const { width, height } = await renderPng({
      text,
      font,
      fontSize,
      fillColor: color,
      outlineColor: "#000000",
      outlineWidth,
      outPath: pngPath,
    });

    events.push({
      pngPath,
      width,
      height,
      text,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
    });
  }

  return events;
}

/**
 * Re-render a single event PNG (used when the user edits a caption after
 * the initial pass). Returns an updated event object with new width/height.
 *
 * `event` must contain { pngPath } so we overwrite the existing file in place.
 */
export async function renderEventPng({ event, text, font, fontSize, color, uppercase }) {
  const displayText = uppercase ? String(text).toUpperCase() : String(text);
  const outlineWidth = Math.max(6, Math.round(fontSize * 0.12));
  const { width, height } = await renderPng({
    text: displayText,
    font,
    fontSize,
    fillColor: color,
    outlineColor: "#000000",
    outlineWidth,
    outPath: event.pngPath,
  });
  return { ...event, text: displayText, width, height };
}
