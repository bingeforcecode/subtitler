import express from "express";
import multer from "multer";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname } from "node:path";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync, createReadStream } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";

import { transcribe } from "./transcribe.js";
import { buildCaptionEvents, renderEventPng } from "./subtitles.js";
import { composeVideo } from "./render.js";
import { compressVideo } from "./compress.js";
import { FONTS, findFont, ensureFontsRegistered } from "./fonts.js";

ensureFontsRegistered();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const UPLOADS = join(ROOT, "uploads");
const RENDERS = join(ROOT, "renders");
const TMP = join(ROOT, "tmp");
const FONTS_DIR = join(ROOT, "fonts");
const PUBLIC_DIR = join(ROOT, "public");

await Promise.all([UPLOADS, RENDERS, TMP].map((d) => mkdir(d, { recursive: true })));

// ---- env loading: prefer local .env, fall back to ../video-studio/.env ----
function loadEnv() {
  const candidates = [
    join(ROOT, ".env"),
    resolve(ROOT, "..", "video-studio", ".env"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const [k, ...rest] = t.split("=");
      const key = k.trim();
      const val = rest.join("=").trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  }
}
loadEnv();

if (!process.env.ELEVENLABS_API_KEY) {
  console.warn(
    "WARNING: ELEVENLABS_API_KEY not set. Copy .env.example to .env and add your key, " +
      "or place a key in ../video-studio/.env."
  );
}

// ---- in-memory job state (single-process; fine for local use) ----
const jobs = new Map();

function newJob() {
  const id = randomUUID();
  const job = {
    id,
    status: "queued",
    step: "queued",
    progress: 0,
    error: null,
    outputPath: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}
function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
}

// ---- Express ----
const app = express();

// Optional password gate. Set APP_PASSCODE to require a password before anyone
// can use the site (keeps strangers from running up your ElevenLabs bill).
// If APP_PASSCODE is unset (e.g. local use), the gate is off.
const APP_PASSCODE = process.env.APP_PASSCODE || "";
if (APP_PASSCODE) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || "";
    const [scheme, encoded] = hdr.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString();
      const given = decoded.slice(decoded.indexOf(":") + 1);
      const a = Buffer.from(given);
      const b = Buffer.from(APP_PASSCODE);
      if (a.length === b.length && timingSafeEqual(a, b)) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Subtitler"');
    return res.status(401).send("Password required.");
  });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/renders", express.static(RENDERS));

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "999", 10);
const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

app.get("/api/fonts", (_req, res) => {
  res.json(FONTS);
});

app.post("/api/jobs", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing video file" });
  const fontKey = (req.body.font || "Inter").toString();
  const style = (req.body.style || "karaoke").toString(); // karaoke | phrase
  const color = (req.body.accent || "#FFFFFF").toString();
  const fontSize = parseInt(req.body.fontSize || "84", 10);
  const positionV = (req.body.positionV || "bottom").toString(); // bottom | middle
  const script = (req.body.script || "").toString();
  const uppercase = req.body.uppercase === "true" || req.body.uppercase === "1";

  const font = findFont(fontKey);

  const job = newJob();
  // Stash style + source path so we can re-render after edits.
  job.style = { fontKey, fontSize, color, uppercase, positionV };
  job.videoPath = req.file.path;
  job.events = [];
  res.json({ id: job.id });

  // Kick off background work (do not await the response)
  (async () => {
    let succeeded = false;
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) throw new Error("ELEVENLABS_API_KEY not configured");

      updateJob(job.id, { status: "running", step: "transcribing", progress: 10 });
      const transcript = await transcribe({
        videoPath: req.file.path,
        apiKey,
        tmpDir: TMP,
      });

      updateJob(job.id, { step: "building subtitles", progress: 55 });
      const events = await buildCaptionEvents({
        words: transcript.words,
        style,
        font,
        fontSize,
        color,
        uppercase,
        script,
        tmpDir: TMP,
        jobId: job.id,
      });
      job.events = events;

      updateJob(job.id, { step: "rendering", progress: 65 });
      const outputPath = join(RENDERS, `${job.id}.mp4`);
      await composeVideo({
        videoPath: req.file.path,
        events,
        outputPath,
        posV: positionV,
        onProgress: (p) =>
          updateJob(job.id, { progress: 65 + Math.round(p * 30) }),
      });

      updateJob(job.id, {
        status: "done",
        step: "done",
        progress: 100,
        outputPath: `/renders/${job.id}.mp4`,
      });
      succeeded = true;
    } catch (err) {
      console.error("job failed", job.id, err);
      updateJob(job.id, {
        status: "error",
        error: err?.message || String(err),
      });
    } finally {
      // On failure: clean everything. On success: keep source + PNGs so the
      // user can edit captions and re-render. They're discarded via DELETE.
      if (!succeeded) {
        if (req.file?.path) {
          try { await unlink(req.file.path); } catch {}
        }
        for (const ev of job.events || []) {
          try { await unlink(ev.pngPath); } catch {}
        }
        job.events = [];
        job.videoPath = null;
      }
    }
  })();
});

