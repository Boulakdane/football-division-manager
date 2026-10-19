/* ---------------------------------------------------------------
   KickOff Division — Tailwind theme customization
   Loaded right after the Tailwind CDN script.
   --------------------------------------------------------------- */

tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        arabic: ['Cairo', 'sans-serif']
      },
      colors: {
        pitch: {
          50: '#f0fdf4',
          100: '#dcfce7',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d'
        }
      }
    }
  }
};
