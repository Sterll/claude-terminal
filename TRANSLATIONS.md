# Translations

This file tracks the translation status of Claude Terminal's user interface and
explains how to contribute new languages or improve existing ones.

> **Coverage data is computed automatically** by
> [`scripts/check-i18n.js`](scripts/check-i18n.js).
> Run `node scripts/check-i18n.js` locally to see the latest figures.

---

## Current status

<!-- Coverage figures are updated automatically by the i18n-badge workflow.    -->
<!-- Run `node scripts/check-i18n.js --json` to regenerate the table below.   -->

| Flag | Language | Locale code | Coverage | Keys | Status |
|------|----------|-------------|----------|------|--------|
| 🇺🇸 | English | `en` | ![100%](https://img.shields.io/badge/i18n-100%25-brightgreen) | ~800 / ~800 | Base (reference) |
| 🇫🇷 | French | `fr` | ![i18n fr](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/bernardopg/8aa5c09aca432a7a39aefe32e8ed393a/raw/i18n_fr.json) | ~800 / ~800 | ✅ Complete |

---

## How to add a new language

Follow these steps to contribute a new locale:

### 1. Fork and clone

```bash
git clone https://github.com/<your-username>/claude-terminal.git
cd claude-terminal
```

### 2. Create the locale file

```bash
cp src/renderer/i18n/locales/en.json src/renderer/i18n/locales/<lang>.json
```

Replace `<lang>` with the ISO 639-1 code of the target language
(e.g., `de` for German, `es` for Spanish, `pt` for Portuguese, `ja` for Japanese).

### 3. Translate the values

Open the new file and translate every **value** (right-hand side of each key).
Do **not** translate key names or variable placeholders like `{count}`.

```jsonc
// Before
"close": "Close"

// After (German example)
"close": "Schließen"
```

### 4. Update the top-level metadata keys

```json
"language": {
  "name": "Deutsch",
  "code": "de"
}
```

### 5. Verify your translation locally

```bash
node scripts/check-i18n.js --locale=<lang>
```

All keys present in `en.json` must be translated for a full 100 % score.
The CI will warn (but not fail) if coverage drops below 80 %.

### 6. Register the locale in the app

Open the i18n loader (check `src/renderer/i18n/index.js` or the equivalent
module) and add a reference to your new file, following the same pattern used
for `fr.json`.

### 7. Update this file

Add a new row to the [Current status](#current-status) table above.

### 8. Open a Pull Request

Submit a PR with the title format:
`feat(i18n): add <Language> translation (<lang>)`

Link to this file in the PR description and mention any keys you intentionally
left untranslated (with a reason).

---

## CI pipeline

The GitHub Actions workflow [`.github/workflows/i18n-badge.yml`](.github/workflows/i18n-badge.yml)
runs on every push that touches a locale file. It:

1. Computes coverage via `node scripts/check-i18n.js --json`.
2. Updates a dynamic Shields.io badge stored in a GitHub Gist.
3. Emits a warning if any locale is below the 80 % threshold.

See [`.github/i18n-coverage.md`](.github/i18n-coverage.md) for setup instructions.

---

## Translator credits

Translations are a community effort. Thank you to everyone who has contributed!

| Language | Contributor(s) |
|----------|----------------|
| French (`fr`) | [@Sterll](https://github.com/Sterll) (original author) |

To have your name listed here, open a PR that adds or significantly improves a
locale file. Mention your preferred display name or GitHub handle in the PR
description.

---

## Reporting translation issues

If you spot an incorrect, missing, or outdated translation, please
[open an issue](https://github.com/Sterll/claude-terminal/issues/new) with the
label `translation` and include:

- The locale code (e.g., `fr`)
- The i18n key path (e.g., `common.close`)
- The current string and the suggested correction
