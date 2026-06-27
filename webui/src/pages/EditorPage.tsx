import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Download, RefreshCcw, Type, ZoomIn, Palette, Settings2,
  Captions, Loader2, CheckCircle2, AlertCircle, Type as TypeIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api, type ClipMetadata, type ClipWord } from '@/api/client';
import { OVERLAY_STYLES, STYLE_LIST, getStyleDefaultPos } from '@/lib/subtitle-styles';
import { FONT_LIST } from '@/lib/fonts';
import { WORD_ANIMATIONS, ANIMATION_ORDER, ANIMATION_KEYFRAMES } from '@/lib/animations';
import { useUIStore } from '@/store/ui';

const PREVIEW_W = 240;
const PREVIEW_H = 426;

export function EditorPage() {
  const { clipName = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const preferredStyle = useUIStore((s) => s.preferredStyle);
  const preferredAnimation = useUIStore((s) => s.preferredAnimation);
  const setPreferredStyle = useUIStore((s) => s.setPreferredStyle);
  const setPreferredAnimation = useUIStore((s) => s.setPreferredAnimation);

  const { data: meta, isLoading, error } = useQuery({
    queryKey: ['clip', clipName],
    queryFn: () => api.getClipMeta(clipName),
    enabled: !!clipName,
  });

  // Editor state
  const [style, setStyleState] = useState<string>('classic');
  const [animation, setAnimationState] = useState<string>('none');
  const [font, setFont] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState<number>(90);
  const [overlayX, setOverlayX] = useState(0.5);
  const [overlayY, setOverlayY] = useState(0.8);
  const [overlayW, setOverlayW] = useState(0.8);
  const [videoZoom, setVideoZoom] = useState(1.0);
  const [panXPx, setPanXPx] = useState(0);
  const [panYPx, setPanYPx] = useState(0);
  const [words, setWords] = useState<ClipWord[]>([]);
  const [timeOffset, setTimeOffset] = useState(0);

  function setStyle(s: string) {
    setStyleState(s);
    setPreferredStyle(s);
    const [dx, dy] = getStyleDefaultPos(s);
    setOverlayX(dx);
    setOverlayY(dy);
  }
  function setAnimation(a: string) {
    setAnimationState(a);
    setPreferredAnimation(a);
  }
  function setZoom(z: number) {
    setVideoZoom(clamp(z, 1, 4));
    if (z <= 1.01) { setPanXPx(0); setPanYPx(0); }
  }

  useEffect(() => {
    if (!meta) return;
    const initialStyle = (meta.style && OVERLAY_STYLES[meta.style]) ? meta.style
      : (meta.subtitle_x != null || meta.subtitle_y != null) ? (meta.style || preferredStyle)
      : (preferredStyle || meta.style || 'classic');
    setStyleState(initialStyle);
    setPreferredStyle(initialStyle);
    setAnimationState(meta.animation && WORD_ANIMATIONS[meta.animation] ? meta.animation : preferredAnimation);
    setPreferredAnimation(meta.animation && WORD_ANIMATIONS[meta.animation] ? meta.animation : preferredAnimation);
    setFont(meta.font || null);
    setFontSize(meta.subtitle_fontsize ?? 90);
    setOverlayX(meta.subtitle_x ?? getStyleDefaultPos(initialStyle)[0]);
    setOverlayY(meta.subtitle_y ?? getStyleDefaultPos(initialStyle)[1]);
    setOverlayW(meta.subtitle_width ?? 0.8);
    const z = parseFloat(String(meta.video_zoom ?? '1')) || 1;
    setVideoZoom(z);
    setPanXPx((Number(meta.video_pan_x) || 0) * PREVIEW_W * z);
    setPanYPx((Number(meta.video_pan_y) || 0) * PREVIEW_H * z);
    setWords(JSON.parse(JSON.stringify(meta.words || [])));
    setTimeOffset(meta.start || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  return (
    <div className="flex h-full min-h-screen flex-col">
      <style>{ANIMATION_KEYFRAMES}</style>

      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/5 bg-bg-panel/80 px-4 backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0">
          <button className="btn-ghost" onClick={() => navigate('/library')}>
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Library</span>
          </button>
          <div className="h-6 w-px bg-white/10" />
          <div className="min-w-0">
            <div className="text-xs text-slate-500">Editing</div>
            <div className="truncate font-mono text-sm text-white">{clipName}</div>
          </div>
        </div>
        {meta && (
          <div className="hidden md:flex items-center gap-2 text-[11px]">
            <span className="chip">
              <span className="text-slate-400">Score</span>
              <span className="text-white font-bold">{parseFloat(String(meta.score)).toFixed(1)}</span>
            </span>
            <span className="chip">
              <span className="text-slate-400">Duration</span>
              <span className="text-white font-bold">{meta.duration?.toFixed(1)}s</span>
            </span>
            <span className="chip">
              <span className="text-slate-400">Words</span>
              <span className="text-white font-bold">{words.length}</span>
            </span>
          </div>
        )}
      </header>

      {isLoading ? (
        <div className="grid flex-1 place-items-center text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : error ? (
        <div className="grid flex-1 place-items-center text-red-400">
          <div className="text-center">
            <AlertCircle className="mx-auto h-8 w-8" />
            <p className="mt-2">{(error as Error).message}</p>
            <button className="btn-secondary mt-3" onClick={() => navigate('/library')}>Back to Library</button>
          </div>
        </div>
      ) : !meta || !meta.words?.length ? (
        <div className="grid flex-1 place-items-center text-slate-400">
          <div className="text-center max-w-md">
            <Captions className="mx-auto h-8 w-8 opacity-60" />
            <p className="mt-3">This clip has no word-timing data.</p>
            <p className="mt-1 text-sm text-slate-500">Re-process the source video with a caption style selected to enable the editor.</p>
          </div>
        </div>
      ) : (
        <EditorBody
          clipName={clipName}
          meta={meta}
          state={{
            style, setStyle, animation, setAnimation, font, setFont,
            fontSize, setFontSize,
            overlayX, setOverlayX, overlayY, setOverlayY, overlayW, setOverlayW,
            videoZoom, setZoom, panXPx, setPanXPx, panYPx, setPanYPx,
            words, setWords, timeOffset,
          }}
          onApplied={() => {
            qc.invalidateQueries({ queryKey: ['clip', clipName] });
            qc.invalidateQueries({ queryKey: ['clips'] });
          }}
        />
      )}
    </div>
  );
}

interface EditorState {
  style: string; setStyle: (s: string) => void;
  animation: string; setAnimation: (a: string) => void;
  font: string | null; setFont: (f: string | null) => void;
  fontSize: number; setFontSize: (n: number) => void;
  overlayX: number; setOverlayX: (n: number) => void;
  overlayY: number; setOverlayY: (n: number) => void;
  overlayW: number; setOverlayW: (n: number) => void;
  videoZoom: number; setZoom: (n: number) => void;
  panXPx: number; setPanXPx: (n: number) => void;
  panYPx: number; setPanYPx: (n: number) => void;
  words: ClipWord[]; setWords: (w: ClipWord[]) => void;
  timeOffset: number;
}

function clamp(n: number, min: number, max: number) {
  return Math.round(Math.max(min, Math.min(max, n)) * 10) / 10;
}

function EditorBody({
  clipName, meta, state, onApplied,
}: {
  clipName: string;
  meta: ClipMetadata;
  state: EditorState;
  onApplied: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [paused, setPaused] = useState(true);
  const [demoIndex, setDemoIndex] = useState(0);
  const [applyState, setApplyState] = useState<'idle' | 'rendering' | 'done' | 'error'>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);

  const sc = OVERLAY_STYLES[state.style] || OVERLAY_STYLES.classic;
  const animDef = WORD_ANIMATIONS[state.animation];

  const buildPayload = useCallback(() => {
    const normalizedZoom = Math.max(state.videoZoom || 1, 1);
    return {
      words: state.words,
      style: state.style,
      animation: state.animation,
      posX: state.overlayX,
      posY: state.overlayY,
      fontSize: state.fontSize,
      font: state.font,
      width: state.overlayW,
      videoZoom: state.videoZoom,
      videoPanX: state.panXPx / (PREVIEW_W * normalizedZoom),
      videoPanY: state.panYPx / (PREVIEW_H * normalizedZoom),
    };
  }, [state]);

  const applyMutation = useMutation({
    mutationFn: () => api.reRenderClip(clipName, buildPayload()),
    onMutate: () => { setApplyState('rendering'); setApplyError(null); },
    onSuccess: () => { setApplyState('done'); onApplied(); setTimeout(() => setApplyState('idle'), 2200); },
    onError: (e) => { setApplyState('error'); setApplyError((e as Error).message); },
  });

  const bake = useBakeDownload({
    clipName,
    buildPayload,
    onState: (s) => {
      setApplyState(s);
      if (s === 'done') setTimeout(() => setApplyState('idle'), 2200);
    },
    onError: setApplyError,
  });

  // Demo cycling while paused
  useEffect(() => {
    if (!paused) return;
    if (!state.words?.length) return;
    if (state.words.length <= sc.chunks) return;
    const t = setInterval(() => {
      setDemoIndex((i) => (i + 1) % Math.ceil(state.words.length / sc.chunks));
    }, 1400);
    return () => clearInterval(t);
  }, [paused, sc.chunks, state.words.length]);

  useEffect(() => { setDemoIndex(0); }, [state.style, state.animation]);

  // Determine chunk to show
  const chunkCount = Math.max(1, Math.ceil(state.words.length / sc.chunks));
  const activeChunkIdx = useMemo(() => {
    if (paused) return demoIndex;
    const t = currentTime + state.timeOffset;
    for (let i = 0; i < state.words.length; i += sc.chunks) {
      const chunk = state.words.slice(i, i + sc.chunks);
      if (t >= chunk[0].start && t <= chunk[chunk.length - 1].end + 0.05) {
        return Math.floor(i / sc.chunks);
      }
    }
    return -1;
  }, [paused, currentTime, state.words, state.timeOffset, sc.chunks, demoIndex]);

  const nearestChunkIdx = useMemo(() => {
    if (activeChunkIdx >= 0) return activeChunkIdx;
    const t = currentTime + state.timeOffset;
    let bestDist = Infinity, bestIdx = 0;
    state.words.forEach((w, i) => {
      const dist = Math.abs((w.start + w.end) / 2 - t);
      if (dist < bestDist) { bestDist = dist; bestIdx = Math.floor(i / sc.chunks); }
    });
    return bestIdx;
  }, [activeChunkIdx, currentTime, state.words, sc.chunks, state.timeOffset]);

  const displayChunk = state.words.slice(nearestChunkIdx * sc.chunks, (nearestChunkIdx + 1) * sc.chunks);
  const videoTime = paused ? -1 : currentTime + state.timeOffset;

  return (
    <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
      <section className="flex flex-col items-center gap-3 border-b border-white/5 p-4 lg:w-[420px] lg:border-b-0 lg:border-r lg:overflow-y-auto">
        <p className="text-[11px] text-slate-500">Drag subtitle to reposition · Scroll to zoom</p>
        <div
          className="relative w-[240px] overflow-hidden rounded-xl border-2 border-brand-500/30 bg-black"
          style={{ aspectRatio: '9/16' }}
          onWheel={(e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            state.setZoom(state.videoZoom + delta);
          }}
        >
          <video
            ref={videoRef}
            src={meta.url}
            className="absolute inset-0 h-full w-full object-cover"
            style={{
              transform: `scale(${state.videoZoom}) translate(${state.panXPx / state.videoZoom}px, ${state.panYPx / state.videoZoom}px)`,
              transformOrigin: 'center center',
            }}
            playsInline
            controls
            onTimeUpdate={(e) => setCurrentTime((e.target as HTMLVideoElement).currentTime)}
            onPlay={() => setPaused(false)}
            onPause={() => setPaused(true)}
          />
          <SubtitleOverlay
            chunk={displayChunk}
            currentTime={videoTime}
            styleId={state.style}
            fontSize={state.fontSize}
            font={state.font}
            animation={state.animation}
            paused={paused}
            x={state.overlayX}
            y={state.overlayY}
            w={state.overlayW}
            onPositionXChange={state.setOverlayX}
            onPositionYChange={state.setOverlayY}
            onWidthChange={state.setOverlayW}
          />
        </div>

        <div className="w-full max-w-[240px] space-y-1">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="flex items-center gap-1.5"><Type className="h-3 w-3" /> Font Size</span>
            <span className="font-mono text-slate-300">{state.fontSize}pt</span>
          </div>
          <input
            type="range" min="40" max="160" value={state.fontSize}
            onChange={(e) => state.setFontSize(parseInt(e.target.value))}
            className="w-full accent-pink-500"
          />
        </div>

        <div className="w-full max-w-[240px] space-y-1">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="flex items-center gap-1.5"><ZoomIn className="h-3 w-3" /> Video Zoom</span>
            <span className="font-mono text-slate-300">{state.videoZoom.toFixed(1)}x</span>
          </div>
          <input
            type="range" min="100" max="400" step="5"
            value={Math.round(state.videoZoom * 100)}
            onChange={(e) => state.setZoom(parseInt(e.target.value) / 100)}
            className="w-full accent-pink-500"
          />
          <button
            onClick={() => state.setZoom(1)}
            className="text-[10px] text-brand-400 hover:text-brand-300"
          >Reset zoom & pan</button>
        </div>

        <div className="text-[11px] font-mono text-slate-500">
          X: {Math.round(state.overlayX * 100)}% &nbsp; Y: {Math.round(state.overlayY * 100)}% &nbsp; W: {Math.round(state.overlayW * 100)}%
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          <div>
            <div className="label flex items-center gap-1.5"><Palette className="h-3 w-3" /> Caption Style</div>
            <div className="flex flex-wrap gap-1.5">
              {STYLE_LIST.map((s, i) => {
                if ('sep' in s) {
                  const prev = i > 0 ? STYLE_LIST[i - 1] : null;
                  const showSep = !prev || !('sep' in prev);
                  if (!showSep) return null;
                  return <div key={`sep-${i}`} className="w-full text-[10px] font-semibold uppercase tracking-wider text-slate-500 pt-2">{s.sep}</div>;
                }
                const active = state.style === s.id;
                const accent = OVERLAY_STYLES[s.id]?.hi[0] || '#fff';
                return (
                  <button
                    key={s.id}
                    onClick={() => state.setStyle(s.id)}
                    className={clsx(
                      'rounded-md px-2.5 py-1 text-[11px] font-semibold transition',
                      active
                        ? 'bg-white/10 text-white ring-1'
                        : 'bg-white/5 text-slate-300 hover:bg-white/10',
                    )}
                    style={active ? { borderColor: accent, boxShadow: `0 0 0 1px ${accent}40` } : {}}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="label flex items-center gap-1.5"><TypeIcon className="h-3 w-3" /> Font</div>
            <select
              className="input"
              value={state.font ?? ''}
              onChange={(e) => state.setFont(e.target.value || null)}
              style={state.font ? { fontFamily: `"${state.font}", sans-serif` } : {}}
            >
              {FONT_LIST.map((f, i) => {
                if (f.group === 'header') return <option key={`hdr-${i}`} disabled>{f.label}</option>;
                return <option key={f.label} value={f.id ?? ''} style={f.id ? { fontFamily: `"${f.id}", sans-serif` } : {}}>{f.label}</option>;
              })}
            </select>
            <p className="mt-1 text-[10px] text-slate-500">Bake output depends on the system fonts installed on the server.</p>
          </div>

          <div>
            <div className="label flex items-center gap-1.5"><Settings2 className="h-3 w-3" /> Word Animation</div>
            <div className="flex flex-wrap gap-1.5">
              {ANIMATION_ORDER.map((id) => {
                const def = WORD_ANIMATIONS[id];
                const label = id === 'none' ? '— None' : (def?.label || id);
                const active = state.animation === id;
                return (
                  <button
                    key={id}
                    onClick={() => state.setAnimation(id)}
                    className={clsx(
                      'rounded-md px-2.5 py-1 text-[11px] font-semibold transition',
                      active
                        ? 'bg-gradient-to-r from-accent-pink/30 to-brand-500/30 text-white ring-1 ring-accent-pink/40'
                        : 'bg-white/5 text-slate-300 hover:bg-white/10',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {animDef?.hint && state.animation !== 'none' && (
              <p className="mt-2 text-[11px] text-slate-500">{animDef.hint}</p>
            )}
          </div>

          <WordEditor
            words={state.words}
            onChange={state.setWords}
            chunkSize={sc.chunks}
            currentTime={videoTime}
            timeOffset={state.timeOffset}
            onSeek={(t) => { if (videoRef.current) videoRef.current.currentTime = Math.max(0, t - state.timeOffset); }}
          />
        </div>

        <footer className="shrink-0 border-t border-white/5 bg-bg-panel/80 p-4 backdrop-blur-md space-y-3">
          {bake.active && bake.progress > 0 && (
            <div>
              <div className="flex justify-between text-[11px] text-slate-300">
                <span>{bake.label}</span>
                <span className="font-mono">{bake.progress}%</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/5">
                <div className="h-full bg-gradient-to-r from-accent-pink to-brand-500 transition-all" style={{ width: `${bake.progress}%` }} />
              </div>
            </div>
          )}
          {applyState === 'done' && (
            <div className="flex items-center gap-2 rounded-md bg-emerald-500/15 px-3 py-1.5 text-[11px] text-emerald-300">
              <CheckCircle2 className="h-3 w-3" /> Done.
            </div>
          )}
          {applyState === 'error' && applyError && (
            <div className="flex items-center gap-2 rounded-md bg-red-500/15 px-3 py-1.5 text-[11px] text-red-300">
              <AlertCircle className="h-3 w-3" /> {applyError}
            </div>
          )}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="text-[11px] text-slate-500">
              Edits are kept in your browser. Use the buttons to write them to the clip.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="btn-secondary"
                onClick={() => applyMutation.mutate()}
                disabled={applyMutation.isPending || bake.active}
              >
                {applyMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
                Apply &amp; Re-render
              </button>
              <button
                className="btn-primary"
                onClick={bake.start}
                disabled={bake.active || applyMutation.isPending}
              >
                {bake.active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Bake &amp; Download
              </button>
            </div>
          </div>
        </footer>
      </section>
    </div>
  );
}

function SubtitleOverlay({
  chunk, currentTime, styleId, fontSize, font, animation, paused, x, y, w,
  onPositionXChange, onPositionYChange, onWidthChange,
}: {
  chunk: ClipWord[];
  currentTime: number;
  styleId: string;
  fontSize: number;
  font: string | null;
  animation: string;
  paused: boolean;
  x: number; y: number; w: number;
  onPositionXChange: (n: number) => void;
  onPositionYChange: (n: number) => void;
  onWidthChange: (n: number) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ active: boolean; mode: 'move' | 'left' | 'right' | null; sx: number; sy: number; spx: number; spy: number; spw: number; }>(
    { active: false, mode: null, sx: 0, sy: 0, spx: 0, spy: 0, spw: 0 }
  );

  const sc = OVERLAY_STYLES[styleId] || OVERLAY_STYLES.classic;
  const anim = WORD_ANIMATIONS[animation];

  // Scale preview font size based on the 240px-wide preview vs. 1080px reference
  const scale = 240 / 1080;
  const cssFontSize = Math.max(8, Math.round(fontSize * scale));

  // Start drag
  const onMoveMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = { active: true, mode: 'move', sx: e.clientX, sy: e.clientY, spx: x, spy: y, spw: w };
  };
  const onResizeMouseDown = (side: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { active: true, mode: side, sx: e.clientX, sy: e.clientY, spx: x, spy: y, spw: w };
  };

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!drag.current.active) return;
      const parent = overlayRef.current?.parentElement;
      if (!parent) return;
      const r = parent.getBoundingClientRect();
      if (drag.current.mode === 'move') {
        onPositionXChange(clamp(drag.current.spx + (e.clientX - drag.current.sx) / r.width, 0.05, 0.95));
        onPositionYChange(clamp(drag.current.spy + (e.clientY - drag.current.sy) / r.height, 0.05, 0.95));
      } else if (drag.current.mode === 'right') {
        const dxf = (e.clientX - drag.current.sx) / r.width;
        onWidthChange(clamp(drag.current.spw + dxf, 0.15, 1.0));
      } else if (drag.current.mode === 'left') {
        const dxf = (e.clientX - drag.current.sx) / r.width;
        onWidthChange(clamp(drag.current.spw - dxf, 0.15, 1.0));
        onPositionXChange(clamp(drag.current.spx + dxf / 2, 0.05, 0.95));
      }
    }
    function onMouseUp() { drag.current.active = false; drag.current.mode = null; }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [onPositionXChange, onPositionYChange, onWidthChange]);

  // Build inline style
  const fontCss = sc.font.replace('1em', `${cssFontSize}px`);
  const finalFont = font ? fontCss.replace(/^(\d+\w+\s+[\d.]+px\s+).*$/, `$1"${font}",sans-serif`) : fontCss;
  const tShadow = sc.op > 0 && sc.outline !== 'none'
    ? `-${sc.op}px -${sc.op}px 0 ${sc.outline},${sc.op}px -${sc.op}px 0 ${sc.outline},-${sc.op}px ${sc.op}px 0 ${sc.outline},${sc.op}px ${sc.op}px 0 ${sc.outline}`
    : sc.ts || 'none';

  return (
    <div
      ref={overlayRef}
      className="absolute z-10"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${w * 100}%`,
        transform: 'translate(-50%, -50%)',
        textAlign: 'center',
        cursor: 'grab',
      }}
      onMouseDown={onMoveMouseDown}
    >
      <div
        className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-ew-resize z-20"
        onMouseDown={onResizeMouseDown('left')}
      />
      <div
        className="absolute -right-1.5 top-0 bottom-0 w-3 cursor-ew-resize z-20"
        onMouseDown={onResizeMouseDown('right')}
      />
      <div
        style={{
          font: finalFont,
          color: sc.color,
          textShadow: tShadow,
          ...(sc.bg && sc.bg !== 'none' ? { background: sc.bg, padding: '2px 5px', borderRadius: 3 } : {}),
          textTransform: sc.upper ? 'uppercase' : 'none',
          letterSpacing: sc.ls || 'normal',
          whiteSpace: 'normal',
          wordBreak: 'break-word',
          lineHeight: 1.25,
        }}
      >
        {chunk.map((w, j) => {
          const isActive = currentTime >= 0
            ? (currentTime >= w.start && currentTime <= w.end + 0.05)
            : (anim?.active ? j === Math.floor(chunk.length / 2) : false);
          const word = sc.upper ? w.word.trim().toUpperCase() : w.word.trim();
          const color = isActive ? sc.hi[j % sc.hi.length] : sc.color;
          let transform = isActive && !anim ? 'scale(1.12)' : 'scale(1)';
          let animCss: React.CSSProperties = {};
          if (anim?.entry) {
            const delay = (j * (anim.stagger ?? 0.06)).toFixed(2);
            animCss = { animation: `${anim.entry} ${anim.dur ?? '.3s'} ${anim.easing ?? 'ease'} ${delay}s both` };
            transform = isActive ? 'scale(1.08)' : 'scale(1)';
          }
          if (anim?.active && isActive) {
            animCss = { animation: `${anim.active} ${anim.activeDur ?? '.5s'} ease infinite` };
            transform = 'none';
          }
          if (paused && currentTime < 0) animCss.animationPlayState = 'paused';
          return (
            <span
              key={j}
              style={{
                display: 'inline-block',
                color,
                transform,
                marginRight: j === chunk.length - 1 ? 0 : `${Math.max(3, Math.round(cssFontSize * (animation === 'none' ? 0.22 : 0.34)))}px`,
                ...animCss,
              }}
            >{word}</span>
          );
        })}
      </div>
    </div>
  );
}

function WordEditor({
  words, onChange, chunkSize, currentTime, timeOffset, onSeek,
}: {
  words: ClipWord[];
  onChange: (w: ClipWord[]) => void;
  chunkSize: number;
  currentTime: number;
  timeOffset: number;
  onSeek: (t: number) => void;
}) {
  const [text, setText] = useState(words.map((w) => w.word.trim()).join(' '));
  useEffect(() => { setText(words.map((w) => w.word.trim()).join(' ')); }, [words]);

  function commitText(newText: string) {
    setText(newText);
    const tokens = newText.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) { onChange([]); return; }
    const old = words;
    const avgDur = old.length ? old.reduce((a, w) => a + (w.end - w.start), 0) / old.length : 0.4;
    const rebuilt: ClipWord[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const src = old[Math.min(i, old.length - 1)] || { start: 0, end: 0.4 };
      const start = i < old.length ? src.start : (rebuilt[i - 1]?.end ?? 0);
      const end = i < old.length ? src.end : start + avgDur;
      rebuilt.push({ word: ' ' + tokens[i], start, end });
    }
    onChange(rebuilt);
  }

  function updateWord(i: number, newWord: string) {
    const next = words.slice();
    next[i] = { ...next[i], word: ' ' + newWord };
    onChange(next);
  }

  const CHUNK = 5;
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <div className="label !mb-0">Caption Text</div>
        <span className="text-[10px] font-mono text-slate-500">{wordCount} word{wordCount !== 1 ? 's' : ''}</span>
      </div>
      <textarea
        rows={2}
        className="input font-mono text-sm leading-relaxed resize-none"
        value={text}
        placeholder="Edit caption text — word timings are preserved automatically"
        onChange={(e) => commitText(e.target.value)}
      />
      <div className="mt-3 max-h-72 overflow-y-auto pr-1 space-y-2 scrollbar-thin">
        {Array.from({ length: Math.ceil(words.length / CHUNK) }, (_, ci) => {
          const slice = words.slice(ci * CHUNK, (ci + 1) * CHUNK);
          if (!slice.length) return null;
          const t0 = slice[0].start.toFixed(2);
          const t1 = slice[slice.length - 1].end.toFixed(2);
          return (
            <div key={ci} className="rounded-lg border border-white/5 bg-black/30 p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <div className="text-[10px] font-mono text-slate-500">{t0}s – {t1}s</div>
                <button onClick={() => onSeek(slice[0].start)} className="text-[10px] text-brand-400 hover:text-brand-300">
                  jump to
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {slice.map((w, j) => {
                  const idx = ci * CHUNK + j;
                  const isActive = currentTime >= 0 && currentTime >= w.start && currentTime <= w.end + 0.05;
                  return (
                    <WordToken
                      key={idx}
                      text={w.word.trim()}
                      active={isActive}
                      onCommit={(t) => updateWord(idx, t)}
                      onClick={() => onSeek(w.start)}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WordToken({ text, active, onCommit, onClick }: {
  text: string;
  active: boolean;
  onCommit: (text: string) => void;
  onClick: () => void;
}) {
  const [val, setVal] = useState(text);
  useEffect(() => setVal(text), [text]);
  return (
    <span
      contentEditable
      suppressContentEditableWarning
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onBlur={() => onCommit(val)}
      onInput={(e) => setVal((e.target as HTMLElement).textContent || '')}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); } }}
      className={clsx(
        'rounded-md border px-1.5 py-0.5 text-[12px] outline-none transition cursor-text',
        active
          ? 'border-brand-500 bg-brand-500/20 text-white'
          : 'border-white/10 bg-brand-500/10 text-slate-200 focus:border-brand-500 focus:bg-brand-500/20',
      )}
    >
      {val}
    </span>
  );
}

function useBakeDownload({
  clipName, buildPayload, onState, onError,
}: {
  clipName: string;
  buildPayload: () => Record<string, unknown>;
  onState: (s: 'idle' | 'rendering' | 'done' | 'error') => void;
  onError: (e: string) => void;
}) {
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState(0);
  const [label, setLabel] = useState('Rendering…');

  async function start() {
    setActive(true); setProgress(0); onState('rendering');
    try {
      const { jobId } = await api.startBakeDownload(clipName, buildPayload());
      setLabel('Rendering…');
      const t = setInterval(async () => {
        try {
          const s = await api.bakeProgress(jobId);
          setProgress(s.progress);
          if (s.done) {
            clearInterval(t);
            if (s.error) {
              onState('error'); onError(s.error);
              setActive(false);
            } else {
              setLabel('Download starting…');
              setProgress(100);
              triggerDownload(api.bakeDownloadUrl(jobId, clipName), clipName);
              onState('done');
              setActive(false);
              setTimeout(() => setProgress(0), 1500);
            }
          }
        } catch (e) {
          clearInterval(t);
          onState('error'); onError((e as Error).message);
          setActive(false);
        }
      }, 600);
    } catch (e) {
      onState('error'); onError((e as Error).message);
      setActive(false);
    }
  }

  return { start, active, progress, label };
}

function triggerDownload(url: string, filename: string) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '');
  if (isIOS) { window.location.assign(url); return; }
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
