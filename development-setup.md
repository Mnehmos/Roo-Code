# Touch and Go Development Setup Guide

This guide covers setting up your development environment for implementing the Touch and Go parallel execution feature in Roo Code.

## Prerequisites

### Required Software

1. **Node.js**: Version 20.18.1 or compatible (20.x series)

    - Check version: `node --version`
    - Download: https://nodejs.org/

2. **pnpm**: Version 10.8.1 or compatible

    - Check version: `pnpm --version`
    - Install: `npm install -g pnpm`

3. **Visual Studio Code**: Latest stable version

    - Download: https://code.visualstudio.com/

4. **Git**: For version control
    - Check version: `git --version`
    - Download: https://git-scm.com/

### Recommended VS Code Extensions

- ESLint
- Prettier
- TypeScript and JavaScript Language Features (built-in)

## Initial Setup

### 1. Clone and Set Up Repository

```bash
# Clone the repository if you haven't already
git clone https://github.com/RooCodeInc/Roo-Code.git
cd Roo-Code

# Install all dependencies
pnpm install
```

### 2. Create Feature Branch

For Touch and Go development, work on the dedicated feature branch:

```bash
# Create and switch to the feature branch
git checkout -b feature/touch-and-go-parallel-execution

# Push the branch to remote (if contributing to the main repo)
git push -u origin feature/touch-and-go-parallel-execution
```

### 3. Verify Installation

Check that everything is properly installed:

```bash
# Verify Node.js version
node --version
# Expected: v20.18.1 or v20.x

# Verify pnpm version
pnpm --version
# Expected: 10.8.1 or compatible

# Verify git configuration
git config --get user.name
git config --get user.email
# Should show your name and email
```

## Development Workflow

### Running the Extension in Debug Mode

The primary development method uses VS Code's built-in debugging:

1. **Open the project in VS Code**:

    ```bash
    code .
    ```

2. **Start Debugging**:

    - Press `F5` (or go to **Run → Start Debugging**)
    - This launches a new "Extension Development Host" window
    - The extension will be active in this debug window

3. **What gets hot-reloaded**:
    - ✅ Webview changes (React components) - reload immediately
    - ✅ Core extension changes - hot reload automatically
    - ℹ️ Some changes may require restarting the debug session

### Launch Configuration Details

The project uses the following debug configuration (from [`.vscode/launch.json`](.vscode/launch.json:1)):

- **Configuration Name**: "Run Extension"
- **Type**: Extension Host
- **Extension Path**: `${workspaceFolder}/src`
- **Output Files**: `${workspaceFolder}/src/dist/**/*.js`
- **Pre-Launch Task**: Runs default build task (watch mode)

### Build Tasks

The project uses several watch tasks (from [`.vscode/tasks.json`](.vscode/tasks.json:1)):

- **`watch`** (default): Runs all watch tasks in parallel
- **`watch:webview`**: Watches React webview components (Vite)
- **`watch:bundle`**: Watches extension bundle (esbuild)
- **`watch:tsc`**: Watches TypeScript compilation

These tasks run automatically when you press F5.

## Running Tests

The project has two test suites using Vitest:

### Backend/Core Tests (src/)

Tests for the core extension logic, tools, and services:

```bash
# From project root
cd src

# Run all tests
npx vitest run

# Run tests in watch mode
npx vitest

# Run with verbose output
npx vitest run --reporter=verbose

# Run specific test file
npx vitest run path/to/test-file.spec.ts
```

**Expected Test Results** (as of setup):

- ✅ 219 test files passed
- ⚠️ 87 test files failed (tree-sitter WASM file issues - expected)
- Total: 3320 passed, 230 skipped

**Note on Tree-Sitter Tests**: Many tree-sitter tests fail due to missing WASM files. These files are generated during the full build process and the failures do not indicate problems with the core functionality. For Touch and Go development, focus on tests related to task execution, state management, and tool orchestration.

### Frontend Tests (webview-ui/)

Tests for React components and UI logic:

```bash
# From project root
cd webview-ui

# Run all tests
npx vitest run

# Run tests in watch mode
npx vitest

# Run with verbose output
npx vitest run --reporter=verbose
```

**Expected Test Results**:

- ✅ 94 test files passed
- ✅ 1108 tests passed, 6 skipped
- ✅ All tests passing

### Test Organization

Tests follow these patterns:

- Backend: `src/**/__tests__/*.spec.ts`
- Frontend: `webview-ui/src/**/__tests__/*.spec.tsx`
- Test framework: Vitest
- Assertion library: Built-in Vitest matchers

## Building the Extension

### Standard Build

Build the entire project:

```bash
# From project root
pnpm run build
```

This uses Turbo to build all packages and applications efficiently. Subsequent builds leverage caching for speed.

