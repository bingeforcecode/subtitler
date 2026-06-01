import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";

/**
 * Extract mono 16 kHz wav from a video using ffmpeg.
 */
function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", videoPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      audioPath,
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg audio extract failed (${code}): ${stderr.slice(-400)}`))
    );
  });
}

/**
 * Call ElevenLabs Scribe with the extracted audio. Returns the parsed JSON
 * response which includes a `words` array with `start`/`end` timestamps.
 */
async function callScribe({ audioPath, apiKey }) {
  const buf = await readFile(audioPath);
  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("timestamps_granularity", "word");
  form.append("diarize", "false");
  form.append("tag_audio_events", "false");
  form.append(
    "file",
    new Blob([buf], { type: "audio/wav" }),
    "audio.wav"
  );

  const resp = await fetch(SCRIBE_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Scribe ${resp.status}: ${text.slice(0, 400)}`);
  }
  return resp.json();
}

export async function transcribe({ videoPath, apiKey, tmpDir }) {
  const audioPath = join(tmpDir, `${randomUUID()}.wav`);
  try {
    await extractAudio(videoPath, audioPath);
    const json = await callScribe({ audioPath, apiKey });
    return json;
  } finally {
    try { await unlink(audioPath); } catch {}
  }
}
