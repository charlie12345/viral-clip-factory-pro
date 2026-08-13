import { useState, type CSSProperties } from 'react';
import { Check, ChevronRight, Play, Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import { Modal } from '@/components/ui';
import { OVERLAY_STYLES, STYLE_LIST } from '@/lib/subtitle-styles';

interface CaptionStylePickerProps {
  value: string;
  onChange: (style: string) => void;
  label?: string;
  className?: string;
}

const SAMPLE_WORDS = ['MAKE', 'IT', 'MATTER', 'NOW'];

/**
 * A visual picker for short-form caption styles. The in-picker stage makes
 * the choice feel like a real short, while the individual thumbnails let a
 * user compare type, colour, motion, and placement at a glance.
 */
export function CaptionStylePicker({
  value,
  onChange,
  label = 'Caption Style',
  className,
}: CaptionStylePickerProps) {
  const [open, setOpen] = useState(false);
  const [previewStyleId, setPreviewStyleId] = useState(value);
  const selected = OVERLAY_STYLES[value];
  const selectedLabel = selected?.label || (value === 'none' ? 'No Captions' : 'Classic');

  function openPicker() {
    setPreviewStyleId(value);
    setOpen(true);
  }

  function choose(style: string) {
    setPreviewStyleId(style);
    onChange(style);
    setOpen(false);
  }

  return (
    <div className={clsx('min-w-0', className)}>
      <div className="label">{label}</div>
      <button
        type="button"
        className="group flex w-full min-w-0 items-center gap-3 rounded-xl border border-white/10 bg-black/25 p-2 text-left transition hover:border-brand-400/50 hover:bg-white/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        onClick={openPicker}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <CaptionStyleThumbnail styleId={value} className="h-16 w-12 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-white">{selectedLabel}</span>
          <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">Preview every caption style before rendering</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold text-brand-300 transition group-hover:text-brand-200">
          Browse <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Caption style studio"
        className="max-w-6xl"
        footer={<span className="mr-auto text-[11px] text-slate-500">Hover or focus a card to audition it here. Select a card to use it in the short.</span>}
      >
        <p className="text-xs leading-relaxed text-slate-400">Original caption treatments, built for fast mobile viewing. The short editor still lets you refine word animation, font, and position.</p>
        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(220px,0.62fr)_minmax(0,1.38fr)]">
          <CaptionStyleDemo styleId={previewStyleId} />
          <div className="min-w-0 max-h-[min(63vh,680px)] overflow-y-auto pr-1 scrollbar-thin">
            <StyleGrid value={value} previewStyleId={previewStyleId} onPreview={setPreviewStyleId} onChoose={choose} />
          </div>
        </div>
      </Modal>
    </div>
  );
}

function CaptionStyleDemo({ styleId }: { styleId: string }) {
  const style = OVERLAY_STYLES[styleId];
  const label = style?.label || 'No Captions';

  return (
    <aside className="overflow-hidden rounded-2xl border border-white/10 bg-[#080d18] p-3 shadow-2xl shadow-black/30" aria-label={`${label} caption preview`}>
      <div className="relative mx-auto aspect-[9/16] max-h-[430px] w-full max-w-[242px] overflow-hidden rounded-xl border border-white/10 bg-slate-950 shadow-xl">
        <CaptionStyleThumbnail styleId={styleId} variant="stage" className="h-full w-full rounded-none" />
        <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/35 px-2 py-1 text-[8px] font-bold uppercase tracking-[0.14em] text-white/75 backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,.9)]" /> Live preview
        </div>
        <div className="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded-full border border-white/15 bg-black/35 text-white/80 backdrop-blur">
          <Play className="ml-px h-3 w-3 fill-current" />
        </div>
      </div>
      <div className="mt-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-white">{label}</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{style ? `${style.group} · ${style.chunks} word cadence` : 'Render your short without a caption overlay'}</p>
        </div>
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-300" />
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.09]">
        <div className="caption-style-demo-progress h-full w-[62%] rounded-full bg-gradient-to-r from-brand-400 via-violet-400 to-fuchsia-400" />
      </div>
    </aside>
  );
}

