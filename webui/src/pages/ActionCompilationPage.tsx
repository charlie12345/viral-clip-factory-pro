import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CheckCircle2, Clapperboard, Film, Gauge,
  GripVertical, Layers3, Loader2, Play, Scissors, Sparkles, Trash2, Upload,
  WandSparkles, Zap,
} from 'lucide-react';
import { clsx } from 'clsx';
import {
  api,
  type ActionCompilationOptions,
  type ActionCompilationQueued,
  type CompilationFormat,
  type CompilationGoal,
  type CompilationPacing,
  type CompilationTransitionMode,
} from '@/api/client';
import {
  CompilationUploadPausedError,
  discardActionCompilationUpload,
  restoreActionCompilationUpload,
  uploadActionCompilation,
  type CompilationUploadProgress,
} from '@/api/compilation-upload';
import { formatSize } from '@/api/upload';
import { useActiveJob, useJobs } from '@/hooks/queries';
import { toast } from '@/store/toasts';

interface QueuedClip {
  id: string;
  file: File;
  previewUrl: string;
}

const GOALS: { id: CompilationGoal; label: string; detail: string; icon: typeof Zap }[] = [
  { id: 'fast_action', label: 'Fast action', detail: 'Motion peaks, impacts, quick reveals', icon: Zap },
  { id: 'cosplay_showcase', label: 'Cosplay showcase', detail: 'Sharp details, color, clear visual moments', icon: Sparkles },
  { id: 'cinematic', label: 'Cinematic', detail: 'Longer moments and smoother visual flow', icon: Film },
];

const PACING: { id: CompilationPacing; label: string; verticalDetail: string; horizontalDetail: string }[] = [
  { id: 'rapid', label: 'Rapid', verticalDetail: '0.9–1.7s shots', horizontalDetail: 'Quick highlight beats' },
  { id: 'fast', label: 'Fast', verticalDetail: '1.4–2.6s shots', horizontalDetail: 'Tight, energetic sequences' },
  { id: 'balanced', label: 'Balanced', verticalDetail: '2.2–3.8s shots', horizontalDetail: 'Longer moments with natural flow' },
  { id: 'cinematic', label: 'Cinematic', verticalDetail: '3.4–5.8s shots', horizontalDetail: 'Patient scenes and smoother visual flow' },
];

const TRANSITIONS: { id: CompilationTransitionMode; label: string; detail: string }[] = [
  { id: 'auto', label: 'Creator mix', detail: 'Clean cuts with a varied swipe or pull every 3–4 clips' },
  { id: 'minimal', label: 'Smooth fades', detail: 'Short clean dissolves between every moment' },
  { id: 'none', label: 'Hard cuts', detail: 'No decorative transitions' },
];

const DEFAULT_OPTIONS: ActionCompilationOptions = {
  name: 'Action compilation',
  format: 'vertical_short',
  goal: 'fast_action',
  targetDurationSec: 30,
  pacing: 'fast',
  transitionMode: 'auto',
  selectionMode: 'best_moments',
  orderMode: 'ai',
};

const GIB = 1024 * 1024 * 1024;
const FALLBACK_MAX_CLIPS = 20;
const FALLBACK_MAX_FILE_BYTES = 20 * GIB;
const FALLBACK_MAX_TOTAL_BYTES = 100 * GIB;
const FALLBACK_CHUNK_BYTES = 32 * 1024 * 1024;
const SUPPORTED_VIDEO = /\.(mp4|mov|mkv|webm|m4v|avi|mts|m2ts)$/i;

const FORMAT_OPTIONS: Array<{
  id: CompilationFormat;
  label: string;
  detail: string;
  aspect: string;
  minimumSources: number;
  defaultDurationSec: number;
  durations: number[];
}> = [
  {
    id: 'vertical_short',
    label: 'Short Montage',
    detail: 'Fast vertical edit for Shorts, Reels, and TikTok',
    aspect: 'Vertical 9:16',
    minimumSources: 2,
    defaultDurationSec: 30,
    durations: [15, 30, 45, 60, 90],
  },
  {
    id: 'horizontal_longform',
    label: 'Long-Form Montage',
    detail: 'Longer horizontal edit for YouTube and full-screen playback',
    aspect: 'Horizontal 16:9',
    minimumSources: 1,
    defaultDurationSec: 300,
    durations: [180, 300, 600, 900],
  },
];

function durationLabel(seconds: number) {
  return seconds >= 180 ? `${seconds / 60}m` : `${seconds}s`;
}

