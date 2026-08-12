import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Camera,
  Check,
  Copy,
  Film,
  Layers3,
  Link2,
  Loader2,
  Plus,
  RefreshCcw,
  Save,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Type,
  Upload,
  Volume2,
  WandSparkles,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import {
  api,
  type LongformAssistantSuggestion,
  type LongformChapter,
  type LongformCreativeOptions,
  type LongformCut,
  type LongformEditPoint,
  type LongformMediaAsset,
  type LongformOptions,
  type LongformProxyState,
} from '@/api/client';

type UploadKind = 'broll' | 'music' | 'angle' | 'lut';
export type ToolTab = 'edit' | 'audio' | 'captions' | 'color' | 'multicam' | 'project' | 'assistant';

interface ToolWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: string | number;
}

interface ProfessionalEditorToolsProps {
  projectName: string;
  creative: LongformCreativeOptions;
  assets: LongformMediaAsset[];
  words: ToolWord[];
  options: LongformOptions;
  cuts: LongformCut[];
  chapters: LongformChapter[];
  playhead: number;
  min: number;
  max: number;
  videoRef: RefObject<HTMLVideoElement>;
  proxy: LongformProxyState;
  uploading: boolean;
  proxyBusy: boolean;
  onCreativeChange: (patch: Partial<LongformCreativeOptions>) => void;
  onOptionsChange: (patch: Partial<LongformOptions>) => void;
  onUpload: (kind: UploadKind, file: File) => void;
  onSeek: (seconds: number) => void;
  onAddCut: (start: number, end: number) => boolean;
  onUpdateCut: (id: string, start: number, end: number) => boolean;
  onAddChapter: (time: number, title?: string) => void;
  onAddEditPoint: (time?: number) => void;
  onUpdateEditPoint: (id: string, patch: Partial<Pick<LongformEditPoint, 'time' | 'label'>>) => void;
  onDeleteEditPoint: (id: string) => void;
  onProxyAction: (action: 'build' | 'delete') => void;
  onReload: () => Promise<void>;
  activeTab?: ToolTab;
  onTabChange?: (tab: ToolTab) => void;
  embedded?: boolean;
  showTabs?: boolean;
}

const TABS: Array<{ id: ToolTab; label: string; icon: typeof Scissors }> = [
  { id: 'edit', label: 'Edit & Motion', icon: Scissors },
  { id: 'audio', label: 'Audio Mixer', icon: Volume2 },
  { id: 'captions', label: 'Captions', icon: Type },
  { id: 'color', label: 'Color & FX', icon: SlidersHorizontal },
  { id: 'multicam', label: 'Multicam', icon: Camera },
  { id: 'project', label: 'Project Safety', icon: ShieldCheck },
  { id: 'assistant', label: 'Assistant', icon: WandSparkles },
];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function formatTime(value: number) {
  const total = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The operation failed.';
}