function StyleGrid({
  value,
  previewStyleId,
  onPreview,
  onChoose,
}: {
  value: string;
  previewStyleId: string;
  onPreview: (style: string) => void;
  onChoose: (style: string) => void;
}) {
  const groups = STYLE_LIST.reduce<Array<{ label: string; styles: string[] }>>((all, item) => {
    if ('sep' in item) {
      all.push({ label: item.sep, styles: [] });
      return all;
    }
    const group = all.at(-1);
    if (group) group.styles.push(item.id);
    return all;
  }, []);

  return (
    <div className="space-y-5" role="radiogroup" aria-label="Caption style previews">
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{group.label}</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {group.styles.map((styleId) => {
              const style = OVERLAY_STYLES[styleId];
              const selected = value === styleId;
              const previewing = previewStyleId === styleId;
              return (
                <button
                  type="button"
                  key={styleId}
                  role="radio"
                  aria-checked={selected}
                  className={clsx(
                    'group relative min-w-0 overflow-hidden rounded-xl border bg-black/25 p-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
                    selected ? 'border-brand-300/80 bg-brand-500/10 shadow-[0_0_0_1px_rgba(125,211,252,0.25)]' : previewing ? 'border-violet-300/60 bg-violet-500/[0.06]' : 'border-white/10 hover:border-white/30 hover:bg-white/[0.045]',
                  )}
                  onPointerEnter={() => onPreview(styleId)}
                  onFocus={() => onPreview(styleId)}
                  onClick={() => onChoose(styleId)}
                >
                  <CaptionStyleThumbnail styleId={styleId} />
                  <span className="mt-1.5 flex items-center justify-between gap-1">
                    <span className="block truncate text-[11px] font-semibold text-slate-200">{style.label}</span>
                    {previewing && !selected && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-300" aria-label="Previewing" />}
                  </span>
                  {selected && <Check className="absolute right-2 top-2 h-3.5 w-3.5 rounded-full bg-brand-400 p-0.5 text-slate-950" aria-label="Selected" />}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      <section aria-label="No captions">
        <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">No overlay</h3>
        <button
          type="button"
          role="radio"
          aria-checked={value === 'none'}
          className={clsx(
            'relative w-full max-w-[170px] overflow-hidden rounded-xl border bg-black/25 p-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
            value === 'none' ? 'border-brand-300/80 bg-brand-500/10 shadow-[0_0_0_1px_rgba(125,211,252,0.25)]' : previewStyleId === 'none' ? 'border-violet-300/60 bg-violet-500/[0.06]' : 'border-white/10 hover:border-white/30 hover:bg-white/[0.045]',
          )}
          onPointerEnter={() => onPreview('none')}
          onFocus={() => onPreview('none')}
          onClick={() => onChoose('none')}
        >
          <CaptionStyleThumbnail styleId="none" />
          <span className="mt-1.5 block text-[11px] font-semibold text-slate-200">No Captions</span>
          {value === 'none' && <Check className="absolute right-2 top-2 h-3.5 w-3.5 rounded-full bg-brand-400 p-0.5 text-slate-950" aria-label="Selected" />}
        </button>
      </section>
    </div>
  );
}

export function CaptionStyleThumbnail({
  styleId,
  className,
  variant = 'tile',
}: {
  styleId: string;
  className?: string;
  variant?: 'tile' | 'stage';
}) {
  const style = OVERLAY_STYLES[styleId];
  const isStage = variant === 'stage';
  if (!style) {
    return (
      <div className={clsx('relative aspect-[9/12] w-full overflow-hidden rounded-md bg-[radial-gradient(circle_at_70%_30%,rgba(71,85,105,.45),transparent_24%),linear-gradient(145deg,#111827,#020617)]', isStage && 'aspect-[9/16]', className)} aria-hidden="true">
        <span className="absolute inset-0 grid place-items-center px-4 text-center text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">Caption overlay<br />off</span>
      </div>
    );
  }

  const fontSize = isStage ? 27 : 12;
  const font = style.font.replace('1em', `${fontSize}px`);
  const outlineSize = isStage ? Math.max(1, Math.round(style.op * 1.2)) : style.op;
  const textShadow = outlineSize > 0 && style.outline !== 'none'
    ? `-${outlineSize}px -${outlineSize}px 0 ${style.outline},${outlineSize}px -${outlineSize}px 0 ${style.outline},-${outlineSize}px ${outlineSize}px 0 ${style.outline},${outlineSize}px ${outlineSize}px 0 ${style.outline}`
    : style.ts || 'none';
  const words = SAMPLE_WORDS.slice(0, Math.min(style.chunks, SAMPLE_WORDS.length));

  return (
    <div
      className={clsx('caption-style-scene relative aspect-[9/12] w-full overflow-hidden rounded-md bg-[radial-gradient(circle_at_72%_20%,rgba(94,234,212,.35),transparent_22%),radial-gradient(circle_at_18%_76%,rgba(167,139,250,.25),transparent_28%),linear-gradient(145deg,#172033_0%,#334155_45%,#111827_100%)]', isStage && 'aspect-[9/16]', className)}
      data-preview-motion={style.previewMotion || 'default'}
      aria-hidden="true"
    >
      <div className="caption-style-scene-light absolute -right-[18%] -top-[10%] h-[46%] w-[72%] rounded-full bg-cyan-300/20 blur-3xl" />
      <div className="caption-style-scene-card absolute inset-x-[9%] top-[12%] h-[29%] rounded-xl border border-white/[0.08] bg-white/[0.07] backdrop-blur-[1px]" />
      <div className="absolute bottom-0 left-0 h-[52%] w-[70%] bg-gradient-to-tr from-black/65 via-black/20 to-transparent" />
      {isStage && <div className="absolute inset-x-[12%] top-[18%] h-px bg-white/20" />}
      <div
        className="caption-style-preview-copy absolute z-10 text-center leading-[1.15]"
        style={{
          left: '8%',
          top: `${(style.defaultPos?.[1] ?? 0.8) * 100}%`,
          width: '84%',
          transform: 'translateY(-50%)',
          font,
          color: style.color,
          textShadow,
          ...(style.bg && style.bg !== 'none' ? { background: style.bg, padding: isStage ? '5px 7px' : '2px 3px', borderRadius: isStage ? 4 : 2 } : {}),
          textTransform: style.upper ? 'uppercase' : 'none',
          letterSpacing: style.ls || 'normal',
        }}
      >
        {words.map((word, index) => (
          <span
            key={word}
            className="caption-style-preview-word inline-block"
            style={{
              '--caption-base': style.color,
              '--caption-highlight': style.hi[index % style.hi.length],
              '--caption-delay': `${index * -0.34}s`,
              marginRight: index === words.length - 1 ? 0 : (isStage ? 7 : 3),
            } as CSSProperties}
          >
            {style.upper ? word : word[0] + word.slice(1).toLowerCase()}
          </span>
        ))}
      </div>
      <Sparkles className={clsx('absolute right-[12%] top-[13%] text-white/45', isStage ? 'h-5 w-5' : 'h-3 w-3')} />
    </div>
  );
}
