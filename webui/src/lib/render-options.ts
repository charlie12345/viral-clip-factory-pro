export const MAX_DURATIONS = [30, 60, 120, 180] as const;
export const MAX_CLIPS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50] as const;
export const RESUMABLE_CHUNK_SIZE = 8 * 1024 * 1024;

export type RenderMode = 'shorts' | 'longform';
export type FramingMode = 'auto' | 'smart_switch' | 'dual_stack';
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
  { id:'last60',     label:'Last 1 minute',       group:'From End',   startTime:'-60',  endTime:'',     isFromEnd:true },
  { id:'last180',    label:'Last 3 minutes',      group:'From End',   startTime:'-180', endTime:'',     isFromEnd:true },
  { id:'last300',    label:'Last 5 minutes',      group:'From End',   startTime:'-300', endTime:'',     isFromEnd:true },
];

export interface RenderSettings {
  mode: RenderMode;
  upscale: boolean;
  subtitleStyle: string;
  maxDuration: number;
  maxClips: number;
  framingMode: FramingMode;
  startTime: string;
  endTime: string;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  mode: 'shorts',
  upscale: false,
  subtitleStyle: 'classic',
  maxDuration: 180,
  maxClips: 30,
  framingMode: 'auto',
  startTime: '',
  endTime: '',
};
