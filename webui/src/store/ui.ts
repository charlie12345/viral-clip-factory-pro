import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { RenderSettings } from '@/lib/render-options';
import { DEFAULT_RENDER_SETTINGS } from '@/lib/render-options';

interface UIState {
  // Upload defaults
  uploadDefaults: RenderSettings;
  setUploadDefaults: (s: RenderSettings) => void;

  // Editor preferences
  preferredStyle: string;
  preferredAnimation: string;
  preferredFont: string | null;
  setPreferredStyle: (s: string) => void;
  setPreferredAnimation: (a: string) => void;
  setPreferredFont: (f: string | null) => void;

  // Keep-awake preference
  keepAwake: boolean;
  setKeepAwake: (v: boolean) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      uploadDefaults: DEFAULT_RENDER_SETTINGS,
      setUploadDefaults: (s) => set({ uploadDefaults: s }),

      preferredStyle: 'classic',
      preferredAnimation: 'none',
      preferredFont: null,
      setPreferredStyle: (s) => set({ preferredStyle: s }),
      setPreferredAnimation: (a) => set({ preferredAnimation: a }),
      setPreferredFont: (f) => set({ preferredFont: f }),

      keepAwake: true,
      setKeepAwake: (v) => set({ keepAwake: v }),
    }),
    {
      name: 'vcf-ui-prefs',
      merge: (persisted, current) => {
        const saved = (persisted || {}) as Partial<UIState>;
        return {
          ...current,
          ...saved,
          uploadDefaults: {
            ...DEFAULT_RENDER_SETTINGS,
            ...(saved.uploadDefaults || {}),
          },
        };
      },
    },
  ),
);