// Standalone compressor: shrink a video toward a target size (MB).
app.post("/api/compress", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing video file" });
  let targetMB = parseInt(req.body.targetMB || "200", 10);
  if (!Number.isFinite(targetMB) || targetMB < 10) targetMB = 200;
  const scale1080 = req.body.scale1080 !== "false"; // default on

  const job = newJob();
  res.json({ id: job.id });

  (async () => {
    try {
      updateJob(job.id, { status: "running", step: "compressing", progress: 5 });
      const outputPath = join(RENDERS, `${job.id}.mp4`);
      await compressVideo({
        videoPath: req.file.path,
        targetMB,
        scale1080,
        outputPath,
        tmpDir: TMP,
        jobId: job.id,
        onProgress: (p) => updateJob(job.id, { progress: 5 + Math.round(p * 92) }),
      });
      updateJob(job.id, {
        status: "done",
        step: "done",
        progress: 100,
        outputPath: `/renders/${job.id}.mp4`,
      });
    } catch (err) {
      console.error("compress failed", job.id, err);
      updateJob(job.id, { status: "error", error: err?.message || String(err) });
    } finally {
      if (req.file?.path) { try { await unlink(req.file.path); } catch {} }
    }
  })();
});

// Edit + re-render. Body: { edits: [{ index, text }] }
app.post("/api/jobs/:id/revise", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  if (!job.videoPath || !job.events?.length) {
    return res.status(400).json({ error: "job has no editable state (already discarded or failed)" });
  }
  const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
  if (edits.length === 0) return res.status(400).json({ error: "no edits" });

  const { fontKey, fontSize, color, uppercase, positionV } = job.style;
  const font = findFont(fontKey);

  res.json({ ok: true });

  (async () => {
    try {
      updateJob(job.id, { status: "running", step: "re-rendering text", progress: 10, error: null });

      // Apply edits in place. Only `text` is editable for now.
      for (const e of edits) {
        const idx = parseInt(e.index, 10);
        if (!Number.isInteger(idx) || idx < 0 || idx >= job.events.length) continue;
        const newText = String(e.text ?? "").trim();
        if (!newText) continue;
        const updated = await renderEventPng({
          event: job.events[idx],
          text: newText,
          font,
          fontSize,
          color,
          uppercase,
        });
        job.events[idx] = updated;
      }

      updateJob(job.id, { step: "rendering", progress: 40 });
      const outputPath = join(RENDERS, `${job.id}.mp4`);
      await composeVideo({
        videoPath: job.videoPath,
        events: job.events,
        outputPath,
        posV: positionV,
        onProgress: (p) =>
          updateJob(job.id, { progress: 40 + Math.round(p * 55) }),
      });

      updateJob(job.id, {
        status: "done",
        step: "done",
        progress: 100,
        outputPath: `/renders/${job.id}.mp4?v=${Date.now()}`,
      });
    } catch (err) {
      console.error("revise failed", job.id, err);
      updateJob(job.id, { status: "error", error: err?.message || String(err) });
    }
  })();
});

// User clicked "subtitle another video" — free disk for this job.
app.delete("/api/jobs/:id", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  if (job.videoPath) { try { await unlink(job.videoPath); } catch {} }
  for (const ev of job.events || []) {
    try { await unlink(ev.pngPath); } catch {}
  }
  job.events = [];
  job.videoPath = null;
  res.json({ ok: true });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const captions = (job.events || []).map((e, i) => ({
    index: i,
    text: e.text,
    start: e.start,
    end: e.end,
  }));
  res.json({
    id: job.id,
    status: job.status,
    step: job.step,
    progress: job.progress,
    error: job.error,
    outputPath: job.outputPath,
    editable: Boolean(job.videoPath && job.events?.length),
    captions,
  });
});

app.get("/api/jobs/:id/download", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") return res.status(404).end();
  const file = join(RENDERS, `${req.params.id}.mp4`);
  if (!existsSync(file)) return res.status(404).end();
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="subtitled-${req.params.id.slice(0, 8)}.mp4"`
  );
  createReadStream(file).pipe(res);
});

const PORT = parseInt(process.env.PORT || "5174", 10);
app.listen(PORT, () => {
  console.log(`subtitler ready at http://localhost:${PORT}`);
});