### VSIX Package (for testing installation)

To build and install the extension as a VSIX package:

```bash
# Automated installation (recommended)
pnpm install:vsix

# Or build VSIX manually
pnpm vsix
# Output: bin/roo-cline-<version>.vsix

# Then install manually
code --install-extension bin/roo-cline-<version>.vsix
```

## Git Workflow for Touch and Go Development

### Branch Strategy

```bash
# Always develop on the feature branch
git checkout feature/touch-and-go-parallel-execution

# Keep your branch up to date with main
git fetch origin
git rebase origin/main

# Handle any conflicts
# Then force push if needed (after rebase)
git push --force-with-lease
```

### Commit Message Format

Follow conventional commits:

```bash
# Feature additions
git commit -m "feat(parallel): add task queue manager"

# Bug fixes
git commit -m "fix(parallel): resolve race condition in state updates"

# Documentation
git commit -m "docs(parallel): add architecture decision record"

# Tests
git commit -m "test(parallel): add tests for parallel execution"

# Refactoring
git commit -m "refactor(parallel): extract state management logic"
```

### Before Committing

```bash
# Ensure code is properly formatted
pnpm run format

# Run linter
pnpm run lint

# Run relevant tests
cd src && npx vitest run tests/related-to-changes
```

## Common Issues and Debugging Tips

### Issue: "vitest: command not found"

**Cause**: Running tests from wrong directory

**Solution**:

- Backend tests: Must run from `src/` directory
- Frontend tests: Must run from `webview-ui/` directory

```bash
# ❌ Wrong
npx vitest run src/tests/user.test.ts

# ✅ Correct
cd src && npx vitest run tests/user.test.ts
```

### Issue: Tree-sitter WASM file errors

**Cause**: Missing tree-sitter WASM files in `src/dist/`

**Solution**: These failures are expected in development. The WASM files are generated during the full build process. For development:

- Focus on non-tree-sitter tests
- Or run full build: `pnpm run build`

### Issue: Extension doesn't start in debug mode

**Troubleshooting steps**:

1. Check terminal output in VS Code for errors
2. Ensure pre-launch build task completed successfully
3. Try cleaning and rebuilding:

    ```bash
    # Clean build artifacts
    pnpm run clean

    # Rebuild
    pnpm run build
    ```

4. Restart VS Code
5. Try F5 again

### Issue: Changes not reflecting in debug mode

**Solutions**:

- For webview changes: Refresh the debug window
- For extension changes: Restart debug session (Ctrl+Shift+F5)
- Check that watch tasks are running in the terminal

### Issue: PowerShell syntax errors with `&&`

**Cause**: PowerShell doesn't support `&&` operator like bash

**Solution**: Use semicolon `;` instead:

```powershell
# ❌ Wrong (bash syntax)
node --version && pnpm --version

# ✅ Correct (PowerShell)
node --version; pnpm --version
```

## Project Structure (Touch and Go Relevant)

```
Roo-Code/
├── src/                          # Core extension code
│   ├── core/                     # Core functionality
│   │   ├── task/                 # Task management (key for Touch and Go)
│   │   ├── diff/                 # Diff operations
│   │   └── assistant-message/    # Message parsing
│   ├── services/                 # Services layer
│   │   ├── tree-sitter/          # Code parsing
│   │   └── mcp/                  # MCP integration
│   ├── activate/                 # Extension activation
│   └── __tests__/                # Backend tests
│
├── webview-ui/                   # React frontend
│   ├── src/
│   │   ├── components/           # UI components
│   │   │   ├── chat/             # Chat interface
│   │   │   └── settings/         # Settings UI
│   │   └── __tests__/            # Frontend tests
│   └── package.json
│
├── .vscode/
│   ├── launch.json               # Debug configurations
│   └── tasks.json                # Build tasks
│
└── research/                     # Touch and Go research docs
    ├── architecture-map.md
    ├── integration-points.md
    └── extension-strategy.md
```

## Key Files for Touch and Go Development

Based on the architecture research:

### Core Components

- [`src/core/task/Task.ts`](src/core/task/Task.ts:1) - Main Task class
- [`src/core/assistant-message/`](src/core/assistant-message/:1) - Message parsing
- [`src/core/diff/`](src/core/diff/:1) - Diff operations

### State Management

- Look for state management patterns in existing task code
- Consider integration points identified in research

### Extension Points

- Review [`research/extension-points-validation.md`](research/extension-points-validation.md:1)
- Check [`research/reuse-inventory.md`](research/reuse-inventory.md:1)

## Testing Your Touch and Go Implementation

### Unit Tests

Create tests alongside your implementation:

