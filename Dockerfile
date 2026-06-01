# Subtitler production image.
# Node 22 + ffmpeg/ffprobe + fontconfig (for @napi-rs/canvas text rendering).
FROM node:22-bookworm-slim

# System deps: ffmpeg gives us ffmpeg + ffprobe; fontconfig helps canvas.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better build caching).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the rest of the app (fonts are committed, so they come along).
COPY . .

# Render provides $PORT; default to 5174 for local docker runs.
ENV PORT=5174
EXPOSE 5174

CMD ["node", "server/index.js"]
