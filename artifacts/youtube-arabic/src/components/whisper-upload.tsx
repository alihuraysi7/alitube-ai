import { useRef, useState, useEffect, useCallback } from "react";
import { Upload, FileAudio, Loader2, AlertCircle, CheckCircle2, Download, Mic } from "lucide-react";
import { useSettings } from "@/contexts/settings-context";
import { addHistoryItem } from "@/lib/storage";
import { useDubbing, type DubSegment } from "@/lib/use-dubbing";

interface TranslatedSegment {
  start: number;
  end: number;
  text: string;
  arabic: string;
}

interface WhisperResult {
  language: string;
  language_probability: number;
  segments: TranslatedSegment[];
}

const ACCEPTED = ".mp4,.mov,.mkv,.webm,.mp3,.wav,.m4a";
const VIDEO_EXTS = /\.(mp4|mov|mkv|webm)$/i;

const LABELS: Record<string, string> = {
  en: "إنجليزي", ar: "عربي", fr: "فرنسي", de: "ألماني",
  es: "إسباني", it: "إيطالي", ja: "ياباني", zh: "صيني",
  ru: "روسي", pt: "برتغالي", ko: "كوري", tr: "تركي",
};

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB — keep in sync with the API server
const MAX_UPLOAD_LABEL = "1 جيجابايت";

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} جيجابايت`;
  return `${Math.round(bytes / 1024 / 1024)} ميجابايت`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "extract":   return "جارٍ استخراج الصوت…";
    case "whisper":   return "جارٍ تشغيل Whisper (التعرّف على الكلام)…";
    case "translate": return "جارٍ الترجمة إلى العربية…";
    default:          return "جارٍ المعالجة على الخادم…";
  }
}

/**
 * Step 1 — ask the server for a presigned URL, then PUT the file straight to
 * object storage with real upload progress. Uploading directly to storage
 * bypasses the deployment's request-body limit (32 MiB on Autoscale), so large
 * videos can be sent. Resolves with the stored object's path.
 */
function uploadToStorage(
  file: File,
  onProgress: (msg: string) => void,
  registerXhr: (xhr: XMLHttpRequest) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    onProgress("جارٍ تجهيز الرفع…");
    fetch("/api/storage/uploads/request-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        contentType: file.type || "application/octet-stream",
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          let msg = `تعذّر تجهيز الرفع (${res.status}).`;
          try {
            const obj = (await res.json()) as { error?: string };
            if (obj.error) msg = obj.error;
          } catch { /* keep default */ }
          throw new Error(msg);
        }
        return res.json() as Promise<{ uploadURL: string; objectPath: string }>;
      })
      .then(({ uploadURL, objectPath }) => {
        const xhr = new XMLHttpRequest();
        registerXhr(xhr);
        xhr.open("PUT", uploadURL);
        xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            onProgress(`جارٍ رفع الملف… ${pct}%`);
          } else {
            onProgress("جارٍ رفع الملف…");
          }
        };
        xhr.upload.onload = () => onProgress("اكتمل الرفع — جارٍ المعالجة على الخادم…");

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(objectPath);
          else reject(new Error(`تعذّر رفع الملف إلى التخزين (${xhr.status}). حاول مرة أخرى.`));
        };
        xhr.onerror = () => reject(new Error("تعذّر الاتصال بخدمة التخزين أثناء الرفع."));
        xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));

        xhr.send(file);
      })
      .catch(reject);
  });
}

/**
 * Step 2 — tell /api/whisper to process the already-uploaded object, then read
 * the server's newline-delimited (NDJSON) progress stream. The server emits one
 * JSON object per line: {"phase": "..."} for each processing phase and finally
 * {"result": {...}}; errors arrive as {"error": "..."}.
 */
function processObject(
  objectPath: string,
  filename: string,
  engine: string,
  onProgress: (msg: string) => void,
  registerXhr: (xhr: XMLHttpRequest) => void,
): Promise<WhisperResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    registerXhr(xhr);
    xhr.open("POST", "/api/whisper");
    xhr.responseType = "text";
    xhr.setRequestHeader("Content-Type", "application/json");

    let consumed = 0; // bytes of responseText already parsed
    let finalResult: WhisperResult | null = null;
    let streamError: string | null = null;

    const drain = () => {
      const text = xhr.responseText;
      let nl: number;
      while ((nl = text.indexOf("\n", consumed)) !== -1) {
        const line = text.slice(consumed, nl).trim();
        consumed = nl + 1;
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as {
            phase?: string;
            error?: string;
            result?: WhisperResult;
          };
          if (obj.error) streamError = obj.error;
          else if (obj.result) finalResult = obj.result;
          else if (obj.phase) onProgress(phaseLabel(obj.phase));
        } catch {
          /* ignore a malformed line; a complete line ends at the newline */
        }
      }
    };

    xhr.onprogress = () => drain();

    xhr.onload = () => {
      drain();
      // Non-streaming error responses (validation) come back as a single JSON object.
      if (xhr.status >= 400 && !streamError && !finalResult) {
        try {
          const obj = JSON.parse(xhr.responseText) as { error?: string };
          streamError = obj.error ?? `خطأ من الخادم (${xhr.status}).`;
        } catch {
          streamError = `استجابة غير متوقعة من الخادم (${xhr.status}). حاول مرة أخرى.`;
        }
      }
      if (streamError) reject(new Error(streamError));
      else if (finalResult) resolve(finalResult);
      else reject(new Error("لم يكتمل استخراج النتيجة من الخادم."));
    };

    xhr.onerror = () => reject(new Error("تعذّر الاتصال بالخادم أثناء المعالجة."));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    xhr.ontimeout = () => reject(new Error("انتهت مهلة المعالجة. حاول بملف أقصر."));

    xhr.send(JSON.stringify({ objectPath, filename, engine }));
  });
}

/**
 * Full pipeline: upload the file directly to storage, then process it.
 */
async function uploadAndProcess(
  file: File,
  engine: string,
  onProgress: (msg: string) => void,
  registerXhr: (xhr: XMLHttpRequest) => void,
): Promise<WhisperResult> {
  const objectPath = await uploadToStorage(file, onProgress, registerXhr);
  return processObject(objectPath, file.name, engine, onProgress, registerXhr);
}

/* ── WebVTT generation for native <track> (enables fullscreen subtitles) ── */
function toVttTime(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${sec.toFixed(3).padStart(6,"0")}`;
}
function buildVtt(segs: TranslatedSegment[]): string {
  return ["WEBVTT", "", ...segs.map((s, i) =>
    `${i + 1}\n${toVttTime(s.start)} --> ${toVttTime(s.end)}\n${s.arabic}`
  )].join("\n\n");
}

