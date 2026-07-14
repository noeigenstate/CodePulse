/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#F6F9FF',
        ink: {
          DEFAULT: '#0F172A',
          900: '#0F172A',
          700: '#334155',
          500: '#64748B',
          400: '#94A3B8',
        },
        line: {
          DEFAULT: '#E6EBF5',
          soft: '#EEF2F9',
        },
        brand: {
          claude: '#FF8A2B',
          codex: '#5B6BFF',
          grok: '#17C083',
        },
      },
      borderRadius: {
        card: '20px',
        badge: '12px',
      },
      boxShadow: {
        card: '0 8px 24px rgba(15, 23, 42, 0.06)',
        'card-hover': '0 12px 32px rgba(15, 23, 42, 0.10)',
        soft: '0 4px 16px rgba(15, 23, 42, 0.04)',
      },
      spacing: {
        18: '4.5rem',
      },
      fontSize: {
        title: ['22px', { lineHeight: '1.25', fontWeight: '700' }],
        module: ['16px', { lineHeight: '1.35', fontWeight: '600' }],
        body: ['14px', { lineHeight: '1.5', fontWeight: '400' }],
        meta: ['12px', { lineHeight: '1.4', fontWeight: '500' }],
      },
      fontFamily: {
        sans: [
          'Inter',
          'Segoe UI',
          'system-ui',
          '-apple-system',
          'PingFang SC',
          'Microsoft YaHei',
          'Noto Sans SC',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
}
