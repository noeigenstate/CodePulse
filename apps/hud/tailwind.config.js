/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Root CSS variables let existing Tailwind utilities switch with data-theme.
        canvas: 'var(--canvas)',
        ink: {
          DEFAULT: 'var(--ink)',
          900: 'var(--ink)',
          700: 'var(--ink-700)',
          500: 'var(--ink-muted)',
          400: 'var(--ink-subtle)',
        },
        line: {
          DEFAULT: 'var(--line)',
          soft: 'var(--line-soft)',
        },
        brand: {
          claude: '#FF8A2B',
          codex: '#5B6BFF',
          grok: '#17C083',
          kimi: '#6D5EF5',
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