export function ActionCompilationPage() {
  const { data: activeJob } = useActiveJob();
  const { data: jobs = [] } = useJobs();
  const queryClient = useQueryClient();
  const capabilitiesQuery = useQuery({
    queryKey: ['action-compilation-upload-capabilities'],
    queryFn: api.actionCompilationUploadCapabilities,
    staleTime: 30_000,
    retry: 1,
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const previewUrls = useRef(new Set<string>());
  const uploadAbort = useRef<AbortController | null>(null);
  const uploadFinalizing = useRef(false);
  const [clips, setClips] = useState<QueuedClip[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [options, setOptions] = useState<ActionCompilationOptions>(DEFAULT_OPTIONS);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<CompilationUploadProgress | null>(null);
  const [uploadSessionId, setUploadSessionId] = useState<string | null>(null);
  const [uploadPaused, setUploadPaused] = useState(false);
  const [discardingUpload, setDiscardingUpload] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<ActionCompilationQueued | null>(null);

  const applySelectedFileOrder = useCallback((orderedFiles: File[]) => {
    setClips((current) => {
      if (current.length !== orderedFiles.length) return current;
      const available = new Map<File, QueuedClip[]>();
      current.forEach((clip) => {
        const bucket = available.get(clip.file) || [];
        bucket.push(clip);
        available.set(clip.file, bucket);
      });
      const ordered: QueuedClip[] = [];
      for (const file of orderedFiles) {
        const clip = available.get(file)?.shift();
        if (!clip) return current;
        ordered.push(clip);
      }
      return ordered.every((clip, index) => clip === current[index]) ? current : ordered;
    });
  }, []);

  useEffect(() => () => {
    if (!uploadFinalizing.current) uploadAbort.current?.abort();
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current.clear();
  }, []);

  useEffect(() => {
    if (clips.length === 0 || uploading || queued || uploadSessionId) return undefined;
    let cancelled = false;
    void restoreActionCompilationUpload(clips.map((clip) => clip.file))
      .then((restored) => {
        if (cancelled || !restored) return;
        applySelectedFileOrder(restored.orderedFiles);
        if (restored.kind === 'queued') {
          setOptions(restored.options);
          setQueued(restored.result);
          void queryClient.invalidateQueries({ queryKey: ['job-status'] });
          void queryClient.invalidateQueries({ queryKey: ['jobs'] });
          return;
        }
        setOptions(restored.options);
        setUploadSessionId(restored.sessionId);
        setUploadProgress(restored.progress);
        setUploadPaused(true);
      })
      .catch(() => {
        // This is only a background resume probe. The explicit upload action
        // reports any persistent local-file read error to the user.
      });
    return () => { cancelled = true; };
  }, [applySelectedFileOrder, clips, queryClient, queued, uploadSessionId, uploading]);

  const totalBytes = useMemo(() => clips.reduce((sum, clip) => sum + clip.file.size, 0), [clips]);
  const capabilities = capabilitiesQuery.data;
  const maxClips = capabilities?.maxFiles || FALLBACK_MAX_CLIPS;
  const maxFileBytes = capabilities?.maxFileBytes || FALLBACK_MAX_FILE_BYTES;
  const maxTotalBytes = capabilities?.maxTotalBytes || FALLBACK_MAX_TOTAL_BYTES;
  const usableStorageBytes = capabilities?.storage.usableBytes ?? maxTotalBytes;
  const chunkBytes = capabilities?.chunkSize || FALLBACK_CHUNK_BYTES;
  const uploadSessionHours = Math.max(1, Math.round((capabilities?.sessionTtlMs || 72 * 60 * 60 * 1000) / (60 * 60 * 1000)));
  const uploadPercent = uploadProgress?.totalBytes
    ? Math.min(100, Math.round(uploadProgress.uploadedBytes * 100 / uploadProgress.totalBytes))
    : 0;
  const uploadRemainingSeconds = uploadProgress?.bytesPerSecond
    ? Math.max(0, (uploadProgress.totalBytes - uploadProgress.uploadedBytes) / uploadProgress.bytesPerSecond)
    : 0;
  const limitsExceeded = clips.length > maxClips
    || clips.some((clip) => clip.file.size <= 0 || clip.file.size > maxFileBytes)
    || totalBytes > maxTotalBytes;
  const limitsBlocked = limitsExceeded && !uploadSessionId;
  // The server performs the authoritative byte reservation. Do not reject a
  // resumed upload merely because its already-staged chunks have reduced the
  // currently free byte count. Saved sessions can also resume even when the
  // capacity probe itself is temporarily unavailable.
  const storageBlocked = Boolean(capabilities && !capabilities.storage.ready && !uploadSessionId);
  const storageCapacityWarning = Boolean(
    capabilities
    && capabilities.storage.ready
    && clips.length > 0
    && totalBytes > usableStorageBytes,
  );
  const locked = uploading || queued !== null || uploadSessionId !== null;
  const format = FORMAT_OPTIONS.find((item) => item.id === options.format) || FORMAT_OPTIONS[0];
  const horizontal = options.format === 'horizontal_longform';
  const minimumSources = format.minimumSources;
  const sourceNoun = horizontal ? 'video' : 'clip';
  const sourceNounPlural = horizontal ? 'videos' : 'clips';
  const queuedJob = queued ? jobs.find((job) => job.id === queued.jobId) : undefined;
  const queuedPhase = !queued
    ? null
    : queuedJob?.status === 'running'
      ? 'running'
      : queuedJob?.status === 'complete'
        ? 'complete'
        : queuedJob && ['failed', 'cancelled', 'interrupted'].includes(queuedJob.status)
          ? 'failed'
        : 'queued';

  function update<K extends keyof ActionCompilationOptions>(key: K, value: ActionCompilationOptions[K]) {
    if (locked) return;
    setOptions((current) => ({ ...current, [key]: value }));
  }

  function selectFormat(nextFormat: CompilationFormat) {
    if (locked || nextFormat === options.format) return;
    const next = FORMAT_OPTIONS.find((item) => item.id === nextFormat) || FORMAT_OPTIONS[0];
    setOptions((current) => ({
      ...current,
      name: ['Action compilation', 'Long-form montage'].includes(current.name)
        ? (nextFormat === 'horizontal_longform' ? 'Long-form montage' : 'Action compilation')
        : current.name,
      format: nextFormat,
      targetDurationSec: next.defaultDurationSec,
      pacing: nextFormat === 'horizontal_longform' ? 'balanced' : 'fast',
    }));
    setError(null);
  }

  function addFiles(files: FileList | File[]) {
    if (locked) return;
    const incoming = Array.from(files);
    const additions: QueuedClip[] = [];
    const rejected: string[] = [];
    let nextTotalBytes = totalBytes;
    for (const file of incoming) {
      if (clips.length + additions.length >= maxClips) {
        rejected.push(`${file.name}: ${maxClips}-${sourceNoun} limit reached`);
        continue;
      }
      if (!SUPPORTED_VIDEO.test(file.name)) {
        rejected.push(`${file.name}: unsupported video type`);
        continue;
      }
      if (file.size <= 0 || file.size > maxFileBytes) {
        rejected.push(`${file.name}: ${sourceNounPlural} must be no larger than ${formatSize(maxFileBytes)}`);
        continue;
      }
      if (nextTotalBytes + file.size > maxTotalBytes) {
        rejected.push(`${file.name}: upload would exceed the ${formatSize(maxTotalBytes)} job limit`);
        continue;
      }
      const previewUrl = URL.createObjectURL(file);
      previewUrls.current.add(previewUrl);
      additions.push({ id: crypto.randomUUID(), file, previewUrl });
      nextTotalBytes += file.size;
    }
    setClips((current) => [...current, ...additions]);
    setError(rejected.length > 0
      ? `${rejected.length} ${rejected.length === 1 ? 'file was' : 'files were'} not added. ${rejected.slice(0, 3).join(' ')}`
      : null);
  }

  function removeClip(id: string) {
    if (locked) return;
    setClips((current) => {
      const found = current.find((clip) => clip.id === id);
      if (found) {
        URL.revokeObjectURL(found.previewUrl);
        previewUrls.current.delete(found.previewUrl);
      }
      return current.filter((clip) => clip.id !== id);
    });
  }

  function moveClip(index: number, direction: -1 | 1) {
    if (locked) return;
    setClips((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = current.slice();
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  /** Lift a source out of position `from` and drop it at `to`, keeping the rest in order. */
  function reorderClip(from: number, to: number) {
    if (locked || from === to) return;
    setClips((current) => {
      if (from < 0 || from >= current.length || to < 0 || to >= current.length) return current;
      const next = current.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  function handleDrop(index: number) {
    if (dragIndex !== null) reorderClip(dragIndex, index);
    setDragIndex(null);
    setDragOverIndex(null);
  }

  async function createCompilation(rebuildCompleted = false) {
    if (
      clips.length < minimumSources
      || uploading
      || activeJob?.active
      || (queued !== null && !rebuildCompleted)
    ) return;
    if (!capabilities && !uploadSessionId) {
      setError(capabilitiesQuery.isError
        ? 'The resumable upload service is unavailable. Refresh the page after the server is updated.'
        : 'Still checking upload capacity. Try again in a moment.');
      return;
    }
    if (limitsBlocked) {
      setError(`Choose no more than ${maxClips} videos, ${formatSize(maxFileBytes)} each and ${formatSize(maxTotalBytes)} total.`);
      return;
    }
    if (storageBlocked) {
      setError('The staging volume is not ready. Check the storage message before uploading.');
      return;
    }
    const controller = new AbortController();
    const submittedOptions = { ...options };
    uploadAbort.current = controller;
    setError(null);
    setQueued(null);
    if (!uploadSessionId) setUploadProgress(null);
    setUploadPaused(false);
    setUploading(true);
    try {
      const completed = await uploadActionCompilation({
        files: clips.map((clip) => clip.file),
        options: submittedOptions,
        signal: controller.signal,
        onProgress: (progress) => {
          uploadFinalizing.current = progress.phase === 'finalizing';
          setUploadProgress(progress);
        },
        onSession: (session) => {
          setUploadSessionId(session.sessionId);
          setOptions(session.options);
        },
        onFilesOrdered: applySelectedFileOrder,
      });
      setUploadSessionId(null);
      setOptions(completed.options);
      setQueued(completed.queued);
      toast('success', 'Montage queued', `${submittedOptions.name} is rendering — track it on the Jobs page.`);
      await queryClient.invalidateQueries({ queryKey: ['job-status'] });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
    } catch (reason) {
      if (reason instanceof CompilationUploadPausedError) {
        setUploadPaused(true);
        setError(null);
      } else {
        setUploadPaused(false);
        const message = reason instanceof Error ? reason.message : 'Could not create the compilation';
        setError(message);
        toast('error', 'Montage upload failed', message);
      }
    } finally {
      uploadFinalizing.current = false;
      uploadAbort.current = null;
      setUploading(false);
    }
  }

  async function discardUploadProgress() {
    if (!uploadSessionId || uploading || discardingUpload) return;
    setDiscardingUpload(true);
    setError(null);
    try {
      await discardActionCompilationUpload(uploadSessionId);
      setUploadSessionId(null);
      setUploadPaused(false);
      setUploadProgress(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not discard the saved upload');
    } finally {
      setDiscardingUpload(false);
    }
  }

  function resetCompilation() {
    if (uploading || uploadSessionId) return;
    clips.forEach((clip) => URL.revokeObjectURL(clip.previewUrl));
    previewUrls.current.clear();
    setClips([]);
    setQueued(null);
    setError(null);
    setUploadPaused(false);
    setUploadProgress(null);
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="relative overflow-hidden rounded-3xl border border-fuchsia-400/15 bg-[radial-gradient(circle_at_top_right,rgba(236,72,153,0.17),transparent_35%),linear-gradient(135deg,rgba(15,23,42,0.96),rgba(30,21,48,0.94))] p-6 shadow-2xl sm:p-8">
        <div className="absolute -right-14 -top-16 h-52 w-52 rounded-full border border-white/5 bg-fuchsia-400/5 blur-2xl" />
        <div className="relative max-w-4xl">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.17em] text-fuchsia-200/80">
            <span className="chip"><WandSparkles className="h-3.5 w-3.5 text-fuchsia-300" /> AI-style montage editor</span>
            <span className="chip">No transcript required</span>
            <span className="chip">{format.aspect}</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
            {horizontal ? 'Upload Long Videos → One Horizontal Montage' : 'Upload Many Clips → One AI-Style Montage'}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
            {horizontal
              ? 'Upload one or more long-form videos. The local editor finds strong visual moments across the footage and builds a paced 16:9 montage for full-screen viewing.'
              : 'Drop cosplay, convention, stunt, gaming, or action clips. The local editor finds motion peaks, foreground cosplayers, costumes, scene changes, and strong visual moments—then builds one paced montage with clean cuts and transitions.'}
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2" aria-label="Montage format">
            {FORMAT_OPTIONS.map((item) => {
              const selected = options.format === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={locked}
                  aria-pressed={selected}
                  onClick={() => selectFormat(item.id)}
                  className={clsx(
                    'rounded-2xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-55',
                    selected
                      ? 'border-fuchsia-300/50 bg-fuchsia-500/15 shadow-[0_0_34px_-20px_rgba(236,72,153,0.95)]'
                      : 'border-white/10 bg-black/20 hover:border-white/25 hover:bg-white/[0.045]',
                  )}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-sm font-black text-white">{item.label}</span>
                    <span className={clsx('rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wider', selected ? 'bg-fuchsia-400/20 text-fuchsia-100' : 'bg-white/5 text-slate-400')}>{item.aspect}</span>
                  </span>
                  <span className="mt-1.5 block text-[11px] leading-5 text-slate-400">{item.detail}</span>
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(310px,0.8fr)]">
        <section className="panel space-y-5 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="section-title">Source bin</p>
              <h2 className="mt-1 text-xl font-bold text-white">
                {horizontal ? `Add 1–${maxClips} long-form videos` : `Add 2–${maxClips} short clips`}
              </h2>
            </div>
            <div className="text-right text-xs text-slate-400">
              <div>{clips.length} {clips.length === 1 ? sourceNoun : sourceNounPlural}</div>
              <div>{formatSize(totalBytes)}</div>
            </div>
          </div>

          <button
            type="button"
            disabled={locked}
            onClick={() => { if (!locked) fileInput.current?.click(); }}
            onDragEnter={(event) => { event.preventDefault(); if (!locked) setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (!locked) addFiles(event.dataTransfer.files);
            }}
            className={clsx(
              'group grid min-h-44 w-full place-items-center rounded-2xl border border-dashed px-5 py-8 text-center transition disabled:cursor-not-allowed disabled:opacity-50',
              dragging
                ? 'border-fuchsia-300/70 bg-fuchsia-500/10 shadow-[0_0_40px_-18px_rgba(236,72,153,0.9)]'
                : 'border-white/15 bg-black/20 hover:border-fuchsia-300/40 hover:bg-white/[0.035]',
            )}
          >
            <span>
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-500/25 to-violet-500/20 ring-1 ring-white/10 transition group-hover:scale-105">
                <Upload className="h-5 w-5 text-fuchsia-200" />
              </span>
              <span className="mt-3 block text-sm font-bold text-white">
                {horizontal ? 'Drop long-form videos here' : 'Drop many short clips here'}
              </span>
              <span className="mt-1 block text-xs text-fuchsia-200">
                {horizontal ? `or select 1–${maxClips} videos at the same time` : `or select 2–${maxClips} videos at the same time`}
              </span>
              <span className="mt-1 block text-[10px] text-slate-500">
                MP4, MOV, MKV, WebM and camera formats · up to {formatSize(maxFileBytes)} each
              </span>
            </span>
          </button>
          <input
            ref={fileInput}
            className="hidden"
            type="file"
            accept=".mp4,.mov,.mkv,.webm,.m4v,.avi,.mts,.m2ts,video/mp4,video/quicktime,video/webm"
            multiple
            disabled={locked}
            onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }}
          />

          <div className={clsx(
            'rounded-xl border px-3 py-2.5 text-[10px] leading-4',
            capabilitiesQuery.isError || capabilities?.storage.ready === false
              ? 'border-rose-400/20 bg-rose-500/[0.07] text-rose-200'
              : storageCapacityWarning
                ? 'border-amber-400/20 bg-amber-500/[0.07] text-amber-100'
              : 'border-emerald-400/15 bg-emerald-500/[0.045] text-slate-400',
          )}>
            {capabilitiesQuery.isLoading
              ? 'Checking large-file upload capacity…'
              : capabilitiesQuery.isError
                ? 'The resumable upload service could not be reached. Files stay selected; refresh after the server is available.'
                : capabilities?.storage.ready === false
                  ? `Staging storage is not ready. ${formatSize(capabilities.storage.availableBytes ?? 0)} free with ${formatSize(capabilities.storage.reserveBytes)} reserved.${capabilities.storage.error ? ` ${capabilities.storage.error}` : ''}`
                  : storageCapacityWarning
                    ? `Selected footage is ${formatSize(totalBytes)}, while ${formatSize(usableStorageBytes)} is currently usable. A saved session may still resume; the server will verify capacity before accepting new chunks.`
                  : `Large videos upload sequentially in resumable ${formatSize(chunkBytes)} chunks. ${formatSize(usableStorageBytes)} is currently usable for source footage.`}
          </div>

          {clips.length > 1 && !locked && (
            <p className="text-[10px] text-slate-500">
              Drag a {sourceNoun} to reorder it, or use the arrow buttons.
            </p>
          )}

          {clips.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {clips.map((clip, index) => (
                <article
                  key={clip.id}
                  draggable={!locked}
                  onDragStart={(event) => {
                    if (locked) return;
                    setDragIndex(index);
                    event.dataTransfer.effectAllowed = 'move';
                    // Firefox only starts a drag when some data is set.
                    event.dataTransfer.setData('text/plain', String(index));
                  }}
                  onDragOver={(event) => {
                    if (locked || dragIndex === null) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    if (dragOverIndex !== index) setDragOverIndex(index);
                  }}
                  onDrop={(event) => {
                    if (locked) return;
                    event.preventDefault();
                    handleDrop(index);
                  }}
                  onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
                  className={clsx(
                    'overflow-hidden rounded-xl border bg-black/25 transition',
                    dragIndex === index && 'opacity-40',
                    dragOverIndex === index && dragIndex !== index
                      ? 'border-cyan-300/60 ring-2 ring-cyan-300/40'
                      : 'border-white/10',
                    !locked && 'cursor-grab active:cursor-grabbing',
                  )}
                >
                  <div className="relative aspect-video bg-black">
                    <video className="h-full w-full object-contain" src={clip.previewUrl} muted controls playsInline preload="metadata" />
                    <span className="absolute left-2 top-2 grid h-7 min-w-7 place-items-center rounded-full bg-black/75 px-2 text-[11px] font-black text-white ring-1 ring-white/15">
                      {index + 1}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 p-3">
                    <GripVertical
                      className={clsx('h-4 w-4 shrink-0', locked ? 'text-slate-700' : 'text-slate-500')}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-slate-200" title={clip.file.name}>{clip.file.name}</p>
                      <p className="mt-0.5 text-[10px] text-slate-500">{formatSize(clip.file.size)}</p>
                    </div>
                    <button className="btn-ghost h-8 w-8 p-0" type="button" onClick={() => moveClip(index, -1)} disabled={locked || index === 0} title="Move earlier" aria-label={`Move ${clip.file.name} earlier`}><ArrowUp className="h-3.5 w-3.5" /></button>
                    <button className="btn-ghost h-8 w-8 p-0" type="button" onClick={() => moveClip(index, 1)} disabled={locked || index === clips.length - 1} title="Move later" aria-label={`Move ${clip.file.name} later`}><ArrowDown className="h-3.5 w-3.5" /></button>
                    <button className="btn-ghost h-8 w-8 p-0 text-rose-300" type="button" onClick={() => removeClip(clip.id)} disabled={locked} title="Remove" aria-label={`Remove ${clip.file.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="rounded-xl border border-cyan-400/10 bg-cyan-400/[0.045] p-4">
            <div className="flex gap-3">
              <Layers3 className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
              <div>
                <p className="text-xs font-bold text-cyan-100">How the edit is built</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  {horizontal
                    ? 'Each long-form source is sampled for people, motion, scene changes, sharpness, exposure, and color. Strong moments are assembled on a horizontal 16:9 timeline with longer pacing, while weak black or static frames are rejected. Multiple moments from the same upload are distributed across the edit. Speech and captions are not used.'
                    : 'Every source is sampled for faces, people, motion, scene changes, sharpness, exposure, and color. The largest persistent foreground cosplayer is tracked by their full body—not a small background face—and placed on a rule-of-thirds line only when the costume still fits. Wide or moving subjects switch to a full-costume view over a soft blurred background. Weak black/static frames are rejected; selected moments are diversified across clips and arranged into an energy curve. Multiple cuts from the same upload are spread across the timeline and never placed back-to-back. Speech and captions are not used.'}
                </p>
              </div>
            </div>
          </div>
        </section>

        <aside className="panel h-fit space-y-5 p-5 sm:p-6 xl:sticky xl:top-6">
          <div>
            <p className="section-title">Edit direction</p>
            <h2 className="mt-1 text-xl font-bold text-white">Direct the montage</h2>
          </div>

          <label className="block">
            <span className="label">Montage name</span>
            <input className="input" value={options.name} maxLength={100} disabled={locked} onChange={(event) => update('name', event.target.value)} />
          </label>

          <div>
            <span className="label">Visual goal</span>
            <div className="space-y-2">
              {GOALS.map(({ id, label, detail, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  disabled={locked}
                  aria-pressed={options.goal === id}
                  onClick={() => update('goal', id)}
                  className={clsx(
                    'flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition ring-1',
                    options.goal === id ? 'bg-fuchsia-500/12 text-white ring-fuchsia-400/30' : 'bg-white/[0.025] text-slate-300 ring-white/5 hover:bg-white/5',
                  )}
                >
                  <Icon className={clsx('mt-0.5 h-4 w-4 shrink-0', options.goal === id ? 'text-fuchsia-300' : 'text-slate-500')} />
                  <span><span className="block text-xs font-bold">{label}</span><span className="mt-0.5 block text-[10px] leading-4 text-slate-500">{detail}</span></span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="label">Target length</span>
            <div className={clsx('grid gap-1.5', horizontal ? 'grid-cols-4' : 'grid-cols-5')}>
              {format.durations.map((seconds) => (
                <button key={seconds} type="button" disabled={locked} aria-pressed={options.targetDurationSec === seconds} onClick={() => update('targetDurationSec', seconds)} className={clsx('rounded-lg px-1 py-2 text-xs font-bold transition ring-1 disabled:opacity-50', options.targetDurationSec === seconds ? 'bg-violet-500/20 text-white ring-violet-400/35' : 'bg-white/5 text-slate-400 ring-white/5')}>{durationLabel(seconds)}</button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] leading-4 text-slate-500">
              {horizontal ? 'Long-form targets produce a horizontal 16:9 master.' : 'Short targets produce a vertical 9:16 montage.'}
            </p>
          </div>

          <label className="block">
            <span className="label">Cut pace</span>
            <select className="input" value={options.pacing} disabled={locked} onChange={(event) => update('pacing', event.target.value as CompilationPacing)}>
              {PACING.map((pace) => <option key={pace.id} value={pace.id}>{pace.label} · {horizontal ? pace.horizontalDetail : pace.verticalDetail}</option>)}
            </select>
          </label>

          <div>
            <span className="label">Transitions</span>
            <div className="grid grid-cols-3 gap-1.5">
              {TRANSITIONS.map((transition) => (
                <button key={transition.id} type="button" disabled={locked} aria-pressed={options.transitionMode === transition.id} title={transition.detail} onClick={() => update('transitionMode', transition.id)} className={clsx('rounded-lg px-2 py-2 text-[11px] font-bold transition ring-1 disabled:opacity-50', options.transitionMode === transition.id ? 'bg-cyan-500/15 text-cyan-100 ring-cyan-400/30' : 'bg-white/5 text-slate-400 ring-white/5')}>{transition.label}</button>
              ))}
            </div>
            {options.transitionMode === 'auto' && (
              <div className="mt-2 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.055] p-3">
                <p className="text-[10px] leading-4 text-cyan-100">
                  {horizontal
                    ? 'Most joins stay clean and unobtrusive. Creator transitions are spaced across the longer edit.'
                    : 'Most joins stay as clean action cuts. A varied creator transition is added after clips 3, 7, 10, 14, 17…'}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px] text-slate-300">
                  <span className="flex items-center gap-1.5 rounded-md bg-black/20 px-2 py-1"><ArrowLeft className="h-3 w-3 text-cyan-300" /> Swipe left</span>
                  <span className="flex items-center gap-1.5 rounded-md bg-black/20 px-2 py-1"><ArrowRight className="h-3 w-3 text-cyan-300" /> Swipe right</span>
                  <span className="flex items-center gap-1.5 rounded-md bg-black/20 px-2 py-1"><ArrowUp className="h-3 w-3 text-cyan-300" /> Pull up</span>
                  <span className="flex items-center gap-1.5 rounded-md bg-black/20 px-2 py-1"><ArrowDown className="h-3 w-3 text-cyan-300" /> Pull down</span>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={locked} aria-pressed={options.selectionMode === 'best_moments'} onClick={() => update('selectionMode', 'best_moments')} className={clsx('rounded-xl p-3 text-left ring-1 transition disabled:opacity-50', options.selectionMode === 'best_moments' ? 'bg-amber-400/10 ring-amber-300/25' : 'bg-white/[0.025] ring-white/5')}>
              <Scissors className="h-4 w-4 text-amber-300" /><span className="mt-2 block text-xs font-bold text-white">Best moments</span><span className="mt-1 block text-[10px] leading-4 text-slate-500">May skip weak clips</span>
            </button>
            <button type="button" disabled={locked} aria-pressed={options.selectionMode === 'use_every_clip'} onClick={() => update('selectionMode', 'use_every_clip')} className={clsx('rounded-xl p-3 text-left ring-1 transition disabled:opacity-50', options.selectionMode === 'use_every_clip' ? 'bg-amber-400/10 ring-amber-300/25' : 'bg-white/[0.025] ring-white/5')}>
              <Clapperboard className="h-4 w-4 text-amber-300" /><span className="mt-2 block text-xs font-bold text-white">Use every {sourceNoun}</span><span className="mt-1 block text-[10px] leading-4 text-slate-500">At least one moment each</span>
            </button>
          </div>

          <label className={clsx('flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.025] p-3', locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
            <span><span className="block text-xs font-bold text-white">Automatic sequencing</span><span className="mt-0.5 block text-[10px] text-slate-500">Build an energy curve instead of keeping upload order</span></span>
            <input type="checkbox" disabled={locked} checked={options.orderMode === 'ai'} onChange={(event) => update('orderMode', event.target.checked ? 'ai' : 'manual')} />
          </label>

          {error && <div role="alert" className="rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-xs leading-5 text-rose-200">{error}</div>}

          {uploadProgress && (uploading || uploadSessionId) && (
            <div role="progressbar" aria-label="Compilation upload" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadPercent} className="space-y-2 rounded-xl border border-violet-400/15 bg-violet-500/[0.07] p-3">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-semibold text-violet-100">
                  {uploading
                    ? uploadProgress.phase === 'finalizing'
                      ? 'Starting montage'
                      : uploadProgress.phase === 'retrying'
                        ? 'Retrying saved chunk'
                        : `Uploading ${horizontal ? 'long-form videos' : 'short clips'}`
                    : uploadPaused
                      ? uploadProgress.finalized
                        ? 'Footage finalized — ready to queue'
                        : 'Upload paused — progress saved'
                      : 'Upload interrupted — ready to resume'}
                </span>
                <span className="shrink-0 text-violet-200">{uploadPercent}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-black/35"><div className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-400 transition-[width]" style={{ width: `${uploadPercent}%` }} /></div>
              <div className="space-y-0.5 text-[10px] leading-4 text-slate-400">
                <p>{uploadProgress.message}</p>
                {uploadProgress.currentFileName && (
                  <p className="truncate" title={uploadProgress.currentFileName}>
                    File {uploadProgress.currentFileIndex + 1} of {uploadProgress.totalFiles}: {uploadProgress.currentFileName}
                    {' · '}{formatSize(uploadProgress.currentFileUploadedBytes)} of {formatSize(uploadProgress.currentFileTotalBytes)}
                  </p>
                )}
                <p>
                  Overall {formatSize(uploadProgress.uploadedBytes)} of {formatSize(uploadProgress.totalBytes)}
                  {uploadProgress.bytesPerSecond > 0 && uploadProgress.uploadedBytes < uploadProgress.totalBytes
                    ? ` · ${formatSize(uploadProgress.bytesPerSecond)}/s · about ${Math.max(1, Math.ceil(uploadRemainingSeconds / 60))}m left`
                    : ''}
                </p>
                <p>{uploadProgress.completedFiles} of {uploadProgress.totalFiles} files safely staged</p>
              </div>
              {uploading ? (
                <button
                  type="button"
                  className="btn-ghost min-h-9 w-full text-xs text-amber-200"
                  disabled={uploadProgress.phase === 'finalizing'}
                  onClick={() => uploadAbort.current?.abort()}
                >
                  {uploadProgress.phase === 'finalizing' ? 'Finalizing — please wait' : 'Pause upload'}
                </button>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" className="btn-secondary min-h-9 text-xs" disabled={Boolean(activeJob?.active) || discardingUpload} onClick={() => { void createCompilation(); }}>Resume upload</button>
                  <button
                    type="button"
                    className="btn-ghost min-h-9 text-xs text-rose-200"
                    disabled={discardingUpload || uploadProgress.finalized}
                    title={uploadProgress.finalized ? 'These sources are already finalized; resume to recover or queue the montage.' : undefined}
                    onClick={() => { void discardUploadProgress(); }}
                  >
                    {discardingUpload
                      ? 'Discarding…'
                      : uploadProgress.finalized
                        ? 'Sources finalized'
                        : 'Discard progress'}
                  </button>
                </div>
              )}
            </div>
          )}

          {queued && (
            <div role="status" className={clsx('rounded-xl border p-4', queuedPhase === 'failed' ? 'border-rose-400/20 bg-rose-500/[0.08]' : 'border-emerald-400/20 bg-emerald-500/[0.08]')}>
              <div className="flex gap-2">
                {queuedPhase === 'running' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet-300" /> : <CheckCircle2 className={clsx('h-4 w-4 shrink-0', queuedPhase === 'failed' ? 'text-rose-300' : 'text-emerald-300')} />}
                <div>
                  <p className={clsx('text-xs font-bold', queuedPhase === 'failed' ? 'text-rose-100' : 'text-emerald-100')}>
                    {queuedPhase === 'running'
                      ? (horizontal ? 'Building long-form montage' : 'Building short montage')
                      : queuedPhase === 'complete'
                        ? 'Montage complete'
                        : queuedPhase === 'failed'
                          ? 'Montage failed'
                          : 'Montage queued'}
                  </p>
                  <p className="mt-1 text-[10px] leading-4 text-slate-400">
                    {queuedPhase === 'complete'
                      ? (horizontal
                        ? 'The finished horizontal montage is ready in Library and can be opened in the long-form editor.'
                        : 'The finished vertical montage is ready in Library.')
                      : queuedPhase === 'failed'
                        ? (queuedJob?.error || 'Open Jobs for the render log and error details.')
                        : `Analyzing ${queued.sourceCount} ${queued.sourceCount === 1 ? sourceNoun : sourceNounPlural}. The ${horizontal ? 'horizontal long-form' : 'vertical short'} montage will appear in Library.`}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex gap-2"><Link className="btn-secondary flex-1 text-xs" to="/jobs">View job</Link><Link className="btn-secondary flex-1 text-xs" to="/library">Library</Link></div>
              {(queuedPhase === 'complete' || queuedPhase === 'failed') && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    className="btn-secondary min-h-9 w-full text-xs"
                    disabled={Boolean(activeJob?.active) || clips.length < minimumSources}
                    onClick={() => { void createCompilation(true); }}
                  >
                    Rebuild same {sourceNounPlural}
                  </button>
                  <button type="button" className="btn-ghost min-h-9 w-full text-xs" onClick={resetCompilation}>Choose different {sourceNounPlural}</button>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className="btn-primary min-h-12 w-full"
            disabled={
              clips.length < minimumSources
              || uploading
              || queued !== null
              || Boolean(activeJob?.active)
              || (!capabilities && !uploadSessionId)
              || limitsBlocked
              || storageBlocked
              || discardingUpload
            }
            onClick={() => { void createCompilation(); }}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : queued ? <CheckCircle2 className="h-4 w-4" /> : activeJob?.active ? <Gauge className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {uploading
              ? uploadProgress?.phase === 'finalizing' ? 'Starting montage…' : 'Uploading resumable chunks…'
              : queued
                ? 'Montage submitted'
                : activeJob?.active
                  ? 'Another job is running'
                  : uploadSessionId
                    ? 'Resume saved upload'
                    : capabilitiesQuery.isLoading
                      ? 'Checking upload capacity…'
                      : capabilitiesQuery.isError
                        ? 'Resumable upload unavailable'
                        : storageBlocked
                          ? 'More staging space required'
                          : clips.length < minimumSources
                            ? `Add at least ${minimumSources} ${minimumSources === 1 ? sourceNoun : sourceNounPlural}`
                            : `Analyze & build ${horizontal ? 'horizontal' : 'vertical'} montage`}
          </button>
          <p className="text-center text-[10px] leading-4 text-slate-500">
            Runs locally. Large files upload one at a time in resumable {formatSize(chunkBytes)} chunks. Pause or reconnect without restarting saved chunks; saved progress is kept for {uploadSessionHours} hours. After a page reload, reselect the same files to continue. Maximum {formatSize(maxFileBytes)} per {sourceNoun} and {formatSize(maxTotalBytes)} per job.
          </p>
        </aside>
      </div>
    </div>
  );
}
