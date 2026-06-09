/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: '#0b0f17',
          800: '#111827',
          700: '#1b2536',
          600: '#27324a',
        },
      },
    },
  },
  plugins: [],
}
