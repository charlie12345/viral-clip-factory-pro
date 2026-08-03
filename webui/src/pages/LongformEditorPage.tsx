import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AudioLines,
  ArrowLeft,
  Captions,
  CheckCircle2,
  ChevronDown,
  ChevronsRight,
  CircleAlert,
  Clock3,
  Eye,
  EyeOff,
  FastForward,
  Film,
  FolderOpen,
  Hand,
  HardDrive,
  ImagePlus,
  Keyboard,
  Layers3,
  Link2,
  ListPlus,
  Loader2,
  Lock,
  Magnet,
  Maximize2,
  MonitorPlay,
  MousePointer2,
  MoveHorizontal,
  Palette,
  PanelLeftClose,
  PanelRightClose,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCcw,
  Search,
  Scissors,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  StretchHorizontal,
  Trash2,
  Type,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
  WandSparkles,
  X,
  ZoomIn,
} from 'lucide-react';
import { clsx } from 'clsx';
import {
  api,
  type LongformAnalysis,
  type LongformChapter,
  type LongformCut,
  type LongformCreativeOptions,
  type LongformEditPoint,
  type LongformMediaAsset,
  type LongformOptions,
  type LongformSequenceClip,
  type LongformSequenceTrack,
  type LongformTransitionType,
} from '@/api/client';
import {
  ProfessionalEditorTools,
  type ToolTab as ProfessionalToolTab,
} from '@/components/longform/ProfessionalEditorTools';
import {
  EditorV3Workspace,
  type WorkspaceTab as V3WorkspaceTab,
} from '@/components/longform/EditorV3Workspace';
import { StorageManagerPanel } from '@/components/admin/StorageManagerPanel';

const DEFAULT_OPTIONS: LongformOptions = {
  enabled: true,
  thresholdDb: -35,
  minSilenceSec: 0.5,
  paddingSec: 0.08,
  audioFadeSec: 0.03,
  videoFadeSec: 0,
  normalizeAudio: false,
  targetLufs: -14,
  limiterDb: -1.5,
  denoise: false,
  startSec: 0,
  endSec: 0,
};

const DEFAULT_CREATIVE: LongformCreativeOptions = {
  exportPreset: 'source',
  editPoints: [],
  transitions: [],
  titles: [],
  broll: [],
  color: {
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
  },
  audio: {
    dialogueGainDb: 0,
    masterGainDb: 0,
    pan: 0,
    eqLowDb: 0,
    eqMidDb: 0,
    eqHighDb: 0,
    compressor: false,
    deEsser: false,
    noiseGate: false,
    dialogueMuted: false,
    musicMuted: false,
    keyframes: [],
  },
  captions: {
    enabled: false,
    burnIn: false,
    cues: [],
    fontSize: 44,
    position: 'bottom',
    textColor: '#FFFFFF',
    backgroundColor: '#09090B',
    highlightColor: '#FACC15',
  },
  adjustmentLayers: [],
  multicam: { angles: [], cuts: [] },
  musicAssetId: null,
  musicVolume: 0.14,
  musicDucking: true,
  sequence: {
    enabled: false,
    mode: 'composite',
    activeSequenceId: 'sequence-main',
    sourceIn: null,
    sourceOut: null,
    sequences: [{
      id: 'sequence-main',
      name: 'Main sequence',
      frameRate: 30,
      width: 1920,
      height: 1080,
      tracks: [
        {
          id: 'v1',
          name: 'Video 1',
          kind: 'video',
          order: 0,
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          linked: true,
          volumeDb: 0,
          clips: [],
        },
        {
          id: 'a1',
          name: 'Audio 1',
          kind: 'audio',
          order: 1,
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          linked: true,
          volumeDb: 0,
          clips: [],
        },
      ],
    }],
    markers: [],
  },
  colorWorkflow: {
    management: {
      inputSpace: 'auto',
      workingSpace: 'rec709',
      outputSpace: 'rec709',
      toneMap: 'mobius',
      legalize: false,
      peakNits: 1000,
    },
    autoGrade: {
      strength: 1,
      analyzedAt: null,
      metrics: {},
      confidence: 0,
    },
    versions: [],
    selectedVersionId: null,
    compareVersionId: null,
    groups: [],
  },
  adr: {
    inputDeviceId: '',
    latencyMs: 0,
    countdownSec: 3,
    preRollSec: 2,
    loopRecord: false,
    cues: [],
  },
  publish: {
    title: '',
    description: '',
    includeMaster: true,
    includeHorizontal: true,
    includeSquare: true,
    includeVertical: true,
    includeShorts: true,
    shortsCount: 3,
    shortDurationSec: 45,
    destinations: ['youtube'],
    chapterArt: true,
    thumbnails: true,
    captions: true,
  },
  delivery: {
    aspect: 'source',
    reframe: 'contain',
    safeArea: true,
  },
};

interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: string | number;
}

interface TranscriptChunk {
  id: string;
  start: number;
  end: number;
  text: string;
  startIndex: number;
  endIndex: number;
}

interface FillerSuggestion {
  id: string;
  start: number;
  end: number;
  label: string;
  context: string;
}

interface CutHistory {
  past: LongformCut[][];
  future: LongformCut[][];
}

interface TransitionJoin {
  cutId: string;
  kind: 'cut' | 'blade';
  joinIndex: number;
  sourceTime: number;
  gapStart: number;
  gapEnd: number;
  maxDuration: number;
}

type PremiereWorkspaceId = 'editing' | 'graphics' | 'color' | 'audio' | 'captions' | 'review' | 'export';
type LeftDockTab = 'project' | 'effects' | 'graphics' | 'text';
type RightDockTab = 'properties' | 'color' | 'audio' | 'export';
type TimelineTool = 'selection' | 'track' | 'ripple' | 'rolling' | 'rate' | 'razor' | 'slip' | 'slide' | 'hand' | 'zoom' | 'type';
type TimelineItemKind = 'sequence' | 'title' | 'broll' | 'caption' | 'adjustment' | 'program' | 'dialogue';

interface TimelineItemDescriptor {
  key: string;
  kind: TimelineItemKind;
  id: string;
  trackId: string;
  start: number;
  end: number;
  movable: boolean;
  locked: boolean;
  linkedGroupId: string | null;
  sequenceTrackId?: string;
  sequenceTrackKind?: 'video' | 'audio';
}

interface TimelineMarquee {
  left: number;
  top: number;
  width: number;
  height: number;
  count: number;
}

interface TimelineDragPayload {
  anchorKey: string;
  keys: string[];
  pointerOffsetSec: number;
}

function timelineItemKey(kind: TimelineItemKind, trackId: string, id: string) {
  return `${kind}|${trackId}|${id}`;
}
type WindowPanel =
  | { suite: 'professional'; tab: ProfessionalToolTab }
  | { suite: 'v3'; tab: V3WorkspaceTab }
  | { suite: 'cuts'; tab: 'cuts' }
  | { suite: 'transcript'; tab: 'transcript' }
  | { suite: 'chapters'; tab: 'chapters' }
  | { suite: 'storage'; tab: 'storage' }
  | null;

