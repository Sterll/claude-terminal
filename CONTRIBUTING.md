# Contributing to Claude Terminal

Thanks for your interest in contributing! Here's how you can help.

## Reporting Bugs

Open an [issue](https://github.com/Sterll/claude-terminal/issues/new?template=bug_report.md) with:

- Steps to reproduce
- Expected vs actual behavior
- Windows version and Node.js version
- Screenshots if applicable

## Suggesting Features

Open an [issue](https://github.com/Sterll/claude-terminal/issues/new?template=feature_request.md) describing:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## Development Setup

```bash
git clone https://github.com/Sterll/claude-terminal.git
cd claude-terminal
npm install
npm run build:renderer
npx electron .
```

Use `npx electron . --dev` to launch with DevTools open.

## Making Changes

1. Fork the repository
2. Create a branch from `main` (`git checkout -b feat/my-feature`)
3. Make your changes
4. Test the application locally with `npm run build:renderer && npx electron .`
5. Commit using [conventional commits](https://www.conventionalcommits.org/):
   - `feat(scope): add new feature`
   - `fix(scope): fix bug description`
   - `refactor(scope): restructure code`
   - `chore(scope): maintenance task`
6. Push and open a Pull Request

## Code Style

- JavaScript (no TypeScript yet) with ES modules in renderer, CommonJS in main process
- Use descriptive variable and function names
- Keep functions focused and concise
- Follow existing patterns in the codebase

## Architecture Notes

- **Main process** (`src/main/`): Node.js + Electron APIs, IPC handlers, services
- **Renderer process** (`src/renderer/`): DOM manipulation, reactive state, UI components
- **IPC bridge**: Communication goes through `src/main/preload.js` context bridge
- **No frameworks**: Vanilla JS with a custom reactive state system (`src/renderer/state/State.js`)

## Pull Request Guidelines

- Keep PRs focused on a single change
- Update the README if you change user-facing behavior
- Test on Windows 10 and 11 if possible
- Fill in the PR template
