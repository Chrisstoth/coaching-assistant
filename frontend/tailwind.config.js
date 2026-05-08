/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        pool: {
          900: '#080808',   // true black background
          800: '#111111',   // nav, elevated surfaces
          700: '#1a1a1a',   // cards, inputs
          600: '#272727',   // borders, dividers
          400: '#6b6b6b',   // muted / placeholder text
          200: '#e8e8e8',   // primary text
        },
        accent: {
          700: '#c2410c',   // deep orange — pressed / dark states
          600: '#ea580c',   // primary orange — CTAs, active nav
          500: '#f97316',   // orange — hover
          400: '#fb923c',   // light orange — icons, tags
          200: '#fed7aa',   // pale orange — subtle highlights
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