/* ── Dubbing audio helpers for export ── */
const DUB_CHUNK_SIZE = 12;
const DUB_RATE_MIN = 0.8;
const DUB_RATE_MAX = 2.2;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/* Fetch + decode the Arabic dubbed audio for every segment (server cached, no re-bill). */
async function fetchDubbedBuffers(
  segs: TranslatedSegment[],
  voiceId: string,
  audioCtx: AudioContext,
  onProgress: (pct: number) => void,
): Promise<(AudioBuffer | null)[]> {
  const out: (AudioBuffer | null)[] = new Array(segs.length).fill(null);
  let done = 0;
  for (let i = 0; i < segs.length; i += DUB_CHUNK_SIZE) {
    const chunk = segs
      .slice(i, i + DUB_CHUNK_SIZE)
      .map((s, j) => ({ index: i + j, text: s.arabic }));
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments: chunk, voiceId }),
    });
    const data = (await res.json()) as { clips?: { index: number; audio: string | null }[]; error?: string };
    if (!res.ok || data.error) {
      throw new Error(data.error ?? `فشل تجهيز الصوت المدبلج (${res.status})`);
    }
    for (const clip of data.clips ?? []) {
      if (clip.audio && clip.index >= 0 && clip.index < out.length) {
        try {
          out[clip.index] = await audioCtx.decodeAudioData(base64ToArrayBuffer(clip.audio));
        } catch {
          out[clip.index] = null;
        }
      }
    }
    done += chunk.length;
    onProgress(Math.round((done / segs.length) * 100));
  }
  return out;
}

