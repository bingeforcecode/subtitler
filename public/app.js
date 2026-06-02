const $ = (id) => document.getElementById(id);

const fileInput = $("file");
const drop = $("drop");
const filenameEl = $("filename");
const goBtn = $("go");
const fontSel = $("font");

const stepUpload = $("step-upload");
const stepProgress = $("step-progress");
const stepResult = $("step-result");
const stepEdit = $("step-edit");
const bar = $("bar");
const statusEl = $("status");
const resultVideo = $("result");
const downloadLink = $("download");
const againBtn = $("again");
const editBtn = $("edit");
const rerenderBtn = $("rerender");
const cancelEditBtn = $("cancelEdit");
const captionsEl = $("captions");

// Compress tab elements
const tabSubtitle = $("tab-subtitle");
const tabCompress = $("tab-compress");
const stepCompress = $("step-compress");
const cdrop = $("cdrop");
const cfileInput = $("cfile");
const cfilenameEl = $("cfilename");
const cgoBtn = $("cgo");

let chosenFile = null;
let chosenCompressFile = null;
let currentMode = "subtitle"; // "subtitle" | "compress"
let currentJobId = null;
let currentCaptions = []; // [{ index, text, start, end }]
let editedText = new Map(); // index -> new text

async function loadFonts() {
  const res = await fetch("/api/fonts");
  const fonts = await res.json();
  fontSel.innerHTML = fonts
    .map((f) => `<option value="${f.key}">${f.label}</option>`)
    .join("");
}
loadFonts();

// ---- drag + drop ----
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  })
);
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) setFile(f);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files?.[0]) setFile(fileInput.files[0]);
});

function setFile(f) {
  if (!f.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)) {
    alert("Please choose a video file.");
    return;
  }
  chosenFile = f;
  filenameEl.textContent = `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`;
  goBtn.disabled = false;
}

// ---- submit ----
goBtn.addEventListener("click", async () => {
  if (!chosenFile) return;
  const fd = new FormData();
  fd.append("video", chosenFile);
  fd.append("font", fontSel.value);
  fd.append("style", $("style").value);
  fd.append("accent", $("accent").value);
  fd.append("fontSize", $("fontSize").value);
  fd.append("positionV", $("positionV").value);
  fd.append("uppercase", $("uppercase").checked ? "true" : "false");
  fd.append("script", $("script").value || "");

  stepUpload.classList.add("hidden");
  stepProgress.classList.remove("hidden");
  bar.style.width = "5%";
  statusEl.textContent = "Uploading…";

  const res = await fetch("/api/jobs", { method: "POST", body: fd });
  if (!res.ok) {
    statusEl.textContent = "Upload failed: " + (await res.text());
    return;
  }
  const { id } = await res.json();
  currentJobId = id;
  pollJob(id);
});

async function pollJob(id) {
  while (true) {
    await new Promise((r) => setTimeout(r, 700));
    const res = await fetch(`/api/jobs/${id}`);
    if (!res.ok) {
      statusEl.textContent = "Job lost.";
      return;
    }
    const job = await res.json();
    bar.style.width = `${Math.max(5, job.progress)}%`;
    statusEl.textContent = labelFor(job);
    if (job.status === "done") {
      stepProgress.classList.add("hidden");
      stepEdit.classList.add("hidden");
      stepResult.classList.remove("hidden");
      resultVideo.src = job.outputPath;
      downloadLink.href = `/api/jobs/${id}/download`;
      currentCaptions = job.captions || [];
      editBtn.style.display = job.editable && currentCaptions.length ? "" : "none";
      editedText.clear();
      return;
    }
    if (job.status === "error") {
      statusEl.textContent = "Error: " + (job.error || "unknown");
      return;
    }
  }
}

function labelFor(job) {
  switch (job.step) {
    case "transcribing": return "Transcribing audio with Scribe…";
    case "building subtitles": return "Building subtitle file…";
    case "re-rendering text": return "Updating edited captions…";
    case "rendering": return `Rendering MP4… ${job.progress}%`;
    case "compressing": return `Compressing video… ${job.progress}%`;
    case "done": return "Done.";
    default: return job.step || "Working…";
  }
}

// ---- tabs ----
function setMode(mode) {
  currentMode = mode;
  const sub = mode === "subtitle";
  tabSubtitle.classList.toggle("active", sub);
  tabCompress.classList.toggle("active", !sub);
  stepUpload.classList.toggle("hidden", !sub);
  stepCompress.classList.toggle("hidden", sub);
  // Always come back to the upload step when switching tabs.
  stepProgress.classList.add("hidden");
  stepResult.classList.add("hidden");
  stepEdit.classList.add("hidden");
}
tabSubtitle.addEventListener("click", () => setMode("subtitle"));
tabCompress.addEventListener("click", () => setMode("compress"));

