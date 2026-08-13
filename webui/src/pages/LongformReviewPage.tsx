import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import {
  Check,
  CircleAlert,
  GitCompare,
  Loader2,
  LockKeyhole,
  MessageSquare,
  Pencil,
  Play,
  RotateCcw,
  Send,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api, ApiError, type LongformReview } from '@/api/client';

function formatTime(value: number) {
  const total = Math.max(0, Math.round(value * 1000));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const milliseconds = total % 1000;
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(hours ? 2 : 1, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

export function LongformReviewPage() {
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const compareRef = useRef<HTMLVideoElement>(null);
  const [password, setPassword] = useState(() => sessionStorage.getItem(`vcf-review-${token}`) || '');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [author, setAuthor] = useState(() => localStorage.getItem('vcf-review-author') || '');
  const [comment, setComment] = useState('');
  const [time, setTime] = useState(0);
  const [versionId, setVersionId] = useState('');
  const [compareVersionId, setCompareVersionId] = useState('');
  const [compare, setCompare] = useState(false);
  const [drawing, setDrawing] = useState<Array<{ x: number; y: number }>>([]);
  const [drawingActive, setDrawingActive] = useState(false);
  const [drawingPointer, setDrawingPointer] = useState(false);

  const reviewQuery = useQuery({
    queryKey: ['longform-public-review', token, password],
    queryFn: () => api.getLongformReview(token, password),
    enabled: Boolean(token),
    retry: false,
    refetchInterval: 5000,
  });
  const review = reviewQuery.data;
  const selectedVersion = useMemo(
    () => review?.versions.find((version) => version.id === versionId) || review?.versions[0],
    [review, versionId],
  );
  const compareVersion = useMemo(
    () => review?.versions.find((version) => version.id === compareVersionId) || review?.versions[1] || review?.versions[0],
    [review, compareVersionId],
  );

  useEffect(() => {
    if (!review?.versions.length) return;
    if (!versionId) setVersionId(review.versions[0].id);
    if (!compareVersionId) setCompareVersionId(review.versions[1]?.id || review.versions[0].id);
  }, [review, versionId, compareVersionId]);

  const commentMutation = useMutation({
    mutationFn: () => api.addLongformReviewComment(token, {
      author: author || 'Reviewer',
      text: comment,
      time,
      versionId: selectedVersion?.id || 'project-master',
      drawing,
      password,
    }),
    onSuccess: () => {
      localStorage.setItem('vcf-review-author', author || 'Reviewer');
      setComment('');
      setDrawing([]);
      queryClient.invalidateQueries({ queryKey: ['longform-public-review', token, password] });
    },
  });
  const statusMutation = useMutation({
    mutationFn: (status: LongformReview['status']) => api.updateLongformReview(token, { status, password }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['longform-public-review', token, password] }),
  });

  function unlock() {
    sessionStorage.setItem(`vcf-review-${token}`, passwordDraft);
    setPassword(passwordDraft);
  }

  function seek(seconds: number) {
    setTime(seconds);
    if (videoRef.current) videoRef.current.currentTime = seconds;
    if (compareRef.current) compareRef.current.currentTime = seconds;
  }

  function syncCompare() {
    if (!videoRef.current || !compareRef.current) return;
    compareRef.current.currentTime = videoRef.current.currentTime;
    if (!videoRef.current.paused) compareRef.current.play().catch(() => undefined);
    else compareRef.current.pause();
  }

  function drawPoint(event: PointerEvent<HTMLDivElement>) {
    if (!drawingActive || !drawingPointer) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
    setDrawing((current) => [...current, point].slice(-2000));
  }

  if (reviewQuery.isLoading) {
    return <ReviewShell><div className="grid min-h-[60vh] place-items-center"><Loader2 className="h-8 w-8 animate-spin text-cyan-300" /></div></ReviewShell>;
  }

  const queryError = reviewQuery.error;
  const passwordRequired = queryError instanceof ApiError && queryError.status === 401;
  if (passwordRequired) {
    return (
      <ReviewShell>
        <div className="mx-auto mt-24 max-w-md rounded-2xl border border-white/10 bg-slate-950/90 p-6 shadow-2xl">
          <LockKeyhole className="h-8 w-8 text-cyan-300" />
          <h1 className="mt-4 text-xl font-semibold text-white">Password-protected review</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">Enter the password supplied with this review link.</p>
          <input className="input mt-5 h-11" type="password" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') unlock(); }} autoFocus />
          <button className="btn-primary mt-3 w-full" onClick={unlock}>Open review</button>
        </div>
      </ReviewShell>
    );
  }

  if (!review) {
    return (
      <ReviewShell>
        <div className="mx-auto mt-24 max-w-lg rounded-2xl border border-red-400/20 bg-red-500/5 p-6">
          <CircleAlert className="h-8 w-8 text-red-300" />
          <h1 className="mt-4 text-xl font-semibold text-white">Review unavailable</h1>
          <p className="mt-2 text-sm text-slate-500">{queryError instanceof Error ? queryError.message : 'This link is invalid or has expired.'}</p>
        </div>
      </ReviewShell>
    );
  }

  return (
    <ReviewShell>
      <header className="border-b border-white/5 bg-slate-950/80 px-4 py-4 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-lg font-semibold text-white">{review.title}</div>
            <div className="mt-1 text-xs text-slate-600">Frame-accurate review · expires {new Date(review.expiresAt).toLocaleDateString()}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx('rounded-full px-3 py-1 text-[10px] font-semibold', review.status === 'approved' ? 'bg-emerald-500/15 text-emerald-200' : review.status === 'changes_requested' ? 'bg-amber-500/15 text-amber-200' : 'bg-cyan-500/15 text-cyan-200')}>
              {review.status.replace('_', ' ')}
            </span>
            <button className="btn-secondary h-9 text-xs" onClick={() => statusMutation.mutate('changes_requested')}><X className="h-4 w-4" /> Request changes</button>
            <button className="btn-primary h-9 text-xs" onClick={() => statusMutation.mutate('approved')}><Check className="h-4 w-4" /> Approve</button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1600px] gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:p-6">
        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap gap-3">
              <label>
                <span className="label">Version A</span>
                <select className="input h-9 min-w-56 text-xs" value={selectedVersion?.id || ''} onChange={(event) => setVersionId(event.target.value)}>
                  {review.versions.map((version) => <option key={version.id} value={version.id}>{version.label}</option>)}
                </select>
              </label>
              {compare && (
                <label>
                  <span className="label">Version B</span>
                  <select className="input h-9 min-w-56 text-xs" value={compareVersion?.id || ''} onChange={(event) => setCompareVersionId(event.target.value)}>
                    {review.versions.map((version) => <option key={version.id} value={version.id}>{version.label}</option>)}
                  </select>
                </label>
              )}
            </div>
            <button className={clsx('btn-secondary h-9 text-xs', compare && 'bg-cyan-500/10 text-cyan-200')} onClick={() => setCompare((value) => !value)}><GitCompare className="h-4 w-4" /> Compare versions</button>
          </div>

          <div className={clsx('grid gap-3', compare && 'xl:grid-cols-2')}>
            <ReviewVideo
              label="A"
              videoRef={videoRef}
              url={selectedVersion?.url}
              drawing={drawing}
              drawingActive={drawingActive}
              onPointerDown={() => setDrawingPointer(true)}
              onPointerUp={() => setDrawingPointer(false)}
              onPointerMove={drawPoint}
              onTime={(seconds) => {
                setTime(seconds);
                if (compare) syncCompare();
              }}
            />
            {compare && (
              <ReviewVideo
                label="B"
                videoRef={compareRef}
                url={compareVersion?.url}
                drawing={[]}
                drawingActive={false}
                onPointerDown={() => undefined}
                onPointerUp={() => undefined}
                onPointerMove={() => undefined}
                onTime={() => undefined}
              />
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/5 bg-black/20 p-3">
            <div className="font-mono text-sm text-cyan-200">{formatTime(time)}</div>
            <div className="flex flex-wrap gap-2">
              <button className={clsx('btn-secondary h-8 px-2 text-[10px]', drawingActive && 'bg-pink-500/10 text-pink-200')} onClick={() => setDrawingActive((value) => !value)}><Pencil className="h-3 w-3" /> Draw annotation</button>
              <button className="btn-secondary h-8 px-2 text-[10px]" disabled={!drawing.length} onClick={() => setDrawing([])}><RotateCcw className="h-3 w-3" /> Clear drawing</button>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-white/5 bg-black/20 p-4">
            <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
              <label>
                <span className="label">Your name</span>
                <input className="input h-9 text-xs" value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="Reviewer" />
              </label>
              <label>
                <span className="label">Comment at {formatTime(time)}</span>
                <input className="input h-9 text-xs" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="What should change on this frame?" onKeyDown={(event) => { if (event.key === 'Enter' && comment.trim()) commentMutation.mutate(); }} />
              </label>
            </div>
            <button className="btn-primary mt-3" disabled={!comment.trim() || commentMutation.isPending} onClick={() => commentMutation.mutate()}><Send className="h-4 w-4" /> Add frame comment {drawing.length ? '+ drawing' : ''}</button>
          </div>
        </section>

        <aside className="rounded-2xl border border-white/5 bg-slate-950/70 p-4 lg:sticky lg:top-5 lg:max-h-[calc(100vh-2.5rem)] lg:overflow-y-auto">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-white"><MessageSquare className="h-4 w-4 text-cyan-300" /> Comments</div>
            <span className="rounded-full bg-white/5 px-2 py-1 text-[10px] text-slate-500">{review.comments.length}</span>
          </div>
          <div className="mt-4 space-y-3">
            {[...review.comments].reverse().map((item) => (
              <button key={item.id} className="w-full rounded-xl border border-white/5 bg-black/25 p-3 text-left hover:border-cyan-400/20" onClick={() => seek(item.time)}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold text-slate-300">{item.author}</span>
                  <span className="font-mono text-[10px] text-cyan-300">{formatTime(item.time)}</span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{item.text}</p>
                <div className="mt-2 flex items-center gap-2">
                  {item.drawing.length > 0 && <span className="rounded-full bg-pink-500/10 px-2 py-0.5 text-[10px] text-pink-300">drawing</span>}
                  {item.resolved && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">resolved</span>}
                </div>
              </button>
            ))}
            {!review.comments.length && <div className="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-slate-600">No comments yet. Pause on a frame and leave the first note.</div>}
          </div>
        </aside>
      </main>
    </ReviewShell>
  );
}

function ReviewVideo({
  label,
  videoRef,
  url,
  drawing,
  drawingActive,
  onPointerDown,
  onPointerUp,
  onPointerMove,
  onTime,
}: {
  label: string;
  videoRef: React.RefObject<HTMLVideoElement>;
  url?: string;
  drawing: Array<{ x: number; y: number }>;
  drawingActive: boolean;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onTime: (time: number) => void;
}) {
  const points = drawing.map((point) => `${point.x * 100},${point.y * 100}`).join(' ');
  return (
    <div className="overflow-hidden rounded-2xl border border-white/5 bg-black shadow-2xl">
      <div className="flex items-center justify-between border-b border-white/5 bg-slate-950 px-3 py-2">
        <span className="rounded bg-cyan-500/15 px-2 py-1 text-[10px] font-semibold text-cyan-200">Version {label}</span>
        <span className="truncate text-[10px] text-slate-600">{url}</span>
      </div>
      <div
        className={clsx('relative aspect-video bg-black', drawingActive && 'cursor-crosshair')}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          onPointerDown();
          onPointerMove(event);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          onPointerUp();
        }}
        onPointerMove={onPointerMove}
      >
        {url ? (
          <video
            ref={videoRef}
            className="h-full w-full object-contain"
            src={url}
            controls={!drawingActive}
            playsInline
            onTimeUpdate={(event) => onTime(event.currentTarget.currentTime)}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-slate-600"><Play className="h-8 w-8" /></div>
        )}
        {drawing.length > 0 && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polyline points={points} fill="none" stroke="#F472B6" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
    </div>
  );
}

function ReviewShell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[#05070d] text-slate-200 selection:bg-cyan-500/30">{children}</div>;
}
