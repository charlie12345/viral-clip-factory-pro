// Subtitle overlay styles — CSS preview approximations of each caption style.
// Source of truth is the Python pipeline (viral_factory.py + ASS generator);
// these objects are used by the in-browser preview only.

export type CaptionStyleGroup = 'Animated Highlight' | 'High Impact' | 'Studio Social' | 'Clean & Cinematic';

export interface OverlayStyle {
  id: string;
  label: string;
  group: CaptionStyleGroup;
  font: string;          // CSS font shorthand, uses `1em` as a font-size placeholder
  color: string;
  outline: string;       // hex / 'none'
  op: number;            // outline thickness in px; 0 = no outline
  bg: string;            // CSS background or 'none'
  hi: string[];          // highlight colors used per-word
  chunks: number;        // words per chunk
  upper?: boolean;
  ls?: string;
  ts?: string;           // text-shadow when outline === 'none' and op === 0
  defaultPos?: [number, number]; // [x, y] fraction (0..1)
  previewMotion?: 'stamp' | 'signal' | 'prism' | 'halo' | 'ticker' | 'poster';
}

export const OVERLAY_STYLES: Record<string, OverlayStyle> = {
  classic:   { id:'classic',   label:'Classic',    group:'Animated Highlight', font:'900 1em "Montserrat Black","Arial Black",sans-serif', color:'#fff', outline:'#000', op:1, bg:'none',            hi:['#ff0','#ffa500','#ff1493','#0f0','#f0f','#00bfff'], chunks:4, defaultPos:[0.5,0.12] },
  bold:      { id:'bold',      label:'Bold',       group:'Animated Highlight', font:'900 1em "Montserrat Black","Arial Black",sans-serif', color:'#0ff', outline:'#000', op:1, bg:'rgba(0,0,0,.9)',  hi:['#0ff'], chunks:3, defaultPos:[0.5,0.80] },
  pulse:     { id:'pulse',     label:'Pulse',      group:'Animated Highlight', font:'900 1em "Poppins Black","Arial Black",sans-serif',     color:'#fff', outline:'#ff1493', op:1, bg:'rgba(0,0,0,.6)', hi:['#ff0','#ffa500','#ff1493','#0f0','#f0f','#00bfff'], chunks:3, defaultPos:[0.5,0.80] },
  neon:      { id:'neon',      label:'Neon',       group:'Animated Highlight', font:'900 1em "Montserrat Black","Arial Black",sans-serif',  color:'#ff0', outline:'#0ff', op:1, bg:'rgba(0,0,0,.65)', hi:['#ff0','#f0f','#0f0','#ff4500','#ff69b4'], chunks:3, defaultPos:[0.5,0.80] },
  wave:      { id:'wave',      label:'Wave',       group:'Animated Highlight', font:'700 1em "Poppins Bold","Arial Black",sans-serif',      color:'#fff', outline:'#ff69b4', op:1, bg:'rgba(0,0,0,.55)', hi:['#0ff','#f8f','#0f0','#f0f','#ff0'], chunks:4, defaultPos:[0.5,0.80] },
  gradient:  { id:'gradient',  label:'Gradient',   group:'Animated Highlight', font:'900 1em "Montserrat Black","Arial Black",sans-serif',  color:'#fff', outline:'#0045ff', op:1, bg:'rgba(0,0,0,.5)',  hi:['#ffcf00','#ff8000','#ff0','#80ff80','#00ff80'], chunks:3, defaultPos:[0.5,0.80] },
  karaoke:   { id:'karaoke',   label:'Karaoke',    group:'Animated Highlight', font:'900 1em "Montserrat Black","Arial Black",sans-serif',  color:'#fff', outline:'#000', op:1, bg:'none',            hi:['#ff0'], chunks:4, defaultPos:[0.5,0.80] },
  whip:      { id:'whip',      label:'Whip',       group:'Animated Highlight', font:'700 1em "Rajdhani Bold","Arial Black",sans-serif',     color:'#fff', outline:'#000', op:1, bg:'rgba(0,0,0,.9)',  hi:['#ff1493'], chunks:3, defaultPos:[0.5,0.80] },

  explosive: { id:'explosive', label:'Impact',     group:'High Impact',        font:'900 1em "Anton","Arial Narrow",sans-serif',            color:'#fff', outline:'#000', op:1, bg:'rgba(0,0,0,.9)',  hi:['#fff'], chunks:2, upper:true, defaultPos:[0.5,0.80] },
  electric:  { id:'electric',  label:'Electric',   group:'High Impact',        font:'900 1em "Anton","Arial Narrow",sans-serif',            color:'#0ff', outline:'#000', op:1, bg:'rgba(0,0,0,.9)',  hi:['#0ff'], chunks:2, upper:true, defaultPos:[0.5,0.80] },
  fire:      { id:'fire',      label:'Fire',       group:'High Impact',        font:'900 1em "Oswald Bold","Arial Narrow",sans-serif',      color:'#fff', outline:'#0045ff', op:1, bg:'rgba(0,0,0,.9)', hi:['#f00','#ff4500','#ff8000','#ffcf00','#ff0'], chunks:2, upper:true, defaultPos:[0.5,0.80] },
  bounce:    { id:'bounce',    label:'Bounce',     group:'High Impact',        font:'700 1em "Poppins Bold","Arial Black",sans-serif',      color:'#fff', outline:'#000', op:1, bg:'rgba(0,0,0,.7)',  hi:['#fff'], chunks:3, defaultPos:[0.5,0.88] },
  stark:     { id:'stark',     label:'Stark',      group:'High Impact',        font:'900 1em "Montserrat Black","Arial Black",sans-serif',  color:'#fff', outline:'none', op:0, bg:'rgba(0,0,0,.97)', hi:['#ff69b4'], chunks:3, defaultPos:[0.5,0.80] },
  glitch:    { id:'glitch',    label:'Glitch',     group:'High Impact',        font:'900 1em "Oswald Bold","Arial Narrow",sans-serif',      color:'#fff', outline:'none', op:0, bg:'rgba(0,0,0,.9)',  hi:['#f00','#0ff'], chunks:3, upper:true, defaultPos:[0.5,0.80] },
  spotlight: { id:'spotlight', label:'Spotlight',  group:'High Impact',        font:'900 1em "Bebas Neue","Impact",sans-serif',             color:'#fff', outline:'#000', op:1, bg:'rgba(0,0,0,.88)', hi:['#fff'], chunks:1, upper:true, defaultPos:[0.5,0.50] },
  duo:       { id:'duo',       label:'Duo',        group:'High Impact',        font:'900 1em "Archivo Black","Arial Black",sans-serif',     color:'#fff', outline:'#000', op:1, bg:'rgba(0,0,0,.88)', hi:['#ff69b4'], chunks:2, defaultPos:[0.5,0.80] },

  marker:    { id:'marker',    label:'Marker',     group:'Studio Social',      font:'900 1em "Montserrat Black","Arial Black",sans-serif', color:'#fff200', outline:'#171717', op:2, bg:'rgba(10,12,18,.74)', hi:['#fff','#fff200'], chunks:3, upper:true, defaultPos:[0.5,0.76], previewMotion:'stamp' },
  signal:    { id:'signal',    label:'Signal',     group:'Studio Social',      font:'900 1em "Archivo Black","Arial Black",sans-serif',     color:'#f8fafc', outline:'#0ea5e9', op:1, bg:'rgba(3,12,28,.88)', hi:['#38bdf8','#a78bfa'], chunks:3, upper:true, defaultPos:[0.5,0.80], previewMotion:'signal' },
  prism:     { id:'prism',     label:'Prism',      group:'Studio Social',      font:'900 1em "Poppins Black","Arial Black",sans-serif',     color:'#fff', outline:'#312e81', op:2, bg:'rgba(15,10,35,.72)', hi:['#22d3ee','#818cf8','#f472b6'], chunks:3, defaultPos:[0.5,0.78], previewMotion:'prism' },
  halo:      { id:'halo',      label:'Halo',       group:'Studio Social',      font:'900 1em "Poppins Black","Arial Black",sans-serif',     color:'#fff', outline:'#c084fc', op:2, bg:'none', hi:['#f0abfc','#c084fc'], chunks:2, defaultPos:[0.5,0.76], previewMotion:'halo' },
  ticker:    { id:'ticker',    label:'Ticker',     group:'Studio Social',      font:'700 1em "Rajdhani Bold","Arial Narrow",sans-serif',     color:'#e0f2fe', outline:'#020617', op:1, bg:'rgba(2,6,23,.9)', hi:['#67e8f9','#fff'], chunks:4, upper:true, ls:'1px', defaultPos:[0.5,0.88], previewMotion:'ticker' },
  poster:    { id:'poster',    label:'Poster',     group:'Studio Social',      font:'900 1em "Anton","Arial Narrow",sans-serif',            color:'#fff', outline:'#111827', op:2, bg:'rgba(251,146,60,.88)', hi:['#111827','#fff'], chunks:2, upper:true, defaultPos:[0.5,0.72], previewMotion:'poster' },

  clean:     { id:'clean',     label:'Clean',      group:'Clean & Cinematic',  font:'700 1em "Montserrat Bold","Arial",sans-serif',         color:'#f5f5f5', outline:'#333', op:1, bg:'rgba(0,0,0,.35)', hi:['#e8e8e8'], chunks:4, defaultPos:[0.5,0.12] },
  cinematic: { id:'cinematic', label:'Cinematic',  group:'Clean & Cinematic',  font:'700 1em "Montserrat Bold","Arial",sans-serif',         color:'#fff', outline:'none', op:0, bg:'rgba(0,0,0,.88)', hi:['#fff'], chunks:5, ls:'1px', defaultPos:[0.5,0.88] },
  outline:   { id:'outline',   label:'Outline',    group:'Clean & Cinematic',  font:'900 1em "Barlow Condensed Black","Arial Narrow",sans-serif', color:'#fff', outline:'#000', op:2, bg:'none',       hi:['#ffcf80'], chunks:3, defaultPos:[0.5,0.80] },
  shadow:    { id:'shadow',    label:'Shadow',     group:'Clean & Cinematic',  font:'900 1em "Montserrat Black","Arial Black",sans-serif',  color:'#fff', outline:'none', op:0, bg:'none', ts:'0 2px 8px rgba(0,0,0,.9)', hi:['#ff0'], chunks:3, defaultPos:[0.5,0.80] },
  gold:      { id:'gold',      label:'Gold',       group:'Clean & Cinematic',  font:'900 1em "Montserrat Black","Arial Black",sans-serif',  color:'#fffacd', outline:'#000', op:1, bg:'rgba(0,0,0,.5)', hi:['#ffd700'], chunks:3, ls:'1px', defaultPos:[0.5,0.80] },
  subtitle:  { id:'subtitle',  label:'Subtitle',   group:'Clean & Cinematic',  font:'700 1em "Oswald Bold","Arial",sans-serif',             color:'#fff', outline:'#000', op:1, bg:'rgba(0,0,0,.85)', hi:['#e8f4ff'], chunks:6, ls:'0.5px', defaultPos:[0.5,0.85] },
};