// ---- compress: drag + drop ----
["dragenter", "dragover"].forEach((ev) =>
  cdrop.addEventListener(ev, (e) => { e.preventDefault(); cdrop.classList.add("over"); })
);
["dragleave", "drop"].forEach((ev) =>
  cdrop.addEventListener(ev, (e) => { e.preventDefault(); cdrop.classList.remove("over"); })
);
cdrop.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) setCompressFile(f);
});
cfileInput.addEventListener("change", () => {
  if (cfileInput.files?.[0]) setCompressFile(cfileInput.files[0]);
});

function setCompressFile(f) {
  if (!f.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)) {
    alert("Please choose a video file.");
    return;
  }
  chosenCompressFile = f;
  cfilenameEl.textContent = `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`;
  cgoBtn.disabled = false;
}

// ---- compress: submit ----
cgoBtn.addEventListener("click", async () => {
  if (!chosenCompressFile) return;
  const fd = new FormData();
  fd.append("video", chosenCompressFile);
  fd.append("targetMB", $("targetMB").value || "200");
  fd.append("scale1080", $("scale1080").checked ? "true" : "false");

  stepCompress.classList.add("hidden");
  stepProgress.classList.remove("hidden");
  bar.style.width = "5%";
  statusEl.textContent = "Uploading…";

  const res = await fetch("/api/compress", { method: "POST", body: fd });
  if (!res.ok) {
    statusEl.textContent = "Upload failed: " + (await res.text());
    return;
  }
  const { id } = await res.json();
  currentJobId = id;
  pollJob(id);
});

function fmtTime(t) {
  const s = Math.max(0, Number(t) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, "0")}`;
}

function renderCaptionRows() {
  captionsEl.innerHTML = "";
  for (const c of currentCaptions) {
    const row = document.createElement("label");
    row.className = "caption-row";
    const time = document.createElement("span");
    time.className = "caption-time";
    time.textContent = `${fmtTime(c.start)}`;
    const input = document.createElement("input");
    input.type = "text";
    input.value = editedText.get(c.index) ?? c.text;
    input.dataset.index = String(c.index);
    input.addEventListener("input", () => {
      const v = input.value;
      if (v === c.text) editedText.delete(c.index);
      else editedText.set(c.index, v);
    });
    // Click time → seek the result video to that point so you can hear the word.
    time.addEventListener("click", (e) => {
      e.preventDefault();
      if (resultVideo && Number.isFinite(c.start)) {
        resultVideo.currentTime = c.start;
        resultVideo.play().catch(() => {});
      }
    });
    row.appendChild(time);
    row.appendChild(input);
    captionsEl.appendChild(row);
  }
}

editBtn.addEventListener("click", () => {
  stepResult.classList.add("hidden");
  stepEdit.classList.remove("hidden");
  renderCaptionRows();
});

cancelEditBtn.addEventListener("click", () => {
  stepEdit.classList.add("hidden");
  stepResult.classList.remove("hidden");
});

rerenderBtn.addEventListener("click", async () => {
  if (!currentJobId) return;
  const edits = [];
  for (const [index, text] of editedText.entries()) {
    if (text.trim().length === 0) continue;
    edits.push({ index, text });
  }
  if (edits.length === 0) {
    alert("No edits to apply. Change at least one line first.");
    return;
  }
  stepEdit.classList.add("hidden");
  stepProgress.classList.remove("hidden");
  bar.style.width = "5%";
  statusEl.textContent = "Applying edits…";

  const res = await fetch(`/api/jobs/${currentJobId}/revise`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edits }),
  });
  if (!res.ok) {
    statusEl.textContent = "Re-render failed: " + (await res.text());
    return;
  }
  pollJob(currentJobId);
});

againBtn.addEventListener("click", async () => {
  // Free disk for the finished job before resetting the UI.
  if (currentJobId) {
    try { await fetch(`/api/jobs/${currentJobId}`, { method: "DELETE" }); } catch {}
  }
  currentJobId = null;
  currentCaptions = [];
  editedText.clear();
  chosenFile = null;
  fileInput.value = "";
  filenameEl.textContent = "";
  goBtn.disabled = true;
  chosenCompressFile = null;
  cfileInput.value = "";
  cfilenameEl.textContent = "";
  cgoBtn.disabled = true;
  stepResult.classList.add("hidden");
  stepEdit.classList.add("hidden");
  // Return to whichever tab the user was on.
  setMode(currentMode);
});