function generateCaptionCues(words: ToolWord[]) {
  const cues: LongformCreativeOptions['captions']['cues'] = [];
  let group: ToolWord[] = [];
  const flush = () => {
    if (!group.length) return;
    const first = group[0];
    const last = group[group.length - 1];
    const speakers = [...new Set(group.map((word) => word.speaker).filter((speaker) => speaker !== undefined && speaker !== null))];
    cues.push({
      id: `caption-${Date.now()}-${cues.length}`,
      start: first.start,
      end: Math.max(first.start + 0.3, last.end),
      text: group.map((word) => word.word).join(' ').trim(),
      speaker: speakers.length === 1 ? String(speakers[0]) : '',
      lowConfidence: group.some((word) => typeof word.confidence === 'number' && word.confidence < 0.68),
    });
    group = [];
  };
  words.forEach((word) => {
    group.push(word);
    const duration = group[group.length - 1].end - group[0].start;
    if (group.length >= 10 || duration >= 4 || /[.!?]["']?$/.test(word.word.trim())) flush();
  });
  flush();
  return cues;
}

function buildSpeakerCuts(
  words: ToolWord[],
  creative: LongformCreativeOptions,
  min: number,
  max: number,
) {
  const angleBySpeaker = new Map(
    creative.multicam.angles
      .filter((angle) => angle.speaker.trim())
      .map((angle) => [angle.speaker.trim(), angle]),
  );
  const cuts: LongformCreativeOptions['multicam']['cuts'] = [];
  let current: { speaker: string; start: number; end: number } | null = null;
  for (const word of words) {
    const speaker = word.speaker === undefined || word.speaker === null ? '' : String(word.speaker);
    if (!angleBySpeaker.has(speaker) || word.end < min || word.start > max) {
      if (current) {
        if (current.end - current.start >= 0.35) {
          const angle = angleBySpeaker.get(current.speaker);
          if (angle) cuts.push({
            id: `multicam-${Date.now()}-${cuts.length}`,
            angleId: angle.id,
            start: clamp(current.start, min, max),
            end: clamp(current.end, min, max),
            useAudio: false,
          });
        }
        current = null;
      }
      continue;
    }
    if (current && current.speaker === speaker && word.start - current.end < 1.2) {
      current.end = word.end;
      continue;
    }
    if (current && current.end - current.start >= 0.35) {
      const angle = angleBySpeaker.get(current.speaker);
      if (angle) cuts.push({
        id: `multicam-${Date.now()}-${cuts.length}`,
        angleId: angle.id,
        start: clamp(current.start, min, max),
        end: clamp(current.end, min, max),
        useAudio: false,
      });
    }
    current = { speaker, start: word.start, end: word.end };
  }
  if (current && current.end - current.start >= 0.35) {
    const angle = angleBySpeaker.get(current.speaker);
    if (angle) cuts.push({
      id: `multicam-${Date.now()}-${cuts.length}`,
      angleId: angle.id,
      start: clamp(current.start, min, max),
      end: clamp(current.end, min, max),
      useAudio: false,
    });
  }
  return cuts.slice(0, 2000);
}

export function ProfessionalEditorTools(props: ProfessionalEditorToolsProps) {
  const {
    projectName,
    creative,
    assets,
    words,
    options,
    cuts,
    chapters,
    playhead,
    min,
    max,
    videoRef,
    proxy,
    uploading,
    proxyBusy,
    onCreativeChange,
    onOptionsChange,
    onUpload,
    onSeek,
    onAddCut,
    onUpdateCut,
    onAddChapter,
    onAddEditPoint,
    onUpdateEditPoint,
    onDeleteEditPoint,
    onProxyAction,
    onReload,
    activeTab,
    onTabChange,
    embedded = false,
    showTabs = true,
  } = props;
  const qc = useQueryClient();
  const [internalTab, setInternalTab] = useState<ToolTab>('edit');
  const tab = activeTab ?? internalTab;
  const setTab = (nextTab: ToolTab) => {
    if (activeTab === undefined) setInternalTab(nextTab);
    onTabChange?.(nextTab);
  };
  const [selectedBrollId, setSelectedBrollId] = useState<string>('');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [presetName, setPresetName] = useState('');
  const [snapshotName, setSnapshotName] = useState('');
  const [duplicateName, setDuplicateName] = useState('');
  const [duplicateResult, setDuplicateResult] = useState<string | null>(null);
  const [assistantSuggestions, setAssistantSuggestions] = useState<LongformAssistantSuggestion[]>([]);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (creative.broll.some((item) => item.id === selectedBrollId)) return;
    const active = creative.broll.find((item) => playhead >= item.start && playhead <= item.end);
    setSelectedBrollId(active?.id || creative.broll[0]?.id || '');
  }, [creative.broll, playhead, selectedBrollId]);

  const snapshotsQuery = useQuery({
    queryKey: ['longform-snapshots', projectName],
    queryFn: () => api.listLongformSnapshots(projectName),
  });
  const presetsQuery = useQuery({
    queryKey: ['longform-presets'],
    queryFn: api.listLongformPresets,
  });
  const queueQuery = useQuery({
    queryKey: ['longform-render-queue'],
    queryFn: api.listLongformRenderQueue,
    refetchInterval: 3000,
  });
  const snapshotMutation = useMutation({
    mutationFn: () => api.createLongformSnapshot(projectName, snapshotName || undefined),
    onSuccess: () => {
      setSnapshotName('');
      qc.invalidateQueries({ queryKey: ['longform-snapshots', projectName] });
    },
  });
  const restoreMutation = useMutation({
    mutationFn: (snapshotId: string) => api.restoreLongformSnapshot(projectName, snapshotId),
    onSuccess: async () => {
      await onReload();
      qc.invalidateQueries({ queryKey: ['longform-snapshots', projectName] });
    },
  });
  const duplicateMutation = useMutation({
    mutationFn: () => api.duplicateLongformProject(projectName, duplicateName || undefined),
    onSuccess: (result) => {
      setDuplicateResult(result.name);
      setDuplicateName('');
      qc.invalidateQueries({ queryKey: ['clips'] });
    },
  });
  const relinkMutation = useMutation({
    mutationFn: (file: File) => api.relinkLongformSource(projectName, file),
    onSuccess: onReload,
  });
  const savePresetMutation = useMutation({
    mutationFn: () => api.createLongformPreset(presetName, creative),
    onSuccess: () => {
      setPresetName('');
      qc.invalidateQueries({ queryKey: ['longform-presets'] });
    },
  });
  const deletePresetMutation = useMutation({
    mutationFn: (id: string) => api.deleteLongformPreset(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['longform-presets'] }),
  });
  const assistantMutation = useMutation({
    mutationFn: () => api.getLongformAssistantSuggestions(projectName, { options, cuts, creative }),
    onSuccess: (result) => {
      setAssistantSuggestions(result.suggestions);
      setDismissedSuggestions(new Set());
    },
  });

  const selectedBroll = creative.broll.find((item) => item.id === selectedBrollId) || null;
  const nearestCut = useMemo(() => cuts.reduce<LongformCut | null>((nearest, cut) => {
    if (!cut.enabled) return nearest;
    const distance = Math.min(Math.abs(playhead - cut.start), Math.abs(playhead - cut.end));
    if (!nearest) return cut;
    const nearestDistance = Math.min(Math.abs(playhead - nearest.start), Math.abs(playhead - nearest.end));
    return distance < nearestDistance ? cut : nearest;
  }, null), [cuts, playhead]);

  const patchBroll = (id: string, patch: Partial<LongformCreativeOptions['broll'][number]>) => {
    onCreativeChange({
      broll: creative.broll.map((item) => item.id === id ? { ...item, ...patch } : item),
    });
  };
  const addSnappedEditPoint = () => {
    if (!snapEnabled || !words.length) {
      onAddEditPoint(playhead);
      return;
    }
    const boundaries = words.flatMap((word) => [word.start, word.end]);
    const nearest = boundaries.reduce((best, value) => (
      Math.abs(value - playhead) < Math.abs(best - playhead) ? value : best
    ), boundaries[0]);
    onAddEditPoint(Math.abs(nearest - playhead) <= 0.2 ? nearest : playhead);
  };
  const shiftCut = (delta: number) => {
    if (!nearestCut) return;
    const duration = nearestCut.end - nearestCut.start;
    const start = clamp(nearestCut.start + delta, min, max - duration);
    onUpdateCut(nearestCut.id, start, start + duration);
  };
  const rippleCut = (edge: 'start' | 'end', delta: number) => {
    if (!nearestCut) return;
    const start = edge === 'start'
      ? clamp(nearestCut.start + delta, min, nearestCut.end - 0.02)
      : nearestCut.start;
    const end = edge === 'end'
      ? clamp(nearestCut.end + delta, nearestCut.start + 0.02, max)
      : nearestCut.end;
    onUpdateCut(nearestCut.id, start, end);
  };
  const shiftBrollPlacement = (delta: number) => {
    if (!selectedBroll) return;
    const duration = selectedBroll.end - selectedBroll.start;
    const start = clamp(selectedBroll.start + delta, min, max - duration);
    patchBroll(selectedBroll.id, { start, end: start + duration });
  };
  const addMotionKeyframe = () => {
    if (!selectedBroll || playhead < selectedBroll.start || playhead > selectedBroll.end) return;
    const existing = selectedBroll.keyframes.find((keyframe) => Math.abs(keyframe.time - playhead) < 0.04);
    const keyframe = {
      id: existing?.id || `keyframe-${Date.now()}`,
      time: playhead,
      x: selectedBroll.x,
      y: selectedBroll.y,
      scale: selectedBroll.scale,
      rotation: selectedBroll.rotation,
      opacity: selectedBroll.opacity,
    };
    patchBroll(selectedBroll.id, {
      keyframes: existing
        ? selectedBroll.keyframes.map((item) => item.id === existing.id ? keyframe : item)
        : [...selectedBroll.keyframes, keyframe].sort((left, right) => left.time - right.time),
    });
  };
  const applyPreset = (presetCreative: LongformCreativeOptions) => {
    onCreativeChange({
      exportPreset: presetCreative.exportPreset,
      color: { ...creative.color, ...presetCreative.color },
      audio: { ...creative.audio, ...presetCreative.audio, keyframes: creative.audio.keyframes },
      captions: {
        ...creative.captions,
        fontSize: presetCreative.captions.fontSize,
        position: presetCreative.captions.position,
        textColor: presetCreative.captions.textColor,
        backgroundColor: presetCreative.captions.backgroundColor,
        highlightColor: presetCreative.captions.highlightColor,
      },
      musicVolume: presetCreative.musicVolume,
      musicDucking: presetCreative.musicDucking,
    });
  };
  const createSpeakerPass = () => {
    const speakerCuts = buildSpeakerCuts(words, creative, min, max);
    onCreativeChange({ multicam: { ...creative.multicam, cuts: speakerCuts } });
  };
  const acceptSuggestion = (suggestion: LongformAssistantSuggestion) => {
    const payload = suggestion.payload;
    if (suggestion.kind === 'cut') {
      const start = Number(payload.start);
      const end = Number(payload.end);
      if (Number.isFinite(start) && Number.isFinite(end)) onAddCut(start, end);
    } else if (suggestion.kind === 'chapter') {
      const time = Number(payload.time);
      if (Number.isFinite(time)) onAddChapter(time, String(payload.title || suggestion.title));
    } else if (suggestion.kind === 'caption') {
      const start = Number(payload.start);
      if (Number.isFinite(start)) onSeek(start);
      setTab('captions');
    } else if (suggestion.kind === 'audio') {
      onOptionsChange({ normalizeAudio: true, targetLufs: -14, limiterDb: -1.5 });
      onCreativeChange({
        audio: { ...creative.audio, compressor: true, deEsser: true },
      });
      setTab('audio');
    } else if (suggestion.kind === 'multicam') {
      createSpeakerPass();
      setTab('multicam');
    } else if (suggestion.kind === 'broll') {
      const time = Number(payload.time);
      if (Number.isFinite(time)) onSeek(time);
      setTab('edit');
    }
    setDismissedSuggestions((current) => new Set(current).add(suggestion.id));
  };

  const operationError = snapshotMutation.error
    || restoreMutation.error
    || duplicateMutation.error
    || relinkMutation.error
    || savePresetMutation.error
    || deletePresetMutation.error
    || assistantMutation.error;

  return (
    <div className={clsx(embedded ? 'min-w-0 overflow-hidden bg-[#151515]' : 'panel-elev overflow-hidden')}>
      {showTabs && <div className="border-b border-white/5 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <Layers3 className="h-4 w-4 text-emerald-300" /> Professional tool suite
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Frame-level editing, motion, audio, captions, scopes, multicam, versioning, and reviewable assistance.
            </p>
          </div>
          <span className="chip">Playhead {formatTime(playhead)}</span>
        </div>
        <div className="mt-4 flex gap-1 overflow-x-auto pb-1 scrollbar-thin">
          {TABS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={clsx(
                  'flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[10px] font-semibold transition',
                  tab === item.id ? 'bg-emerald-500/15 text-emerald-100 ring-1 ring-inset ring-emerald-400/20' : 'text-slate-500 hover:bg-white/5 hover:text-slate-300',
                )}
                onClick={() => setTab(item.id)}
              >
                <Icon className="h-3.5 w-3.5" /> {item.label}
              </button>
            );
          })}
        </div>
      </div>}

      {tab === 'edit' && (
        <EditAndMotionTools
          creative={creative}
          assets={assets}
          playhead={playhead}
          min={min}
          max={max}
          nearestCut={nearestCut}
          selectedBroll={selectedBroll}
          selectedBrollId={selectedBrollId}
          snapEnabled={snapEnabled}
          onSnapChange={setSnapEnabled}
          onSelectBroll={setSelectedBrollId}
          onAddEditPoint={addSnappedEditPoint}
          onUpdateEditPoint={onUpdateEditPoint}
          onDeleteEditPoint={onDeleteEditPoint}
          onSeek={onSeek}
          onRipple={rippleCut}
          onRoll={shiftCut}
          onSlip={(delta) => selectedBroll && patchBroll(selectedBroll.id, { sourceOffset: Math.max(0, selectedBroll.sourceOffset + delta) })}
          onSlide={shiftBrollPlacement}
          onPatchBroll={patchBroll}
          onAddKeyframe={addMotionKeyframe}
        />
      )}
      {tab === 'audio' && (
        <AudioMixerTools
          creative={creative}
          options={options}
          playhead={playhead}
          min={min}
          max={max}
          videoRef={videoRef}
          onCreativeChange={onCreativeChange}
          onOptionsChange={onOptionsChange}
        />
      )}
      {tab === 'captions' && (
        <CaptionTools
          creative={creative}
          words={words}
          min={min}
          max={max}
          onSeek={onSeek}
          onCreativeChange={onCreativeChange}
        />
      )}
      {tab === 'color' && (
        <ColorAndEffectsTools
          creative={creative}
          assets={assets}
          playhead={playhead}
          min={min}
          max={max}
          videoRef={videoRef}
          uploading={uploading}
          onUpload={onUpload}
          onCreativeChange={onCreativeChange}
          onSeek={onSeek}
        />
      )}
      {tab === 'multicam' && (
        <MulticamTools
          creative={creative}
          assets={assets}
          words={words}
          playhead={playhead}
          min={min}
          max={max}
          uploading={uploading}
          onUpload={onUpload}
          onCreativeChange={onCreativeChange}
          onSeek={onSeek}
          onCreateSpeakerPass={createSpeakerPass}
        />
      )}
      {tab === 'project' && (
        <ProjectSafetyTools
          projectName={projectName}
          proxy={proxy}
          proxyBusy={proxyBusy}
          snapshots={snapshotsQuery.data || []}
          presets={presetsQuery.data || []}
          queue={queueQuery.data || []}
          snapshotName={snapshotName}
          presetName={presetName}
          duplicateName={duplicateName}
          duplicateResult={duplicateResult}
          busy={snapshotMutation.isPending || restoreMutation.isPending || duplicateMutation.isPending || relinkMutation.isPending || savePresetMutation.isPending || deletePresetMutation.isPending}
          onSnapshotName={setSnapshotName}
          onPresetName={setPresetName}
          onDuplicateName={setDuplicateName}
          onCreateSnapshot={() => snapshotMutation.mutate()}
          onRestoreSnapshot={(id) => {
            if (window.confirm('Restore this snapshot? A safety snapshot of the current draft will be created first.')) restoreMutation.mutate(id);
          }}
          onDuplicate={() => duplicateMutation.mutate()}
          onRelink={(file) => relinkMutation.mutate(file)}
          onProxyAction={onProxyAction}
          onSavePreset={() => savePresetMutation.mutate()}
          onApplyPreset={applyPreset}
          onDeletePreset={(id) => deletePresetMutation.mutate(id)}
        />
      )}
      {tab === 'assistant' && (
        <AssistantTools
          suggestions={assistantSuggestions.filter((item) => !dismissedSuggestions.has(item.id))}
          scanning={assistantMutation.isPending}
          onScan={() => assistantMutation.mutate()}
          onAccept={acceptSuggestion}
          onDismiss={(id) => setDismissedSuggestions((current) => new Set(current).add(id))}
        />
      )}
      {operationError && (
        <div className="border-t border-red-500/20 bg-red-500/10 px-5 py-3 text-xs text-red-200">
          {errorMessage(operationError)}
        </div>
      )}
    </div>
  );
}