const EMPTY_HISTORY: CutHistory = { past: [], future: [] };
const ANALYSIS_KEYS = new Set<keyof LongformOptions>([
  'thresholdDb',
  'minSilenceSec',
  'paddingSec',
  'startSec',
  'endSec',
]);
const SINGLE_FILLERS = new Set(['um', 'uh', 'erm', 'hmm', 'mmm']);
const FILLER_PHRASES = [
  ['you', 'know'],
  ['i', 'mean'],
] as const;
const TRANSITION_OPTIONS: Array<{ value: LongformTransitionType; label: string }> = [
  { value: 'cut', label: 'Clean cut' },
  { value: 'dissolve', label: 'Cross dissolve' },
  { value: 'fade_black', label: 'Dip to black' },
  { value: 'fade_white', label: 'Dip to white' },
  { value: 'wipe_left', label: 'Wipe left' },
  { value: 'slide_left', label: 'Slide left' },
];
const PREMIERE_WORKSPACES: Array<{ id: PremiereWorkspaceId; label: string }> = [
  { id: 'editing', label: 'Editing' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'color', label: 'Color' },
  { id: 'audio', label: 'Audio' },
  { id: 'captions', label: 'Captions' },
  { id: 'review', label: 'Review' },
  { id: 'export', label: 'Export' },
];
const TIMELINE_TOOLS: Array<{ id: TimelineTool; label: string; shortcut: string; icon: typeof Scissors }> = [
  { id: 'selection', label: 'Selection', shortcut: 'V', icon: MousePointer2 },
  { id: 'track', label: 'Track select', shortcut: 'A', icon: FastForward },
  { id: 'ripple', label: 'Ripple edit', shortcut: 'B', icon: MoveHorizontal },
  { id: 'rolling', label: 'Rolling edit', shortcut: 'N', icon: StretchHorizontal },
  { id: 'rate', label: 'Rate stretch', shortcut: 'R', icon: FastForward },
  { id: 'razor', label: 'Razor', shortcut: 'C', icon: Scissors },
  { id: 'slip', label: 'Slip', shortcut: 'Y', icon: Layers3 },
  { id: 'slide', label: 'Slide', shortcut: 'U', icon: ChevronsRight },
  { id: 'hand', label: 'Hand', shortcut: 'H', icon: Hand },
  { id: 'zoom', label: 'Zoom', shortcut: 'Z', icon: ZoomIn },
  { id: 'type', label: 'Type', shortcut: 'T', icon: Type },
];
const WINDOW_PANELS: Array<{ label: string; panel: Exclude<WindowPanel, null> }> = [
  { label: 'Cuts', panel: { suite: 'cuts', tab: 'cuts' } },
  { label: 'Transcript', panel: { suite: 'transcript', tab: 'transcript' } },
  { label: 'Chapters', panel: { suite: 'chapters', tab: 'chapters' } },
  { label: 'Edit controls', panel: { suite: 'professional', tab: 'edit' } },
  { label: 'Audio mixer', panel: { suite: 'professional', tab: 'audio' } },
  { label: 'Captions', panel: { suite: 'professional', tab: 'captions' } },
  { label: 'Legacy color', panel: { suite: 'professional', tab: 'color' } },
  { label: 'Multicam', panel: { suite: 'professional', tab: 'multicam' } },
  { label: 'Project safety', panel: { suite: 'professional', tab: 'project' } },
  { label: 'Storage', panel: { suite: 'storage', tab: 'storage' } },
  { label: 'Assistant', panel: { suite: 'professional', tab: 'assistant' } },
  { label: 'Sequence', panel: { suite: 'v3', tab: 'timeline' } },
  { label: 'Time & FX', panel: { suite: 'v3', tab: 'effects' } },
  { label: 'Auto Color', panel: { suite: 'v3', tab: 'color' } },
  { label: 'Voiceover / ADR', panel: { suite: 'v3', tab: 'voiceover' } },
  { label: 'Review', panel: { suite: 'v3', tab: 'review' } },
  { label: 'QC', panel: { suite: 'v3', tab: 'qc' } },
  { label: 'Publish', panel: { suite: 'v3', tab: 'publish' } },
  { label: 'Interchange', panel: { suite: 'v3', tab: 'interchange' } },
  { label: 'Templates', panel: { suite: 'v3', tab: 'templates' } },
];

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const rounded = Math.floor(value);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatTimecode(value: number, fps = 30) {
  const safeValue = Math.max(0, Number.isFinite(value) ? value : 0);
  const totalFrames = Math.floor(safeValue * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

function titleTransformDefaults(title: Partial<LongformCreativeOptions['titles'][number]>) {
  if (title.style === 'center_card') {
    return { x: 0.1, y: 0.32, width: 0.8, scale: 1 };
  }
  if (title.template === 'glass') {
    return { x: 0.045, y: 0.7, width: 0.91, scale: 1 };
  }
  if (title.template === 'minimal') {
    const x = title.alignment === 'right' ? 0.54 : title.alignment === 'center' ? 0.28 : 0.08;
    return { x, y: 0.73, width: 0.38, scale: 1 };
  }
  const x = title.alignment === 'right' ? 0.385 : title.alignment === 'center' ? 0.22 : 0.055;
  return { x, y: 0.69, width: 0.56, scale: 1 };
}

function numberValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampValue(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function assetTrackKind(asset: LongformMediaAsset): 'video' | 'audio' {
  if (asset.mediaType === 'audio' || asset.kind === 'music' || asset.kind === 'voiceover') return 'audio';
  return 'video';
}

function sequenceClipFromAsset(asset: LongformMediaAsset, timelineStart: number): LongformSequenceClip {
  const mediaType = asset.mediaType || (assetTrackKind(asset) === 'audio' ? 'audio' : 'video');
  const duration = clampValue(
    mediaType === 'image' ? 5 : (asset.durationSec || 5),
    0.02,
    24 * 60 * 60,
  );
  return {
    id: `sequence-clip-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: asset.name,
    enabled: true,
    sourceType: 'asset',
    assetId: asset.id,
    nestedSequenceId: null,
    generator: 'solid',
    generatorColor: '#111827',
    sourceStart: 0,
    sourceEnd: duration,
    timelineStart,
    timelineEnd: timelineStart + duration,
    includeAudio: mediaType === 'video',
    linkedGroupId: null,
    compoundId: null,
    fit: mediaType === 'image' ? 'contain' : 'cover',
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    volumeDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    transitionIn: { type: 'cut', duration: 0 },
    transitionOut: { type: 'cut', duration: 0 },
    speed: {
      rate: 1,
      reverse: false,
      freeze: false,
      freezeAt: 0,
      opticalFlow: false,
      pitchPreserve: true,
      keyframes: [],
    },
    stabilization: { enabled: false, strength: 12, rollingShutter: 0, method: 'realtime' },
    chromaKey: {
      enabled: false,
      color: '#00FF00',
      similarity: 0.18,
      blend: 0.08,
      spill: 0.25,
      autoBackground: false,
    },
    masks: [],
    templateIds: [],
    notes: '',
  };
}

function cloneCuts(cuts: LongformCut[]) {
  return cuts.map((cut) => ({ ...cut }));
}

function cleanToken(value: string) {
  return value.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
}

function buildTranscriptChunks(words: TranscriptWord[]): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let current: TranscriptWord[] = [];
  let chunkStartIndex = 0;
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    const word = words[wordIndex];
    if (!current.length) chunkStartIndex = wordIndex;
    current.push(word);
    const sentenceEnd = /[.!?]["']?$/.test(word.word.trim());
    if (current.length >= 18 || (sentenceEnd && current.length >= 6)) {
      chunks.push({
        id: `transcript-${chunks.length}-${current[0].start}`,
        start: current[0].start,
        end: current[current.length - 1].end,
        text: current.map((item) => item.word).join(' ').trim(),
        startIndex: chunkStartIndex,
        endIndex: wordIndex,
      });
      current = [];
    }
  }
  if (current.length) {
    chunks.push({
      id: `transcript-${chunks.length}-${current[0].start}`,
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((item) => item.word).join(' ').trim(),
      startIndex: chunkStartIndex,
      endIndex: words.length - 1,
    });
  }
  return chunks;
}

function buildFillerSuggestions(words: TranscriptWord[]): FillerSuggestion[] {
  const suggestions: FillerSuggestion[] = [];
  const tokens = words.map((word) => cleanToken(word.word));
  const add = (startIndex: number, endIndex: number, label: string) => {
    const contextStart = Math.max(0, startIndex - 4);
    const contextEnd = Math.min(words.length, endIndex + 5);
    suggestions.push({
      id: `filler-${startIndex}-${endIndex}`,
      start: words[startIndex].start,
      end: words[endIndex].end,
      label,
      context: words.slice(contextStart, contextEnd).map((word) => word.word).join(' '),
    });
  };

  for (let index = 0; index < words.length; index += 1) {
    if (SINGLE_FILLERS.has(tokens[index])) {
      add(index, index, words[index].word);
      continue;
    }
    const phrase = FILLER_PHRASES.find((parts) => parts.every((part, offset) => tokens[index + offset] === part));
    if (phrase) {
      add(index, index + phrase.length - 1, phrase.join(' '));
      index += phrase.length - 1;
      continue;
    }
    if (index > 0 && tokens[index].length > 1 && tokens[index] === tokens[index - 1]) {
      add(index, index, `Repeated “${words[index].word}”`);
    }
  }
  return suggestions;
}

function cutsOverlap(start: number, end: number, cuts: LongformCut[], ignoreId?: string) {
  return cuts.some((cut) => cut.id !== ignoreId && start < cut.end - 0.001 && end > cut.start + 0.001);
}

function buildTransitionJoins(
  cuts: LongformCut[],
  keepSegments: Array<[number, number]>,
  enabled: boolean,
  editPoints: LongformEditPoint[],
): TransitionJoin[] {
  if (!keepSegments.length) return [];
  const activeCuts = enabled ? cuts.filter((cut) => cut.enabled) : [];
  const points = [...editPoints].sort((left, right) => left.time - right.time);
  const entries: Array<{ segment: [number, number]; joinIdBefore: string | null; kind: 'cut' | 'blade'; gapStart: number; gapEnd: number }> = [];
  keepSegments.forEach((segment, segmentIndex) => {
    const localPoints = points.filter((point) => point.time > segment[0] + 0.02 && point.time < segment[1] - 0.02);
    const boundaries = [segment[0], ...localPoints.map((point) => point.time), segment[1]];
    const gapCut = segmentIndex > 0
      ? activeCuts.find((cut) => (
          cut.start <= keepSegments[segmentIndex - 1][1] + 0.001
          && cut.end >= segment[0] - 0.001
        ))
      : null;
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const point = index > 0 ? localPoints[index - 1] : null;
      entries.push({
        segment: [boundaries[index], boundaries[index + 1]],
        joinIdBefore: entries.length === 0 ? null : point?.id || gapCut?.id || null,
        kind: point ? 'blade' : 'cut',
        gapStart: point?.time ?? (gapCut?.start ?? boundaries[index]),
        gapEnd: point?.time ?? (gapCut?.end ?? boundaries[index]),
      });
    }
  });
  return entries.slice(1).flatMap((entry, index) => {
    if (!entry.joinIdBefore) return [];
    const previous = entries[index].segment;
    return [{
      cutId: entry.joinIdBefore,
      kind: entry.kind,
      joinIndex: index,
      sourceTime: previous[1],
      gapStart: entry.gapStart,
      gapEnd: entry.gapEnd,
      maxDuration: Math.min(
        2,
        Math.max(0, previous[1] - previous[0]) * 0.45,
        Math.max(0, entry.segment[1] - entry.segment[0]) * 0.45,
      ),
    }];
  });
}

function previewColorFilter(
  color: LongformCreativeOptions['color'],
  adjustment?: LongformCreativeOptions['adjustmentLayers'][number] | null,
) {
  const exposure = color.exposure + (adjustment?.exposure || 0);
  const contrastValue = color.contrast * (adjustment?.contrast || 1);
  const saturationValue = color.saturation * (adjustment?.saturation || 1);
  const temperature = color.temperature + (adjustment?.temperature || 0);
  const tint = color.tint + (adjustment?.tint || 0);
  const brightness = Math.max(0.35, (1 + exposure * 1.8 + color.shadows * 0.12 + color.highlights * 0.05) / Math.max(0.35, color.gamma));
  const contrast = Math.max(0.25, contrastValue + color.highlights * 0.04 - color.shadows * 0.04);
  const saturation = Math.max(0, saturationValue + color.vibrance * 0.35);
  const warmth = Math.abs(temperature);
  const hue = temperature * -7 + tint * 5;
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturation}) sepia(${warmth * 0.12}) hue-rotate(${hue}deg)`;
}

function rebuildAnalysis(
  current: LongformAnalysis | null,
  cuts: LongformCut[],
  options: LongformOptions,
  sourceDuration: number,
): LongformAnalysis {
  const normalizedCuts = cloneCuts(cuts)
    .map((cut) => ({ ...cut, duration: Math.max(0, cut.end - cut.start) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const enabledCuts = options.enabled ? normalizedCuts.filter((cut) => cut.enabled) : [];
  const keepSegments: Array<[number, number]> = [];
  let cursor = options.startSec;
  for (const cut of enabledCuts) {
    if (cut.start > cursor + 0.001) keepSegments.push([cursor, cut.start]);
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < options.endSec - 0.001) keepSegments.push([cursor, options.endSec]);
  const selectedDurationSec = Math.max(0, options.endSec - options.startSec);
  const estimatedDurationSec = keepSegments.reduce((sum, [start, end]) => sum + (end - start), 0);
  return {
    cuts: normalizedCuts,
    keepSegments,
    originalDurationSec: current?.originalDurationSec ?? sourceDuration,
    selectedDurationSec,
    removedDurationSec: Math.max(0, selectedDurationSec - estimatedDurationSec),
    estimatedDurationSec,
    joinCount: Math.max(0, keepSegments.length - 1),
    options,
  };
}

export function LongformEditorPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { clipName = '' } = useParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const monitorSurfaceRef = useRef<HTMLDivElement>(null);
  const auditionStopRef = useRef<number | null>(null);
  const [options, setOptions] = useState<LongformOptions>(DEFAULT_OPTIONS);
  const [analysis, setAnalysis] = useState<LongformAnalysis | null>(null);
  const [wholeVideo, setWholeVideo] = useState(true);
  const [queuedOutput, setQueuedOutput] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [editedPreview, setEditedPreview] = useState(true);
  const [manualStart, setManualStart] = useState(0);
  const [manualEnd, setManualEnd] = useState(0.5);
  const [cutHistory, setCutHistory] = useState<CutHistory>(EMPTY_HISTORY);
  const [analysisNotice, setAnalysisNotice] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [selectedWordRange, setSelectedWordRange] = useState<[number, number] | null>(null);
  const [wordSelectionAnchor, setWordSelectionAnchor] = useState<number | null>(null);
  const [dismissedFillers, setDismissedFillers] = useState<Set<string>>(() => new Set());
  const [editRevision, setEditRevision] = useState(0);
  const [savedRevision, setSavedRevision] = useState(0);
  const [chapters, setChapters] = useState<LongformChapter[]>([]);
  const [creative, setCreative] = useState<LongformCreativeOptions>(DEFAULT_CREATIVE);
  const [showSafeAreas, setShowSafeAreas] = useState(true);
  const [useProxy, setUseProxy] = useState(false);
  const [workspace, setWorkspace] = useState<PremiereWorkspaceId>('editing');
  const [leftDockTab, setLeftDockTab] = useState<LeftDockTab>('project');
  const [rightDockTab, setRightDockTab] = useState<RightDockTab>('properties');
  const [leftDockCollapsed, setLeftDockCollapsed] = useState(false);
  const [rightDockCollapsed, setRightDockCollapsed] = useState(false);
  const [windowPanel, setWindowPanel] = useState<WindowPanel>(null);
  const [timelineTool, setTimelineTool] = useState<TimelineTool>('selection');
  const [timelineSnap, setTimelineSnap] = useState(true);
  const [selectedTitleId, setSelectedTitleId] = useState<string | null>(null);
  const [monitorPlaying, setMonitorPlaying] = useState(false);
  const [monitorSize, setMonitorSize] = useState({ width: 0, height: 0 });
  const [videoAspect, setVideoAspect] = useState(16 / 9);
  const [mobileDock, setMobileDock] = useState<'left' | 'right' | null>(null);

  const projectQuery = useQuery({
    queryKey: ['longform-project', clipName],
    queryFn: () => api.getLongformProject(clipName),
    enabled: Boolean(clipName),
    refetchInterval: (query) => query.state.data?.proxy?.status === 'building' ? 2500 : false,
  });

  useEffect(() => {
    const project = projectQuery.data;
    if (!project) return;
    const nextOptions = {
      ...DEFAULT_OPTIONS,
      ...project.options,
      endSec: project.options?.endSec || project.sourceDurationSec,
    };
    const hasSelectedRange = nextOptions.startSec > 0.001
      || nextOptions.endSec < project.sourceDurationSec - 0.001;
    setOptions(nextOptions);
    setWholeVideo(!hasSelectedRange);
    setPlayhead(nextOptions.startSec);
    setManualStart(nextOptions.startSec);
    setManualEnd(Math.min(nextOptions.endSec, nextOptions.startSec + 0.5));
    setCutHistory({ past: [], future: [] });
    setAnalysisNotice(null);
    setEditError(null);
    setDismissedFillers(new Set());
    setSelectedWordRange(null);
    setWordSelectionAnchor(null);
    setChapters(Array.isArray(project.chapters) ? project.chapters : []);
    setCreative({
      ...DEFAULT_CREATIVE,
      ...(project.creative || {}),
      editPoints: Array.isArray(project.creative?.editPoints) ? project.creative.editPoints : [],
      transitions: Array.isArray(project.creative?.transitions)
        ? project.creative.transitions.map((transition) => ({ ...transition, audioOffsetSec: transition.audioOffsetSec || 0 }))
        : [],
      titles: Array.isArray(project.creative?.titles)
        ? project.creative.titles.map((title) => ({
            ...title,
            subtitle: title.subtitle || '',
            template: title.template || 'broadcast',
            alignment: title.alignment || 'left',
            animation: title.animation || 'slide',
            accentColor: title.accentColor || '#8B5CF6',
            backgroundColor: title.backgroundColor || '#09090B',
            textColor: title.textColor || '#FFFFFF',
            ...titleTransformDefaults(title),
            x: Number.isFinite(title.x) ? title.x : titleTransformDefaults(title).x,
            y: Number.isFinite(title.y) ? title.y : titleTransformDefaults(title).y,
            width: Number.isFinite(title.width) ? title.width : titleTransformDefaults(title).width,
            scale: Number.isFinite(title.scale) ? title.scale : titleTransformDefaults(title).scale,
          }))
        : [],
      broll: Array.isArray(project.creative?.broll)
        ? project.creative.broll.map((item) => ({
            ...item,
            sourceOffset: item.sourceOffset || 0,
            layout: item.layout || 'cover',
            x: item.x || 0,
            y: item.y || 0,
            scale: item.scale || 1,
            rotation: item.rotation || 0,
            opacity: item.opacity ?? 1,
            cropLeft: item.cropLeft || 0,
            cropTop: item.cropTop || 0,
            cropRight: item.cropRight || 0,
            cropBottom: item.cropBottom || 0,
            keyframes: Array.isArray(item.keyframes) ? item.keyframes : [],
          }))
        : [],
      color: {
        ...DEFAULT_CREATIVE.color,
        ...(project.creative?.color || {}),
      },
      audio: {
        ...DEFAULT_CREATIVE.audio,
        ...(project.creative?.audio || {}),
        keyframes: Array.isArray(project.creative?.audio?.keyframes) ? project.creative.audio.keyframes : [],
      },
      captions: {
        ...DEFAULT_CREATIVE.captions,
        ...(project.creative?.captions || {}),
        cues: Array.isArray(project.creative?.captions?.cues) ? project.creative.captions.cues : [],
      },
      adjustmentLayers: Array.isArray(project.creative?.adjustmentLayers) ? project.creative.adjustmentLayers : [],
      multicam: {
        angles: Array.isArray(project.creative?.multicam?.angles) ? project.creative.multicam.angles : [],
        cuts: Array.isArray(project.creative?.multicam?.cuts) ? project.creative.multicam.cuts : [],
      },
      sequence: {
        ...DEFAULT_CREATIVE.sequence,
        ...(project.creative?.sequence || {}),
        sequences: Array.isArray(project.creative?.sequence?.sequences) && project.creative.sequence.sequences.length
          ? project.creative.sequence.sequences
          : DEFAULT_CREATIVE.sequence.sequences,
        markers: Array.isArray(project.creative?.sequence?.markers) ? project.creative.sequence.markers : [],
      },
      colorWorkflow: {
        ...DEFAULT_CREATIVE.colorWorkflow,
        ...(project.creative?.colorWorkflow || {}),
        management: {
          ...DEFAULT_CREATIVE.colorWorkflow.management,
          ...(project.creative?.colorWorkflow?.management || {}),
        },
        autoGrade: {
          ...DEFAULT_CREATIVE.colorWorkflow.autoGrade,
          ...(project.creative?.colorWorkflow?.autoGrade || {}),
        },
        versions: Array.isArray(project.creative?.colorWorkflow?.versions) ? project.creative.colorWorkflow.versions : [],
        groups: Array.isArray(project.creative?.colorWorkflow?.groups) ? project.creative.colorWorkflow.groups : [],
      },
      adr: {
        ...DEFAULT_CREATIVE.adr,
        ...(project.creative?.adr || {}),
        cues: Array.isArray(project.creative?.adr?.cues) ? project.creative.adr.cues : [],
      },
      publish: {
        ...DEFAULT_CREATIVE.publish,
        ...(project.creative?.publish || {}),
        destinations: Array.isArray(project.creative?.publish?.destinations)
          ? project.creative.publish.destinations
          : DEFAULT_CREATIVE.publish.destinations,
      },
      delivery: {
        ...DEFAULT_CREATIVE.delivery,
        ...(project.creative?.delivery || {}),
      },
    });
    setUseProxy(project.proxy?.status === 'ready');
    const draftRevision = Math.max(0, project.draftRevision || 0);
    setEditRevision(draftRevision);
    setSavedRevision(draftRevision);
    if (project.cuts?.length || typeof project.removedDurationSec === 'number') {
      setAnalysis({
        cuts: project.cuts || [],
        keepSegments: project.keepSegments || [],
        originalDurationSec: project.originalDurationSec ?? project.sourceDurationSec,
        selectedDurationSec: project.selectedDurationSec ?? project.sourceDurationSec,
        removedDurationSec: project.removedDurationSec ?? 0,
        estimatedDurationSec: project.estimatedDurationSec ?? project.sourceDurationSec,
        joinCount: project.joinCount ?? 0,
        options: nextOptions,
      });
    } else {
      setAnalysis(null);
    }
  }, [projectQuery.data]);

  const effectiveOptions = useMemo<LongformOptions>(() => {
    const duration = projectQuery.data?.sourceDurationSec || options.endSec || 0;
    return {
      ...options,
      startSec: wholeVideo ? 0 : Math.max(0, options.startSec),
      endSec: wholeVideo ? duration : Math.min(duration, Math.max(options.startSec, options.endSec)),
    };
  }, [options, wholeVideo, projectQuery.data?.sourceDurationSec]);

  const transcriptWords = useMemo<TranscriptWord[]>(() => {
    const rawWords = (projectQuery.data as (typeof projectQuery.data & { words?: unknown }))?.words;
    if (!Array.isArray(rawWords)) return [];
    return rawWords.flatMap((raw): TranscriptWord[] => {
      if (!raw || typeof raw !== 'object') return [];
      const source = raw as unknown as Record<string, unknown>;
      const word = String(source.word || '').trim();
      const start = Number(source.start);
      const end = Number(source.end);
      if (!word || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
      const normalized: TranscriptWord = { word, start, end };
      if (Number.isFinite(Number(source.confidence))) normalized.confidence = Number(source.confidence);
      if (typeof source.speaker === 'string' || typeof source.speaker === 'number') normalized.speaker = source.speaker;
      return [normalized];
    }).sort((left, right) => left.start - right.start || left.end - right.end);
  }, [projectQuery.data]);

  const transcriptChunks = useMemo(() => buildTranscriptChunks(transcriptWords), [transcriptWords]);
  const visibleTranscriptChunks = useMemo(() => {
    const search = transcriptSearch.trim().toLowerCase();
    return search ? transcriptChunks.filter((chunk) => chunk.text.toLowerCase().includes(search)) : transcriptChunks;
  }, [transcriptChunks, transcriptSearch]);
  const fillerSuggestions = useMemo(() => buildFillerSuggestions(transcriptWords), [transcriptWords]);
  const enabledPreviewCuts = useMemo(
    () => effectiveOptions.enabled
      ? (analysis?.cuts || []).filter((cut) => cut.enabled).sort((left, right) => left.start - right.start)
      : [],
    [analysis?.cuts, effectiveOptions.enabled],
  );
  const transitionJoins = useMemo(
    () => buildTransitionJoins(
      analysis?.cuts || [],
      analysis?.keepSegments || [],
      effectiveOptions.enabled,
      creative.editPoints,
    ),
    [analysis?.cuts, analysis?.keepSegments, effectiveOptions.enabled, creative.editPoints],
  );
  const transitionOverlapSec = useMemo(() => {
    const joinsByCut = new Map(transitionJoins.map((join) => [join.cutId, join]));
    return creative.transitions.reduce((total, transition) => (
      transition.type !== 'cut' && joinsByCut.has(transition.cutId)
        ? total + Math.min(transition.duration, joinsByCut.get(transition.cutId)?.maxDuration || 0)
        : total
    ), 0);
  }, [creative.transitions, transitionJoins]);
  const activeTitle = useMemo(
    () => [...creative.titles].reverse().find((title) => playhead >= title.start && playhead <= title.end) || null,
    [creative.titles, playhead],
  );
  const selectedTitle = useMemo(
    () => creative.titles.find((title) => title.id === selectedTitleId) || activeTitle,
    [activeTitle, creative.titles, selectedTitleId],
  );
  const activeSequence = useMemo(
    () => creative.sequence.sequences.find((sequence) => sequence.id === creative.sequence.activeSequenceId)
      || creative.sequence.sequences[0],
    [creative.sequence.activeSequenceId, creative.sequence.sequences],
  );
  const activeBroll = useMemo(
    () => [...creative.broll].reverse().find((item) => playhead >= item.start && playhead <= item.end) || null,
    [creative.broll, playhead],
  );
  const activeCaption = useMemo(
    () => creative.captions.enabled
      ? creative.captions.cues.find((cue) => playhead >= cue.start && playhead <= cue.end) || null
      : null,
    [creative.captions, playhead],
  );
  const activeAdjustment = useMemo(
    () => [...creative.adjustmentLayers].reverse().find((layer) => playhead >= layer.start && playhead <= layer.end) || null,
    [creative.adjustmentLayers, playhead],
  );
  const activeMulticamCut = useMemo(
    () => [...creative.multicam.cuts].reverse().find((cut) => playhead >= cut.start && playhead <= cut.end) || null,
    [creative.multicam.cuts, playhead],
  );
  const activeMulticamAngle = useMemo(
    () => activeMulticamCut
      ? creative.multicam.angles.find((angle) => angle.id === activeMulticamCut.angleId) || null
      : null,
    [activeMulticamCut, creative.multicam.angles],
  );
  const activeBrollAsset = useMemo(
    () => activeBroll
      ? projectQuery.data?.assets.find((asset) => asset.id === activeBroll.assetId) || null
      : null,
    [activeBroll, projectQuery.data?.assets],
  );
  const activeMulticamAsset = useMemo(
    () => activeMulticamAngle
      ? projectQuery.data?.assets.find((asset) => asset.id === activeMulticamAngle.assetId) || null
      : null,
    [activeMulticamAngle, projectQuery.data?.assets],
  );
  const programFrame = useMemo(() => {
    const surfaceWidth = monitorSize.width;
    const surfaceHeight = monitorSize.height;
    if (surfaceWidth <= 0 || surfaceHeight <= 0) {
      return { left: 0, top: 0, width: 0, height: 0 };
    }
    const aspect = Number.isFinite(videoAspect) && videoAspect > 0 ? videoAspect : 16 / 9;
    const width = Math.min(surfaceWidth, surfaceHeight * aspect);
    const height = width / aspect;
    return {
      left: (surfaceWidth - width) / 2,
      top: (surfaceHeight - height) / 2,
      width,
      height,
    };
  }, [monitorSize, videoAspect]);

  useEffect(() => {
    if (!selectedTitleId) return;
    if (!creative.titles.some((title) => title.id === selectedTitleId)) setSelectedTitleId(null);
  }, [creative.titles, selectedTitleId]);

  useEffect(() => {
    const surface = monitorSurfaceRef.current;
    if (!surface) return;
    const update = () => {
      const bounds = surface.getBoundingClientRect();
      setMonitorSize({ width: bounds.width, height: bounds.height });
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(surface);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [projectQuery.data?.name]);

  const analyzeMutation = useMutation({
    mutationFn: () => api.analyzeLongform(clipName, effectiveOptions),
    onSuccess: (result) => {
      setAnalysis(result);
      const validCutIds = new Set([
        ...result.cuts.map((cut) => cut.id),
        ...creative.editPoints.map((point) => point.id),
      ]);
      setCreative((current) => ({
        ...current,
        transitions: current.transitions.filter((transition) => validCutIds.has(transition.cutId)),
      }));
      setQueuedOutput(null);
      setCutHistory({ past: [], future: [] });
      setAnalysisNotice(null);
      setEditError(null);
      setEditRevision((revision) => revision + 1);
    },
  });

  const renderMutation = useMutation({
    mutationFn: () => api.renderLongform(clipName, {
      options: effectiveOptions,
      cuts: analysis?.cuts || [],
      chapters,
      creative,
    }),
    onSuccess: (result) => {
      setQueuedOutput(result.outputName);
      qc.invalidateQueries({ queryKey: ['job-status'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const saveMutation = useMutation({
    mutationFn: (payload: { options: LongformOptions; cuts: LongformCut[]; chapters: LongformChapter[]; creative: LongformCreativeOptions; revision: number }) => api.saveLongformProject(clipName, payload),
    onSuccess: (_, variables) => setSavedRevision((revision) => Math.max(revision, variables.revision)),
  });
  const assetMutation = useMutation({
    mutationFn: ({ kind, file }: { kind: 'broll' | 'music' | 'angle' | 'lut' | 'media' | 'voiceover'; file: File }) => api.uploadLongformAsset(clipName, kind, file),
    onSuccess: (asset, variables) => {
      qc.setQueryData(['longform-project', clipName], (current: typeof projectQuery.data) => current ? {
        ...current,
        assets: [...(current.assets || []).filter((item) => item.id !== asset.id), asset],
      } : current);
      setCreative((current) => {
        if (variables.kind === 'lut') return { ...current, color: { ...current.color, lutAssetId: asset.id } };
        if (variables.kind === 'angle') {
          return {
            ...current,
            multicam: {
              ...current.multicam,
              angles: [...current.multicam.angles, {
                id: `angle-${Date.now()}`,
                assetId: asset.id,
                name: asset.name,
                offsetSec: 0,
                speaker: '',
              }],
            },
          };
        }
        if (variables.kind === 'media' || variables.kind === 'voiceover' || variables.kind === 'music') {
          const trackKind = variables.kind === 'music' || variables.kind === 'voiceover'
            ? 'audio'
            : assetTrackKind(asset);
          const sequenceState = current.sequence;
          const activeId = sequenceState.activeSequenceId;
          const sequences = sequenceState.sequences.map((sequence) => {
            if (sequence.id !== activeId) return sequence;
            let tracks = sequence.tracks;
            const preferredName = variables.kind === 'music'
              ? 'Music'
              : variables.kind === 'voiceover'
                ? 'Voiceover'
                : null;
            let track = preferredName
              ? tracks.find((item) => item.kind === trackKind && !item.locked && item.name.toLowerCase() === preferredName.toLowerCase())
              : tracks.find((item) => item.kind === trackKind && !item.locked);
            if (!track) {
              track = {
                id: `${trackKind === 'video' ? 'v' : 'a'}-${Date.now()}`,
                name: preferredName || `${trackKind === 'video' ? 'Video' : 'Audio'} ${tracks.filter((item) => item.kind === trackKind).length + 1}`,
                kind: trackKind,
                order: tracks.length,
                locked: false,
                hidden: false,
                muted: false,
                solo: false,
                linked: true,
                volumeDb: 0,
                clips: [],
              };
              tracks = [...tracks, track];
            }
            const newClip = sequenceClipFromAsset(asset, playhead);
            return {
              ...sequence,
              tracks: tracks.map((item) => item.id === track.id
                ? { ...item, clips: [...item.clips, newClip].sort((left, right) => left.timelineStart - right.timelineStart) }
                : item),
            };
          });
          return {
            ...current,
            ...(variables.kind === 'music' ? { musicAssetId: null } : {}),
            sequence: {
              ...sequenceState,
              enabled: true,
              sequences,
            },
          };
        }
        return {
          ...current,
          broll: [...current.broll, {
            id: `broll-${Date.now()}`,
            assetId: asset.id,
            start: playhead,
            end: Math.min(effectiveOptions.endSec, playhead + 5),
            sourceOffset: 0,
            layout: 'cover',
            x: 0,
            y: 0,
            scale: 1,
            rotation: 0,
            opacity: 1,
            cropLeft: 0,
            cropTop: 0,
            cropRight: 0,
            cropBottom: 0,
            keyframes: [],
          }],
        };
      });
      setEditRevision((revision) => revision + 1);
      setQueuedOutput(null);
    },
  });
  const proxyMutation = useMutation({
    mutationFn: (action: 'build' | 'delete') => action === 'build'
      ? api.buildLongformProxy(clipName)
      : api.deleteLongformProxy(clipName),
    onSuccess: (proxy, action) => {
      qc.setQueryData(['longform-project', clipName], (current: typeof projectQuery.data) => current ? { ...current, proxy } : current);
      setUseProxy(action === 'build' && proxy.status === 'ready');
      qc.invalidateQueries({ queryKey: ['longform-project', clipName] });
    },
  });

  useEffect(() => {
    if (!editRevision || editRevision <= savedRevision || !analysis || !clipName) return;
    const timer = window.setTimeout(() => {
      saveMutation.mutate({
        options: effectiveOptions,
        cuts: cloneCuts(analysis.cuts),
        chapters,
        creative,
        revision: editRevision,
      });
    }, 900);
    return () => window.clearTimeout(timer);
  // The revision is the explicit debounce trigger; the payload is captured from
  // the same render that produced it so initial project hydration never writes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRevision]);

  function invalidateAnalysis(message: string) {
    setAnalysis(null);
    setCutHistory({ past: [], future: [] });
    setAnalysisNotice(message);
    setEditError(null);
    setQueuedOutput(null);
    setEditRevision((revision) => revision + 1);
  }

  function patchOption<K extends keyof LongformOptions>(key: K, value: LongformOptions[K]) {
    if (options[key] === value) return;
    setOptions((current) => ({ ...current, [key]: value }));
    if (ANALYSIS_KEYS.has(key)) {
      invalidateAnalysis('Analysis settings changed. Analyze again to rebuild the automatic silence map, or add manual cuts below.');
      return;
    }
    if (key === 'enabled' && analysis && projectQuery.data) {
      const nextOptions = { ...effectiveOptions, enabled: Boolean(value) };
      setAnalysis(rebuildAnalysis(analysis, analysis.cuts, nextOptions, projectQuery.data.sourceDurationSec));
    }
    setEditRevision((revision) => revision + 1);
    setQueuedOutput(null);
  }

  function patchOptions(patch: Partial<LongformOptions>) {
    const changedKeys = (Object.keys(patch) as Array<keyof LongformOptions>)
      .filter((key) => patch[key] !== undefined && options[key] !== patch[key]);
    if (!changedKeys.length) return;
    setOptions((current) => ({ ...current, ...patch }));
    if (changedKeys.some((key) => ANALYSIS_KEYS.has(key))) {
      invalidateAnalysis('Analysis settings changed. Analyze again to rebuild the automatic silence map.');
      return;
    }
    setEditRevision((revision) => revision + 1);
    setQueuedOutput(null);
  }

  function changeScope(nextWholeVideo: boolean) {
    if (wholeVideo === nextWholeVideo) return;
    setWholeVideo(nextWholeVideo);
    invalidateAnalysis('The edit scope changed. Analyze the new range again, or build a manual cut list.');
  }

  function commitCuts(nextCuts: LongformCut[]) {
    const sourceDuration = projectQuery.data?.sourceDurationSec || effectiveOptions.endSec;
    const currentCuts = analysis?.cuts || [];
    if (JSON.stringify(currentCuts) === JSON.stringify(nextCuts)) return;
    setCutHistory((history) => ({
      past: [...history.past, cloneCuts(currentCuts)].slice(-60),
      future: [],
    }));
    setAnalysis(rebuildAnalysis(analysis, nextCuts, effectiveOptions, sourceDuration));
    const validCutIds = new Set([
      ...nextCuts.map((cut) => cut.id),
      ...creative.editPoints.map((point) => point.id),
    ]);
    setCreative((current) => ({
      ...current,
      transitions: current.transitions.filter((transition) => validCutIds.has(transition.cutId)),
    }));
    setAnalysisNotice(null);
    setEditError(null);
    setQueuedOutput(null);
    setEditRevision((revision) => revision + 1);
  }

  function validateCutRange(start: number, end: number, ignoreId?: string) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.02) {
      setEditError('A cut must be at least 0.02 seconds long.');
      return false;
    }
    if (start < effectiveOptions.startSec - 0.001 || end > effectiveOptions.endSec + 0.001) {
      setEditError(`Cuts must stay inside ${formatTime(effectiveOptions.startSec)}–${formatTime(effectiveOptions.endSec)}.`);
      return false;
    }
    if (cutsOverlap(start, end, analysis?.cuts || [], ignoreId)) {
      setEditError('That range overlaps another cut. Adjust the existing boundary instead.');
      return false;
    }
    return true;
  }

  function addCutRange(start: number, end: number, idPrefix = 'manual') {
    const boundedStart = Math.max(effectiveOptions.startSec, Math.min(effectiveOptions.endSec, start));
    const boundedEnd = Math.max(effectiveOptions.startSec, Math.min(effectiveOptions.endSec, end));
    if (!validateCutRange(boundedStart, boundedEnd)) return false;
    const cut: LongformCut = {
      id: `${idPrefix}-${Date.now()}-${Math.round(boundedStart * 1000)}`,
      start: boundedStart,
      end: boundedEnd,
      duration: boundedEnd - boundedStart,
      enabled: true,
    };
    commitCuts([...(analysis?.cuts || []), cut]);
    return true;
  }

  function addManualCut() {
    if (addCutRange(manualStart, manualEnd)) {
      setManualStart(manualEnd);
      setManualEnd(Math.min(effectiveOptions.endSec, manualEnd + 0.5));
    }
  }

  function selectTranscriptWord(index: number, extend: boolean) {
    if (extend && wordSelectionAnchor !== null) {
      setSelectedWordRange([Math.min(wordSelectionAnchor, index), Math.max(wordSelectionAnchor, index)]);
      return;
    }
    setWordSelectionAnchor(index);
    setSelectedWordRange([index, index]);
  }

  function cutTranscriptSelection() {
    if (!selectedWordRange) return;
    const [startIndex, endIndex] = selectedWordRange;
    const first = transcriptWords[startIndex];
    const last = transcriptWords[endIndex];
    if (!first || !last) return;
    if (addCutRange(first.start, last.end, 'transcript')) {
      setSelectedWordRange(null);
      setWordSelectionAnchor(null);
    }
  }

  function toggleCut(id: string) {
    if (!analysis) return;
    commitCuts(analysis.cuts.map((cut) => cut.id === id ? { ...cut, enabled: !cut.enabled } : cut));
  }

  function deleteCut(id: string) {
    if (!analysis) return;
    commitCuts(analysis.cuts.filter((cut) => cut.id !== id));
  }

  function updateCutBounds(id: string, start: number, end: number) {
    if (!analysis || !validateCutRange(start, end, id)) return false;
    commitCuts(analysis.cuts.map((cut) => cut.id === id
      ? { ...cut, start, end, duration: end - start }
      : cut));
    return true;
  }

  function undoCuts() {
    if (!cutHistory.past.length || !projectQuery.data) return;
    const previous = cutHistory.past[cutHistory.past.length - 1];
    const current = cloneCuts(analysis?.cuts || []);
    setCutHistory({
      past: cutHistory.past.slice(0, -1),
      future: [current, ...cutHistory.future].slice(0, 60),
    });
    setAnalysis(rebuildAnalysis(analysis, previous, effectiveOptions, projectQuery.data.sourceDurationSec));
    setEditError(null);
    setQueuedOutput(null);
    setEditRevision((revision) => revision + 1);
  }

  function redoCuts() {
    if (!cutHistory.future.length || !projectQuery.data) return;
    const next = cutHistory.future[0];
    const current = cloneCuts(analysis?.cuts || []);
    setCutHistory({
      past: [...cutHistory.past, current].slice(-60),
      future: cutHistory.future.slice(1),
    });
    setAnalysis(rebuildAnalysis(analysis, next, effectiveOptions, projectQuery.data.sourceDurationSec));
    setEditError(null);
    setQueuedOutput(null);
    setEditRevision((revision) => revision + 1);
  }

  function addChapter() {
    addChapterAt(playhead);
  }

  function addChapterAt(requestedTime: number, requestedTitle?: string) {
    const time = Math.max(effectiveOptions.startSec, Math.min(effectiveOptions.endSec, requestedTime));
    setChapters((current) => [
      ...current,
      {
        id: `chapter-${Date.now()}-${Math.round(time * 1000)}`,
        time,
        title: (requestedTitle || `Chapter ${current.length + 1}`).slice(0, 160),
      },
    ].sort((left, right) => left.time - right.time));
    setEditRevision((revision) => revision + 1);
    setQueuedOutput(null);
  }

  function updateChapter(id: string, patch: Partial<Pick<LongformChapter, 'time' | 'title'>>) {
    setChapters((current) => current.map((chapter) => chapter.id === id
      ? {
          ...chapter,
          ...patch,
          time: Math.max(effectiveOptions.startSec, Math.min(effectiveOptions.endSec, patch.time ?? chapter.time)),
          title: (patch.title ?? chapter.title).slice(0, 160),
        }
      : chapter).sort((left, right) => left.time - right.time));
    setEditRevision((revision) => revision + 1);
    setQueuedOutput(null);
  }

  function deleteChapter(id: string) {
    setChapters((current) => current.filter((chapter) => chapter.id !== id));
    setEditRevision((revision) => revision + 1);
    setQueuedOutput(null);
  }

  function patchCreative(patch: Partial<LongformCreativeOptions>) {
    setCreative((current) => ({ ...current, ...patch }));
    setEditRevision((revision) => revision + 1);
    setQueuedOutput(null);
  }

  function addEditPoint(at = playhead) {
    const time = Math.max(effectiveOptions.startSec, Math.min(effectiveOptions.endSec, at));
    if (creative.editPoints.some((point) => Math.abs(point.time - time) < 0.04)) {
      setEditError('There is already an edit point at this frame.');
      return;
    }
    patchCreative({
      editPoints: [...creative.editPoints, {
        id: `blade-${Date.now()}-${Math.round(time * 1000)}`,
        time,
        label: `Edit ${creative.editPoints.length + 1}`,
      }].sort((left, right) => left.time - right.time),
    });
    setEditError(null);
  }

  function updateEditPoint(id: string, patch: Partial<Pick<LongformEditPoint, 'time' | 'label'>>) {
    patchCreative({
      editPoints: creative.editPoints.map((point) => point.id === id
        ? {
            ...point,
            ...patch,
            time: Math.max(effectiveOptions.startSec, Math.min(effectiveOptions.endSec, patch.time ?? point.time)),
            label: (patch.label ?? point.label).slice(0, 80),
          }
        : point).sort((left, right) => left.time - right.time),
    });
  }

  function deleteEditPoint(id: string) {
    patchCreative({
      editPoints: creative.editPoints.filter((point) => point.id !== id),
      transitions: creative.transitions.filter((transition) => transition.cutId !== id),
    });
  }

  function addTitleCard(
    position: 'playhead' | 'intro' | 'outro' = 'playhead',
    preset: Partial<LongformCreativeOptions['titles'][number]> = {},
  ) {
    const start = position === 'intro'
      ? effectiveOptions.startSec
      : position === 'outro'
        ? Math.max(effectiveOptions.startSec, effectiveOptions.endSec - 4)
        : playhead;
    const end = Math.min(effectiveOptions.endSec, start + 4);
    const id = `title-${Date.now()}`;
    const baseTitle: LongformCreativeOptions['titles'][number] = {
        id,
        text: position === 'intro' ? 'Program title' : position === 'outro' ? 'Thanks for watching' : 'Title',
        subtitle: position === 'playhead' ? 'Name or context' : '',
        start,
        end,
        style: position === 'playhead' ? 'lower_third' : 'center_card',
        template: position === 'playhead' ? 'broadcast' : 'minimal',
        alignment: position === 'playhead' ? 'left' : 'center',
        animation: position === 'playhead' ? 'slide' : 'fade',
        accentColor: '#8B5CF6',
        backgroundColor: '#09090B',
        textColor: '#FFFFFF',
        x: 0,
        y: 0,
        width: 0.56,
        scale: 1,
        ...preset,
    };
    const transform = titleTransformDefaults(baseTitle);
    patchCreative({
      titles: [...creative.titles, {
        ...baseTitle,
        x: preset.x ?? transform.x,
        y: preset.y ?? transform.y,
        width: preset.width ?? transform.width,
        scale: preset.scale ?? transform.scale,
      }],
    });
    setSelectedTitleId(id);
    setWorkspace('graphics');
    setLeftDockTab('graphics');
    setRightDockTab('properties');
    setRightDockCollapsed(false);
  }

  function updateTitle(id: string, patch: Partial<LongformCreativeOptions['titles'][number]>) {
    patchCreative({ titles: creative.titles.map((title) => title.id === id ? { ...title, ...patch } : title) });
  }

  function updateBroll(id: string, patch: Partial<LongformCreativeOptions['broll'][number]>) {
    patchCreative({ broll: creative.broll.map((item) => item.id === id ? { ...item, ...patch } : item) });
  }

  function setJoinTransition(cutId: string, type: LongformTransitionType, duration?: number) {
    const existing = creative.transitions.find((transition) => transition.cutId === cutId);
    const join = transitionJoins.find((item) => item.cutId === cutId);
    const usableType = type !== 'cut' && (!join || join.maxDuration < 0.08) ? 'cut' : type;
    const next = {
      id: existing?.id || `transition-${Date.now()}-${cutId}`,
      cutId,
      type: usableType,
      duration: usableType === 'cut'
        ? 0
        : Math.max(0.08, Math.min(join?.maxDuration || 2, duration ?? existing?.duration ?? 0.35)),
      audioOffsetSec: existing?.audioOffsetSec || 0,
    };
    patchCreative({
      transitions: existing
        ? creative.transitions.map((transition) => transition.cutId === cutId ? next : transition)
        : [...creative.transitions, next],
    });
  }

  function setJoinAudioOffset(cutId: string, audioOffsetSec: number) {
    const existing = creative.transitions.find((transition) => transition.cutId === cutId);
    const join = transitionJoins.find((item) => item.cutId === cutId);
    const maximum = Math.min(2, Math.max(0, join?.maxDuration || 2));
    const next = {
      id: existing?.id || `transition-${Date.now()}-${cutId}`,
      cutId,
      type: existing?.type || ('cut' as const),
      duration: existing?.duration || 0,
      audioOffsetSec: Math.max(-maximum, Math.min(maximum, audioOffsetSec)),
    };
    patchCreative({
      transitions: existing
        ? creative.transitions.map((transition) => transition.cutId === cutId ? next : transition)
        : [...creative.transitions, next],
    });
  }

  function applyTransitionToAll(type: LongformTransitionType) {
    const duration = type === 'cut' ? 0 : 0.35;
    const byCut = new Map(creative.transitions.map((transition) => [transition.cutId, transition]));
    patchCreative({
      transitions: transitionJoins.map((join, index) => ({
        id: byCut.get(join.cutId)?.id || `transition-${Date.now()}-${index}`,
        cutId: join.cutId,
        type: type !== 'cut' && join.maxDuration < 0.08 ? 'cut' : type,
        duration: type === 'cut' || join.maxDuration < 0.08
          ? 0
          : Math.min(join.maxDuration, byCut.get(join.cutId)?.duration || duration),
        audioOffsetSec: byCut.get(join.cutId)?.audioOffsetSec || 0,
      })),
    });
  }

  function activateWorkspace(nextWorkspace: PremiereWorkspaceId) {
    setWorkspace(nextWorkspace);
    setWindowPanel(null);
    if (nextWorkspace === 'editing') {
      setLeftDockTab('project');
      setRightDockTab('properties');
    } else if (nextWorkspace === 'graphics') {
      setLeftDockTab('graphics');
      setRightDockTab('properties');
    } else if (nextWorkspace === 'color') {
      setLeftDockTab('effects');
      setRightDockTab('color');
    } else if (nextWorkspace === 'audio') {
      setLeftDockTab('project');
      setRightDockTab('audio');
    } else if (nextWorkspace === 'captions') {
      setLeftDockTab('text');
      setRightDockTab('properties');
    } else if (nextWorkspace === 'review') {
      setLeftDockTab('project');
      setRightDockTab('properties');
      setWindowPanel({ suite: 'v3', tab: 'review' });
    } else {
      setLeftDockTab('project');
      setRightDockTab('export');
    }
    setLeftDockCollapsed(false);
    setRightDockCollapsed(false);
  }

  function openWindowPanel(panel: Exclude<WindowPanel, null>) {
    setWindowPanel(panel);
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, button, a, [contenteditable="true"]')) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoCuts();
        else undoCuts();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const toolShortcuts: Partial<Record<string, TimelineTool>> = {
        v: 'selection',
        a: 'track',
        b: 'ripple',
        n: 'rolling',
        r: 'rate',
        c: 'razor',
        y: 'slip',
        u: 'slide',
        h: 'hand',
        z: 'zoom',
        t: 'type',
      };
      if (toolShortcuts[key]) {
        event.preventDefault();
        setTimelineTool(toolShortcuts[key]!);
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      if (event.key === ' ') {
        event.preventDefault();
        if (event.repeat) return;
        if (video.paused) video.play().catch(() => undefined);
        else video.pause();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        video.pause();
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        seekTo(video.currentTime + direction * (event.shiftKey ? 1 : 1 / 30));
        return;
      }
      if (key === 'i') {
        event.preventDefault();
        setManualStart(playhead);
        if (manualEnd <= playhead) setManualEnd(Math.min(effectiveOptions.endSec, playhead + 0.5));
        return;
      }
      if (key === 'o') {
        event.preventDefault();
        setManualEnd(playhead);
        if (manualStart >= playhead) setManualStart(Math.max(effectiveOptions.startSec, playhead - 0.5));
        return;
      }
      if (key === 'j') {
        event.preventDefault();
        video.pause();
        video.playbackRate = 1;
        seekTo(video.currentTime - 1);
        return;
      }
      if (key === 'k') {
        event.preventDefault();
        video.pause();
        return;
      }
      if (key === 'l') {
        event.preventDefault();
        video.playbackRate = video.paused
          ? 1
          : video.playbackRate < 1.5
            ? 1.5
            : video.playbackRate < 2
              ? 2
              : 1;
        video.play().catch(() => undefined);
        return;
      }
      if (key === 'm') {
        event.preventDefault();
        addChapter();
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  function seekTo(seconds: number, autoplay = false, lead = 0) {
    const video = videoRef.current;
    if (!video) return;
    const maxTime = projectQuery.data?.sourceDurationSec || video.duration || seconds;
    const target = Math.max(0, Math.min(maxTime, seconds - lead));
    video.currentTime = target;
    setPlayhead(target);
    if (autoplay) video.play().catch(() => undefined);
  }

  function auditionCut(cut: LongformCut) {
    setEditedPreview(true);
    auditionStopRef.current = Math.min(effectiveOptions.endSec, cut.end + 1.25);
    seekTo(cut.start, true, 1.25);
  }

  function enforceEditedPreview(video: HTMLVideoElement) {
    let current = video.currentTime;
    if (editedPreview && !video.paused) {
      if (current < effectiveOptions.startSec - 0.01) {
        video.currentTime = effectiveOptions.startSec;
        current = effectiveOptions.startSec;
      }
      const cut = enabledPreviewCuts.find((item) => current >= item.start - 0.04 && current < item.end - 0.005);
      if (cut) {
        current = Math.min(cut.end + 0.002, effectiveOptions.endSec);
        video.currentTime = current;
      }
      if (current >= effectiveOptions.endSec - 0.01) {
        video.pause();
        current = effectiveOptions.endSec;
      }
    }
    return current;
  }

  function handleVideoProgress(video: HTMLVideoElement) {
    const current = enforceEditedPreview(video);
    if (auditionStopRef.current !== null && current >= auditionStopRef.current) {
      video.pause();
      auditionStopRef.current = null;
    }
    setPlayhead(current);
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !editedPreview || typeof video.requestVideoFrameCallback !== 'function') return;
    let frameHandle: number | null = null;
    const tick = () => {
      frameHandle = null;
      enforceEditedPreview(video);
      if (!video.paused) frameHandle = video.requestVideoFrameCallback(tick);
    };
    const start = () => {
      if (frameHandle === null) frameHandle = video.requestVideoFrameCallback(tick);
    };
    video.addEventListener('play', start);
    if (!video.paused) start();
    return () => {
      video.removeEventListener('play', start);
      if (frameHandle !== null) video.cancelVideoFrameCallback(frameHandle);
    };
  }, [editedPreview, enabledPreviewCuts, effectiveOptions.startSec, effectiveOptions.endSec]);

  if (projectQuery.isLoading) {
    return <PageState icon={<Loader2 className="h-6 w-6 animate-spin" />} title="Loading long-form project" />;
  }

  if (projectQuery.isError || !projectQuery.data) {
    return (
      <PageState
        icon={<Film className="h-6 w-6" />}
        title="Long-form project unavailable"
        detail={projectQuery.error instanceof Error ? projectQuery.error.message : 'The source or project metadata could not be loaded.'}
        action={<button className="btn-secondary" onClick={() => navigate('/library')}><ArrowLeft className="h-4 w-4" /> Library</button>}
      />
    );
  }

  const project = projectQuery.data;
  const selectedDuration = Math.max(0, effectiveOptions.endSec - effectiveOptions.startSec);
  const stats = analysis || {
    originalDurationSec: project.sourceDurationSec,
    selectedDurationSec: selectedDuration,
    removedDurationSec: 0,
    estimatedDurationSec: selectedDuration,
    joinCount: 0,
  };
  const finishedDuration = Math.max(0, stats.estimatedDurationSec - transitionOverlapSec);

  return (
    <div className="relative flex h-[100dvh] min-h-[680px] min-w-0 flex-col overflow-hidden bg-[#0d0d0f] text-slate-200">
      <header className="flex h-12 shrink-0 items-center border-b border-black bg-[#181818] shadow-[0_1px_0_rgba(255,255,255,0.04)]">
        <button className="grid h-12 w-11 shrink-0 place-items-center border-r border-white/5 text-slate-500 hover:bg-white/5 hover:text-white" onClick={() => navigate('/library')} title="Back to Library">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 items-center gap-2 border-r border-white/5 px-3">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded bg-violet-500/15 text-violet-300">
            <Film className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[11px] font-semibold text-slate-200" title={project.name}>{project.name}</div>
            <div className="text-[8px] uppercase tracking-[0.16em] text-slate-600">Long-form sequence</div>
          </div>
        </div>
        <nav className="hidden min-w-0 flex-1 items-stretch justify-center overflow-x-auto lg:flex">
          {PREMIERE_WORKSPACES.map((item) => (
            <button
              key={item.id}
              className={clsx(
                'relative h-12 shrink-0 px-3 text-[10px] font-semibold transition',
                workspace === item.id ? 'bg-white/[0.035] text-white' : 'text-slate-500 hover:bg-white/[0.025] hover:text-slate-300',
              )}
              onClick={() => activateWorkspace(item.id)}
            >
              {item.label}
              {workspace === item.id && <span className="absolute inset-x-2 bottom-0 h-0.5 bg-[#58a6ff]" />}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1 px-2">
          <span className={clsx(
            'hidden px-2 text-[8px] font-semibold uppercase tracking-[0.15em] sm:block',
            saveMutation.isError ? 'text-red-300' : saveMutation.isPending ? 'text-amber-300' : editRevision > 0 && savedRevision >= editRevision ? 'text-emerald-400' : 'text-slate-600',
          )}>
            {saveMutation.isError ? 'Autosave failed' : saveMutation.isPending ? 'Saving' : editRevision > 0 && savedRevision >= editRevision ? 'Saved' : 'Original'}
          </span>
          <button className="nle-icon-button" disabled={!cutHistory.past.length} onClick={undoCuts} title="Undo (Ctrl+Z)"><Undo2 className="h-3.5 w-3.5" /></button>
          <button className="nle-icon-button" disabled={!cutHistory.future.length} onClick={redoCuts} title="Redo (Ctrl+Shift+Z)"><Redo2 className="h-3.5 w-3.5" /></button>
          <button
            className="ml-1 inline-flex h-8 items-center gap-1.5 rounded bg-[#2678c9] px-3 text-[10px] font-semibold text-white hover:bg-[#3189df] disabled:opacity-50"
            disabled={renderMutation.isPending || analyzeMutation.isPending || (options.enabled && !analysis)}
            onClick={() => renderMutation.mutate()}
          >
            {renderMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}
            Export
          </button>
        </div>
      </header>

      {(analyzeMutation.isError || renderMutation.isError || saveMutation.isError || queuedOutput || analysisNotice || editError) && (
        <div className={clsx(
          'flex min-h-8 shrink-0 items-center gap-2 border-b px-3 text-[10px]',
          (analyzeMutation.isError || renderMutation.isError || saveMutation.isError || editError)
            ? 'border-red-500/20 bg-red-500/10 text-red-200'
            : queuedOutput
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
              : 'border-amber-500/20 bg-amber-500/10 text-amber-100',
        )}>
          {(analyzeMutation.isError || renderMutation.isError || saveMutation.isError || editError) ? <CircleAlert className="h-3.5 w-3.5 shrink-0" /> : queuedOutput ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <CircleAlert className="h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0 flex-1 truncate">
            {(analyzeMutation.error || renderMutation.error || saveMutation.error) instanceof Error
              ? (analyzeMutation.error || renderMutation.error || saveMutation.error)?.message
              : editError || (queuedOutput ? `Render queued as ${queuedOutput}` : analysisNotice)}
          </span>
          {queuedOutput && (
            <button
              className="text-emerald-100 underline"
              onClick={() => {
                setWorkspace('export');
                setRightDockTab('export');
                setRightDockCollapsed(false);
              }}
            >
              Export panel
            </button>
          )}
        </div>
      )}

      <main className="grid min-h-0 flex-1 grid-rows-[minmax(300px,58fr)_minmax(280px,42fr)] overflow-hidden">
        <section className={clsx(
          'relative grid min-h-0 grid-cols-[minmax(0,1fr)] border-b border-black',
          leftDockCollapsed && rightDockCollapsed
            ? 'lg:grid-cols-[36px_minmax(0,1fr)_36px]'
            : leftDockCollapsed
              ? 'lg:grid-cols-[36px_minmax(0,1fr)_300px]'
              : rightDockCollapsed
                ? 'lg:grid-cols-[250px_minmax(380px,1fr)_36px] xl:grid-cols-[270px_minmax(420px,1fr)_36px]'
                : 'lg:grid-cols-[250px_minmax(380px,1fr)_280px] xl:grid-cols-[270px_minmax(420px,1fr)_300px]',
        )}>
          {mobileDock && <button className="absolute inset-0 z-30 bg-black/55 lg:hidden" onClick={() => setMobileDock(null)} aria-label="Close dock" />}
          <aside className={clsx(
            'hidden min-h-0 border-r border-black bg-[#151515] lg:block',
            mobileDock === 'left' && 'absolute inset-y-0 left-0 z-40 !block w-[min(86vw,320px)] shadow-2xl lg:static lg:w-auto',
          )}>
            {leftDockCollapsed ? (
              <button className="grid h-full w-9 place-items-center text-slate-600 hover:bg-white/5 hover:text-white" onClick={() => { setLeftDockCollapsed(false); setMobileDock('left'); }} title="Open left panels">
                <FolderOpen className="h-4 w-4" />
              </button>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex h-9 shrink-0 items-stretch border-b border-black bg-[#1d1d1d]">
                  {([
                    ['project', 'Project'],
                    ['effects', 'Effects'],
                    ['graphics', 'Graphics'],
                    ['text', 'Text'],
                  ] as Array<[LeftDockTab, string]>).map(([id, label]) => (
                    <button key={id} className={clsx('nle-panel-tab', leftDockTab === id && 'active')} onClick={() => setLeftDockTab(id)}>{label}</button>
                  ))}
                  <button className="ml-auto grid w-8 place-items-center text-slate-600 hover:text-white" onClick={() => { setLeftDockCollapsed(true); setMobileDock(null); }} title="Collapse panel"><PanelLeftClose className="h-3.5 w-3.5" /></button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                  {leftDockTab === 'project' && (
                    <ProjectDockPanel
                      assets={project.assets || []}
                      activeSequence={activeSequence}
                      creative={creative}
                      uploading={assetMutation.isPending}
                      onUpload={(kind, file) => assetMutation.mutate({ kind, file })}
                      onOpenSequence={() => openWindowPanel({ suite: 'v3', tab: 'timeline' })}
                      onOpenStorage={() => openWindowPanel({ suite: 'storage', tab: 'storage' })}
                    />
                  )}
                  {leftDockTab === 'effects' && (
                    <EffectsDockPanel
                      creative={creative}
                      transitionJoins={transitionJoins}
                      onApplyTransitionToAll={applyTransitionToAll}
                      onSetTransition={setJoinTransition}
                      onOpenEffects={() => openWindowPanel({ suite: 'v3', tab: 'effects' })}
                      onOpenTemplates={() => openWindowPanel({ suite: 'v3', tab: 'templates' })}
                    />
                  )}
                  {leftDockTab === 'graphics' && (
                    <GraphicsDockPanel
                      creative={creative}
                      selectedTitleId={selectedTitle?.id || null}
                      onAddTitle={addTitleCard}
                      onSelectTitle={(id) => {
                        setSelectedTitleId(id);
                        const title = creative.titles.find((item) => item.id === id);
                        if (title) seekTo(title.start);
                      }}
                      onDeleteTitle={(id) => patchCreative({ titles: creative.titles.filter((title) => title.id !== id) })}
                    />
                  )}
                  {leftDockTab === 'text' && (
                    <TextDockPanel
                      chunks={visibleTranscriptChunks}
                      captions={creative.captions.cues}
                      chapters={chapters}
                      search={transcriptSearch}
                      onSearch={setTranscriptSearch}
                      onSeek={(seconds) => seekTo(seconds)}
                      onOpenTranscript={() => openWindowPanel({ suite: 'transcript', tab: 'transcript' })}
                      onOpenCaptions={() => openWindowPanel({ suite: 'professional', tab: 'captions' })}
                    />
                  )}
                </div>
              </div>
            )}
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col bg-[#101010]">
            <div className="flex h-9 shrink-0 items-center border-b border-black bg-[#1b1b1b]">
              <button className="nle-icon-button ml-1 lg:hidden" onClick={() => { setLeftDockCollapsed(false); setMobileDock('left'); }} title="Open Project panels"><FolderOpen className="h-3.5 w-3.5" /></button>
              <button className={clsx('nle-panel-tab px-4', !editedPreview && 'active')} onClick={() => setEditedPreview(false)}>Source</button>
              <button className={clsx('nle-panel-tab px-4', editedPreview && 'active')} onClick={() => setEditedPreview(true)}>Program</button>
              <span className="ml-2 min-w-0 truncate text-[9px] text-slate-600">{activeSequence?.name || 'Main sequence'}</span>
              <div className="ml-auto flex items-center gap-1 pr-2">
                <button className="nle-icon-button lg:hidden" onClick={() => { setRightDockCollapsed(false); setMobileDock('right'); }} title="Open Properties"><SlidersHorizontal className="h-3.5 w-3.5" /></button>
                <button
                  className={clsx('nle-icon-button', useProxy && 'text-sky-300')}
                  disabled={proxyMutation.isPending || project.proxy?.status === 'building'}
                  onClick={() => project.proxy?.status === 'ready' ? setUseProxy((current) => !current) : proxyMutation.mutate('build')}
                  title={project.proxy?.status === 'ready' ? 'Toggle proxies' : 'Create proxies'}
                >
                  {project.proxy?.status === 'building' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Film className="h-3.5 w-3.5" />}
                </button>
                <button className={clsx('nle-icon-button', showSafeAreas && 'text-amber-200')} onClick={() => setShowSafeAreas((current) => !current)} title="Safe margins"><Eye className="h-3.5 w-3.5" /></button>
                <button className="nle-icon-button" onClick={() => openWindowPanel({ suite: 'v3', tab: 'qc' })} title="Maximize panel"><Maximize2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            <div ref={monitorSurfaceRef} className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-black">
              <video
                ref={videoRef}
                src={useProxy && project.proxy?.status === 'ready' && project.proxy.url ? project.proxy.url : project.sourceUrl}
                className="h-full w-full object-contain transition-[filter] duration-200"
                style={{ filter: editedPreview ? previewColorFilter(creative.color, activeAdjustment) : undefined }}
                preload="metadata"
                playsInline
                onClick={(event) => event.currentTarget.paused ? event.currentTarget.play().catch(() => undefined) : event.currentTarget.pause()}
                onPlay={() => setMonitorPlaying(true)}
                onPause={() => setMonitorPlaying(false)}
                onTimeUpdate={(event) => handleVideoProgress(event.currentTarget)}
                onSeeked={(event) => setPlayhead(event.currentTarget.currentTime)}
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  if (video.videoWidth > 0 && video.videoHeight > 0) setVideoAspect(video.videoWidth / video.videoHeight);
                  setPlayhead(Math.min(effectiveOptions.startSec, video.duration || effectiveOptions.startSec));
                }}
              />
              {programFrame.width > 0 && (
                <div
                  className="pointer-events-none absolute overflow-hidden"
                  data-program-frame
                  style={{
                    left: programFrame.left,
                    top: programFrame.top,
                    width: programFrame.width,
                    height: programFrame.height,
                  }}
                >
                  {editedPreview && activeMulticamCut && activeMulticamAngle && activeMulticamAsset && (
                    <MediaPreviewOverlay asset={activeMulticamAsset} start={activeMulticamCut.start} sourceOffset={activeMulticamCut.start + activeMulticamAngle.offsetSec} playhead={playhead} className="absolute inset-0 h-full w-full object-cover" />
                  )}
                  {editedPreview && activeBroll && activeBrollAsset && (
                    <MediaPreviewOverlay asset={activeBrollAsset} start={activeBroll.start} sourceOffset={activeBroll.sourceOffset} playhead={playhead} overlay={activeBroll} className="absolute inset-0" />
                  )}
                  {editedPreview && activeTitle && (
                    <TitlePreviewOverlay
                      title={activeTitle}
                      selected={selectedTitle?.id === activeTitle.id}
                      frameWidth={programFrame.width}
                      frameHeight={programFrame.height}
                      onSelect={() => {
                        setSelectedTitleId(activeTitle.id);
                        setWorkspace('graphics');
                        setLeftDockTab('graphics');
                        setRightDockTab('properties');
                        setRightDockCollapsed(false);
                      }}
                      onChange={(patch) => updateTitle(activeTitle.id, patch)}
                    />
                  )}
                  {editedPreview && activeCaption && <CaptionPreviewOverlay cue={activeCaption} options={creative.captions} />}
                  {editedPreview && showSafeAreas && (
                    <div className="pointer-events-none absolute inset-0">
                      <div className="absolute inset-[5%] border border-white/20" />
                      <div className="absolute inset-[10%] border border-dashed border-amber-300/35" />
                      <span className="absolute right-[10%] top-[10%] bg-black/60 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-amber-100/70">Title safe</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex h-11 shrink-0 items-center justify-center gap-1 border-t border-black bg-[#181818]">
              <button className="nle-icon-button" onClick={() => seekTo(playhead - 1 / 30)} title="Step back one frame"><SkipBack className="h-3.5 w-3.5" /></button>
              <button className="nle-icon-button" onClick={() => videoRef.current?.paused ? videoRef.current.play().catch(() => undefined) : videoRef.current?.pause()} title="Play / pause (Space)">
                {monitorPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
              </button>
              <button className="nle-icon-button" onClick={() => seekTo(playhead + 1 / 30)} title="Step forward one frame"><SkipForward className="h-3.5 w-3.5" /></button>
              <span className="mx-3 min-w-[92px] text-center font-mono text-[12px] font-semibold text-sky-100">{formatTimecode(playhead)}</span>
              <button className="nle-text-button" onClick={() => setManualStart(playhead)} title="Mark In (I)">I</button>
              <button className="nle-text-button" onClick={() => setManualEnd(playhead)} title="Mark Out (O)">O</button>
              <button className="nle-icon-button" onClick={addChapter} title="Add marker (M)"><Plus className="h-3.5 w-3.5" /></button>
            </div>
          </section>

          <aside className={clsx(
            'hidden min-h-0 border-l border-black bg-[#151515] lg:block',
            mobileDock === 'right' && 'absolute inset-y-0 right-0 z-40 !block w-[min(86vw,340px)] shadow-2xl lg:static lg:w-auto',
          )}>
            {rightDockCollapsed ? (
              <button className="grid h-full w-9 place-items-center text-slate-600 hover:bg-white/5 hover:text-white" onClick={() => { setRightDockCollapsed(false); setMobileDock('right'); }} title="Open Properties">
                <SlidersHorizontal className="h-4 w-4" />
              </button>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex h-9 shrink-0 items-stretch border-b border-black bg-[#1d1d1d]">
                  {([
                    ['properties', 'Properties'],
                    ['color', 'Color'],
                    ['audio', 'Audio'],
                    ['export', 'Export'],
                  ] as Array<[RightDockTab, string]>).map(([id, label]) => (
                    <button key={id} className={clsx('nle-panel-tab', rightDockTab === id && 'active')} onClick={() => setRightDockTab(id)}>{label}</button>
                  ))}
                  <button className="ml-auto grid w-8 place-items-center text-slate-600 hover:text-white" onClick={() => { setRightDockCollapsed(true); setMobileDock(null); }} title="Collapse panel"><PanelRightClose className="h-3.5 w-3.5" /></button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                  {rightDockTab === 'properties' && (
                    <PropertiesDockPanel
                      creative={creative}
                      title={selectedTitle}
                      options={effectiveOptions}
                      wholeVideo={wholeVideo}
                      sourceDuration={project.sourceDurationSec}
                      showSafeAreas={showSafeAreas}
                      onTitleChange={updateTitle}
                      onDeleteTitle={(id) => patchCreative({ titles: creative.titles.filter((title) => title.id !== id) })}
                      onCreativeChange={patchCreative}
                      onOptionChange={patchOption}
                      onScopeChange={changeScope}
                      onSafeAreasChange={setShowSafeAreas}
                      onOpenEditControls={() => openWindowPanel({ suite: 'professional', tab: 'edit' })}
                    />
                  )}
                  {rightDockTab === 'color' && (
                    <QuickColorDockPanel
                      creative={creative}
                      assets={project.assets || []}
                      uploading={assetMutation.isPending}
                      onCreativeChange={patchCreative}
                      onUpload={(file) => assetMutation.mutate({ kind: 'lut', file })}
                      onOpenColor={() => openWindowPanel({ suite: 'v3', tab: 'color' })}
                    />
                  )}
                  {rightDockTab === 'audio' && (
                    <QuickAudioDockPanel
                      creative={creative}
                      options={effectiveOptions}
                      onCreativeChange={patchCreative}
                      onOptionsChange={patchOptions}
                      onOpenMixer={() => openWindowPanel({ suite: 'professional', tab: 'audio' })}
                    />
                  )}
                  {rightDockTab === 'export' && (
                    <ExportDockPanel
                      creative={creative}
                      finishedDuration={finishedDuration}
                      renderBusy={renderMutation.isPending}
                      onCreativeChange={patchCreative}
                      onRender={() => renderMutation.mutate()}
                      onOpenPublish={() => openWindowPanel({ suite: 'v3', tab: 'publish' })}
                      onOpenInterchange={() => openWindowPanel({ suite: 'v3', tab: 'interchange' })}
                    />
                  )}
                </div>
              </div>
            )}
          </aside>
        </section>

        <Timeline
          duration={project.sourceDurationSec}
          start={effectiveOptions.startSec}
          end={effectiveOptions.endSec || project.sourceDurationSec}
          cuts={analysis?.cuts || []}
          playhead={playhead}
          waveformUrl={project.waveformUrl}
          chapters={chapters}
          creative={creative}
          assets={project.assets || []}
          transitionJoins={transitionJoins}
          activeTool={timelineTool}
          snapEnabled={timelineSnap}
          manualStart={manualStart}
          manualEnd={manualEnd}
          selectedTitleId={selectedTitle?.id || null}
          onToolChange={setTimelineTool}
          onSnapChange={setTimelineSnap}
          onSeek={(seconds) => seekTo(seconds)}
          onBlade={(seconds) => addEditPoint(seconds)}
          onMarkIn={() => setManualStart(playhead)}
          onMarkOut={() => setManualEnd(playhead)}
          onAddCut={addManualCut}
          onCutBoundsChange={(id, startValue, endValue) => updateCutBounds(id, startValue, endValue)}
          onTitleSelect={(id) => {
            setSelectedTitleId(id);
            setWorkspace('graphics');
            setLeftDockTab('graphics');
            setRightDockTab('properties');
          }}
          onCreativeChange={patchCreative}
          onOpenPanel={openWindowPanel}
        />
      </main>

      <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-black bg-[#181818] px-3 font-mono text-[8px] text-slate-600">
        <span className="text-sky-300">{TIMELINE_TOOLS.find((tool) => tool.id === timelineTool)?.label || 'Selection'} [{TIMELINE_TOOLS.find((tool) => tool.id === timelineTool)?.shortcut}]</span>
        <span>Source {formatTime(stats.originalDurationSec)}</span>
        <span className="text-red-300/70">Removed {formatTime(stats.removedDurationSec)}</span>
        <span className="text-emerald-300/70">Sequence {formatTime(finishedDuration)}</span>
        <span>{transitionJoins.length} edit joins</span>
        <span className="ml-auto hidden sm:inline">Space Play · J/K/L Shuttle · I/O Marks · M Marker</span>
      </footer>

      {windowPanel && (
        <div className="absolute inset-y-12 right-0 z-50 flex w-full min-h-0 flex-col border-l border-black bg-[#101010]/98 shadow-[-24px_0_45px_rgba(0,0,0,0.6)] sm:w-[min(88vw,980px)] xl:w-[min(60vw,960px)]">
          <div className="flex h-12 shrink-0 items-center border-b border-black bg-[#1b1b1b]">
            <div className="flex h-12 items-center gap-2 border-r border-white/5 px-4 text-[11px] font-semibold text-white">
              <PanelRightClose className="h-3.5 w-3.5 text-sky-300" /> Docked tools
            </div>
            <div className="flex min-w-0 flex-1 overflow-x-auto scrollbar-thin">
              {WINDOW_PANELS.map((item) => {
                const active = windowPanel.suite === item.panel.suite && windowPanel.tab === item.panel.tab;
                return (
                  <button key={`${item.panel.suite}-${item.panel.tab}`} className={clsx('nle-panel-tab h-12 shrink-0 px-3', active && 'active')} onClick={() => setWindowPanel(item.panel)}>
                    {item.label}
                  </button>
                );
              })}
            </div>
            <button className="grid h-12 w-12 shrink-0 place-items-center border-l border-white/5 text-slate-500 hover:bg-white/5 hover:text-white" onClick={() => setWindowPanel(null)} title="Close docked tools"><X className="h-4 w-4" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-[#151515] scrollbar-thin">
            {windowPanel.suite === 'cuts' && (
              <div className="grid gap-3 p-4 xl:grid-cols-[minmax(300px,0.7fr)_minmax(500px,1.3fr)]">
                <ManualCutPanel
                  playhead={playhead}
                  start={manualStart}
                  end={manualEnd}
                  min={effectiveOptions.startSec}
                  max={effectiveOptions.endSec}
                  onStartChange={setManualStart}
                  onEndChange={setManualEnd}
                  onMarkStart={() => setManualStart(playhead)}
                  onMarkEnd={() => setManualEnd(playhead)}
                  onAdd={addManualCut}
                />
                <div className="panel-elev overflow-hidden">
                  <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
                    <div><div className="text-sm font-semibold text-white">Cut list</div><div className="text-xs text-slate-500">Automatic, manual, and transcript removals</div></div>
                    <span className="chip">{analysis?.cuts.length || 0} regions</span>
                  </div>
                  <div className="max-h-[70vh] divide-y divide-white/5 overflow-y-auto scrollbar-thin">
                    {(analysis?.cuts || []).map((cut, index) => <CutRow key={cut.id} cut={cut} index={index} onToggle={() => toggleCut(cut.id)} onPlay={() => auditionCut(cut)} onDelete={() => deleteCut(cut.id)} onBoundsChange={(startValue, endValue) => updateCutBounds(cut.id, startValue, endValue)} />)}
                    {!analysis?.cuts.length && <div className="p-10 text-center text-xs text-slate-600">No cut regions yet.</div>}
                  </div>
                </div>
              </div>
            )}
            {windowPanel.suite === 'transcript' && (
              <div className="p-4">
                <TranscriptPanel
                  wordsAvailable={transcriptWords.length > 0}
                  words={transcriptWords}
                  chunks={visibleTranscriptChunks}
                  suggestions={fillerSuggestions}
                  cuts={analysis?.cuts || []}
                  dismissed={dismissedFillers}
                  playhead={playhead}
                  search={transcriptSearch}
                  selectedWordRange={selectedWordRange}
                  onSearch={setTranscriptSearch}
                  onSeek={(seconds, autoplay = false) => seekTo(seconds, autoplay)}
                  onWordSelect={selectTranscriptWord}
                  onCutSelection={cutTranscriptSelection}
                  onAccept={(suggestion) => addCutRange(suggestion.start, suggestion.end, 'filler')}
                  onDismiss={(id) => setDismissedFillers((current) => new Set(current).add(id))}
                />
              </div>
            )}
            {windowPanel.suite === 'chapters' && (
              <div className="p-4">
                <ChapterPanel chapters={chapters} playhead={playhead} min={effectiveOptions.startSec} max={effectiveOptions.endSec} onAdd={addChapter} onSeek={(seconds) => seekTo(seconds)} onUpdate={updateChapter} onDelete={deleteChapter} />
              </div>
            )}
            {windowPanel.suite === 'storage' && <StorageManagerPanel embedded />}
            {windowPanel.suite === 'professional' && (
              <ProfessionalEditorTools
                projectName={clipName}
                creative={creative}
                assets={project.assets || []}
                words={transcriptWords}
                options={effectiveOptions}
                cuts={analysis?.cuts || []}
                chapters={chapters}
                playhead={playhead}
                min={effectiveOptions.startSec}
                max={effectiveOptions.endSec}
                videoRef={videoRef}
                proxy={project.proxy}
                uploading={assetMutation.isPending}
                proxyBusy={proxyMutation.isPending}
                onCreativeChange={patchCreative}
                onOptionsChange={patchOptions}
                onUpload={(kind, file) => assetMutation.mutate({ kind, file })}
                onSeek={(seconds) => seekTo(seconds)}
                onAddCut={(startValue, endValue) => addCutRange(startValue, endValue, 'assistant')}
                onUpdateCut={updateCutBounds}
                onAddChapter={addChapterAt}
                onAddEditPoint={addEditPoint}
                onUpdateEditPoint={updateEditPoint}
                onDeleteEditPoint={deleteEditPoint}
                onProxyAction={(action) => proxyMutation.mutate(action)}
                onReload={() => projectQuery.refetch().then(() => undefined)}
                activeTab={windowPanel.tab}
                onTabChange={(tab) => setWindowPanel({ suite: 'professional', tab })}
                embedded
                showTabs={false}
              />
            )}
            {windowPanel.suite === 'v3' && (
              <EditorV3Workspace
                projectName={clipName}
                creative={creative}
                assets={project.assets || []}
                options={effectiveOptions}
                cuts={analysis?.cuts || []}
                chapters={chapters}
                playhead={playhead}
                min={effectiveOptions.startSec}
                max={effectiveOptions.endSec}
                videoRef={videoRef}
                uploading={assetMutation.isPending}
                onUpload={(kind, file) => assetMutation.mutate({ kind, file })}
                onCreativeChange={patchCreative}
                onSeek={(seconds) => seekTo(seconds)}
                activeTab={windowPanel.tab}
                onTabChange={(tab) => setWindowPanel({ suite: 'v3', tab })}
                embedded
                showTabs={false}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DockSection({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-black/70 p-3">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="nle-section-label">{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function DockRange({ label, value, min, max, step, suffix = '', onChange }: {
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
      <span className="mb-1 flex items-center justify-between gap-2 text-[9px] text-slate-500">
        <span>{label}</span>
        <span className="font-mono text-slate-400">{Number(value.toFixed(2))}{suffix}</span>
      </span>
      <input
        className="h-1.5 w-full cursor-pointer accent-sky-500"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(numberValue(event.target.value, value))}
      />
    </label>
  );
}

function DockSwitch({ label, detail, checked, onChange }: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5">
      <span className="min-w-0">
        <span className="block text-[10px] font-medium text-slate-300">{label}</span>
        {detail && <span className="block truncate text-[8px] text-slate-600">{detail}</span>}
      </span>
      <span className={clsx('relative h-4 w-7 shrink-0 rounded-full transition', checked ? 'bg-sky-500' : 'bg-slate-700')}>
        <input className="sr-only" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className={clsx('absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition', checked ? 'left-3.5' : 'left-0.5')} />
      </span>
    </label>
  );
}

function DockColor({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[8px] font-semibold uppercase tracking-wider text-slate-600">{label}</span>
      <span className="flex h-7 items-center gap-2 rounded-sm border border-white/[0.08] bg-black/30 px-1.5">
        <input className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0" type="color" value={value} onChange={(event) => onChange(event.target.value.toUpperCase())} />
        <span className="truncate font-mono text-[8px] text-slate-500">{value}</span>
      </span>
    </label>
  );
}

function ProjectDockPanel({
  assets,
  activeSequence,
  creative,
  uploading,
  onUpload,
  onOpenSequence,
  onOpenStorage,
}: {
  assets: LongformMediaAsset[];
  activeSequence: LongformCreativeOptions['sequence']['sequences'][number] | undefined;
  creative: LongformCreativeOptions;
  uploading: boolean;
  onUpload: (kind: LongformMediaAsset['kind'], file: File) => void;
  onOpenSequence: () => void;
  onOpenStorage: () => void;
}) {
  const [search, setSearch] = useState('');
  const visibleAssets = assets.filter((asset) => asset.name.toLowerCase().includes(search.trim().toLowerCase()));
  const uploadButton = (kind: 'media' | 'broll' | 'music', label: string, accept: string) => (
    <label className="flex h-7 cursor-pointer items-center justify-center gap-1 rounded-sm bg-white/[0.045] px-2 text-[9px] font-semibold text-slate-400 hover:bg-white/[0.08] hover:text-white">
      {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
      {label}
      <input
        className="hidden"
        type="file"
        accept={accept}
        disabled={uploading}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUpload(kind, file);
          event.currentTarget.value = '';
        }}
      />
    </label>
  );
  return (
    <div>
      <DockSection title="Project">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-slate-700" />
          <input className="nle-field pl-7" placeholder="Search project" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1">
          {uploadButton('media', 'Media', 'video/*,audio/*,image/*')}
          {uploadButton('broll', 'B-roll', 'video/*,image/*')}
          {uploadButton('music', 'Audio', 'audio/*')}
        </div>
      </DockSection>
      <DockSection
        title="Sequences"
        action={<button className="text-[8px] font-semibold text-sky-400 hover:text-sky-200" onClick={onOpenSequence}>Open</button>}
      >
        <button className="w-full rounded-sm border border-sky-400/15 bg-sky-500/[0.07] p-2 text-left hover:bg-sky-500/10" onDoubleClick={onOpenSequence}>
          <div className="flex items-center gap-2">
            <Layers3 className="h-3.5 w-3.5 text-sky-300" />
            <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-slate-200">{activeSequence?.name || 'Main sequence'}</span>
          </div>
          <div className="mt-1.5 flex gap-3 font-mono text-[8px] text-slate-600">
            <span>{activeSequence?.frameRate || 30} fps</span>
            <span>{activeSequence?.tracks.length || 0} tracks</span>
            <span>{activeSequence?.tracks.reduce((count, track) => count + track.clips.length, 0) || 0} clips</span>
          </div>
        </button>
      </DockSection>
      <DockSection title={`Media · ${visibleAssets.length}`}>
        <div className="space-y-px">
          {visibleAssets.map((asset) => (
            <button
              key={asset.id}
              draggable
              className="group flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-white/[0.055]"
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-longform-asset', asset.id);
                event.dataTransfer.setData('application/x-vcf-asset', asset.id);
                event.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <span className={clsx(
                'grid h-7 w-9 shrink-0 place-items-center rounded-sm',
                asset.kind === 'music' || asset.kind === 'voiceover'
                  ? 'bg-emerald-500/10 text-emerald-300'
                  : asset.kind === 'lut'
                    ? 'bg-amber-500/10 text-amber-300'
                    : 'bg-sky-500/10 text-sky-300',
              )}>
                {asset.kind === 'music' || asset.kind === 'voiceover' ? <AudioLines className="h-3.5 w-3.5" /> : asset.kind === 'lut' ? <Palette className="h-3.5 w-3.5" /> : <Film className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[9px] font-medium text-slate-300">{asset.name}</span>
                <span className="block text-[7px] uppercase tracking-wider text-slate-700">
                  {asset.library ? 'Library · ' : ''}{asset.mediaType || asset.kind}{asset.durationSec ? ` · ${formatTime(asset.durationSec)}` : ''}
                </span>
              </span>
            </button>
          ))}
          {!visibleAssets.length && (
            <div className="border border-dashed border-white/5 px-3 py-6 text-center text-[9px] leading-relaxed text-slate-650">
              {assets.length ? 'No project items match this search.' : 'Import media to build B-roll, music, multicam, LUT, and sequence tracks.'}
            </div>
          )}
        </div>
      </DockSection>
      <DockSection title="Project summary">
        <div className="grid grid-cols-2 gap-1 text-[8px]">
          <div className="bg-black/20 p-2 text-slate-600"><span className="block text-sm font-semibold text-white">{creative.titles.length}</span>Graphics</div>
          <div className="bg-black/20 p-2 text-slate-600"><span className="block text-sm font-semibold text-white">{creative.broll.length}</span>B-roll clips</div>
          <div className="bg-black/20 p-2 text-slate-600"><span className="block text-sm font-semibold text-white">{creative.captions.cues.length}</span>Captions</div>
          <div className="bg-black/20 p-2 text-slate-600"><span className="block text-sm font-semibold text-white">{creative.colorWorkflow.versions.length}</span>Grade versions</div>
        </div>
        <button className="mt-2 flex h-8 w-full items-center justify-center gap-2 rounded-sm bg-white/[0.045] text-[8px] font-semibold text-slate-500 hover:bg-white/[0.08] hover:text-white" onClick={onOpenStorage}>
          <HardDrive className="h-3.5 w-3.5" /> Admin cache & work files
        </button>
      </DockSection>
    </div>
  );
}

function EffectsDockPanel({
  creative,
  transitionJoins,
  onApplyTransitionToAll,
  onSetTransition,
  onOpenEffects,
  onOpenTemplates,
}: {
  creative: LongformCreativeOptions;
  transitionJoins: TransitionJoin[];
  onApplyTransitionToAll: (type: LongformTransitionType) => void;
  onSetTransition: (cutId: string, type: LongformTransitionType, duration?: number) => void;
  onOpenEffects: () => void;
  onOpenTemplates: () => void;
}) {
  const [search, setSearch] = useState('');
  const filtered = TRANSITION_OPTIONS.filter((option) => option.label.toLowerCase().includes(search.trim().toLowerCase()));
  const transitionByCut = new Map(creative.transitions.map((transition) => [transition.cutId, transition]));
  return (
    <div>
      <DockSection title="Effects">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-slate-700" />
          <input className="nle-field pl-7" placeholder="Search effects" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
      </DockSection>
      <DockSection title="Video transitions">
        <div className="grid grid-cols-2 gap-1.5">
          {filtered.map((option) => (
            <button
              key={option.value}
              className="group h-14 overflow-hidden rounded-sm border border-white/[0.06] bg-black/20 text-left hover:border-sky-400/30 hover:bg-sky-500/[0.06]"
              onClick={() => onApplyTransitionToAll(option.value)}
              title={`Apply ${option.label} to all eligible edit points`}
            >
              <span className="relative block h-7 border-b border-white/5 bg-gradient-to-r from-slate-800 via-slate-600 to-slate-900">
                {option.value !== 'cut' && <span className="absolute inset-y-0 left-1/2 w-4 -translate-x-1/2 skew-x-[-18deg] bg-sky-300/25" />}
              </span>
              <span className="block truncate px-2 py-1 text-[8px] font-semibold text-slate-400 group-hover:text-slate-200">{option.label}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[8px] leading-relaxed text-slate-650">Click a preset to apply it across eligible cuts. Fine-tune individual joins below.</p>
      </DockSection>
      <DockSection title={`Sequence joins · ${transitionJoins.length}`}>
        <div className="max-h-52 space-y-1 overflow-y-auto pr-0.5 scrollbar-thin">
          {transitionJoins.slice(0, 30).map((join) => (
            <div key={join.cutId} className="grid grid-cols-[minmax(0,1fr)_116px] items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-white/[0.035]">
              <span className="min-w-0">
                <span className="block truncate text-[9px] font-medium text-slate-400">Edit {join.joinIndex + 1}</span>
                <span className="block font-mono text-[7px] text-slate-700">{formatTimecode(join.sourceTime)}</span>
              </span>
              <select
                className="nle-field"
                value={transitionByCut.get(join.cutId)?.type || 'cut'}
                onChange={(event) => onSetTransition(join.cutId, event.target.value as LongformTransitionType)}
              >
                {TRANSITION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
          ))}
          {!transitionJoins.length && <div className="border border-dashed border-white/5 p-4 text-center text-[8px] text-slate-650">Create cuts or blade edit points to add transitions.</div>}
        </div>
      </DockSection>
      <DockSection title="Advanced">
        <div className="grid gap-1.5">
          <button className="flex h-8 items-center gap-2 rounded-sm bg-white/[0.04] px-2 text-[9px] text-slate-400 hover:bg-white/[0.08] hover:text-white" onClick={onOpenEffects}><Sparkles className="h-3.5 w-3.5 text-violet-300" /> Time remap, masks, keying & stabilization</button>
          <button className="flex h-8 items-center gap-2 rounded-sm bg-white/[0.04] px-2 text-[9px] text-slate-400 hover:bg-white/[0.08] hover:text-white" onClick={onOpenTemplates}><Layers3 className="h-3.5 w-3.5 text-cyan-300" /> Reusable effect templates</button>
        </div>
      </DockSection>
    </div>
  );
}

function GraphicsDockPanel({
  creative,
  selectedTitleId,
  onAddTitle,
  onSelectTitle,
  onDeleteTitle,
}: {
  creative: LongformCreativeOptions;
  selectedTitleId: string | null;
  onAddTitle: (position?: 'playhead' | 'intro' | 'outro', preset?: Partial<LongformCreativeOptions['titles'][number]>) => void;
  onSelectTitle: (id: string) => void;
  onDeleteTitle: (id: string) => void;
}) {
  const templates: Array<{
    id: LongformCreativeOptions['titles'][number]['template'];
    label: string;
    detail: string;
    preset: Partial<LongformCreativeOptions['titles'][number]>;
  }> = [
    { id: 'minimal', label: 'Minimal', detail: 'Clean underline', preset: { template: 'minimal', accentColor: '#38BDF8', backgroundColor: '#09090B', animation: 'fade' } },
    { id: 'broadcast', label: 'Broadcast', detail: 'Bold newsroom', preset: { template: 'broadcast', accentColor: '#8B5CF6', backgroundColor: '#09090B', animation: 'slide' } },
    { id: 'glass', label: 'Glass', detail: 'Full-width glass', preset: { template: 'glass', accentColor: '#22D3EE', backgroundColor: '#0F172A', animation: 'slide' } },
  ];
  return (
    <div>
      <DockSection title="Graphics templates">
        <div className="space-y-1.5">
          {templates.map((template) => (
            <button key={template.id} className="group flex w-full items-center gap-2 rounded-sm border border-white/[0.06] bg-black/20 p-2 text-left hover:border-violet-400/30 hover:bg-violet-500/[0.06]" onClick={() => onAddTitle('playhead', template.preset)}>
              <span className="relative h-12 w-20 shrink-0 overflow-hidden rounded-sm bg-gradient-to-br from-slate-800 to-black">
                <span className={clsx(
                  'absolute bottom-2 left-2 right-2 h-4',
                  template.id === 'broadcast' && 'border-l-2 border-violet-400 bg-black/70',
                  template.id === 'glass' && 'border-t border-cyan-300/70 bg-slate-700/70',
                  template.id === 'minimal' && 'border-b border-sky-300',
                )}>
                  <span className="absolute left-1 top-1 h-0.5 w-8 bg-white/80" />
                  <span className="absolute left-1 top-2.5 h-px w-5 bg-white/35" />
                </span>
              </span>
              <span className="min-w-0">
                <span className="block text-[10px] font-semibold text-slate-300 group-hover:text-white">{template.label}</span>
                <span className="block text-[8px] text-slate-650">{template.detail}</span>
                <span className="mt-1 block text-[7px] font-semibold uppercase tracking-wider text-violet-400">Add at playhead</span>
              </span>
            </button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <button className="h-7 rounded-sm bg-white/[0.045] text-[8px] font-semibold text-slate-400 hover:bg-white/[0.08] hover:text-white" onClick={() => onAddTitle('intro')}>Intro title</button>
          <button className="h-7 rounded-sm bg-white/[0.045] text-[8px] font-semibold text-slate-400 hover:bg-white/[0.08] hover:text-white" onClick={() => onAddTitle('outro')}>Outro title</button>
        </div>
      </DockSection>
      <DockSection title={`Sequence graphics · ${creative.titles.length}`}>
        <div className="space-y-px">
          {creative.titles.map((title) => (
            <div key={title.id} className={clsx('group flex items-center gap-2 rounded-sm px-2 py-1.5', selectedTitleId === title.id ? 'bg-violet-500/12 ring-1 ring-inset ring-violet-400/20' : 'hover:bg-white/[0.04]')}>
              <button className="min-w-0 flex-1 text-left" onClick={() => onSelectTitle(title.id)}>
                <span className="block truncate text-[9px] font-medium text-slate-300">{title.text}</span>
                <span className="block font-mono text-[7px] text-slate-700">{formatTimecode(title.start)} — {formatTimecode(title.end)}</span>
              </button>
              <button className="grid h-6 w-6 place-items-center text-slate-700 opacity-0 hover:text-red-300 group-hover:opacity-100" onClick={() => onDeleteTitle(title.id)} title="Delete graphic"><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
          {!creative.titles.length && <div className="border border-dashed border-white/5 p-5 text-center text-[8px] text-slate-650">Choose a template to add a clean lower third.</div>}
        </div>
      </DockSection>
    </div>
  );
}

function TextDockPanel({
  chunks,
  captions,
  chapters,
  search,
  onSearch,
  onSeek,
  onOpenTranscript,
  onOpenCaptions,
}: {
  chunks: TranscriptChunk[];
  captions: LongformCreativeOptions['captions']['cues'];
  chapters: LongformChapter[];
  search: string;
  onSearch: (value: string) => void;
  onSeek: (seconds: number) => void;
  onOpenTranscript: () => void;
  onOpenCaptions: () => void;
}) {
  return (
    <div>
      <DockSection title="Text">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-slate-700" />
          <input className="nle-field pl-7" placeholder="Search transcript" value={search} onChange={(event) => onSearch(event.target.value)} />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <button className="h-7 rounded-sm bg-white/[0.045] text-[8px] font-semibold text-slate-400 hover:bg-white/[0.08] hover:text-white" onClick={onOpenTranscript}>Edit transcript</button>
          <button className="h-7 rounded-sm bg-white/[0.045] text-[8px] font-semibold text-slate-400 hover:bg-white/[0.08] hover:text-white" onClick={onOpenCaptions}>Caption tools</button>
        </div>
      </DockSection>
      <DockSection title={`Transcript · ${chunks.length}`}>
        <div className="max-h-72 space-y-px overflow-y-auto scrollbar-thin">
          {chunks.slice(0, 80).map((chunk) => (
            <button key={chunk.id} className="w-full rounded-sm px-2 py-2 text-left hover:bg-white/[0.04]" onClick={() => onSeek(chunk.start)}>
              <span className="mb-1 block font-mono text-[7px] text-sky-500/70">{formatTimecode(chunk.start)}</span>
              <span className="line-clamp-3 text-[9px] leading-relaxed text-slate-500">{chunk.text}</span>
            </button>
          ))}
          {!chunks.length && <div className="border border-dashed border-white/5 p-5 text-center text-[8px] text-slate-650">No transcript text is available for this project.</div>}
        </div>
      </DockSection>
      <DockSection title="Text summary">
        <div className="grid grid-cols-2 gap-1 text-[8px]">
          <button className="bg-black/20 p-2 text-left text-slate-600 hover:bg-white/[0.04]" onClick={onOpenCaptions}><span className="block text-sm font-semibold text-white">{captions.length}</span>Caption cues</button>
          <div className="bg-black/20 p-2 text-slate-600"><span className="block text-sm font-semibold text-white">{chapters.length}</span>Chapters</div>
        </div>
      </DockSection>
    </div>
  );
}

function PropertiesDockPanel({
  creative,
  title,
  options,
  wholeVideo,
  sourceDuration,
  showSafeAreas,
  onTitleChange,
  onDeleteTitle,
  onCreativeChange,
  onOptionChange,
  onScopeChange,
  onSafeAreasChange,
  onOpenEditControls,
}: {
  creative: LongformCreativeOptions;
  title: LongformCreativeOptions['titles'][number] | null;
  options: LongformOptions;
  wholeVideo: boolean;
  sourceDuration: number;
  showSafeAreas: boolean;
  onTitleChange: (id: string, patch: Partial<LongformCreativeOptions['titles'][number]>) => void;
  onDeleteTitle: (id: string) => void;
  onCreativeChange: (patch: Partial<LongformCreativeOptions>) => void;
  onOptionChange: <K extends keyof LongformOptions>(key: K, value: LongformOptions[K]) => void;
  onScopeChange: (wholeVideo: boolean) => void;
  onSafeAreasChange: (visible: boolean) => void;
  onOpenEditControls: () => void;
}) {
  if (title) {
    return (
      <div>
        <DockSection
          title="Graphic properties"
          action={<button className="text-slate-700 hover:text-red-300" onClick={() => onDeleteTitle(title.id)} title="Delete graphic"><Trash2 className="h-3.5 w-3.5" /></button>}
        >
          <label className="block">
            <span className="mb-1 block text-[8px] font-semibold uppercase tracking-wider text-slate-600">Primary text</span>
            <textarea className="nle-field h-14 resize-none py-1.5" value={title.text} maxLength={160} onChange={(event) => onTitleChange(title.id, { text: event.target.value })} />
          </label>
          <label className="mt-2 block">
            <span className="mb-1 block text-[8px] font-semibold uppercase tracking-wider text-slate-600">Secondary text</span>
            <input className="nle-field" value={title.subtitle} maxLength={160} onChange={(event) => onTitleChange(title.id, { subtitle: event.target.value })} />
          </label>
        </DockSection>
        <DockSection title="Appearance">
          <div className="grid grid-cols-2 gap-2">
            <label><span className="mb-1 block text-[8px] text-slate-600">Type</span><select className="nle-field" value={title.style} onChange={(event) => onTitleChange(title.id, { style: event.target.value as typeof title.style })}><option value="lower_third">Lower third</option><option value="center_card">Center card</option></select></label>
            <label><span className="mb-1 block text-[8px] text-slate-600">Template</span><select className="nle-field" value={title.template} onChange={(event) => onTitleChange(title.id, { template: event.target.value as typeof title.template })}><option value="minimal">Minimal</option><option value="broadcast">Broadcast</option><option value="glass">Glass</option></select></label>
            <label><span className="mb-1 block text-[8px] text-slate-600">Alignment</span><select className="nle-field" value={title.alignment} onChange={(event) => onTitleChange(title.id, { alignment: event.target.value as typeof title.alignment })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
            <label><span className="mb-1 block text-[8px] text-slate-600">Animation</span><select className="nle-field" value={title.animation} onChange={(event) => onTitleChange(title.id, { animation: event.target.value as typeof title.animation })}><option value="none">None</option><option value="fade">Fade</option><option value="slide">Slide</option></select></label>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <DockColor label="Text" value={title.textColor} onChange={(textColor) => onTitleChange(title.id, { textColor })} />
            <DockColor label="Accent" value={title.accentColor} onChange={(accentColor) => onTitleChange(title.id, { accentColor })} />
            <DockColor label="Panel" value={title.backgroundColor} onChange={(backgroundColor) => onTitleChange(title.id, { backgroundColor })} />
          </div>
        </DockSection>
        <DockSection
          title="Motion"
          action={(
            <button
              className="text-[8px] font-semibold text-sky-400 hover:text-sky-200"
              onClick={() => onTitleChange(title.id, titleTransformDefaults(title))}
            >
              Reset
            </button>
          )}
        >
          <p className="mb-3 text-[8px] leading-relaxed text-slate-650">Select the graphic in the Program monitor, then drag it or use its resize handles. These controls provide frame-accurate adjustments.</p>
          <div className="space-y-3">
            <DockRange label="Position X" value={title.x * 100} min={0} max={95} step={0.5} suffix="%" onChange={(x) => onTitleChange(title.id, { x: x / 100 })} />
            <DockRange label="Position Y" value={title.y * 100} min={0} max={95} step={0.5} suffix="%" onChange={(y) => onTitleChange(title.id, { y: y / 100 })} />
            <DockRange label="Width" value={title.width * 100} min={12} max={100} step={0.5} suffix="%" onChange={(width) => onTitleChange(title.id, { width: width / 100 })} />
            <DockRange label="Scale" value={title.scale * 100} min={40} max={250} step={1} suffix="%" onChange={(scale) => onTitleChange(title.id, { scale: scale / 100 })} />
          </div>
        </DockSection>
        <DockSection title="Timing">
          <div className="grid grid-cols-2 gap-2">
            <label><span className="mb-1 block text-[8px] text-slate-600">Start</span><input className="nle-field font-mono" type="number" min={0} max={title.end - 0.02} step={0.1} value={title.start} onChange={(event) => onTitleChange(title.id, { start: numberValue(event.target.value, title.start) })} /></label>
            <label><span className="mb-1 block text-[8px] text-slate-600">End</span><input className="nle-field font-mono" type="number" min={title.start + 0.02} max={sourceDuration} step={0.1} value={title.end} onChange={(event) => onTitleChange(title.id, { end: numberValue(event.target.value, title.end) })} /></label>
          </div>
          <div className="mt-2 font-mono text-[8px] text-slate-600">Duration {formatTimecode(title.end - title.start)}</div>
        </DockSection>
      </div>
    );
  }
  return (
    <div>
      <DockSection title="Sequence properties">
        <div className="grid grid-cols-2 gap-2">
          <label><span className="mb-1 block text-[8px] text-slate-600">Preset</span><select className="nle-field" value={creative.exportPreset} onChange={(event) => onCreativeChange({ exportPreset: event.target.value as LongformCreativeOptions['exportPreset'] })}><option value="source">Match source</option><option value="youtube_1080p">YouTube 1080p</option><option value="youtube_4k">YouTube 4K</option><option value="podcast">Podcast</option></select></label>
          <label><span className="mb-1 block text-[8px] text-slate-600">Edit scope</span><select className="nle-field" value={wholeVideo ? 'whole' : 'range'} onChange={(event) => onScopeChange(event.target.value === 'whole')}><option value="whole">Whole source</option><option value="range">In / Out range</option></select></label>
        </div>
        {!wholeVideo && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label><span className="mb-1 block text-[8px] text-slate-600">Sequence In</span><input className="nle-field font-mono" type="number" min={0} max={options.endSec} step={0.1} value={options.startSec} onChange={(event) => onOptionChange('startSec', numberValue(event.target.value, options.startSec))} /></label>
            <label><span className="mb-1 block text-[8px] text-slate-600">Sequence Out</span><input className="nle-field font-mono" type="number" min={options.startSec} max={sourceDuration} step={0.1} value={options.endSec} onChange={(event) => onOptionChange('endSec', numberValue(event.target.value, options.endSec))} /></label>
          </div>
        )}
      </DockSection>
      <DockSection title="Editing">
        <DockSwitch label="Silence removal" detail="Use analyzed and manual removal ranges" checked={options.enabled} onChange={(enabled) => onOptionChange('enabled', enabled)} />
        <DockSwitch label="Advanced sequence" detail="Enable stacked sequence-track compositing" checked={creative.sequence.enabled} onChange={(enabled) => onCreativeChange({ sequence: { ...creative.sequence, enabled } })} />
        <DockSwitch label="Safe margins" detail="Show action and title safe guides" checked={showSafeAreas} onChange={onSafeAreasChange} />
        <button className="mt-2 flex h-8 w-full items-center justify-center gap-2 rounded-sm bg-white/[0.05] text-[9px] font-semibold text-slate-400 hover:bg-white/[0.09] hover:text-white" onClick={onOpenEditControls}><SlidersHorizontal className="h-3.5 w-3.5" /> Detailed edit controls</button>
      </DockSection>
      <DockSection title="Program">
        <div className="grid grid-cols-2 gap-1 text-[8px]">
          <div className="bg-black/20 p-2 text-slate-600"><span className="block font-mono text-[11px] text-slate-300">{formatTimecode(sourceDuration)}</span>Source duration</div>
          <div className="bg-black/20 p-2 text-slate-600"><span className="block font-mono text-[11px] text-slate-300">{creative.sequence.sequences[0]?.frameRate || 30} fps</span>Timebase</div>
        </div>
      </DockSection>
    </div>
  );
}

function QuickColorDockPanel({
  creative,
  assets,
  uploading,
  onCreativeChange,
  onUpload,
  onOpenColor,
}: {
  creative: LongformCreativeOptions;
  assets: LongformMediaAsset[];
  uploading: boolean;
  onCreativeChange: (patch: Partial<LongformCreativeOptions>) => void;
  onUpload: (file: File) => void;
  onOpenColor: () => void;
}) {
  const color = creative.color;
  const patchColor = (patch: Partial<typeof color>) => onCreativeChange({ color: { ...color, ...patch } });
  const luts = assets.filter((asset) => asset.kind === 'lut');
  return (
    <div>
      <DockSection title="Lumetri-style color">
        <button className="flex h-9 w-full items-center justify-center gap-2 rounded-sm bg-gradient-to-r from-cyan-500/15 to-violet-500/15 text-[9px] font-semibold text-cyan-100 ring-1 ring-inset ring-cyan-400/20 hover:from-cyan-500/25 hover:to-violet-500/25" onClick={onOpenColor}>
          <WandSparkles className="h-3.5 w-3.5" /> Analyze & Auto Color
        </button>
        <div className="mt-2 flex items-center justify-between text-[8px] text-slate-650">
          <span>{creative.colorWorkflow.autoGrade.analyzedAt ? `Last grade ${Math.round(creative.colorWorkflow.autoGrade.confidence * 100)}% confidence` : 'No automatic grade analyzed'}</span>
          <span>{creative.colorWorkflow.versions.length} versions</span>
        </div>
      </DockSection>
      <DockSection title="Basic correction">
        <div className="space-y-3">
          <DockRange label="Exposure" value={color.exposure} min={-0.5} max={0.5} step={0.01} onChange={(exposure) => patchColor({ exposure })} />
          <DockRange label="Contrast" value={color.contrast} min={0.25} max={2} step={0.01} onChange={(contrast) => patchColor({ contrast })} />
          <DockRange label="Highlights" value={color.highlights} min={-1} max={1} step={0.01} onChange={(highlights) => patchColor({ highlights })} />
          <DockRange label="Shadows" value={color.shadows} min={-1} max={1} step={0.01} onChange={(shadows) => patchColor({ shadows })} />
          <DockRange label="Saturation" value={color.saturation} min={0} max={3} step={0.01} onChange={(saturation) => patchColor({ saturation })} />
          <DockRange label="Temperature" value={color.temperature} min={-1} max={1} step={0.01} onChange={(temperature) => patchColor({ temperature })} />
          <DockRange label="Tint" value={color.tint} min={-1} max={1} step={0.01} onChange={(tint) => patchColor({ tint })} />
        </div>
        <button className="mt-3 h-7 w-full rounded-sm bg-white/[0.04] text-[8px] font-semibold text-slate-500 hover:bg-white/[0.08] hover:text-white" onClick={() => onCreativeChange({ color: { ...DEFAULT_CREATIVE.color } })}>Reset primary correction</button>
      </DockSection>
      <DockSection title="Creative LUT">
        <select className="nle-field" value={color.lutAssetId || ''} onChange={(event) => patchColor({ lutAssetId: event.target.value || null })}>
          <option value="">None</option>
          {luts.map((asset) => <option key={asset.id} value={asset.id}>{asset.library ? 'Library · ' : ''}{asset.name}</option>)}
        </select>
        <label className="mt-2 flex h-8 cursor-pointer items-center justify-center gap-2 rounded-sm border border-dashed border-white/10 text-[8px] font-semibold text-slate-500 hover:border-cyan-400/30 hover:text-cyan-200">
          {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} Upload LUT file
          <input className="hidden" type="file" accept=".cube,.3dl,.dat,.m3d" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(file); event.currentTarget.value = ''; }} />
        </label>
      </DockSection>
    </div>
  );
}

function QuickAudioDockPanel({
  creative,
  options,
  onCreativeChange,
  onOptionsChange,
  onOpenMixer,
}: {
  creative: LongformCreativeOptions;
  options: LongformOptions;
  onCreativeChange: (patch: Partial<LongformCreativeOptions>) => void;
  onOptionsChange: (patch: Partial<LongformOptions>) => void;
  onOpenMixer: () => void;
}) {
  const audio = creative.audio;
  const patchAudio = (patch: Partial<typeof audio>) => onCreativeChange({ audio: { ...audio, ...patch } });
  return (
    <div>
      <DockSection title="Essential sound">
        <div className="grid grid-cols-2 gap-1">
          <div className="bg-emerald-500/[0.07] p-2 text-[8px] text-emerald-200/60"><AudioLines className="mb-1 h-4 w-4 text-emerald-300" />Dialogue</div>
          <div className="bg-violet-500/[0.07] p-2 text-[8px] text-violet-200/60"><Volume2 className="mb-1 h-4 w-4 text-violet-300" />Music</div>
        </div>
      </DockSection>
      <DockSection title="Clip volume">
        <div className="space-y-3">
          <DockRange label="Dialogue" value={audio.dialogueGainDb} min={-24} max={18} step={0.5} suffix=" dB" onChange={(dialogueGainDb) => patchAudio({ dialogueGainDb })} />
          <DockRange label="Master" value={audio.masterGainDb} min={-24} max={12} step={0.5} suffix=" dB" onChange={(masterGainDb) => patchAudio({ masterGainDb })} />
          <DockRange label="Music" value={creative.musicVolume} min={0} max={0.5} step={0.01} onChange={(musicVolume) => onCreativeChange({ musicVolume })} />
        </div>
      </DockSection>
      <DockSection title="Dialogue repair">
        <DockSwitch label="Normalize loudness" detail={`Target ${options.targetLufs} LUFS`} checked={options.normalizeAudio} onChange={(normalizeAudio) => onOptionsChange({ normalizeAudio })} />
        <DockSwitch label="Reduce noise" checked={options.denoise} onChange={(denoise) => onOptionsChange({ denoise })} />
        <DockSwitch label="Compressor" checked={audio.compressor} onChange={(compressor) => patchAudio({ compressor })} />
        <DockSwitch label="De-esser" checked={audio.deEsser} onChange={(deEsser) => patchAudio({ deEsser })} />
        <DockSwitch label="Noise gate" checked={audio.noiseGate} onChange={(noiseGate) => patchAudio({ noiseGate })} />
        <DockSwitch label="Automatic music ducking" checked={creative.musicDucking} onChange={(musicDucking) => onCreativeChange({ musicDucking })} />
      </DockSection>
      <DockSection title="Mixer">
        <button className="flex h-8 w-full items-center justify-center gap-2 rounded-sm bg-white/[0.05] text-[9px] font-semibold text-slate-400 hover:bg-white/[0.09] hover:text-white" onClick={onOpenMixer}><SlidersHorizontal className="h-3.5 w-3.5" /> Open track mixer & keyframes</button>
      </DockSection>
    </div>
  );
}

function ExportDockPanel({
  creative,
  finishedDuration,
  renderBusy,
  onCreativeChange,
  onRender,
  onOpenPublish,
  onOpenInterchange,
}: {
  creative: LongformCreativeOptions;
  finishedDuration: number;
  renderBusy: boolean;
  onCreativeChange: (patch: Partial<LongformCreativeOptions>) => void;
  onRender: () => void;
  onOpenPublish: () => void;
  onOpenInterchange: () => void;
}) {
  return (
    <div>
      <DockSection title="Export settings">
        <label className="block"><span className="mb-1 block text-[8px] text-slate-600">Preset</span><select className="nle-field" value={creative.exportPreset} onChange={(event) => onCreativeChange({ exportPreset: event.target.value as LongformCreativeOptions['exportPreset'] })}><option value="source">Match source</option><option value="youtube_1080p">YouTube 1080p</option><option value="youtube_4k">YouTube 4K</option><option value="podcast">Podcast</option></select></label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label><span className="mb-1 block text-[8px] text-slate-600">Frame</span><select className="nle-field" value={creative.delivery.aspect} onChange={(event) => onCreativeChange({ delivery: { ...creative.delivery, aspect: event.target.value as typeof creative.delivery.aspect } })}><option value="source">Source</option><option value="16:9">16:9</option><option value="1:1">1:1</option><option value="9:16">9:16</option></select></label>
          <label><span className="mb-1 block text-[8px] text-slate-600">Reframe</span><select className="nle-field" value={creative.delivery.reframe} onChange={(event) => onCreativeChange({ delivery: { ...creative.delivery, reframe: event.target.value as typeof creative.delivery.reframe } })}><option value="contain">Contain</option><option value="smart_crop">Smart crop</option><option value="stretch">Stretch</option></select></label>
        </div>
      </DockSection>
      <DockSection title="Summary">
        <div className="space-y-1.5 font-mono text-[8px] text-slate-600">
          <div className="flex justify-between"><span>Sequence</span><span className="text-slate-300">{formatTimecode(finishedDuration)}</span></div>
          <div className="flex justify-between"><span>Captions</span><span className="text-slate-300">{creative.captions.burnIn ? 'Burned in' : creative.captions.enabled ? 'Sidecar' : 'Off'}</span></div>
          <div className="flex justify-between"><span>Color</span><span className="text-slate-300">{creative.color.lutAssetId ? 'LUT + grade' : 'Manual grade'}</span></div>
          <div className="flex justify-between"><span>Audio</span><span className="text-slate-300">{creative.audio.masterGainDb.toFixed(1)} dB master</span></div>
        </div>
      </DockSection>
      <DockSection title="Output">
        <button className="flex h-9 w-full items-center justify-center gap-2 rounded-sm bg-[#2678c9] text-[9px] font-semibold text-white hover:bg-[#3189df] disabled:opacity-50" disabled={renderBusy} onClick={onRender}>
          {renderBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />} Render master
        </button>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <button className="h-8 rounded-sm bg-white/[0.045] text-[8px] font-semibold text-slate-400 hover:bg-white/[0.08] hover:text-white" onClick={onOpenPublish}>Publish package</button>
          <button className="h-8 rounded-sm bg-white/[0.045] text-[8px] font-semibold text-slate-400 hover:bg-white/[0.08] hover:text-white" onClick={onOpenInterchange}>AAF / XML / EDL</button>
        </div>
      </DockSection>
    </div>
  );
}

function Timeline({
  duration,
  start,
  end,
  cuts,
  playhead,
  waveformUrl,
  chapters,
  creative,
  assets,
  transitionJoins,
  activeTool,
  snapEnabled,
  manualStart,
  manualEnd,
  selectedTitleId,
  onToolChange,
  onSnapChange,
  onSeek,
  onBlade,
  onMarkIn,
  onMarkOut,
  onAddCut,
  onCutBoundsChange,
  onTitleSelect,
  onCreativeChange,
  onOpenPanel,
}: {
  duration: number;
  start: number;
  end: number;
  cuts: LongformCut[];
  playhead: number;
  waveformUrl?: string;
  chapters: LongformChapter[];
  creative: LongformCreativeOptions;
  assets: LongformMediaAsset[];
  transitionJoins: TransitionJoin[];
  activeTool: TimelineTool;
  snapEnabled: boolean;
  manualStart: number;
  manualEnd: number;
  selectedTitleId: string | null;
  onToolChange: (tool: TimelineTool) => void;
  onSnapChange: (enabled: boolean) => void;
  onSeek: (seconds: number) => void;
  onBlade: (seconds: number) => void;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onAddCut: () => void;
  onCutBoundsChange: (id: string, start: number, end: number) => boolean;
  onTitleSelect: (id: string) => void;
  onCreativeChange: (patch: Partial<LongformCreativeOptions>) => void;
  onOpenPanel: (panel: Exclude<WindowPanel, null>) => void;
}) {
  const timelineRootRef = useRef<HTMLElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [linkedSelection, setLinkedSelection] = useState(true);
  const [selectedTimelineItemKeys, setSelectedTimelineItemKeys] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<TimelineMarquee | null>(null);
  const [draggingTimelineItemKeys, setDraggingTimelineItemKeys] = useState<string[]>([]);
  const [dropIndicator, setDropIndicator] = useState<{ trackId: string; time: number } | null>(null);
  const [sequenceTrimPreview, setSequenceTrimPreview] = useState<{
    trackId: string;
    clipId: string;
    timelineStart: number;
    timelineEnd: number;
    sourceStart: number;
    sourceEnd: number;
  } | null>(null);
  const activeSequence = creative.sequence.sequences.find((sequence) => sequence.id === creative.sequence.activeSequenceId)
    || creative.sequence.sequences[0];
  const orderedSequenceTracks = [...(activeSequence?.tracks || [])].sort((left, right) => left.order - right.order);
  const primaryVideoTrack = orderedSequenceTracks.find((track) => track.kind === 'video');
  const primaryAudioTrack = orderedSequenceTracks.find((track) => track.kind === 'audio' && track.name.toLowerCase() === 'music')
    || orderedSequenceTracks.find((track) => track.kind === 'audio');
  const additionalSequenceTracks = orderedSequenceTracks.filter((track) => (
    track.id !== primaryVideoTrack?.id
    && track.id !== primaryAudioTrack?.id
    && (track.clips.length > 0 || track.name.toLowerCase() !== 'audio 1')
  ));
  const timelineItems = useMemo<TimelineItemDescriptor[]>(() => [
    ...creative.titles.map((title) => ({
      key: timelineItemKey('title', 'graphics', title.id),
      kind: 'title' as const,
      id: title.id,
      trackId: 'graphics',
      start: title.start,
      end: title.end,
      movable: true,
      locked: false,
      linkedGroupId: null,
    })),
    ...creative.broll.map((item) => ({
      key: timelineItemKey('broll', 'broll', item.id),
      kind: 'broll' as const,
      id: item.id,
      trackId: 'broll',
      start: item.start,
      end: item.end,
      movable: true,
      locked: false,
      linkedGroupId: null,
    })),
    ...creative.adjustmentLayers.map((layer) => ({
      key: timelineItemKey('adjustment', 'broll', layer.id),
      kind: 'adjustment' as const,
      id: layer.id,
      trackId: 'broll',
      start: layer.start,
      end: layer.end,
      movable: true,
      locked: false,
      linkedGroupId: null,
    })),
    ...(creative.captions.enabled ? creative.captions.cues.map((cue) => ({
      key: timelineItemKey('caption', 'captions', cue.id),
      kind: 'caption' as const,
      id: cue.id,
      trackId: 'captions',
      start: cue.start,
      end: cue.end,
      movable: true,
      locked: false,
      linkedGroupId: null,
    })) : []),
    {
      key: timelineItemKey('program', 'program', 'program-video'),
      kind: 'program' as const,
      id: 'program-video',
      trackId: 'program',
      start,
      end,
      movable: false,
      locked: false,
      linkedGroupId: 'program-av',
    },
    {
      key: timelineItemKey('dialogue', 'dialogue', 'program-dialogue'),
      kind: 'dialogue' as const,
      id: 'program-dialogue',
      trackId: 'dialogue',
      start,
      end,
      movable: false,
      locked: false,
      linkedGroupId: 'program-av',
    },
    ...(activeSequence?.tracks.flatMap((track) => {
      const selectionTrackId = track.id === primaryVideoTrack?.id
        ? 'broll'
        : track.id === primaryAudioTrack?.id
          ? 'music'
          : track.id;
      return track.clips.map((clip) => ({
        key: timelineItemKey('sequence', track.id, clip.id),
        kind: 'sequence' as const,
        id: clip.id,
        trackId: selectionTrackId,
        start: clip.timelineStart,
        end: clip.timelineEnd,
        movable: !track.locked,
        locked: track.locked,
        linkedGroupId: clip.linkedGroupId,
        sequenceTrackId: track.id,
        sequenceTrackKind: track.kind,
      }));
    }) || []),
  ], [activeSequence, creative.adjustmentLayers, creative.broll, creative.captions, creative.titles, end, primaryAudioTrack?.id, primaryVideoTrack?.id, start]);
  const timelineItemsByKey = useMemo(
    () => new Map(timelineItems.map((item) => [item.key, item])),
    [timelineItems],
  );
  const selectedTimelineItems = selectedTimelineItemKeys
    .map((key) => timelineItemsByKey.get(key))
    .filter((item): item is TimelineItemDescriptor => Boolean(item));
  const selectedMovableItems = selectedTimelineItems.filter((item) => item.movable && !item.locked);

  useEffect(() => {
    setSelectedTimelineItemKeys((current) => current.filter((key) => timelineItemsByKey.has(key)));
  }, [timelineItemsByKey]);

  useEffect(() => {
    if (!selectedTitleId) return;
    const key = timelineItemKey('title', 'graphics', selectedTitleId);
    setSelectedTimelineItemKeys((current) => current.includes(key) ? current : [key]);
  }, [selectedTitleId]);
  const sequenceEnd = activeSequence?.tracks.reduce(
    (maximum, track) => Math.max(maximum, ...track.clips.map((clip) => clip.timelineEnd), 0),
    0,
  ) || 0;
  const safeDuration = Math.max(duration, sequenceEnd, end, 0.001);
  const position = (seconds: number) => `${Math.max(0, Math.min(100, (seconds / safeDuration) * 100))}%`;
  const width = (itemStart: number, itemEnd: number) => `${Math.max(0.3, ((itemEnd - itemStart) / safeDuration) * 100)}%`;
  const transitionByCut = new Map(creative.transitions.map((transition) => [transition.cutId, transition]));
  const [dragPreview, setDragPreview] = useState<{ id: string; start: number; end: number } | null>(null);
  const snapCandidates = useMemo(() => [
    start,
    end,
    manualStart,
    manualEnd,
    ...cuts.flatMap((cut) => [cut.start, cut.end]),
    ...chapters.map((chapter) => chapter.time),
    ...creative.editPoints.map((point) => point.time),
    ...creative.titles.flatMap((title) => [title.start, title.end]),
    ...creative.broll.flatMap((item) => [item.start, item.end]),
    ...(activeSequence?.tracks.flatMap((track) => track.clips.flatMap((clip) => [clip.timelineStart, clip.timelineEnd])) || []),
  ], [activeSequence, chapters, creative.broll, creative.editPoints, creative.titles, cuts, end, manualEnd, manualStart, start]);
  const snapTime = (rawTime: number) => {
    const bounded = Math.max(start, Math.min(end, rawTime));
    if (!snapEnabled) return bounded;
    const threshold = Math.max(0.04, safeDuration * 0.0025 / zoom);
    let closest = bounded;
    let closestDistance = threshold;
    for (const candidate of snapCandidates) {
      const distance = Math.abs(candidate - bounded);
      if (distance <= closestDistance) {
        closest = candidate;
        closestDistance = distance;
      }
    }
    return closest;
  };
  const snapSequenceTime = (rawTime: number) => {
    const bounded = clampValue(rawTime, 0, safeDuration);
    if (!snapEnabled) return bounded;
    const threshold = Math.max(0.04, safeDuration * 0.0025 / zoom);
    let closest = bounded;
    let closestDistance = threshold;
    for (const candidate of snapCandidates) {
      const distance = Math.abs(candidate - bounded);
      if (distance <= closestDistance) {
        closest = candidate;
        closestDistance = distance;
      }
    }
    return closest;
  };
  const timeFromPointer = (event: React.PointerEvent<HTMLDivElement> | PointerEvent, rect: DOMRect) => {
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(rect.width, 1)));
    return snapTime(ratio * safeDuration);
  };
  const focusTimeline = () => {
    timelineRootRef.current?.focus({ preventScroll: true });
  };
  const expandLinkedSelection = (keys: string[]) => {
    if (!linkedSelection) return [...new Set(keys)];
    const groups = new Set(
      keys
        .map((key) => timelineItemsByKey.get(key)?.linkedGroupId)
        .filter((group): group is string => Boolean(group)),
    );
    if (!groups.size) return [...new Set(keys)];
    return [...new Set([
      ...keys,
      ...timelineItems
        .filter((item) => !item.locked && item.linkedGroupId && groups.has(item.linkedGroupId))
        .map((item) => item.key),
    ])];
  };
  const selectTrackForward = (trackId: string, time: number, allTracks: boolean, additive: boolean) => {
    const matches = timelineItems
      .filter((item) => !item.locked && (allTracks || item.trackId === trackId) && item.start >= time - 0.001)
      .map((item) => item.key);
    const expanded = expandLinkedSelection(matches);
    setSelectedTimelineItemKeys((current) => additive ? [...new Set([...current, ...expanded])] : expanded);
  };
  const selectTimelineItem = (
    event: React.PointerEvent<HTMLElement>,
    item: TimelineItemDescriptor,
  ) => {
    event.stopPropagation();
    focusTimeline();
    if (activeTool === 'razor') return;
    if (activeTool === 'track') {
      event.preventDefault();
      selectTrackForward(item.trackId, item.start, event.shiftKey, event.ctrlKey || event.metaKey);
      onSeek(item.start);
      return;
    }
    const linkedKeys = expandLinkedSelection([item.key]);
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      setSelectedTimelineItemKeys((current) => {
        const next = new Set(current);
        const allSelected = linkedKeys.every((key) => next.has(key));
        linkedKeys.forEach((key) => allSelected ? next.delete(key) : next.add(key));
        return [...next];
      });
    } else {
      setSelectedTimelineItemKeys((current) => current.includes(item.key) ? current : linkedKeys);
    }
    onSeek(item.start);
  };
  const beginMarqueeSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const lane = event.currentTarget;
    const canvas = lane.closest<HTMLElement>('[data-timeline-canvas]');
    if (!canvas) return;
    event.preventDefault();
    focusTimeline();
    const pointerId = event.pointerId;
    const originClient = { x: event.clientX, y: event.clientY };
    const baseSelection = [...selectedTimelineItemKeys];
    const additive = event.shiftKey;
    const toggle = event.ctrlKey || event.metaKey;
    let moved = false;
    lane.setPointerCapture(pointerId);

    const selectionForHits = (hits: string[]) => {
      if (toggle) {
        const next = new Set(baseSelection);
        hits.forEach((key) => next.has(key) ? next.delete(key) : next.add(key));
        return expandLinkedSelection([...next]);
      }
      if (additive) return expandLinkedSelection([...new Set([...baseSelection, ...hits])]);
      return expandLinkedSelection(hits);
    };
    const move = (moveEvent: PointerEvent) => {
      const distance = Math.hypot(moveEvent.clientX - originClient.x, moveEvent.clientY - originClient.y);
      if (!moved && distance < 4) return;
      moved = true;
      const canvasBounds = canvas.getBoundingClientRect();
      const clientLeft = Math.max(canvasBounds.left + 116, Math.min(originClient.x, moveEvent.clientX));
      const clientRight = Math.min(canvasBounds.right, Math.max(originClient.x, moveEvent.clientX));
      const clientTop = Math.max(canvasBounds.top, Math.min(originClient.y, moveEvent.clientY));
      const clientBottom = Math.min(canvasBounds.bottom, Math.max(originClient.y, moveEvent.clientY));
      const hits = [...canvas.querySelectorAll<HTMLElement>('[data-timeline-item-key]')]
        .filter((element) => element.dataset.timelineSelectable !== 'false')
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.right >= clientLeft
            && bounds.left <= clientRight
            && bounds.bottom >= clientTop
            && bounds.top <= clientBottom;
        })
        .map((element) => element.dataset.timelineItemKey || '')
        .filter(Boolean);
      const nextSelection = selectionForHits(hits);
      setSelectedTimelineItemKeys(nextSelection);
      setMarquee({
        left: clientLeft - canvasBounds.left,
        top: clientTop - canvasBounds.top,
        width: Math.max(1, clientRight - clientLeft),
        height: Math.max(1, clientBottom - clientTop),
        count: nextSelection.length,
      });
    };
    const cleanup = () => {
      lane.removeEventListener('pointermove', move);
      lane.removeEventListener('pointerup', finish);
      lane.removeEventListener('pointercancel', cancel);
      if (lane.hasPointerCapture(pointerId)) lane.releasePointerCapture(pointerId);
      setMarquee(null);
    };
    const finish = (upEvent: PointerEvent) => {
      cleanup();
      if (moved) return;
      if (!additive && !toggle) setSelectedTimelineItemKeys([]);
      onSeek(timeFromPointer(upEvent, lane.getBoundingClientRect()));
    };
    const cancel = () => {
      setSelectedTimelineItemKeys(baseSelection);
      cleanup();
    };
    lane.addEventListener('pointermove', move);
    lane.addEventListener('pointerup', finish);
    lane.addEventListener('pointercancel', cancel);
  };
  const handleTimelinePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, input, select')) return;
    focusTimeline();
    const rect = event.currentTarget.getBoundingClientRect();
    const time = timeFromPointer(event, rect);
    const isRuler = event.currentTarget.dataset.timelineRuler !== undefined;
    if (activeTool === 'selection' && !isRuler) {
      beginMarqueeSelection(event);
      return;
    }
    if (activeTool === 'track' && !isRuler) {
      const trackId = event.currentTarget.dataset.timelineSelectionTrack;
      if (trackId) selectTrackForward(trackId, time, event.shiftKey, event.ctrlKey || event.metaKey);
      onSeek(time);
      return;
    }
    if (activeTool === 'hand') return;
    if (activeTool === 'zoom') {
      setZoom((current) => Math.min(8, current + 0.5));
      onSeek(time);
      return;
    }
    if (activeTool === 'razor') {
      onBlade(time);
      onSeek(time);
      return;
    }
    onSeek(time);
  };
  const beginCutDrag = (event: React.PointerEvent<HTMLButtonElement>, cut: LongformCut, edge: 'start' | 'end') => {
    event.preventDefault();
    event.stopPropagation();
    const timeline = event.currentTarget.closest('[data-edit-timeline]') as HTMLElement | null;
    if (!timeline) return;
    const rect = timeline.getBoundingClientRect();
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    handle.setPointerCapture(pointerId);
    let draft = { id: cut.id, start: cut.start, end: cut.end };
    const move = (moveEvent: PointerEvent) => {
      const time = timeFromPointer(moveEvent, rect);
      draft = edge === 'start'
        ? { ...draft, start: Math.min(time, draft.end - 0.02) }
        : { ...draft, end: Math.max(time, draft.start + 0.02) };
      setDragPreview(draft);
    };
    const finish = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      setDragPreview(null);
      onCutBoundsChange(cut.id, draft.start, draft.end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  };
  const updateActiveSequence = (updater: (sequence: NonNullable<typeof activeSequence>) => NonNullable<typeof activeSequence>) => {
    if (!activeSequence) return;
    onCreativeChange({
      sequence: {
        ...creative.sequence,
        enabled: true,
        sequences: creative.sequence.sequences.map((sequence) => sequence.id === activeSequence.id ? updater(sequence) : sequence),
      },
    });
  };
  const deleteSelectedTimelineItems = () => {
    const selected = new Set(selectedTimelineItemKeys);
    const selectedDescriptors = selectedTimelineItemKeys
      .map((key) => timelineItemsByKey.get(key))
      .filter((item): item is TimelineItemDescriptor => Boolean(item?.movable && !item.locked));
    if (!selectedDescriptors.length) return;
    const sequenceKeys = new Set(
      selectedDescriptors
        .filter((item) => item.kind === 'sequence')
        .map((item) => `${item.sequenceTrackId}|${item.id}`),
    );
    const titleIds = new Set(selectedDescriptors.filter((item) => item.kind === 'title').map((item) => item.id));
    const brollIds = new Set(selectedDescriptors.filter((item) => item.kind === 'broll').map((item) => item.id));
    const captionIds = new Set(selectedDescriptors.filter((item) => item.kind === 'caption').map((item) => item.id));
    const adjustmentIds = new Set(selectedDescriptors.filter((item) => item.kind === 'adjustment').map((item) => item.id));
    const patch: Partial<LongformCreativeOptions> = {};
    if (sequenceKeys.size && activeSequence) {
      patch.sequence = {
        ...creative.sequence,
        sequences: creative.sequence.sequences.map((sequence) => sequence.id === activeSequence.id
          ? {
              ...sequence,
              tracks: sequence.tracks.map((track) => ({
                ...track,
                clips: track.clips.filter((clip) => !sequenceKeys.has(`${track.id}|${clip.id}`)),
              })),
            }
          : sequence),
      };
    }
    if (titleIds.size) patch.titles = creative.titles.filter((item) => !titleIds.has(item.id));
    if (brollIds.size) patch.broll = creative.broll.filter((item) => !brollIds.has(item.id));
    if (captionIds.size) {
      patch.captions = {
        ...creative.captions,
        cues: creative.captions.cues.filter((item) => !captionIds.has(item.id)),
      };
    }
    if (adjustmentIds.size) {
      patch.adjustmentLayers = creative.adjustmentLayers.filter((item) => !adjustmentIds.has(item.id));
    }
    onCreativeChange(patch);
    setSelectedTimelineItemKeys((current) => current.filter((key) => !selected.has(key)));
  };
  const beginTimelineItemDrag = (
    event: React.DragEvent<HTMLElement>,
    item: TimelineItemDescriptor,
  ) => {
    if (!item.movable || item.locked || activeTool !== 'selection') {
      event.preventDefault();
      return;
    }
    const selected = selectedTimelineItemKeys.includes(item.key)
      ? selectedTimelineItemKeys
      : expandLinkedSelection([item.key]);
    const movableKeys = selected.filter((key) => {
      const candidate = timelineItemsByKey.get(key);
      return Boolean(candidate?.movable && !candidate.locked);
    });
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerRatio = clampValue((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
    const payload: TimelineDragPayload = {
      anchorKey: item.key,
      keys: movableKeys,
      pointerOffsetSec: pointerRatio * Math.max(0.02, item.end - item.start),
    };
    event.dataTransfer.setData('application/x-vcf-timeline-items', JSON.stringify(payload));
    if (item.kind === 'sequence' && item.sequenceTrackId) {
      event.dataTransfer.setData('application/x-vcf-clip', `${item.sequenceTrackId}|${item.id}`);
    }
    event.dataTransfer.effectAllowed = 'move';
    setSelectedTimelineItemKeys(selected);
    setDraggingTimelineItemKeys(movableKeys);
  };
  const readTimelineDragPayload = (dataTransfer: DataTransfer): TimelineDragPayload | null => {
    try {
      const raw = dataTransfer.getData('application/x-vcf-timeline-items');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<TimelineDragPayload>;
      if (typeof parsed.anchorKey !== 'string' || !Array.isArray(parsed.keys)) return null;
      return {
        anchorKey: parsed.anchorKey,
        keys: parsed.keys.filter((key): key is string => typeof key === 'string'),
        pointerOffsetSec: Number.isFinite(parsed.pointerOffsetSec) ? Number(parsed.pointerOffsetSec) : 0,
      };
    } catch {
      return null;
    }
  };
  const handleTimelineDragOver = (
    event: React.DragEvent<HTMLDivElement>,
    trackId: string,
  ) => {
    const hasTimelineItems = event.dataTransfer.types.includes('application/x-vcf-timeline-items')
      || event.dataTransfer.types.includes('application/x-vcf-clip');
    const hasAsset = event.dataTransfer.types.includes('application/x-longform-asset')
      || event.dataTransfer.types.includes('application/x-vcf-asset');
    if (!hasTimelineItems && !hasAsset) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = hasTimelineItems ? 'move' : 'copy';
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = clampValue((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
    setDropIndicator({ trackId, time: snapSequenceTime(ratio * safeDuration) });
  };
  const handleTimelineItemsDrop = (
    event: React.DragEvent<HTMLDivElement>,
    targetLaneKind: 'title' | 'broll' | 'caption' | 'sequence',
    targetTrack?: LongformSequenceTrack,
  ) => {
    const payload = readTimelineDragPayload(event.dataTransfer);
    if (!payload) return false;
    event.preventDefault();
    event.stopPropagation();
    setDropIndicator(null);
    const anchor = timelineItemsByKey.get(payload.anchorKey);
    if (!anchor || !anchor.movable || anchor.locked) return true;
    if (anchor.kind === 'sequence') {
      if (targetLaneKind !== 'sequence' || !targetTrack || targetTrack.locked || targetTrack.kind !== anchor.sequenceTrackKind) return true;
    } else if (
      (anchor.kind === 'title' && targetLaneKind !== 'title')
      || ((anchor.kind === 'broll' || anchor.kind === 'adjustment') && targetLaneKind !== 'broll')
      || (anchor.kind === 'caption' && targetLaneKind !== 'caption')
    ) {
      return true;
    }
    const movingItems = payload.keys
      .map((key) => timelineItemsByKey.get(key))
      .filter((item): item is TimelineItemDescriptor => Boolean(item?.movable && !item.locked));
    if (!movingItems.length) return true;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = clampValue((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
    const pointerTime = ratio * safeDuration;
    const proposedAnchorStart = snapSequenceTime(pointerTime - payload.pointerOffsetSec);
    const minimumStart = Math.min(...movingItems.map((item) => item.start));
    const delta = Math.max(-minimumStart, proposedAnchorStart - anchor.start);
    const patch: Partial<LongformCreativeOptions> = {};
    const nextSelectionKeys = new Map(movingItems.map((item) => [item.key, item.key]));
    const selectedSequence = movingItems.filter((item) => item.kind === 'sequence');
    if (selectedSequence.length && activeSequence) {
      const anchorSourceTrackId = anchor.sequenceTrackId;
      const moves = selectedSequence.flatMap((descriptor) => {
        const sourceTrack = activeSequence.tracks.find((track) => track.id === descriptor.sequenceTrackId);
        const clip = sourceTrack?.clips.find((candidate) => candidate.id === descriptor.id);
        if (!sourceTrack || !clip) return [];
        const destinationTrackId = anchor.kind === 'sequence'
          && targetTrack
          && sourceTrack.id === anchorSourceTrackId
          && sourceTrack.kind === targetTrack.kind
          ? targetTrack.id
          : sourceTrack.id;
        nextSelectionKeys.set(descriptor.key, timelineItemKey('sequence', destinationTrackId, clip.id));
        return [{ descriptor, clip, sourceTrackId: sourceTrack.id, destinationTrackId }];
      });
      patch.sequence = {
        ...creative.sequence,
        enabled: true,
        sequences: creative.sequence.sequences.map((sequence) => {
          if (sequence.id !== activeSequence.id) return sequence;
          return {
            ...sequence,
            tracks: sequence.tracks.map((track) => {
              const movedOutIds = new Set(
                moves
                  .filter((move) => move.sourceTrackId === track.id && move.destinationTrackId !== track.id)
                  .map((move) => move.clip.id),
              );
              const movedWithinIds = new Set(
                moves
                  .filter((move) => move.sourceTrackId === track.id && move.destinationTrackId === track.id)
                  .map((move) => move.clip.id),
              );
              const clips = track.clips
                .filter((clip) => !movedOutIds.has(clip.id))
                .map((clip) => movedWithinIds.has(clip.id)
                  ? { ...clip, timelineStart: clip.timelineStart + delta, timelineEnd: clip.timelineEnd + delta }
                  : clip);
              const incoming = moves
                .filter((move) => move.destinationTrackId === track.id && move.sourceTrackId !== track.id)
                .map((move) => ({
                  ...move.clip,
                  timelineStart: move.clip.timelineStart + delta,
                  timelineEnd: move.clip.timelineEnd + delta,
                }));
              return { ...track, clips: [...clips, ...incoming].sort((left, right) => left.timelineStart - right.timelineStart) };
            }),
          };
        }),
      };
    }
    const titleIds = new Set(movingItems.filter((item) => item.kind === 'title').map((item) => item.id));
    if (titleIds.size) {
      patch.titles = creative.titles.map((item) => titleIds.has(item.id)
        ? { ...item, start: item.start + delta, end: item.end + delta }
        : item);
    }
    const brollIds = new Set(movingItems.filter((item) => item.kind === 'broll').map((item) => item.id));
    if (brollIds.size) {
      patch.broll = creative.broll.map((item) => brollIds.has(item.id)
        ? { ...item, start: item.start + delta, end: item.end + delta }
        : item);
    }
    const captionIds = new Set(movingItems.filter((item) => item.kind === 'caption').map((item) => item.id));
    if (captionIds.size) {
      patch.captions = {
        ...creative.captions,
        cues: creative.captions.cues.map((item) => captionIds.has(item.id)
          ? { ...item, start: item.start + delta, end: item.end + delta }
          : item),
      };
    }
    const adjustmentIds = new Set(movingItems.filter((item) => item.kind === 'adjustment').map((item) => item.id));
    if (adjustmentIds.size) {
      patch.adjustmentLayers = creative.adjustmentLayers.map((item) => adjustmentIds.has(item.id)
        ? { ...item, start: item.start + delta, end: item.end + delta }
        : item);
    }
    onCreativeChange(patch);
    setSelectedTimelineItemKeys((current) => current.map((key) => nextSelectionKeys.get(key) || key));
    setDraggingTimelineItemKeys([]);
    onSeek(Math.max(0, anchor.start + delta));
    return true;
  };
  const splitSequenceClip = (track: LongformSequenceTrack, clip: LongformSequenceClip, splitTime: number) => {
    const bounded = clampValue(splitTime, clip.timelineStart + 0.02, clip.timelineEnd - 0.02);
    if (bounded <= clip.timelineStart + 0.019 || bounded >= clip.timelineEnd - 0.019) return;
    const timelineDuration = Math.max(0.02, clip.timelineEnd - clip.timelineStart);
    const fraction = clampValue((bounded - clip.timelineStart) / timelineDuration, 0.001, 0.999);
    const sourceSpan = Math.max(0.02, clip.sourceEnd - clip.sourceStart);
    const sourceSplit = clip.speed.reverse
      ? clip.sourceEnd - sourceSpan * fraction
      : clip.sourceStart + sourceSpan * fraction;
    const left: LongformSequenceClip = {
      ...clip,
      id: `${clip.id}-left-${Date.now()}`,
      timelineEnd: bounded,
      ...(clip.speed.reverse ? { sourceStart: sourceSplit } : { sourceEnd: sourceSplit }),
    };
    const right: LongformSequenceClip = {
      ...clip,
      id: `${clip.id}-right-${Date.now()}`,
      timelineStart: bounded,
      ...(clip.speed.reverse ? { sourceEnd: sourceSplit } : { sourceStart: sourceSplit }),
    };
    updateActiveSequence((sequence) => ({
      ...sequence,
      tracks: sequence.tracks.map((item) => item.id === track.id
        ? {
            ...item,
            clips: item.clips.flatMap((candidate) => candidate.id === clip.id ? [left, right] : [candidate])
              .sort((a, b) => a.timelineStart - b.timelineStart),
          }
        : item),
    }));
    setSelectedTimelineItemKeys(expandLinkedSelection([timelineItemKey('sequence', track.id, right.id)]));
    onSeek(bounded);
  };
  const handleSequenceDrop = (event: React.DragEvent<HTMLDivElement>, track: LongformSequenceTrack) => {
    event.preventDefault();
    event.stopPropagation();
    if (!activeSequence || track.locked) return;
    if (handleTimelineItemsDrop(event, 'sequence', track)) return;
    setDropIndicator(null);
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = clampValue((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
    const dropTime = snapSequenceTime(ratio * safeDuration);
    const assetId = event.dataTransfer.getData('application/x-longform-asset')
      || event.dataTransfer.getData('application/x-vcf-asset');
    const clipReference = event.dataTransfer.getData('application/x-vcf-clip');
    if (assetId) {
      const asset = assets.find((item) => item.id === assetId);
      if (!asset || asset.kind === 'lut') return;
      const sourceKind = assetTrackKind(asset);
      if (track.kind === 'video' && sourceKind === 'audio') return;
      if (track.kind === 'audio' && asset.mediaType === 'image') return;
      const clip = sequenceClipFromAsset(asset, dropTime);
      updateActiveSequence((sequence) => ({
        ...sequence,
        tracks: sequence.tracks.map((item) => item.id === track.id
          ? { ...item, clips: [...item.clips, clip].sort((left, right) => left.timelineStart - right.timelineStart) }
          : item),
      }));
      setSelectedTimelineItemKeys(expandLinkedSelection([timelineItemKey('sequence', track.id, clip.id)]));
      onSeek(dropTime);
      return;
    }
    if (!clipReference) return;
    const [sourceTrackId, clipId] = clipReference.split('|');
    const sourceTrack = activeSequence.tracks.find((item) => item.id === sourceTrackId);
    const clip = sourceTrack?.clips.find((item) => item.id === clipId);
    if (!sourceTrack || !clip || sourceTrack.kind !== track.kind) return;
    const clipDuration = clip.timelineEnd - clip.timelineStart;
    updateActiveSequence((sequence) => ({
      ...sequence,
      tracks: sequence.tracks.map((item) => {
        const withoutClip = item.id === sourceTrackId
          ? item.clips.filter((candidate) => candidate.id !== clipId)
          : item.clips;
        if (item.id !== track.id) return { ...item, clips: withoutClip };
        return {
          ...item,
          clips: [...withoutClip, { ...clip, timelineStart: dropTime, timelineEnd: dropTime + clipDuration }]
            .sort((left, right) => left.timelineStart - right.timelineStart),
        };
      }),
    }));
    setSelectedTimelineItemKeys(expandLinkedSelection([timelineItemKey('sequence', track.id, clip.id)]));
    onSeek(dropTime);
  };
  const beginSequenceTrim = (
    event: React.PointerEvent<HTMLSpanElement>,
    track: LongformSequenceTrack,
    clip: LongformSequenceClip,
    edge: 'start' | 'end',
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (track.locked) return;
    const lane = event.currentTarget.closest<HTMLElement>('[data-timeline-track-lane]');
    if (!lane) return;
    const laneBounds = lane.getBoundingClientRect();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const original = {
      trackId: track.id,
      clipId: clip.id,
      timelineStart: clip.timelineStart,
      timelineEnd: clip.timelineEnd,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
    };
    let draft = original;
    let changed = false;
    handle.setPointerCapture(pointerId);
    const move = (moveEvent: PointerEvent) => {
      const ratio = clampValue((moveEvent.clientX - laneBounds.left) / Math.max(1, laneBounds.width), 0, 1);
      const time = snapSequenceTime(ratio * safeDuration);
      if (edge === 'start') {
        const timelineStart = clampValue(time, 0, original.timelineEnd - 0.02);
        const delta = timelineStart - original.timelineStart;
        draft = {
          ...original,
          timelineStart,
          ...(clip.speed.reverse
            ? { sourceEnd: clampValue(original.sourceEnd - delta * clip.speed.rate, original.sourceStart + 0.02, 24 * 60 * 60) }
            : { sourceStart: clampValue(original.sourceStart + delta * clip.speed.rate, 0, original.sourceEnd - 0.02) }),
        };
      } else {
        const timelineEnd = Math.max(original.timelineStart + 0.02, time);
        const delta = timelineEnd - original.timelineEnd;
        draft = {
          ...original,
          timelineEnd,
          ...(clip.speed.reverse
            ? { sourceStart: clampValue(original.sourceStart - delta * clip.speed.rate, 0, original.sourceEnd - 0.02) }
            : { sourceEnd: clampValue(original.sourceEnd + delta * clip.speed.rate, original.sourceStart + 0.02, 24 * 60 * 60) }),
        };
      }
      changed = true;
      setSequenceTrimPreview(draft);
    };
    const finish = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      setSequenceTrimPreview(null);
      if (!changed) return;
      const delta = edge === 'start'
        ? draft.timelineStart - original.timelineStart
        : draft.timelineEnd - original.timelineEnd;
      const clipPatch = {
        timelineStart: draft.timelineStart,
        timelineEnd: draft.timelineEnd,
        sourceStart: draft.sourceStart,
        sourceEnd: draft.sourceEnd,
      };
      updateActiveSequence((sequence) => ({
        ...sequence,
        tracks: sequence.tracks.map((item) => {
          if (item.id !== track.id) return item;
          const adjacent = activeTool === 'rolling'
            ? item.clips.find((candidate) => candidate.id !== clip.id && (
                edge === 'start'
                  ? Math.abs(candidate.timelineEnd - original.timelineStart) < 0.04
                  : Math.abs(candidate.timelineStart - original.timelineEnd) < 0.04
              ))
            : null;
          return {
            ...item,
            clips: item.clips.map((candidate) => {
              if (candidate.id === clip.id) return { ...candidate, ...clipPatch };
              if (activeTool === 'ripple' && edge === 'end' && candidate.timelineStart >= original.timelineEnd - 0.001) {
                return {
                  ...candidate,
                  timelineStart: Math.max(0, candidate.timelineStart + delta),
                  timelineEnd: Math.max(0.02, candidate.timelineEnd + delta),
                };
              }
              if (adjacent?.id !== candidate.id) return candidate;
              if (edge === 'start') {
                return {
                  ...candidate,
                  timelineEnd: draft.timelineStart,
                  ...(candidate.speed.reverse
                    ? { sourceStart: Math.max(0, candidate.sourceStart - delta * candidate.speed.rate) }
                    : { sourceEnd: Math.max(candidate.sourceStart + 0.02, candidate.sourceEnd + delta * candidate.speed.rate) }),
                };
              }
              return {
                ...candidate,
                timelineStart: draft.timelineEnd,
                ...(candidate.speed.reverse
                  ? { sourceEnd: Math.max(candidate.sourceStart + 0.02, candidate.sourceEnd - delta * candidate.speed.rate) }
                  : { sourceStart: Math.max(0, candidate.sourceStart + delta * candidate.speed.rate) }),
              };
            }).sort((left, right) => left.timelineStart - right.timelineStart),
          };
        }),
      }));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  };
  const patchSequenceTrack = (trackId: string, patch: Partial<LongformCreativeOptions['sequence']['sequences'][number]['tracks'][number]>) => {
    if (!activeSequence) return;
    updateActiveSequence((sequence) => ({
      ...sequence,
      tracks: sequence.tracks.map((track) => track.id === trackId ? { ...track, ...patch } : track),
    }));
  };
  const renderSequenceClips = (track: LongformSequenceTrack | undefined) => {
    if (!track) return null;
    return track.clips.map((clip) => {
      const itemKey = timelineItemKey('sequence', track.id, clip.id);
      const timelineItem = timelineItemsByKey.get(itemKey);
      const preview = sequenceTrimPreview?.trackId === track.id && sequenceTrimPreview.clipId === clip.id
        ? sequenceTrimPreview
        : null;
      const timelineStart = preview?.timelineStart ?? clip.timelineStart;
      const timelineEnd = preview?.timelineEnd ?? clip.timelineEnd;
      const selected = selectedTimelineItemKeys.includes(itemKey);
      const dragging = draggingTimelineItemKeys.includes(itemKey);
      return (
        <button
          key={clip.id}
          draggable={!track.locked && activeTool === 'selection'}
          className={clsx(
            'group absolute inset-y-1 select-none overflow-hidden border px-1.5 text-left text-[7px] font-semibold',
            track.kind === 'video'
              ? 'border-sky-300/25 bg-sky-600/55 text-sky-50 hover:bg-sky-500/70'
              : 'border-emerald-300/20 bg-emerald-600/45 text-emerald-50 hover:bg-emerald-500/60',
            selected && 'z-10 border-sky-100 bg-sky-500/80 ring-2 ring-inset ring-sky-100/80 shadow-[0_0_0_1px_rgba(14,165,233,0.9)]',
            dragging && 'opacity-45',
            !clip.enabled && 'opacity-35',
            activeTool === 'razor' && 'cursor-crosshair',
          )}
          data-sequence-clip={clip.id}
          data-timeline-item-key={itemKey}
          data-timeline-selectable={track.locked ? 'false' : 'true'}
          style={{ left: position(timelineStart), width: width(timelineStart, timelineEnd) }}
          onDragStart={(event) => timelineItem && beginTimelineItemDrag(event, timelineItem)}
          onDragEnd={() => {
            setDraggingTimelineItemKeys([]);
            setDropIndicator(null);
          }}
          onPointerDown={(event) => timelineItem && selectTimelineItem(event, timelineItem)}
          onClick={(event) => {
            event.stopPropagation();
            if (activeTool === 'razor') {
              const bounds = event.currentTarget.getBoundingClientRect();
              const ratio = clampValue((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
              splitSequenceClip(track, clip, clip.timelineStart + ratio * (clip.timelineEnd - clip.timelineStart));
              return;
            }
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (timelineItem) setSelectedTimelineItemKeys(expandLinkedSelection([timelineItem.key]));
            onOpenPanel({ suite: 'v3', tab: 'timeline' });
          }}
          title={`${clip.name} · ${formatTimecode(timelineStart)}–${formatTimecode(timelineEnd)} · drag to move, C to splice`}
        >
          <span className="block truncate">
            {track.kind === 'audio' ? <AudioLines className="mr-1 inline h-2.5 w-2.5" /> : <Film className="mr-1 inline h-2.5 w-2.5" />}
            {clip.name}
          </span>
          {selected && activeTool !== 'razor' && (
            <>
              <span
                className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/45 hover:bg-white/80"
                data-clip-trim="start"
                onPointerDown={(event) => beginSequenceTrim(event, track, clip, 'start')}
                onClick={(event) => event.stopPropagation()}
                title={activeTool === 'rolling' ? 'Rolling trim start' : 'Trim start'}
              />
              <span
                className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/45 hover:bg-white/80"
                data-clip-trim="end"
                onPointerDown={(event) => beginSequenceTrim(event, track, clip, 'end')}
                onClick={(event) => event.stopPropagation()}
                title={activeTool === 'ripple' ? 'Ripple trim end' : activeTool === 'rolling' ? 'Rolling trim end' : 'Trim end'}
              />
            </>
          )}
        </button>
      );
    });
  };
  const rulerTicks = Array.from({ length: 13 }, (_, index) => (safeDuration * index) / 12);
  const activeCursor = activeTool === 'razor'
    ? 'cursor-crosshair'
    : activeTool === 'hand'
      ? 'cursor-grab'
      : activeTool === 'zoom'
        ? 'cursor-zoom-in'
        : activeTool === 'track'
          ? 'cursor-cell'
          : 'cursor-default';
  const programItemKey = timelineItemKey('program', 'program', 'program-video');
  const programItem = timelineItemsByKey.get(programItemKey);
  const programSelected = selectedTimelineItemKeys.includes(programItemKey);
  const dialogueItemKey = timelineItemKey('dialogue', 'dialogue', 'program-dialogue');
  const dialogueItem = timelineItemsByKey.get(dialogueItemKey);
  const dialogueSelected = selectedTimelineItemKeys.includes(dialogueItemKey);
  const programTrack = (
    <>
      <button
        type="button"
        className={clsx(
          'absolute inset-y-1.5 select-none bg-sky-600/55 text-left ring-1 ring-inset ring-sky-300/20',
          programSelected && 'z-10 bg-sky-500/75 ring-2 ring-inset ring-sky-100/90 shadow-[0_0_0_1px_rgba(14,165,233,0.9)]',
        )}
        style={{ left: position(start), width: width(start, end) }}
        data-timeline-item-key={programItemKey}
        data-timeline-selectable="true"
        onPointerDown={(event) => programItem && selectTimelineItem(event, programItem)}
        onClick={(event) => {
          event.stopPropagation();
          if (activeTool !== 'razor') return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const ratio = clampValue((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
          const time = snapTime(start + ratio * Math.max(0.02, end - start));
          onBlade(time);
          onSeek(time);
        }}
        title={`Program ${formatTime(start)}–${formatTime(end)}`}
      >
        <span className="absolute left-2 top-1 truncate text-[8px] font-semibold text-sky-50/80">Program video</span>
      </button>
      {manualEnd > manualStart && (
        <div className="pointer-events-none absolute inset-y-0 border-x border-amber-300/60 bg-amber-300/[0.06]" style={{ left: position(manualStart), width: width(manualStart, manualEnd) }} />
      )}
      {cuts.map((cut) => {
        const display = dragPreview?.id === cut.id ? dragPreview : cut;
        return (
          <div
            key={cut.id}
            className={clsx(
              'absolute inset-y-1 border-x',
              cut.enabled ? 'border-red-300/45 bg-red-500/80' : 'border-amber-300/30 bg-amber-500/25',
            )}
            style={{ left: position(display.start), width: width(display.start, display.end) }}
            title={`${cut.enabled ? 'Removed' : 'Disabled cut'} ${formatTimecode(display.start)}–${formatTimecode(display.end)}`}
          >
            <button
              type="button"
              className="absolute inset-0 w-full text-left hover:brightness-125"
              onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
              onClick={() => onSeek(display.start)}
            >
              <span className="block truncate px-1 pt-1 text-[7px] font-bold uppercase tracking-wider text-red-50/80">{cut.enabled ? 'Removed' : 'Disabled'}</span>
            </button>
            <button
              type="button"
              className="absolute inset-y-0 -left-1 w-2 cursor-ew-resize touch-none border-l border-white/50 bg-white/10 opacity-70 hover:opacity-100"
              aria-label={`Trim cut start at ${formatTime(display.start)}`}
              onPointerDown={(pointerEvent) => beginCutDrag(pointerEvent, cut, 'start')}
            />
            <button
              type="button"
              className="absolute inset-y-0 -right-1 w-2 cursor-ew-resize touch-none border-r border-white/50 bg-white/10 opacity-70 hover:opacity-100"
              aria-label={`Trim cut end at ${formatTime(display.end)}`}
              onPointerDown={(pointerEvent) => beginCutDrag(pointerEvent, cut, 'end')}
            />
          </div>
        );
      })}
      {creative.editPoints.map((point) => (
        <button
          key={point.id}
          className="absolute inset-y-0 w-px bg-pink-300/80 hover:bg-pink-100"
          style={{ left: position(point.time) }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onSeek(point.time)}
          title={`${point.label} · ${formatTimecode(point.time)}`}
        >
          <Scissors className="absolute -left-1.5 top-1 h-3 w-3 rounded-sm bg-slate-950 p-0.5 text-pink-300" />
        </button>
      ))}
      {transitionJoins.map((join) => {
        const transition = transitionByCut.get(join.cutId);
        if (!transition || transition.type === 'cut') return null;
        return (
          <button
            key={join.cutId}
            className="absolute bottom-1 top-1 w-3 -translate-x-1/2 skew-x-[-18deg] border-x border-amber-100/60 bg-amber-300/40 shadow-[0_0_8px_rgba(252,211,77,0.35)]"
            style={{ left: position(join.sourceTime) }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onSeek(join.sourceTime)}
            title={`${TRANSITION_OPTIONS.find((item) => item.value === transition.type)?.label || transition.type} · ${transition.duration.toFixed(2)}s`}
          />
        );
      })}
    </>
  );
  const handleTimelineKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'a') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedTimelineItemKeys(expandLinkedSelection(
        timelineItems.filter((item) => !item.locked).map((item) => item.key),
      ));
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setSelectedTimelineItemKeys([]);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!selectedMovableItems.length) return;
      event.preventDefault();
      event.stopPropagation();
      deleteSelectedTimelineItems();
    }
  };
  return (
    <section
      ref={timelineRootRef}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#121212] outline-none"
      tabIndex={-1}
      onKeyDown={handleTimelineKeyDown}
      aria-label="Main sequence timeline"
    >
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-black bg-[#1b1b1b] px-1.5">
        <div className="flex min-w-0 items-center overflow-x-auto scrollbar-thin">
          {TIMELINE_TOOLS.map((tool) => {
            const Icon = tool.icon;
            return (
              <button
                key={tool.id}
                className={clsx('nle-icon-button', activeTool === tool.id && 'bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/20')}
                onClick={() => onToolChange(tool.id)}
                title={`${tool.label} (${tool.shortcut})`}
                aria-label={`${tool.label} tool`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>
        <span className="mx-1 h-5 w-px bg-white/[0.06]" />
        <button className={clsx('nle-icon-button', snapEnabled && 'text-sky-300')} onClick={() => onSnapChange(!snapEnabled)} title="Snap in Timeline (S)"><Magnet className="h-3.5 w-3.5" /></button>
        <button className={clsx('nle-icon-button', linkedSelection && 'text-sky-300')} onClick={() => setLinkedSelection((current) => !current)} title="Linked selection"><Link2 className="h-3.5 w-3.5" /></button>
        <button
          className="nle-icon-button text-slate-600 enabled:hover:text-red-300"
          disabled={!selectedMovableItems.length}
          onClick={deleteSelectedTimelineItems}
          title={selectedMovableItems.length ? `Delete ${selectedMovableItems.length} selected timeline item${selectedMovableItems.length === 1 ? '' : 's'}` : 'Select timeline items to delete'}
          aria-label="Delete selected timeline items"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        {selectedTimelineItemKeys.length > 0 && (
          <span className="hidden rounded-sm bg-sky-500/10 px-1.5 py-1 font-mono text-[7px] text-sky-200 md:inline">
            {selectedTimelineItemKeys.length} selected
          </span>
        )}
        <span className="mx-1 h-5 w-px bg-white/[0.06]" />
        <button className="nle-text-button" onClick={onMarkIn} title="Mark In (I)">I</button>
        <button className="nle-text-button" onClick={onMarkOut} title="Mark Out (O)">O</button>
        <button className="hidden h-7 items-center gap-1 rounded-sm bg-red-500/10 px-2 text-[8px] font-semibold text-red-200 hover:bg-red-500/20 disabled:opacity-30 sm:flex" disabled={manualEnd - manualStart < 0.02} onClick={onAddCut} title="Add the marked range to removals">
          <Scissors className="h-3 w-3" /> Remove In–Out
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button className="hidden h-7 items-center gap-1 rounded-sm px-2 text-[8px] font-semibold text-slate-500 hover:bg-white/[0.06] hover:text-white lg:flex" onClick={() => onOpenPanel({ suite: 'cuts', tab: 'cuts' })}>Cuts</button>
          <button className="hidden h-7 items-center gap-1 rounded-sm px-2 text-[8px] font-semibold text-slate-500 hover:bg-white/[0.06] hover:text-white lg:flex" onClick={() => onOpenPanel({ suite: 'v3', tab: 'timeline' })}>Sequence</button>
          <ZoomIn className="ml-1 h-3 w-3 text-slate-700" />
          <input className="h-1 w-20 accent-sky-500" type="range" min={1} max={8} step={0.25} value={zoom} onChange={(event) => setZoom(numberValue(event.target.value, zoom))} aria-label="Timeline zoom" />
          <span className="w-8 font-mono text-[8px] text-slate-600">{Math.round(zoom * 100)}%</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <div
          className="relative min-h-full min-w-full select-none bg-[#111]"
          style={{ width: `${zoom * 100}%` }}
          data-timeline-canvas
        >
          <div className="grid h-6 grid-cols-[116px_minmax(0,1fr)] border-b border-black bg-[#181818]">
            <div className="sticky left-0 z-30 flex items-center border-r border-black bg-[#1c1c1c] px-2 font-mono text-[8px] text-sky-200">{formatTimecode(playhead)}</div>
            <div
              className={clsx('relative', activeCursor)}
              onPointerDown={handleTimelinePointer}
              data-timeline-ruler
              role="slider"
              tabIndex={0}
              aria-label="Timeline ruler"
              aria-valuemin={start}
              aria-valuemax={end}
              aria-valuenow={playhead}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const direction = event.key === 'ArrowLeft' ? -1 : 1;
                onSeek(Math.max(start, Math.min(end, playhead + direction * (event.shiftKey ? 5 : 1 / 30))));
              }}
            >
              {rulerTicks.map((tick, index) => (
                <span key={index} className="absolute inset-y-0 border-l border-white/10 pl-1 pt-1 font-mono text-[7px] text-slate-700" style={{ left: position(tick) }}>{formatTime(tick)}</span>
              ))}
              {chapters.map((chapter) => (
                <button key={chapter.id} className="absolute top-0 h-3 w-3 -translate-x-1/2 rotate-45 bg-cyan-400" style={{ left: position(chapter.time) }} onPointerDown={(event) => event.stopPropagation()} onClick={() => onSeek(chapter.time)} title={`${chapter.title} · ${formatTimecode(chapter.time)}`} />
              ))}
              {creative.sequence.markers.map((marker) => (
                <button key={marker.id} className="absolute top-0 h-3 w-3 -translate-x-1/2 rotate-45" style={{ left: position(marker.time), backgroundColor: marker.color }} onPointerDown={(event) => event.stopPropagation()} onClick={() => onSeek(marker.time)} title={`${marker.label} · ${formatTimecode(marker.time)}`} />
              ))}
              <TimelinePlayhead position={position(playhead)} needle />
            </div>
          </div>

          <TimelineTrackRow
            trackId="V3"
            name="Graphics"
            kind="video"
            accent="violet"
            playheadPosition={position(playhead)}
            cursor={activeCursor}
            onPointerDown={handleTimelinePointer}
            selectionTrackId="graphics"
            onDragOver={(event) => handleTimelineDragOver(event, 'graphics')}
            onDrop={(event) => handleTimelineItemsDrop(event, 'title')}
            dropIndicatorPosition={dropIndicator?.trackId === 'graphics' ? position(dropIndicator.time) : undefined}
          >
          {creative.titles.map((title) => {
            const itemKey = timelineItemKey('title', 'graphics', title.id);
            const timelineItem = timelineItemsByKey.get(itemKey);
            const selected = selectedTimelineItemKeys.includes(itemKey);
            return (
              <button
                key={title.id}
                draggable={activeTool === 'selection'}
                className={clsx(
                  'absolute inset-y-1 select-none overflow-hidden border px-1.5 text-left text-[8px] font-semibold text-violet-50 hover:bg-violet-500/75',
                  selected
                    ? 'z-10 border-violet-50 bg-violet-500/85 ring-2 ring-inset ring-violet-100/80'
                    : 'border-violet-300/25 bg-violet-500/55',
                  draggingTimelineItemKeys.includes(itemKey) && 'opacity-45',
                )}
                style={{ left: position(title.start), width: width(title.start, title.end) }}
                data-timeline-item-key={itemKey}
                data-timeline-selectable="true"
                onDragStart={(event) => timelineItem && beginTimelineItemDrag(event, timelineItem)}
                onDragEnd={() => {
                  setDraggingTimelineItemKeys([]);
                  setDropIndicator(null);
                }}
                onPointerDown={(event) => timelineItem && selectTimelineItem(event, timelineItem)}
                onClick={(event) => {
                  event.stopPropagation();
                  onTitleSelect(title.id);
                }}
                title={`${title.text} · ${formatTimecode(title.start)}–${formatTimecode(title.end)} · drag to move`}
              >
                <Type className="mr-1 inline h-2.5 w-2.5" /><span className="truncate">{title.text}</span>
              </button>
            );
          })}
          </TimelineTrackRow>

          <TimelineTrackRow
            trackId="V2"
            name={primaryVideoTrack?.name || 'B-roll / FX'}
            kind="video"
            accent="sky"
            locked={primaryVideoTrack?.locked}
            hidden={primaryVideoTrack?.hidden}
            onLocked={primaryVideoTrack ? (locked) => patchSequenceTrack(primaryVideoTrack.id, { locked }) : undefined}
            onHidden={primaryVideoTrack ? (hidden) => patchSequenceTrack(primaryVideoTrack.id, { hidden }) : undefined}
            playheadPosition={position(playhead)}
            cursor={activeCursor}
            onPointerDown={handleTimelinePointer}
            onDragOver={(event) => handleTimelineDragOver(event, 'broll')}
            onDrop={(event) => {
              const payload = readTimelineDragPayload(event.dataTransfer);
              const anchor = payload ? timelineItemsByKey.get(payload.anchorKey) : null;
              if (anchor && anchor.kind !== 'sequence') {
                handleTimelineItemsDrop(event, 'broll', primaryVideoTrack);
                return;
              }
              if (primaryVideoTrack) handleSequenceDrop(event, primaryVideoTrack);
            }}
            timelineTrackId={primaryVideoTrack?.id}
            selectionTrackId="broll"
            dropIndicatorPosition={dropIndicator?.trackId === 'broll' ? position(dropIndicator.time) : undefined}
          >
          {renderSequenceClips(primaryVideoTrack)}
          {creative.broll.map((item, index) => {
            const itemKey = timelineItemKey('broll', 'broll', item.id);
            const timelineItem = timelineItemsByKey.get(itemKey);
            const selected = selectedTimelineItemKeys.includes(itemKey);
            return (
              <button
                key={item.id}
                draggable={activeTool === 'selection'}
                className={clsx(
                  'absolute inset-y-1 select-none overflow-hidden border bg-sky-500/55 px-1.5 text-left text-[8px] font-semibold text-sky-50 hover:bg-sky-500/70',
                  selected ? 'z-10 border-sky-50 bg-sky-500/85 ring-2 ring-inset ring-sky-100/80' : 'border-sky-300/25',
                  draggingTimelineItemKeys.includes(itemKey) && 'opacity-45',
                )}
                style={{ left: position(item.start), width: width(item.start, item.end) }}
                data-timeline-item-key={itemKey}
                data-timeline-selectable="true"
                onDragStart={(event) => timelineItem && beginTimelineItemDrag(event, timelineItem)}
                onDragEnd={() => {
                  setDraggingTimelineItemKeys([]);
                  setDropIndicator(null);
                }}
                onPointerDown={(event) => timelineItem && selectTimelineItem(event, timelineItem)}
                onClick={(event) => event.stopPropagation()}
                title={`B-roll ${index + 1} · ${formatTimecode(item.start)}–${formatTimecode(item.end)} · drag to move`}
              >
                <Film className="mr-1 inline h-2.5 w-2.5" /><span className="truncate">B-roll {index + 1}</span>
              </button>
            );
          })}
          {creative.adjustmentLayers.map((layer) => {
            const itemKey = timelineItemKey('adjustment', 'broll', layer.id);
            const timelineItem = timelineItemsByKey.get(itemKey);
            const selected = selectedTimelineItemKeys.includes(itemKey);
            return (
              <button
                key={layer.id}
                draggable={activeTool === 'selection'}
                className={clsx(
                  'absolute bottom-0 h-2 select-none border-x border-orange-200/50 bg-orange-400/70',
                  selected && 'z-20 border-white bg-orange-300 ring-1 ring-white',
                  draggingTimelineItemKeys.includes(itemKey) && 'opacity-45',
                )}
                style={{ left: position(layer.start), width: width(layer.start, layer.end) }}
                data-timeline-item-key={itemKey}
                data-timeline-selectable="true"
                onDragStart={(event) => timelineItem && beginTimelineItemDrag(event, timelineItem)}
                onDragEnd={() => {
                  setDraggingTimelineItemKeys([]);
                  setDropIndicator(null);
                }}
                onPointerDown={(event) => timelineItem && selectTimelineItem(event, timelineItem)}
                onClick={(event) => event.stopPropagation()}
                title={`${layer.name} · adjustment layer · drag to move`}
              >
                <span className="sr-only">{layer.name}</span>
              </button>
            );
          })}
          </TimelineTrackRow>

          <TimelineTrackRow
            trackId="V1"
            name="Program"
            kind="video"
            accent="blue"
            playheadPosition={position(playhead)}
            cursor={activeCursor}
            onPointerDown={handleTimelinePointer}
            selectionTrackId="program"
            dataEditTimeline
          >
            {programTrack}
          </TimelineTrackRow>

          <TimelineTrackRow
            trackId="C1"
            name="Captions"
            kind="caption"
            accent="pink"
            hidden={!creative.captions.enabled}
            onHidden={(hidden) => onCreativeChange({ captions: { ...creative.captions, enabled: !hidden } })}
            playheadPosition={position(playhead)}
            cursor={activeCursor}
            onPointerDown={handleTimelinePointer}
            selectionTrackId="captions"
            onDragOver={(event) => handleTimelineDragOver(event, 'captions')}
            onDrop={(event) => handleTimelineItemsDrop(event, 'caption')}
            dropIndicatorPosition={dropIndicator?.trackId === 'captions' ? position(dropIndicator.time) : undefined}
          >
          {creative.captions.enabled && creative.captions.cues.map((cue) => {
            const itemKey = timelineItemKey('caption', 'captions', cue.id);
            const timelineItem = timelineItemsByKey.get(itemKey);
            const selected = selectedTimelineItemKeys.includes(itemKey);
            return (
              <button
                key={cue.id}
                draggable={activeTool === 'selection'}
                className={clsx(
                  'absolute inset-y-1 select-none overflow-hidden border px-1 text-left text-[7px]',
                  cue.lowConfidence
                    ? 'border-amber-300/30 bg-amber-500/45 text-amber-50'
                    : 'border-fuchsia-300/20 bg-fuchsia-500/35 text-fuchsia-50',
                  selected && 'z-10 border-white bg-fuchsia-500/75 ring-2 ring-inset ring-fuchsia-100/80',
                  draggingTimelineItemKeys.includes(itemKey) && 'opacity-45',
                )}
                style={{ left: position(cue.start), width: width(cue.start, cue.end) }}
                data-timeline-item-key={itemKey}
                data-timeline-selectable="true"
                onDragStart={(event) => timelineItem && beginTimelineItemDrag(event, timelineItem)}
                onDragEnd={() => {
                  setDraggingTimelineItemKeys([]);
                  setDropIndicator(null);
                }}
                onPointerDown={(event) => timelineItem && selectTimelineItem(event, timelineItem)}
                onClick={(event) => event.stopPropagation()}
                title={`${cue.text} · ${formatTimecode(cue.start)}–${formatTimecode(cue.end)} · drag to move`}
              >
                <span className="block truncate">{cue.text}</span>
              </button>
            );
          })}
          </TimelineTrackRow>

          <TimelineTrackRow
            trackId="A1"
            name="Dialogue"
            kind="audio"
            accent="green"
            muted={creative.audio.dialogueMuted}
            onMuted={(dialogueMuted) => onCreativeChange({ audio: { ...creative.audio, dialogueMuted } })}
            playheadPosition={position(playhead)}
            cursor={activeCursor}
            onPointerDown={handleTimelinePointer}
            selectionTrackId="dialogue"
          >
            <button
              type="button"
              className={clsx(
                'absolute inset-y-1.5 select-none bg-emerald-600/30 text-left ring-1 ring-inset ring-emerald-300/15',
                dialogueSelected && 'z-10 bg-emerald-500/55 ring-2 ring-inset ring-emerald-100/85 shadow-[0_0_0_1px_rgba(16,185,129,0.8)]',
              )}
              style={{ left: position(start), width: width(start, end) }}
              data-timeline-item-key={dialogueItemKey}
              data-timeline-selectable="true"
              onPointerDown={(event) => dialogueItem && selectTimelineItem(event, dialogueItem)}
              onClick={(event) => {
                event.stopPropagation();
                if (activeTool !== 'razor') return;
                const bounds = event.currentTarget.getBoundingClientRect();
                const ratio = clampValue((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
                const time = snapTime(start + ratio * Math.max(0.02, end - start));
                onBlade(time);
                onSeek(time);
              }}
              title={`Dialogue · ${formatTimecode(start)}–${formatTimecode(end)} · linked to Program video`}
            >
              {waveformUrl && <img src={waveformUrl} alt="" className="pointer-events-none h-full w-full object-fill opacity-55 grayscale invert" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
            </button>
            {cuts.filter((cut) => cut.enabled).map((cut) => <div key={cut.id} className="pointer-events-none absolute inset-y-1.5 bg-red-950/80" style={{ left: position(cut.start), width: width(cut.start, cut.end) }} />)}
          </TimelineTrackRow>

          <TimelineTrackRow
            trackId="A2"
            name={primaryAudioTrack?.name || 'Music'}
            kind="audio"
            accent="green"
            locked={primaryAudioTrack?.locked}
            muted={primaryAudioTrack?.muted ?? creative.audio.musicMuted}
            solo={primaryAudioTrack?.solo}
            onLocked={primaryAudioTrack ? (locked) => patchSequenceTrack(primaryAudioTrack.id, { locked }) : undefined}
            onMuted={primaryAudioTrack
              ? (muted) => patchSequenceTrack(primaryAudioTrack.id, { muted })
              : (musicMuted) => onCreativeChange({ audio: { ...creative.audio, musicMuted } })}
            onSolo={primaryAudioTrack ? (solo) => patchSequenceTrack(primaryAudioTrack.id, { solo }) : undefined}
            playheadPosition={position(playhead)}
            cursor={activeCursor}
            onPointerDown={handleTimelinePointer}
            onDragOver={primaryAudioTrack ? (event) => handleTimelineDragOver(event, primaryAudioTrack.id) : undefined}
            onDrop={primaryAudioTrack ? (event) => handleSequenceDrop(event, primaryAudioTrack) : undefined}
            timelineTrackId={primaryAudioTrack?.id}
            selectionTrackId="music"
            dropIndicatorPosition={dropIndicator && primaryAudioTrack && dropIndicator.trackId === primaryAudioTrack.id ? position(dropIndicator.time) : undefined}
          >
            {renderSequenceClips(primaryAudioTrack)}
            {creative.musicAssetId && (
              <div className="absolute inset-y-1.5 bg-emerald-500/35 px-2 pt-1 text-[7px] font-semibold text-emerald-100 ring-1 ring-inset ring-emerald-300/15" style={{ left: position(start), width: width(start, end) }}>
                Background music · {Math.round(creative.musicVolume * 100)}%
              </div>
            )}
          </TimelineTrackRow>

          {creative.sequence.enabled && activeSequence && additionalSequenceTracks.length > 0 && (
            <>
              <div className="grid h-5 grid-cols-[116px_minmax(0,1fr)] border-y border-black bg-[#161616]">
                <button className="sticky left-0 z-20 border-r border-black bg-[#1a1a1a] px-2 text-left text-[7px] font-bold uppercase tracking-[0.15em] text-slate-600 hover:text-white" onClick={() => onOpenPanel({ suite: 'v3', tab: 'timeline' })}>Additional tracks</button>
                <div className="flex items-center px-2 text-[7px] text-slate-700">Drag clips between matching video or audio tracks</div>
              </div>
              {additionalSequenceTracks.map((track, index) => (
                <TimelineTrackRow
                  key={track.id}
                  trackId={`${track.kind === 'video' ? 'V' : 'A'}${index + 1}`}
                  name={track.name}
                  kind={track.kind}
                  accent={track.kind === 'video' ? 'blue' : 'green'}
                  locked={track.locked}
                  hidden={track.hidden}
                  muted={track.muted}
                  solo={track.solo}
                  onLocked={(locked) => patchSequenceTrack(track.id, { locked })}
                  onHidden={track.kind === 'video' ? (hidden) => patchSequenceTrack(track.id, { hidden }) : undefined}
                  onMuted={track.kind === 'audio' ? (muted) => patchSequenceTrack(track.id, { muted }) : undefined}
                  onSolo={(solo) => patchSequenceTrack(track.id, { solo })}
                  playheadPosition={position(playhead)}
                  cursor={activeCursor}
                  onPointerDown={handleTimelinePointer}
                  onDragOver={(event) => handleTimelineDragOver(event, track.id)}
                  onDrop={(event) => handleSequenceDrop(event, track)}
                  timelineTrackId={track.id}
                  selectionTrackId={track.id}
                  dropIndicatorPosition={dropIndicator?.trackId === track.id ? position(dropIndicator.time) : undefined}
                >
                  {renderSequenceClips(track)}
                </TimelineTrackRow>
              ))}
            </>
          )}
          {marquee && (
            <div
              className="pointer-events-none absolute z-50 border border-sky-200 bg-sky-400/15 shadow-[0_0_0_1px_rgba(14,165,233,0.35),0_0_18px_rgba(14,165,233,0.18)]"
              style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
              aria-hidden="true"
            >
              {marquee.width > 54 && marquee.height > 20 && (
                <span className="absolute -top-5 left-0 rounded-sm bg-sky-500 px-1.5 py-0.5 font-mono text-[7px] font-semibold text-white shadow">
                  {marquee.count} selected
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex h-5 shrink-0 items-center gap-3 border-t border-black bg-[#181818] px-2 font-mono text-[7px] text-slate-650">
        <span className="text-sky-300">{TIMELINE_TOOLS.find((tool) => tool.id === activeTool)?.label}</span>
        <span>In {formatTimecode(manualStart)}</span>
        <span>Out {formatTimecode(manualEnd)}</span>
        <span className="text-red-300/70">{cuts.filter((cut) => cut.enabled).length} removals</span>
        <span>{creative.editPoints.length} blades</span>
        {selectedTimelineItemKeys.length > 0 && <span className="text-sky-300">{selectedTimelineItemKeys.length} selected</span>}
        <span className="ml-auto hidden text-slate-700 lg:inline">Drag empty space to marquee · Shift adds · Delete removes</span>
        <span>Snap {snapEnabled ? 'on' : 'off'}</span>
      </div>
    </section>
  );
}

function TimelinePlayhead({ position, needle = false }: { position: string; needle?: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-sky-100 shadow-[0_0_0_1px_rgba(2,132,199,0.35)]" style={{ left: position }}>
      {needle && <span className="absolute -left-1.5 top-0 h-0 w-0 border-x-[6px] border-t-[7px] border-x-transparent border-t-sky-100" />}
    </div>
  );
}

function TimelineTrackRow({
  trackId,
  name,
  kind,
  accent,
  locked = false,
  hidden = false,
  muted = false,
  solo = false,
  onLocked,
  onHidden,
  onMuted,
  onSolo,
  playheadPosition,
  cursor,
  onPointerDown,
  onDragOver,
  onDrop,
  timelineTrackId,
  selectionTrackId,
  dropIndicatorPosition,
  dataEditTimeline = false,
  children,
}: {
  trackId: string;
  name: string;
  kind: 'video' | 'audio' | 'caption';
  accent: 'blue' | 'sky' | 'violet' | 'pink' | 'green';
  locked?: boolean;
  hidden?: boolean;
  muted?: boolean;
  solo?: boolean;
  onLocked?: (locked: boolean) => void;
  onHidden?: (hidden: boolean) => void;
  onMuted?: (muted: boolean) => void;
  onSolo?: (solo: boolean) => void;
  playheadPosition: string;
  cursor: string;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
  timelineTrackId?: string;
  selectionTrackId?: string;
  dropIndicatorPosition?: string;
  dataEditTimeline?: boolean;
  children: React.ReactNode;
}) {
  const targetClass = accent === 'violet'
    ? 'border-violet-400/50 bg-violet-500/10 text-violet-200'
    : accent === 'pink'
      ? 'border-fuchsia-400/50 bg-fuchsia-500/10 text-fuchsia-200'
      : accent === 'green'
        ? 'border-emerald-400/50 bg-emerald-500/10 text-emerald-200'
        : 'border-sky-400/50 bg-sky-500/10 text-sky-200';
  return (
    <div className={clsx('grid h-9 grid-cols-[116px_minmax(0,1fr)] border-b border-black', hidden && 'opacity-45')}>
      <div className="sticky left-0 z-30 flex min-w-0 items-center border-r border-black bg-[#202020]">
        <button className={clsx('ml-1 grid h-6 w-7 shrink-0 place-items-center border text-[8px] font-bold', targetClass)} title={`Target ${trackId}`}>{trackId}</button>
        <span className="min-w-0 flex-1 truncate px-1.5 text-[8px] font-medium text-slate-500" title={name}>{name}</span>
        <div className="flex shrink-0 items-center pr-1">
          {onLocked && <button className={clsx('grid h-6 w-5 place-items-center', locked ? 'text-amber-300' : 'text-slate-700 hover:text-slate-300')} onClick={() => onLocked(!locked)} title={locked ? 'Unlock track' : 'Lock track'}><Lock className="h-2.5 w-2.5" /></button>}
          {onHidden && <button className={clsx('grid h-6 w-5 place-items-center', hidden ? 'text-red-300' : 'text-slate-700 hover:text-slate-300')} onClick={() => onHidden(!hidden)} title={hidden ? 'Show track output' : 'Hide track output'}>{hidden ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}</button>}
          {onMuted && <button className={clsx('grid h-6 w-5 place-items-center text-[8px] font-bold', muted ? 'text-red-300' : 'text-slate-700 hover:text-slate-300')} onClick={() => onMuted(!muted)} title={muted ? 'Unmute track' : 'Mute track'}>M</button>}
          {onSolo && <button className={clsx('grid h-6 w-5 place-items-center text-[8px] font-bold', solo ? 'text-amber-200' : 'text-slate-700 hover:text-slate-300')} onClick={() => onSolo(!solo)} title="Solo track">S</button>}
          {!onHidden && !onMuted && kind !== 'caption' && <span className="grid h-6 w-5 place-items-center text-slate-800">{kind === 'audio' ? <VolumeX className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}</span>}
        </div>
      </div>
      <div
        className={clsx('relative select-none overflow-hidden bg-[#151515] [background-image:linear-gradient(to_right,rgba(255,255,255,0.025)_1px,transparent_1px)] [background-size:5%_100%]', cursor)}
        onPointerDown={onPointerDown}
        onDragOver={onDragOver}
        onDrop={onDrop}
        data-timeline-track-lane={timelineTrackId}
        data-timeline-selection-track={selectionTrackId || timelineTrackId || trackId}
        data-edit-timeline={dataEditTimeline ? '' : undefined}
      >
        {children}
        {dropIndicatorPosition && (
          <span
            className="pointer-events-none absolute inset-y-0 z-30 w-px bg-sky-100 shadow-[0_0_5px_rgba(125,211,252,0.9)]"
            style={{ left: dropIndicatorPosition }}
          />
        )}
        <TimelinePlayhead position={playheadPosition} />
      </div>
    </div>
  );
}

function ManualCutPanel({ playhead, start, end, min, max, onStartChange, onEndChange, onMarkStart, onMarkEnd, onAdd }: {
  playhead: number;
  start: number;
  end: number;
  min: number;
  max: number;
  onStartChange: (value: number) => void;
  onEndChange: (value: number) => void;
  onMarkStart: () => void;
  onMarkEnd: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="panel-elev p-4 sm:p-5">
      <div className="flex min-w-0 flex-col gap-4 2xl:flex-row 2xl:items-end">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-white">Manual removal</div>
          <div className="mt-1 text-xs text-slate-500">Place the playhead, mark both boundaries, then add the range to the cut list.</div>
        </div>
        <div className="grid w-full min-w-0 grid-cols-2 gap-2 sm:grid-cols-[minmax(105px,1fr)_auto_minmax(105px,1fr)_auto] 2xl:w-[520px]">
          <NumberField label="Cut start" value={start} min={min} max={max} step={0.01} onChange={onStartChange} />
          <button className="btn-secondary self-end px-3 text-xs" onClick={onMarkStart} title={`Use playhead ${playhead.toFixed(2)}s`}>Mark in</button>
          <NumberField label="Cut end" value={end} min={min} max={max} step={0.01} onChange={onEndChange} />
          <button className="btn-secondary self-end px-3 text-xs" onClick={onMarkEnd} title={`Use playhead ${playhead.toFixed(2)}s`}>Mark out</button>
        </div>
        <button className="btn-primary w-full shrink-0 sm:w-auto" disabled={end - start < 0.02} onClick={onAdd}>
          <Plus className="h-4 w-4" /> Add cut
        </button>
      </div>
    </div>
  );
}

function CutRow({ cut, index, onToggle, onPlay, onDelete, onBoundsChange }: {
  cut: LongformCut;
  index: number;
  onToggle: () => void;
  onPlay: () => void;
  onDelete: () => void;
  onBoundsChange: (start: number, end: number) => boolean;
}) {
  const [draftStart, setDraftStart] = useState(String(Number(cut.start.toFixed(3))));
  const [draftEnd, setDraftEnd] = useState(String(Number(cut.end.toFixed(3))));
  useEffect(() => {
    setDraftStart(String(Number(cut.start.toFixed(3))));
    setDraftEnd(String(Number(cut.end.toFixed(3))));
  }, [cut.start, cut.end]);
  const commitBounds = () => {
    const nextStart = numberValue(draftStart, cut.start);
    const nextEnd = numberValue(draftEnd, cut.end);
    if (!onBoundsChange(nextStart, nextEnd)) {
      setDraftStart(String(Number(cut.start.toFixed(3))));
      setDraftEnd(String(Number(cut.end.toFixed(3))));
    }
  };
  const kind = cut.id.startsWith('manual-') ? 'Manual cut' : cut.id.startsWith('filler-') ? 'Filler cut' : `Silence ${index + 1}`;
  return (
    <div className={clsx('grid min-w-0 gap-3 px-4 py-3 transition lg:grid-cols-[auto_minmax(115px,1fr)_minmax(190px,0.8fr)_auto_auto]', !cut.enabled && 'opacity-55')}>
      <button className="grid h-8 w-8 place-items-center rounded-lg bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white" onClick={onPlay} title="Audition this edit">
        <Play className="h-3.5 w-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-slate-200">{kind}</div>
        <div className="mt-0.5 font-mono text-[10px] text-slate-500">{formatTime(cut.start)} — {formatTime(cut.end)} · {cut.duration.toFixed(2)} sec</div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="sr-only">Cut start in seconds</span>
          <input className="input h-8 px-2 font-mono text-[11px]" type="number" min="0" step="0.01" value={draftStart} onChange={(event) => setDraftStart(event.target.value)} onBlur={commitBounds} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
        </label>
        <label>
          <span className="sr-only">Cut end in seconds</span>
          <input className="input h-8 px-2 font-mono text-[11px]" type="number" min="0" step="0.01" value={draftEnd} onChange={(event) => setDraftEnd(event.target.value)} onBlur={commitBounds} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
        </label>
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-[11px] font-semibold text-slate-400">
        <span>{cut.enabled ? 'Cut' : 'Keep'}</span>
        <input type="checkbox" checked={cut.enabled} onChange={onToggle} className="h-4 w-4 accent-pink-500" />
      </label>
      <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-600 transition hover:bg-red-500/10 hover:text-red-300" onClick={onDelete} title="Delete cut" aria-label={`Delete ${kind}`}>
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function TranscriptPanel({ wordsAvailable, words, chunks, suggestions, cuts, dismissed, playhead, search, selectedWordRange, onSearch, onSeek, onWordSelect, onCutSelection, onAccept, onDismiss }: {
  wordsAvailable: boolean;
  words: TranscriptWord[];
  chunks: TranscriptChunk[];
  suggestions: FillerSuggestion[];
  cuts: LongformCut[];
  dismissed: Set<string>;
  playhead: number;
  search: string;
  selectedWordRange: [number, number] | null;
  onSearch: (value: string) => void;
  onSeek: (seconds: number, autoplay?: boolean) => void;
  onWordSelect: (index: number, extend: boolean) => void;
  onCutSelection: () => void;
  onAccept: (suggestion: FillerSuggestion) => boolean;
  onDismiss: (id: string) => void;
}) {
  const reviewable = suggestions.filter((suggestion) => !dismissed.has(suggestion.id) && !cutsOverlap(suggestion.start, suggestion.end, cuts));
  return (
    <div className="panel-elev overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-white/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-white">Transcript editor</div>
          <div className="text-xs text-slate-500">Click a word, then Shift-click to select a range for ripple removal. Double-click a word to play.</div>
        </div>
        {wordsAvailable && (
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            {selectedWordRange && (
              <button className="btn-secondary h-9 shrink-0 text-[10px]" onClick={onCutSelection}>
                <Scissors className="h-3.5 w-3.5" /> Cut selected words
              </button>
            )}
            <label className="relative block min-w-0 sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-600" />
              <input className="input h-9 pl-8 text-xs" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search transcript" />
            </label>
          </div>
        )}
      </div>
      {!wordsAvailable ? (
        <div className="grid place-items-center gap-2 px-5 py-12 text-center text-sm text-slate-500">
          <Volume2 className="h-5 w-5" />
          <div>
            <div className="font-semibold text-slate-400">Transcript unavailable for this project</div>
            <div className="mt-1 text-xs text-slate-600">New transcribed long-form projects can expose timed words here.</div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,0.55fr)]">
          <div className="max-h-[430px] overflow-y-auto border-b border-white/5 p-3 scrollbar-thin lg:border-b-0 lg:border-r">
            {chunks.length ? (
              <div className="space-y-1">
                {chunks.map((chunk) => {
                  const active = playhead >= chunk.start && playhead <= chunk.end;
                  return (
                    <div
                      key={chunk.id}
                      className={clsx(
                        'block w-full min-w-0 break-words rounded-lg px-3 py-2 text-left text-xs leading-relaxed transition [overflow-wrap:anywhere]',
                        active ? 'bg-brand-500/15 text-white ring-1 ring-inset ring-brand-500/25' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                      )}
                    >
                      <button className="mr-2 font-mono text-[9px] text-slate-600 hover:text-slate-300" onClick={() => onSeek(chunk.start)} title="Seek to passage">{formatTime(chunk.start)}</button>
                      {words.slice(chunk.startIndex, chunk.endIndex + 1).map((word, offset) => {
                        const wordIndex = chunk.startIndex + offset;
                        const selected = Boolean(selectedWordRange && wordIndex >= selectedWordRange[0] && wordIndex <= selectedWordRange[1]);
                        return (
                          <span key={`${word.start}-${wordIndex}`}>
                            <button
                              type="button"
                              className={clsx(
                                'rounded-sm px-0.5 text-left transition',
                                selected ? 'bg-red-500/25 text-red-100 ring-1 ring-inset ring-red-400/25' : 'hover:bg-white/10 hover:text-white',
                              )}
                              onClick={(event) => onWordSelect(wordIndex, event.shiftKey)}
                              onDoubleClick={() => onSeek(word.start, true)}
                              title="Click to start a text selection; Shift-click to extend"
                            >
                              {word.word}
                            </button>{' '}
                          </span>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="grid h-36 place-items-center text-sm text-slate-600">No passages match “{search}”.</div>
            )}
          </div>
          <div className="max-h-[430px] overflow-y-auto scrollbar-thin">
            <div className="sticky top-0 border-b border-white/5 bg-slate-950/95 px-4 py-3 backdrop-blur">
              <div className="text-xs font-semibold text-slate-200">Filler review</div>
              <div className="mt-0.5 text-[10px] text-slate-600">{reviewable.length} conservative suggestion{reviewable.length === 1 ? '' : 's'}</div>
            </div>
            {reviewable.length ? reviewable.slice(0, 80).map((suggestion) => (
              <div key={suggestion.id} className="border-b border-white/5 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <button className="min-w-0 text-left" onClick={() => onSeek(suggestion.start, true)}>
                    <span className="block break-words text-xs font-semibold text-amber-200 [overflow-wrap:anywhere]">{suggestion.label}</span>
                    <span className="mt-1 block break-words line-clamp-2 text-[10px] leading-relaxed text-slate-500 [overflow-wrap:anywhere]">…{suggestion.context}…</span>
                  </button>
                  <button className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-600 hover:bg-white/5 hover:text-slate-300" onClick={() => onDismiss(suggestion.id)} title="Dismiss suggestion" aria-label="Dismiss filler suggestion">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <button className="btn-secondary mt-2 h-7 w-full text-[10px]" onClick={() => onAccept(suggestion)}>
                  <Scissors className="h-3 w-3" /> Add {Math.max(0, suggestion.end - suggestion.start).toFixed(2)}s cut
                </button>
              </div>
            )) : (
              <div className="grid h-36 place-items-center px-4 text-center text-xs leading-relaxed text-slate-600">No unreviewed filler suggestions remain.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CreativePanel({ creative, assets, playhead, min, max, transitionJoins, uploading, uploadError, onCreativeChange, onSeek, onTransitionChange, onAudioOffsetChange, onApplyTransitionToAll, onAddTitle, onUpdateTitle, onDeleteTitle, onUpload, onUpdateBroll, onDeleteBroll }: {
  creative: LongformCreativeOptions;
  assets: LongformMediaAsset[];
  playhead: number;
  min: number;
  max: number;
  transitionJoins: TransitionJoin[];
  uploading: boolean;
  uploadError: Error | null;
  onCreativeChange: (patch: Partial<LongformCreativeOptions>) => void;
  onSeek: (seconds: number) => void;
  onTransitionChange: (cutId: string, type: LongformTransitionType, duration?: number) => void;
  onAudioOffsetChange: (cutId: string, offset: number) => void;
  onApplyTransitionToAll: (type: LongformTransitionType) => void;
  onAddTitle: (position: 'playhead' | 'intro' | 'outro') => void;
  onUpdateTitle: (id: string, patch: Partial<LongformCreativeOptions['titles'][number]>) => void;
  onDeleteTitle: (id: string) => void;
  onUpload: (kind: 'broll' | 'music', file: File) => void;
  onUpdateBroll: (id: string, patch: Partial<LongformCreativeOptions['broll'][number]>) => void;
  onDeleteBroll: (id: string) => void;
}) {
  const brollAssets = assets.filter((asset) => asset.kind === 'broll');
  const musicAssets = assets.filter((asset) => asset.kind === 'music');
  const transitionByCut = new Map(creative.transitions.map((transition) => [transition.cutId, transition]));
  const patchColor = (key: keyof LongformCreativeOptions['color'], value: number) => {
    onCreativeChange({ color: { ...creative.color, [key]: value } });
  };
  return (
    <div className="panel-elev overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-white/5 px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-5">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-white"><Film className="h-4 w-4 text-brand-300" /> Professional finishing</div>
          <div className="mt-1 text-xs text-slate-500">Build transitions, branded graphics, color, cutaways, and a polished audio bed.</div>
        </div>
        <label className="block min-w-0 sm:w-56">
          <span className="label">Export preset</span>
          <select className="input h-9 text-xs" value={creative.exportPreset} onChange={(event) => onCreativeChange({ exportPreset: event.target.value as LongformCreativeOptions['exportPreset'] })}>
            <option value="source">Source resolution</option>
            <option value="youtube_1080p">YouTube 1080p</option>
            <option value="youtube_4k">YouTube 4K</option>
            <option value="podcast">Podcast 1080p</option>
          </select>
        </label>
      </div>

      <section className="border-b border-white/5 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <FastForward className="h-3.5 w-3.5 text-amber-300" /> Transitions
            </div>
            <div className="mt-1 text-[10px] text-slate-600">Attach a true video transition and matching audio crossfade to any active edit join.</div>
          </div>
          <div className="flex flex-wrap gap-1">
            <button className="btn-secondary h-8 px-2 text-[10px]" disabled={!transitionJoins.length} onClick={() => onApplyTransitionToAll('cut')}>All clean cuts</button>
            <button className="btn-secondary h-8 px-2 text-[10px]" disabled={!transitionJoins.length} onClick={() => onApplyTransitionToAll('dissolve')}>Dissolve all</button>
          </div>
        </div>
        {transitionJoins.length ? (
          <div className="mt-3 max-h-[360px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
            {transitionJoins.map((join) => {
              const transition = transitionByCut.get(join.cutId) || {
                id: `preview-${join.cutId}`,
                cutId: join.cutId,
                type: 'cut' as const,
                duration: 0,
                audioOffsetSec: 0,
              };
              return (
                <div key={join.cutId} className="grid min-w-0 gap-2 rounded-xl border border-white/5 bg-black/20 p-3 sm:grid-cols-[auto_minmax(110px,0.65fr)_minmax(145px,1fr)_95px_105px] sm:items-end">
                  <button className="grid h-9 w-9 place-items-center rounded-lg bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => onSeek(join.sourceTime)} title="Audition this join">
                    <Play className="h-3.5 w-3.5" />
                  </button>
                  <div className="min-w-0 self-center">
                    <div className="truncate text-xs font-semibold text-slate-200">{join.kind === 'blade' ? 'Blade' : 'Join'} {join.joinIndex + 1}</div>
                    <div className="font-mono text-[9px] text-slate-600">{formatTime(join.gapStart)} → {formatTime(join.gapEnd)}</div>
                  </div>
                  <label>
                    <span className="label">Transition</span>
                    <select
                      className="input h-9 text-xs"
                      value={transition.type}
                      disabled={join.maxDuration < 0.08}
                      onChange={(event) => onTransitionChange(join.cutId, event.target.value as LongformTransitionType, transition.duration)}
                    >
                      {TRANSITION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <label className={clsx(transition.type === 'cut' && 'opacity-40')}>
                    <span className="label">Duration</span>
                    <div className="relative">
                      <input
                        className="input h-9 pr-8 font-mono text-xs"
                        type="number"
                        min={0.08}
                        max={Math.max(0.08, join.maxDuration)}
                        step={0.05}
                        disabled={transition.type === 'cut' || join.maxDuration < 0.08}
                        value={transition.type === 'cut' ? 0 : transition.duration}
                        onChange={(event) => onTransitionChange(join.cutId, transition.type, Number(event.target.value))}
                      />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-slate-600">sec</span>
                    </div>
                  </label>
                  <label>
                    <span className="label">J/L audio</span>
                    <div className="relative">
                      <input
                        className="input h-9 pr-7 font-mono text-xs"
                        type="number"
                        min={-Math.max(0.05, join.maxDuration)}
                        max={Math.max(0.05, join.maxDuration)}
                        step={0.05}
                        value={transition.audioOffsetSec || 0}
                        onChange={(event) => onAudioOffsetChange(join.cutId, Number(event.target.value))}
                        title="Negative starts the incoming audio early (J-cut); positive lets outgoing audio continue (L-cut)"
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-slate-600">sec</span>
                    </div>
                  </label>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-3 rounded-xl border border-dashed border-white/5 px-4 py-7 text-center text-xs text-slate-600">
            Add or analyze at least one interior cut to create a transition join.
          </div>
        )}
      </section>

      <section className="border-b border-white/5 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-semibold text-slate-200">Titles, lower thirds, and cards</div>
            <div className="mt-0.5 text-[10px] text-slate-600">Current playhead: {formatTime(playhead)} · graphics preview directly over the player.</div>
          </div>
          <div className="flex flex-wrap gap-1">
            <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => onAddTitle('intro')}>Intro card</button>
            <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => onAddTitle('playhead')}>Lower third</button>
            <button className="btn-secondary h-8 px-2 text-[10px]" onClick={() => onAddTitle('outro')}>Outro card</button>
          </div>
        </div>
        <div className="mt-3 space-y-3">
          {creative.titles.map((title, index) => (
            <div key={title.id} className="rounded-xl border border-white/5 bg-black/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <button className="min-w-0 text-left" onClick={() => onSeek(title.start)}>
                  <span className="block truncate text-xs font-semibold text-slate-200">{title.text || `Graphic ${index + 1}`}</span>
                  <span className="mt-0.5 block font-mono text-[9px] text-slate-600">{formatTime(title.start)} — {formatTime(title.end)}</span>
                </button>
                <button className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-600 hover:bg-red-500/10 hover:text-red-300" onClick={() => onDeleteTitle(title.id)} aria-label="Delete title"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
              <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
                <label>
                  <span className="label">Primary text</span>
                  <input className="input h-9 min-w-0 text-xs" value={title.text} maxLength={160} onChange={(event) => onUpdateTitle(title.id, { text: event.target.value })} />
                </label>
                <label>
                  <span className="label">Secondary text</span>
                  <input className="input h-9 min-w-0 text-xs" value={title.subtitle} maxLength={180} placeholder="Role, topic, or context" onChange={(event) => onUpdateTitle(title.id, { subtitle: event.target.value })} />
                </label>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <label>
                  <span className="label">Graphic type</span>
                  <select className="input h-9 text-xs" value={title.style} onChange={(event) => onUpdateTitle(title.id, { style: event.target.value as typeof title.style })}>
                    <option value="lower_third">Lower third</option>
                    <option value="center_card">Center card</option>
                  </select>
                </label>
                <label>
                  <span className="label">Template</span>
                  <select className="input h-9 text-xs" value={title.template} onChange={(event) => onUpdateTitle(title.id, { template: event.target.value as typeof title.template })}>
                    <option value="minimal">Minimal line</option>
                    <option value="broadcast">Broadcast bar</option>
                    <option value="glass">Wide glass</option>
                  </select>
                </label>
                <label>
                  <span className="label">Alignment</span>
                  <select className="input h-9 text-xs" value={title.alignment} onChange={(event) => onUpdateTitle(title.id, { alignment: event.target.value as typeof title.alignment })}>
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                  </select>
                </label>
                <label>
                  <span className="label">Entrance</span>
                  <select className="input h-9 text-xs" value={title.animation} onChange={(event) => onUpdateTitle(title.id, { animation: event.target.value as typeof title.animation })}>
                    <option value="none">None</option>
                    <option value="fade">Fade</option>
                    <option value="slide">Slide</option>
                  </select>
                </label>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[110px_110px_repeat(3,minmax(95px,1fr))]">
                <label>
                  <span className="label">Start</span>
                  <input className="input h-9 px-2 font-mono text-[10px]" type="number" min={min} max={title.end - 0.2} step={0.1} value={title.start} onChange={(event) => onUpdateTitle(title.id, { start: Math.max(min, Math.min(title.end - 0.2, Number(event.target.value))) })} />
                </label>
                <label>
                  <span className="label">End</span>
                  <input className="input h-9 px-2 font-mono text-[10px]" type="number" min={title.start + 0.2} max={max} step={0.1} value={title.end} onChange={(event) => onUpdateTitle(title.id, { end: Math.min(max, Math.max(title.start + 0.2, Number(event.target.value))) })} />
                </label>
                <ColorField label="Accent" value={title.accentColor} onChange={(value) => onUpdateTitle(title.id, { accentColor: value })} />
                <ColorField label="Background" value={title.backgroundColor} onChange={(value) => onUpdateTitle(title.id, { backgroundColor: value })} />
                <ColorField label="Text" value={title.textColor} onChange={(value) => onUpdateTitle(title.id, { textColor: value })} />
              </div>
            </div>
          ))}
          {!creative.titles.length && <div className="rounded-xl border border-dashed border-white/5 px-3 py-8 text-center text-xs text-slate-600">No graphics yet. Add a clean lower third at the playhead or create an intro card.</div>}
        </div>
      </section>

      <div className="grid min-w-0 divide-y divide-white/5 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
        <section className="min-w-0 space-y-5 p-4 sm:p-5">
          <div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-slate-200">Master color</div>
                <div className="mt-0.5 text-[10px] text-slate-600">Non-destructive finishing applied after B-roll and before graphics.</div>
              </div>
              <button className="btn-ghost h-8 px-2 text-[10px]" onClick={() => onCreativeChange({ color: { ...DEFAULT_CREATIVE.color } })}>Reset</button>
            </div>
            <div className="mt-4 space-y-4">
              <RangeField label="Exposure" value={creative.color.exposure} min={-0.3} max={0.3} step={0.01} suffix="" onChange={(value) => patchColor('exposure', value)} />
              <RangeField label="Contrast" value={creative.color.contrast} min={0.5} max={1.5} step={0.01} suffix="" onChange={(value) => patchColor('contrast', value)} />
              <RangeField label="Saturation" value={creative.color.saturation} min={0} max={2} step={0.01} suffix="" onChange={(value) => patchColor('saturation', value)} />
              <RangeField label="Temperature" value={creative.color.temperature} min={-1} max={1} step={0.05} suffix="" detail="Negative cools the image; positive warms it." onChange={(value) => patchColor('temperature', value)} />
              <RangeField label="Tint" value={creative.color.tint} min={-1} max={1} step={0.05} suffix="" detail="Balance green against magenta." onChange={(value) => patchColor('tint', value)} />
              <RangeField label="Sharpen" value={creative.color.sharpen} min={0} max={1.5} step={0.05} suffix="" onChange={(value) => patchColor('sharpen', value)} />
            </div>
          </div>
        </section>

        <section className="min-w-0 space-y-5 p-4 sm:p-5">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-slate-200">B-roll cutaways</div>
                <div className="mt-0.5 text-[10px] text-slate-600">Uploaded clips cover the program while original audio continues.</div>
              </div>
              <label className="btn-secondary h-8 cursor-pointer px-2 text-[10px]">
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />} Upload B-roll
                <input className="hidden" type="file" accept="video/*" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload('broll', file); event.currentTarget.value = ''; }} />
              </label>
            </div>
            <div className="mt-3 space-y-2">
              {creative.broll.map((item) => (
                <div key={item.id} className="grid min-w-0 gap-2 rounded-lg bg-black/20 p-2 sm:grid-cols-[minmax(0,1fr)_80px_80px_auto]">
                  <select className="input h-8 min-w-0 text-xs" value={item.assetId} onChange={(event) => onUpdateBroll(item.id, { assetId: event.target.value })}>
                    {brollAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                  </select>
                  <input className="input h-8 px-2 font-mono text-[10px]" type="number" min={min} max={item.end - 0.2} step={0.1} value={item.start} onChange={(event) => onUpdateBroll(item.id, { start: Number(event.target.value) })} aria-label="B-roll start" />
                  <input className="input h-8 px-2 font-mono text-[10px]" type="number" min={item.start + 0.2} max={max} step={0.1} value={item.end} onChange={(event) => onUpdateBroll(item.id, { end: Number(event.target.value) })} aria-label="B-roll end" />
                  <button className="grid h-8 w-8 place-items-center rounded-md text-slate-600 hover:bg-red-500/10 hover:text-red-300" onClick={() => onDeleteBroll(item.id)} aria-label="Delete B-roll"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              ))}
              {!creative.broll.length && <div className="rounded-lg border border-dashed border-white/5 px-3 py-5 text-center text-[10px] text-slate-600">Upload a clip to place it on the B-roll track.</div>}
            </div>
          </div>

          <div className="border-t border-white/5 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-slate-200">Background music</div>
                <div className="mt-0.5 text-[10px] text-slate-600">Voice-triggered ducking keeps speech clear.</div>
              </div>
              <label className="btn-secondary h-8 cursor-pointer px-2 text-[10px]">
                <Volume2 className="h-3.5 w-3.5" /> Upload music
                <input className="hidden" type="file" accept="audio/*" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload('music', file); event.currentTarget.value = ''; }} />
              </label>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
              <select className="input h-9 text-xs" value={creative.musicAssetId || ''} onChange={(event) => onCreativeChange({ musicAssetId: event.target.value || null })}>
                <option value="">No music</option>
                {musicAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select>
              <label>
                <span className="label">Music {Math.round(creative.musicVolume * 100)}%</span>
                <input className="w-full accent-emerald-500" type="range" min={0.02} max={0.5} step={0.01} value={creative.musicVolume} onChange={(event) => onCreativeChange({ musicVolume: Number(event.target.value) })} />
              </label>
            </div>
            <label className="mt-3 flex items-center gap-2 text-[11px] text-slate-400">
              <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={creative.musicDucking} onChange={(event) => onCreativeChange({ musicDucking: event.target.checked })} /> Duck music while people speak
            </label>
          </div>
          {uploadError && <div className="text-xs text-red-300">Asset upload failed: {uploadError.message}</div>}
        </section>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span className="label">{label}</span>
      <span className="flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2">
        <input className="h-5 w-7 cursor-pointer border-0 bg-transparent p-0" type="color" value={value} onChange={(event) => onChange(event.target.value.toUpperCase())} />
        <span className="truncate font-mono text-[9px] text-slate-500">{value}</span>
      </span>
    </label>
  );
}

function motionValue(
  overlay: LongformCreativeOptions['broll'][number],
  playhead: number,
  field: 'x' | 'y' | 'scale' | 'rotation' | 'opacity',
) {
  const points = overlay.keyframes
    .map((keyframe) => ({ time: keyframe.time, value: keyframe[field] }))
    .sort((left, right) => left.time - right.time);
  if (!points.length) return overlay[field];
  if (playhead <= points[0].time) return points[0].value;
  if (playhead >= points[points.length - 1].time) return points[points.length - 1].value;
  const nextIndex = points.findIndex((point) => point.time >= playhead);
  const previous = points[Math.max(0, nextIndex - 1)];
  const next = points[nextIndex];
  const ratio = (playhead - previous.time) / Math.max(0.001, next.time - previous.time);
  return previous.value + (next.value - previous.value) * ratio;
}

function MediaPreviewOverlay({
  asset,
  start,
  sourceOffset,
  playhead,
  overlay,
  className,
}: {
  asset: LongformMediaAsset;
  start: number;
  sourceOffset: number;
  playhead: number;
  overlay?: LongformCreativeOptions['broll'][number];
  className?: string;
}) {
  const previewRef = useRef<HTMLVideoElement>(null);
  const desiredTime = Math.max(0, sourceOffset + playhead - start);
  useEffect(() => {
    const video = previewRef.current;
    if (!video || video.readyState < 1 || Math.abs(video.currentTime - desiredTime) < 0.18) return;
    video.currentTime = Math.min(desiredTime, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.02) : desiredTime);
  }, [desiredTime]);
  const x = overlay ? motionValue(overlay, playhead, 'x') : 0;
  const y = overlay ? motionValue(overlay, playhead, 'y') : 0;
  const scale = overlay ? motionValue(overlay, playhead, 'scale') : 1;
  const rotation = overlay ? motionValue(overlay, playhead, 'rotation') : 0;
  const opacity = overlay ? motionValue(overlay, playhead, 'opacity') : 1;
  const pip = overlay?.layout === 'pip';
  return (
    <video
      ref={previewRef}
      src={asset.url}
      muted
      autoPlay
      loop
      playsInline
      className={clsx(
        'pointer-events-none',
        pip ? 'absolute left-1/2 top-1/2 h-auto w-[38%] -translate-x-1/2 -translate-y-1/2 object-contain' : className,
      )}
      style={overlay ? {
        objectFit: overlay.layout === 'contain' ? 'contain' : 'cover',
        opacity,
        transform: pip
          ? `translate(calc(-50% + ${x * 50}vw), calc(-50% + ${y * 28}vh)) scale(${scale}) rotate(${rotation}deg)`
          : `translate(${x * 50}%, ${y * 50}%) scale(${scale}) rotate(${rotation}deg)`,
        clipPath: `inset(${overlay.cropTop * 100}% ${overlay.cropRight * 100}% ${overlay.cropBottom * 100}% ${overlay.cropLeft * 100}%)`,
      } : undefined}
      onLoadedMetadata={(event) => {
        event.currentTarget.currentTime = Math.min(desiredTime, Math.max(0, event.currentTarget.duration - 0.02));
      }}
    />
  );
}

function CaptionPreviewOverlay({
  cue,
  options,
}: {
  cue: LongformCreativeOptions['captions']['cues'][number];
  options: LongformCreativeOptions['captions'];
}) {
  const position = options.position === 'top'
    ? 'top-[8%]'
    : options.position === 'center'
      ? 'top-1/2 -translate-y-1/2'
      : 'bottom-[8%]';
  return (
    <div className={clsx('pointer-events-none absolute inset-x-[8%] z-30 flex justify-center text-center', position)}>
      <div
        className="max-w-[90%] rounded-md px-3 py-1.5 font-bold leading-tight shadow-lg"
        style={{
          color: options.textColor,
          backgroundColor: `${options.backgroundColor}D0`,
          fontSize: `clamp(14px, ${Math.max(18, options.fontSize) / 25}vw, 42px)`,
        }}
      >
        {cue.speaker && <span style={{ color: options.highlightColor }}>{cue.speaker}: </span>}
        {cue.text}
      </div>
    </div>
  );
}

function TitlePreviewOverlay({
  title,
  selected,
  frameWidth,
  frameHeight,
  onSelect,
  onChange,
}: {
  title: LongformCreativeOptions['titles'][number];
  selected: boolean;
  frameWidth: number;
  frameHeight: number;
  onSelect: () => void;
  onChange: (patch: Partial<LongformCreativeOptions['titles'][number]>) => void;
}) {
  type TransformDraft = Pick<LongformCreativeOptions['titles'][number], 'x' | 'y' | 'width' | 'scale'>;
  const [draft, setDraft] = useState<TransformDraft>({
    x: title.x,
    y: title.y,
    width: title.width,
    scale: title.scale,
  });
  useEffect(() => {
    setDraft({ x: title.x, y: title.y, width: title.width, scale: title.scale });
  }, [title.id, title.scale, title.width, title.x, title.y]);

  const beginTransform = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    const surface = event.currentTarget;
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-title-handle]');
    const mode = handle?.dataset.titleHandle || 'move';
    const pointerId = event.pointerId;
    const originX = event.clientX;
    const originY = event.clientY;
    const initial = { ...draft };
    let next = initial;
    let changed = false;
    surface.setPointerCapture(pointerId);
    const move = (moveEvent: PointerEvent) => {
      const deltaX = (moveEvent.clientX - originX) / Math.max(frameWidth, 1);
      const deltaY = (moveEvent.clientY - originY) / Math.max(frameHeight, 1);
      if (mode === 'width') {
        const maximumWidth = Math.max(0.12, (1 - initial.x) / Math.max(initial.scale, 0.4));
        next = {
          ...initial,
          width: clampValue(initial.width + deltaX / Math.max(initial.scale, 0.4), 0.12, Math.min(1, maximumWidth)),
        };
      } else if (mode === 'scale') {
        const scaleDelta = (deltaX + deltaY) * 1.35;
        const approximateHeight = title.style === 'center_card' ? 0.3 : 0.18;
        const maximumScale = Math.min(
          2.5,
          (1 - initial.x) / Math.max(initial.width, 0.12),
          (1 - initial.y) / approximateHeight,
        );
        next = { ...initial, scale: clampValue(initial.scale + scaleDelta, 0.4, Math.max(0.4, maximumScale)) };
      } else {
        const approximateHeight = title.style === 'center_card' ? 0.3 : 0.18;
        next = {
          ...initial,
          x: clampValue(initial.x + deltaX, 0, Math.max(0, 1 - initial.width * initial.scale)),
          y: clampValue(initial.y + deltaY, 0, Math.max(0, 1 - approximateHeight * initial.scale)),
        };
      }
      changed = true;
      setDraft(next);
    };
    const finish = () => {
      surface.removeEventListener('pointermove', move);
      surface.removeEventListener('pointerup', finish);
      surface.removeEventListener('pointercancel', finish);
      if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId);
      if (changed) onChange(next);
    };
    surface.addEventListener('pointermove', move);
    surface.addEventListener('pointerup', finish);
    surface.addEventListener('pointercancel', finish);
  };

  const textAlign = title.alignment === 'right' ? 'right' : title.alignment === 'center' ? 'center' : 'left';
  const alignItems = title.alignment === 'right' ? 'flex-end' : title.alignment === 'center' ? 'center' : 'flex-start';
  const primarySize = Math.max(10, frameHeight * (title.style === 'center_card' ? 0.072 : 0.044));
  const secondarySize = Math.max(8, frameHeight * (title.style === 'center_card' ? 0.032 : 0.022));
  const paddingX = Math.max(6, frameHeight * 0.026);
  const paddingY = Math.max(4, frameHeight * 0.018);
  const borderSize = Math.max(2, frameHeight * 0.006);
  const panelStyle: React.CSSProperties = title.style === 'center_card'
    ? {
        color: title.textColor,
        backgroundColor: `${title.backgroundColor}E6`,
        borderTop: `${borderSize}px solid ${title.accentColor}`,
        borderBottom: `${Math.max(1, borderSize / 2)}px solid ${title.accentColor}66`,
        padding: `${paddingY * 1.8}px ${paddingX * 1.4}px`,
        minHeight: frameHeight * 0.22,
        justifyContent: 'center',
      }
    : title.template === 'broadcast'
      ? {
          color: title.textColor,
          backgroundColor: `${title.backgroundColor}E0`,
          borderLeft: `${borderSize * 1.5}px solid ${title.accentColor}`,
          padding: `${paddingY}px ${paddingX}px`,
        }
      : title.template === 'glass'
        ? {
            color: title.textColor,
            backgroundColor: `${title.backgroundColor}A6`,
            borderTop: `${Math.max(1, borderSize / 2)}px solid ${title.accentColor}`,
            padding: `${paddingY}px ${paddingX}px`,
            backdropFilter: 'blur(8px)',
          }
        : {
            color: title.textColor,
            backgroundColor: 'transparent',
            borderBottom: `${Math.max(1, borderSize / 2)}px solid ${title.accentColor}`,
            padding: `0 ${Math.max(1, paddingX * 0.15)}px ${paddingY * 0.55}px`,
          };

  return (
    <div
      className={clsx(
        'pointer-events-auto absolute z-40 flex cursor-move select-none flex-col drop-shadow-2xl',
        selected && 'outline outline-1 outline-sky-300',
      )}
      data-title-overlay={title.id}
      data-title-selected={selected ? 'true' : 'false'}
      onPointerDown={beginTransform}
      style={{
        left: `${draft.x * 100}%`,
        top: `${draft.y * 100}%`,
        width: `${draft.width * 100}%`,
        transform: `scale(${draft.scale})`,
        transformOrigin: 'top left',
        touchAction: 'none',
        textAlign,
        alignItems,
        ...panelStyle,
      }}
      title="Drag to reposition. Drag the right handle to change width or the corner handle to scale."
    >
      <div className="w-full font-black leading-tight tracking-tight" style={{ fontSize: primarySize }}>{title.text}</div>
      {title.subtitle && (
        <div className="mt-[0.35em] w-full font-semibold tracking-wide opacity-80" style={{ fontSize: secondarySize }}>{title.subtitle}</div>
      )}
      {title.style === 'center_card' && (
        <div className="mt-[0.7em] h-[3px] w-[28%] max-w-28" style={{ backgroundColor: title.accentColor, alignSelf: alignItems }} />
      )}
      {selected && (
        <>
          <span className="pointer-events-none absolute -left-1 -top-1 h-2 w-2 border border-sky-100 bg-sky-500" />
          <span className="pointer-events-none absolute -bottom-1 -left-1 h-2 w-2 border border-sky-100 bg-sky-500" />
          <span
            className="absolute -right-1 top-1/2 h-3 w-2 -translate-y-1/2 cursor-ew-resize border border-sky-100 bg-sky-500"
            data-title-handle="width"
            title="Resize width"
          />
          <span
            className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize border border-sky-100 bg-sky-500"
            data-title-handle="scale"
            title="Scale graphic"
          />
          <span className="pointer-events-none absolute -top-5 left-0 rounded-sm bg-sky-500 px-1.5 py-0.5 text-[8px] font-semibold text-white shadow">Motion · drag to position</span>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent = 'text-white' }: { label: string; value: string; accent?: string }) {
  return (
    <div className="stat-card">
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</span>
      <span className={clsx('text-xl font-black tracking-tight', accent)}>{value}</span>
    </div>
  );
}

function ChapterPanel({ chapters, playhead, min, max, onAdd, onSeek, onUpdate, onDelete }: {
  chapters: LongformChapter[];
  playhead: number;
  min: number;
  max: number;
  onAdd: () => void;
  onSeek: (seconds: number) => void;
  onUpdate: (id: string, patch: Partial<Pick<LongformChapter, 'time' | 'title'>>) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="panel-elev overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-white/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <ListPlus className="h-4 w-4 text-brand-300" /> Chapter markers
          </div>
          <div className="mt-0.5 text-xs text-slate-500">Markers are remapped around cuts and exported as YouTube-ready timestamps.</div>
        </div>
        <button className="btn-secondary shrink-0 text-xs" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" /> Add at {formatTime(playhead)}
        </button>
      </div>
      {chapters.length === 0 ? (
        <div className="grid place-items-center gap-2 px-5 py-10 text-center text-sm text-slate-500">
          <ListPlus className="h-5 w-5" />
          Place the playhead at a topic change, then add a chapter.
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {chapters.map((chapter, index) => (
            <div key={chapter.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[auto_110px_minmax(0,1fr)_auto] sm:items-end">
              <button
                type="button"
                className="grid h-9 w-9 place-items-center self-end rounded-lg bg-white/5 text-slate-300 transition hover:bg-white/10 hover:text-white"
                onClick={() => onSeek(chapter.time)}
                title={`Seek to ${formatTime(chapter.time)}`}
              >
                <Play className="h-3.5 w-3.5" />
              </button>
              <NumberField
                label={`Chapter ${index + 1} time`}
                value={chapter.time}
                min={min}
                max={max}
                step={0.1}
                onChange={(time) => onUpdate(chapter.id, { time })}
              />
              <label>
                <span className="label">Title</span>
                <input
                  className="input"
                  value={chapter.title}
                  maxLength={160}
                  placeholder={`Chapter ${index + 1}`}
                  onChange={(event) => onUpdate(chapter.id, { title: event.target.value })}
                />
              </label>
              <button
                type="button"
                className="grid h-9 w-9 place-items-center self-end rounded-lg bg-red-500/10 text-red-300 transition hover:bg-red-500/20 hover:text-white"
                onClick={() => onDelete(chapter.id)}
                title="Delete chapter"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RangeField({ label, value, min, max, step, suffix, detail, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  detail?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold text-slate-300">
        <span>{label}</span>
        <span className="rounded-md bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-300 ring-1 ring-inset ring-white/5">{value}{suffix}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(numberValue(event.target.value, value))} className="w-full accent-pink-500" />
      {detail && <span className="mt-1.5 block text-[11px] leading-relaxed text-slate-600">{detail}</span>}
    </label>
  );
}

function ToggleField({ label, detail, checked, onChange }: { label: string; detail?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg bg-white/[0.025] p-3 ring-1 ring-inset ring-white/5">
      <span>
        <span className="block text-xs font-semibold text-slate-200">{label}</span>
        {detail && <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-600">{detail}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-pink-500" />
    </label>
  );
}

function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label>
      <span className="label">{label}</span>
      <input className="input font-mono text-xs" type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(numberValue(event.target.value, value))} />
    </label>
  );
}

function PageState({ icon, title, detail, action }: { icon: React.ReactNode; title: string; detail?: string; action?: React.ReactNode }) {
  return (
    <div className="grid min-h-[70vh] place-items-center px-5">
      <div className="panel-elev grid max-w-md place-items-center gap-3 p-8 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-white/5 text-slate-400">{icon}</div>
        <div className="text-lg font-bold text-white">{title}</div>
        {detail && <p className="text-sm leading-relaxed text-slate-500">{detail}</p>}
        {action}
      </div>
    </div>
  );
}
