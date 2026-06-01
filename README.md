# Subtitler

Drop a video, get word-synced TikTok-style subtitles burned in, download as MP4.

Runs locally as a small web app. Built on:
- **ElevenLabs Scribe** for word-level transcription
- **@napi-rs/canvas** to render each caption as a transparent PNG
- **ffmpeg overlay filter** to composite the captions onto the video
  (works on any vanilla ffmpeg build — no libass / libfreetype required)
- A curated set of Google Fonts (Inter, Montserrat, Bebas Neue, etc.)

## Setup

```bash
cd subtitler
npm install
npm run fonts        # downloads ~10 curated subtitle fonts into ./fonts/
cp .env.example .env
# add ELEVENLABS_API_KEY=... to .env
# (or, if you already have ~/Desktop/Claude Code/video-studio/.env, it will be picked up automatically)
npm start
```

Open <http://localhost:5174>.

## How it works

1. Upload a video (mp4/mov/webm, up to 500 MB).
2. Pick a font, style (karaoke vs. phrase), accent colour, size, position.
3. Server extracts mono 16 kHz audio with ffmpeg.
4. Audio is sent to ElevenLabs Scribe; we get `words[]` with `start`/`end` timestamps.
5. Words are chunked (one per event in karaoke mode, up to 5 in phrase mode).
6. Each chunk is rendered to a transparent PNG using `@napi-rs/canvas` —
   bold fill, thick black outline, drop shadow.
7. ffmpeg composes the final MP4 by chaining one `overlay` filter per chunk,
   each gated by `enable='between(t, start, end)'`.
8. You download the MP4.

## Requirements

- Node.js 20+
- ffmpeg + ffprobe on `PATH` (Homebrew: `brew install ffmpeg`)
- An ElevenLabs API key

## Sharing it with others

This is a local web app. If you want to share publicly, you can:
- Deploy to a small VPS / Railway / Fly.io (the whole thing is ~10 files).
- Or run it locally and expose it temporarily with `ngrok http 5174`.

## Project layout

```
subtitler/
  server/
    index.js       # Express server, job state
    transcribe.js  # ffmpeg audio extract + Scribe call
    subtitles.js   # word timings -> caption PNGs via canvas
    render.js      # ffmpeg overlay-chain compose
    fonts.js       # curated font list + canvas font registration
  public/
    index.html
    app.js
    style.css
  fonts/
    download.sh    # downloads OFL/Apache fonts from google/fonts
```
