/**
 * Tailwind configuration — now authoritative.
 * ---------------------------------------------------------------------------
 * `npm run build:css` compiles src/input.css into public/css/nexus.css. That
 * output is committed to git so the deploy target still needs no build step:
 * Railway serves the committed file, exactly as it did when the stylesheet was
 * maintained by hand. What changed is that a human no longer transcribes
 * utilities — running the build is the only way to add one.
 *
 * The colour names below read the same custom properties declared in
 * src/styles/tokens.css, so `bg-surface` and `background: rgb(var(--c-surface))`
 * always resolve to the same value and both follow the theme.
 *
 * Default screens are kept as-is (sm 640 / md 768 / lg 1024 / xl 1280) because
 * the hand-written media queries in src/styles/app-shell.css use those exact
 * pixel values.
 */
module.exports = {
  darkMode: 'class',

  // The scanner is the source of truth for which utilities get emitted, so a
  // path missing here means a silently missing class. app.js builds markup in
  // template strings, which is why the js glob matters as much as the html one.
  content: [
    './public/**/*.html',
    './public/js/**/*.js',
  ],

  theme: {
    extend: {
      colors: {
        // `primary` previously pointed at `--c-primary`, a property that was
        // never declared anywhere, so every `primary` utility resolved to
        // nothing and simply inherited. It is an alias of the accent, not of
        // the text token: read the call sites and they are all accent work —
        // `bg-primary/10 + border-primary/15 + text-primary` brand badges, the
        // `border-l-[3px] border-primary` section bar (the same bar
        // `.nav-btn.active::before` paints with --c-accent), the spinner rings,
        // the dropzone hover border and the storage-usage fill. Pointing it at
        // --c-text turned those into grey-on-grey blobs sitting next to a blue
        // .btn-primary.
        primary:    'rgb(var(--c-accent) / <alpha-value>)',
        accent:     'rgb(var(--c-accent) / <alpha-value>)',
        accentSoft: 'rgb(var(--c-accent-soft) / <alpha-value>)',
        onAccent:   'rgb(var(--c-on-accent) / <alpha-value>)',
        surface:    'rgb(var(--c-surface) / <alpha-value>)',
        paper:      'rgb(var(--c-subtle) / <alpha-value>)',
        cloud:      'rgb(var(--c-border) / <alpha-value>)',
        cloudStrong:'rgb(var(--c-border-strong) / <alpha-value>)',
        textDark:   'rgb(var(--c-text) / <alpha-value>)',
        textGray:   'rgb(var(--c-text-muted) / <alpha-value>)',
        iron:       'rgb(var(--c-iron) / <alpha-value>)',
        fog:        'rgb(var(--c-fog) / <alpha-value>)',
        ash:        'rgb(var(--c-ash) / <alpha-value>)',
        borderDark: 'rgb(var(--c-text) / <alpha-value>)',

        // Semantic status — separate from the accent on purpose.
        success:    'rgb(var(--c-success) / <alpha-value>)',
        danger:     'rgb(var(--c-danger) / <alpha-value>)',
        warning:    'rgb(var(--c-warning) / <alpha-value>)',

        // Fixed literals retained from the earlier palettes.
        obsidian: '#111418',
        graphite: '#18181b',
        slate:    '#27272a',
        ember:    '#ff5a00',
      },

      borderRadius: {
        card: '16px',
        control: '12px',
      },

      // Mirrors the stack applied to <body> in src/styles/base.css so
      // `font-sans` never silently swaps the typeface.
      fontFamily: {
        sans: ['Inter', 'DM Sans', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },

  plugins: [],
};
