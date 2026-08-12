// Typed API client wrapping all /api/* endpoints exposed by the existing
// Express server (dashboard/server.js). No backend changes required.

import type { RenderSettings } from '@/lib/render-options';

export interface ClipSummary {
  name: string;
  url: string;
  kind: 'shorts' | 'longform';
  score: number | string;
  candidateScore: number | null;
  reasons: string[];
  topics: string[];
  scoreBreakdown: Record<string, unknown> | null;
  rankingVersion: string | null;
  confidenceTier?: 'best' | 'strong' | 'review' | null;
  yieldRole?: string | null;
  yieldPlan?: { volume?: string; target?: number; soft_min?: number; active_speech_minutes?: number } | null;
  canGenerateMore?: boolean;
  remainingCandidates?: number;
  transcriptionProvider?: string | null;
  hasSubtitleData: boolean;
  baked: boolean;
  computeBackend?: string | null;
  videoEncoder?: string | null;
  exportPreset?: string | null;
  sourceKind?: 'single' | 'action_compilation' | string;
  compilationName?: string | null;
}

export type CompilationGoal = 'fast_action' | 'cosplay_showcase' | 'cinematic';
export type CompilationPacing = 'rapid' | 'fast' | 'balanced' | 'cinematic';
export type CompilationTransitionMode = 'auto' | 'minimal' | 'none';
export type CompilationFormat = 'vertical_short' | 'horizontal_longform';

export interface ActionCompilationOptions {
  name: string;
  format: CompilationFormat;
  goal: CompilationGoal;
  targetDurationSec: number;
  pacing: CompilationPacing;
  transitionMode: CompilationTransitionMode;
  selectionMode: 'best_moments' | 'use_every_clip';
  orderMode: 'ai' | 'manual';
}

export interface ActionCompilationQueued {
  status: 'queued';
  jobId: string;
  projectId: string;
  outputName: string;
  sourceCount: number;
  targetDurationSec: number;
  format: CompilationFormat;
}

export interface ActionCompilationUploadStorage {
  availableBytes: number | null;
  reserveBytes: number;
  usableBytes: number | null;
  ready: boolean;
  error: string | null;
}

export interface ActionCompilationUploadCapabilities {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  chunkSize: number;
  sessionTtlMs: number;
  storage: ActionCompilationUploadStorage;
}

export interface ActionCompilationUploadSource {
  sourceId: string;
  name: string;
  size: number;
  type: string;
  lastModified: number | null;
  receivedBytes: number;
  complete: boolean;
}

export interface ActionCompilationUploadSession {
  sessionId: string;
  fingerprint: string;
  status: string;
  chunkSize: number;
  totalBytes: number;
  receivedBytes: number;
  expiresAt: string;
  options: ActionCompilationOptions;
  files: ActionCompilationUploadSource[];
  duplicate?: boolean;
  finalized?: boolean;
}

export interface FinalizedActionCompilationUploadSession {
  sessionId: string;
  status: 'queued';
  finalized: true;
  result: ActionCompilationQueued;
}

export type ActionCompilationUploadSessionResponse =
  | ActionCompilationUploadSession
  | FinalizedActionCompilationUploadSession;