export const STYLE_LIST: Array<{ id: string; label: string; group: OverlayStyle['group'] } | { sep: string }> = [
  { sep: 'Animated Highlight' },
  { id:'classic',   label:'Classic',   group:'Animated Highlight' },
  { id:'bold',      label:'Bold',      group:'Animated Highlight' },
  { id:'pulse',     label:'Pulse',     group:'Animated Highlight' },
  { id:'neon',      label:'Neon',      group:'Animated Highlight' },
  { id:'wave',      label:'Wave',      group:'Animated Highlight' },
  { id:'gradient',  label:'Gradient',  group:'Animated Highlight' },
  { id:'karaoke',   label:'Karaoke',   group:'Animated Highlight' },
  { id:'whip',      label:'Whip',      group:'Animated Highlight' },
  { sep: 'High Impact' },
  { id:'explosive', label:'Impact',    group:'High Impact' },
  { id:'electric',  label:'Electric',  group:'High Impact' },
  { id:'fire',      label:'Fire',      group:'High Impact' },
  { id:'bounce',    label:'Bounce',    group:'High Impact' },
  { id:'stark',     label:'Stark',     group:'High Impact' },
  { id:'glitch',    label:'Glitch',    group:'High Impact' },
  { id:'spotlight', label:'Spotlight', group:'High Impact' },
  { id:'duo',       label:'Duo',       group:'High Impact' },
  { sep: 'Studio Social' },
  { id:'marker',    label:'Marker',    group:'Studio Social' },
  { id:'signal',    label:'Signal',    group:'Studio Social' },
  { id:'prism',     label:'Prism',     group:'Studio Social' },
  { id:'halo',      label:'Halo',      group:'Studio Social' },
  { id:'ticker',    label:'Ticker',    group:'Studio Social' },
  { id:'poster',    label:'Poster',    group:'Studio Social' },
  { sep: 'Clean & Cinematic' },
  { id:'clean',     label:'Clean',     group:'Clean & Cinematic' },
  { id:'cinematic', label:'Cinematic', group:'Clean & Cinematic' },
  { id:'outline',   label:'Outline',   group:'Clean & Cinematic' },
  { id:'shadow',    label:'Shadow',    group:'Clean & Cinematic' },
  { id:'gold',      label:'Gold',      group:'Clean & Cinematic' },
  { id:'subtitle',  label:'Subtitle',  group:'Clean & Cinematic' },
];

export const STYLE_IDS: string[] = STYLE_LIST
  .filter((s): s is { id: string; label: string; group: OverlayStyle['group'] } => 'id' in s)
  .map((s) => s.id);

export const PYTHON_STYLE_CHOICES = [
  ...STYLE_IDS,
  'none',
];

export function getStyleDefaultPos(style: string): [number, number] {
  const def = OVERLAY_STYLES[style];
  if (def?.defaultPos) return def.defaultPos;
  if (style === 'classic' || style === 'clean') return [0.5, 0.12];
  if (style === 'bounce' || style === 'cinematic') return [0.5, 0.88];
  return [0.5, 0.80];
}