/* ── Burn subtitles (and optionally dubbed audio) into video via canvas + MediaRecorder ── */
async function burnAndDownload(
  videoUrl: string,
  segs: TranslatedSegment[],
  filename: string,
  opts: { dubbed: boolean; voiceId: string; showSubtitles: boolean },
  onProgress: (msg: string) => void,
) {
  // Create + resume the context synchronously so it stays unlocked across the
  // awaited TTS fetch (browser autoplay grants run on the click gesture).
  const audioCtx = new AudioContext();
  void audioCtx.resume().catch(() => undefined);

  // Pre-fetch + decode dubbed audio before recording so playback can be scheduled.
  let dubBuffers: (AudioBuffer | null)[] = [];
  if (opts.dubbed) {
    try {
      onProgress("جارٍ تجهيز الصوت المدبلج…");
      dubBuffers = await fetchDubbedBuffers(segs, opts.voiceId, audioCtx, (pct) =>
        onProgress(`جارٍ تجهيز الصوت المدبلج… ${pct}%`),
      );
    } catch (err) {
      await audioCtx.close().catch(() => undefined);
      throw err;
    }
    if (!dubBuffers.some(Boolean)) {
      await audioCtx.close().catch(() => undefined);
      throw new Error("تعذّر تجهيز الصوت المدبلج — حاول مرة أخرى");
    }
  }

  return new Promise<void>((resolve, reject) => {
    const vid = document.createElement("video");
    vid.src = videoUrl;
    vid.crossOrigin = "anonymous";
    vid.muted = false;
    vid.preload = "auto";

    vid.onloadedmetadata = () => {
      const W = vid.videoWidth || 1280, H = vid.videoHeight || 720;
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d")!;

      // Audio graph: original audio (muted when dubbing) + scheduled dubbed clips.
      const audioSrc = audioCtx.createMediaElementSource(vid);
      const audioDest = audioCtx.createMediaStreamDestination();
      const origGain = audioCtx.createGain();
      origGain.gain.value = opts.dubbed ? 0 : 1;
      audioSrc.connect(origGain);
      origGain.connect(audioDest);

      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus" : "video/webm";
      const stream = new MediaStream([
        ...canvas.captureStream(30).getVideoTracks(),
        ...audioDest.stream.getAudioTracks(),
      ]);
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks: BlobPart[] = [];
      rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

      rec.onstop = () => {
        audioCtx.close();
        const blob = new Blob(chunks, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename.replace(/\.[^.]+$/, "_ar.webm");
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        resolve();
      };
      rec.onerror = (e) => { audioCtx.close(); reject(e); };

      let raf = 0;
      const fontSize = Math.round(H * 0.048);

      // Break a single token that is wider than maxWidth into character chunks
      function breakLongWord(word: string, maxWidth: number): string[] {
        const chunks: string[] = [];
        let current = "";
        for (const ch of word) {
          const candidate = current + ch;
          if (current && ctx.measureText(candidate).width > maxWidth) {
            chunks.push(current);
            current = ch;
          } else {
            current = candidate;
          }
        }
        if (current) chunks.push(current);
        return chunks;
      }

      // Wrap text into lines that fit within maxWidth
      function wrapLines(text: string, maxWidth: number): string[] {
        const words = text.split(/\s+/).filter(Boolean);
        if (words.length === 0) return [];
        const lines: string[] = [];
        let current = "";
        for (const word of words) {
          // A single word too wide on its own — break it into character chunks
          if (ctx.measureText(word).width > maxWidth) {
            if (current) { lines.push(current); current = ""; }
            const chunks = breakLongWord(word, maxWidth);
            for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]);
            current = chunks[chunks.length - 1] ?? "";
            continue;
          }
          const candidate = current ? `${current} ${word}` : word;
          if (ctx.measureText(candidate).width <= maxWidth) {
            current = candidate;
          } else {
            lines.push(current);
            current = word;
          }
        }
        if (current) lines.push(current);
        return lines;
      }

      function drawFrame() {
        ctx.drawImage(vid, 0, 0, W, H);
        const t = vid.currentTime;
        const seg = opts.showSubtitles ? segs.find(s => t >= s.start && t < s.end) : undefined;
        const text = seg ? seg.arabic.trim() : "";
        if (seg && text) {
          ctx.font = `bold ${fontSize}px Tajawal, Cairo, sans-serif`;
          ctx.textAlign = "center";
          ctx.direction = "rtl";

          const px = 20, py = 10;
          const lineGap = Math.round(fontSize * 0.3);
          const maxTextWidth = W * 0.9 - px * 2;
          const lines = wrapLines(text, maxTextWidth);
          const lineHeight = fontSize + lineGap;

          let widest = 0;
          for (const ln of lines) widest = Math.max(widest, ctx.measureText(ln).width);

          const boxW = widest + px * 2;
          const boxH = lines.length * lineHeight - lineGap + py * 2;
          const bx = W / 2 - boxW / 2;
          // anchor box so its bottom sits near 0.92*H, but never run off the top
          const by = Math.max(8, H * 0.92 - boxH);

          ctx.fillStyle = "rgba(0,0,0,0.76)";
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, 8);
          else ctx.rect(bx, by, boxW, boxH);
          ctx.fill();

          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = "rgba(0,0,0,0.9)";
          ctx.shadowBlur = 4;
          lines.forEach((ln, i) => {
            const ly = by + py + fontSize * 0.88 + i * lineHeight;
            ctx.fillText(ln, W / 2, ly);
          });
          ctx.shadowBlur = 0;
        }
        const pct = vid.duration > 0 ? Math.round((t / vid.duration) * 100) : 0;
        onProgress(`جارٍ تصدير الفيديو ${opts.dubbed ? "مع الدبلجة" : "مع الترجمة"}… ${pct}%`);
        if (!vid.paused && !vid.ended) raf = requestAnimationFrame(drawFrame);
      }

      vid.currentTime = 0;
      rec.start(200);
      vid.play().then(() => {
        // Schedule the dubbed Arabic clips against the audio clock, mirroring the
        // live behaviour: each clip starts at its segment and is cut off when the
        // next segment begins.
        if (opts.dubbed) {
          const t0 = audioCtx.currentTime;
          for (let i = 0; i < segs.length; i++) {
            const buf = dubBuffers[i];
            if (!buf) continue;
            const seg = segs[i];
            const segDur = seg.end - seg.start;
            const rate = segDur > 0 && buf.duration > 0
              ? Math.min(DUB_RATE_MAX, Math.max(DUB_RATE_MIN, buf.duration / segDur))
              : 1;
            const src = audioCtx.createBufferSource();
            src.buffer = buf;
            src.playbackRate.value = rate;
            src.connect(audioDest);
            src.start(t0 + seg.start);
            const next = segs[i + 1];
            if (next && next.start > seg.start) src.stop(t0 + next.start);
          }
        }
        raf = requestAnimationFrame(drawFrame);
      }).catch((e) => { cancelAnimationFrame(raf); void audioCtx.close().catch(() => undefined); reject(e); });
      vid.onended = () => { cancelAnimationFrame(raf); rec.stop(); };
      vid.onerror = () => { cancelAnimationFrame(raf); void audioCtx.close().catch(() => undefined); reject(new Error("خطأ في قراءة الفيديو")); };
    };
    vid.onerror = () => { void audioCtx.close().catch(() => undefined); reject(new Error("تعذّر تحميل الفيديو")); };
  });
}

