import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  AudioLines,
  Blend,
  Boxes,
  Check,
  ChevronDown,
  CircleStop,
  Clipboard,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileArchive,
  Film,
  Gauge,
  GitCompare,
  Group,
  Layers3,
  Link2,
  Lock,
  LockOpen,
  MessageSquare,
  Mic,
  MonitorPlay,
  Palette,
  Pause,
  Play,
  Plus,
  Radio,
  Redo2,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareStack,
  Trash2,
  Upload,
  WandSparkles,
  Zap,
} from 'lucide-react';
import { clsx } from 'clsx';
import {
  api,
  type LongformChapter,
  type LongformColorGrade,
  type LongformConsolidation,
  type LongformCreativeOptions,
  type LongformCut,
  type LongformDelivery,
  type LongformEffectTemplate,
  type LongformMask,
  type LongformMediaAsset,
  type LongformOptions,
  type LongformQcReport,
  type LongformReview,
  type LongformSequence,
  type LongformSequenceClip,
  type LongformSequenceTrack,
  type LongformTransitionType,
} from '@/api/client';

type UploadKind = 'media' | 'voiceover' | 'lut';
export type WorkspaceTab = 'timeline' | 'effects' | 'color' | 'voiceover' | 'publish' | 'review' | 'qc' | 'interchange' | 'templates';

interface EditorV3WorkspaceProps {
  projectName: string;
  creative: LongformCreativeOptions;
  assets: LongformMediaAsset[];
  options: LongformOptions;
  cuts: LongformCut[];
  chapters: LongformChapter[];
  playhead: number;
  min: number;
  max: number;
  videoRef: RefObject<HTMLVideoElement>;
  uploading: boolean;
  onUpload: (kind: UploadKind, file: File) => void;
  onCreativeChange: (patch: Partial<LongformCreativeOptions>) => void;
  onSeek: (seconds: number) => void;
  activeTab?: WorkspaceTab;
  onTabChange?: (tab: WorkspaceTab) => void;
  embedded?: boolean;
  showTabs?: boolean;
}

const TABS: Array<{ id: WorkspaceTab; label: string; icon: typeof Film }> = [
  { id: 'timeline', label: 'Sequence', icon: Layers3 },
  { id: 'effects', label: 'Time & FX', icon: Zap },
  { id: 'color', label: 'Auto Color', icon: Palette },
  { id: 'voiceover', label: 'Voiceover / ADR', icon: Mic },
  { id: 'publish', label: 'Publish', icon: MonitorPlay },
  { id: 'review', label: 'Review', icon: MessageSquare },
  { id: 'qc', label: 'QC', icon: ShieldCheck },
  { id: 'interchange', label: 'Interchange', icon: GitCompare },
  { id: 'templates', label: 'Templates', icon: Boxes },
];

const NEUTRAL_GRADE: LongformColorGrade = {
  exposure: 0,
  contrast: 1,
  saturation: 1,
  vibrance: 0,
  gamma: 1,
  highlights: 0,
  shadows: 0,
  temperature: 0,
  tint: 0,
  sharpen: 0,
  lutAssetId: null,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}

