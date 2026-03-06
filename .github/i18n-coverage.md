# i18n Coverage Guide

This document explains how Claude Terminal handles internationalization (i18n),
how to add a new language, and how the automated coverage badges work.

---

## Table of Contents

- [Locale file format](#locale-file-format)
- [Adding a new language](#adding-a-new-language)
- [Running the coverage check locally](#running-the-coverage-check-locally)
- [Automated badge generation](#automated-badge-generation)
- [Coverage thresholds](#coverage-thresholds)

---

## Locale file format

All locale files live in:

```
src/renderer/i18n/locales/
├── en.json   ← reference/base (always 100 %)
└── fr.json   ← French translation
```

Each file is a **nested JSON object** where leaf values are translated strings.
Interpolation variables are wrapped in curly braces: `{variable}`.

### Example

```jsonc
// en.json (base)
{
  "common": {
    "close": "Close",
    "loading": "Loading..."
  },
  "terminals": {
    "notifToolsDone": "Task complete — {count} tools used"
  }
}

// fr.json (translation)
{
  "common": {
    "close": "Fermer",
    "loading": "Chargement..."
  },
  "terminals": {
    "notifToolsDone": "Tâche terminée — {count} outils utilisés"
  }
}
```

**Rules:**

- The structure (nesting, key names) must mirror `en.json` exactly.
- Variable names inside `{...}` must not be translated.
- Do **not** remove or rename top-level namespace keys (e.g., `common`, `git`).
- Extra keys that don't exist in `en.json` are allowed but will be reported by
  the coverage checker.

---

## Adding a new language

1. **Copy the base locale:**

   ```bash
   cp src/renderer/i18n/locales/en.json src/renderer/i18n/locales/<lang>.json
   ```

   Replace `<lang>` with the ISO 639-1 code (e.g., `de`, `es`, `ja`, `pt`).

2. **Translate the values** (not the keys) in the new file.

3. **Verify coverage:**

   ```bash
   node scripts/check-i18n.js --locale=<lang>
   ```

4. **Register the new locale** in the i18n loader:

   - Open `src/renderer/i18n/index.js` (or the equivalent module that imports
     locale files) and add an import/require for the new file.

5. **Add a badge block** to `.github/workflows/i18n-badge.yml`:

   ```yaml
   - name: Update badge — German (de)
     if: ${{ steps.parse.outputs.message_de != '' && secrets.GIST_SECRET != '' && secrets.GIST_ID != '' }}
     uses: schneegans/dynamic-badges-action@e9a478b16159b4d31420099ba146cdc50f134483  # v1.7.0
     with:
       auth: ${{ secrets.GIST_SECRET }}
       gistID: ${{ secrets.GIST_ID }}
       filename: i18n_de.json
       label: "🌐 German (de)"
       message: ${{ steps.parse.outputs.message_de }}
       color: ${{ steps.parse.outputs.color_de }}
   ```

6. **Add the badge to `README.md`** (in the badges block at the top):

   ```markdown
   ![i18n de](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/bernardopg/8aa5c09aca432a7a39aefe32e8ed393a/raw/i18n_de.json)
   ```

7. **Update `TRANSLATIONS.md`** at the project root with the new locale row.

8. **Open a Pull Request** — the CI pipeline will run the coverage check
   automatically.

---

## Running the coverage check locally

No extra dependencies needed — only the Node.js built-in modules are used.

```bash
# Check all locales (human-readable table)
node scripts/check-i18n.js

# Check a single locale
node scripts/check-i18n.js --locale=fr

# JSON output (for CI or badge generation)
node scripts/check-i18n.js --json

# Combined
node scripts/check-i18n.js --locale=fr --json
```

The script exits with code `0` when all locales meet the threshold, and `1`
when any locale is below it.

Sample output:

```
────────────────────────────────────────────────────────────
 i18n Coverage Report — Claude Terminal
────────────────────────────────────────────────────────────
 Base locale : en.json  (800 keys — 100%)
 Threshold   : 80%
────────────────────────────────────────────────────────────

 Locale  : fr (fr.json)
 Status  : ✓ PASS
 Coverage: 800/800 keys (100%)
 Missing : 0 key(s)
 Extra   : 0 key(s) not in base

────────────────────────────────────────────────────────────
 ✓ All locales meet the 80% threshold.
────────────────────────────────────────────────────────────
```

---

## Automated badge generation

The GitHub Actions workflow `.github/workflows/i18n-badge.yml` runs whenever a
file under `src/renderer/i18n/locales/**` is pushed to the repository. It:

1. Calls `node scripts/check-i18n.js --json` to compute coverage figures.
2. For each non-English locale, calls
   [`schneegans/dynamic-badges-action`](https://github.com/schneegans/dynamic-badges-action)
   to write a Shields.io endpoint payload to a GitHub Gist.
3. The README badge image is served by Shields.io, pointing at the raw Gist URL.

### One-time setup (maintainer only)

| Step | Action |
|------|--------|
| 1    | Create a **public** Gist at <https://gist.github.com> (any file, any content). |
| 2    | Copy the Gist ID from the URL (the long hex string after your username). |
| 3    | Create a Personal Access Token (PAT) at <https://github.com/settings/tokens> with the **`gist`** scope. |
| 4    | Add two repository secrets under **Settings → Secrets → Actions**: |
|      | `GIST_SECRET` — the PAT |
|      | `GIST_ID`     — the Gist ID |
| 5    | Trigger the workflow manually once via **Actions → i18n Coverage Badges → Run workflow**. |

---

## Coverage thresholds

| Percentage | Badge color   | Meaning                  |
|------------|---------------|--------------------------|
| ≥ 90 %     | 🟢 brightgreen | Excellent coverage        |
| 60 – 89 %  | 🟡 yellow      | Work in progress          |
| < 60 %     | 🔴 red         | Needs attention           |
| < 80 %     | (any)         | CI warning is emitted     |

The threshold for CI warnings is configured at the top of
`scripts/check-i18n.js` via the `COVERAGE_THRESHOLD` constant.
