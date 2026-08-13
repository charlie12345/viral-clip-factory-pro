import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Save, RotateCcw, FolderOpen, Sparkles, Server, Cpu, Gauge, KeyRound, ShieldCheck } from 'lucide-react';
import { clsx } from 'clsx';
import { api, type Profile, type ProviderSecretSource, type ProviderSettingsUpdate } from '@/api/client';
import { StorageManagerPanel } from '@/components/admin/StorageManagerPanel';
import { Button, ConfirmDialog, NumberField, Panel, Select, ToggleGroup } from '@/components/ui';
import { CaptionStylePicker } from '@/components/captions/CaptionStylePicker';
import { useUIStore } from '@/store/ui';
import { toast } from '@/store/toasts';
import { CLIP_VOLUME_OPTIONS, DEFAULT_RENDER_SETTINGS, EXPORT_PRESETS, FRAMING_MODES, MAX_CLIPS, MAX_DURATIONS } from '@/lib/render-options';
import type { RenderSettings } from '@/lib/render-options';
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
  const capabilities = useQuery({
    queryKey: ['system-capabilities'],
    queryFn: () => api.systemCapabilities(),
    staleTime: 30_000,
  });

  const [newName, setNewName] = useState('');
  const [newSettings, setNewSettings] = useState<RenderSettings>(uploadDefaults);

  const save = useMutation({
    mutationFn: (p: Profile) => api.saveProfile(p),
    onSuccess: (_result, p) => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      toast('success', `Profile "${p.name}" saved`);
    },
    onError: (error) => {
      toast('error', 'Profile could not be saved', (error as Error).message);
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteProfile(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      toast('info', 'Profile deleted');
    },
    onError: (error) => {
      toast('error', 'Profile could not be deleted', (error as Error).message);
    },
  });
  const saveDefaults = useMutation({
    mutationFn: () => api.saveSettings(uploadDefaults),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast('success', 'Upload defaults saved');
    },
    onError: (error) => {
      toast('error', 'Defaults were not saved', (error as Error).message);
    },
  });

  function applyProfile(p: Profile) {
    setUploadDefaults({ ...DEFAULT_RENDER_SETTINGS, ...p.settings });
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
        <p className="mt-1 text-sm text-slate-400">Upload defaults, provider credentials, render profiles, and editor preferences.</p>
      </header>

      {/* Editor preferences */}
      <Panel className="p-5 space-y-4">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent-pink" /> Editor preferences
        </h2>
        <p className="text-[12px] text-slate-500 -mt-3">These default to whatever you last used in the editor.</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 md:grid-cols-1 lg:grid-cols-3">
          <div>
            <CaptionStylePicker value={preferredStyle} onChange={setPreferredStyle} label="Default Caption Style" />
          </div>
          <div>
            <div className="label">Default Word Animation</div>
            <Select value={preferredAnimation} onChange={(e) => setPreferredAnimation(e.target.value)}>
              {['none','popIn','fadeIn','slideUp','slideDown','flip','typewriter','wave','zoom','bounce','shake','glow'].map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </Select>
          </div>
          <div>
            <div className="label">Behavior</div>
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" className="h-4 w-4 rounded accent-pink-500" checked={keepAwake} onChange={(e) => setKeepAwake(e.target.checked)} />
              Keep screen awake during uploads
            </label>
          </div>
        </div>
      </Panel>

      {/* Upload defaults */}
      <Panel className="p-5 space-y-4">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <Save className="h-4 w-4 text-accent-blue" /> Upload defaults
        </h2>
        <p className="text-[12px] text-slate-500 -mt-3">Used when you start a new render from the Dashboard.</p>
        <RenderSettingsEditor value={uploadDefaults} onChange={setUploadDefaults} />
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={saveDefaults.isPending} onClick={() => saveDefaults.mutate()}>
            {saveDefaults.isPending ? 'Saving…' : 'Save defaults'}
          </Button>
          <Button variant="secondary" onClick={() => setUploadDefaults(DEFAULT_RENDER_SETTINGS)}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset to factory
          </Button>
          {saveDefaults.isSuccess && <span role="status" className="text-[11px] text-emerald-300">Browser and server defaults match.</span>}
          {saveDefaults.isError && <span className="text-[11px] text-red-300" role="alert">Defaults were not saved: {(saveDefaults.error as Error).message}</span>}
        </div>
      </Panel>

      <ProviderCredentialsSection />

      {/* Hardware capability probe */}
      <Panel className="p-5 space-y-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Cpu className="h-4 w-4 text-accent-blue" /> Hardware acceleration
          </h2>
          {capabilities.data && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
              {capabilities.data.platform} · {capabilities.data.machine}
            </span>
          )}
        </div>
        {capabilities.isLoading ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
            {[0, 1].map((item) => <div key={item} className="h-20 animate-pulse rounded-lg bg-white/5" />)}
          </div>
        ) : capabilities.error ? (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            Hardware probe failed: {(capabilities.error as Error).message}
          </div>
        ) : capabilities.data ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] md:grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
              <div className="divide-y divide-white/5 rounded-lg border border-white/5 bg-black/20">
                {capabilities.data.compute.map((item) => (
                  <div key={item.backend} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-100">{item.label}</div>
                      <div className="mt-0.5 break-all font-mono text-[10px] text-slate-500">{item.device_name || item.backend}</div>
                    </div>
                    <CapabilityState available={item.available} />
                  </div>
                ))}
              </div>
              <div className="divide-y divide-white/5 rounded-lg border border-white/5 bg-black/20">
                {capabilities.data.videoEncoders.map((item) => (
                  <div key={item.backend} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5" title={item.reason || undefined}>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-100">{item.label}</div>
                      <div className="mt-0.5 break-all font-mono text-[10px] text-slate-500">{item.h264_encoder}</div>
                    </div>
                    <CapabilityState available={item.available} />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="label">Analysis Providers</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
                {[...(capabilities.data.transcriptionProviders || []), ...(capabilities.data.viralProviders || [])].map((item) => (
                  <div key={item.id} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2.5" title={item.reason || undefined}>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-100">{item.label}</div>
                      <div className="mt-0.5 text-[10px] text-slate-500">{item.cloud ? 'Cloud · explicit opt-in' : 'Runs locally'}</div>
                    </div>
                    <CapabilityState available={item.available} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        <p className="text-[11px] leading-relaxed text-slate-500">
          Auto mode runs a real encoder probe before each process starts. Compiled encoders that cannot access hardware are skipped.
        </p>
      </Panel>

      {/* Profiles */}
      <Panel className="p-5 space-y-4">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-accent-violet" /> Render profiles
        </h2>
        <p className="text-[12px] text-slate-500 -mt-3">Save combinations of mode, style, duration, and clip count as one-click presets.</p>

        {profiles.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-sm text-slate-500">
            No profiles yet. Save one below to get started.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
            {profiles.map((p) => (
              <div key={p.id} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-white/5 bg-black/30 p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-white">{p.name}</div>
                  <div className="break-words text-[10px] text-slate-500 [overflow-wrap:anywhere]">
                    {p.settings.mode}{p.settings.mode === 'shorts' ? ` · ${p.settings.subtitleStyle}` : ''}
                    {p.settings.mode === 'shorts' && ` · ${p.settings.framingMode || 'auto'} · ${p.settings.maxDuration}s · ${p.settings.clipVolume || 'balanced'} · cap ${p.settings.maxClips}`}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
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
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] md:grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto]">
            <input
              className="input"
              placeholder="Profile name (e.g. “Podcast Shorts”)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button variant="primary" disabled={!newName.trim() || save.isPending} onClick={saveCurrent}>
              <Plus className="h-3.5 w-3.5" /> Save
            </Button>
          </div>
          <details>
            <summary className="cursor-pointer text-[12px] text-slate-400 hover:text-slate-300">Use custom settings for this profile</summary>
            <div className="mt-3">
              <RenderSettingsEditor value={newSettings} onChange={setNewSettings} />
            </div>
          </details>
        </div>
      </Panel>

      <StorageManagerPanel />

      {/* Server info */}
      {serverSettings && (
        <Panel className="p-5 space-y-2">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Server className="h-4 w-4 text-slate-400" /> Server
          </h2>
          <dl className="grid grid-cols-1 gap-2 text-[12px] sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
            {Object.entries(serverSettings).map(([k, v]) => (
              <div key={k} className="flex min-w-0 items-start justify-between gap-3 overflow-hidden rounded-md bg-black/20 px-3 py-1.5">
                <dt className="min-w-0 break-words text-slate-500">{k}</dt>
                <dd className="min-w-0 max-w-full break-all text-right font-mono text-slate-200" title={String(v)}>{String(v)}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      )}
    </div>
  );
}

type ProviderMutationInput = {
  payload: ProviderSettingsUpdate;
  successMessage: string;
  clearInputs?: Array<'deepgram' | 'gemini' | 'local'>;
  resetEndpointDrafts?: boolean;
};

const PROVIDER_LABELS = {
  deepgram: 'Deepgram',
  gemini: 'Gemini',
  local: 'local endpoint',
} as const;

function ProviderCredentialsSection() {
  const qc = useQueryClient();
  const providerSettings = useQuery({
    queryKey: ['provider-settings'],
    queryFn: () => api.getProviderSettings(),
  });

  // Secret inputs deliberately live only in component memory. They never enter
  // the persisted UI store or browser storage.
  const [deepgramApiKey, setDeepgramApiKey] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [localLlmApiKey, setLocalLlmApiKey] = useState('');
  const [localLlmUrlDraft, setLocalLlmUrlDraft] = useState<string | undefined>();
  const [localLlmModelDraft, setLocalLlmModelDraft] = useState<string | undefined>();
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [pendingKeyRemoval, setPendingKeyRemoval] = useState<'deepgram' | 'gemini' | 'local' | null>(null);

  const updateProvider = useMutation({
    mutationFn: ({ payload }: ProviderMutationInput) => api.saveProviderSettings(payload),
    onMutate: () => setSuccessMessage(null),
    onSuccess: async (data, variables) => {
      qc.setQueryData(['provider-settings'], data);
      if (variables.clearInputs?.includes('deepgram')) setDeepgramApiKey('');
      if (variables.clearInputs?.includes('gemini')) setGeminiApiKey('');
      if (variables.clearInputs?.includes('local')) setLocalLlmApiKey('');
      if (variables.resetEndpointDrafts) {
        setLocalLlmUrlDraft(undefined);
        setLocalLlmModelDraft(undefined);
      }
      setSuccessMessage(variables.successMessage);
      toast('success', variables.successMessage);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['provider-settings'] }),
        qc.invalidateQueries({ queryKey: ['system-capabilities'] }),
      ]);
    },
    onError: (error) => {
      toast('error', 'Provider settings were not saved', (error as Error).message);
    },
  });

  const data = providerSettings.data;
  const localLlmUrl = localLlmUrlDraft ?? data?.localSemantic.url ?? '';
  const localLlmModel = localLlmModelDraft ?? data?.localSemantic.model ?? '';
  const currentEndpointOrigin = safeUrlOrigin(data?.localSemantic.url || '');
  const nextEndpointOrigin = safeUrlOrigin(localLlmUrl);
  const endpointNeedsReplacementKey = Boolean(
    data?.localSemantic.apiKeyConfigured
    && nextEndpointOrigin
    && nextEndpointOrigin !== currentEndpointOrigin
    && !localLlmApiKey.trim(),
  );
  const hasDraftChanges = Boolean(
    deepgramApiKey.trim()
    || geminiApiKey.trim()
    || localLlmApiKey.trim()
    || localLlmUrlDraft !== undefined
    || localLlmModelDraft !== undefined,
  );

  function submitProviderSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload: ProviderSettingsUpdate = {};
    // Only send endpoint fields the user actually edited. This avoids copying
    // environment-managed values into the saved override file when someone is
    // merely adding a Gemini or Deepgram key.
    if (localLlmUrlDraft !== undefined) payload.localLlmUrl = localLlmUrlDraft.trim();
    if (localLlmModelDraft !== undefined) payload.localLlmModel = localLlmModelDraft.trim();
    if (deepgramApiKey.trim()) payload.deepgramApiKey = deepgramApiKey.trim();
    if (geminiApiKey.trim()) payload.geminiApiKey = geminiApiKey.trim();
    if (localLlmApiKey.trim()) payload.localLlmApiKey = localLlmApiKey.trim();

    updateProvider.mutate({
      payload,
      successMessage: 'Provider settings saved. New render jobs will use the updated configuration.',
      clearInputs: ['deepgram', 'gemini', 'local'],
      resetEndpointDrafts: true,
    });
  }

  function clearSavedKey(provider: 'deepgram' | 'gemini' | 'local') {
    const labels = PROVIDER_LABELS;
    const payload: ProviderSettingsUpdate = provider === 'deepgram'
      ? { clearDeepgramApiKey: true }
      : provider === 'gemini'
        ? { clearGeminiApiKey: true }
        : { clearLocalLlmApiKey: true };
    updateProvider.mutate({
      payload,
      successMessage: `${labels[provider][0].toUpperCase()}${labels[provider].slice(1)} API key removed.`,
      clearInputs: [provider],
    });
  }

  return (
    <Panel className="p-5 space-y-4" aria-labelledby="provider-credentials-heading">
      <div>
        <h2 id="provider-credentials-heading" className="flex items-center gap-2 text-sm font-bold text-white">
          <KeyRound className="h-4 w-4 text-accent-blue" /> Provider credentials
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
          Connect optional cloud analysis services and your OpenAI-compatible local model endpoint.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-emerald-500/15 bg-emerald-500/[0.06] px-3 py-2.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
        <p className="text-[11px] leading-relaxed text-slate-400">
          The app saves keys in a permission-restricted server file and does not add them to its browser storage. Your browser or extensions may still offer to retain form entries. This dashboard has no sign-in layer, so limit access to trusted tailnet members. Saving a key does not enable cloud uploads: Deepgram must be selected as the transcription engine, and Gemini video analysis must be enabled for a render.
        </p>
      </div>

      {providerSettings.isLoading ? (
        <div className="space-y-3" aria-label="Loading provider settings">
          <div className="h-24 animate-pulse rounded-lg bg-white/5" />
          <div className="h-32 animate-pulse rounded-lg bg-white/5" />
        </div>
      ) : providerSettings.error ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3 text-xs text-red-300" role="alert">
          <p>Provider settings could not be loaded: {(providerSettings.error as Error).message}</p>
          <button
            type="button"
            className="mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 font-semibold text-red-200 transition hover:bg-red-500/20 active:scale-[0.98]"
            onClick={() => providerSettings.refetch()}
          >
            Try again
          </button>
        </div>
      ) : data ? (
        <form className="space-y-4" onSubmit={submitProviderSettings}>
          <div className="divide-y divide-white/5 overflow-hidden rounded-lg border border-white/5 bg-black/20">
            <div className="space-y-4 p-4">
              <div>
                <div className="text-xs font-semibold text-slate-100">Cloud providers</div>
                <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">Leave a key field empty to keep the current key. Entering a value replaces it.</p>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
                <ProviderCredentialField
                  id="deepgram-api-key"
                  label="Deepgram API key"
                  description="Used only when Deepgram Nova-3 is selected for transcription."
                  value={deepgramApiKey}
                  onChange={setDeepgramApiKey}
                  configured={data.deepgram.configured}
                  source={data.deepgram.source}
                  disabled={updateProvider.isPending}
                  onClear={() => setPendingKeyRemoval('deepgram')}
                />
                <ProviderCredentialField
                  id="gemini-api-key"
                  label="Gemini API key"
                  description="Used only for explicitly enabled Gemini video analysis."
                  value={geminiApiKey}
                  onChange={setGeminiApiKey}
                  configured={data.gemini.configured}
                  source={data.gemini.source}
                  disabled={updateProvider.isPending}
                  onClear={() => setPendingKeyRemoval('gemini')}
                />
              </div>
            </div>

            <div className="space-y-4 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-slate-100">Local semantic endpoint</div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">For llama.cpp, Ollama, LM Studio, or another OpenAI-compatible server.</p>
                </div>
                <ProviderSourceBadge configured={data.localSemantic.apiKeyConfigured} source={data.localSemantic.apiKeySource} />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.6fr)] md:grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,0.6fr)]">
                <div className="space-y-2">
                  <label className="label" htmlFor="local-llm-url">Endpoint URL</label>
                  <input
                    id="local-llm-url"
                    className="input font-mono"
                    type="url"
                    placeholder="http://127.0.0.1:8080/v1/chat/completions"
                    value={localLlmUrl}
                    disabled={updateProvider.isPending}
                    onChange={(event) => setLocalLlmUrlDraft(event.target.value)}
                    aria-describedby="local-llm-url-help"
                  />
                  <p id="local-llm-url-help" className="text-[10px] leading-relaxed text-slate-500">Use the full chat-completions endpoint exposed by your local server.</p>
                  {endpointNeedsReplacementKey && (
                    <p className="text-[10px] leading-relaxed text-amber-300" role="alert">
                      This changes the endpoint origin. Re-enter its API key below so an existing credential can never be forwarded to a different server.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="label" htmlFor="local-llm-model">Model name</label>
                  <input
                    id="local-llm-model"
                    className="input font-mono"
                    type="text"
                    placeholder="local-model"
                    value={localLlmModel}
                    disabled={updateProvider.isPending}
                    onChange={(event) => setLocalLlmModelDraft(event.target.value)}
                    aria-describedby="local-llm-model-help"
                  />
                  <p id="local-llm-model-help" className="text-[10px] leading-relaxed text-slate-500">Must match the model identifier accepted by the endpoint.</p>
                </div>
              </div>
              <ProviderCredentialField
                id="local-llm-api-key"
                label="Endpoint API key (optional)"
                description="Leave empty for local servers that do not require bearer authentication."
                value={localLlmApiKey}
                onChange={setLocalLlmApiKey}
                configured={data.localSemantic.apiKeyConfigured}
                source={data.localSemantic.apiKeySource}
                disabled={updateProvider.isPending}
                onClear={() => setPendingKeyRemoval('local')}
                hideStatus
              />
            </div>
          </div>

          <div aria-live="polite">
            {successMessage && !updateProvider.error && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                {successMessage}
              </div>
            )}
            {updateProvider.error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
                Settings were not saved: {(updateProvider.error as Error).message}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end">
            <Button
              type="submit"
              variant="primary"
              className="active:scale-[0.98]"
              disabled={!hasDraftChanges || endpointNeedsReplacementKey || updateProvider.isPending}
            >
              <Save className="h-3.5 w-3.5" /> {updateProvider.isPending ? 'Saving…' : 'Save provider settings'}
            </Button>
          </div>
        </form>
      ) : null}

      <ConfirmDialog
        open={pendingKeyRemoval !== null}
        title="Remove saved API key?"
        body={pendingKeyRemoval
          ? `The saved ${PROVIDER_LABELS[pendingKeyRemoval]} API key is deleted from this server. Renders that need it will fail until a new key is saved.`
          : undefined}
        confirmLabel="Remove key"
        danger
        confirmDisabled={updateProvider.isPending}
        onCancel={() => setPendingKeyRemoval(null)}
        onConfirm={() => {
          const provider = pendingKeyRemoval;
          setPendingKeyRemoval(null);
          if (provider) clearSavedKey(provider);
        }}
      />
    </Panel>
  );
}

function ProviderCredentialField({
  id,
  label,
  description,
  value,
  onChange,
  configured,
  source,
  disabled,
  onClear,
  hideStatus = false,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  configured: boolean;
  source: ProviderSecretSource;
  disabled: boolean;
  onClear: () => void;
  hideStatus?: boolean;
}) {
  const helpId = `${id}-help`;
  return (
    <div className="space-y-2">
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-2">
        <label className="label mb-0" htmlFor={id}>{label}</label>
        {!hideStatus && <ProviderSourceBadge configured={configured} source={source} />}
      </div>
      <input
        id={id}
        className="input font-mono"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={configured ? 'Configured — enter a replacement key' : 'Paste API key'}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={helpId}
      />
      <div className="flex min-h-6 min-w-0 items-start justify-between gap-3">
        <p id={helpId} className="min-w-0 break-words text-[10px] leading-relaxed text-slate-500">{description}</p>
        {source === 'saved' ? (
          <button
            type="button"
            className="shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold text-red-400 transition hover:bg-red-500/10 hover:text-red-300 active:scale-[0.98]"
            disabled={disabled}
            onClick={onClear}
          >
            Clear saved key
          </button>
        ) : source === 'environment' ? (
          <span className="shrink-0 text-right text-[10px] text-slate-500">Managed by environment</span>
        ) : null}
      </div>
    </div>
  );
}

function safeUrlOrigin(value: string) {
  if (!value.trim()) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function ProviderSourceBadge({ configured, source }: { configured: boolean; source: ProviderSecretSource }) {
  const label = !configured ? 'Not configured' : source === 'saved' ? 'Saved on server' : source === 'environment' ? 'Environment' : 'Configured';
  return (
    <span className={clsx(
      'inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1',
      configured
        ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25'
        : 'bg-white/5 text-slate-500 ring-white/5',
    )}>
      {label}
    </span>
  );
}

function RenderSettingsEditor({ value, onChange }: { value: RenderSettings; onChange: (s: RenderSettings) => void }) {
  function set<K extends keyof RenderSettings>(k: K, v: RenderSettings[K]) {
    onChange({ ...value, [k]: v });
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-3">
      <ToggleGroup
        label="Mode"
        columns={2}
        gapClassName="gap-1"
        inactiveClassName="bg-white/5 text-slate-300 hover:bg-white/10"
        options={[
          { value: 'shorts', label: 'Shorts' },
          { value: 'longform', label: 'Long' },
        ]}
        value={value.mode}
        onChange={(m) => set('mode', m)}
      />
      <div>
        <div className="label">Export Target</div>
        <Select
          value={value.exportPreset}
          onChange={(e) => {
            const exportPreset = e.target.value as RenderSettings['exportPreset'];
            const preset = EXPORT_PRESETS.find((item) => item.id === exportPreset);
            onChange({ ...value, exportPreset, maxDuration: preset?.defaultMaxDuration || value.maxDuration });
          }}
        >
          {EXPORT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </Select>
        <p className="mt-1 text-[10px] text-slate-500">{EXPORT_PRESETS.find((item) => item.id === value.exportPreset)?.detail}</p>
      </div>
      <div>
        <div className="label">Compute</div>
        <Select value={value.computeDevice} onChange={(e) => set('computeDevice', e.target.value as RenderSettings['computeDevice'])}>
          <option value="auto">Auto detect</option>
          <option value="rocm">AMD ROCm</option>
          <option value="cuda">NVIDIA CUDA</option>
          <option value="cpu">CPU</option>
        </Select>
      </div>
      <div>
        <div className="label">Video Encoder</div>
        <Select value={value.videoEncoder} onChange={(e) => set('videoEncoder', e.target.value as RenderSettings['videoEncoder'])}>
          <option value="auto">Auto detect</option>
          <option value="vaapi">AMD VAAPI · Linux</option>
          <option value="amf">AMD AMF · Windows</option>
          <option value="nvenc">NVIDIA NVENC</option>
          <option value="cpu">CPU x264/x265</option>
        </Select>
      </div>
      <div>
        <div className="label">Transcription Engine</div>
        <Select value={value.transcriptionProvider} onChange={(e) => set('transcriptionProvider', e.target.value as RenderSettings['transcriptionProvider'])}>
          <option value="auto">Auto · local</option>
          <option value="openai_whisper">PyTorch Whisper · local</option>
          <option value="whisper_cpp">whisper.cpp · local</option>
          <option value="deepgram">Deepgram Nova-3 · cloud</option>
        </Select>
      </div>
      <div>
        <div className="label">Speech Model</div>
        <Select value={value.transcriptionModel} onChange={(e) => set('transcriptionModel', e.target.value as RenderSettings['transcriptionModel'])}>
          {(['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'] as const).map((model) => <option key={model} value={model}>{model}</option>)}
        </Select>
        {value.transcriptionProvider === 'deepgram' && <p className="mt-1 text-[10px] text-sky-300">Ignored by Deepgram Nova-3.</p>}
      </div>
      <div>
        <div className="label">Transcription Pass</div>
        <Select
          value={value.transcriptionPreset}
          onChange={(event) => {
            const transcriptionPreset = event.target.value as RenderSettings['transcriptionPreset'];
            onChange({
              ...value,
              transcriptionPreset,
              transcriptionModel: transcriptionPreset === 'draft' ? 'turbo' : 'large-v3',
            });
          }}
        >
          <option value="draft">Draft · turbo</option>
          <option value="final">Final · large-v3</option>
        </Select>
      </div>
      <div>
        <div className="label">Speech Language</div>
        <input className="input" value={value.transcriptionLanguage} onChange={(event) => set('transcriptionLanguage', event.target.value.trim().toLowerCase() || 'auto')} placeholder="auto or en" />
      </div>
      {value.mode === 'shorts' && (
        <div>
          <div className="label">Shorts Framing</div>
          <Select value={value.framingMode || 'auto'} onChange={(e) => set('framingMode', e.target.value as RenderSettings['framingMode'])}>
            {FRAMING_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
          </Select>
        </div>
      )}
      {value.mode === 'shorts' && (
        <>
          <div>
            <div className="label">Max Duration</div>
            <Select value={value.maxDuration} onChange={(e) => set('maxDuration', parseInt(e.target.value))}>
              {MAX_DURATIONS.map((d) => <option key={d} value={d}>{d >= 60 ? `${d / 60} min` : `${d}s`}</option>)}
            </Select>
          </div>
          <div>
            <div className="label">Clip Volume</div>
            <Select value={value.clipVolume} onChange={(e) => set('clipVolume', e.target.value as RenderSettings['clipVolume'])}>
              {CLIP_VOLUME_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label} · {option.detail}</option>)}
            </Select>
            <p className="mt-1 text-[10px] text-slate-500">Balanced is the default review set; More broadens coverage.</p>
          </div>
          {value.clipVolume === 'exact' && (
            <NumberField
              id="settings-target-clips"
              label="Target Clips"
              min={1}
              max={value.maxClips}
              value={value.targetClips}
              onChange={(v) => set('targetClips', Math.trunc(v))}
            />
          )}
          <div>
            <div className="label">Hard Export Cap</div>
            <Select
              value={value.maxClips}
              onChange={(e) => {
                const maxClips = parseInt(e.target.value);
                onChange({ ...value, maxClips, targetClips: Math.min(value.targetClips, maxClips) });
              }}
            >
              {MAX_CLIPS.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
            <p className="mt-1 text-[10px] text-slate-500">Never render more than this many clips.</p>
          </div>
          <label className="flex items-start gap-2 rounded-lg border border-emerald-500/15 bg-emerald-500/[0.05] p-3 text-xs text-slate-200">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-500" checked={value.reviewBeforeRender} onChange={(event) => set('reviewBeforeRender', event.target.checked)} />
            <span><span className="block font-semibold">Review before rendering</span><span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">Group candidates by story and approve boundaries before final exports.</span></span>
          </label>
        </>
      )}
      {value.mode === 'shorts' && (
        <div className="space-y-2 rounded-lg border border-white/5 bg-black/20 p-3 sm:col-span-2 lg:col-span-3">
          <div className="label">Viral Intelligence</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-start gap-2 text-xs text-slate-200">
              <input type="checkbox" className="mt-0.5 h-4 w-4 rounded accent-violet-500" checked={value.localSemantic} onChange={(e) => set('localSemantic', e.target.checked)} />
              <span><span className="block font-semibold">Local semantic reranking</span><span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">Uses a configured OpenAI-compatible local model endpoint.</span></span>
            </label>
            <label className="flex items-start gap-2 text-xs text-slate-200">
              <input type="checkbox" className="mt-0.5 h-4 w-4 rounded accent-pink-500" checked={value.geminiAnalysis} onChange={(e) => set('geminiAnalysis', e.target.checked)} />
              <span><span className="block font-semibold">Gemini video analysis · Cloud</span><span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500">Opt in to upload a compact video/audio proxy for multimodal scoring.</span></span>
            </label>
          </div>
        </div>
      )}
      {value.mode === 'shorts' && <CaptionStylePicker value={value.subtitleStyle} onChange={(style) => set('subtitleStyle', style)} />}
      <div>
        <div className="label">Time Segment</div>
        <Select
          value={value.startTime === '' && value.endTime === '' ? 'full' :
                 value.startTime === '0' && value.endTime === '60' ? 'first60' :
                 value.startTime === '0' && value.endTime === '180' ? 'first180' :
                 'custom'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'custom') return;
            const p = SEGMENT_PRESETS.find((p) => p.id === v);
            if (p) onChange({ ...value, startTime: p.startTime, endTime: p.endTime });
          }}
        >
          {SEGMENT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="custom">Custom…</option>
        </Select>
      </div>
      <div>
        <div className="label">Upscale</div>
        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input type="checkbox" className="h-4 w-4 rounded accent-pink-500" checked={value.upscale} onChange={(e) => set('upscale', e.target.checked)} />
          8K upscaling
        </label>
      </div>
      <div className="sm:col-span-2">
        <div className="label">Output Naming</div>
        <input
          className="input font-mono"
          value={value.outputNameTemplate}
          onChange={(e) => set('outputNameTemplate', e.target.value)}
          aria-describedby="output-name-help"
        />
        <p id="output-name-help" className="mt-1 text-[10px] text-slate-500">Tokens: {'{source}'} {'{platform}'} {'{index}'} {'{score}'}</p>
      </div>
      {(value.videoEncoder === 'auto' || value.videoEncoder === 'vaapi') && (
        <div>
          <div className="label">VAAPI Device</div>
          <input className="input font-mono" value={value.vaapiDevice} onChange={(e) => set('vaapiDevice', e.target.value)} />
        </div>
      )}
    </div>
  );
}

function CapabilityState({ available }: { available: boolean }) {
  return (
    <span className={clsx(
      'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
      available ? 'bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/25' : 'bg-white/5 text-slate-500 ring-1 ring-white/5',
    )}>
      <Gauge className="h-3 w-3" /> {available ? 'Ready' : 'Unavailable'}
    </span>
  );
}