function formatTime(value: number) {
  const totalMilliseconds = Math.max(0, Math.round((Number.isFinite(value) ? value : 0) * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const frames = Math.floor((totalMilliseconds % 1000) / (1000 / 30));
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(hours ? 2 : 1, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'The operation failed.';
}

function defaultClip(values: Partial<LongformSequenceClip>): LongformSequenceClip {
  const sourceStart = values.sourceStart ?? 0;
  const sourceEnd = Math.max(sourceStart + 0.02, values.sourceEnd ?? sourceStart + 5);
  const timelineStart = values.timelineStart ?? 0;
  const timelineEnd = Math.max(timelineStart + 0.02, values.timelineEnd ?? timelineStart + (sourceEnd - sourceStart));
  return {
    id: values.id || `sequence-clip-${Date.now()}-${Math.round(Math.random() * 10_000)}`,
    name: values.name || 'Program clip',
    enabled: values.enabled !== false,
    sourceType: values.sourceType || 'program',
    assetId: values.assetId ?? null,
    nestedSequenceId: values.nestedSequenceId ?? null,
    generator: values.generator || 'solid',
    generatorColor: values.generatorColor || '#111827',
    sourceStart,
    sourceEnd,
    timelineStart,
    timelineEnd,
    includeAudio: values.includeAudio ?? false,
    linkedGroupId: values.linkedGroupId ?? null,
    compoundId: values.compoundId ?? null,
    fit: values.fit || 'cover',
    x: values.x ?? 0,
    y: values.y ?? 0,
    scale: values.scale ?? 1,
    rotation: values.rotation ?? 0,
    opacity: values.opacity ?? 1,
    volumeDb: values.volumeDb ?? 0,
    fadeIn: values.fadeIn ?? 0,
    fadeOut: values.fadeOut ?? 0,
    transitionIn: values.transitionIn || { type: 'cut', duration: 0 },
    transitionOut: values.transitionOut || { type: 'cut', duration: 0 },
    speed: values.speed || {
      rate: 1,
      reverse: false,
      freeze: false,
      freezeAt: 0,
      opticalFlow: false,
      pitchPreserve: true,
      keyframes: [],
    },
    stabilization: values.stabilization || {
      enabled: false,
      strength: 12,
      rollingShutter: 0,
      method: 'realtime',
    },
    chromaKey: values.chromaKey || {
      enabled: false,
      color: '#00FF00',
      similarity: 0.18,
      blend: 0.08,
      spill: 0.25,
      autoBackground: false,
    },
    masks: values.masks || [],
    templateIds: values.templateIds || [],
    notes: values.notes || '',
  };
}

function defaultTrack(kind: 'video' | 'audio', order: number): LongformSequenceTrack {
  return {
    id: `${kind === 'video' ? 'v' : 'a'}-${Date.now()}-${order}`,
    name: `${kind === 'video' ? 'Video' : 'Audio'} ${order + 1}`,
    kind,
    order,
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
    linked: true,
    volumeDb: 0,
    clips: [],
  };
}

function cloneClip(clip: LongformSequenceClip, offset = 0): LongformSequenceClip {
  return {
    ...clip,
    id: `sequence-clip-${Date.now()}-${Math.round(Math.random() * 100_000)}`,
    timelineStart: clip.timelineStart + offset,
    timelineEnd: clip.timelineEnd + offset,
    linkedGroupId: clip.linkedGroupId ? `linked-${Date.now()}` : null,
    compoundId: clip.compoundId ? `compound-${Date.now()}` : null,
    speed: {
      ...clip.speed,
      keyframes: clip.speed.keyframes.map((item) => ({ ...item, id: `speed-${Date.now()}-${Math.random()}` })),
    },
    masks: clip.masks.map((mask) => ({
      ...mask,
      id: `mask-${Date.now()}-${Math.random()}`,
      keyframes: mask.keyframes.map((item) => ({ ...item, id: `mask-keyframe-${Date.now()}-${Math.random()}` })),
    })),
  };
}

export function EditorV3Workspace(props: EditorV3WorkspaceProps) {
  const {
    projectName,
    creative,
    assets,
    options,
    cuts,
    chapters,
    playhead,
    min,
    max,
    videoRef,
    uploading,
    onUpload,
    onCreativeChange,
    onSeek,
    activeTab,
    onTabChange,
    embedded = false,
    showTabs = true,
  } = props;
  const queryClient = useQueryClient();
  const [internalTab, setInternalTab] = useState<WorkspaceTab>('timeline');
  const tab = activeTab ?? internalTab;
  const setTab = (nextTab: WorkspaceTab) => {
    if (activeTab === undefined) setInternalTab(nextTab);
    onTabChange?.(nextTab);
  };
  const [selectedTrackId, setSelectedTrackId] = useState('');
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(() => new Set());
  const [clipboard, setClipboard] = useState<Array<{ trackKind: 'video' | 'audio'; clip: LongformSequenceClip }>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [qcReport, setQcReport] = useState<LongformQcReport | null>(null);
  const [reviewTitle, setReviewTitle] = useState('');
  const [reviewPassword, setReviewPassword] = useState('');
  const [reviewExpiry, setReviewExpiry] = useState(14);
  const [templateName, setTemplateName] = useState('');
  const compareFilterRef = useRef<string | null>(null);

  const sequenceState = creative.sequence;
  const activeSequence = useMemo(
    () => sequenceState.sequences.find((sequence) => sequence.id === sequenceState.activeSequenceId)
      || sequenceState.sequences[0],
    [sequenceState.activeSequenceId, sequenceState.sequences],
  );
  const allClips = useMemo(
    () => (activeSequence?.tracks || []).flatMap((track) => track.clips.map((clip) => ({ track, clip }))),
    [activeSequence],
  );
  const selectedRows = allClips.filter(({ clip }) => selectedClipIds.has(clip.id));
  const selectedRow = selectedRows[0] || null;
  const selectedClip = selectedRow?.clip || null;
  const selectedTrack = selectedRow?.track
    || activeSequence?.tracks.find((track) => track.id === selectedTrackId)
    || activeSequence?.tracks[0]
    || null;
  const timelinePlayhead = Math.max(0, playhead - min);
  const sequenceDuration = Math.max(
    10,
    max - min,
    ...(activeSequence?.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineEnd)) || [0]),
  );
  const luts = assets.filter((asset) => asset.kind === 'lut');
  const voiceoverAssets = assets.filter((asset) => asset.kind === 'voiceover');

  useEffect(() => {
    if (!activeSequence) return;
    if (!activeSequence.tracks.some((track) => track.id === selectedTrackId)) {
      setSelectedTrackId(activeSequence.tracks[0]?.id || '');
    }
    const clipIds = new Set(activeSequence.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    setSelectedClipIds((current) => new Set([...current].filter((clipId) => clipIds.has(clipId))));
  }, [activeSequence, selectedTrackId]);

  const templatesQuery = useQuery({
    queryKey: ['longform-effect-templates'],
    queryFn: api.listLongformEffectTemplates,
    enabled: tab === 'templates' || tab === 'effects',
  });
  const reviewsQuery = useQuery({
    queryKey: ['longform-reviews', projectName],
    queryFn: () => api.listLongformReviews(projectName),
    enabled: tab === 'review',
    refetchInterval: tab === 'review' ? 5000 : false,
  });
  const deliveriesQuery = useQuery({
    queryKey: ['longform-deliveries', projectName],
    queryFn: () => api.listLongformDeliveries(projectName),
    enabled: tab === 'publish',
    refetchInterval: tab === 'publish' ? 3500 : false,
  });

  const autoGradeMutation = useMutation({
    mutationFn: () => api.autoGradeLongform(projectName, { start: min, end: max, samples: 48 }),
    onSuccess: (result) => {
      const strength = creative.colorWorkflow.autoGrade.strength;
      const suggested = { ...NEUTRAL_GRADE, ...result.grade };
      const blendLinear = (current: number, target: number) => current + (target - current) * strength;
      const blendMultiplier = (current: number, target: number) => current * (1 + (target - 1) * strength);
      const beforeId = `grade-before-${Date.now()}`;
      const afterId = `grade-auto-${Date.now()}`;
      const grade: LongformColorGrade = {
        ...creative.color,
        exposure: blendLinear(creative.color.exposure, creative.color.exposure + suggested.exposure),
        contrast: blendMultiplier(creative.color.contrast, suggested.contrast),
        saturation: blendMultiplier(creative.color.saturation, suggested.saturation),
        vibrance: blendLinear(creative.color.vibrance, suggested.vibrance),
        gamma: blendMultiplier(creative.color.gamma, suggested.gamma),
        highlights: blendLinear(creative.color.highlights, suggested.highlights),
        shadows: blendLinear(creative.color.shadows, suggested.shadows),
        temperature: blendLinear(creative.color.temperature, creative.color.temperature + suggested.temperature),
        tint: blendLinear(creative.color.tint, creative.color.tint + suggested.tint),
        sharpen: Math.max(creative.color.sharpen, suggested.sharpen * strength),
      };
      onCreativeChange({
        color: grade,
        colorWorkflow: {
          ...creative.colorWorkflow,
          autoGrade: {
            strength,
            analyzedAt: result.analyzedAt,
            metrics: result.metrics,
            confidence: result.confidence,
          },
          versions: [
            ...creative.colorWorkflow.versions,
            {
              id: beforeId,
              name: `Before auto grade ${new Date().toLocaleTimeString()}`,
              createdAt: new Date().toISOString(),
              source: 'manual' as const,
              grade: { ...creative.color },
              metrics: {},
            },
            {
              id: afterId,
              name: `Auto grade ${new Date().toLocaleTimeString()}`,
              createdAt: new Date().toISOString(),
              source: 'auto' as const,
              grade,
              metrics: result.metrics,
            },
          ].slice(-100),
          selectedVersionId: afterId,
        },
      });
      setNotice(`Auto grade applied at ${Math.round(result.confidence * 100)}% confidence. The previous grade was saved.`);
    },
  });

  const trackingMutation = useMutation({
    mutationFn: ({ mask, face }: { mask: LongformMask; face: boolean }) => {
      if (!selectedClip) throw new Error('Select a clip first.');
      return api.trackLongformMask(projectName, {
        assetId: selectedClip.sourceType === 'asset' ? selectedClip.assetId : null,
        sourceStart: selectedClip.sourceStart,
        sourceEnd: selectedClip.sourceEnd,
        timelineStart: selectedClip.timelineStart,
        rate: selectedClip.speed.rate,
        x: mask.x,
        y: mask.y,
        width: mask.width,
        height: mask.height,
        face,
      });
    },
    onSuccess: (result, variables) => {
      if (!selectedClip) return;
      patchClip(selectedClip.id, {
        masks: selectedClip.masks.map((mask) => mask.id === variables.mask.id
          ? { ...mask, keyframes: result.keyframes, trackingStatus: result.status }
          : mask),
      });
      setNotice(`${variables.face ? 'Face' : 'Region'} tracking completed at ${Math.round(result.confidence * 100)}% confidence.`);
    },
  });

  const backgroundMutation = useMutation({
    mutationFn: () => {
      if (!selectedClip) throw new Error('Select a clip first.');
      return api.suggestLongformBackgroundKey(projectName, {
        assetId: selectedClip.sourceType === 'asset' ? selectedClip.assetId : null,
        time: selectedClip.sourceStart,
      });
    },
    onSuccess: (result) => {
      if (!selectedClip) return;
      patchClip(selectedClip.id, {
        chromaKey: {
          ...selectedClip.chromaKey,
          enabled: true,
          autoBackground: true,
          color: result.color,
          similarity: result.similarity,
          blend: result.blend,
        },
      });
      setNotice(`Background key sampled at ${Math.round(result.confidence * 100)}% confidence.`);
    },
  });

  const qcMutation = useMutation({
    mutationFn: () => api.runLongformQc(projectName, { options, cuts, chapters, creative }),
    onSuccess: setQcReport,
  });
  const publishMutation = useMutation({
    mutationFn: () => api.publishLongformPackage(projectName, { options, cuts, chapters, creative }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['longform-deliveries', projectName] });
      queryClient.invalidateQueries({ queryKey: ['longform-render-queue'] });
      setNotice(result.queued ? `${result.queued} changed delivery variants queued.` : 'Every delivery variant is already current.');
    },
  });
  const reviewMutation = useMutation({
    mutationFn: () => api.createLongformReview(projectName, {
      title: reviewTitle || creative.publish.title || undefined,
      password: reviewPassword || undefined,
      expiryDays: reviewExpiry,
    }),
    onSuccess: (review) => {
      queryClient.invalidateQueries({ queryKey: ['longform-reviews', projectName] });
      setReviewPassword('');
      if (review.url) navigator.clipboard?.writeText(review.url).catch(() => undefined);
      setNotice('Review link created and copied.');
    },
  });
  const saveTemplateMutation = useMutation({
    mutationFn: () => api.createLongformEffectTemplate({
      name: templateName || 'Custom effect stack',
      category: selectedClip ? 'effect' : 'color',
      description: selectedClip ? `Reusable settings from ${selectedClip.name}` : 'Reusable project color grade',
      payload: selectedClip
        ? {
            clip: {
              fit: selectedClip.fit,
              x: selectedClip.x,
              y: selectedClip.y,
              scale: selectedClip.scale,
              rotation: selectedClip.rotation,
              opacity: selectedClip.opacity,
              speed: selectedClip.speed,
              stabilization: selectedClip.stabilization,
              chromaKey: selectedClip.chromaKey,
              masks: selectedClip.masks,
            },
          }
        : { color: creative.color, colorWorkflow: creative.colorWorkflow.management },
    }),
    onSuccess: () => {
      setTemplateName('');
      queryClient.invalidateQueries({ queryKey: ['longform-effect-templates'] });
    },
  });
  const deleteTemplateMutation = useMutation({
    mutationFn: api.deleteLongformEffectTemplate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['longform-effect-templates'] }),
  });

  function patchSequence(patch: Partial<LongformCreativeOptions['sequence']>) {
    onCreativeChange({ sequence: { ...sequenceState, ...patch } });
  }

  function updateActiveSequence(updater: (sequence: LongformSequence) => LongformSequence) {
    if (!activeSequence) return;
    patchSequence({
      sequences: sequenceState.sequences.map((sequence) => sequence.id === activeSequence.id ? updater(sequence) : sequence),
    });
  }

  function patchTrack(trackId: string, patch: Partial<LongformSequenceTrack>) {
    updateActiveSequence((sequence) => ({
      ...sequence,
      tracks: sequence.tracks.map((track) => track.id === trackId ? { ...track, ...patch } : track),
    }));
  }

  function patchClip(clipId: string, patch: Partial<LongformSequenceClip>) {
    updateActiveSequence((sequence) => ({
      ...sequence,
      tracks: sequence.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip),
      })),
    }));
  }

  function addTrack(kind: 'video' | 'audio') {
    updateActiveSequence((sequence) => ({
      ...sequence,
      tracks: [...sequence.tracks, defaultTrack(kind, sequence.tracks.length)],
    }));
  }

  function createProgramClip(): LongformSequenceClip {
    const sourceStart = sequenceState.sourceIn ?? playhead;
    const sourceEnd = sequenceState.sourceOut ?? Math.min(max, sourceStart + 5);
    return defaultClip({
      name: `Program ${formatTime(sourceStart)}–${formatTime(sourceEnd)}`,
      sourceType: 'program',
      sourceStart,
      sourceEnd: Math.max(sourceStart + 0.02, sourceEnd),
      timelineStart: timelinePlayhead,
      timelineEnd: timelinePlayhead + Math.max(0.02, sourceEnd - sourceStart),
      includeAudio: true,
    });
  }

  function insertClip(trackId: string, clip: LongformSequenceClip, mode: 'insert' | 'overwrite' = 'insert') {
    const targetTrack = activeSequence?.tracks.find((track) => track.id === trackId);
    if (!targetTrack || targetTrack.locked) return;
    const duration = clip.timelineEnd - clip.timelineStart;
    updateActiveSequence((sequence) => ({
      ...sequence,
      tracks: sequence.tracks.map((track) => {
        if (track.id !== trackId) return track;
        let clips = track.clips;
        if (mode === 'insert') {
          clips = clips.map((item) => item.timelineStart >= clip.timelineStart
            ? { ...item, timelineStart: item.timelineStart + duration, timelineEnd: item.timelineEnd + duration }
            : item);
        } else {
          clips = clips.flatMap((item) => {
            if (item.timelineEnd <= clip.timelineStart || item.timelineStart >= clip.timelineEnd) return [item];
            const pieces: LongformSequenceClip[] = [];
            if (item.timelineStart < clip.timelineStart - 0.02) {
              pieces.push({ ...item, timelineEnd: clip.timelineStart });
            }
            if (item.timelineEnd > clip.timelineEnd + 0.02) {
              pieces.push({
                ...cloneClip(item),
                sourceStart: item.sourceEnd - (item.timelineEnd - clip.timelineEnd) * item.speed.rate,
                timelineStart: clip.timelineEnd,
              });
            }
            return pieces;
          });
        }
        return { ...track, clips: [...clips, clip].sort((left, right) => left.timelineStart - right.timelineStart) };
      }),
    }));
    setSelectedTrackId(trackId);
    setSelectedClipIds(new Set([clip.id]));
  }

  function liftSelected(extract = false) {
    if (!selectedRows.length) return;
    const selectedIds = new Set(selectedRows.map(({ clip }) => clip.id));
    const earliest = Math.min(...selectedRows.map(({ clip }) => clip.timelineStart));
    const latest = Math.max(...selectedRows.map(({ clip }) => clip.timelineEnd));
    const duration = latest - earliest;
    updateActiveSequence((sequence) => ({
      ...sequence,
      tracks: sequence.tracks.map((track) => ({
        ...track,
        clips: track.clips
          .filter((clip) => !selectedIds.has(clip.id))
          .map((clip) => extract && clip.timelineStart >= latest
            ? { ...clip, timelineStart: clip.timelineStart - duration, timelineEnd: clip.timelineEnd - duration }
            : clip),
      })),
    }));
    setSelectedClipIds(new Set());
  }

  function replaceSelected() {
    if (!selectedClip) return;
    const sourceStart = sequenceState.sourceIn ?? playhead;
    const sourceEnd = sequenceState.sourceOut ?? Math.min(max, sourceStart + (selectedClip.timelineEnd - selectedClip.timelineStart));
    patchClip(selectedClip.id, {
      sourceType: 'program',
      assetId: null,
      nestedSequenceId: null,
      name: `Program ${formatTime(sourceStart)}`,
      sourceStart,
      sourceEnd,
    });
  }

  function copySelected() {
    setClipboard(selectedRows.map(({ track, clip }) => ({ trackKind: track.kind, clip: cloneClip(clip, -clip.timelineStart) })));
    setNotice(`${selectedRows.length} clip${selectedRows.length === 1 ? '' : 's'} copied.`);
  }

  function pasteClipboard() {
    if (!activeSequence || !clipboard.length) return;
    const created: string[] = [];
    let sequences = activeSequence;
    for (const entry of clipboard) {
      const track = sequences.tracks.find((item) => item.kind === entry.trackKind && !item.locked)
        || sequences.tracks[0];
      if (!track) continue;
      const clip = cloneClip(entry.clip, timelinePlayhead);
      created.push(clip.id);
      sequences = {
        ...sequences,
        tracks: sequences.tracks.map((item) => item.id === track.id
          ? { ...item, clips: [...item.clips, clip].sort((left, right) => left.timelineStart - right.timelineStart) }
          : item),
      };
    }
    updateActiveSequence(() => sequences);
    setSelectedClipIds(new Set(created));
  }

  function assignGroup(field: 'linkedGroupId' | 'compoundId') {
    if (!selectedRows.length) return;
    const groupId = `${field === 'linkedGroupId' ? 'linked' : 'compound'}-${Date.now()}`;
    const ids = new Set(selectedRows.map(({ clip }) => clip.id));
    updateActiveSequence((sequence) => ({
      ...sequence,
      tracks: sequence.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ids.has(clip.id) ? { ...clip, [field]: groupId } : clip),
      })),
    }));
  }

  function nestSelected() {
    if (!activeSequence || !selectedRows.length) return;
    const earliest = Math.min(...selectedRows.map(({ clip }) => clip.timelineStart));
    const latest = Math.max(...selectedRows.map(({ clip }) => clip.timelineEnd));
    const ids = new Set(selectedRows.map(({ clip }) => clip.id));
    const nestedId = `sequence-${Date.now()}`;
    const nestedTracks = activeSequence.tracks.flatMap((track) => {
      const clips = track.clips.filter((clip) => ids.has(clip.id)).map((clip) => ({
        ...cloneClip(clip, -earliest),
        timelineStart: clip.timelineStart - earliest,
        timelineEnd: clip.timelineEnd - earliest,
      }));
      return clips.length ? [{ ...track, id: `${track.id}-${nestedId}`, clips }] : [];
    });
    const targetTrack = selectedRows.find(({ track }) => track.kind === 'video')?.track
      || activeSequence.tracks.find((track) => track.kind === 'video');
    if (!targetTrack) return;
    const nestedClip = defaultClip({
      name: `Compound ${sequenceState.sequences.length + 1}`,
      sourceType: 'sequence',
      nestedSequenceId: nestedId,
      sourceStart: 0,
      sourceEnd: latest - earliest,
      timelineStart: earliest,
      timelineEnd: latest,
      includeAudio: true,
      compoundId: `compound-${Date.now()}`,
    });
    patchSequence({
      sequences: [
        ...sequenceState.sequences.map((sequence) => sequence.id === activeSequence.id
          ? {
              ...sequence,
              tracks: sequence.tracks.map((track) => ({
                ...track,
                clips: [
                  ...track.clips.filter((clip) => !ids.has(clip.id)),
                  ...(track.id === targetTrack.id ? [nestedClip] : []),
                ].sort((left, right) => left.timelineStart - right.timelineStart),
              })),
            }
          : sequence),
        {
          id: nestedId,
          name: nestedClip.name,
          frameRate: activeSequence.frameRate,
          width: activeSequence.width,
          height: activeSequence.height,
          tracks: nestedTracks,
        },
      ],
    });
    setSelectedClipIds(new Set([nestedClip.id]));
  }

  function selectClip(event: React.MouseEvent, trackId: string, clipId: string) {
    setSelectedTrackId(trackId);
    setSelectedClipIds((current) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        const next = new Set(current);
        if (next.has(clipId)) next.delete(clipId);
        else next.add(clipId);
        return next;
      }
      return new Set([clipId]);
    });
  }

  function timelineDrop(event: DragEvent<HTMLDivElement>, track: LongformSequenceTrack) {
    event.preventDefault();
    if (track.locked) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dropTime = clamp(((event.clientX - rect.left) / Math.max(1, rect.width)) * sequenceDuration, 0, sequenceDuration);
    const assetId = event.dataTransfer.getData('application/x-vcf-asset')
      || event.dataTransfer.getData('application/x-longform-asset');
    const clipReference = event.dataTransfer.getData('application/x-vcf-clip');
    if (assetId) {
      const asset = assets.find((item) => item.id === assetId);
      if (!asset) return;
      insertClip(track.id, defaultClip({
        name: asset.name,
        sourceType: 'asset',
        assetId: asset.id,
        sourceStart: 0,
        sourceEnd: asset.durationSec || 5,
        timelineStart: dropTime,
        timelineEnd: dropTime + (asset.durationSec || 5),
        includeAudio: track.kind === 'video' && asset.mediaType === 'video',
      }), 'overwrite');
      return;
    }
    if (clipReference) {
      const [sourceTrackId, clipId] = clipReference.split('|');
      const sourceTrack = activeSequence?.tracks.find((item) => item.id === sourceTrackId);
      const clip = sourceTrack?.clips.find((item) => item.id === clipId);
      if (!sourceTrack || !clip) return;
      const duration = clip.timelineEnd - clip.timelineStart;
      updateActiveSequence((sequence) => ({
        ...sequence,
        tracks: sequence.tracks.map((item) => {
          const without = item.id === sourceTrackId ? item.clips.filter((candidate) => candidate.id !== clipId) : item.clips;
          return item.id === track.id
            ? { ...item, clips: [...without, { ...clip, timelineStart: dropTime, timelineEnd: dropTime + duration }] }
            : { ...item, clips: without };
        }),
      }));
      setSelectedTrackId(track.id);
    }
  }

  function addMask(type: LongformMask['type'], effect: LongformMask['effect'] = 'blur') {
    if (!selectedClip) return;
    const mask: LongformMask = {
      id: `mask-${Date.now()}`,
      name: `${type[0].toUpperCase()}${type.slice(1)} ${selectedClip.masks.length + 1}`,
      enabled: true,
      type,
      effect,
      x: 0.3,
      y: 0.3,
      width: 0.25,
      height: 0.25,
      rotation: 0,
      feather: type === 'ellipse' ? 0.16 : 0.08,
      strength: effect === 'mosaic' ? 30 : 18,
      invert: false,
      fillColor: '#000000',
      points: [],
      keyframes: [],
      trackingStatus: 'idle',
    };
    patchClip(selectedClip.id, { masks: [...selectedClip.masks, mask] });
  }

  function saveManualGrade() {
    const versionId = `grade-manual-${Date.now()}`;
    onCreativeChange({
      colorWorkflow: {
        ...creative.colorWorkflow,
        versions: [...creative.colorWorkflow.versions, {
          id: versionId,
          name: `Manual grade ${new Date().toLocaleTimeString()}`,
          createdAt: new Date().toISOString(),
          source: 'manual' as const,
          grade: { ...creative.color },
          metrics: {},
        }].slice(-100),
        selectedVersionId: versionId,
      },
    });
  }

  function restoreGrade(versionId: string) {
    const version = creative.colorWorkflow.versions.find((item) => item.id === versionId);
    if (!version) return;
    onCreativeChange({
      color: { ...version.grade },
      colorWorkflow: { ...creative.colorWorkflow, selectedVersionId: version.id },
    });
  }

  function compareBefore(active: boolean) {
    const video = videoRef.current;
    if (!video) return;
    if (active) {
      compareFilterRef.current = video.style.filter;
      video.style.filter = 'none';
    } else if (compareFilterRef.current !== null) {
      video.style.filter = compareFilterRef.current;
      compareFilterRef.current = null;
    }
  }

  function addColorGroup() {
    if (!selectedRows.length) return;
    const groupId = `color-group-${Date.now()}`;
    onCreativeChange({
      colorWorkflow: {
        ...creative.colorWorkflow,
        groups: [...creative.colorWorkflow.groups, {
          id: groupId,
          name: `Shot group ${creative.colorWorkflow.groups.length + 1}`,
          clipIds: selectedRows.map(({ clip }) => clip.id),
          grade: { ...creative.color },
        }],
      },
    });
  }

  function importReviewMarkers(review: LongformReview) {
    const existingIds = new Set(sequenceState.markers.map((marker) => marker.id));
    patchSequence({
      markers: [
        ...sequenceState.markers,
        ...review.comments.flatMap((comment) => {
          const markerId = `review-${review.token}-${comment.id}`;
          if (existingIds.has(markerId)) return [];
          return [{
            id: markerId,
            time: comment.time,
            label: `${comment.author}: ${comment.text}`,
            color: comment.resolved ? '#22C55E' : '#F59E0B',
            source: 'review' as const,
            resolved: comment.resolved,
          }];
        }),
      ].sort((left, right) => left.time - right.time),
    });
  }

  function addQcMarker(issue: LongformQcReport['issues'][number]) {
    const markerId = `qc-${issue.id}`;
    if (sequenceState.markers.some((marker) => marker.id === markerId)) return;
    patchSequence({
      markers: [...sequenceState.markers, {
        id: markerId,
        time: issue.time,
        label: `${issue.title}: ${issue.detail}`,
        color: issue.severity === 'error' ? '#EF4444' : issue.severity === 'warning' ? '#F59E0B' : '#38BDF8',
        source: 'qc' as const,
        resolved: false,
      }].sort((left, right) => left.time - right.time),
    });
  }

  function applyTemplate(template: LongformEffectTemplate) {
    const payload = template.payload as Record<string, unknown>;
    if (payload.clip && selectedClip) {
      patchClip(selectedClip.id, payload.clip as Partial<LongformSequenceClip>);
    }
    if (payload.mask && selectedClip) {
      addMask(
        ((payload.mask as { type?: LongformMask['type'] }).type || 'rectangle'),
        ((payload.mask as { effect?: LongformMask['effect'] }).effect || 'blur'),
      );
    }
    if (payload.transition && selectedClip) {
      const transition = payload.transition as { type?: LongformTransitionType; duration?: number };
      patchClip(selectedClip.id, {
        transitionIn: {
          type: transition.type || 'dissolve',
          duration: transition.duration ?? 0.35,
        },
      });
    }
    if (payload.audio) {
      onCreativeChange({ audio: { ...creative.audio, ...(payload.audio as Partial<typeof creative.audio>) } });
    }
    if (payload.color) {
      onCreativeChange({ color: { ...creative.color, ...(payload.color as Partial<LongformColorGrade>) } });
    }
    if (payload.title) {
      const titlePayload = payload.title as Partial<LongformCreativeOptions['titles'][number]>;
      onCreativeChange({
        titles: [...creative.titles, {
          id: `title-${Date.now()}`,
          text: template.name,
          subtitle: '',
          start: playhead,
          end: Math.min(max, playhead + 4),
          style: 'lower_third',
          template: 'broadcast',
          alignment: 'left',
          animation: 'slide',
          accentColor: '#8B5CF6',
          backgroundColor: '#09090B',
          textColor: '#FFFFFF',
          x: 0.055,
          y: 0.69,
          width: 0.56,
          scale: 1,
          ...titlePayload,
        }],
      });
    }
    setNotice(`${template.name} applied.`);
  }

  const operationError = autoGradeMutation.error
    || trackingMutation.error
    || backgroundMutation.error
    || qcMutation.error
    || publishMutation.error
    || reviewMutation.error
    || saveTemplateMutation.error
    || deleteTemplateMutation.error;

  return (
    <div className={clsx(embedded ? 'min-w-0 overflow-hidden bg-[#151515]' : 'panel-elev overflow-hidden')}>
      {showTabs && <div className="border-b border-white/5 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <SquareStack className="h-4 w-4 text-cyan-300" /> Editor v3 workspace
            </div>
            <p className="mt-1 max-w-4xl text-xs leading-relaxed text-slate-500">
              Multi-track sequences, time remapping, tracked effects, reversible color, ADR, review, QC, interchange, and linked delivery packages.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="chip">{selectedRows.length} selected</span>
            <span className="chip">{activeSequence?.tracks.length || 0} tracks</span>
            <span className="chip">{formatTime(timelinePlayhead)}</span>
          </div>
        </div>
        <div className="mt-4 flex gap-1 overflow-x-auto pb-1 scrollbar-thin">
          {TABS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={clsx(
                  'flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[10px] font-semibold transition',
                  tab === item.id ? 'bg-cyan-500/15 text-cyan-100 ring-1 ring-inset ring-cyan-400/20' : 'text-slate-500 hover:bg-white/5 hover:text-slate-300',
                )}
                onClick={() => setTab(item.id)}
              >
                <Icon className="h-3.5 w-3.5" /> {item.label}
              </button>
            );
          })}
        </div>
      </div>}

      {tab === 'timeline' && (
        <SequenceWorkspace
          sequenceState={sequenceState}
          activeSequence={activeSequence}
          assets={assets}
          selectedClipIds={selectedClipIds}
          selectedTrackId={selectedTrackId}
          timelinePlayhead={timelinePlayhead}
          sequenceDuration={sequenceDuration}
          min={min}
          max={max}
          playhead={playhead}
          uploading={uploading}
          clipboardCount={clipboard.length}
          onPatchSequence={patchSequence}
          onUpdateActive={updateActiveSequence}
          onPatchTrack={patchTrack}
          onSelectClip={selectClip}
          onSelectTrack={setSelectedTrackId}
          onDrop={timelineDrop}
          onUpload={onUpload}
          onSeek={onSeek}
          onAddTrack={addTrack}
          onInsertProgram={(mode) => {
            const track = selectedTrack?.kind === 'video'
              ? selectedTrack
              : activeSequence?.tracks.find((item) => item.kind === 'video');
            if (track) insertClip(track.id, createProgramClip(), mode);
          }}
          onReplace={replaceSelected}
          onLift={() => liftSelected(false)}
          onExtract={() => liftSelected(true)}
          onCopy={copySelected}
          onPaste={pasteClipboard}
          onLink={() => assignGroup('linkedGroupId')}
          onGroup={() => assignGroup('compoundId')}
          onNest={nestSelected}
        />
      )}
      {tab === 'effects' && (
        <TimeEffectsWorkspace
          clip={selectedClip}
          templates={templatesQuery.data || []}
          busy={trackingMutation.isPending || backgroundMutation.isPending}
          timelinePlayhead={timelinePlayhead}
          onPatch={(patch) => selectedClip && patchClip(selectedClip.id, patch)}
          onAddMask={addMask}
          onTrack={(mask, face) => trackingMutation.mutate({ mask, face })}
          onAutoBackground={() => backgroundMutation.mutate()}
          onApplyTemplate={applyTemplate}
        />
      )}
      {tab === 'color' && (
        <ColorWorkspace
          creative={creative}
          luts={luts}
          busy={autoGradeMutation.isPending}
          uploading={uploading}
          onCreativeChange={onCreativeChange}
          onUpload={onUpload}
          onAutoGrade={() => autoGradeMutation.mutate()}
          onSaveVersion={saveManualGrade}
          onRestoreVersion={restoreGrade}
          onCompare={compareBefore}
          onAddGroup={addColorGroup}
          selectedCount={selectedRows.length}
        />
      )}
      {tab === 'voiceover' && (
        <VoiceoverWorkspace
          projectName={projectName}
          creative={creative}
          assets={voiceoverAssets}
          playhead={playhead}
          min={min}
          max={max}
          uploading={uploading}
          selectedClip={selectedClip}
          videoRef={videoRef}
          onCreativeChange={onCreativeChange}
          onUpload={onUpload}
          onSeek={onSeek}
          onPatchClip={(patch) => selectedClip && patchClip(selectedClip.id, patch)}
        />
      )}
      {tab === 'publish' && (
        <PublishWorkspace
          creative={creative}
          deliveries={deliveriesQuery.data || []}
          busy={publishMutation.isPending}
          onCreativeChange={onCreativeChange}
          onPublish={() => publishMutation.mutate()}
        />
      )}
      {tab === 'review' && (
        <ReviewWorkspace
          reviews={reviewsQuery.data || []}
          title={reviewTitle}
          password={reviewPassword}
          expiry={reviewExpiry}
          busy={reviewMutation.isPending}
          onTitle={setReviewTitle}
          onPassword={setReviewPassword}
          onExpiry={setReviewExpiry}
          onCreate={() => reviewMutation.mutate()}
          onImportMarkers={importReviewMarkers}
          onSeek={onSeek}
        />
      )}
      {tab === 'qc' && (
        <QcWorkspace
          report={qcReport}
          busy={qcMutation.isPending}
          markers={sequenceState.markers}
          onRun={() => qcMutation.mutate()}
          onSeek={onSeek}
          onAddMarker={addQcMarker}
          onResolveMarker={(markerId) => patchSequence({
            markers: sequenceState.markers.map((marker) => marker.id === markerId ? { ...marker, resolved: !marker.resolved } : marker),
          })}
        />
      )}
      {tab === 'interchange' && (
        <InterchangeWorkspace projectName={projectName} />
      )}
      {tab === 'templates' && (
        <TemplateWorkspace
          templates={templatesQuery.data || []}
          name={templateName}
          busy={saveTemplateMutation.isPending || deleteTemplateMutation.isPending}
          canSaveClip={Boolean(selectedClip)}
          onName={setTemplateName}
          onSave={() => saveTemplateMutation.mutate()}
          onApply={applyTemplate}
          onDelete={(id) => deleteTemplateMutation.mutate(id)}
          onImport={async (templates) => {
            await api.importLongformEffectTemplates(templates);
            queryClient.invalidateQueries({ queryKey: ['longform-effect-templates'] });
          }}
        />
      )}

      {(notice || operationError) && (
        <div className={clsx(
          'border-t px-5 py-3 text-xs',
          operationError ? 'border-red-500/20 bg-red-500/10 text-red-200' : 'border-cyan-500/20 bg-cyan-500/10 text-cyan-100',
        )}>
          {operationError ? errorText(operationError) : notice}
        </div>
      )}
    </div>
  );
}

