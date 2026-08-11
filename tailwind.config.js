/**
 * Tailwind config — kept for reference only. `npm run build:css` writes to
 * src/tailwind-generated.css (NOT to the shipped stylesheet) so it can never
 * clobber the hand-maintained public/css/app.css.
 *
 * IMPORTANT: `public/css/app.css` is currently maintained BY HAND and is the
 * shipped stylesheet. It is committed to git on purpose: Railway runs no CSS
 * build step, so a broken build can never take the site down. If you switch to
 * generating it with the CLI, run the build locally and commit the result —
 * do not add a build step to the deploy.
 *
 * The token names below mirror the CSS custom properties declared at the top of
 * public/css/app.css, so class names stay identical either way.
 */
module.exports = {
  darkMode: 'class',
  content: [
    './public/index.html',
    './public/js/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        primary:  'rgb(var(--c-primary) / <alpha-value>)',
        accent:   'rgb(var(--c-accent) / <alpha-value>)',
        surface:  'rgb(var(--c-surface) / <alpha-value>)',
        paper:    'rgb(var(--c-subtle) / <alpha-value>)',
        cloud:    'rgb(var(--c-border) / <alpha-value>)',
        textDark: 'rgb(var(--c-text) / <alpha-value>)',
        textGray: 'rgb(var(--c-text-muted) / <alpha-value>)',
        iron:     'rgb(var(--c-iron) / <alpha-value>)',
        fog:      'rgb(var(--c-fog) / <alpha-value>)',
        ash:      'rgb(var(--c-ash) / <alpha-value>)',
        obsidian: '#111418',
        graphite: '#18181b',
        slate:    '#27272a',
        ember:    '#ff5a00',
        borderDark: 'rgb(var(--c-text) / <alpha-value>)',
      },
      borderRadius: {
        card: '16px',
        control: '12px',
      },
      fontFamily: {
        sans: ['DM Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['DM Sans', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};
