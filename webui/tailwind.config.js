/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'monospace'],
      },
      colors: {
        bg: {
          base: '#0a0a14',
          panel: '#0f0f1f',
          elev: '#15152a',
        },
        brand: {
          50:  '#fdf2ff',
          100: '#fae8ff',
          200: '#f5d0fe',
          300: '#f0abfc',
          400: '#e879f9',
          500: '#d946ef',
          600: '#c026d3',
          700: '#a21caf',
          800: '#86198f',
          900: '#701a75',
        },
        accent: {
          pink:   '#ec4899',
          violet: '#8b5cf6',
          indigo: '#6366f1',
          blue:   '#3b82f6',
          cyan:   '#22d3ee',
          green:  '#10b981',
          amber:  '#f59e0b',
          red:    '#ef4444',
        },
      },
      backgroundImage: {
        'app-bg': 'linear-gradient(135deg, #0a0a14 0%, #0f0f1f 60%, #14102b 100%)',
        'panel-bg': 'linear-gradient(180deg, rgba(139,92,246,.06) 0%, rgba(59,130,246,.04) 100%)',
        'brand-gradient': 'linear-gradient(135deg, #ec4899 0%, #8b5cf6 50%, #3b82f6 100%)',
      },
      boxShadow: {
        'glow-brand':  '0 0 24px -2px rgba(139,92,246,.45)',
        'glow-pink':   '0 0 24px -2px rgba(236,72,153,.45)',
        'inner-glow':  'inset 0 1px 0 0 rgba(255,255,255,.05)',
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '.55' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to:   { opacity: '1', transform: 'none' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to:   { opacity: '1', transform: 'none' },
        },
        'shimmer': {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'pulse-soft': 'pulse-soft 2s cubic-bezier(.4,0,.6,1) infinite',
        'fade-in':    'fade-in .25s ease-out both',
        'slide-up':   'slide-up .35s ease-out both',
        'shimmer':    'shimmer 2s linear infinite',
      },
    },
  },
  plugins: [],
};