function EditAndMotionTools({
  creative,
  assets,
  playhead,
  min,
  max,
  nearestCut,
  selectedBroll,
  selectedBrollId,
  snapEnabled,
  onSnapChange,
  onSelectBroll,
  onAddEditPoint,
  onUpdateEditPoint,
  onDeleteEditPoint,
  onSeek,
  onRipple,
  onRoll,
  onSlip,
  onSlide,
  onPatchBroll,
  onAddKeyframe,
}: {
  creative: LongformCreativeOptions;
  assets: LongformMediaAsset[];
  playhead: number;
  min: number;
  max: number;
  nearestCut: LongformCut | null;
  selectedBroll: LongformCreativeOptions['broll'][number] | null;
  selectedBrollId: string;
  snapEnabled: boolean;
  onSnapChange: (value: boolean) => void;
  onSelectBroll: (id: string) => void;
  onAddEditPoint: () => void;
  onUpdateEditPoint: ProfessionalEditorToolsProps['onUpdateEditPoint'];
  onDeleteEditPoint: (id: string) => void;
  onSeek: (time: number) => void;
  onRipple: (edge: 'start' | 'end', delta: number) => void;
  onRoll: (delta: number) => void;
  onSlip: (delta: number) => void;
  onSlide: (delta: number) => void;
  onPatchBroll: (id: string, patch: Partial<LongformCreativeOptions['broll'][number]>) => void;
  onAddKeyframe: () => void;
}) {
  const brollAssets = new Map(assets.filter((asset) => asset.kind === 'broll').map((asset) => [asset.id, asset]));
  return (
    <div className="grid divide-y divide-white/5 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
      <section className="space-y-5 p-4 sm:p-5">
        <div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-slate-200">Blade and trim tools</div>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                Blade creates a true join without removing time. Ripple changes duration; roll moves a removed range while preserving its length.
              </p>
            </div>
            <label className="flex items-center gap-2 text-[10px] text-slate-400">
              <input type="checkbox" checked={snapEnabled} onChange={(event) => onSnapChange(event.target.checked)} className="accent-emerald-500" />
              Snap to words
            </label>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button className="btn-primary h-9 text-xs" onClick={onAddEditPoint}>
              <Scissors className="h-3.5 w-3.5" /> Blade at {formatTime(playhead)}
            </button>
            <div className="grid grid-cols-2 gap-1">
              <button className="btn-secondary h-9 px-2 text-[10px]" disabled={!nearestCut} onClick={() => onRoll(-1 / 30)}>Roll −1f</button>
              <button className="btn-secondary h-9 px-2 text-[10px]" disabled={!nearestCut} onClick={() => onRoll(1 / 30)}>Roll +1f</button>
            </div>
            <button className="btn-secondary h-9 px-2 text-[10px]" disabled={!nearestCut} onClick={() => onRipple('start', 1 / 30)}>Ripple start +1f</button>
            <button className="btn-secondary h-9 px-2 text-[10px]" disabled={!nearestCut} onClick={() => onRipple('end', -1 / 30)}>Ripple end −1f</button>
          </div>
          {nearestCut && (
            <div className="mt-2 rounded-lg bg-black/20 px-3 py-2 font-mono text-[10px] text-slate-500">
              Nearest removal: {nearestCut.start.toFixed(3)}s–{nearestCut.end.toFixed(3)}s
            </div>
          )}
        </div>

        <div className="border-t border-white/5 pt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200">Edit points</span>
            <span className="chip">{creative.editPoints.length}</span>
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
            {creative.editPoints.map((point) => (
              <div key={point.id} className="grid grid-cols-[minmax(0,1fr)_90px_auto] gap-2 rounded-lg bg-black/20 p-2">
                <input className="input h-8 text-xs" value={point.label} onChange={(event) => onUpdateEditPoint(point.id, { label: event.target.value })} />
                <input className="input h-8 px-2 font-mono text-[10px]" type="number" min={min} max={max} step={1 / 30} value={point.time} onChange={(event) => onUpdateEditPoint(point.id, { time: Number(event.target.value) })} />
                <div className="flex">
                  <button className="grid h-8 w-8 place-items-center text-slate-500 hover:text-white" onClick={() => onSeek(point.time)} aria-label="Seek to edit point"><Film className="h-3.5 w-3.5" /></button>
                  <button className="grid h-8 w-8 place-items-center text-slate-600 hover:text-red-300" onClick={() => onDeleteEditPoint(point.id)} aria-label="Delete edit point"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
            {!creative.editPoints.length && <EmptyNote>Press B or use Blade to split program video without deleting a frame.</EmptyNote>}
          </div>
        </div>
      </section>

      <section className="space-y-4 p-4 sm:p-5">
        <div>
          <div className="text-xs font-semibold text-slate-200">Transform inspector and keyframes</div>
          <p className="mt-1 text-[10px] text-slate-600">Animate B-roll position, scale, and rotation; slip changes source content while slide changes timeline placement.</p>
        </div>
        <select className="input h-9 text-xs" value={selectedBrollId} onChange={(event) => onSelectBroll(event.target.value)}>
          <option value="">Select B-roll</option>
          {creative.broll.map((item, index) => <option key={item.id} value={item.id}>{brollAssets.get(item.assetId)?.name || `B-roll ${index + 1}`}</option>)}
        </select>
        {selectedBroll ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MiniNumber label="X" value={selectedBroll.x} min={-1} max={1} step={0.01} onChange={(x) => onPatchBroll(selectedBroll.id, { x })} />
              <MiniNumber label="Y" value={selectedBroll.y} min={-1} max={1} step={0.01} onChange={(y) => onPatchBroll(selectedBroll.id, { y })} />
              <MiniNumber label="Scale" value={selectedBroll.scale} min={0.1} max={4} step={0.05} onChange={(scale) => onPatchBroll(selectedBroll.id, { scale })} />
              <MiniNumber label="Rotation" value={selectedBroll.rotation} min={-360} max={360} step={1} onChange={(rotation) => onPatchBroll(selectedBroll.id, { rotation })} />
              <MiniNumber label="Opacity" value={selectedBroll.opacity} min={0} max={1} step={0.05} onChange={(opacity) => onPatchBroll(selectedBroll.id, { opacity })} />
              <MiniNumber label="Source offset" value={selectedBroll.sourceOffset} min={0} max={86400} step={0.1} onChange={(sourceOffset) => onPatchBroll(selectedBroll.id, { sourceOffset })} />
              <label className="col-span-2">
                <span className="label">Layout</span>
                <select className="input h-9 text-xs" value={selectedBroll.layout} onChange={(event) => onPatchBroll(selectedBroll.id, { layout: event.target.value as typeof selectedBroll.layout })}>
                  <option value="cover">Full-frame cover</option>
                  <option value="contain">Contain with matte</option>
                  <option value="pip">Picture in picture</option>
                </select>
              </label>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <MiniNumber label="Crop L" value={selectedBroll.cropLeft} min={0} max={0.45} step={0.01} onChange={(cropLeft) => onPatchBroll(selectedBroll.id, { cropLeft })} />
              <MiniNumber label="Crop T" value={selectedBroll.cropTop} min={0} max={0.45} step={0.01} onChange={(cropTop) => onPatchBroll(selectedBroll.id, { cropTop })} />
              <MiniNumber label="Crop R" value={selectedBroll.cropRight} min={0} max={0.45} step={0.01} onChange={(cropRight) => onPatchBroll(selectedBroll.id, { cropRight })} />
              <MiniNumber label="Crop B" value={selectedBroll.cropBottom} min={0} max={0.45} step={0.01} onChange={(cropBottom) => onPatchBroll(selectedBroll.id, { cropBottom })} />
            </div>
            <div className="grid grid-cols-4 gap-1">
              <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => onSlip(-0.25)}>Slip −.25s</button>
              <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => onSlip(0.25)}>Slip +.25s</button>
              <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => onSlide(-0.25)}>Slide −.25s</button>
              <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => onSlide(0.25)}>Slide +.25s</button>
            </div>
            <div className="border-t border-white/5 pt-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-semibold text-slate-300">Motion keyframes</span>
                <button className="btn-secondary h-8 px-2 text-[10px]" disabled={playhead < selectedBroll.start || playhead > selectedBroll.end} onClick={onAddKeyframe}>
                  <Plus className="h-3 w-3" /> Add at playhead
                </button>
              </div>
              <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto scrollbar-thin">
                {selectedBroll.keyframes.map((keyframe) => (
                  <div key={keyframe.id} className="grid grid-cols-[75px_repeat(4,minmax(0,1fr))_auto] gap-1 rounded-lg bg-black/20 p-1.5">
                    <input className="input h-8 px-1 font-mono text-[10px]" type="number" min={selectedBroll.start} max={selectedBroll.end} step={1 / 30} value={keyframe.time} onChange={(event) => onPatchBroll(selectedBroll.id, { keyframes: selectedBroll.keyframes.map((item) => item.id === keyframe.id ? { ...item, time: Number(event.target.value) } : item) })} aria-label="Keyframe time" />
                    {(['x', 'y', 'scale', 'rotation'] as const).map((field) => (
                      <input key={field} className="input h-8 px-1 font-mono text-[10px]" type="number" step={field === 'rotation' ? 1 : 0.01} value={keyframe[field]} onChange={(event) => onPatchBroll(selectedBroll.id, { keyframes: selectedBroll.keyframes.map((item) => item.id === keyframe.id ? { ...item, [field]: Number(event.target.value) } : item) })} aria-label={`Keyframe ${field}`} />
                    ))}
                    <button className="grid h-8 w-8 place-items-center text-slate-600 hover:text-red-300" onClick={() => onPatchBroll(selectedBroll.id, { keyframes: selectedBroll.keyframes.filter((item) => item.id !== keyframe.id) })} aria-label="Delete keyframe"><Trash2 className="h-3 w-3" /></button>
                  </div>
                ))}
                {!selectedBroll.keyframes.length && <EmptyNote>No keyframes. Static transform values still render.</EmptyNote>}
              </div>
            </div>
          </>
        ) : <EmptyNote>Add or select a B-roll clip to reveal transform controls.</EmptyNote>}
      </section>
    </div>
  );
}

