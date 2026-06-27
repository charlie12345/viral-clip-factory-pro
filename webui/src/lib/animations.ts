export interface WordAnimation {
  id: string;
  label: string;
  entry?: string;       // CSS keyframe name
  dur?: string;         // '0.3s'
  easing?: string;
  stagger?: number;     // delay per word (s)
  active?: string;      // CSS keyframe for the highlighted word
  activeDur?: string;
  hint: string;
}

export const WORD_ANIMATIONS: Record<string, WordAnimation> = {
  none:       { id:'none',       label:'None',       hint:'Words appear instantly with no animation.' },
  popIn:      { id:'popIn',      label:'Pop In',     entry:'wordPopIn',     dur:'.3s',  easing:'cubic-bezier(.34,1.56,.64,1)', stagger:.06, hint:'Each word pops in with a spring bounce — fast and punchy.' },
  fadeIn:     { id:'fadeIn',     label:'Fade In',    entry:'wordFadeIn',    dur:'.35s', easing:'ease', stagger:.07, hint:'Words fade in softly from below — smooth and clean.' },
  slideUp:    { id:'slideUp',    label:'Slide Up',   entry:'wordSlideUp',   dur:'.3s',  easing:'ease', stagger:.06, hint:'Words slide up from below as they appear — great for impact.' },
  slideDown:  { id:'slideDown',  label:'Slide Down', entry:'wordSlideDown', dur:'.3s',  easing:'ease', stagger:.06, hint:'Words drop down from above — dynamic entry.' },
  flip:       { id:'flip',       label:'Flip In',    entry:'wordFlip',      dur:'.4s',  easing:'ease', stagger:.08, hint:'Words flip in from the side — cinematic.' },
  typewriter: { id:'typewriter', label:'Typewriter', entry:'wordTypewrite', dur:'.12s', easing:'ease', stagger:.22, hint:'Words appear one-by-one like typing — builds suspense.' },
  wave:       { id:'wave',       label:'Wave',       active:'wordWave',     activeDur:'.7s',  hint:'Highlighted word waves gently — looping effect.' },
  zoom:       { id:'zoom',       label:'Zoom',       active:'wordZoom',     activeDur:'.55s', hint:'Highlighted word pulses larger — draw attention.' },
  bounce:     { id:'bounce',     label:'Bounce',     active:'wordBounce',   activeDur:'.6s',  hint:'Highlighted word bounces up — energetic feel.' },
  shake:      { id:'shake',      label:'Shake',      active:'wordShake',    activeDur:'.35s', hint:'Highlighted word shakes side-to-side — intense.' },
  glow:       { id:'glow',       label:'Glow',       active:'wordGlow',     activeDur:'.8s',  hint:'Highlighted word glows bright — premium look.' },
};

export const ANIMATION_ORDER: string[] = [
  'none','popIn','fadeIn','slideUp','slideDown','flip','typewriter',
  'wave','zoom','bounce','shake','glow',
];

// CSS keyframes — injected once via a global <style> in main.tsx
export const ANIMATION_KEYFRAMES = `
@keyframes wordPopIn     { 0%{transform:scale(0) rotate(-5deg);opacity:0} 60%{transform:scale(1.25)} 100%{transform:scale(1);opacity:1} }
@keyframes wordFadeIn    { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
@keyframes wordSlideUp   { from{opacity:0;transform:translateY(18px)} to{opacity:1;transform:none} }
@keyframes wordSlideDown { from{opacity:0;transform:translateY(-18px)} to{opacity:1;transform:none} }
@keyframes wordZoom      { 0%,100%{transform:scale(1)} 50%{transform:scale(1.4)} }
@keyframes wordBounce    { 0%,100%{transform:translateY(0)} 45%{transform:translateY(-10px)} 65%{transform:translateY(-4px)} }
@keyframes wordShake     { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-5px)} 40%,80%{transform:translateX(5px)} }
@keyframes wordGlow      { 0%,100%{filter:brightness(1)} 50%{filter:brightness(1.7) drop-shadow(0 0 8px currentColor)} }
@keyframes wordFlip      { from{transform:rotateY(90deg);opacity:0} to{transform:rotateY(0deg);opacity:1} }
@keyframes wordTypewrite { from{opacity:0;transform:scale(.5)} to{opacity:1;transform:scale(1)} }
@keyframes wordWave      { 0%,100%{transform:translateY(0) rotate(0)} 25%{transform:translateY(-6px) rotate(-3deg)} 75%{transform:translateY(6px) rotate(3deg)} }
`;