```bash
# Create test file
touch src/core/parallel/__tests__/TaskQueue.spec.ts

# Run specific tests
cd src && npx vitest run core/parallel/__tests__/TaskQueue.spec.ts

# Watch mode for TDD
cd src && npx vitest core/parallel/__tests__/
```

### Integration Testing

Test your changes in the actual extension:

1. Start debug session (F5)
2. In the Extension Development Host, invoke Roo Code
3. Test parallel execution scenarios
4. Check console output for errors
5. Verify state management and UI updates

### Manual Testing Checklist

Before submitting changes:

- [ ] Extension activates without errors
- [ ] Parallel tasks can be initiated
- [ ] State updates correctly during parallel execution
- [ ] UI reflects parallel task status
- [ ] Errors are handled gracefully
- [ ] Cleanup happens properly on completion
- [ ] No memory leaks during extended use
- [ ] All new code has test coverage
- [ ] All tests pass (excluding known tree-sitter issues)

## Resources

### Documentation

- [Roo Code Architecture](research/architecture-map.md)
- [Integration Points](research/integration-points.md)
- [Extension Strategy](research/extension-strategy.md)
- [Reuse Inventory](research/reuse-inventory.md)

### VS Code Extension Development

- [Extension API](https://code.visualstudio.com/api)
- [Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [Debugging Extensions](https://code.visualstudio.com/api/working-with-extensions/debugging-extension)

### Project-Specific

- [Project README](README.md)
- [Contributing Guidelines](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Getting Help

### For Touch and Go Development

- Review architecture research in `research/` directory
- Check existing task management patterns in `src/core/task/`
- Reference integration points documentation

### For General Roo Code Questions

- **Discord**: https://discord.gg/roocode (DM Hannes Rudolph for contributor access)
- **Reddit**: https://www.reddit.com/r/RooCode/
- **GitHub Issues**: https://github.com/RooCodeInc/Roo-Code/issues

## Next Steps

After completing this setup:

1. **Review Architecture**: Read all documents in `research/` directory
2. **Understand Current Implementation**: Study [`src/core/task/Task.ts`](src/core/task/Task.ts:1)
3. **Plan Implementation**: Design parallel execution architecture
4. **Write Tests First**: TDD approach for new functionality
5. **Implement Features**: Follow extension strategy from research
6. **Document Decisions**: Update architecture docs as you go

## Troubleshooting

### Build Issues

If you encounter build errors:

```bash
# Clean all build artifacts
pnpm run clean

# Clear pnpm cache
pnpm store prune

# Reinstall dependencies
rm -rf node_modules
pnpm install

# Rebuild
pnpm run build
```

### Test Issues

If tests fail unexpectedly:

```bash
# Update snapshots if needed
cd src && npx vitest run -u

# Clear test cache
cd src && npx vitest run --clearCache
```

### Git Issues

If you have merge conflicts or branch issues:

```bash
# Save your work
git stash

# Update from main
git fetch origin
git rebase origin/main

# Reapply your work
git stash pop

# Resolve conflicts, then continue
git rebase --continue
```

## Development Environment Validation

Run these commands to verify your setup is correct:

```bash
# Check Node.js and pnpm versions
node --version; pnpm --version

# Verify git configuration
git config --get user.name
git config --get user.email

# Check current branch
git branch --show-current
# Expected: feature/touch-and-go-parallel-execution

# Build the project
pnpm run build
# Should complete without errors (may show cache hits)

# Run backend tests
cd src && npx vitest run --reporter=verbose
# Expected: 219+ test files passed (87 may fail on tree-sitter)

# Run frontend tests
cd ../webview-ui && npx vitest run --reporter=verbose
# Expected: 94 test files passed, 1108+ tests passed
```

If all of the above complete successfully, your development environment is ready for Touch and Go implementation!

## Important Notes

### Windows Development

- Use PowerShell syntax for commands (`;` instead of `&&`)
- Git is configured with `core.autocrlf=true` for proper line ending handling
- Paths use forward slashes in the codebase

### Test Execution Rules

From `.roo/rules/rules.md`:

> Tests must be run from the same directory as the `package.json` file that specifies `vitest` in `devDependencies`

Always ensure you're in the correct directory:

- Backend: `cd src` before running tests
- Frontend: `cd webview-ui` before running tests

### Code Quality

Before committing:

1. Ensure all new code has test coverage
2. Run linter: `pnpm run lint`
3. Format code: `pnpm run format`
4. Verify tests pass (excluding known tree-sitter issues)

## Continuous Integration

When you push your branch:

- Automated CI will run all tests
- Build verification will occur
- Linting will be checked
- Type checking will be performed

Fix any CI failures before requesting review.

---

**Happy Coding!** If you encounter issues not covered in this guide, please update this document or reach out on Discord.
