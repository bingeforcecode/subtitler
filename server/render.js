import { spawn } from "node:child_process";
import { createCanvas, loadImage } from "@napi-rs/canvas";

/**
 * Compose a video with caption overlays.
 *
 * Strategy: render the caption layer in Node (canvas) at the video's native
 * resolution + framerate, pipe the raw RGBA frames into ffmpeg as a single
 * rawvideo input, and use ONE overlay filter to composite it onto the source.
 *
 * This avoids the "too many open files" / filtergraph blowup that happens
 * when you pass hundreds of PNG inputs (one per word). It scales to any
 * caption count.
 */
export async function composeVideo({ videoPath, events, outputPath, posV = "bottom", onProgress }) {
  const meta = await probeVideo(videoPath);
  const { width: W, height: H, fps, duration } = meta;

  if (!W || !H || !fps || !duration) {
    throw new Error(`probe failed: ${JSON.stringify(meta)}`);
  }

  // Compute each event's frame range up front, but DON'T decode the images yet.
  // Decoding every caption PNG at once is the main memory hog (a word-by-word
  // video has hundreds). Instead we load each image only while it's on screen
  // and release it once it passes, so memory stays flat (~1 image at a time).
  const evs = events
    .map((e) => ({
      ...e,
      startF: Math.floor(e.start * fps),
      endF: Math.max(Math.floor(e.start * fps) + 1, Math.ceil(e.end * fps)),
    }))
    .sort((a, b) => a.startF - b.startF);

  const totalFrames = Math.ceil(duration * fps);

  const args = [
    "-y",
    // Input 0: source video
    "-i", videoPath,
    // Input 1: raw RGBA caption layer piped via stdin
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-s", `${W}x${H}`,
    "-framerate", String(fps),
    "-i", "pipe:0",
    // Composite (overlay handles the alpha)
    "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[v]",
    "-map", "[v]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    "-progress", "pipe:2",
    "-nostats",
    outputPath,
  ];

  const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });

  let stderr = "";
  proc.stderr.on("data", (c) => {
    const s = c.toString();
    stderr += s;
    if (stderr.length > 8000) stderr = stderr.slice(-4000);
  });

  const done = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg compose failed (${code}): ${stderr.slice(-700)}`))
    );
  });

  // Render frames and pipe them in.
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  let activeIdx = 0;
  let lastReportedAt = 0;
  let loadedIdx = -1;     // which event's image is currently decoded
  let loadedImg = null;   // the decoded image (at most one alive at a time)

  for (let f = 0; f < totalFrames; f++) {
    // Advance past events that have ended.
    while (activeIdx < evs.length && evs[activeIdx].endF <= f) activeIdx++;
    const active =
      activeIdx < evs.length && evs[activeIdx].startF <= f ? evs[activeIdx] : null;

    ctx.clearRect(0, 0, W, H);
    if (active) {
      // Decode this event's PNG on demand; drop the previous one so the
      // garbage collector can reclaim it (keeps memory flat).
      if (loadedIdx !== activeIdx) {
        loadedImg = await loadImage(active.pngPath);
        loadedIdx = activeIdx;
      }
      const x = Math.round((W - active.width) / 2);
      const y =
        posV === "middle"
          ? Math.round((H - active.height) / 2)
          : Math.round(H - active.height - H * 0.18);
      ctx.drawImage(loadedImg, x, y);
    } else if (loadedImg) {
      loadedImg = null;
      loadedIdx = -1;
    }

    const imgData = ctx.getImageData(0, 0, W, H);
    const buf = Buffer.from(
      imgData.data.buffer,
      imgData.data.byteOffset,
      imgData.data.byteLength
    );

    if (!proc.stdin.write(buf)) {
      await new Promise((r) => proc.stdin.once("drain", r));
    }

    if (onProgress && f - lastReportedAt >= Math.max(1, Math.floor(fps / 2))) {
      onProgress(f / totalFrames);
      lastReportedAt = f;
    }
  }

  proc.stdin.end();
  await done;
}

/**
 * Probe a video for width, height, average framerate, and duration (seconds).
 */
export function probeVideo(videoPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate,avg_frame_rate:stream_tags=rotate:stream_side_data=rotation:format=duration",
      "-of", "json",
      videoPath,
    ];
    const proc = spawn("ffprobe", args);
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed (${code}): ${err}`));
      try {
        const json = JSON.parse(out);
        const s = (json.streams && json.streams[0]) || {};
        const duration = parseFloat((json.format && json.format.duration) || "0");
        const fps = parseFraction(s.avg_frame_rate) || parseFraction(s.r_frame_rate) || 30;
        let width = parseInt(s.width, 10) || 0;
        let height = parseInt(s.height, 10) || 0;

        // ffmpeg auto-rotates by default, so the frames flowing into our
        // overlay are sized for the *displayed* orientation. Detect rotation
        // from either the legacy `tags.rotate` field or the modern
        // `side_data_list[].rotation` and swap width/height when needed.
        let rotation = 0;
        const t = s.tags && s.tags.rotate ? parseInt(s.tags.rotate, 10) : NaN;
        if (Number.isFinite(t)) rotation = t;
        if (Array.isArray(s.side_data_list)) {
          for (const sd of s.side_data_list) {
            if (sd && typeof sd.rotation === "number") {
              rotation = sd.rotation;
              break;
            }
          }
        }
        const absRot = Math.abs(rotation) % 360;
        if (absRot === 90 || absRot === 270) {
          [width, height] = [height, width];
        }

        resolve({ width, height, fps, duration, rotation });
      } catch (e) {
        reject(new Error(`ffprobe parse failed: ${e.message}; raw=${out.slice(0, 200)}`));
      }
    });
  });
}

// Kept for backward compatibility with any caller that imported it.
export function probeDuration(videoPath) {
  return probeVideo(videoPath).then((m) => m.duration);
}

function parseFraction(s) {
  if (!s || typeof s !== "string") return 0;
  const [n, d] = s.split("/").map(Number);
  if (!d || !Number.isFinite(n) || !Number.isFinite(d)) return 0;
  return n / d;
}
