import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#0b0c0e',
        panel: '#121417',
        panel2: '#171a1e',
        line: '#24282e',
        ink: '#e8eaed',
        dim: '#9aa2ad',
        dimmer: '#6b7280',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['10px', '14px'],
        xs: ['11px', '16px'],
        sm: ['12px', '18px'],
        base: ['13px', '20px'],
        lg: ['15px', '22px'],
        xl: ['18px', '26px'],
      },
    },
  },
  plugins: [],
};

export default config;
