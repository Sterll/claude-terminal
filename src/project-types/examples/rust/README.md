# Reference extension — `rust`

A complete, working project-type extension, kept deliberately tiny. It is
documentation-by-example, not a feature: everything a manifest can express is here,
and there is nothing else a manifest can express.

## Try it

```bash
# Windows
xcopy /E /I src\project-types\examples\rust "%USERPROFILE%\.claude-terminal\project-types\rust"

# macOS / Linux
cp -r src/project-types/examples/rust ~/.claude-terminal/project-types/rust
```

Then, in `~/.claude-terminal/settings.json`:

```json
{
  "projectTypeExtensionsEnabled": true,
  "enabledProjectTypeExtensions": ["rust"]
}
```

Both are required. The master switch alone lists the extension as `disabled`; the
allowlist alone does nothing while the switch is off. Restart the app and "Rust"
appears in the new-project wizard under **General**, with this icon and this colour.

## What it does not contain, and cannot

No `.js` file, and no way to add one that would be loaded. An extension is a
manifest plus translations — the app reads it, validates it, and builds a type
descriptor out of it with its own code. Nothing here runs.

That means no dashboard, no wizard fields, no terminal panel, no IPC handler, no
quick action, no shell command and no CSS. If you are looking for those, read
`design/project-type-extensions.md`: the section titled *Refused, and why* explains
what each of them would cost, and the order in which they might be reconsidered.

## Files

| File | Purpose |
|------|---------|
| `project-type.json` | The manifest. Required. |
| `i18n/en.json` … `i18n/zh-CN.json` | Per-locale `name` and `description`. Optional — without them the manifest's own strings are used in every language. |

Only `name` and `description` are read from a locale file. They are merged into the
app's translations as `ext.rust.name` / `ext.rust.description`, so an extension can
name itself and cannot rename anything else.

## Field reference

See the *Manifest reference* table in `design/project-type-extensions.md`. The two
that most often trip people up:

- **`engines.claudeTerminal`** — a small semver subset (`*`, `1.3.2`, `>=1.3.0`,
  `^1.3.0`, `~1.3.0`). Anything else is treated as unsatisfiable, and the extension
  is listed as `incompatible` rather than silently skipped.
- **`detect.files` / `detect.dirs`** — bare names only. A value containing `/`, `\`
  or `..` is dropped, because these are joined onto a project path.
