import { useMemo, useRef, useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Upload, Link2, FileVideo, Send, ChevronRight, Sparkles, Activity, Flame, TrendingUp, Trophy, Loader2, CheckCircle2, AlertCircle, ListChecks, ShieldCheck, Clapperboard } from 'lucide-react';
import { clsx } from 'clsx';
import { api, type JobPreflight } from '@/api/client';
import { useResumableUpload, formatSize } from '@/api/upload';
import { Button, Panel, Select, StatCard, ToggleGroup } from '@/components/ui';
import { CaptionStylePicker } from '@/components/captions/CaptionStylePicker';
import { useActiveJob, useLogs, useClips } from '@/hooks/queries';
import { useUIStore } from '@/store/ui';
import { CLIP_VOLUME_OPTIONS, SEGMENT_PRESETS, MAX_DURATIONS, MAX_CLIPS, FRAMING_MODES, EXPORT_PRESETS } from '@/lib/render-options';
import type { RenderSettings, SegmentPreset } from '@/lib/render-options';
import { useWakeLock } from '@/hooks/useWakeLock';

export function DashboardPage() {
  const { data: clips = [], isLoading: clipsLoading } = useClips();
  const { data: job } = useActiveJob();
  const { data: logs = [] } = useLogs(60);
  const qc = useQueryClient();
  const uploadDefaults = useUIStore((s) => s.uploadDefaults);
  const setUploadDefaults = useUIStore((s) => s.setUploadDefaults);
  const keepAwake = useUIStore((s) => s.keepAwake);
  const setKeepAwake = useUIStore((s) => s.setKeepAwake);

  const [settings, setSettings] = useState<RenderSettings>(uploadDefaults);
  const [preset, setPreset] = useState<SegmentPreset>('full');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [url, setUrl] = useState('');
  const [urlPlatform, setUrlPlatform] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { upload, progress, active: uploadActive } = useResumableUpload();
  useWakeLock(uploadActive, keepAwake);

  const preflight = useQuery({
    queryKey: ['job-preflight', settings],
    queryFn: () => api.jobPreflight(settings),
    staleTime: 10_000,
    retry: 1,
  });
  // Starting while the probe is loading or failed would bypass the exact
  // configuration guard that preflight is meant to provide.
  const jobReady = preflight.data?.ready === true && !preflight.isError;

  const [dropping, setDropping] = useState(false);

  // Keep a selected caption style (and every other render option) when the
  // user leaves and returns to the dashboard, not only after a job starts.
  function update<K extends keyof RenderSettings>(k: K, v: RenderSettings[K]) {
    const next = { ...settings, [k]: v };
    setSettings(next);
    setUploadDefaults(next);
  }

  // Apply segment preset to settings.startTime/endTime
  useEffect(() => {
    if (preset === 'custom') {
      update('startTime', customStart);
      update('endTime', customEnd);
      return;
    }
    const p = SEGMENT_PRESETS.find((p) => p.id === preset);
    if (p) {
      update('startTime', p.startTime);
      update('endTime', p.endTime);
    }
  }, [preset, customStart, customEnd]);

  // URL platform detect
  useEffect(() => {
    if (!url) return setUrlPlatform(null);
    try {
      const h = new URL(url).hostname.replace(/^www\./, '');
      if (/youtube\.com|youtu\.be/.test(h)) return setUrlPlatform('YouTube');
      if (/rumble\.com/.test(h)) return setUrlPlatform('Rumble');
      if (/twitch\.tv/.test(h)) return setUrlPlatform('Twitch');
      if (/facebook\.com|fb\.watch/.test(h)) return setUrlPlatform('Facebook');
      if (/instagram\.com/.test(h)) return setUrlPlatform('Instagram');
      if (/tiktok\.com/.test(h)) return setUrlPlatform('TikTok');
      if (/twitter\.com|x\.com/.test(h)) return setUrlPlatform('X / Twitter');
      if (/vimeo\.com/.test(h)) return setUrlPlatform('Vimeo');
      if (/dailymotion\.com/.test(h)) return setUrlPlatform('Dailymotion');
    } catch {}
    return setUrlPlatform(null);
  }, [url]);

  const stats = useMemo(() => {
    const scores = clips.map((c) => parseFloat(String(c.score))).filter((n) => !isNaN(n));
    return {
      total: clips.length,
      avg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
      top: scores.length ? Math.max(...scores) : 0,
    };
  }, [clips]);

  const urlMutation = useMutation({
    mutationFn: (body: { url: string } & RenderSettings) => api.processUrl(body),
    onSuccess: () => {
      setUrl('');
      qc.invalidateQueries({ queryKey: ['job-status'] });
    },
  });

  async function handleFile(file: File) {
    if (!jobReady) return;
    setLaunchError(null);
    urlMutation.reset();
    try {
      setUploadDefaults(settings);
      await api.saveSettings(settings);
      await upload(file, settings);
      qc.invalidateQueries({ queryKey: ['job-status'] });
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : 'Unable to save the job settings');
    }
  }

  async function handleUrlSubmit() {
    if (!url || !jobReady) return;
    setLaunchError(null);
    urlMutation.reset();
    try {
      setUploadDefaults(settings);
      await api.saveSettings(settings);
      urlMutation.mutate({ url, ...settings });
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : 'Unable to save the job settings');
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-6">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tight">
            <span className="gradient-text">Viral Clip</span>{' '}
            <span className="text-white">Factory</span>
          </h1>
          <p className="mt-1 text-sm text-slate-400">Local-first transcription, speaker tracking, and multi-signal viral moment detection.</p>
        </div>
        <div className="flex flex-wrap gap-2 self-start sm:self-auto">
          <Link to="/compilations" className="btn-primary">
            <Clapperboard className="h-4 w-4" />
            Create a Montage
          </Link>
          <Link to="/library" className="btn-secondary">
            View Library
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </header>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={<Flame className="h-4 w-4" />}
          label="Total Clips"
          value={String(stats.total)}
          accent="from-pink-500 to-orange-500"
          loading={clipsLoading}
        />
        <StatCard
          icon={<Activity className="h-4 w-4" />}
          label="Status"
          value={job?.active ? 'Processing' : (job?.error ? 'Error' : 'Idle')}
          accent={job?.active ? 'from-violet-500 to-pink-500' : 'from-slate-500 to-slate-700'}
          pulse={job?.active}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Avg Score"
          value={stats.avg.toFixed(1)}
          accent="from-blue-500 to-violet-500"
          loading={clipsLoading}
        />
        <StatCard
          icon={<Trophy className="h-4 w-4" />}
          label="Top Score"
          value={stats.top.toFixed(1)}
          accent="from-amber-500 to-pink-500"
          loading={clipsLoading}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Render Wizard */}
        <Panel
          className="min-w-0 space-y-4 p-5 xl:col-span-1"
          title={
            <span className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-accent-pink" /> New Render
            </span>
          }
          header={<span className="text-[10px] uppercase tracking-wider text-slate-500">v2.0</span>}
        >

          {/* Mode */}
          <div>
            <ToggleGroup
              label="Output Mode"
              columns={2}
              gapClassName="gap-2"
              optionClassName="flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold transition"
              activeClassName="bg-gradient-to-r from-brand-500/25 to-accent-pink/15 text-white ring-1 ring-brand-500/40"
              options={[
                { value: 'shorts' as const, label: 'Shorts 9:16', icon: <FileVideo className="h-4 w-4" /> },
                { value: 'longform' as const, label: 'Long 16:9', icon: <Activity className="h-4 w-4" /> },
              ]}
              value={settings.mode}
              onChange={(m) => update('mode', m)}
            />
            <Link
              to="/compilations"
              className="mt-2 flex min-h-14 items-center gap-3 rounded-lg bg-gradient-to-r from-fuchsia-500/20 via-violet-500/15 to-cyan-500/10 px-3 py-2.5 text-left text-white ring-1 ring-fuchsia-400/35 transition hover:ring-fuchsia-300/60"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-fuchsia-500/20 text-fuchsia-200 ring-1 ring-fuchsia-300/25">
                <Clapperboard className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">Short or Long-Form Montage</span>
                <span className="mt-0.5 block text-[10px] leading-4 text-slate-400">Combine short clips or long videos into a vertical 9:16 or horizontal 16:9 edit</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-fuchsia-200" />
            </Link>
          </div>

          {settings.mode === 'shorts' && (
            <div>
              <Select
                label="Export Target"
                value={settings.exportPreset}
                onChange={(e) => {
                  const exportPreset = e.target.value as RenderSettings['exportPreset'];
                  const target = EXPORT_PRESETS.find((item) => item.id === exportPreset);
                  setSettings((current) => ({
                    ...current,
                    exportPreset,
                    maxDuration: target?.defaultMaxDuration || current.maxDuration,
                  }));
                }}
              >
                {EXPORT_PRESETS.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
              </Select>
              <p className="mt-1 text-[11px] text-slate-500">
                {EXPORT_PRESETS.find((item) => item.id === settings.exportPreset)?.detail}
              </p>
            </div>
          )}

          {settings.mode === 'shorts' && (
            <ToggleGroup
              label="Shorts Framing"
              columns={3}
              tone="blue"
              optionClassName="flex min-h-10 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition"
              options={FRAMING_MODES.map((mode) => ({
                value: mode.id,
                label: mode.label,
                icon: mode.id === 'auto' ? <Sparkles className="h-3.5 w-3.5" /> : mode.id === 'smart_switch' ? <Activity className="h-3.5 w-3.5" /> : <FileVideo className="h-3.5 w-3.5" />,
              }))}
              value={settings.framingMode}
              onChange={(id) => update('framingMode', id)}
            />
          )}

          {settings.mode === 'shorts' && (
            <>
              {/* Max Duration */}
              <ToggleGroup
                label="Max Clip Duration"
                columns={4}
                optionClassName="rounded-md px-2 py-1.5 text-xs font-semibold transition"
                options={MAX_DURATIONS.map((d) => ({
                  value: d,
                  label: d >= 60 ? `${d / 60} min` : `${d}s`,
                }))}
                value={settings.maxDuration}
                onChange={(d) => update('maxDuration', d)}
              />

              {/* Clip volume */}
              <div className="space-y-3">
                <div>
                  <ToggleGroup
                    label="Clip Volume"
                    columns={2}
                    tone="pink"
                    options={CLIP_VOLUME_OPTIONS.map((option) => ({
                      value: option.id,
                      label: option.label,
                      description: option.detail,
                    }))}
                    value={settings.clipVolume}
                    onChange={(id) => update('clipVolume', id)}
                  />
                  <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                    Balanced returns a useful review set; More favors coverage over a strict score cutoff.
                  </p>
                </div>

                {settings.clipVolume === 'exact' && (
                  <div>
                    <label className="label" htmlFor="target-clips">Target Clips</label>
                    <input
                      id="target-clips"
                      className="input"
                      type="number"
                      min={1}
                      max={settings.maxClips}
                      value={settings.targetClips}
                      onChange={(e) => update('targetClips', Math.min(settings.maxClips, Math.max(1, Number.parseInt(e.target.value, 10) || 1)))}
                    />
                    <p className="mt-1 text-[10px] text-slate-500">The factory aims for this many distinct clips when enough material is available.</p>
                  </div>
                )}

                <div>
                  <ToggleGroup
                    label="Hard Export Cap"
                    wrap
                    optionClassName="h-8 w-10 rounded-md text-xs font-bold transition"
                    activeClassName="bg-accent-pink/30 text-white ring-1 ring-accent-pink/50"
                    options={MAX_CLIPS.map((n) => ({ value: n, label: n }))}
                    value={settings.maxClips}
                    onChange={(n) => setSettings((current) => ({
                      ...current,
                      maxClips: n,
                      targetClips: Math.min(current.targetClips, n),
                    }))}
                  />
                  <p className="mt-1 text-[10px] text-slate-500">Rendering never exceeds this number, regardless of volume mode.</p>
                </div>
              </div>
            </>
          )}

          {/* Transcription and viral intelligence */}
          <div className="space-y-3 rounded-lg border border-white/5 bg-black/20 p-3">
            <div>
              <Select
                label="Transcription Engine"
                value={settings.transcriptionProvider}
                onChange={(e) => update('transcriptionProvider', e.target.value as RenderSettings['transcriptionProvider'])}
              >
                <option value="auto">Auto · local</option>
                <option value="openai_whisper">PyTorch Whisper · local</option>
                <option value="whisper_cpp">whisper.cpp · local</option>
                <option value="deepgram">Deepgram Nova-3 · cloud</option>
              </Select>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                {settings.transcriptionProvider === 'deepgram'
                  ? 'Cloud option: the source audio is sent to Deepgram.'
                  : 'Runs locally. Auto prefers the best configured local backend.'}
              </p>
            </div>
            {settings.transcriptionProvider !== 'deepgram' && (
              <>
                <div>
                  <ToggleGroup
                    label="Transcription Pass"
                    columns={2}
                    inactiveClassName="bg-white/[0.03] text-slate-400"
                    options={[
                      {
                        value: 'draft' as const,
                        label: 'Draft',
                        description: 'Fast review pass',
                        selectedClassName: 'bg-white/10 text-white ring-1 ring-white/15',
                      },
                      {
                        value: 'final' as const,
                        label: 'Final',
                        description: 'Large-v3 accuracy',
                        selectedClassName: 'bg-emerald-500/10 text-white ring-1 ring-emerald-400/20',
                      },
                    ]}
                    value={settings.transcriptionPreset}
                    onChange={(pass) => setSettings((current) => ({
                      ...current,
                      transcriptionPreset: pass,
                      transcriptionModel: pass === 'final' ? 'large-v3' : 'turbo',
                    }))}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                  <Select
                    label="Speech Model"
                    containerClassName="min-w-0"
                    value={settings.transcriptionModel}
                    onChange={(e) => update('transcriptionModel', e.target.value as RenderSettings['transcriptionModel'])}
                  >
                    {(['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'] as const).map((model) => (
                      <option key={model} value={model}>{model}{model === 'turbo' ? ' · faster large-v3' : ''}</option>
                    ))}
                  </Select>
                  <label className="block min-w-0">
                    <span className="label">Language</span>
                    <input
                      className="input"
                      value={settings.transcriptionLanguage}
                      onChange={(event) => update('transcriptionLanguage', event.target.value.trim().toLowerCase() || 'auto')}
                      placeholder="auto or en"
                    />
                  </label>
                </div>
              </>
            )}
            {settings.mode === 'shorts' && (
              <div className="space-y-2 border-t border-white/5 pt-3">
                <div className="label">Viral Intelligence</div>
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded accent-violet-500"
                    checked={settings.localSemantic}
                    onChange={(e) => update('localSemantic', e.target.checked)}
                  />
                  <span>
                    <span className="block text-xs font-semibold text-slate-200">Local semantic reranking</span>
                    <span className="block text-[10px] leading-relaxed text-slate-500">Uses your configured llama.cpp, Ollama, or LM Studio endpoint; falls back safely when unavailable.</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded accent-pink-500"
                    checked={settings.geminiAnalysis}
                    onChange={(e) => update('geminiAnalysis', e.target.checked)}
                  />
                  <span>
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                      Gemini video analysis
                      <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-sky-300">Cloud</span>
                    </span>
                    <span className="block text-[10px] leading-relaxed text-slate-500">Sends a compact analysis proxy with audio to Gemini for visual and semantic moment scoring.</span>
                  </span>
                </label>
              </div>
            )}
          </div>

          {settings.mode === 'shorts' && (
            <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-emerald-400/15 bg-emerald-500/[0.055] p-3">
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-xs font-semibold text-white"><ListChecks className="h-4 w-4 text-emerald-300" /> Review before rendering</span>
                <span className="mt-1 block text-[10px] leading-relaxed text-slate-500">Analyze once, group alternate lengths by story, then let you approve and trim candidates before full-quality exports.</span>
              </span>
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
                checked={settings.reviewBeforeRender}
                onChange={(event) => update('reviewBeforeRender', event.target.checked)}
              />
            </label>
          )}

          <JobPreflightPanel data={preflight.data} loading={preflight.isLoading} error={preflight.error as Error | null} />

          {/* Caption Style */}
          {settings.mode === 'shorts' && <div>
            <CaptionStylePicker value={settings.subtitleStyle} onChange={(style) => update('subtitleStyle', style)} />
            <p className="mt-1 text-[11px] text-slate-500">Tip: edit any clip’s captions from the Library or Editor.</p>
          </div>}

          {/* Segment */}
          <div>
            <Select
              label="Time Segment"
              value={preset}
              onChange={(e) => setPreset(e.target.value as SegmentPreset)}
            >
              {['Full', 'From Start', 'Middle', 'From End'].map((g) => (
                <optgroup key={g} label={g}>
                  {SEGMENT_PRESETS.filter((p) => p.group === g || (g === 'Full' && p.id === 'full')).map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </optgroup>
              ))}
              <option value="custom">Custom range…</option>
            </Select>
            {preset === 'custom' && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  type="number" min="0" step="1" placeholder="Start (s)"
                  className="input"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                />
                <input
                  type="number" min="0" step="1" placeholder="End (s)"
                  className="input"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                />
              </div>
            )}
          </div>

          {/* Advanced */}
          <div className="space-y-1.5 pt-2">
            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="checkbox"
                className="h-4 w-4 rounded accent-pink-500"
                checked={settings.upscale}
                onChange={(e) => update('upscale', e.target.checked)}
              />
              <div>
                <div className="text-sm text-slate-200 group-hover:text-white">8K Upscaling</div>
                <div className="text-[11px] text-slate-500">Slower, higher quality output</div>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="checkbox"
                className="h-4 w-4 rounded accent-violet-500"
                checked={keepAwake}
                onChange={(e) => setKeepAwake(e.target.checked)}
              />
              <div>
                <div className="text-sm text-slate-200 group-hover:text-white">Keep Screen Awake</div>
                <div className="text-[11px] text-slate-500">Helps phone sleep from interrupting uploads</div>
              </div>
            </label>
          </div>

          {/* Drop Zone */}
          <div
            onDragEnter={(e) => { e.preventDefault(); setDropping(true); }}
            onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
            onDragLeave={() => setDropping(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDropping(false);
              if (!jobReady) return;
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            onClick={() => { if (jobReady) fileInput.current?.click(); }}
            onKeyDown={(e) => {
              if (!jobReady) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInput.current?.click();
              }
            }}
            role="button"
            tabIndex={jobReady ? 0 : -1}
            aria-disabled={!jobReady}
            aria-label="Choose a video to render, or drop one here"
            className={clsx(
              'group rounded-xl border-2 border-dashed p-5 text-center transition',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-panel',
              jobReady ? 'cursor-pointer' : 'cursor-not-allowed opacity-55',
              dropping
                ? 'border-brand-500 bg-brand-500/10'
                : 'border-white/10 hover:border-brand-500/40 hover:bg-white/[0.02]',
            )}
          >
            <input
              ref={fileInput}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.currentTarget.value = '';
              }}
            />
            <Upload className="mx-auto h-8 w-8 text-brand-400 group-hover:scale-110 transition" />
            <p className="mt-2 text-sm font-semibold text-white">Drop one video here</p>
            <p className="text-xs text-slate-500">or click to browse</p>
            <p className="mt-1 text-[10px] text-slate-600">MP4, MOV, MKV, AVI — up to 50GB</p>
          </div>

          <Link
            to="/compilations"
            className="flex min-h-11 items-center gap-2 rounded-xl border border-fuchsia-400/20 bg-fuchsia-500/[0.07] px-3 py-2 text-fuchsia-100 transition hover:border-fuchsia-300/40 hover:bg-fuchsia-500/10"
          >
            <Clapperboard className="h-4 w-4 shrink-0 text-fuchsia-300" />
            <span className="min-w-0 flex-1 text-xs font-semibold">Make a vertical short or horizontal long-form montage</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-fuchsia-300" />
          </Link>

          {/* URL input */}
          <div className="flex min-w-0 gap-2">
            <div className="relative min-w-0 flex-1">
              <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                placeholder="Paste video URL…"
                className="input pl-9"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
              />
            </div>
            <Button
              variant="primary"
              className="shrink-0"
              onClick={handleUrlSubmit}
              disabled={!url || !jobReady || urlMutation.isPending}
              aria-label="Process video URL"
            >
              {urlMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          {urlPlatform && (
            <div className="text-[11px] text-slate-500">Detected: <span className="text-slate-300">{urlPlatform}</span></div>
          )}
          {(launchError || urlMutation.isError) && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{launchError || (urlMutation.error as Error).message}</span>
            </div>
          )}

          {/* Upload progress */}
          {progress.phase !== 'idle' && (
            <UploadProgressPanel progress={progress} />
          )}
        </Panel>

        {/* Live Logs */}
        <section className="panel min-w-0 p-5 xl:col-span-2 flex flex-col">
          <header className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span className="grid h-5 w-5 place-items-center rounded-md bg-emerald-500/15 text-emerald-400">
                <Activity className="h-3 w-3" />
              </span>
              Live Logs
              {job?.active && (
                <span className="ml-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse-soft" />
                  live
                </span>
              )}
            </h2>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                className="text-xs"
                onClick={() => navigator.clipboard.writeText(logs.join('\n'))}
              >
                Copy
              </Button>
            </div>
          </header>
          <div className="flex-1 min-h-[420px] overflow-y-auto rounded-lg border border-white/5 bg-black/40 p-3 font-mono text-[11px] leading-relaxed">
            {logs.length === 0 ? (
              <div className="grid h-full place-items-center text-slate-500 italic">
                Waiting for activity…
              </div>
            ) : (
              <div className="space-y-0.5">
                {logs.map((line, i) => (
                  <div key={i} className={clsx('whitespace-pre-wrap break-words', colorize(line))}>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function JobPreflightPanel({ data, loading, error }: { data?: JobPreflight; loading: boolean; error: Error | null }) {
  if (loading && !data) {
    return <div className="h-20 animate-pulse rounded-xl border border-white/5 bg-white/[0.025]" aria-label="Checking job configuration" />;
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-xs text-red-200">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Preflight could not run: {error.message}</span>
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className={clsx('rounded-xl border px-3 py-3', data.ready ? 'border-emerald-400/15 bg-emerald-500/[0.045]' : 'border-red-500/20 bg-red-500/[0.07]')}>
      <div className="flex items-start gap-2">
        {data.ready ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-white">{data.ready ? 'Job configuration ready' : 'Resolve configuration errors'}</div>
          <div className="mt-1 break-words font-mono text-[10px] leading-relaxed text-slate-500 [overflow-wrap:anywhere]">
            {data.effective.transcriptionProvider || 'unavailable'} · {data.effective.transcriptionModel || 'no model'} · {data.effective.computeDevice} · {data.effective.videoEncoder}
          </div>
        </div>
      </div>
      {(data.warnings.length > 0 || data.errors.length > 0) && (
        <div className="mt-2 space-y-1 border-t border-white/5 pt-2">
          {[...data.errors, ...data.warnings].map((item) => (
            <div key={`${item.code}-${item.message}`} className={clsx('break-words text-[10px] leading-relaxed [overflow-wrap:anywhere]', data.errors.includes(item) ? 'text-red-200' : 'text-amber-200/80')}>
              {item.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UploadProgressPanel({ progress }: { progress: ReturnType<typeof useResumableUpload>['progress'] }) {
  const pct = progress.totalBytes > 0 ? Math.round((progress.uploadedBytes / progress.totalBytes) * 100) : 0;
  const remaining = progress.bytesPerSecond > 0
    ? Math.max(0, (progress.totalBytes - progress.uploadedBytes) / progress.bytesPerSecond)
    : 0;
  return (
    <div className="rounded-lg border border-white/5 bg-black/30 p-3 animate-fade-in">
      <div className="flex items-center justify-between text-[11px]">
        <div className="flex items-center gap-1.5 font-semibold text-slate-200">
          {progress.phase === 'error' ? <AlertCircle className="h-3 w-3 text-red-400" /> :
           progress.phase === 'done' ? <CheckCircle2 className="h-3 w-3 text-emerald-400" /> :
           <Loader2 className="h-3 w-3 animate-spin text-brand-400" />}
          {progress.message}
        </div>
        <div className="font-mono text-slate-300">{pct}%</div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full bg-gradient-to-r from-accent-pink to-brand-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500">
        <span>{formatSize(progress.uploadedBytes)} / {formatSize(progress.totalBytes)}</span>
        {progress.bytesPerSecond > 0 && progress.uploadedBytes < progress.totalBytes && (
          <span>{formatSize(progress.bytesPerSecond)}/s · {Math.ceil(remaining)}s left</span>
        )}
      </div>
    </div>
  );
}

function colorize(line: string): string {
  if (line.includes('❌') || line.includes('Error') || line.includes('⚠️')) return 'text-red-400';
  if (line.includes('✅')) return 'text-emerald-400';
  if (line.includes('🎬') || line.includes('📊')) return 'text-blue-400';
  if (line.includes('🚀') || line.includes('🔥')) return 'text-violet-400';
  return 'text-slate-300';
}
