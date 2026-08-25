/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        pool: {
          950: '#000000',   // deepest LaneWatch chrome
          900: '#121212',   // page background
          800: '#1e1e1e',   // cards and navigation
          750: '#242424',   // intermediate elevated surface
          700: '#2c2c2c',   // raised surfaces and inputs
          600: '#444444',   // borders and dividers
          500: '#7f858c',   // muted text
          400: '#aeb3b9',   // secondary text
          300: '#d0d4d8',
          200: '#e9ebed',
          100: '#ffffff',
        },
        accent: {
          900: '#082844',
          800: '#0d4778',
          700: '#1565c0',
          600: '#1e88e5',
          500: '#2196f3',   // LaneWatch family blue
          400: '#64b5f6',
          300: '#90caf9',
          200: '#bbdefb',
        },
      },
      fontFamily: {
        sans: ['Oxanium', 'system-ui', 'sans-serif'],
        brand: ['Orbitron', 'Oxanium', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