function AudioMixerTools({
  creative,
  options,
  playhead,
  min,
  max,
  videoRef,
  onCreativeChange,
  onOptionsChange,
}: {
  creative: LongformCreativeOptions;
  options: LongformOptions;
  playhead: number;
  min: number;
  max: number;
  videoRef: RefObject<HTMLVideoElement>;
  onCreativeChange: ProfessionalEditorToolsProps['onCreativeChange'];
  onOptionsChange: ProfessionalEditorToolsProps['onOptionsChange'];
}) {
  const audio = creative.audio;
  const patchAudio = (patch: Partial<typeof audio>) => onCreativeChange({ audio: { ...audio, ...patch } });
  const levels = useAudioLevels(videoRef);
  const addAutomation = () => {
    const existing = audio.keyframes.find((keyframe) => Math.abs(keyframe.time - playhead) < 0.04);
    const keyframe = { id: existing?.id || `audio-keyframe-${Date.now()}`, time: playhead, gainDb: existing?.gainDb || 0 };
    patchAudio({
      keyframes: existing
        ? audio.keyframes.map((item) => item.id === existing.id ? keyframe : item)
        : [...audio.keyframes, keyframe].sort((left, right) => left.time - right.time),
    });
  };
  return (
    <div className="grid divide-y divide-white/5 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)] xl:divide-x xl:divide-y-0">
      <section className="p-4 sm:p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-slate-200">Dialogue channel</div>
            <p className="mt-1 text-[10px] text-slate-600">Gain staging, pan, three-band EQ, dynamics, restoration, and keyframed volume automation.</p>
          </div>
          <div className="flex h-12 items-end gap-1 rounded bg-black/30 p-1.5 ring-1 ring-inset ring-white/5">
            <Meter value={levels.left} />
            <Meter value={levels.right} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <ToolRange label="Dialogue gain" value={audio.dialogueGainDb} min={-60} max={18} step={0.5} suffix=" dB" onChange={(dialogueGainDb) => patchAudio({ dialogueGainDb })} />
          <ToolRange label="Pan" value={audio.pan} min={-1} max={1} step={0.05} onChange={(pan) => patchAudio({ pan })} />
          <ToolRange label="Low EQ" value={audio.eqLowDb} min={-18} max={18} step={0.5} suffix=" dB" onChange={(eqLowDb) => patchAudio({ eqLowDb })} />
          <ToolRange label="Mid EQ" value={audio.eqMidDb} min={-18} max={18} step={0.5} suffix=" dB" onChange={(eqMidDb) => patchAudio({ eqMidDb })} />
          <ToolRange label="High EQ" value={audio.eqHighDb} min={-18} max={18} step={0.5} suffix=" dB" onChange={(eqHighDb) => patchAudio({ eqHighDb })} />
          <ToolRange label="Master gain" value={audio.masterGainDb} min={-60} max={18} step={0.5} suffix=" dB" onChange={(masterGainDb) => patchAudio({ masterGainDb })} />
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Toggle label="Compressor" checked={audio.compressor} onChange={(compressor) => patchAudio({ compressor })} />
          <Toggle label="De-esser" checked={audio.deEsser} onChange={(deEsser) => patchAudio({ deEsser })} />
          <Toggle label="Noise gate" checked={audio.noiseGate} onChange={(noiseGate) => patchAudio({ noiseGate })} />
          <Toggle label="Mute dialogue" checked={audio.dialogueMuted} onChange={(dialogueMuted) => patchAudio({ dialogueMuted })} />
        </div>
        <div className="mt-4 rounded-xl bg-black/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[11px] font-semibold text-slate-300">Volume automation</div>
              <div className="text-[10px] text-slate-600">Interpolated gain keyframes render against the edited timeline.</div>
            </div>
            <button className="btn-secondary h-8 px-2 text-[10px]" onClick={addAutomation}><Plus className="h-3 w-3" /> Keyframe at {formatTime(playhead)}</button>
          </div>
          <div className="mt-2 space-y-1.5">
            {audio.keyframes.map((keyframe) => (
              <div key={keyframe.id} className="grid grid-cols-[100px_minmax(0,1fr)_auto] gap-2">
                <input className="input h-8 font-mono text-[10px]" type="number" min={min} max={max} step={1 / 30} value={keyframe.time} onChange={(event) => patchAudio({ keyframes: audio.keyframes.map((item) => item.id === keyframe.id ? { ...item, time: Number(event.target.value) } : item) })} />
                <input className="w-full accent-emerald-500" type="range" min={-60} max={18} step={0.5} value={keyframe.gainDb} onChange={(event) => patchAudio({ keyframes: audio.keyframes.map((item) => item.id === keyframe.id ? { ...item, gainDb: Number(event.target.value) } : item) })} />
                <button className="grid h-8 w-8 place-items-center text-slate-600 hover:text-red-300" onClick={() => patchAudio({ keyframes: audio.keyframes.filter((item) => item.id !== keyframe.id) })}><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="space-y-5 p-4 sm:p-5">
        <div>
          <div className="text-xs font-semibold text-slate-200">Master and delivery</div>
          <div className="mt-3 space-y-2">
            <Toggle label="Loudness normalization" detail={`${options.targetLufs.toFixed(1)} LUFS · ${options.limiterDb.toFixed(1)} dBTP ceiling`} checked={options.normalizeAudio} onChange={(normalizeAudio) => onOptionsChange({ normalizeAudio })} />
            <Toggle label="Broadband denoise" checked={options.denoise} onChange={(denoise) => onOptionsChange({ denoise })} />
            <Toggle label="Mute music track" checked={audio.musicMuted} onChange={(musicMuted) => patchAudio({ musicMuted })} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <MiniNumber label="Target LUFS" value={options.targetLufs} min={-24} max={-8} step={0.5} onChange={(targetLufs) => onOptionsChange({ targetLufs })} />
            <MiniNumber label="Limiter dBTP" value={options.limiterDb} min={-6} max={-0.1} step={0.1} onChange={(limiterDb) => onOptionsChange({ limiterDb })} />
          </div>
        </div>
        <div className="border-t border-white/5 pt-4">
          <div className="text-xs font-semibold text-slate-200">Music bus</div>
          <ToolRange label="Music level" value={creative.musicVolume * 100} min={2} max={50} step={1} suffix="%" onChange={(value) => onCreativeChange({ musicVolume: value / 100 })} />
          <div className="mt-3">
            <Toggle label="Dialogue side-chain ducking" checked={creative.musicDucking} onChange={(musicDucking) => onCreativeChange({ musicDucking })} />
          </div>
        </div>
      </section>
    </div>
  );
}

function CaptionTools({
  creative,
  words,
  min,
  max,
  onSeek,
  onCreativeChange,
}: {
  creative: LongformCreativeOptions;
  words: ToolWord[];
  min: number;
  max: number;
  onSeek: (time: number) => void;
  onCreativeChange: ProfessionalEditorToolsProps['onCreativeChange'];
}) {
  const captions = creative.captions;
  const patch = (values: Partial<typeof captions>) => onCreativeChange({ captions: { ...captions, ...values } });
  const updateCue = (id: string, values: Partial<(typeof captions.cues)[number]>) => {
    patch({ cues: captions.cues.map((cue) => cue.id === id ? { ...cue, ...values } : cue) });
  };
  return (
    <div className="p-4 sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-xs font-semibold text-slate-200">Editable caption workflow</div>
          <p className="mt-1 text-[10px] text-slate-600">Generate cues from word timestamps, fix text and timing, flag uncertain words, then export sidecars or burn captions into the master.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary h-8 px-2 text-[10px]" disabled={!words.length} onClick={() => patch({ enabled: true, cues: generateCaptionCues(words) })}>
            <WandSparkles className="h-3 w-3" /> Generate from transcript
          </button>
          <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => patch({ cues: [...captions.cues, { id: `caption-${Date.now()}`, start: min, end: Math.min(max, min + 3), text: 'New caption', speaker: '', lowConfidence: false }] })}>
            <Plus className="h-3 w-3" /> Add cue
          </button>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Toggle label="Enable captions" checked={captions.enabled} onChange={(enabled) => patch({ enabled })} />
        <Toggle label="Burn into video" checked={captions.burnIn} onChange={(burnIn) => patch({ burnIn })} />
        <label>
          <span className="label">Position</span>
          <select className="input h-9 text-xs" value={captions.position} onChange={(event) => patch({ position: event.target.value as typeof captions.position })}>
            <option value="bottom">Bottom</option>
            <option value="center">Center</option>
            <option value="top">Top</option>
          </select>
        </label>
        <MiniNumber label="Font size" value={captions.fontSize} min={18} max={96} step={1} onChange={(fontSize) => patch({ fontSize })} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <ColorInput label="Text" value={captions.textColor} onChange={(textColor) => patch({ textColor })} />
        <ColorInput label="Background" value={captions.backgroundColor} onChange={(backgroundColor) => patch({ backgroundColor })} />
        <ColorInput label="Highlight" value={captions.highlightColor} onChange={(highlightColor) => patch({ highlightColor })} />
      </div>
      <div className="mt-4 max-h-[520px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
        {captions.cues.map((cue, index) => (
          <div key={cue.id} className={clsx('rounded-xl border bg-black/20 p-3', cue.lowConfidence ? 'border-amber-400/20' : 'border-white/5')}>
            <div className="grid gap-2 lg:grid-cols-[auto_90px_90px_minmax(0,1fr)_120px_auto] lg:items-end">
              <button className="grid h-9 w-9 place-items-center rounded-lg bg-white/5 text-slate-400 hover:text-white" onClick={() => onSeek(cue.start)}>{index + 1}</button>
              <MiniNumber label="Start" value={cue.start} min={min} max={cue.end - 0.05} step={0.01} onChange={(start) => updateCue(cue.id, { start })} />
              <MiniNumber label="End" value={cue.end} min={cue.start + 0.05} max={max} step={0.01} onChange={(end) => updateCue(cue.id, { end })} />
              <label>
                <span className="label">Caption text</span>
                <input className="input h-9 text-xs" value={cue.text} onChange={(event) => updateCue(cue.id, { text: event.target.value })} />
              </label>
              <label>
                <span className="label">Speaker</span>
                <input className="input h-9 text-xs" value={cue.speaker} onChange={(event) => updateCue(cue.id, { speaker: event.target.value })} />
              </label>
              <div className="flex items-center">
                <button className={clsx('grid h-9 w-9 place-items-center rounded-lg', cue.lowConfidence ? 'bg-amber-500/10 text-amber-300' : 'text-slate-600 hover:text-amber-300')} onClick={() => updateCue(cue.id, { lowConfidence: !cue.lowConfidence })} title="Toggle review flag">!</button>
                <button className="grid h-9 w-9 place-items-center text-slate-600 hover:text-red-300" onClick={() => patch({ cues: captions.cues.filter((item) => item.id !== cue.id) })}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          </div>
        ))}
        {!captions.cues.length && <EmptyNote>No caption cues. Generated cues preserve custom edits in SRT, VTT, and optional burn-in output.</EmptyNote>}
      </div>
    </div>
  );
}

function ColorAndEffectsTools({
  creative,
  assets,
  playhead,
  min,
  max,
  videoRef,
  uploading,
  onUpload,
  onCreativeChange,
  onSeek,
}: {
  creative: LongformCreativeOptions;
  assets: LongformMediaAsset[];
  playhead: number;
  min: number;
  max: number;
  videoRef: RefObject<HTMLVideoElement>;
  uploading: boolean;
  onUpload: ProfessionalEditorToolsProps['onUpload'];
  onCreativeChange: ProfessionalEditorToolsProps['onCreativeChange'];
  onSeek: (time: number) => void;
}) {
  const color = creative.color;
  const patchColor = (values: Partial<typeof color>) => onCreativeChange({ color: { ...color, ...values } });
  const addAdjustment = () => onCreativeChange({
    adjustmentLayers: [...creative.adjustmentLayers, {
      id: `adjustment-${Date.now()}`,
      name: `Adjustment ${creative.adjustmentLayers.length + 1}`,
      start: playhead,
      end: Math.min(max, playhead + 5),
      exposure: 0,
      contrast: 1,
      saturation: 1,
      temperature: 0,
      tint: 0,
      sharpen: 0,
      blur: 0,
      vignette: 0,
      grain: 0,
    }],
  });
  const patchLayer = (id: string, values: Partial<LongformCreativeOptions['adjustmentLayers'][number]>) => onCreativeChange({
    adjustmentLayers: creative.adjustmentLayers.map((layer) => layer.id === id ? { ...layer, ...values } : layer),
  });
  const luts = assets.filter((asset) => asset.kind === 'lut');
  return (
    <div className="grid divide-y divide-white/5 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
      <section className="space-y-4 p-4 sm:p-5">
        <VideoScopes videoRef={videoRef} color={color} onColorChange={patchColor} />
        <div className="border-t border-white/5 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-slate-200">LUT and white balance</div>
              <div className="text-[10px] text-slate-600">.cube LUTs render before manual finishing controls.</div>
            </div>
            <label className="btn-secondary h-8 cursor-pointer px-2 text-[10px]">
              {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} Upload LUT
              <input className="hidden" type="file" accept=".cube" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload('lut', file); event.currentTarget.value = ''; }} />
            </label>
          </div>
          <select className="input mt-3 h-9 text-xs" value={color.lutAssetId || ''} onChange={(event) => patchColor({ lutAssetId: event.target.value || null })}>
            <option value="">No LUT</option>
            {luts.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <ToolRange label="Temperature" value={color.temperature} min={-1} max={1} step={0.02} onChange={(temperature) => patchColor({ temperature })} />
            <ToolRange label="Tint" value={color.tint} min={-1} max={1} step={0.02} onChange={(tint) => patchColor({ tint })} />
          </div>
        </div>
      </section>
      <section className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-slate-200">Adjustment layers</div>
            <p className="mt-1 text-[10px] text-slate-600">Time-bounded, non-destructive color and texture effects above program and B-roll.</p>
          </div>
          <button className="btn-secondary h-8 px-2 text-[10px]" onClick={addAdjustment}><Plus className="h-3 w-3" /> Add at playhead</button>
        </div>
        <div className="mt-3 max-h-[620px] space-y-3 overflow-y-auto pr-1 scrollbar-thin">
          {creative.adjustmentLayers.map((layer) => (
            <div key={layer.id} className="rounded-xl border border-white/5 bg-black/20 p-3">
              <div className="grid grid-cols-[minmax(0,1fr)_80px_80px_auto] gap-2">
                <input className="input h-8 text-xs" value={layer.name} onChange={(event) => patchLayer(layer.id, { name: event.target.value })} />
                <input className="input h-8 px-1 font-mono text-[10px]" type="number" min={min} max={layer.end - 0.05} step={0.1} value={layer.start} onChange={(event) => patchLayer(layer.id, { start: Number(event.target.value) })} />
                <input className="input h-8 px-1 font-mono text-[10px]" type="number" min={layer.start + 0.05} max={max} step={0.1} value={layer.end} onChange={(event) => patchLayer(layer.id, { end: Number(event.target.value) })} />
                <div className="flex">
                  <button className="grid h-8 w-8 place-items-center text-slate-500 hover:text-white" onClick={() => onSeek(layer.start)}><Film className="h-3 w-3" /></button>
                  <button className="grid h-8 w-8 place-items-center text-slate-600 hover:text-red-300" onClick={() => onCreativeChange({ adjustmentLayers: creative.adjustmentLayers.filter((item) => item.id !== layer.id) })}><Trash2 className="h-3 w-3" /></button>
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <ToolRange label="Exposure" value={layer.exposure} min={-0.3} max={0.3} step={0.01} onChange={(exposure) => patchLayer(layer.id, { exposure })} />
                <ToolRange label="Contrast" value={layer.contrast} min={0.5} max={1.5} step={0.01} onChange={(contrast) => patchLayer(layer.id, { contrast })} />
                <ToolRange label="Saturation" value={layer.saturation} min={0} max={2} step={0.01} onChange={(saturation) => patchLayer(layer.id, { saturation })} />
                <ToolRange label="Temperature" value={layer.temperature} min={-1} max={1} step={0.02} onChange={(temperature) => patchLayer(layer.id, { temperature })} />
                <ToolRange label="Tint" value={layer.tint} min={-1} max={1} step={0.02} onChange={(tint) => patchLayer(layer.id, { tint })} />
                <ToolRange label="Sharpen" value={layer.sharpen} min={0} max={1.5} step={0.05} onChange={(sharpen) => patchLayer(layer.id, { sharpen })} />
                <ToolRange label="Blur" value={layer.blur} min={0} max={20} step={0.25} onChange={(blur) => patchLayer(layer.id, { blur })} />
                <ToolRange label="Vignette" value={layer.vignette} min={0} max={1} step={0.05} onChange={(vignette) => patchLayer(layer.id, { vignette })} />
                <ToolRange label="Film grain" value={layer.grain} min={0} max={50} step={1} onChange={(grain) => patchLayer(layer.id, { grain })} />
              </div>
            </div>
          ))}
          {!creative.adjustmentLayers.length && <EmptyNote>Add an adjustment layer for shot-specific grades, blur, vignette, or grain.</EmptyNote>}
        </div>
      </section>
    </div>
  );
}

function MulticamTools({
  creative,
  assets,
  words,
  playhead,
  min,
  max,
  uploading,
  onUpload,
  onCreativeChange,
  onSeek,
  onCreateSpeakerPass,
}: {
  creative: LongformCreativeOptions;
  assets: LongformMediaAsset[];
  words: ToolWord[];
  playhead: number;
  min: number;
  max: number;
  uploading: boolean;
  onUpload: ProfessionalEditorToolsProps['onUpload'];
  onCreativeChange: ProfessionalEditorToolsProps['onCreativeChange'];
  onSeek: (time: number) => void;
  onCreateSpeakerPass: () => void;
}) {
  const angleAssets = new Map(assets.filter((asset) => asset.kind === 'angle').map((asset) => [asset.id, asset]));
  const speakers = [...new Set(words.map((word) => word.speaker).filter((speaker) => speaker !== undefined && speaker !== null).map(String))];
  const patchAngle = (id: string, values: Partial<LongformCreativeOptions['multicam']['angles'][number]>) => onCreativeChange({
    multicam: {
      ...creative.multicam,
      angles: creative.multicam.angles.map((angle) => angle.id === id ? { ...angle, ...values } : angle),
    },
  });
  const patchCut = (id: string, values: Partial<LongformCreativeOptions['multicam']['cuts'][number]>) => onCreativeChange({
    multicam: {
      ...creative.multicam,
      cuts: creative.multicam.cuts.map((cut) => cut.id === id ? { ...cut, ...values } : cut),
    },
  });
  const addCut = (angleId: string) => onCreativeChange({
    multicam: {
      ...creative.multicam,
      cuts: [...creative.multicam.cuts, {
        id: `multicam-cut-${Date.now()}`,
        angleId,
        start: playhead,
        end: Math.min(max, playhead + 5),
        useAudio: false,
      }].sort((left, right) => left.start - right.start),
    },
  });
  return (
    <div className="grid divide-y divide-white/5 xl:grid-cols-[minmax(280px,0.75fr)_minmax(0,1.25fr)] xl:divide-x xl:divide-y-0">
      <section className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-slate-200">Synchronized angles</div>
            <p className="mt-1 text-[10px] text-slate-600">Set sync offset as alternate-angle time minus program time, then optionally map an angle to a transcript speaker.</p>
          </div>
          <label className="btn-secondary h-8 cursor-pointer px-2 text-[10px]">
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />} Add angle
            <input className="hidden" type="file" accept="video/*" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload('angle', file); event.currentTarget.value = ''; }} />
          </label>
        </div>
        <div className="mt-3 space-y-2">
          {creative.multicam.angles.map((angle) => (
            <div key={angle.id} className="rounded-xl bg-black/20 p-3">
              <input className="input h-8 text-xs" value={angle.name} onChange={(event) => patchAngle(angle.id, { name: event.target.value })} />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <MiniNumber label="Sync offset" value={angle.offsetSec} min={-86400} max={86400} step={0.01} onChange={(offsetSec) => patchAngle(angle.id, { offsetSec })} />
                <label>
                  <span className="label">Speaker</span>
                  <select className="input h-9 text-xs" value={angle.speaker} onChange={(event) => patchAngle(angle.id, { speaker: event.target.value })}>
                    <option value="">Manual switching</option>
                    {speakers.map((speaker) => <option key={speaker} value={speaker}>{speaker}</option>)}
                  </select>
                </label>
              </div>
              <div className="mt-2 flex items-center justify-between text-[10px] text-slate-600">
                <span className="truncate">{angleAssets.get(angle.assetId)?.name || angle.assetId}</span>
                <div className="flex gap-1">
                  <button className="btn-secondary h-7 px-2 text-[10px]" onClick={() => addCut(angle.id)}>Cut at playhead</button>
                  <button className="grid h-7 w-7 place-items-center hover:text-red-300" onClick={() => onCreativeChange({ multicam: { angles: creative.multicam.angles.filter((item) => item.id !== angle.id), cuts: creative.multicam.cuts.filter((cut) => cut.angleId !== angle.id) } })}><Trash2 className="h-3 w-3" /></button>
                </div>
              </div>
            </div>
          ))}
          {!creative.multicam.angles.length && <EmptyNote>Upload a second camera or screen recording to start a multicam sequence.</EmptyNote>}
        </div>
        <button className="btn-primary mt-3 w-full text-xs" disabled={!creative.multicam.angles.some((angle) => angle.speaker) || !speakers.length} onClick={onCreateSpeakerPass}>
          <WandSparkles className="h-3.5 w-3.5" /> Build speaker-based cut pass
        </button>
      </section>
      <section className="p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-slate-200">Angle switch timeline</div>
            <div className="mt-1 text-[10px] text-slate-600">Alternate angle video replaces program only inside each switch range. Original program audio remains unless angle audio is enabled.</div>
          </div>
          <span className="chip">{creative.multicam.cuts.length} switches</span>
        </div>
        <div className="mt-3 max-h-[580px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
          {creative.multicam.cuts.map((cut) => {
            const angle = creative.multicam.angles.find((item) => item.id === cut.angleId);
            return (
              <div key={cut.id} className="grid gap-2 rounded-xl border border-white/5 bg-black/20 p-3 sm:grid-cols-[minmax(0,1fr)_90px_90px_110px_auto] sm:items-end">
                <label>
                  <span className="label">Angle</span>
                  <select className="input h-9 text-xs" value={cut.angleId} onChange={(event) => patchCut(cut.id, { angleId: event.target.value })}>
                    {creative.multicam.angles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <MiniNumber label="Start" value={cut.start} min={min} max={cut.end - 0.05} step={0.01} onChange={(start) => patchCut(cut.id, { start })} />
                <MiniNumber label="End" value={cut.end} min={cut.start + 0.05} max={max} step={0.01} onChange={(end) => patchCut(cut.id, { end })} />
                <Toggle label="Use angle audio" checked={cut.useAudio} onChange={(useAudio) => patchCut(cut.id, { useAudio })} compact />
                <div className="flex">
                  <button className="grid h-9 w-9 place-items-center text-slate-500 hover:text-white" onClick={() => onSeek(cut.start)} title={angle?.name}><Film className="h-3 w-3" /></button>
                  <button className="grid h-9 w-9 place-items-center text-slate-600 hover:text-red-300" onClick={() => onCreativeChange({ multicam: { ...creative.multicam, cuts: creative.multicam.cuts.filter((item) => item.id !== cut.id) } })}><Trash2 className="h-3 w-3" /></button>
                </div>
              </div>
            );
          })}
          {!creative.multicam.cuts.length && <EmptyNote>Use “Cut at playhead” or generate a speaker-based first pass, then refine every switch.</EmptyNote>}
        </div>
      </section>
    </div>
  );
}

