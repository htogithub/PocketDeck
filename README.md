# Mnemo

Spaced-repetition flashcards that run entirely in the browser. Mnemo opens and exports Anki decks, schedules reviews with FSRS or SM-2, adds interactive multiple-choice and true/false cards, and works offline once it has been opened. Your collection is stored on your device; nothing is sent to a server.

The interface is available in English and French (Settings → Language).

## Features

**Studying**
- FSRS-5 or SM-2 scheduling, chosen per deck preset, with learning and relearning steps, daily limits, leech handling and sibling burying
- Custom study: raise today's limits, review forgotten cards, review ahead, or cram any search without touching the schedule
- Undo, flags, mark, bury, suspend, card info with full review history
- Configurable gestures (swipe left/right/up/down, double tap, long press) and keyboard shortcuts
- 2- or 4-button grading, optional interval labels, timer and remaining counts

**Cards**
- Basic, reversed, optional reversed, type-in answer, cloze (nested clozes and clozes inside math), multiple choice and true/false
- Anki-compatible templates: `{{Field}}`, `{{FrontSide}}`, `{{#Field}}…{{/Field}}`, `{{cloze:}}`, `{{type:}}`, `{{hint:}}`, `{{text:}}`, furigana filters, plus `{{mcq:}}` and `{{tf:}}`
- Note type editor with fields, HTML/CSS templates and a live preview
- LaTeX math with KaTeX: `\(…\)`, `\[…\]`, `$$…$$`, Anki's `[$]…[/$]`, and optionally `$…$`
- Images and audio, stored locally

**Customization**
- Themes: Auto, Light, Dark, AMOLED (true black)
- Accent color, interface font, card font (any Google Fonts family), card size, width and alignment
- Option to adapt imported cards to the theme and font

**Organizing**
- Folders to group decks (nested folders supported), with combined counts and a *Study folder* button
- Move decks between folders, add existing decks to a folder, delete a folder while keeping its decks
- Import several files at once with shared options (one deck per text file, or a single destination)

**Browse and stats**
- Search with Anki syntax: `deck:`, `tag:`, `note:`, `is:due`, `flag:`, `added:`, `rated:`, `prop:ivl>=30`, field searches, `or`, negation, regex
- Bulk actions: move, tag, suspend, flag, reset, delete, study selection
- Statistics: today, 30-day forecast, review calendar, reviews by type, card breakdown, intervals, answer buttons, true retention, FSRS memory

## Import and export formats

| Format | Import | Export |
|---|---|---|
| Anki package `.apkg` / `.colpkg` (legacy and current formats, media, review history) | ✓ | ✓ `.apkg` |
| Anki text export (`#separator`, `#notetype column`…) | ✓ | ✓ |
| CSV / TSV / TXT with column mapping | ✓ | ✓ |
| JSON (arrays of objects or rows; Mnemo JSON) | ✓ | ✓ |
| CrowdAnki (`deck.json`, folder or zip) | ✓ | |
| Markdown | ✓ | |
| HTML tables and definition lists | ✓ | |
| GIFT (Moodle) | ✓ | |
| Aiken | ✓ | |
| Full backup `.zip` (collection, media, settings) | ✓ restore | ✓ |

Multiple-choice and true/false notes exported to `.apkg` stay readable in Anki and become interactive again when re-imported into Mnemo.

### Writing multiple-choice and true/false cards

**CSV** — use a header row; choices go in one column, separated by line breaks or `|`. The answer can be letters, numbers or the exact text:

```csv
Question;Choices;Answer;Explanation
Unit of force?;Newton|Joule|Watt;A;1 N = 1 kg·m/s²
Which are prime?;2|4|5|9;A,C;
```

**Markdown** — Mnemo recognizes these patterns (blocks separated by blank lines):

```markdown
Q: What is the derivative of $\sin x$?
A: $\cos x$

Newton's second law :: $F = ma$
Unit of force ::: newton
Light travels faster than sound :: True

Which particle has a negative charge?
- [ ] Proton
- [x] Electron
- [ ] Neutron

The ==proton== is in the ==nucleus==.
```

`::` makes a basic card, `:::` a two-sided card, `True`/`False` after `::` a true/false card, a checklist a multiple-choice card, and `==highlights==` cloze deletions. Multi-line cards use a line containing only `?` between front and back.

**GIFT and Aiken** quiz files from Moodle and other LMS work as-is, including `$CATEGORY` (becomes subdecks), feedback and weighted answers.

## Deploying on GitHub Pages

1. Create a repository and upload every file from this folder to its root (`index.html` must be at the top level).
2. In the repository, open **Settings → Pages**, set **Source** to *Deploy from a branch*, choose `main` and `/ (root)`, then save.
3. After a minute, the app is live at `https://<username>.github.io/<repository>/`.

There is no build step. External libraries (KaTeX, JSZip, sql.js, fzstd) load from jsDelivr on first use and are cached for offline use.

## Installing on a phone

- **iPhone / iPad**: open the site in Safari, tap Share → *Add to Home Screen*. The app then opens full screen and works offline.
- **Android**: open it in Chrome and choose *Install app*.

Pinch and double-tap zoom are disabled so the app behaves like a native one. Installing it also makes the browser less likely to clear its storage. You can check the storage status in Settings → Data.

## Your data

Everything lives in the browser's IndexedDB on the device you use. Different devices and browsers keep separate collections; there is no sync. Back up regularly with **Settings → Back up collection** and restore the `.zip` on another device to move your collection. Exporting to `.apkg` lets you continue in Anki at any time.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Space / Enter | Show answer, then Good |
| 1 2 3 4 | Again, Hard, Good, Easy |
| A B C… or 1 2 3… | Pick a multiple-choice answer |
| T / F (or V / F) | True or false |
| U or Ctrl+Z | Undo |
| E | Edit note |
| R | Replay audio |
| − | Bury |
| @ | Suspend |
| * | Mark |
| Ctrl+1…7 | Flags |
| Esc | Leave the session |

In the editor: Ctrl+Shift+C adds a cloze, Ctrl+M wraps the selection in math, Ctrl+Enter saves.

## Notes and limits

- Anki sync servers can't be reached from a third-party web app, so AnkiWeb sync isn't available. Use `.apkg` export/import or backups to move data.
- FSRS uses the default FSRS-5 parameters. To personalize them, run the optimizer in Anki desktop and paste the 19 parameters into the deck preset.
- JavaScript inside card templates is disabled by default; enable it in Settings only for decks you trust.

## Project structure

```
index.html            App shell
style.css             Themes and layout
app.js                Views, navigation, theme
ui.js                 Shared components and note editor
state.js              Collection model, decks, notes, built-in note types
sched.js              FSRS-5 and SM-2 schedulers, study sessions
template.js           Anki-compatible template engine, cloze, multiple choice, true/false
cardview.js           Card rendering (shadow DOM, media, math, audio)
search.js             Anki search syntax
stats.js              Statistics and charts
importers.js          All import formats
exporters.js          .apkg, text, JSON, backup
db.js                 IndexedDB storage
i18n.js, i18n-en.js   Language switching and English strings
sw.js                 Service worker for offline use
manifest.webmanifest  Install metadata and icons
```