export interface ActionCompilationUploadFile {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface ActionCompilationUploadSessionRequest {
  sessionId?: string;
  fingerprint: string;
  options: ActionCompilationOptions;
  files: ActionCompilationUploadFile[];
}

export interface LongformCut {
  id: string;
  start: number;
  end: number;
  duration: number;
  enabled: boolean;
}

export interface LongformOptions {
  enabled: boolean;
  thresholdDb: number;
  minSilenceSec: number;
  paddingSec: number;
  audioFadeSec: number;
  videoFadeSec: number;
  normalizeAudio: boolean;
  targetLufs: number;
  limiterDb: number;
  denoise: boolean;
  startSec: number;
  endSec: number;
}

export interface LongformChapter {
  id: string;
  time: number;
  title: string;
}

export type LongformTransitionType =
  | 'cut'
  | 'dissolve'
  | 'fade_black'
  | 'fade_white'
  | 'wipe_left'
  | 'slide_left';

export interface LongformTransition {
  id: string;
  cutId: string;
  type: LongformTransitionType;
  duration: number;
  audioOffsetSec: number;
}

export interface LongformEditPoint {
  id: string;
  time: number;
  label: string;
}

export interface LongformTitleOverlay {
  id: string;
  text: string;
  subtitle: string;
  start: number;
  end: number;
  style: 'lower_third' | 'center_card';
  template: 'minimal' | 'broadcast' | 'glass';
  alignment: 'left' | 'center' | 'right';
  animation: 'none' | 'fade' | 'slide';
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  x: number;
  y: number;
  width: number;
  scale: number;
}

export interface LongformMotionKeyframe {
  id: string;
  time: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export interface LongformBrollOverlay {
  id: string;
  assetId: string;
  start: number;
  end: number;
  sourceOffset: number;
  layout: 'cover' | 'contain' | 'pip';
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  keyframes: LongformMotionKeyframe[];
}

export interface LongformMediaAsset {
  id: string;
  name: string;
  kind: 'broll' | 'music' | 'angle' | 'lut' | 'media' | 'voiceover';
  url: string;
  library?: boolean;
  durationSec?: number | null;
  mediaType?: 'video' | 'audio' | 'image' | 'lut';
}

export interface LongformColorGrade {
  exposure: number;
  contrast: number;
  saturation: number;
  vibrance: number;
  gamma: number;
  highlights: number;
  shadows: number;
  temperature: number;
  tint: number;
  sharpen: number;
  lutAssetId: string | null;
}

export interface LongformSpeedKeyframe {
  id: string;
  sourceTime: number;
  speed: number;
}

export interface LongformClipSpeed {
  rate: number;
  reverse: boolean;
  freeze: boolean;
  freezeAt: number;
  opticalFlow: boolean;
  pitchPreserve: boolean;
  keyframes: LongformSpeedKeyframe[];
}

export interface LongformMaskKeyframe {
  id: string;
  time: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface LongformMask {
  id: string;
  name: string;
  enabled: boolean;
  type: 'rectangle' | 'ellipse' | 'pen' | 'gradient';
  effect: 'blur' | 'mosaic' | 'opacity' | 'color';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  feather: number;
  strength: number;
  invert: boolean;
  fillColor: string;
  points: Array<{ x: number; y: number }>;
  keyframes: LongformMaskKeyframe[];
  trackingStatus: 'idle' | 'tracked' | 'partial' | 'failed';
}

export interface LongformSequenceClip {
  id: string;
  name: string;
  enabled: boolean;
  sourceType: 'program' | 'asset' | 'sequence' | 'generator';
  assetId: string | null;
  nestedSequenceId: string | null;
  generator: 'solid' | 'color_bars' | 'transparent';
  generatorColor: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  timelineEnd: number;
  includeAudio: boolean;
  linkedGroupId: string | null;
  compoundId: string | null;
  fit: 'cover' | 'contain' | 'stretch' | 'native';
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  volumeDb: number;
  fadeIn: number;
  fadeOut: number;
  transitionIn: { type: LongformTransitionType; duration: number };
  transitionOut: { type: LongformTransitionType; duration: number };
  speed: LongformClipSpeed;
  stabilization: {
    enabled: boolean;
    strength: number;
    rollingShutter: number;
    method: 'realtime' | 'two_pass';
  };
  chromaKey: {
    enabled: boolean;
    color: string;
    similarity: number;
    blend: number;
    spill: number;
    autoBackground: boolean;
  };
  masks: LongformMask[];
  templateIds: string[];
  notes: string;
}

export interface LongformSequenceTrack {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  order: number;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  solo: boolean;
  linked: boolean;
  volumeDb: number;
  clips: LongformSequenceClip[];
}

export interface LongformSequence {
  id: string;
  name: string;
  frameRate: number;
  width: number;
  height: number;
  tracks: LongformSequenceTrack[];
}

export interface LongformTimelineMarker {
  id: string;
  time: number;
  label: string;
  color: string;
  source: 'manual' | 'review' | 'qc' | 'chapter';
  resolved: boolean;
}

export interface LongformSequenceState {
  enabled: boolean;
  mode: 'composite' | 'replace';
  activeSequenceId: string;
  sourceIn: number | null;
  sourceOut: number | null;
  sequences: LongformSequence[];
  markers: LongformTimelineMarker[];
}

export interface LongformColorVersion {
  id: string;
  name: string;
  createdAt: string;
  source: 'manual' | 'auto' | 'lut' | 'match';
  grade: LongformColorGrade;
  metrics: Record<string, unknown>;
}

export interface LongformColorWorkflow {
  management: {
    inputSpace: 'auto' | 'rec709' | 'log_c' | 'slog3' | 'vlog' | 'hlg' | 'pq';
    workingSpace: 'rec709' | 'acescct' | 'hdr10' | 'hlg';
    outputSpace: 'rec709' | 'hdr10' | 'hlg';
    toneMap: 'none' | 'hable' | 'mobius' | 'reinhard';
    legalize: boolean;
    peakNits: number;
  };
  autoGrade: {
    strength: number;
    analyzedAt: string | null;
    metrics: Record<string, unknown>;
    confidence: number;
  };
  versions: LongformColorVersion[];
  selectedVersionId: string | null;
  compareVersionId: string | null;
  groups: Array<{
    id: string;
    name: string;
    clipIds: string[];
    grade: LongformColorGrade;
  }>;
}

export interface LongformAdrOptions {
  inputDeviceId: string;
  latencyMs: number;
  countdownSec: number;
  preRollSec: number;
  loopRecord: boolean;
  cues: Array<{
    id: string;
    name: string;
    start: number;
    end: number;
    text: string;
    takeAssetIds: string[];
    selectedTakeAssetId: string | null;
    roomToneAssetId: string | null;
  }>;
}

export interface LongformPublishOptions {
  title: string;
  description: string;
  includeMaster: boolean;
  includeHorizontal: boolean;
  includeSquare: boolean;
  includeVertical: boolean;
  includeShorts: boolean;
  shortsCount: number;
  shortDurationSec: number;
  destinations: string[];
  chapterArt: boolean;
  thumbnails: boolean;
  captions: boolean;
}

export interface LongformAudioKeyframe {
  id: string;
  time: number;
  gainDb: number;
}

export interface LongformAudioMix {
  dialogueGainDb: number;
  masterGainDb: number;
  pan: number;
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
  compressor: boolean;
  deEsser: boolean;
  noiseGate: boolean;
  dialogueMuted: boolean;
  musicMuted: boolean;
  keyframes: LongformAudioKeyframe[];
}

export interface LongformCaptionCue {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker: string;
  lowConfidence: boolean;
}

export interface LongformCaptionOptions {
  enabled: boolean;
  burnIn: boolean;
  cues: LongformCaptionCue[];
  fontSize: number;
  position: 'bottom' | 'center' | 'top';
  textColor: string;
  backgroundColor: string;
  highlightColor: string;
}

export interface LongformAdjustmentLayer {
  id: string;
  name: string;
  start: number;
  end: number;
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  sharpen: number;
  blur: number;
  vignette: number;
  grain: number;
}

export interface LongformMulticamAngle {
  id: string;
  assetId: string;
  name: string;
  offsetSec: number;
  speaker: string;
}

export interface LongformMulticamCut {
  id: string;
  angleId: string;
  start: number;
  end: number;
  useAudio: boolean;
}

export interface LongformMulticamOptions {
  angles: LongformMulticamAngle[];
  cuts: LongformMulticamCut[];
}

export interface LongformCreativeOptions {
  exportPreset: 'source' | 'youtube_1080p' | 'youtube_4k' | 'podcast';
  editPoints: LongformEditPoint[];
  transitions: LongformTransition[];
  titles: LongformTitleOverlay[];
  broll: LongformBrollOverlay[];
  color: LongformColorGrade;
  audio: LongformAudioMix;
  captions: LongformCaptionOptions;
  adjustmentLayers: LongformAdjustmentLayer[];
  multicam: LongformMulticamOptions;
  musicAssetId: string | null;
  musicVolume: number;
  musicDucking: boolean;
  sequence: LongformSequenceState;
  colorWorkflow: LongformColorWorkflow;
  adr: LongformAdrOptions;
  publish: LongformPublishOptions;
  delivery: {
    aspect: 'source' | '16:9' | '1:1' | '9:16';
    reframe: 'contain' | 'smart_crop' | 'stretch';
    safeArea: boolean;
  };
}

export interface LongformAutoGradeResult {
  grade: Partial<LongformColorGrade>;
  metrics: Record<string, number | string>;
  confidence: number;
  analyzedAt: string;
}

export interface LongformTrackingResult {
  keyframes: LongformMaskKeyframe[];
  confidence: number;
  status: 'tracked' | 'partial';
  face: boolean;
}

export interface LongformQcIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  time: number;
  title: string;
  detail: string;
}

export interface LongformQcReport {
  id: string;
  generatedAt: string;
  summary: { error: number; warning: number; info: number; passed: boolean };
  issues: LongformQcIssue[];
  media?: Record<string, unknown>;
}

export interface LongformEffectTemplate {
  id: string;
  name: string;
  category: 'transition' | 'title' | 'effect' | 'color' | 'audio' | 'mask';
  description: string;
  version: number;
  controls: Array<{
    id: string;
    label: string;
    type: 'number' | 'color' | 'boolean' | 'select' | 'text';
    value: unknown;
    min: number;
    max: number;
    step: number;
    options: string[];
  }>;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LongformReviewComment {
  id: string;
  author: string;
  text: string;
  time: number;
  versionId: string;
  drawing: Array<{ x: number; y: number }>;
  createdAt: string;
  resolved: boolean;
}

export interface LongformReview {
  token: string;
  projectName: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  status: 'in_review' | 'approved' | 'changes_requested';
  comments: LongformReviewComment[];
  versions: Array<{ id: string; label: string; createdAt: string | null; url: string }>;
  passwordRequired: boolean;
  drawingEnabled: boolean;
  url?: string;
}

export interface LongformDeliveryVariant {
  id: string;
  label: string;
  aspect: string;
  range: { start: number; end: number; title?: string } | null;
  contentHash: string;
  status: 'queued' | 'rendering' | 'complete' | 'failed';
  queueId?: string;
  outputName: string;
  outputUrl: string | null;
  thumbnailUrl: string | null;
  error: string | null;
}

export interface LongformDelivery {
  id: string;
  projectName: string;
  title: string;
  description: string;
  destinations: string[];
  createdAt: string;
  updatedAt: string;
  projectRevision: number;
  variants: LongformDeliveryVariant[];
  metadata: Record<string, unknown>;
}

export interface LongformConsolidation {
  id: string;
  projectName: string;
  title: string;
  codec: 'copy' | 'prores' | 'dnxhr' | 'h264';
  handlesSec: number;
  frameRate: number;
  status: 'queued' | 'running' | 'complete' | 'partial' | 'failed';
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  summary: { total: number; complete: number; failed: number };
  progress: {
    status: string;
    completed: number;
    total: number;
    percent: number;
    current: string | null;
    failed?: number;
  };
  warnings: string[];
  error: string | null;
  downloadUrl: string | null;
}

export interface LongformProxyState {
  status: 'missing' | 'building' | 'ready' | 'error';
  url: string | null;
  updatedAt: string | null;
  error: string | null;
}

export interface LongformSnapshot {
  id: string;
  name: string;
  createdAt: string;
  revision: number;
}

export interface LongformPreset {
  id: string;
  name: string;
  createdAt: string;
  creative: LongformCreativeOptions;
}

export interface LongformRenderQueueItem {
  id: string;
  projectName: string;
  outputName: string;
  status: 'queued' | 'rendering' | 'complete' | 'failed';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface LongformAssistantSuggestion {
  id: string;
  kind: 'chapter' | 'cut' | 'caption' | 'audio' | 'multicam' | 'broll';
  title: string;
  detail: string;
  confidence: number;
  payload: Record<string, unknown>;
}

export interface LongformAnalysis {
  cuts: LongformCut[];
  keepSegments: Array<[number, number]>;
  originalDurationSec: number;
  selectedDurationSec: number;
  removedDurationSec: number;
  estimatedDurationSec: number;
  joinCount: number;
  options: LongformOptions;
}

export interface LongformProject extends Partial<LongformAnalysis> {
  manifestVersion: number;
  kind: 'longform';
  name: string;
  sourceUrl: string;
  outputUrl: string;
  waveformUrl: string;
  sourceDurationSec: number;
  options: LongformOptions;
  cuts: LongformCut[];
  keepSegments: Array<[number, number]>;
  words: ClipWord[];
  topics: string[];
  chapters: LongformChapter[];
  transcriptionProvider?: string | null;
  transcriptionModel?: string | null;
  draftRevision?: number;
  creative: LongformCreativeOptions;
  assets: LongformMediaAsset[];
  proxy: LongformProxyState;
}

export interface ClipWord {
  word: string;
  start: number;
  end: number;
}

export interface ClipMetadata extends ClipSummary {
  start: number;
  end: number;
  duration: number;
  source?: string;
  style?: string;
  animation?: string;
  font?: string | null;
  subtitle_x?: number | null;
  subtitle_y?: number | null;
  subtitle_width?: number | null;
  subtitle_fontsize?: number | null;
  subtitle_glow?: boolean;
  video_zoom?: number | string | null;
  video_pan_x?: number | string | null;
  video_pan_y?: number | string | null;
  words: ClipWord[];
  text?: string;
  compute_backend?: string;
  video_encoder?: string;
  export_preset?: string;
  output_resolution?: [number, number];
  safe_area?: { top: number; right: number; bottom: number; left: number };
}

export interface ActiveJobState {
  jobId: string | null;
  active: boolean;
  recovered: boolean;
  label: string | null;
  source: string | null;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  computeDevice?: string;
  videoEncoder?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;
  transcriptionPreset?: string;
  transcriptionLanguage?: string;
  localSemantic?: boolean;
  geminiAnalysis?: boolean;
  reviewBeforeRender?: boolean;
  exportPreset?: string;
}

export interface UploadSession {
  sessionId: string;
  safeName: string;
  totalSize: number;
  receivedBytes: number;
  chunkSize: number;
  status: 'uploading' | 'uploaded' | 'processing' | 'completed' | 'error';
}

export interface Profile {
  id: string;
  name: string;
  settings: RenderSettings;
  createdAt: string;
  updatedAt: string;
}

export interface JobHistoryEntry {
  id: string;
  kind: string;
  label: string;
  source?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  status: 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  error?: string | null;
  computeDevice?: string;
  videoEncoder?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string | null;
  transcriptionPreset?: string;
  transcriptionLanguage?: string;
  localSemantic?: boolean;
  geminiAnalysis?: boolean;
  reviewBeforeRender?: boolean;
  exportPreset?: string;
}

export interface ComputeCapability {
  backend: 'rocm' | 'cuda' | 'cpu';
  available: boolean;
  label: string;
  device_name: string | null;
  runtime_version: string | null;
}

export interface VideoCapability {
  backend: 'nvenc' | 'vaapi' | 'amf' | 'cpu';
  available: boolean;
  label: string;
  h264_encoder: string;
  hevc_encoder: string;
  reason: string | null;
}

export interface IntelligenceCapability {
  id: string;
  label: string;
  available: boolean;
  cloud: boolean;
  reason: string | null;
}

export interface SystemCapabilities {
  platform: string;
  machine: string;
  ffmpegPath: string;
  vaapiDevice: string;
  compute: ComputeCapability[];
  videoEncoders: VideoCapability[];
  transcriptionProviders: IntelligenceCapability[];
  viralProviders: IntelligenceCapability[];
  recommendedCompute: string;
  recommendedVideoEncoder: string;
}

export type ProviderSecretSource = 'saved' | 'environment' | 'none';

export interface ProviderSecretStatus {
  configured: boolean;
  source: ProviderSecretSource;
}

export interface ProviderSettings {
  deepgram: ProviderSecretStatus;
  gemini: ProviderSecretStatus;
  localSemantic: {
    url: string;
    model: string;
    apiKeyConfigured: boolean;
    apiKeySource: ProviderSecretSource;
  };
}

export interface ProviderSettingsUpdate {
  deepgramApiKey?: string;
  geminiApiKey?: string;
  localLlmUrl?: string;
  localLlmModel?: string;
  localLlmApiKey?: string;
  clearDeepgramApiKey?: boolean;
  clearGeminiApiKey?: boolean;
  clearLocalLlmApiKey?: boolean;
}

export interface JobPreflight {
  ready: boolean;
  requested: {
    computeDevice: string;
    videoEncoder: string;
    transcriptionProvider: string;
    transcriptionModel: string | null;
    transcriptionPreset?: string;
    transcriptionLanguage?: string;
    localSemantic: boolean;
    geminiAnalysis: boolean;
    reviewBeforeRender: boolean;
  };
  effective: {
    computeDevice: string;
    videoEncoder: string;
    transcriptionProvider: string | null;
    transcriptionModel: string | null;
    transcriptionPreset?: string;
    transcriptionLanguage?: string;
    localSemantic: boolean;
    geminiAnalysis: boolean;
    reviewBeforeRender: boolean;
  };
  warnings: Array<{ code: string; message: string; requested: unknown; fallback: unknown }>;
  errors: Array<{ code: string; message: string; requested: unknown; fallback: unknown }>;
}

export interface ShortsCandidate {
  id: string;
  yieldId: string;
  start: number;
  end: number;
  duration: number;
  text: string;
  contextBefore?: string;
  contextAfter?: string;
  score: number;
  confidenceTier?: 'best' | 'strong' | 'review' | null;
  reasons: string[];
  topics: string[];
  clusterId: string;
  variantRank: number;
  duplicateOf?: string | null;
  boundaryQuality?: {
    standalone_opening?: number;
    complete_ending?: number;
    topic_coherence?: number;
    context_dependency?: number;
  };
  exported: boolean;
  failed: boolean;
  selected: boolean;
  feedback?: ShortsCandidateFeedback;
}

export interface ShortsCandidateFeedback {
  decision: 'approved' | 'rejected' | 'unreviewed';
  reason?: string;
  rating?: 1 | -1 | 0;
  editedStart?: number;
  editedEnd?: number;
  updatedAt?: string;
}

export interface ShortsReviewProjectSummary {
  id: string;
  createdAt: string;
  status: 'awaiting_review' | 'rendering' | 'rendered' | 'rendered_with_errors';
  sourceName: string;
  candidateCount: number;
  clusterCount: number;
  selectedCount: number;
  exportedCount: number;
}

export interface ShortsReviewProject extends ShortsReviewProjectSummary {
  sourceUrl: string;
  settings: Record<string, unknown>;
  yield: Record<string, unknown>;
  candidates: ShortsCandidate[];
}

export interface BatchReRenderBody {
  clipNames: string[];
  style?: string;
  font?: string | null;
  animation?: string;
  subtitle_x?: number | null;
  subtitle_y?: number | null;
  subtitle_width?: number | null;
  subtitle_fontsize?: number | null;
  subtitle_glow?: boolean;
}

export interface StorageMetrics {
  bytes: number;
  files: number;
  directories: number;
}

export interface AdminStorageCategory extends StorageMetrics {
  id: string;
  label: string;
  description: string;
  warning: string;
}

export interface AdminStorageSummary {
  categories: AdminStorageCategory[];
  totals: StorageMetrics;
  protected: string[];
  busyReason: string | null;
  confirmation: string;
}

export interface AdminStorageCleanupResult {
  status: 'cleaned';
  cleanup: {
    categories: string[];
    before: StorageMetrics;
    after: StorageMetrics;
    freedBytes: number;
  };
  storage: AdminStorageSummary;
}

class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string')
        ? (body as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export const api = {
  // Clips
  listClips: () => request<ClipSummary[]>('/api/clips'),
  getClipMeta: (name: string) => request<ClipMetadata>(`/api/clips/${encodeURIComponent(name)}/subtitles`),
  deleteClip: (name: string) => request<{ status: string }>(`/api/clips/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  reRenderClip: (name: string, body: Record<string, unknown>) =>
    request<{ status: string; message: string }>(`/api/clips/${encodeURIComponent(name)}/subtitles`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  startBakeDownload: (name: string, body: Record<string, unknown>) =>
    request<{ jobId: string }>(`/api/clips/${encodeURIComponent(name)}/render-download`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  bakeProgress: (jobId: string) =>
    request<{ progress: number; done: boolean; error: string | null }>(`/api/bake-progress/${encodeURIComponent(jobId)}`),
  bakeDownloadUrl: (jobId: string, name: string) =>
    `/api/bake-download/${encodeURIComponent(jobId)}?name=${encodeURIComponent(name)}`,

  // Thumbnail (served by the new thumbnail endpoint; the server sets Cache-Control
  // headers, so no client-side cache-buster — the clips list has no timestamp to key one off)
  clipThumbnailUrl: (name: string) => `/api/clips/${encodeURIComponent(name)}/thumbnail`,
  generateMoreClips: (name: string, count = 5) =>
    request<{ status: string; requested: number; remainingBeforeRender: number }>(`/api/clips/${encodeURIComponent(name)}/generate-more`, {
      method: 'POST',
      body: JSON.stringify({ count }),
    }),

  // Long-form silence editor
  getLongformProject: (name: string) =>
    request<LongformProject>(`/api/longform/${encodeURIComponent(name)}/project`),
  analyzeLongform: (name: string, options: LongformOptions) =>
    request<LongformAnalysis>(`/api/longform/${encodeURIComponent(name)}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ options }),
    }),
  saveLongformProject: (name: string, body: { options: LongformOptions; cuts: LongformCut[]; chapters?: LongformChapter[]; creative?: LongformCreativeOptions; revision?: number }) =>
    request<{ status: string } & LongformAnalysis>(`/api/longform/${encodeURIComponent(name)}/project`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  renderLongform: (name: string, body: { options: LongformOptions; cuts: LongformCut[]; chapters?: LongformChapter[]; creative?: LongformCreativeOptions }) =>
    request<{ status: string; outputName: string; queueId?: string }>(`/api/longform/${encodeURIComponent(name)}/render`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  buildLongformProxy: (name: string) =>
    request<LongformProxyState>(`/api/longform/${encodeURIComponent(name)}/proxy`, { method: 'POST' }),
  deleteLongformProxy: (name: string) =>
    request<LongformProxyState>(`/api/longform/${encodeURIComponent(name)}/proxy`, { method: 'DELETE' }),
  listLongformSnapshots: (name: string) =>
    request<LongformSnapshot[]>(`/api/longform/${encodeURIComponent(name)}/snapshots`),
  createLongformSnapshot: (name: string, snapshotName?: string) =>
    request<LongformSnapshot>(`/api/longform/${encodeURIComponent(name)}/snapshots`, {
      method: 'POST',
      body: JSON.stringify({ name: snapshotName }),
    }),
  restoreLongformSnapshot: (name: string, snapshotId: string) =>
    request<{ status: string }>(`/api/longform/${encodeURIComponent(name)}/snapshots/${encodeURIComponent(snapshotId)}/restore`, {
      method: 'POST',
    }),
  duplicateLongformProject: (name: string, duplicateName?: string) =>
    request<{ name: string }>(`/api/longform/${encodeURIComponent(name)}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ name: duplicateName }),
    }),
  relinkLongformSource: (name: string, file: File) => {
    const form = new FormData();
    form.append('source', file, file.name);
    return request<{ status: string; sourceDurationSec: number }>(`/api/longform/${encodeURIComponent(name)}/relink`, {
      method: 'POST',
      body: form,
    });
  },
  listLongformRenderQueue: () =>
    request<LongformRenderQueueItem[]>('/api/longform-render-queue'),
  listLongformPresets: () =>
    request<LongformPreset[]>('/api/longform-presets'),
  createLongformPreset: (name: string, creative: LongformCreativeOptions) =>
    request<LongformPreset>('/api/longform-presets', {
      method: 'POST',
      body: JSON.stringify({ name, creative }),
    }),
  deleteLongformPreset: (id: string) =>
    request<{ status: string }>(`/api/longform-presets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getLongformAssistantSuggestions: (name: string, body: { options: LongformOptions; cuts: LongformCut[]; creative: LongformCreativeOptions }) =>
    request<{ suggestions: LongformAssistantSuggestion[] }>(`/api/longform/${encodeURIComponent(name)}/assistant`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  autoGradeLongform: (name: string, body: { start: number; end: number; assetId?: string | null; samples?: number }) =>
    request<LongformAutoGradeResult>(`/api/longform/${encodeURIComponent(name)}/auto-grade`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  suggestLongformBackgroundKey: (name: string, body: { time: number; assetId?: string | null }) =>
    request<{ color: string; similarity: number; blend: number; confidence: number }>(`/api/longform/${encodeURIComponent(name)}/background-key`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  trackLongformMask: (name: string, body: {
    assetId?: string | null;
    sourceStart: number;
    sourceEnd: number;
    timelineStart: number;
    rate: number;
    x: number;
    y: number;
    width: number;
    height: number;
    face?: boolean;
    interval?: number;
  }) => request<LongformTrackingResult>(`/api/longform/${encodeURIComponent(name)}/track`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  alignLongformVoiceover: (name: string, body: { assetId: string; cueStart: number; thresholdDb?: number }) =>
    request<{ leadingSilenceSec: number; timelineStart: number }>(`/api/longform/${encodeURIComponent(name)}/voiceover/align`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  runLongformQc: (name: string, body: { options: LongformOptions; cuts: LongformCut[]; chapters: LongformChapter[]; creative: LongformCreativeOptions }) =>
    request<LongformQcReport>(`/api/longform/${encodeURIComponent(name)}/qc`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listLongformEffectTemplates: () =>
    request<LongformEffectTemplate[]>('/api/longform-effect-templates'),
  createLongformEffectTemplate: (template: Partial<LongformEffectTemplate>) =>
    request<LongformEffectTemplate>('/api/longform-effect-templates', {
      method: 'POST',
      body: JSON.stringify(template),
    }),
  importLongformEffectTemplates: (templates: Array<Partial<LongformEffectTemplate>>) =>
    request<LongformEffectTemplate[]>('/api/longform-effect-templates', {
      method: 'POST',
      body: JSON.stringify({ templates }),
    }),
  deleteLongformEffectTemplate: (id: string) =>
    request<{ status: string }>(`/api/longform-effect-templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listLongformReviews: (name: string) =>
    request<LongformReview[]>(`/api/longform/${encodeURIComponent(name)}/reviews`),
  createLongformReview: (name: string, body: { title?: string; password?: string; expiryDays?: number }) =>
    request<LongformReview>(`/api/longform/${encodeURIComponent(name)}/reviews`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getLongformReview: (token: string, password = '') =>
    request<LongformReview>(`/api/longform-reviews/${encodeURIComponent(token)}`, {
      headers: password ? { 'x-review-password': password } : {},
    }),
  addLongformReviewComment: (token: string, body: {
    author: string;
    text: string;
    time: number;
    versionId: string;
    drawing?: Array<{ x: number; y: number }>;
    password?: string;
  }) => request<LongformReviewComment>(`/api/longform-reviews/${encodeURIComponent(token)}/comments`, {
    method: 'POST',
    headers: body.password ? { 'x-review-password': body.password } : {},
    body: JSON.stringify(body),
  }),
  updateLongformReview: (token: string, body: {
    status?: LongformReview['status'];
    commentId?: string;
    resolved?: boolean;
    password?: string;
  }) => request<LongformReview>(`/api/longform-reviews/${encodeURIComponent(token)}`, {
    method: 'PATCH',
    headers: body.password ? { 'x-review-password': body.password } : {},
    body: JSON.stringify(body),
  }),
  publishLongformPackage: (name: string, body: {
    options: LongformOptions;
    cuts: LongformCut[];
    chapters: LongformChapter[];
    creative: LongformCreativeOptions;
  }) => request<{ status: string; queued: number; delivery: LongformDelivery }>(`/api/longform/${encodeURIComponent(name)}/publish-package`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  listLongformDeliveries: (name: string) =>
    request<LongformDelivery[]>(`/api/longform/${encodeURIComponent(name)}/deliveries`),
  getLongformDelivery: (id: string) =>
    request<LongformDelivery>(`/api/longform-deliveries/${encodeURIComponent(id)}`),
  longformDeliveryArchiveUrl: (id: string) =>
    `/api/longform-deliveries/${encodeURIComponent(id)}/archive`,
  longformInterchangeUrl: (name: string, format: 'edl' | 'otio' | 'fcpxml' | 'aaf') =>
    `/api/longform/${encodeURIComponent(name)}/interchange/${format}`,
  longformProjectArchiveUrl: (name: string, includeMedia = true) =>
    `/api/longform/${encodeURIComponent(name)}/archive?includeMedia=${includeMedia ? 'true' : 'false'}`,
  listLongformConsolidations: (name: string) =>
    request<LongformConsolidation[]>(`/api/longform/${encodeURIComponent(name)}/consolidations`),
  createLongformConsolidation: (name: string, body: {
    title?: string;
    codec: LongformConsolidation['codec'];
    handlesSec: number;
  }) => request<LongformConsolidation>(`/api/longform/${encodeURIComponent(name)}/consolidations`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  getLongformConsolidation: (id: string) =>
    request<LongformConsolidation>(`/api/longform-consolidations/${encodeURIComponent(id)}`),
  longformConsolidationArchiveUrl: (id: string) =>
    `/api/longform-consolidations/${encodeURIComponent(id)}/archive`,
  listLongformLuts: () => request<LongformMediaAsset[]>('/api/longform-luts'),
  deleteLongformLut: (id: string) =>
    request<{ status: string }>(`/api/longform-luts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Batch operations (new endpoints, see server.js)
  batchDelete: (names: string[]) =>
    request<{ deleted: number }>(`/api/clips/batch`, {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', clipNames: names }),
    }),
  batchReRender: (body: BatchReRenderBody) =>
    request<{ status: string; queued: number }>(`/api/clips/batch`, {
      method: 'POST',
      body: JSON.stringify({ action: 'rerender', ...body }),
    }),
  batchDownloadUrl: () => `/api/clips/batch-download`,

  // Jobs
  jobStatus: () => request<ActiveJobState>('/api/job-status'),
  cancelJob: () => request<{ status: string }>('/api/job/cancel', { method: 'POST' }),
  listJobs: () => request<JobHistoryEntry[]>('/api/jobs'),

  // Logs
  getLogs: (limit = 80) => request<string[]>(`/api/logs?limit=${limit}`),

  // Upload (resumable chunked)
  initUpload: (body: {
    fileName: string;
    fileSize: number;
    mimeType: string;
    lastModified?: number;
    fingerprint?: string;
    sessionId?: string;
  } & RenderSettings) =>
    request<UploadSession>('/api/upload-sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  uploadStatus: (sessionId: string) =>
    request<UploadSession>(`/api/upload-sessions/${encodeURIComponent(sessionId)}`),
  uploadChunk: (sessionId: string, chunk: Blob, offset: number) => {
    const form = new FormData();
    form.append('chunk', chunk, 'chunk.bin');
    form.append('offset', String(offset));
    form.append('chunkSize', String(chunk.size));
    return fetch(`/api/upload-sessions/${encodeURIComponent(sessionId)}/chunk`, {
      method: 'POST',
      body: form,
    }).then(async (r) => {
      const text = await r.text();
      const body = safeParse(text);
      if (!r.ok) throw new ApiError((body as { error?: string })?.error ?? 'Chunk upload failed', r.status, body);
      return body as { status: string; receivedBytes: number; totalSize: number; complete: boolean };
    });
  },
  finalizeUpload: (sessionId: string) =>
    request<{ status: string; message: string }>(`/api/upload-sessions/${encodeURIComponent(sessionId)}/complete`, {
      method: 'POST',
    }),

  // Resumable, multi-source montage upload. Each source is committed in small
  // raw chunks; the final request only starts analysis after every source is
  // durably staged.
  actionCompilationUploadCapabilities: () =>
    request<ActionCompilationUploadCapabilities>('/api/action-compilation-upload-capabilities'),
  createActionCompilationUploadSession: (body: ActionCompilationUploadSessionRequest, signal?: AbortSignal) =>
    request<ActionCompilationUploadSessionResponse>('/api/action-compilation-upload-sessions', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),
  actionCompilationUploadSessionStatus: (sessionId: string, signal?: AbortSignal) =>
    request<ActionCompilationUploadSessionResponse>(`/api/action-compilation-upload-sessions/${encodeURIComponent(sessionId)}`, { signal }),
  uploadActionCompilationSourceChunk: (
    sessionId: string,
    sourceId: string,
    chunk: Blob,
    offset: number,
    totalSize: number,
    signal?: AbortSignal,
  ) => request<ActionCompilationUploadSession>(
    `/api/action-compilation-upload-sessions/${encodeURIComponent(sessionId)}/sources/${encodeURIComponent(sourceId)}`,
    {
      method: 'PUT',
      body: chunk,
      signal,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${offset}-${offset + chunk.size - 1}/${totalSize}`,
      },
    },
  ),
  completeActionCompilationUploadSession: (sessionId: string, signal?: AbortSignal) =>
    request<ActionCompilationQueued>(`/api/action-compilation-upload-sessions/${encodeURIComponent(sessionId)}/complete`, {
      method: 'POST',
      signal,
    }),
  discardActionCompilationUploadSession: (sessionId: string) =>
    request<{ status: string }>(`/api/action-compilation-upload-sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),

  // URL ingest
  processUrl: (body: { url: string } & RenderSettings) =>
    request<{ status: string; message: string }>('/api/process-url', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Profiles
  listProfiles: () => request<Profile[]>('/api/profiles'),
  saveProfile: (profile: Profile) =>
    request<Profile>(`/api/profiles/${encodeURIComponent(profile.id)}`, {
      method: 'PUT',
      body: JSON.stringify(profile),
    }),
  deleteProfile: (id: string) =>
    request<{ status: string }>(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Settings
  getSettings: () => request<Record<string, unknown>>('/api/settings'),
  saveSettings: (settings: RenderSettings) =>
    request<{ status: string; settings: Record<string, unknown> }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  getAdminStorage: () => request<AdminStorageSummary>('/api/admin/storage'),
  cleanupAdminStorage: (categories: string[], confirm: string) =>
    request<AdminStorageCleanupResult>('/api/admin/storage/cleanup', {
      method: 'POST',
      body: JSON.stringify({ categories, confirm }),
    }),
  getProviderSettings: () => request<ProviderSettings>('/api/provider-settings'),
  saveProviderSettings: (settings: ProviderSettingsUpdate) =>
    request<ProviderSettings>('/api/provider-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  systemCapabilities: () => request<SystemCapabilities>('/api/system/capabilities'),
  jobPreflight: (settings: RenderSettings) =>
    request<JobPreflight>('/api/jobs/preflight', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),

  // Shorts candidate review
  listShortsProjects: () => request<ShortsReviewProjectSummary[]>('/api/shorts-projects'),
  getShortsProject: (id: string) =>
    request<ShortsReviewProject>(`/api/shorts-projects/${encodeURIComponent(id)}`),
  saveShortsFeedback: (
    id: string,
    body: { candidateIds: string[]; feedback: Record<string, ShortsCandidateFeedback> },
  ) =>
    request<ShortsReviewProject>(`/api/shorts-projects/${encodeURIComponent(id)}/feedback`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  renderShortsCandidates: (
    id: string,
    body: { candidateIds: string[]; feedback?: Record<string, ShortsCandidateFeedback> },
  ) => request<{ status: string; requested: number }>(`/api/shorts-projects/${encodeURIComponent(id)}/render`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  uploadLongformAsset: (name: string, kind: 'broll' | 'music' | 'angle' | 'lut' | 'media' | 'voiceover', file: File) => {
    const form = new FormData();
    form.append('asset', file, file.name);
    form.append('kind', kind);
    return request<LongformMediaAsset>(`/api/longform/${encodeURIComponent(name)}/assets`, {
      method: 'POST',
      body: form,
    });
  },
};

export { ApiError };