function ProjectSafetyTools({
  projectName,
  proxy,
  proxyBusy,
  snapshots,
  presets,
  queue,
  snapshotName,
  presetName,
  duplicateName,
  duplicateResult,
  busy,
  onSnapshotName,
  onPresetName,
  onDuplicateName,
  onCreateSnapshot,
  onRestoreSnapshot,
  onDuplicate,
  onRelink,
  onProxyAction,
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
}: {
  projectName: string;
  proxy: LongformProxyState;
  proxyBusy: boolean;
  snapshots: Awaited<ReturnType<typeof api.listLongformSnapshots>>;
  presets: Awaited<ReturnType<typeof api.listLongformPresets>>;
  queue: Awaited<ReturnType<typeof api.listLongformRenderQueue>>;
  snapshotName: string;
  presetName: string;
  duplicateName: string;
  duplicateResult: string | null;
  busy: boolean;
  onSnapshotName: (value: string) => void;
  onPresetName: (value: string) => void;
  onDuplicateName: (value: string) => void;
  onCreateSnapshot: () => void;
  onRestoreSnapshot: (id: string) => void;
  onDuplicate: () => void;
  onRelink: (file: File) => void;
  onProxyAction: (action: 'build' | 'delete') => void;
  onSavePreset: () => void;
  onApplyPreset: (creative: LongformCreativeOptions) => void;
  onDeletePreset: (id: string) => void;
}) {
  const projectQueue = queue.filter((job) => job.projectName === projectName || job.outputName.includes(projectName.replace(/\.mp4$/i, '')));
  return (
    <div className="grid divide-y divide-white/5 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
      <section className="space-y-5 p-4 sm:p-5">
        <div>
          <div className="text-xs font-semibold text-slate-200">Proxy and source health</div>
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-black/20 p-3">
            <span className={clsx('h-2 w-2 rounded-full', proxy.status === 'ready' ? 'bg-emerald-400' : proxy.status === 'building' ? 'animate-pulse bg-amber-300' : proxy.status === 'error' ? 'bg-red-400' : 'bg-slate-600')} />
            <span className="text-xs font-semibold capitalize text-slate-300">{proxy.status}</span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-slate-600">{proxy.error || '1280px H.264 editing proxy; final render always uses the source.'}</span>
            {proxy.status === 'ready' ? (
              <button className="btn-secondary h-8 px-2 text-[10px]" disabled={proxyBusy} onClick={() => onProxyAction('delete')}><Trash2 className="h-3 w-3" /> Delete proxy</button>
            ) : (
              <button className="btn-secondary h-8 px-2 text-[10px]" disabled={proxyBusy || proxy.status === 'building'} onClick={() => onProxyAction('build')}>
                {proxy.status === 'building' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Film className="h-3 w-3" />} Build proxy
              </button>
            )}
          </div>
          <label className="btn-secondary mt-2 h-9 cursor-pointer px-3 text-xs">
            <Link2 className="h-3.5 w-3.5" /> Relink missing or replaced source
            <input className="hidden" type="file" accept="video/*" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) onRelink(file); event.currentTarget.value = ''; }} />
          </label>
        </div>

        <div className="border-t border-white/5 pt-4">
          <div className="text-xs font-semibold text-slate-200">Snapshots and recovery</div>
          <div className="mt-2 flex gap-2">
            <input className="input h-9 min-w-0 flex-1 text-xs" value={snapshotName} placeholder="Snapshot name (optional)" onChange={(event) => onSnapshotName(event.target.value)} />
            <button className="btn-primary h-9 px-3 text-xs" disabled={busy} onClick={onCreateSnapshot}><Save className="h-3.5 w-3.5" /> Snapshot</button>
          </div>
          <div className="mt-2 max-h-52 space-y-1.5 overflow-y-auto scrollbar-thin">
            {snapshots.map((snapshot) => (
              <div key={snapshot.id} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-semibold text-slate-300">{snapshot.name}</div>
                  <div className="text-[10px] text-slate-600">Revision {snapshot.revision} · {new Date(snapshot.createdAt).toLocaleString()}</div>
                </div>
                <button className="btn-secondary h-7 px-2 text-[10px]" disabled={busy} onClick={() => onRestoreSnapshot(snapshot.id)}>Restore</button>
              </div>
            ))}
            {!snapshots.length && <EmptyNote>Autosave snapshots are retained periodically; create named checkpoints before major edits.</EmptyNote>}
          </div>
        </div>

        <div className="border-t border-white/5 pt-4">
          <div className="text-xs font-semibold text-slate-200">Duplicate project</div>
          <div className="mt-2 flex gap-2">
            <input className="input h-9 min-w-0 flex-1 text-xs" value={duplicateName} placeholder="Optional copy name" onChange={(event) => onDuplicateName(event.target.value)} />
            <button className="btn-secondary h-9 px-3 text-xs" disabled={busy} onClick={onDuplicate}><Copy className="h-3.5 w-3.5" /> Duplicate</button>
          </div>
          {duplicateResult && <div className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-2 font-mono text-[10px] text-emerald-200">Created {duplicateResult}</div>}
        </div>
      </section>

      <section className="space-y-5 p-4 sm:p-5">
        <div>
          <div className="text-xs font-semibold text-slate-200">Reusable finishing presets</div>
          <div className="mt-2 flex gap-2">
            <input className="input h-9 min-w-0 flex-1 text-xs" value={presetName} placeholder="Preset name" onChange={(event) => onPresetName(event.target.value)} />
            <button className="btn-secondary h-9 px-3 text-xs" disabled={!presetName.trim() || busy} onClick={onSavePreset}><Save className="h-3.5 w-3.5" /> Save</button>
          </div>
          <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto scrollbar-thin">
            {presets.map((preset) => (
              <div key={preset.id} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-semibold text-slate-300">{preset.name}</div>
                  <div className="text-[10px] text-slate-600">{new Date(preset.createdAt).toLocaleDateString()}</div>
                </div>
                <button className="btn-secondary h-7 px-2 text-[10px]" onClick={() => onApplyPreset(preset.creative)}>Apply</button>
                <button className="grid h-7 w-7 place-items-center text-slate-600 hover:text-red-300" onClick={() => onDeletePreset(preset.id)}><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
            {!presets.length && <EmptyNote>Save color, audio, caption style, and delivery defaults for reuse.</EmptyNote>}
          </div>
        </div>

        <div className="border-t border-white/5 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-slate-200">Persisted render queue</div>
              <div className="mt-1 text-[10px] text-slate-600">Exports wait safely behind other factory jobs and survive a dashboard restart.</div>
            </div>
            <span className="chip">{projectQueue.length}</span>
          </div>
          <div className="mt-3 max-h-64 space-y-2 overflow-y-auto scrollbar-thin">
            {projectQueue.map((job) => (
              <div key={job.id} className="rounded-lg bg-black/20 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={clsx('h-2 w-2 rounded-full', job.status === 'complete' ? 'bg-emerald-400' : job.status === 'failed' ? 'bg-red-400' : job.status === 'rendering' ? 'animate-pulse bg-pink-400' : 'bg-amber-300')} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-300">{job.outputName}</span>
                  <span className="text-[10px] font-semibold uppercase text-slate-500">{job.status}</span>
                </div>
                {job.error && <div className="mt-1 text-[10px] text-red-300">{job.error}</div>}
              </div>
            ))}
            {!projectQueue.length && <EmptyNote>Queued and recent exports for this project will appear here.</EmptyNote>}
          </div>
        </div>
      </section>
    </div>
  );
}

function AssistantTools({
  suggestions,
  scanning,
  onScan,
  onAccept,
  onDismiss,
}: {
  suggestions: LongformAssistantSuggestion[];
  scanning: boolean;
  onScan: () => void;
  onAccept: (suggestion: LongformAssistantSuggestion) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs font-semibold text-slate-200">Reviewable editor assistant</div>
          <p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-slate-600">
            Suggestions never change the timeline automatically. Scan the current transcript and edit state, then accept or dismiss each proposed change.
          </p>
        </div>
        <button className="btn-primary h-9 px-3 text-xs" disabled={scanning} onClick={onScan}>
          {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />} Scan project
        </button>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {suggestions.map((suggestion) => (
          <div key={suggestion.id} className="rounded-xl border border-white/5 bg-black/20 p-4">
            <div className="flex items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-300"><WandSparkles className="h-4 w-4" /></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-slate-200">{suggestion.title}</span>
                  <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-500">{suggestion.kind}</span>
                  <span className="text-[10px] text-slate-600">{Math.round(suggestion.confidence * 100)}%</span>
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{suggestion.detail}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button className="btn-primary h-8 px-2 text-[10px]" onClick={() => onAccept(suggestion)}><Check className="h-3 w-3" /> Accept</button>
              <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => onDismiss(suggestion.id)}><X className="h-3 w-3" /> Dismiss</button>
            </div>
          </div>
        ))}
        {!suggestions.length && !scanning && <div className="lg:col-span-2"><EmptyNote>Run a scan to review pacing cuts, chapter ideas, caption confidence, audio finishing, multicam, and B-roll cues.</EmptyNote></div>}
      </div>
    </div>
  );
}

function VideoScopes({
  videoRef,
  color,
  onColorChange,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  color: LongformCreativeOptions['color'];
  onColorChange: (patch: Partial<LongformCreativeOptions['color']>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pickerCanvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<'histogram' | 'parade' | 'vectorscope'>('histogram');
  const [reference, setReference] = useState<{ r: number; g: number; b: number; luma: number } | null>(null);
  const sample = () => sampleVideoFrame(videoRef.current);
  const redraw = () => {
    const frame = captureVideoFrame(videoRef.current);
    if (!frame) return;
    if (canvasRef.current) drawScope(canvasRef.current, frame.data, frame.width, frame.height, mode);
    const pickerContext = pickerCanvasRef.current?.getContext('2d');
    if (pickerContext && pickerCanvasRef.current) {
      const image = new ImageData(frame.data, frame.width, frame.height);
      pickerCanvasRef.current.width = frame.width;
      pickerCanvasRef.current.height = frame.height;
      pickerContext.putImageData(image, 0, 0);
    }
  };
  useEffect(() => {
    redraw();
    const video = videoRef.current;
    if (!video) return;
    const timer = window.setInterval(() => {
      if (!video.paused) redraw();
    }, 450);
    return () => window.clearInterval(timer);
  // Scope redraw intentionally follows the selected display mode.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, videoRef]);
  const applyWhiteBalance = (current: { r: number; g: number; b: number; luma: number } | null) => {
    if (!current) return;
    onColorChange({
      temperature: clamp(color.temperature + ((current.b - current.r) / 255) * 1.25, -1, 1),
      tint: clamp(color.tint + ((((current.r + current.b) / 2) - current.g) / 255) * 1.25, -1, 1),
    });
  };
  const matchShot = () => {
    const current = sample();
    if (!current || !reference) return;
    onColorChange({
      exposure: clamp(color.exposure + ((reference.luma - current.luma) / 255) * 0.3, -0.3, 0.3),
      temperature: clamp(color.temperature + (((reference.r - reference.b) - (current.r - current.b)) / 255), -1, 1),
      tint: clamp(color.tint + ((((reference.r + reference.b) / 2 - reference.g) - ((current.r + current.b) / 2 - current.g)) / 255), -1, 1),
    });
  };
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-slate-200">Video scopes and shot matching</div>
          <div className="mt-1 text-[10px] text-slate-600">Live sampled from the current source or proxy frame.</div>
        </div>
        <div className="flex gap-1">
          {(['histogram', 'parade', 'vectorscope'] as const).map((item) => (
            <button key={item} className={clsx('rounded px-2 py-1 text-[10px] capitalize', mode === item ? 'bg-white/10 text-white' : 'text-slate-600 hover:text-slate-300')} onClick={() => setMode(item)}>{item}</button>
          ))}
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)]">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">WB picker</div>
          <canvas
            ref={pickerCanvasRef}
            width={192}
            height={108}
            className="aspect-video w-full cursor-crosshair rounded bg-black ring-1 ring-inset ring-white/10"
            title="Click a neutral gray or white point to balance temperature and tint"
            onClick={(event) => {
              const canvas = event.currentTarget;
              const rect = canvas.getBoundingClientRect();
              const x = clamp(Math.floor((event.clientX - rect.left) / Math.max(1, rect.width) * canvas.width), 0, canvas.width - 1);
              const y = clamp(Math.floor((event.clientY - rect.top) / Math.max(1, rect.height) * canvas.height), 0, canvas.height - 1);
              const pixel = canvas.getContext('2d')?.getImageData(x, y, 1, 1).data;
              if (pixel) applyWhiteBalance({
                r: pixel[0],
                g: pixel[1],
                b: pixel[2],
                luma: pixel[0] * 0.2126 + pixel[1] * 0.7152 + pixel[2] * 0.0722,
              });
            }}
          />
          <div className="mt-1 text-[10px] leading-relaxed text-slate-600">Click a neutral pixel.</div>
        </div>
        <canvas ref={canvasRef} width={720} height={220} className="h-48 w-full rounded-lg bg-black ring-1 ring-inset ring-white/10" />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <button className="btn-secondary h-8 px-2 text-[10px]" onClick={redraw}><RefreshCcw className="h-3 w-3" /> Refresh</button>
        <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => applyWhiteBalance(sample())}>Auto WB</button>
        <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => setReference(sample())}>Set reference</button>
        <button className="btn-primary h-8 px-2 text-[10px]" disabled={!reference} onClick={matchShot}>Match shot</button>
      </div>
    </div>
  );
}