function SequenceWorkspace({
  sequenceState,
  activeSequence,
  assets,
  selectedClipIds,
  selectedTrackId,
  timelinePlayhead,
  sequenceDuration,
  min,
  max,
  playhead,
  uploading,
  clipboardCount,
  onPatchSequence,
  onUpdateActive,
  onPatchTrack,
  onSelectClip,
  onSelectTrack,
  onDrop,
  onUpload,
  onSeek,
  onAddTrack,
  onInsertProgram,
  onReplace,
  onLift,
  onExtract,
  onCopy,
  onPaste,
  onLink,
  onGroup,
  onNest,
}: {
  sequenceState: LongformCreativeOptions['sequence'];
  activeSequence?: LongformSequence;
  assets: LongformMediaAsset[];
  selectedClipIds: Set<string>;
  selectedTrackId: string;
  timelinePlayhead: number;
  sequenceDuration: number;
  min: number;
  max: number;
  playhead: number;
  uploading: boolean;
  clipboardCount: number;
  onPatchSequence: (patch: Partial<LongformCreativeOptions['sequence']>) => void;
  onUpdateActive: (updater: (sequence: LongformSequence) => LongformSequence) => void;
  onPatchTrack: (trackId: string, patch: Partial<LongformSequenceTrack>) => void;
  onSelectClip: (event: React.MouseEvent, trackId: string, clipId: string) => void;
  onSelectTrack: (trackId: string) => void;
  onDrop: (event: DragEvent<HTMLDivElement>, track: LongformSequenceTrack) => void;
  onUpload: EditorV3WorkspaceProps['onUpload'];
  onSeek: (time: number) => void;
  onAddTrack: (kind: 'video' | 'audio') => void;
  onInsertProgram: (mode: 'insert' | 'overwrite') => void;
  onReplace: () => void;
  onLift: () => void;
  onExtract: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onLink: () => void;
  onGroup: () => void;
  onNest: () => void;
}) {
  const mediaAssets = assets.filter((asset) => ['media', 'broll', 'angle', 'music', 'voiceover'].includes(asset.kind));
  if (!activeSequence) return <EmptyState>No sequence is available.</EmptyState>;
  return (
    <div className="grid xl:grid-cols-[270px_minmax(0,1fr)]">
      <aside className="border-b border-white/5 p-4 xl:border-b-0 xl:border-r">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-semibold text-white">Media bin</div>
            <p className="mt-1 text-[10px] text-slate-600">Drag media onto any unlocked compatible track.</p>
          </div>
          <label className="btn-secondary h-8 cursor-pointer px-2 text-[10px]">
            <Upload className="h-3 w-3" /> {uploading ? 'Uploading' : 'Media'}
            <input
              className="hidden"
              type="file"
              accept="video/*,audio/*,image/*"
              disabled={uploading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUpload('media', file);
                event.currentTarget.value = '';
              }}
            />
          </label>
        </div>
        <div className="mt-3 max-h-72 space-y-1 overflow-y-auto pr-1 scrollbar-thin">
          {mediaAssets.map((asset) => (
            <div
              key={asset.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-vcf-asset', asset.id);
                event.dataTransfer.setData('application/x-longform-asset', asset.id);
              }}
              className="flex cursor-grab items-center gap-2 rounded-lg border border-white/5 bg-black/20 px-2 py-2 text-[10px] text-slate-400 hover:border-cyan-400/20 hover:text-white"
            >
              {['music', 'voiceover'].includes(asset.kind) ? <AudioLines className="h-3.5 w-3.5 text-emerald-300" /> : <Film className="h-3.5 w-3.5 text-cyan-300" />}
              <span className="min-w-0 flex-1 truncate">{asset.name}</span>
              <span className="uppercase text-[8px] text-slate-700">{asset.kind}</span>
            </div>
          ))}
          {!mediaAssets.length && <EmptyState>Upload video, audio, or stills to build the media bin.</EmptyState>}
        </div>

        <div className="mt-5 border-t border-white/5 pt-4">
          <div className="text-xs font-semibold text-white">Source monitor</div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <MiniNumber
              label="In"
              value={sequenceState.sourceIn ?? playhead}
              min={min}
              max={sequenceState.sourceOut ?? max}
              step={0.01}
              onChange={(sourceIn) => onPatchSequence({ sourceIn })}
            />
            <MiniNumber
              label="Out"
              value={sequenceState.sourceOut ?? Math.min(max, playhead + 5)}
              min={sequenceState.sourceIn ?? min}
              max={max}
              step={0.01}
              onChange={(sourceOut) => onPatchSequence({ sourceOut })}
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button className="btn-secondary h-8 text-[10px]" onClick={() => onPatchSequence({ sourceIn: playhead })}>Mark In</button>
            <button className="btn-secondary h-8 text-[10px]" onClick={() => onPatchSequence({ sourceOut: playhead })}>Mark Out</button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button className="btn-primary h-8 text-[10px]" onClick={() => onInsertProgram('insert')}>Insert</button>
            <button className="btn-secondary h-8 text-[10px]" onClick={() => onInsertProgram('overwrite')}>Overwrite</button>
          </div>
        </div>

        <div className="mt-5 border-t border-white/5 pt-4">
          <label>
            <span className="label">Sequence</span>
            <select
              className="input h-9 text-xs"
              value={sequenceState.activeSequenceId}
              onChange={(event) => onPatchSequence({ activeSequenceId: event.target.value })}
            >
              {sequenceState.sequences.map((sequence) => <option key={sequence.id} value={sequence.id}>{sequence.name}</option>)}
            </select>
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Toggle label="Use sequence" checked={sequenceState.enabled} onChange={(enabled) => onPatchSequence({ enabled })} />
            <Toggle label="Replace base" checked={sequenceState.mode === 'replace'} onChange={(replace) => onPatchSequence({ mode: replace ? 'replace' : 'composite' })} />
          </div>
          <button
            className="btn-secondary mt-2 w-full text-[10px]"
            onClick={() => {
              const id = `sequence-${Date.now()}`;
              onPatchSequence({
                activeSequenceId: id,
                sequences: [...sequenceState.sequences, {
                  id,
                  name: `Sequence ${sequenceState.sequences.length + 1}`,
                  frameRate: activeSequence.frameRate,
                  width: activeSequence.width,
                  height: activeSequence.height,
                  tracks: [defaultTrack('video', 0), defaultTrack('audio', 1)],
                }],
              });
            }}
          >
            <Plus className="h-3 w-3" /> New sequence
          </button>
        </div>
      </aside>

      <section className="min-w-0 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1">
            <button className="btn-secondary h-8 px-2 text-[9px]" onClick={() => onAddTrack('video')}><Plus className="h-3 w-3" /> Video track</button>
            <button className="btn-secondary h-8 px-2 text-[9px]" onClick={() => onAddTrack('audio')}><Plus className="h-3 w-3" /> Audio track</button>
            <button className="btn-secondary h-8 px-2 text-[9px]" disabled={!selectedClipIds.size} onClick={onReplace}>Replace</button>
            <button className="btn-secondary h-8 px-2 text-[9px]" disabled={!selectedClipIds.size} onClick={onLift}>Lift</button>
            <button className="btn-secondary h-8 px-2 text-[9px]" disabled={!selectedClipIds.size} onClick={onExtract}>Extract</button>
          </div>
          <div className="flex flex-wrap gap-1">
            <button className="btn-secondary h-8 px-2 text-[9px]" disabled={!selectedClipIds.size} onClick={onCopy}><Copy className="h-3 w-3" /> Copy</button>
            <button className="btn-secondary h-8 px-2 text-[9px]" disabled={!clipboardCount} onClick={onPaste}><Clipboard className="h-3 w-3" /> Paste</button>
            <button className="btn-secondary h-8 px-2 text-[9px]" disabled={selectedClipIds.size < 2} onClick={onLink}><Link2 className="h-3 w-3" /> Link</button>
            <button className="btn-secondary h-8 px-2 text-[9px]" disabled={!selectedClipIds.size} onClick={onGroup}><Group className="h-3 w-3" /> Group</button>
            <button className="btn-secondary h-8 px-2 text-[9px]" disabled={!selectedClipIds.size} onClick={onNest}><SquareStack className="h-3 w-3" /> Compound</button>
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-white/5 bg-black/25">
          <div className="grid grid-cols-[150px_minmax(680px,1fr)] border-b border-white/5 bg-white/[0.025]">
            <div className="px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-600">Tracks</div>
            <div className="relative h-9">
              {Array.from({ length: 9 }, (_, index) => (
                <span
                  key={index}
                  className="absolute top-2 font-mono text-[8px] text-slate-700"
                  style={{ left: `${(index / 8) * 100}%` }}
                >
                  {formatTime((index / 8) * sequenceDuration)}
                </span>
              ))}
              <span className="absolute bottom-0 top-0 w-px bg-pink-400/80" style={{ left: `${clamp(timelinePlayhead / sequenceDuration, 0, 1) * 100}%` }} />
            </div>
          </div>
          <div className="max-h-[620px] overflow-auto scrollbar-thin">
            {activeSequence.tracks.map((track) => (
              <div key={track.id} className="grid min-w-[830px] grid-cols-[150px_minmax(680px,1fr)] border-b border-white/5 last:border-b-0">
                <div className={clsx('p-2', selectedTrackId === track.id && 'bg-cyan-500/5')} onClick={() => onSelectTrack(track.id)}>
                  <input
                    className="w-full bg-transparent text-[10px] font-semibold text-slate-300 outline-none"
                    value={track.name}
                    onChange={(event) => onPatchTrack(track.id, { name: event.target.value })}
                  />
                  <div className="mt-2 flex items-center gap-1">
                    <TrackButton active={track.locked} title="Lock" onClick={() => onPatchTrack(track.id, { locked: !track.locked })}>{track.locked ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}</TrackButton>
                    {track.kind === 'video' ? (
                      <TrackButton active={track.hidden} title="Hide" onClick={() => onPatchTrack(track.id, { hidden: !track.hidden })}>{track.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}</TrackButton>
                    ) : (
                      <TrackButton active={track.muted} title="Mute" onClick={() => onPatchTrack(track.id, { muted: !track.muted })}>M</TrackButton>
                    )}
                    <TrackButton active={track.solo} title="Solo" onClick={() => onPatchTrack(track.id, { solo: !track.solo })}>S</TrackButton>
                    <TrackButton active={track.linked} title="Linked edits" onClick={() => onPatchTrack(track.id, { linked: !track.linked })}><Link2 className="h-3 w-3" /></TrackButton>
                    <button
                      className="ml-auto grid h-6 w-6 place-items-center text-slate-700 hover:text-red-300"
                      onClick={() => onUpdateActive((sequence) => ({ ...sequence, tracks: sequence.tracks.filter((item) => item.id !== track.id) }))}
                      title="Delete track"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <div
                  className={clsx(
                    'relative h-20 bg-[linear-gradient(to_right,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:6.25%_100%]',
                    track.kind === 'audio' ? 'bg-emerald-500/[0.025]' : 'bg-cyan-500/[0.025]',
                  )}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => onDrop(event, track)}
                  onDoubleClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const time = ((event.clientX - rect.left) / rect.width) * sequenceDuration;
                    onSeek(min + time);
                  }}
                >
                  <span className="absolute bottom-0 top-0 z-20 w-px bg-pink-400/70" style={{ left: `${clamp(timelinePlayhead / sequenceDuration, 0, 1) * 100}%` }} />
                  {track.clips.map((clip) => {
                    const left = clamp(clip.timelineStart / sequenceDuration, 0, 1) * 100;
                    const width = Math.max(0.75, ((clip.timelineEnd - clip.timelineStart) / sequenceDuration) * 100);
                    const selected = selectedClipIds.has(clip.id);
                    return (
                      <button
                        key={clip.id}
                        draggable={!track.locked}
                        onDragStart={(event) => event.dataTransfer.setData('application/x-vcf-clip', `${track.id}|${clip.id}`)}
                        onClick={(event) => onSelectClip(event, track.id, clip.id)}
                        className={clsx(
                          'absolute top-2 h-16 overflow-hidden rounded-lg border px-2 text-left shadow-lg transition',
                          track.kind === 'audio'
                            ? 'border-emerald-400/20 bg-emerald-500/15'
                            : 'border-cyan-400/20 bg-cyan-500/15',
                          selected && 'z-10 border-pink-300/60 bg-pink-500/20 ring-2 ring-pink-400/30',
                          !clip.enabled && 'opacity-40',
                        )}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`${clip.name} ${formatTime(clip.timelineStart)}–${formatTime(clip.timelineEnd)}`}
                      >
                        <span className="block truncate text-[9px] font-semibold text-white">{clip.name}</span>
                        <span className="mt-1 block truncate font-mono text-[8px] text-slate-500">
                          {clip.speed.reverse ? 'REV ' : ''}{clip.speed.freeze ? 'FREEZE ' : ''}{clip.speed.rate.toFixed(2)}x
                        </span>
                        <span className="mt-1 block truncate text-[8px] text-slate-600">{clip.sourceType}{clip.compoundId ? ' · compound' : ''}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[9px] text-slate-600">
          <span>Ctrl/Shift-click for multi-select.</span>
          <span>Drag clips to move between tracks.</span>
          <span>Double-click a track lane to seek.</span>
          <span>Copy/paste works across nested sequences.</span>
        </div>
      </section>
    </div>
  );
}

function TimeEffectsWorkspace({
  clip,
  templates,
  busy,
  timelinePlayhead,
  onPatch,
  onAddMask,
  onTrack,
  onAutoBackground,
  onApplyTemplate,
}: {
  clip: LongformSequenceClip | null;
  templates: LongformEffectTemplate[];
  busy: boolean;
  timelinePlayhead: number;
  onPatch: (patch: Partial<LongformSequenceClip>) => void;
  onAddMask: (type: LongformMask['type'], effect?: LongformMask['effect']) => void;
  onTrack: (mask: LongformMask, face: boolean) => void;
  onAutoBackground: () => void;
  onApplyTemplate: (template: LongformEffectTemplate) => void;
}) {
  if (!clip) return <EmptyState>Select a sequence clip to edit speed, transitions, stabilization, keying, masks, and tracking.</EmptyState>;
  const patchSpeed = (patch: Partial<LongformSequenceClip['speed']>) => onPatch({ speed: { ...clip.speed, ...patch } });
  const patchMask = (maskId: string, patch: Partial<LongformMask>) => onPatch({
    masks: clip.masks.map((mask) => mask.id === maskId ? { ...mask, ...patch } : mask),
  });
  const fxTemplates = templates.filter((template) => ['effect', 'mask', 'transition'].includes(template.category));
  return (
    <div className="grid divide-y divide-white/5 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
      <section className="space-y-5 p-4 sm:p-5">
        <div>
          <div className="text-xs font-semibold text-white">Time remapping</div>
          <p className="mt-1 text-[10px] text-slate-600">Constant speed, piecewise ramps, reverse, freeze frames, optical flow, and pitch-preserved audio.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ToolRange label="Speed" value={clip.speed.rate} min={0.05} max={16} step={0.05} suffix="x" onChange={(rate) => patchSpeed({ rate })} />
            <ToolRange label="Freeze source offset" value={clip.speed.freezeAt} min={0} max={Math.max(0, clip.sourceEnd - clip.sourceStart)} step={0.01} suffix="s" onChange={(freezeAt) => patchSpeed({ freezeAt })} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Toggle label="Reverse" checked={clip.speed.reverse} onChange={(reverse) => patchSpeed({ reverse })} />
            <Toggle label="Freeze" checked={clip.speed.freeze} onChange={(freeze) => patchSpeed({ freeze })} />
            <Toggle label="Optical flow" checked={clip.speed.opticalFlow} onChange={(opticalFlow) => patchSpeed({ opticalFlow })} />
            <Toggle label="Keep pitch" checked={clip.speed.pitchPreserve} onChange={(pitchPreserve) => patchSpeed({ pitchPreserve })} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="btn-secondary h-8 px-2 text-[10px]"
              onClick={() => {
                const sourceTime = clamp((timelinePlayhead - clip.timelineStart) * clip.speed.rate, 0, clip.sourceEnd - clip.sourceStart);
                patchSpeed({
                  keyframes: [...clip.speed.keyframes, {
                    id: `speed-${Date.now()}`,
                    sourceTime,
                    speed: clip.speed.rate,
                  }].sort((left, right) => left.sourceTime - right.sourceTime),
                });
              }}
            >
              <Plus className="h-3 w-3" /> Add ramp point
            </button>
            <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => patchSpeed({ keyframes: [] })}>Clear ramp</button>
          </div>
          <div className="mt-2 space-y-1">
            {clip.speed.keyframes.map((keyframe) => (
              <div key={keyframe.id} className="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-lg bg-black/20 p-2">
                <MiniNumber label="Source time" value={keyframe.sourceTime} min={0} max={clip.sourceEnd - clip.sourceStart} step={0.01} onChange={(sourceTime) => patchSpeed({ keyframes: clip.speed.keyframes.map((item) => item.id === keyframe.id ? { ...item, sourceTime } : item) })} />
                <MiniNumber label="Speed" value={keyframe.speed} min={0.05} max={16} step={0.05} onChange={(speed) => patchSpeed({ keyframes: clip.speed.keyframes.map((item) => item.id === keyframe.id ? { ...item, speed } : item) })} />
                <button className="mt-4 grid h-8 w-8 place-items-center text-slate-600 hover:text-red-300" onClick={() => patchSpeed({ keyframes: clip.speed.keyframes.filter((item) => item.id !== keyframe.id) })}><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-white/5 pt-4">
          <div className="text-xs font-semibold text-white">Clip transitions & transform</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <TransitionControl label="Transition in" value={clip.transitionIn} onChange={(transitionIn) => onPatch({ transitionIn, fadeIn: transitionIn.type === 'cut' ? clip.fadeIn : transitionIn.duration })} />
            <TransitionControl label="Transition out" value={clip.transitionOut} onChange={(transitionOut) => onPatch({ transitionOut, fadeOut: transitionOut.type === 'cut' ? clip.fadeOut : transitionOut.duration })} />
            <ToolRange label="Scale" value={clip.scale} min={0.05} max={8} step={0.01} onChange={(scale) => onPatch({ scale })} />
            <ToolRange label="Rotation" value={clip.rotation} min={-180} max={180} step={0.5} suffix="°" onChange={(rotation) => onPatch({ rotation })} />
            <ToolRange label="Position X" value={clip.x} min={-1} max={1} step={0.01} onChange={(x) => onPatch({ x })} />
            <ToolRange label="Position Y" value={clip.y} min={-1} max={1} step={0.01} onChange={(y) => onPatch({ y })} />
            <ToolRange label="Opacity" value={clip.opacity} min={0} max={1} step={0.01} onChange={(opacity) => onPatch({ opacity })} />
            <label>
              <span className="label">Fit</span>
              <select className="input h-9 text-xs" value={clip.fit} onChange={(event) => onPatch({ fit: event.target.value as LongformSequenceClip['fit'] })}>
                <option value="cover">Cover</option>
                <option value="contain">Contain</option>
                <option value="stretch">Stretch</option>
                <option value="native">Native</option>
              </select>
            </label>
          </div>
        </div>

        <div className="border-t border-white/5 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-white">Stabilization & rolling shutter</div>
              <p className="mt-1 text-[10px] text-slate-600">Realtime deshake is rendered per clip; two-pass projects retain the setting for turnover.</p>
            </div>
            <Toggle label="Enabled" checked={clip.stabilization.enabled} onChange={(enabled) => onPatch({ stabilization: { ...clip.stabilization, enabled } })} />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ToolRange label="Search strength" value={clip.stabilization.strength} min={1} max={64} step={1} onChange={(strength) => onPatch({ stabilization: { ...clip.stabilization, strength } })} />
            <ToolRange label="Rolling shutter" value={clip.stabilization.rollingShutter} min={0} max={1} step={0.05} onChange={(rollingShutter) => onPatch({ stabilization: { ...clip.stabilization, rollingShutter } })} />
          </div>
        </div>
      </section>

      <section className="space-y-5 p-4 sm:p-5">
        <div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-white">Chroma key / background removal</div>
              <p className="mt-1 text-[10px] text-slate-600">Sample the frame border automatically or set a key color manually.</p>
            </div>
            <button className="btn-secondary h-8 px-2 text-[10px]" disabled={busy} onClick={onAutoBackground}><WandSparkles className="h-3 w-3" /> Auto background</button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Toggle label="Enable key" checked={clip.chromaKey.enabled} onChange={(enabled) => onPatch({ chromaKey: { ...clip.chromaKey, enabled } })} />
            <label>
              <span className="label">Key color</span>
              <input className="input h-9" type="color" value={clip.chromaKey.color} onChange={(event) => onPatch({ chromaKey: { ...clip.chromaKey, color: event.target.value } })} />
            </label>
            <ToolRange label="Similarity" value={clip.chromaKey.similarity} min={0.01} max={1} step={0.01} onChange={(similarity) => onPatch({ chromaKey: { ...clip.chromaKey, similarity } })} />
            <ToolRange label="Edge blend" value={clip.chromaKey.blend} min={0} max={1} step={0.01} onChange={(blend) => onPatch({ chromaKey: { ...clip.chromaKey, blend } })} />
          </div>
        </div>

        <div className="border-t border-white/5 pt-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-white">Masks, privacy & tracking</div>
              <p className="mt-1 text-[10px] text-slate-600">Rectangle, ellipse, pen, and gradient masks can carry frame-position keyframes.</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {(['rectangle', 'ellipse', 'pen', 'gradient'] as const).map((type) => (
                <button key={type} className="btn-secondary h-8 px-2 text-[9px]" onClick={() => onAddMask(type)}><Plus className="h-3 w-3" /> {type}</button>
              ))}
            </div>
          </div>
          <div className="mt-3 max-h-[600px] space-y-3 overflow-y-auto pr-1 scrollbar-thin">
            {clip.masks.map((mask) => (
              <div key={mask.id} className="rounded-xl border border-white/5 bg-black/20 p-3">
                <div className="flex items-center gap-2">
                  <input className="input h-8 flex-1 text-xs" value={mask.name} onChange={(event) => patchMask(mask.id, { name: event.target.value })} />
                  <span className={clsx('chip', mask.trackingStatus === 'tracked' && 'text-emerald-300')}>{mask.trackingStatus}</span>
                  <button className="grid h-8 w-8 place-items-center text-slate-600 hover:text-red-300" onClick={() => onPatch({ masks: clip.masks.filter((item) => item.id !== mask.id) })}><Trash2 className="h-3 w-3" /></button>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label>
                    <span className="label">Effect</span>
                    <select className="input h-9 text-xs" value={mask.effect} onChange={(event) => patchMask(mask.id, { effect: event.target.value as LongformMask['effect'] })}>
                      <option value="blur">Blur</option>
                      <option value="mosaic">Mosaic</option>
                      <option value="opacity">Opacity</option>
                      <option value="color">Solid cover</option>
                    </select>
                  </label>
                  <ToolRange label="Strength" value={mask.strength} min={0} max={100} step={1} onChange={(strength) => patchMask(mask.id, { strength })} />
                  <ToolRange label="X" value={mask.x} min={0} max={1} step={0.01} onChange={(x) => patchMask(mask.id, { x })} />
                  <ToolRange label="Y" value={mask.y} min={0} max={1} step={0.01} onChange={(y) => patchMask(mask.id, { y })} />
                  <ToolRange label="Width" value={mask.width} min={0.005} max={1} step={0.01} onChange={(width) => patchMask(mask.id, { width })} />
                  <ToolRange label="Height" value={mask.height} min={0.005} max={1} step={0.01} onChange={(height) => patchMask(mask.id, { height })} />
                  <ToolRange label="Feather" value={mask.feather} min={0} max={1} step={0.01} onChange={(feather) => patchMask(mask.id, { feather })} />
                  <Toggle label="Enabled" checked={mask.enabled} onChange={(enabled) => patchMask(mask.id, { enabled })} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button className="btn-secondary h-8 px-2 text-[10px]" disabled={busy} onClick={() => onTrack(mask, false)}><Radio className="h-3 w-3" /> Track region</button>
                  <button className="btn-primary h-8 px-2 text-[10px]" disabled={busy} onClick={() => onTrack(mask, true)}><Sparkles className="h-3 w-3" /> Detect + blur face</button>
                </div>
              </div>
            ))}
            {!clip.masks.length && <EmptyState>Add a mask or use the tracked face-blur template.</EmptyState>}
          </div>
        </div>

        {!!fxTemplates.length && (
          <div className="border-t border-white/5 pt-4">
            <div className="text-xs font-semibold text-white">Quick templates</div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {fxTemplates.slice(0, 8).map((template) => (
                <button key={template.id} className="rounded-xl border border-white/5 bg-black/20 p-3 text-left hover:border-cyan-400/20" onClick={() => onApplyTemplate(template)}>
                  <span className="block text-[10px] font-semibold text-white">{template.name}</span>
                  <span className="mt-1 block text-[9px] leading-relaxed text-slate-600">{template.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ColorWorkspace({
  creative,
  luts,
  busy,
  uploading,
  onCreativeChange,
  onUpload,
  onAutoGrade,
  onSaveVersion,
  onRestoreVersion,
  onCompare,
  onAddGroup,
  selectedCount,
}: {
  creative: LongformCreativeOptions;
  luts: LongformMediaAsset[];
  busy: boolean;
  uploading: boolean;
  onCreativeChange: EditorV3WorkspaceProps['onCreativeChange'];
  onUpload: EditorV3WorkspaceProps['onUpload'];
  onAutoGrade: () => void;
  onSaveVersion: () => void;
  onRestoreVersion: (id: string) => void;
  onCompare: (active: boolean) => void;
  onAddGroup: () => void;
  selectedCount: number;
}) {
  const workflow = creative.colorWorkflow;
  const patchWorkflow = (patch: Partial<LongformCreativeOptions['colorWorkflow']>) => onCreativeChange({ colorWorkflow: { ...workflow, ...patch } });
  const patchManagement = (patch: Partial<typeof workflow.management>) => patchWorkflow({ management: { ...workflow.management, ...patch } });
  const patchColor = (patch: Partial<LongformColorGrade>) => onCreativeChange({ color: { ...creative.color, ...patch } });
  return (
    <div className="grid divide-y divide-white/5 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] xl:divide-x xl:divide-y-0">
      <section className="space-y-5 p-4 sm:p-5">
        <div className="rounded-2xl border border-cyan-400/15 bg-gradient-to-br from-cyan-500/10 to-violet-500/5 p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-white"><WandSparkles className="h-4 w-4 text-cyan-300" /> Automatic scene grade</div>
              <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-slate-500">Samples luminance, dynamic range, channel balance, saturation, clipping, and log-like contrast. Every application creates a reversible before/after version.</p>
            </div>
            <button className="btn-primary shrink-0" disabled={busy} onClick={onAutoGrade}>{busy ? <Gauge className="h-4 w-4 animate-pulse" /> : <Sparkles className="h-4 w-4" />} Analyze & grade</button>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
            <ToolRange label="Auto-grade strength" value={workflow.autoGrade.strength} min={0} max={1} step={0.05} onChange={(strength) => patchWorkflow({ autoGrade: { ...workflow.autoGrade, strength } })} />
            <div className="rounded-xl bg-black/20 p-3">
              <div className="text-[9px] uppercase tracking-[0.14em] text-slate-600">Last confidence</div>
              <div className="mt-1 text-lg font-semibold text-white">{Math.round(workflow.autoGrade.confidence * 100)}%</div>
              <div className="text-[9px] text-slate-600">{workflow.autoGrade.analyzedAt ? new Date(workflow.autoGrade.analyzedAt).toLocaleString() : 'Not analyzed'}</div>
            </div>
          </div>
        </div>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-white">Primary correction</div>
              <p className="mt-1 text-[10px] text-slate-600">These controls and the selected LUT are non-destructive and saved in grade versions.</p>
            </div>
            <div className="flex gap-2">
              <button className="btn-secondary h-8 px-2 text-[10px]" onClick={onSaveVersion}><Archive className="h-3 w-3" /> Save version</button>
              <button
                className="btn-secondary h-8 px-2 text-[10px]"
                onMouseDown={() => onCompare(true)}
                onMouseUp={() => onCompare(false)}
                onMouseLeave={() => onCompare(false)}
                onTouchStart={() => onCompare(true)}
                onTouchEnd={() => onCompare(false)}
              >
                <GitCompare className="h-3 w-3" /> Hold for before
              </button>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <ToolRange label="Exposure" value={creative.color.exposure} min={-0.5} max={0.5} step={0.01} onChange={(exposure) => patchColor({ exposure })} />
            <ToolRange label="Contrast" value={creative.color.contrast} min={0.25} max={2} step={0.01} onChange={(contrast) => patchColor({ contrast })} />
            <ToolRange label="Gamma" value={creative.color.gamma} min={0.35} max={3} step={0.01} onChange={(gamma) => patchColor({ gamma })} />
            <ToolRange label="Highlights" value={creative.color.highlights} min={-1} max={1} step={0.01} onChange={(highlights) => patchColor({ highlights })} />
            <ToolRange label="Shadows" value={creative.color.shadows} min={-1} max={1} step={0.01} onChange={(shadows) => patchColor({ shadows })} />
            <ToolRange label="Saturation" value={creative.color.saturation} min={0} max={3} step={0.01} onChange={(saturation) => patchColor({ saturation })} />
            <ToolRange label="Vibrance" value={creative.color.vibrance} min={-1} max={1} step={0.01} onChange={(vibrance) => patchColor({ vibrance })} />
            <ToolRange label="Temperature" value={creative.color.temperature} min={-1} max={1} step={0.01} onChange={(temperature) => patchColor({ temperature })} />
            <ToolRange label="Tint" value={creative.color.tint} min={-1} max={1} step={0.01} onChange={(tint) => patchColor({ tint })} />
            <ToolRange label="Sharpen" value={creative.color.sharpen} min={0} max={2} step={0.01} onChange={(sharpen) => patchColor({ sharpen })} />
          </div>
        </div>

        <div className="border-t border-white/5 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-white">LUT library</div>
              <p className="mt-1 text-[10px] text-slate-600">Shared .cube, .3dl, .dat, and .m3d files remain available to every long-form project.</p>
            </div>
            <label className="btn-secondary h-8 cursor-pointer px-2 text-[10px]">
              <Upload className="h-3 w-3" /> {uploading ? 'Uploading' : 'Upload LUT'}
              <input
                className="hidden"
                type="file"
                accept=".cube,.3dl,.dat,.m3d"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUpload('lut', file);
                  event.currentTarget.value = '';
                }}
              />
            </label>
          </div>
          <select className="input mt-3 h-9 text-xs" value={creative.color.lutAssetId || ''} onChange={(event) => patchColor({ lutAssetId: event.target.value || null })}>
            <option value="">No LUT</option>
            {luts.map((lut) => <option key={lut.id} value={lut.id}>{lut.library ? 'Library · ' : ''}{lut.name}</option>)}
          </select>
        </div>

        <div className="border-t border-white/5 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-white">Shared shot grades</div>
              <p className="mt-1 text-[10px] text-slate-600">Attach the current grade to the selected sequence clips so related camera shots update together.</p>
            </div>
            <button className="btn-secondary h-8 px-2 text-[10px]" disabled={!selectedCount} onClick={onAddGroup}><Group className="h-3 w-3" /> Group {selectedCount}</button>
          </div>
          <div className="mt-3 space-y-2">
            {workflow.groups.map((group) => (
              <div key={group.id} className="flex items-center gap-2 rounded-xl border border-white/5 bg-black/20 p-3">
                <input
                  className="input h-8 flex-1 text-xs"
                  value={group.name}
                  onChange={(event) => patchWorkflow({ groups: workflow.groups.map((item) => item.id === group.id ? { ...item, name: event.target.value } : item) })}
                />
                <span className="chip">{group.clipIds.length} clips</span>
                <button className="grid h-8 w-8 place-items-center text-slate-600 hover:text-red-300" onClick={() => patchWorkflow({ groups: workflow.groups.filter((item) => item.id !== group.id) })}><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
            {!workflow.groups.length && <EmptyState>No shared grade groups yet.</EmptyState>}
          </div>
        </div>
      </section>

      <section className="space-y-5 p-4 sm:p-5">
        <div>
          <div className="text-xs font-semibold text-white">Color management</div>
          <p className="mt-1 text-[10px] text-slate-600">Input transforms, working space, HDR/HLG output, tone mapping, and legal-range limiting.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <SelectField label="Input" value={workflow.management.inputSpace} options={['auto', 'rec709', 'log_c', 'slog3', 'vlog', 'hlg', 'pq']} onChange={(inputSpace) => patchManagement({ inputSpace: inputSpace as typeof workflow.management.inputSpace })} />
            <SelectField label="Working space" value={workflow.management.workingSpace} options={['rec709', 'acescct', 'hdr10', 'hlg']} onChange={(workingSpace) => patchManagement({ workingSpace: workingSpace as typeof workflow.management.workingSpace })} />
            <SelectField label="Output" value={workflow.management.outputSpace} options={['rec709', 'hdr10', 'hlg']} onChange={(outputSpace) => patchManagement({ outputSpace: outputSpace as typeof workflow.management.outputSpace })} />
            <SelectField label="Tone map" value={workflow.management.toneMap} options={['none', 'mobius', 'hable', 'reinhard']} onChange={(toneMap) => patchManagement({ toneMap: toneMap as typeof workflow.management.toneMap })} />
            <ToolRange label="Peak nits" value={workflow.management.peakNits} min={100} max={10_000} step={50} onChange={(peakNits) => patchManagement({ peakNits })} />
            <Toggle label="Broadcast legalize" checked={workflow.management.legalize} onChange={(legalize) => patchManagement({ legalize })} />
          </div>
        </div>

        <div className="border-t border-white/5 pt-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-white">Grade history</div>
            <span className="chip">{workflow.versions.length} versions</span>
          </div>
          <div className="mt-3 max-h-[650px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
            {[...workflow.versions].reverse().map((version) => (
              <button
                key={version.id}
                className={clsx(
                  'w-full rounded-xl border p-3 text-left',
                  workflow.selectedVersionId === version.id ? 'border-cyan-400/30 bg-cyan-500/10' : 'border-white/5 bg-black/20 hover:border-white/10',
                )}
                onClick={() => onRestoreVersion(version.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[10px] font-semibold text-white">{version.name}</span>
                  <span className="chip">{version.source}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 font-mono text-[8px] text-slate-600">
                  <span>E {version.grade.exposure.toFixed(2)}</span>
                  <span>C {version.grade.contrast.toFixed(2)}</span>
                  <span>S {version.grade.saturation.toFixed(2)}</span>
                  <span>T {version.grade.temperature.toFixed(2)}</span>
                </div>
              </button>
            ))}
            {!workflow.versions.length && <EmptyState>Run automatic grading or save a manual grade to start version history.</EmptyState>}
          </div>
        </div>
      </section>
    </div>
  );
}

function VoiceoverWorkspace({
  projectName,
  creative,
  assets,
  playhead,
  min,
  max,
  uploading,
  selectedClip,
  videoRef,
  onCreativeChange,
  onUpload,
  onSeek,
  onPatchClip,
}: {
  projectName: string;
  creative: LongformCreativeOptions;
  assets: LongformMediaAsset[];
  playhead: number;
  min: number;
  max: number;
  uploading: boolean;
  selectedClip: LongformSequenceClip | null;
  videoRef: RefObject<HTMLVideoElement>;
  onCreativeChange: EditorV3WorkspaceProps['onCreativeChange'];
  onUpload: EditorV3WorkspaceProps['onUpload'];
  onSeek: (time: number) => void;
  onPatchClip: (patch: Partial<LongformSequenceClip>) => void;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordLabel, setRecordLabel] = useState('voiceover');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const adr = creative.adr;
  const patchAdr = (patch: Partial<typeof adr>) => onCreativeChange({ adr: { ...adr, ...patch } });
  const alignMutation = useMutation({
    mutationFn: (assetId: string) => api.alignLongformVoiceover(projectName, { assetId, cueStart: selectedClip?.timelineStart ?? playhead }),
    onSuccess: (result) => {
      if (selectedClip) onPatchClip({ timelineStart: result.timelineStart, timelineEnd: result.timelineStart + (selectedClip.timelineEnd - selectedClip.timelineStart) });
    },
  });

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices()
      .then((items) => setDevices(items.filter((item) => item.kind === 'audioinput')))
      .catch(() => setDevices([]));
    return () => {
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function startRecording(label = 'voiceover', cueStart = playhead) {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setRecordError('This browser does not support microphone recording.');
      return;
    }
    setRecordError(null);
    setRecordLabel(label);
    const preRollStart = Math.max(min, cueStart - adr.preRollSec);
    onSeek(preRollStart);
    videoRef.current?.play().catch(() => undefined);
    for (let value = Math.round(adr.countdownSec); value > 0; value -= 1) {
      setCountdown(value);
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    setCountdown(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: adr.inputDeviceId ? { deviceId: { exact: adr.inputDeviceId } } : true,
      });
      streamRef.current = stream;
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((mime) => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'audio/webm';
        const extension = mimeType.includes('ogg') ? 'ogg' : 'webm';
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size) onUpload('voiceover', new File([blob], `${label}-${Date.now()}.${extension}`, { type: mimeType }));
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
      };
      recorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
    } catch (error) {
      setRecordError(errorText(error));
      setRecording(false);
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  return (
    <div className="grid divide-y divide-white/5 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)] xl:divide-x xl:divide-y-0">
      <section className="space-y-5 p-4 sm:p-5">
        <div className="rounded-2xl border border-emerald-400/15 bg-emerald-500/5 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-white">Record to timeline</div>
              <p className="mt-1 text-[10px] text-slate-600">Browser microphone capture creates a voiceover asset and places it on an audio track at the playhead.</p>
            </div>
            {countdown !== null && <span className="grid h-12 w-12 place-items-center rounded-full bg-pink-500/20 text-xl font-bold text-pink-200">{countdown}</span>}
          </div>
          <label className="mt-4 block">
            <span className="label">Input device</span>
            <select className="input h-9 text-xs" value={adr.inputDeviceId} onChange={(event) => patchAdr({ inputDeviceId: event.target.value })}>
              <option value="">System default</option>
              {devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${device.deviceId.slice(0, 8)}`}</option>)}
            </select>
          </label>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <MiniNumber label="Countdown" value={adr.countdownSec} min={0} max={10} step={1} onChange={(countdownSec) => patchAdr({ countdownSec })} />
            <MiniNumber label="Pre-roll" value={adr.preRollSec} min={0} max={10} step={0.5} onChange={(preRollSec) => patchAdr({ preRollSec })} />
            <MiniNumber label="Latency offset ms" value={adr.latencyMs} min={-2000} max={2000} step={1} onChange={(latencyMs) => patchAdr({ latencyMs })} />
            <Toggle label="Loop takes" checked={adr.loopRecord} onChange={(loopRecord) => patchAdr({ loopRecord })} />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {!recording ? (
              <>
                <button className="btn-primary" disabled={uploading || countdown !== null} onClick={() => startRecording('voiceover')}><Mic className="h-4 w-4" /> Record</button>
                <button className="btn-secondary" disabled={uploading || countdown !== null} onClick={() => startRecording('room-tone')}><AudioLines className="h-4 w-4" /> Room tone</button>
              </>
            ) : (
              <button className="btn-primary col-span-2 bg-red-500/20 text-red-100" onClick={stopRecording}><CircleStop className="h-4 w-4" /> Stop {recordLabel}</button>
            )}
          </div>
          {recordError && <div className="mt-3 text-xs text-red-300">{recordError}</div>}
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-white">Recorded takes</div>
            <label className="btn-secondary h-8 cursor-pointer px-2 text-[10px]">
              <Upload className="h-3 w-3" /> Import audio
              <input className="hidden" type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload('voiceover', file); event.currentTarget.value = ''; }} />
            </label>
          </div>
          <div className="mt-3 space-y-2">
            {assets.map((asset) => (
              <div key={asset.id} className="flex items-center gap-2 rounded-xl border border-white/5 bg-black/20 p-3">
                <AudioLines className="h-4 w-4 text-emerald-300" />
                <span className="min-w-0 flex-1 truncate text-[10px] text-slate-300">{asset.name}</span>
                <button className="btn-secondary h-7 px-2 text-[9px]" disabled={!selectedClip || alignMutation.isPending} onClick={() => alignMutation.mutate(asset.id)}>Align take</button>
              </div>
            ))}
            {!assets.length && <EmptyState>No voiceover takes yet.</EmptyState>}
          </div>
        </div>
      </section>

      <section className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-white">ADR cue sheet</div>
            <p className="mt-1 text-[10px] text-slate-600">Cue ranges, scripts, loop takes, selected performances, room tone, and leading-silence alignment.</p>
          </div>
          <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => patchAdr({
            cues: [...adr.cues, {
              id: `adr-cue-${Date.now()}`,
              name: `ADR cue ${adr.cues.length + 1}`,
              start: playhead,
              end: Math.min(max, playhead + 3),
              text: '',
              takeAssetIds: [],
              selectedTakeAssetId: null,
              roomToneAssetId: null,
            }],
          })}><Plus className="h-3 w-3" /> Add cue</button>
        </div>
        <div className="mt-4 max-h-[720px] space-y-3 overflow-y-auto pr-1 scrollbar-thin">
          {adr.cues.map((cue) => (
            <div key={cue.id} className="rounded-xl border border-white/5 bg-black/20 p-3">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_90px_90px_auto]">
                <input className="input h-8 text-xs" value={cue.name} onChange={(event) => patchAdr({ cues: adr.cues.map((item) => item.id === cue.id ? { ...item, name: event.target.value } : item) })} />
                <MiniNumber label="Start" value={cue.start} min={min} max={cue.end - 0.02} step={0.01} onChange={(start) => patchAdr({ cues: adr.cues.map((item) => item.id === cue.id ? { ...item, start } : item) })} />
                <MiniNumber label="End" value={cue.end} min={cue.start + 0.02} max={max} step={0.01} onChange={(end) => patchAdr({ cues: adr.cues.map((item) => item.id === cue.id ? { ...item, end } : item) })} />
                <button className="grid h-8 w-8 place-items-center text-slate-600 hover:text-red-300" onClick={() => patchAdr({ cues: adr.cues.filter((item) => item.id !== cue.id) })}><Trash2 className="h-3 w-3" /></button>
              </div>
              <textarea className="input mt-3 min-h-20 py-2 text-xs" placeholder="Line, pronunciation note, or performance direction…" value={cue.text} onChange={(event) => patchAdr({ cues: adr.cues.map((item) => item.id === cue.id ? { ...item, text: event.target.value } : item) })} />
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label>
                  <span className="label">Selected take</span>
                  <select className="input h-9 text-xs" value={cue.selectedTakeAssetId || ''} onChange={(event) => patchAdr({ cues: adr.cues.map((item) => item.id === cue.id ? { ...item, selectedTakeAssetId: event.target.value || null } : item) })}>
                    <option value="">Choose a take</option>
                    {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                  </select>
                </label>
                <label>
                  <span className="label">Room tone</span>
                  <select className="input h-9 text-xs" value={cue.roomToneAssetId || ''} onChange={(event) => patchAdr({ cues: adr.cues.map((item) => item.id === cue.id ? { ...item, roomToneAssetId: event.target.value || null } : item) })}>
                    <option value="">None</option>
                    {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                  </select>
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => onSeek(cue.start)}><Play className="h-3 w-3" /> Audition cue</button>
                <button className="btn-primary h-8 px-2 text-[10px]" disabled={recording || countdown !== null} onClick={() => startRecording(`adr-${cue.id}`, cue.start)}><Mic className="h-3 w-3" /> Record take</button>
              </div>
            </div>
          ))}
          {!adr.cues.length && <EmptyState>Add ADR cues at the playhead, then record as many takes as needed.</EmptyState>}
        </div>
      </section>
    </div>
  );
}

function PublishWorkspace({
  creative,
  deliveries,
  busy,
  onCreativeChange,
  onPublish,
}: {
  creative: LongformCreativeOptions;
  deliveries: LongformDelivery[];
  busy: boolean;
  onCreativeChange: EditorV3WorkspaceProps['onCreativeChange'];
  onPublish: () => void;
}) {
  const publish = creative.publish;
  const patch = (values: Partial<typeof publish>) => onCreativeChange({ publish: { ...publish, ...values } });
  const destinations = ['youtube', 'podcast', 'instagram', 'tiktok', 'archive'];
  return (
    <div className="grid divide-y divide-white/5 xl:grid-cols-[minmax(320px,0.75fr)_minmax(0,1.25fr)] xl:divide-x xl:divide-y-0">
      <section className="space-y-5 p-4 sm:p-5">
        <div>
          <div className="text-xs font-semibold text-white">Linked publish package</div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">Build the long master, 16:9, square, vertical, and short derivatives together. Content hashes rerender only variants affected by project changes.</p>
        </div>
        <label>
          <span className="label">Title</span>
          <input className="input h-9 text-xs" value={publish.title} onChange={(event) => patch({ title: event.target.value })} placeholder="Episode or program title" />
        </label>
        <label>
          <span className="label">Description</span>
          <textarea className="input min-h-32 py-2 text-xs" value={publish.description} onChange={(event) => patch({ description: event.target.value })} placeholder="Description, credits, licensing notes, and calls to action…" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <Toggle label="Long master" checked={publish.includeMaster} onChange={(includeMaster) => patch({ includeMaster })} />
          <Toggle label="Horizontal" checked={publish.includeHorizontal} onChange={(includeHorizontal) => patch({ includeHorizontal })} />
          <Toggle label="Square" checked={publish.includeSquare} onChange={(includeSquare) => patch({ includeSquare })} />
          <Toggle label="Vertical" checked={publish.includeVertical} onChange={(includeVertical) => patch({ includeVertical })} />
          <Toggle label="Auto shorts" checked={publish.includeShorts} onChange={(includeShorts) => patch({ includeShorts })} />
          <Toggle label="Captions" checked={publish.captions} onChange={(captions) => patch({ captions })} />
          <Toggle label="Thumbnails" checked={publish.thumbnails} onChange={(thumbnails) => patch({ thumbnails })} />
          <Toggle label="Chapter art" checked={publish.chapterArt} onChange={(chapterArt) => patch({ chapterArt })} />
        </div>
        {publish.includeShorts && (
          <div className="grid grid-cols-2 gap-3">
            <MiniNumber label="Short count" value={publish.shortsCount} min={0} max={12} step={1} onChange={(shortsCount) => patch({ shortsCount })} />
            <MiniNumber label="Short duration" value={publish.shortDurationSec} min={10} max={180} step={1} onChange={(shortDurationSec) => patch({ shortDurationSec })} />
          </div>
        )}
        <div>
          <span className="label">Destination folders</span>
          <div className="grid grid-cols-2 gap-2">
            {destinations.map((destination) => (
              <Toggle
                key={destination}
                label={destination}
                checked={publish.destinations.includes(destination)}
                onChange={(checked) => patch({
                  destinations: checked
                    ? [...new Set([...publish.destinations, destination])]
                    : publish.destinations.filter((item) => item !== destination),
                })}
              />
            ))}
          </div>
        </div>
        <button className="btn-primary w-full" disabled={busy} onClick={onPublish}><MonitorPlay className="h-4 w-4" /> {busy ? 'Building manifest…' : 'Build / update package'}</button>
      </section>

      <section className="p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-white">Delivery history</div>
            <p className="mt-1 text-[10px] text-slate-600">Each package keeps linked hashes, output status, thumbnails, chapter/caption metadata, and one downloadable folder.</p>
          </div>
          <span className="chip">{deliveries.length} packages</span>
        </div>
        <div className="mt-4 max-h-[760px] space-y-4 overflow-y-auto pr-1 scrollbar-thin">
          {deliveries.map((delivery) => (
            <div key={delivery.id} className="rounded-xl border border-white/5 bg-black/20 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-white">{delivery.title}</div>
                  <div className="mt-1 text-[9px] text-slate-600">Updated {new Date(delivery.updatedAt).toLocaleString()} · {delivery.destinations.join(', ') || 'No destinations'}</div>
                </div>
                <a className="btn-secondary h-8 px-2 text-[10px]" href={api.longformDeliveryArchiveUrl(delivery.id)}><Download className="h-3 w-3" /> Package ZIP</a>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {delivery.variants.map((variant) => (
                  <div key={variant.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[10px] font-semibold text-slate-200">{variant.label}</span>
                      <span className={clsx('chip', variant.status === 'complete' && 'text-emerald-300', variant.status === 'failed' && 'text-red-300')}>{variant.status}</span>
                    </div>
                    <div className="mt-1 font-mono text-[8px] text-slate-700">{variant.aspect} · {variant.contentHash.slice(0, 10)}</div>
                    {variant.outputUrl && <a className="mt-2 inline-flex text-[9px] text-cyan-300 hover:text-cyan-200" href={variant.outputUrl} target="_blank" rel="noreferrer">Open render</a>}
                    {variant.error && <div className="mt-2 text-[9px] text-red-300">{variant.error}</div>}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!deliveries.length && <EmptyState>No publish package has been built yet.</EmptyState>}
        </div>
      </section>
    </div>
  );
}

function ReviewWorkspace({
  reviews,
  title,
  password,
  expiry,
  busy,
  onTitle,
  onPassword,
  onExpiry,
  onCreate,
  onImportMarkers,
  onSeek,
}: {
  reviews: LongformReview[];
  title: string;
  password: string;
  expiry: number;
  busy: boolean;
  onTitle: (value: string) => void;
  onPassword: (value: string) => void;
  onExpiry: (value: number) => void;
  onCreate: () => void;
  onImportMarkers: (review: LongformReview) => void;
  onSeek: (time: number) => void;
}) {
  return (
    <div className="grid divide-y divide-white/5 xl:grid-cols-[320px_minmax(0,1fr)] xl:divide-x xl:divide-y-0">
      <section className="space-y-4 p-4 sm:p-5">
        <div>
          <div className="text-xs font-semibold text-white">Create reviewer portal</div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">Share a tokenized page with optional password and expiry. Reviewers can compare versions, comment on exact frames, draw annotations, approve, or request changes.</p>
        </div>
        <label>
          <span className="label">Review title</span>
          <input className="input h-9 text-xs" value={title} onChange={(event) => onTitle(event.target.value)} placeholder="Client review" />
        </label>
        <label>
          <span className="label">Password (optional)</span>
          <input className="input h-9 text-xs" type="password" value={password} onChange={(event) => onPassword(event.target.value)} />
        </label>
        <MiniNumber label="Expiry days" value={expiry} min={1} max={365} step={1} onChange={onExpiry} />
        <button className="btn-primary w-full" disabled={busy} onClick={onCreate}><Link2 className="h-4 w-4" /> Create and copy link</button>
      </section>
      <section className="p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-semibold text-white">Active reviews</div>
          <span className="chip">{reviews.reduce((sum, review) => sum + review.comments.length, 0)} comments</span>
        </div>
        <div className="mt-4 space-y-4">
          {reviews.map((review) => (
            <div key={review.token} className="rounded-xl border border-white/5 bg-black/20 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-white">{review.title}</div>
                  <div className="mt-1 text-[9px] text-slate-600">Expires {new Date(review.expiresAt).toLocaleDateString()} · {review.passwordRequired ? 'Password protected' : 'Token access'}</div>
                </div>
                <span className={clsx('chip', review.status === 'approved' && 'text-emerald-300', review.status === 'changes_requested' && 'text-amber-300')}>{review.status.replace('_', ' ')}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {review.url && <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => navigator.clipboard?.writeText(review.url || '')}><Copy className="h-3 w-3" /> Copy link</button>}
                <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => onImportMarkers(review)}><Plus className="h-3 w-3" /> Comments → markers</button>
              </div>
              <div className="mt-3 space-y-2">
                {review.comments.slice(-20).map((comment) => (
                  <button key={comment.id} className="flex w-full items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3 text-left hover:border-cyan-400/20" onClick={() => onSeek(comment.time)}>
                    <span className="font-mono text-[9px] text-cyan-300">{formatTime(comment.time)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[9px] font-semibold text-slate-300">{comment.author}</span>
                      <span className="mt-1 block text-[10px] leading-relaxed text-slate-500">{comment.text}</span>
                    </span>
                    {comment.drawing.length > 0 && <span className="chip">drawing</span>}
                  </button>
                ))}
                {!review.comments.length && <EmptyState>Waiting for reviewer notes.</EmptyState>}
              </div>
            </div>
          ))}
          {!reviews.length && <EmptyState>Create a review link when the cut is ready for feedback.</EmptyState>}
        </div>
      </section>
    </div>
  );
}

function QcWorkspace({
  report,
  busy,
  markers,
  onRun,
  onSeek,
  onAddMarker,
  onResolveMarker,
}: {
  report: LongformQcReport | null;
  busy: boolean;
  markers: LongformCreativeOptions['sequence']['markers'];
  onRun: () => void;
  onSeek: (time: number) => void;
  onAddMarker: (issue: LongformQcReport['issues'][number]) => void;
  onResolveMarker: (id: string) => void;
}) {
  return (
    <div className="p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs font-semibold text-white">Automated technical QC</div>
          <p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-slate-600">Checks black and flash frames, missing streams/media, audio clipping and silence, caption overlap/reading speed, legal levels, chapters, and publish metadata.</p>
        </div>
        <button className="btn-primary shrink-0" disabled={busy} onClick={onRun}><ShieldCheck className="h-4 w-4" /> {busy ? 'Analyzing media…' : 'Run QC'}</button>
      </div>
      {report ? (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Errors" value={report.summary.error} tone="red" />
            <Metric label="Warnings" value={report.summary.warning} tone="amber" />
            <Metric label="Info" value={report.summary.info} tone="cyan" />
            <Metric label="Status" value={report.summary.passed ? 'PASS' : 'REVIEW'} tone={report.summary.passed ? 'green' : 'amber'} />
          </div>
          <div className="mt-5 space-y-2">
            {report.issues.map((issue) => {
              const marker = markers.find((item) => item.id === `qc-${issue.id}`);
              return (
                <div key={issue.id} className={clsx(
                  'grid gap-3 rounded-xl border p-3 sm:grid-cols-[90px_100px_minmax(0,1fr)_auto] sm:items-center',
                  issue.severity === 'error' ? 'border-red-400/15 bg-red-500/5' : issue.severity === 'warning' ? 'border-amber-400/15 bg-amber-500/5' : 'border-cyan-400/10 bg-cyan-500/5',
                )}>
                  <button className="font-mono text-[9px] text-cyan-300" onClick={() => onSeek(issue.time)}>{formatTime(issue.time)}</button>
                  <span className="chip w-fit">{issue.category}</span>
                  <div>
                    <div className="text-[10px] font-semibold text-slate-200">{issue.title}</div>
                    <div className="mt-1 text-[9px] leading-relaxed text-slate-600">{issue.detail}</div>
                  </div>
                  {marker ? (
                    <button className={clsx('btn-secondary h-8 px-2 text-[9px]', marker.resolved && 'text-emerald-300')} onClick={() => onResolveMarker(marker.id)}>
                      <Check className="h-3 w-3" /> {marker.resolved ? 'Resolved' : 'Open'}
                    </button>
                  ) : (
                    <button className="btn-secondary h-8 px-2 text-[9px]" onClick={() => onAddMarker(issue)}><Plus className="h-3 w-3" /> Marker</button>
                  )}
                </div>
              );
            })}
            {!report.issues.length && <EmptyState>No QC issues were detected in the selected range.</EmptyState>}
          </div>
        </>
      ) : (
        <div className="mt-5"><EmptyState>Run QC before delivery to create a frame-addressable report.</EmptyState></div>
      )}
    </div>
  );
}

function InterchangeWorkspace({ projectName }: { projectName: string }) {
  const queryClient = useQueryClient();
  const [codec, setCodec] = useState<LongformConsolidation['codec']>('prores');
  const [handlesSec, setHandlesSec] = useState(2);
  const consolidationsQuery = useQuery({
    queryKey: ['longform-consolidations', projectName],
    queryFn: () => api.listLongformConsolidations(projectName),
    refetchInterval: 3000,
  });
  const consolidateMutation = useMutation({
    mutationFn: () => api.createLongformConsolidation(projectName, { codec, handlesSec }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['longform-consolidations', projectName] }),
  });
  const formats: Array<{ id: 'edl' | 'otio' | 'fcpxml' | 'aaf'; label: string; detail: string }> = [
    { id: 'edl', label: 'CMX 3600 EDL', detail: 'Cuts, source names, timecode, speed, and reverse notes.' },
    { id: 'fcpxml', label: 'Final Cut Pro XML', detail: 'Import into Final Cut Pro, Premiere Pro, or Resolve.' },
    { id: 'aaf', label: 'AAF', detail: 'Linked picture composition for Avid, Pro Tools, and Resolve turnover.' },
    { id: 'otio', label: 'OpenTimelineIO', detail: 'Modern timeline interchange with clip metadata and external references.' },
  ];
  return (
    <div className="grid divide-y divide-white/5 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
      <section className="p-4 sm:p-5">
        <div className="text-xs font-semibold text-white">Timeline interchange</div>
        <p className="mt-1 text-[10px] text-slate-600">Export the saved sequence into the formats used by Adobe, Final Cut, Avid, and DaVinci Resolve.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {formats.map((format) => (
            <a key={format.id} className="rounded-xl border border-white/5 bg-black/20 p-4 hover:border-cyan-400/20" href={api.longformInterchangeUrl(projectName, format.id)}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold text-white">{format.label}</span>
                <Download className="h-3.5 w-3.5 text-cyan-300" />
              </div>
              <p className="mt-2 text-[9px] leading-relaxed text-slate-600">{format.detail}</p>
            </a>
          ))}
        </div>
      </section>
      <section className="space-y-4 p-4 sm:p-5">
        <div>
          <div className="text-xs font-semibold text-white">Project archive & turnover</div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">Trim the sequence media with handles and transcode it to a professional mezzanine codec for relinking in another editor.</p>
        </div>
        <div className="grid gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-4 sm:grid-cols-[1fr_120px_auto]">
          <label className="space-y-1">
            <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">Turnover codec</span>
            <select className="input h-9 w-full text-[10px]" value={codec} onChange={(event) => setCodec(event.target.value as LongformConsolidation['codec'])}>
              <option value="prores">ProRes 422 HQ</option>
              <option value="dnxhr">DNxHR HQ</option>
              <option value="h264">H.264 high quality</option>
              <option value="copy">Stream copy</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">Handles (sec)</span>
            <input className="input h-9 w-full text-[10px]" type="number" min={0} max={120} step={0.5} value={handlesSec} onChange={(event) => setHandlesSec(clamp(Number(event.target.value), 0, 120))} />
          </label>
          <button className="btn-primary self-end" disabled={consolidateMutation.isPending} onClick={() => consolidateMutation.mutate()}>
            <FileArchive className="h-4 w-4" /> {consolidateMutation.isPending ? 'Starting…' : 'Consolidate'}
          </button>
        </div>
        {consolidateMutation.error && <div className="text-[10px] text-red-300">{errorText(consolidateMutation.error)}</div>}
        <div className="space-y-2">
          {(consolidationsQuery.data || []).slice(0, 4).map((job) => (
            <div key={job.id} className="rounded-xl border border-white/5 bg-black/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] font-semibold text-white">{job.codec.toUpperCase()} · {job.handlesSec}s handles</div>
                  <div className="mt-1 text-[9px] text-slate-600">
                    {job.status.replace('_', ' ')} · {job.summary.complete}/{job.summary.total} clips
                    {job.progress.current ? ` · ${job.progress.current}` : ''}
                  </div>
                </div>
                {job.downloadUrl && (
                  <a className="btn-secondary h-8 px-2 text-[9px]" href={api.longformConsolidationArchiveUrl(job.id)}>
                    <Download className="h-3 w-3" /> ZIP
                  </a>
                )}
              </div>
              {['queued', 'running'].includes(job.status) && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${clamp(job.progress.percent, 1, 100)}%` }} />
                </div>
              )}
              {job.error && <div className="mt-2 text-[9px] text-red-300">{job.error}</div>}
              {job.warnings?.map((warning) => <div key={warning} className="mt-2 text-[9px] text-amber-300">{warning}</div>)}
            </div>
          ))}
          {!consolidationsQuery.isLoading && !(consolidationsQuery.data || []).length && (
            <EmptyState>No consolidated turnovers have been created yet.</EmptyState>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <a className="btn-secondary w-full" href={api.longformProjectArchiveUrl(projectName, true)}><Archive className="h-4 w-4" /> Full-media archive</a>
          <a className="btn-secondary w-full" href={api.longformProjectArchiveUrl(projectName, false)}><FileArchive className="h-4 w-4" /> References archive</a>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <div className="text-[10px] font-semibold text-slate-300">Turnover notes</div>
          <ul className="mt-2 space-y-2 text-[9px] leading-relaxed text-slate-600">
            <li>Consolidated AAF, FCPXML, OTIO, and EDL files point at the trimmed media included in the ZIP.</li>
            <li>Actual head and tail handles are recorded per clip when media starts or ends before the requested handle length.</li>
            <li>FCPXML and OTIO retain clip names, timing, track metadata, and external media references.</li>
            <li>EDL includes speed/reverse comments for conform operators.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}

function TemplateWorkspace({
  templates,
  name,
  busy,
  canSaveClip,
  onName,
  onSave,
  onApply,
  onDelete,
  onImport,
}: {
  templates: LongformEffectTemplate[];
  name: string;
  busy: boolean;
  canSaveClip: boolean;
  onName: (value: string) => void;
  onSave: () => void;
  onApply: (template: LongformEffectTemplate) => void;
  onDelete: (id: string) => void;
  onImport: (templates: Array<Partial<LongformEffectTemplate>>) => Promise<void>;
}) {
  function exportTemplates() {
    const blob = new Blob([JSON.stringify({ version: 1, templates }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'viral-clip-factory-effect-templates.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-xs font-semibold text-white">Reusable effect and brand system</div>
          <p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-slate-600">Save parameterized transitions, lower thirds, clip effects, grades, audio chains, and mask stacks. Export/import JSON bundles for teams and future plugin integrations.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="btn-secondary h-9 cursor-pointer px-3 text-[10px]">
            <Upload className="h-3.5 w-3.5" /> Import bundle
            <input
              className="hidden"
              type="file"
              accept=".json,application/json"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const parsed = JSON.parse(await file.text()) as { templates?: Array<Partial<LongformEffectTemplate>> };
                await onImport(Array.isArray(parsed.templates) ? parsed.templates : []);
                event.currentTarget.value = '';
              }}
            />
          </label>
          <button className="btn-secondary h-9 px-3 text-[10px]" onClick={exportTemplates}><Download className="h-3.5 w-3.5" /> Export bundle</button>
        </div>
      </div>
      <div className="mt-5 flex flex-col gap-2 rounded-xl border border-white/5 bg-black/20 p-3 sm:flex-row">
        <input className="input h-9 flex-1 text-xs" value={name} onChange={(event) => onName(event.target.value)} placeholder={canSaveClip ? 'Template name from selected clip' : 'Template name from current grade'} />
        <button className="btn-primary shrink-0" disabled={busy} onClick={onSave}><Plus className="h-4 w-4" /> Save current stack</button>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {templates.map((template) => {
          const builtIn = new Date(template.createdAt).getTime() === 0;
          return (
            <div key={template.id} className="rounded-xl border border-white/5 bg-black/20 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[10px] font-semibold text-white">{template.name}</div>
                  <div className="mt-1 text-[8px] uppercase tracking-[0.14em] text-cyan-400/60">{template.category}</div>
                </div>
                <span className="chip">v{template.version}</span>
              </div>
              <p className="mt-3 min-h-10 text-[9px] leading-relaxed text-slate-600">{template.description}</p>
              <div className="mt-3 flex gap-2">
                <button className="btn-primary h-8 flex-1 text-[10px]" onClick={() => onApply(template)}><WandSparkles className="h-3 w-3" /> Apply</button>
                {!builtIn && <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-600 hover:bg-red-500/10 hover:text-red-300" onClick={() => onDelete(template.id)}><Trash2 className="h-3 w-3" /></button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrackButton({ active, title, onClick, children }: { active: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return <button className={clsx('grid h-6 min-w-6 place-items-center rounded text-[8px]', active ? 'bg-cyan-500/15 text-cyan-200' : 'text-slate-700 hover:bg-white/5 hover:text-slate-300')} title={title} onClick={onClick}>{children}</button>;
}

function TransitionControl({ label, value, onChange }: { label: string; value: { type: LongformTransitionType; duration: number }; onChange: (value: { type: LongformTransitionType; duration: number }) => void }) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="grid grid-cols-[1fr_82px] gap-2">
        <select className="input h-9 text-xs" value={value.type} onChange={(event) => onChange({ ...value, type: event.target.value as LongformTransitionType })}>
          <option value="cut">Cut</option>
          <option value="dissolve">Dissolve</option>
          <option value="fade_black">Fade black</option>
          <option value="fade_white">Fade white</option>
          <option value="wipe_left">Wipe left</option>
          <option value="slide_left">Slide left</option>
        </select>
        <input className="input h-9 px-2 font-mono text-[9px]" type="number" min={0} max={3} step={0.01} value={value.duration} onChange={(event) => onChange({ ...value, duration: Number(event.target.value) })} />
      </div>
    </div>
  );
}

function ToolRange({ label, value, min, max, step, suffix = '', onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
  return (
    <label>
      <span className="flex items-center justify-between gap-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-600">
        {label}<span className="font-mono normal-case tracking-normal text-slate-400">{Number(value).toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)}{suffix}</span>
      </span>
      <input className="mt-2 h-1.5 w-full cursor-pointer accent-cyan-400" type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function MiniNumber({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label>
      <span className="label">{label}</span>
      <input className="input h-9 px-2 font-mono text-[10px]" type="number" value={Number.isFinite(value) ? value : min} min={min} max={max} step={step} onChange={(event) => onChange(clamp(Number(event.target.value), min, max))} />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-[9px] font-semibold text-slate-500">
      <span className="capitalize">{label}</span>
      <input className="h-3.5 w-3.5 accent-cyan-400" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label>
      <span className="label">{label}</span>
      <div className="relative">
        <select className="input h-9 appearance-none pr-8 text-xs" value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => <option key={option} value={option}>{option.replace(/_/g, ' ')}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-slate-600" />
      </div>
    </label>
  );
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone: 'red' | 'amber' | 'cyan' | 'green' }) {
  const toneClass = {
    red: 'text-red-300',
    amber: 'text-amber-300',
    cyan: 'text-cyan-300',
    green: 'text-emerald-300',
  }[tone];
  return (
    <div className="rounded-xl border border-white/5 bg-black/20 p-4">
      <div className="text-[9px] uppercase tracking-[0.14em] text-slate-600">{label}</div>
      <div className={clsx('mt-1 text-xl font-semibold', toneClass)}>{value}</div>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-5 text-center text-[10px] leading-relaxed text-slate-600">{children}</div>;
}