type Status = "idle" | "uploading" | "done" | "error";
type DlStatus = "idle" | "recording" | "done" | "error";

export function WhisperUpload() {
  const { settings } = useSettings();
  const fontMap = { tajawal: "'Tajawal', sans-serif", cairo: "'Cairo', sans-serif" };

  const [file, setFile]           = useState<File | null>(null);
  const [videoUrl, setVideoUrl]   = useState<string | null>(null);
  const [isVideo, setIsVideo]     = useState(false);
  const [dragging, setDragging]   = useState(false);
  const [status, setStatus]       = useState<Status>("idle");
  const [progress, setProgress]   = useState("");
  const [error, setError]         = useState<string | null>(null);
  const [result, setResult]       = useState<WhisperResult | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [dlStatus, setDlStatus]     = useState<DlStatus>("idle");
  const [dlProgress, setDlProgress] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  const xhrRef     = useRef<XMLHttpRequest | null>(null);
  const videoRef   = useRef<HTMLVideoElement>(null);
  const trackRef   = useRef<HTMLTrackElement | null>(null);
  const vttUrlRef  = useRef<string | null>(null);
  const prevUrlRef = useRef<string | null>(null);

  // ── NEW: optional Arabic voice dubbing (opt-in, default off) ──
  const dub = useDubbing();
  const autoDubRef = useRef(false);

  useEffect(() => () => {
    if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current);
    if (vttUrlRef.current)  URL.revokeObjectURL(vttUrlRef.current);
  }, []);

  /* Attach / refresh VTT track whenever result changes */
  useEffect(() => {
    if (!videoRef.current || !result) return;
    const vid = videoRef.current;
    if (vttUrlRef.current) URL.revokeObjectURL(vttUrlRef.current);
    if (trackRef.current && vid.contains(trackRef.current)) vid.removeChild(trackRef.current);

    const vtt = buildVtt(result.segments);
    const blob = new Blob([vtt], { type: "text/vtt" });
    const url  = URL.createObjectURL(blob);
    vttUrlRef.current = url;

    const track = document.createElement("track");
    track.kind    = "subtitles";
    track.src     = url;
    track.srclang = "ar";
    track.label   = "عربي";
    track.default = false;
    vid.appendChild(track);
    trackRef.current = track;

    // Keep hidden — fullscreen handler will enable it when needed
    const setHidden = () => {
      if (vid.textTracks[0]) vid.textTracks[0].mode = "hidden";
    };
    setHidden();
    vid.addEventListener("loadedmetadata", setHidden, { once: true });
  }, [result]);

  /* Toggle native track on fullscreen, hide custom overlay */
  useEffect(() => {
    const onChange = () => {
      const fs = !!(
        document.fullscreenElement ||
        (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement
      );
      setIsFullscreen(fs);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  /* Drive native track visibility: show only in fullscreen, and never while
     dubbing with the "hide subtitles" preference enabled. */
  useEffect(() => {
    const tt = videoRef.current?.textTracks[0];
    if (!tt) return;
    const hidden = settings.hideSubsWhileDubbing && dub.active;
    tt.mode = isFullscreen && !hidden ? "showing" : "hidden";
  }, [isFullscreen, settings.hideSubsWhileDubbing, dub.active, result]);

  function pickFile(f: File) {
    if (f.size > MAX_UPLOAD_BYTES) {
      setFile(null); setVideoUrl(null); setIsVideo(false); setResult(null);
      setStatus("error");
      setError(`الملف كبير جداً (${fmtSize(f.size)}). الحدّ الأقصى المسموح هو ${MAX_UPLOAD_LABEL}.`);
      return;
    }
    if (prevUrlRef.current) { URL.revokeObjectURL(prevUrlRef.current); prevUrlRef.current = null; }
    const url = URL.createObjectURL(f);
    prevUrlRef.current = url;
    const vid = VIDEO_EXTS.test(f.name);
    dub.deactivate();
    autoDubRef.current = false;
    setFile(f); setVideoUrl(vid ? url : null); setIsVideo(vid);
    setResult(null); setError(null); setStatus("idle"); setActiveIdx(-1);
    setDlStatus("idle");
  }

  const onTimeUpdate = useCallback(() => {
    if (!videoRef.current || !result) return;
    const t = videoRef.current.currentTime;
    dub.syncTo(t);
    setActiveIdx(result.segments.findIndex(s => t >= s.start && t < s.end));
  }, [result, dub]);

  function buildDubSegments(): DubSegment[] {
    if (!result) return [];
    return result.segments.map(s => ({
      start: s.start, end: s.end, text: s.arabic,
    }));
  }

  async function toggleDubbing() {
    if (dub.active) {
      dub.deactivate();
      if (videoRef.current) videoRef.current.muted = false;
      return;
    }
    if (!result) return;
    if (videoRef.current) videoRef.current.muted = true;
    await dub.activate(buildDubSegments(), settings.dubbingVoice);
  }

  function downloadDub() {
    if (!result || dub.downloading) return;
    const base = (file?.name ?? "audio").replace(/\.[^.]+$/, "");
    void dub.downloadAudio(buildDubSegments(), settings.dubbingVoice, `${base}_ar_dub.mp3`);
  }

  // Unmute and stop dubbing if generation failed
  useEffect(() => {
    if (dub.status === "error" && videoRef.current) videoRef.current.muted = false;
  }, [dub.status]);

  // Auto-activate dubbing when the user has turned it on by default in settings.
  // Default is off, so this is a no-op for the existing experience.
  useEffect(() => {
    if (!settings.dubbingEnabled || !result) return;
    if (autoDubRef.current || dub.status !== "idle") return;
    autoDubRef.current = true;
    const segs: DubSegment[] = result.segments.map(s => ({
      start: s.start, end: s.end, text: s.arabic,
    }));
    if (videoRef.current) videoRef.current.muted = true;
    void dub.activate(segs, settings.dubbingVoice);
  }, [settings.dubbingEnabled, settings.dubbingVoice, result, dub]);

  async function handleUpload() {
    if (!file || status === "uploading") return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`الملف كبير جداً (${fmtSize(file.size)}). الحدّ الأقصى المسموح هو ${MAX_UPLOAD_LABEL}.`);
      setStatus("error");
      return;
    }
    xhrRef.current?.abort();
    setStatus("uploading"); setError(null); setResult(null);
    setProgress("جارٍ رفع الملف…");
    try {
      // Raw file (video or audio) is uploaded as-is; the server extracts audio
      // with FFmpeg and runs Whisper → translation. No in-browser decoding.
      const data = await uploadAndProcess(
        file,
        settings.translationEngine ?? "mymemory",
        (m) => setProgress(m),
        (xhr) => { xhrRef.current = xhr; },
      );
      setResult(data); setStatus("done"); setProgress("اكتملت المعالجة");
      addHistoryItem({
        type: "whisper",
        title: file?.name ?? "تسجيل صوتي",
        fileName: file?.name,
        segments: data.segments.map(s => ({
          start: s.start, end: s.end,
          english: s.text, arabic: s.arabic,
        })),
      });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع");
      setStatus("error"); setProgress("");
    }
  }

  async function handleDownload() {
    if (!videoUrl || !result || dlStatus === "recording") return;
    const fname = file?.name ?? "video.mp4";
    const dubbed = dub.active && dub.status === "ready";
    const showSubtitles = !(settings.hideSubsWhileDubbing && dubbed);
    setDlStatus("recording");
    try {
      await burnAndDownload(
        videoUrl, result.segments, fname,
        { dubbed, voiceId: settings.dubbingVoice, showSubtitles },
        msg => setDlProgress(msg),
      );
      setDlStatus("done"); setDlProgress("");
    } catch (e) {
      setDlStatus("error");
      setDlProgress(e instanceof Error ? e.message : "خطأ أثناء التصدير");
    }
  }

  const activeSub = activeIdx >= 0 && result ? result.segments[activeIdx] : null;
  const isLoading = status === "uploading";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Drop zone */}
      <div className="glass gradient-border" style={{ borderRadius: 24, padding: "clamp(20px,4vw,32px)" }}>
        <label
          htmlFor="whisper-file-input"
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); e.stopPropagation(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) pickFile(f); }}
          style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
            borderRadius: 16,
            border: `2px dashed ${dragging ? "#00D4FF" : file ? "rgba(0,212,255,0.4)" : "rgba(255,255,255,0.12)"}`,
            padding: "clamp(28px,5vw,44px) 24px", cursor: "pointer", textAlign: "center",
            transition: "border-color 0.2s, background 0.2s",
            background: dragging ? "rgba(0,212,255,0.06)" : file ? "rgba(0,212,255,0.04)" : "transparent",
          }}
        >
          <input id="whisper-file-input" type="file" accept={ACCEPTED}
            onChange={e => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = ""; }}
            style={{ display: "none" }} />
          <div style={{
            width: 60, height: 60, borderRadius: 16,
            background: file ? "rgba(0,212,255,0.15)" : "rgba(124,58,237,0.12)",
            border: `1px solid ${file ? "rgba(0,212,255,0.3)" : "rgba(124,58,237,0.25)"}`,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {file ? <FileAudio style={{ width: 28, height: 28, color: "#00D4FF" }} />
                  : <Upload    style={{ width: 28, height: 28, color: "#A78BFA" }} />}
          </div>
          {file ? (
            <>
              <p style={{ fontWeight: 700, color: "#00D4FF", fontSize: "0.95rem" }}>{file.name}</p>
              <p style={{ color: "#94A3B8", fontSize: "0.82rem" }}>
                {(file.size / 1024 / 1024).toFixed(1)} MB — انقر لتغيير الملف
              </p>
            </>
          ) : (
            <>
              <p style={{ fontWeight: 700, color: "#CBD5E1", fontSize: "0.95rem" }}>اسحب ملفاً هنا أو انقر للاختيار</p>
              <p style={{ color: "#64748B", fontSize: "0.82rem" }}>MP4 · MOV · MKV · WebM · MP3 · WAV · M4A — بحد أقصى {MAX_UPLOAD_LABEL}</p>
            </>
          )}
        </label>

        <button type="button" onClick={handleUpload} disabled={!file || isLoading}
          className="btn-gradient"
          style={{
            marginTop: 16, width: "100%", height: 56, borderRadius: 14,
            fontSize: "1.05rem", fontFamily: "'Cairo', sans-serif",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            opacity: !file || isLoading ? 0.6 : 1,
          }}>
          {isLoading
            ? <><Loader2 style={{ width: 20, height: 20, animation: "spin 1s linear infinite" }} />{progress}</>
            : <><FileAudio style={{ width: 18, height: 18 }} />استخرج النص وترجم</>}
        </button>

        {!result && !isLoading && (
          <p style={{ marginTop: 12, color: "#64748B", fontSize: "0.8rem", textAlign: "center" }}>
            يُرفع الملف ثم يُستخرج منه الصوت ويُعالَج على الخادم · الحدّ الأقصى {MAX_UPLOAD_LABEL}
          </p>
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="loading-shimmer" style={{
          borderRadius: 20, padding: "36px 24px",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 14,
          textAlign: "center", border: "1px solid rgba(255,255,255,0.06)",
        }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14,
            background: "rgba(0,212,255,0.1)", border: "1px solid rgba(0,212,255,0.25)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Loader2 style={{ width: 26, height: 26, color: "#00D4FF", animation: "spin 1s linear infinite" }} />
          </div>
          <div>
            <p style={{ fontWeight: 700, fontSize: "1rem", color: "#fff", marginBottom: 4 }}>{progress}</p>
            <p style={{ color: "#94A3B8", fontSize: "0.85rem" }}>قد يستغرق ذلك دقيقة أو أكثر حسب حجم الملف</p>
          </div>
        </div>
      )}

      {/* Error */}
      {status === "error" && error && (
        <div style={{
          borderRadius: 20, padding: "24px",
          background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
          display: "flex", gap: 14, alignItems: "flex-start",
        }}>
          <div style={{
            flexShrink: 0, width: 40, height: 40, borderRadius: 10,
            background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <AlertCircle style={{ width: 20, height: 20, color: "#F87171" }} />
          </div>
          <div>
            <p style={{ fontWeight: 700, color: "#FCA5A5", fontSize: "0.9rem", marginBottom: 4 }}>حدث خطأ أثناء المعالجة</p>
            <p style={{ color: "#94A3B8", fontSize: "0.83rem", lineHeight: 1.6, direction: "ltr" }}>{error}</p>
          </div>
        </div>
      )}

      {/* Results */}
      {result && isVideo && videoUrl && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Status bar */}
          <div style={{
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            padding: "14px 20px", borderRadius: 16,
            background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.18)",
          }}>
            <CheckCircle2 style={{ width: 18, height: 18, color: "#00D4FF", flexShrink: 0 }} />
            <span style={{ color: "#00D4FF", fontWeight: 700, fontSize: "0.9rem" }}>تمت الترجمة</span>
            <span style={{ color: "#64748B", fontSize: "0.82rem" }}>
              {LABELS[result.language] ?? result.language} ({Math.round(result.language_probability * 100)}%) · {result.segments.length} مقطع
            </span>
          </div>

          {/* Dubbing control */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={toggleDubbing}
              disabled={dub.status === "preparing"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "9px 18px", borderRadius: 12,
                border: `1px solid ${dub.active ? "rgba(255,61,0,0.5)" : "rgba(0,212,255,0.3)"}`,
                background: dub.active ? "rgba(255,61,0,0.15)" : "rgba(0,212,255,0.08)",
                color: dub.active ? "#FF6B35" : "#00D4FF",
                fontFamily: "'Cairo', sans-serif", fontSize: "0.88rem", fontWeight: 600,
                cursor: dub.status === "preparing" ? "wait" : "pointer",
              }}
            >
              {dub.status === "preparing"
                ? <><Loader2 style={{ width: 16, height: 16, animation: "spin 1s linear infinite" }} />جارٍ تجهيز الدبلجة… {dub.progress}%</>
                : dub.active
                  ? <><Mic style={{ width: 16, height: 16 }} />إيقاف الدبلجة</>
                  : <><Mic style={{ width: 16, height: 16 }} />دبلجة صوتية بالعربية</>}
            </button>
            {dub.status === "ready" && (
              <button
                type="button"
                onClick={downloadDub}
                disabled={dub.downloading}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  padding: "9px 18px", borderRadius: 12,
                  border: "1px solid rgba(0,212,255,0.3)",
                  background: "rgba(0,212,255,0.08)",
                  color: "#00D4FF",
                  fontFamily: "'Cairo', sans-serif", fontSize: "0.88rem", fontWeight: 600,
                  cursor: dub.downloading ? "wait" : "pointer",
                }}
              >
                {dub.downloading
                  ? <><Loader2 style={{ width: 16, height: 16, animation: "spin 1s linear infinite" }} />جارٍ تجهيز الملف…</>
                  : <><Download style={{ width: 16, height: 16 }} />تنزيل الصوت المدبلج</>}
              </button>
            )}
            {dub.active && dub.status === "ready" && (
              <span style={{ color: "#64748B", fontSize: "0.78rem" }}>
                تم كتم الصوت الأصلي — يُشغَّل الصوت العربي مع الفيديو
              </span>
            )}
            {dub.status === "error" && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#F87171", fontSize: "0.8rem" }}>
                <AlertCircle style={{ width: 14, height: 14 }} />{dub.error}
              </span>
            )}
            {dub.downloadError && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#F87171", fontSize: "0.8rem" }}>
                <AlertCircle style={{ width: 14, height: 14 }} />{dub.downloadError}
              </span>
            )}
          </div>

          {/* Video + subtitle overlay */}
          <div style={{
            position: "relative", borderRadius: 20, overflow: "hidden",
            border: "1px solid rgba(255,255,255,0.08)", background: "#000",
          }}>
            <video
              ref={videoRef} src={videoUrl} controls onTimeUpdate={onTimeUpdate}
              onPause={() => dub.pauseAudio()}
              onSeeked={() => { if (videoRef.current) dub.syncTo(videoRef.current.currentTime); }}
              style={{ width: "100%", display: "block", maxHeight: "56vw", objectFit: "contain" }}
            />
            {/* Custom overlay (hidden in fullscreen — native <track> handles fullscreen) */}
            <div style={{
              position: "absolute",
              bottom: settings.position === "bottom" ? 54 : undefined,
              top: settings.position === "top" ? 8 : undefined,
              left: "50%",
              transform: "translateX(-50%)", width: "92%",
              textAlign: "center", pointerEvents: "none",
              transition: "opacity 0.12s",
              opacity: activeSub && !isFullscreen && !(settings.hideSubsWhileDubbing && dub.active) ? 1 : 0,
            }}>
              <span style={{
                display: "inline-block",
                maxWidth: "100%",
                whiteSpace: "normal",
                wordBreak: "break-word",
                overflowWrap: "break-word",
                background: `rgba(0,0,0,${settings.bgOpacity})`,
                backdropFilter: "blur(4px)",
                color: settings.color,
                fontSize: settings.fontSize,
                fontWeight: settings.bold ? 700 : 400,
                fontFamily: fontMap[settings.fontFamily],
                padding: "6px 18px", borderRadius: 8,
                lineHeight: 1.6, direction: "rtl",
                textShadow: settings.shadow ? "0 1px 6px rgba(0,0,0,0.95)" : "none",
              }}>
                {activeSub?.arabic ?? ""}
              </span>
            </div>
          </div>

          {/* Download button */}
          <button
            type="button"
            onClick={handleDownload}
            disabled={dlStatus === "recording"}
            style={{
              width: "100%", height: 52, borderRadius: 14,
              border: "1px solid rgba(0,212,255,0.3)",
              background: dlStatus === "recording"
                ? "rgba(0,212,255,0.05)"
                : "rgba(0,212,255,0.1)",
              color: dlStatus === "recording" ? "#64748B" : "#00D4FF",
              fontFamily: "'Cairo', sans-serif", fontSize: "0.98rem", fontWeight: 600,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              cursor: dlStatus === "recording" ? "not-allowed" : "pointer",
              transition: "background 0.2s, color 0.2s",
            }}
          >
            {dlStatus === "recording" ? (
              <><Loader2 style={{ width: 18, height: 18, animation: "spin 1s linear infinite" }} />{dlProgress}</>
            ) : dlStatus === "error" ? (
              <><AlertCircle style={{ width: 18, height: 18 }} />{dlProgress || "فشل التصدير — حاول مرة أخرى"}</>
            ) : (
              <><Download style={{ width: 18, height: 18 }} />
                {dub.active && dub.status === "ready"
                  ? (settings.hideSubsWhileDubbing
                      ? "تحميل الفيديو بالدبلجة العربية"
                      : "تحميل الفيديو بالدبلجة والترجمة")
                  : "تحميل الفيديو مع الترجمة المدمجة"}
              </>
            )}
          </button>

          {dlStatus === "recording" && (
            <p style={{ textAlign: "center", color: "#475569", fontSize: "0.78rem" }}>
              {dub.active && dub.status === "ready"
                ? "يُعاد تشغيل الفيديو في الخلفية لدمج الصوت المدبلج — يستغرق نفس مدة المقطع"
                : "يُعاد تشغيل الفيديو في الخلفية لدمج الترجمة — يستغرق نفس مدة المقطع"}
            </p>
          )}
        </div>
      )}

      {/* Audio-only result (no video player) */}
      {result && !isVideo && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            padding: "14px 20px", borderRadius: 16,
            background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.18)",
          }}>
            <CheckCircle2 style={{ width: 18, height: 18, color: "#00D4FF", flexShrink: 0 }} />
            <span style={{ color: "#00D4FF", fontWeight: 700, fontSize: "0.9rem" }}>تمت الترجمة</span>
            <span style={{ color: "#64748B", fontSize: "0.82rem" }}>
              {LABELS[result.language] ?? result.language} ({Math.round(result.language_probability * 100)}%) · {result.segments.length} مقطع
            </span>
          </div>
          <div className="glass" style={{
            borderRadius: 20, overflow: "hidden",
            border: "1px solid rgba(255,255,255,0.06)",
            maxHeight: "55vh", overflowY: "auto",
          }}>
            {result.segments.map((seg, i) => (
              <div key={i} style={{
                padding: "14px 20px",
                borderBottom: i < result.segments.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
                display: "flex", flexDirection: "column", gap: 6,
              }}>
                <p style={{ color: "#94A3B8", fontSize: "0.88rem", lineHeight: 1.5, direction: "ltr", margin: 0 }}>
                  {seg.text}
                </p>
                <p style={{
                  color: "#E2E8F0", fontSize: "0.92rem", fontWeight: 500,
                  lineHeight: 1.6, direction: "rtl", margin: 0,
                  fontFamily: "'Tajawal','Cairo',sans-serif",
                }}>
                  {seg.arabic}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        video::cue {
          background-color: rgba(0,0,0,0.76);
          color: white;
          font-size: 1.1em;
          font-family: 'Tajawal', 'Cairo', sans-serif;
          font-weight: bold;
        }
      `}</style>
    </div>
  );
}