function captureVideoFrame(video: HTMLVideoElement | null) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const width = 192;
  const height = Math.max(2, Math.round(width * video.videoHeight / video.videoWidth));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, width, height);
    return { data: context.getImageData(0, 0, width, height).data, width, height };
  } catch {
    return null;
  }
}

function sampleVideoFrame(video: HTMLVideoElement | null) {
  const frame = captureVideoFrame(video);
  if (!frame) return null;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let index = 0; index < frame.data.length; index += 16) {
    red += frame.data[index];
    green += frame.data[index + 1];
    blue += frame.data[index + 2];
    count += 1;
  }
  if (!count) return null;
  const r = red / count;
  const g = green / count;
  const b = blue / count;
  return { r, g, b, luma: r * 0.2126 + g * 0.7152 + b * 0.0722 };
}

function drawScope(
  canvas: HTMLCanvasElement,
  pixels: Uint8ClampedArray,
  _frameWidth: number,
  _frameHeight: number,
  mode: 'histogram' | 'parade' | 'vectorscope',
) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  context.fillStyle = '#020617';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = 'rgba(148,163,184,.12)';
  context.lineWidth = 1;
  for (let index = 1; index < 4; index += 1) {
    context.beginPath();
    context.moveTo(0, height * index / 4);
    context.lineTo(width, height * index / 4);
    context.stroke();
  }
  if (mode === 'vectorscope') {
    context.strokeStyle = 'rgba(148,163,184,.25)';
    context.beginPath();
    context.arc(width / 2, height / 2, Math.min(width, height) * 0.42, 0, Math.PI * 2);
    context.stroke();
    for (let index = 0; index < pixels.length; index += 64) {
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const u = -0.14713 * r - 0.28886 * g + 0.436 * b;
      const v = 0.615 * r - 0.51499 * g - 0.10001 * b;
      context.fillStyle = `rgba(${r},${g},${b},.2)`;
      context.fillRect(width / 2 + u * 0.7, height / 2 - v * 0.7, 2, 2);
    }
    return;
  }
  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let index = 0; index < pixels.length; index += 4) {
    histograms[0][pixels[index]] += 1;
    histograms[1][pixels[index + 1]] += 1;
    histograms[2][pixels[index + 2]] += 1;
  }
  const colors = ['#ef4444', '#22c55e', '#3b82f6'];
  histograms.forEach((histogram, channel) => {
    const maximum = Math.max(1, ...histogram);
    const sectionWidth = mode === 'parade' ? width / 3 : width;
    const offset = mode === 'parade' ? sectionWidth * channel : 0;
    context.strokeStyle = colors[channel];
    context.lineWidth = 1.4;
    context.beginPath();
    histogram.forEach((value, index) => {
      const x = offset + index / 255 * sectionWidth;
      const y = height - Math.sqrt(value / maximum) * (height - 8);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  });
}

function useAudioLevels(videoRef: RefObject<HTMLVideoElement>) {
  const [levels, setLevels] = useState({ left: 0, right: 0 });
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const captureStream = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream;
    if (!captureStream) return;
    let context: AudioContext | null = null;
    let frame = 0;
    try {
      const stream = captureStream.call(video);
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const values = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(values);
        let sum = 0;
        for (const value of values) {
          const normalized = (value - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / values.length);
        setLevels({ left: clamp(rms * 3.5, 0, 1), right: clamp(rms * 3.25, 0, 1) });
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    } catch {
      return;
    }
    return () => {
      window.cancelAnimationFrame(frame);
      context?.close().catch(() => undefined);
    };
  }, [videoRef]);
  return levels;
}

