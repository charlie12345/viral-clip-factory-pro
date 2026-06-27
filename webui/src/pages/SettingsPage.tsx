import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Save, RotateCcw, FolderOpen, Sparkles, Eye, EyeOff, Server } from 'lucide-react';
import { clsx } from 'clsx';
import { api, type Profile } from '@/api/client';
import { useUIStore } from '@/store/ui';
import { DEFAULT_RENDER_SETTINGS, FRAMING_MODES, MAX_CLIPS, MAX_DURATIONS } from '@/lib/render-options';
import type { RenderSettings } from '@/lib/render-options';
import { STYLE_LIST, PYTHON_STYLE_CHOICES } from '@/lib/subtitle-styles';
import { SEGMENT_PRESETS } from '@/lib/render-options';

export function SettingsPage() {
  const qc = useQueryClient();
  const uploadDefaults = useUIStore((s) => s.uploadDefaults);
  const setUploadDefaults = useUIStore((s) => s.setUploadDefaults);
  const keepAwake = useUIStore((s) => s.keepAwake);
  const setKeepAwake = useUIStore((s) => s.setKeepAwake);
  const preferredStyle = useUIStore((s) => s.preferredStyle);
  const setPreferredStyle = useUIStore((s) => s.setPreferredStyle);
  const preferredAnimation = useUIStore((s) => s.preferredAnimation);
  const setPreferredAnimation = useUIStore((s) => s.setPreferredAnimation);

  const { data: profiles = [] } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.listProfiles(),
  });
  const { data: serverSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const [newName, setNewName] = useState('');
  const [newSettings, setNewSettings] = useState<RenderSettings>(uploadDefaults);

  const save = useMutation({
    mutationFn: (p: Profile) => api.saveProfile(p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles'] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteProfile(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles'] }),
  });

  function applyProfile(p: Profile) {
    setUploadDefaults(p.settings);
  }

  function saveCurrent() {
    if (!newName.trim()) return;
    const id = newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    save.mutate({
      id,
      name: newName.trim(),
      settings: newSettings,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    setNewName('');
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8 space-y-6">
      <header>
        <h1 className="text-3xl font-black tracking-tight text-white">Settings</h1>
        <p className="mt-1 text-sm text-slate-400">Upload defaults, render profiles, and editor preferences.</p>
      </header>

      {/* Editor preferences */}
      <section className="panel p-5 space-y-4">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent-pink" /> Editor preferences
        </h2>
        <p className="text-[12px] text-slate-500 -mt-3">These default to whatever you last used in the editor.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <div className="label">Default Caption Style</div>
            <select className="input" value={preferredStyle} onChange={(e) => setPreferredStyle(e.target.value)}>
              {STYLE_LIST.map((s) => 'sep' in s ? null : <option key={s.id} value={s.id}>{s.label}</option>)}
              <option value="none">No Captions</option>
            </select>
          </div>
          <div>
            <div className="label">Default Word Animation</div>
            <select className="input" value={preferredAnimation} onChange={(e) => setPreferredAnimation(e.target.value)}>
              {['none','popIn','fadeIn','slideUp','slideDown','flip','typewriter','wave','zoom','bounce','shake','glow'].map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="label">Behavior</div>
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" className="h-4 w-4 rounded accent-pink-500" checked={keepAwake} onChange={(e) => setKeepAwake(e.target.checked)} />
              Keep screen awake during uploads
            </label>
          </div>
        </div>
      </section>

      {/* Upload defaults */}
      <section className="panel p-5 space-y-4">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <Save className="h-4 w-4 text-accent-blue" /> Upload defaults
        </h2>
        <p className="text-[12px] text-slate-500 -mt-3">Used when you start a new render from the Dashboard.</p>
        <RenderSettingsEditor value={uploadDefaults} onChange={setUploadDefaults} />
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={() => setUploadDefaults(DEFAULT_RENDER_SETTINGS)}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset to factory
          </button>
        </div>
      </section>

      {/* Profiles */}
      <section className="panel p-5 space-y-4">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-accent-violet" /> Render profiles
        </h2>
        <p className="text-[12px] text-slate-500 -mt-3">Save combinations of mode, style, duration, and clip count as one-click presets.</p>

        {profiles.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-sm text-slate-500">
            No profiles yet. Save one below to get started.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {profiles.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-white/5 bg-black/30 p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-white">{p.name}</div>
                  <div className="text-[10px] text-slate-500">
                    {p.settings.mode} · {p.settings.framingMode || 'auto'} · {p.settings.subtitleStyle} · {p.settings.maxDuration}s · {p.settings.maxClips} clips
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    className="rounded-md bg-white/5 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10"
                    onClick={() => applyProfile(p)}
                  >Apply</button>
                  <button
                    className="rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/20"
                    onClick={() => { if (confirm(`Delete profile "${p.name}"?`)) del.mutate(p.id); }}
                  ><Trash2 className="h-3 w-3" /></button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* New profile form */}
        <div className="rounded-lg border border-white/5 bg-black/20 p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
            <input
              className="input"
              placeholder="Profile name (e.g. “Podcast Shorts”)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="btn-primary" disabled={!newName.trim() || save.isPending} onClick={saveCurrent}>
              <Plus className="h-3.5 w-3.5" /> Save
            </button>
          </div>
          <details>
            <summary className="cursor-pointer text-[12px] text-slate-400 hover:text-slate-300">Use custom settings for this profile</summary>
            <div className="mt-3">
              <RenderSettingsEditor value={newSettings} onChange={setNewSettings} />
            </div>
          </details>
        </div>
      </section>

      {/* Server info */}
      {serverSettings && (
        <section className="panel p-5 space-y-2">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Server className="h-4 w-4 text-slate-400" /> Server
          </h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
            {Object.entries(serverSettings).map(([k, v]) => (
              <div key={k} className="flex justify-between rounded-md bg-black/20 px-3 py-1.5">
                <dt className="text-slate-500">{k}</dt>
                <dd className="font-mono text-slate-200">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

function RenderSettingsEditor({ value, onChange }: { value: RenderSettings; onChange: (s: RenderSettings) => void }) {
  function set<K extends keyof RenderSettings>(k: K, v: RenderSettings[K]) {
    onChange({ ...value, [k]: v });
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <div>
        <div className="label">Mode</div>
        <div className="grid grid-cols-2 gap-1">
          {(['shorts', 'longform'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => set('mode', m)}
              className={clsx(
                'rounded-md px-2 py-1.5 text-xs font-semibold transition',
                value.mode === m ? 'bg-brand-500/25 text-white ring-1 ring-brand-500/40' : 'bg-white/5 text-slate-300 hover:bg-white/10',
              )}
            >{m === 'shorts' ? 'Shorts' : 'Long'}</button>
          ))}
        </div>
      </div>
      {value.mode === 'shorts' && (
        <div>
          <div className="label">Shorts Framing</div>
          <select className="input" value={value.framingMode || 'auto'} onChange={(e) => set('framingMode', e.target.value as RenderSettings['framingMode'])}>
            {FRAMING_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
          </select>
        </div>
      )}
      <div>
        <div className="label">Max Duration</div>
        <select className="input" value={value.maxDuration} onChange={(e) => set('maxDuration', parseInt(e.target.value))}>
          {MAX_DURATIONS.map((d) => <option key={d} value={d}>{d >= 60 ? `${d / 60} min` : `${d}s`}</option>)}
        </select>
      </div>
      <div>
        <div className="label">Max Clips</div>
        <select className="input" value={value.maxClips} onChange={(e) => set('maxClips', parseInt(e.target.value))}>
          {MAX_CLIPS.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div>
        <div className="label">Caption Style</div>
        <select className="input" value={value.subtitleStyle} onChange={(e) => set('subtitleStyle', e.target.value)}>
          {STYLE_LIST.map((s) => 'sep' in s ? null : <option key={s.id} value={s.id}>{s.label}</option>)}
          <option value="none">No Captions</option>
        </select>
      </div>
      <div>
        <div className="label">Time Segment</div>
        <select
          className="input"
          value={value.startTime === '' && value.endTime === '' ? 'full' :
                 value.startTime === '0' && value.endTime === '60' ? 'first60' :
                 value.startTime === '0' && value.endTime === '180' ? 'first180' :
                 'custom'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'custom') return;
            const p = SEGMENT_PRESETS.find((p) => p.id === v);
            if (p) { set('startTime', p.startTime); set('endTime', p.endTime); }
          }}
        >
          {SEGMENT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="custom">Custom…</option>
        </select>
      </div>
      <div>
        <div className="label">Upscale</div>
        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input type="checkbox" className="h-4 w-4 rounded accent-pink-500" checked={value.upscale} onChange={(e) => set('upscale', e.target.checked)} />
          8K upscaling
        </label>
      </div>
    </div>
  );
}
