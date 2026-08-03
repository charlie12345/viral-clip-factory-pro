export const MAX_DURATIONS = [30, 60, 90, 120, 180] as const;
export const MAX_CLIPS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50] as const;
export const RESUMABLE_CHUNK_SIZE = 8 * 1024 * 1024;

export type RenderMode = 'shorts' | 'longform';
export type FramingMode = 'auto' | 'smart_switch' | 'dual_stack';
export type ClipVolume = 'curated' | 'balanced' | 'more' | 'exact';
export type ComputeDevice = 'auto' | 'cpu' | 'cuda' | 'rocm';
export type VideoEncoder = 'auto' | 'cpu' | 'nvenc' | 'vaapi' | 'amf';
export type TranscriptionProvider = 'auto' | 'openai_whisper' | 'whisper_cpp' | 'deepgram';
export type TranscriptionModel = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'turbo';
export type TranscriptionPreset = 'draft' | 'final';
export type ExportPreset = 'generic' | 'youtube_shorts' | 'instagram_reels' | 'tiktok';
export type SegmentPreset =
  | 'full'
  | 'first60' | 'first180' | 'first300' | 'first600' | 'first1800'
  | 'seg_1_3' | 'seg_3_6' | 'seg_6_9' | 'seg_9_12' | 'seg_12_17'
  | 'last60' | 'last180' | 'last300'
  | 'custom';

export interface SegmentPresetMeta {
  id: SegmentPreset;
  label: string;
  group: string;
  startTime: string;
  endTime: string;
  // 'from-end' sentinels are sent literally to the backend, which interprets them
  isFromEnd?: boolean;
}

export const FRAMING_MODES: { id: FramingMode; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'smart_switch', label: 'Smart switch' },
  { id: 'dual_stack', label: 'Stacked heads' },
];

export const CLIP_VOLUME_OPTIONS: { id: ClipVolume; label: string; detail: string }[] = [
  { id: 'curated', label: 'Curated', detail: 'Strongest picks' },
  { id: 'balanced', label: 'Balanced', detail: 'Quality + coverage' },
  { id: 'more', label: 'More', detail: 'Broader selection' },
  { id: 'exact', label: 'Exact', detail: 'Choose a target' },
];

export interface ExportPresetMeta {
  id: ExportPreset;
  label: string;
  detail: string;
  defaultMaxDuration: number;
  safeArea: { top: number; right: number; bottom: number; left: number };
}

export const EXPORT_PRESETS: ExportPresetMeta[] = [
  { id: 'generic', label: 'Generic Vertical', detail: '1080 × 1920', defaultMaxDuration: 60, safeArea: { top: 0.08, right: 0.08, bottom: 0.12, left: 0.08 } },
  { id: 'youtube_shorts', label: 'YouTube Shorts', detail: '1080 × 1920 · up to 3 min', defaultMaxDuration: 180, safeArea: { top: 0.08, right: 0.14, bottom: 0.18, left: 0.06 } },
  { id: 'instagram_reels', label: 'Instagram Reels', detail: '1080 × 1920 creator default', defaultMaxDuration: 90, safeArea: { top: 0.12, right: 0.08, bottom: 0.2, left: 0.08 } },
  { id: 'tiktok', label: 'TikTok', detail: '1080 × 1920 creator default', defaultMaxDuration: 60, safeArea: { top: 0.1, right: 0.16, bottom: 0.2, left: 0.06 } },
];

export const SEGMENT_PRESETS: SegmentPresetMeta[] = [
  { id:'full',       label:'Full video',          group:'From Start', startTime:'',     endTime:''     },
  { id:'first60',    label:'First 1 minute',      group:'From Start', startTime:'0',    endTime:'60'   },
  { id:'first180',   label:'First 3 minutes',     group:'From Start', startTime:'0',    endTime:'180'  },
  { id:'first300',   label:'First 5 minutes',     group:'From Start', startTime:'0',    endTime:'300'  },
  { id:'first600',   label:'First 10 minutes',    group:'From Start', startTime:'0',    endTime:'600'  },
  { id:'first1800',  label:'First 30 minutes',    group:'From Start', startTime:'0',    endTime:'1800' },
  { id:'seg_1_3',    label:'Minutes 1–3',         group:'Middle',     startTime:'60',   endTime:'180'  },
  { id:'seg_3_6',    label:'Minutes 3–6',         group:'Middle',     startTime:'180',  endTime:'360'  },
  { id:'seg_6_9',    label:'Minutes 6–9',         group:'Middle',     startTime:'360',  endTime:'540'  },
  { id:'seg_9_12',   label:'Minutes 9–12',        group:'Middle',     startTime:'540',  endTime:'720'  },
  { id:'seg_12_17',  label:'Minutes 12–17',       group:'Middle',     startTime:'720',  endTime:'1020' },
  { id:'last60',     label:'Last 1 minute',       group:'From End',   startTime:'999998', endTime:'60',  isFromEnd:true },
  { id:'last180',    label:'Last 3 minutes',      group:'From End',   startTime:'999998', endTime:'180', isFromEnd:true },
  { id:'last300',    label:'Last 5 minutes',      group:'From End',   startTime:'999998', endTime:'300', isFromEnd:true },
];

export interface RenderSettings {
  mode: RenderMode;
  upscale: boolean;
  subtitleStyle: string;
  maxDuration: number;
  clipVolume: ClipVolume;
  targetClips: number;
  maxClips: number;
  framingMode: FramingMode;
  startTime: string;
  endTime: string;
  computeDevice: ComputeDevice;
  videoEncoder: VideoEncoder;
  transcriptionProvider: TranscriptionProvider;
  transcriptionModel: TranscriptionModel;
  transcriptionPreset: TranscriptionPreset;
  transcriptionLanguage: string;
  localSemantic: boolean;
  geminiAnalysis: boolean;
  reviewBeforeRender: boolean;
  exportPreset: ExportPreset;
  outputNameTemplate: string;
  vaapiDevice: string;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  mode: 'shorts',
  upscale: false,
  subtitleStyle: 'classic',
  maxDuration: 180,
  clipVolume: 'balanced',
  targetClips: 12,
  maxClips: 30,
  framingMode: 'auto',
  startTime: '',
  endTime: '',
  computeDevice: 'auto',
  videoEncoder: 'auto',
  transcriptionProvider: 'auto',
  transcriptionModel: 'large-v3',
  transcriptionPreset: 'final',
  transcriptionLanguage: 'auto',
  localSemantic: true,
  geminiAnalysis: false,
  reviewBeforeRender: true,
  exportPreset: 'generic',
  outputNameTemplate: '{source}_{platform}_{index}_{score}',
  vaapiDevice: '/dev/dri/renderD128',
};