function Meter({ value }: { value: number }) {
  return (
    <span className="relative h-9 w-2 overflow-hidden rounded-sm bg-slate-900">
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-emerald-500 via-amber-300 to-red-500 transition-[height]" style={{ height: `${clamp(value, 0, 1) * 100}%` }} />
    </span>
  );
}

function ToolRange({ label, value, min, max, step, suffix = '', onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between gap-2 text-[10px] font-semibold text-slate-400">
        <span>{label}</span><span className="font-mono text-slate-500">{value.toFixed(step < 0.1 ? 2 : 1)}{suffix}</span>
      </span>
      <input className="w-full accent-emerald-500" type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function MiniNumber({ label, value, min, max, step, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span className="label">{label}</span>
      <input className="input h-9 px-2 font-mono text-[10px]" type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Toggle({ label, detail, checked, onChange, compact = false }: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  compact?: boolean;
}) {
  return (
    <label className={clsx('flex cursor-pointer items-center justify-between gap-3 rounded-lg bg-white/[0.025] ring-1 ring-inset ring-white/5', compact ? 'h-9 px-2' : 'p-3')}>
      <span className="min-w-0">
        <span className="block text-[10px] font-semibold text-slate-300">{label}</span>
        {detail && <span className="mt-0.5 block text-[10px] text-slate-600">{detail}</span>}
      </span>
      <input className="h-4 w-4 shrink-0 accent-emerald-500" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span className="label">{label}</span>
      <span className="flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2">
        <input className="h-5 w-7 cursor-pointer border-0 bg-transparent p-0" type="color" value={value} onChange={(event) => onChange(event.target.value.toUpperCase())} />
        <span className="truncate font-mono text-[10px] text-slate-500">{value}</span>
      </span>
    </label>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-white/5 px-3 py-5 text-center text-[10px] leading-relaxed text-slate-600">{children}</div>;
}
