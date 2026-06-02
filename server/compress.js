import { spawn } from "node:child_process";
import { unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { probeVideo } from "./render.js";

/**
 * Compress a video to roughly a target file size using a two-pass x264 encode.
 *
 * Two-pass is the right tool for "hit ~200 MB": we compute the video bitrate
 * from the target size and duration, then let ffmpeg distribute it. Optionally
 * downscale to 1080p (never upscales), which alone cuts size dramatically on
 * 4K phone footage.
 */
export async function compressVideo({
  videoPath,
  targetMB = 200,
  scale1080 = true,
  outputPath,
  tmpDir,
  jobId,
  onProgress,
}) {
  const meta = await probeVideo(videoPath);
  const { duration } = meta;
  if (!duration || duration <= 0) {
    throw new Error(`could not read video duration (${JSON.stringify(meta)})`);
  }

  // Budget the bitrate. Reserve audio, give the rest to video.
  const audioKbps = 128;
  const totalKbps = (targetMB * 8 * 1024) / duration; // kbit/s for the whole file
  const videoKbps = Math.max(200, Math.floor(totalKbps - audioKbps));

  const passLog = join(tmpDir, `${jobId}-pass`);
  const vf = scale1080 ? ["-vf", "scale=-2:'min(1080,ih)'"] : [];

  // ---- Pass 1: analysis (no audio, no output file) ----
  await runFfmpeg(
    [
      "-y", "-i", videoPath,
      ...vf,
      "-c:v", "libx264", "-b:v", `${videoKbps}k`,
      "-pass", "1", "-passlogfile", passLog,
      "-preset", "medium", "-an",
      "-f", "null",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ],
    duration,
    (p) => onProgress && onProgress(p * 0.4) // pass 1 = first 40%
  );

  // ---- Pass 2: real encode ----
  await runFfmpeg(
    [
      "-y", "-i", videoPath,
      ...vf,
      "-c:v", "libx264", "-b:v", `${videoKbps}k`,
      "-pass", "2", "-passlogfile", passLog,
      "-preset", "medium",
      "-c:a", "aac", "-b:a", `${audioKbps}k`,
      "-movflags", "+faststart",
      outputPath,
    ],
    duration,
    (p) => onProgress && onProgress(0.4 + p * 0.6) // pass 2 = last 60%
  );

  // Clean up every two-pass log file ffmpeg leaves behind (including any
  // .temp variants from an interrupted pass).
  const prefix = `${jobId}-pass`;
  try {
    const files = await readdir(tmpDir);
    await Promise.all(
      files
        .filter((f) => f.startsWith(prefix))
        .map((f) => unlink(join(tmpDir, f)).catch(() => {}))
    );
  } catch {}
}

function runFfmpeg(args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [...args, "-progress", "pipe:2", "-nostats"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (c) => {
      const s = c.toString();
      stderr += s;
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
      // ffmpeg -progress emits "out_time_ms=NNN" lines.
      const m = [...s.matchAll(/out_time_ms=(\d+)/g)].pop();
      if (m && onProgress) {
        const sec = parseInt(m[1], 10) / 1_000_000;
        onProgress(Math.min(1, sec / duration));
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg compress failed (${code}): ${stderr.slice(-700)}`))
    );
  });
}
