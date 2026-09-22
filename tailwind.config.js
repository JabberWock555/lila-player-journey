/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink:    { 900:'#08090c', 800:'#0d0f14', 700:'#13161d', 600:'#1b1f28', 500:'#252b36' },
        edge:   '#2a3140',
        muted:  '#8a94a6',
        human:  '#38bdf8',
        bot:    '#f59e0b',
        kill:   '#f43f5e',
        death:  '#a855f7',
        loot:   '#22c55e',
        storm:  '#eab308',
      },
      fontFamily: {
        sans: ['Inter','-apple-system','BlinkMacSystemFont','Segoe UI','sans-serif'],
        mono: ['ui-monospace','SFMono-Regular','Menlo','monospace'],
      },
    },
  },
  plugins: [],
}
