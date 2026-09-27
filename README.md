# GitGuard: AI-Powered Safe Push & Auto-Remediation

**GitGuard** is an AI-powered Visual Studio Code extension built for the **IBM Bob 2.0 Hackathon**. It acts as an autonomous safety net for novice developers, student programmers, and teams by eliminating Git friction, preventing credential leaks, and resolving terminal errors before code reaches GitHub.

Powered by a **3-Agent Architecture** leveraging **IBM Bob 2.0**, GitGuard replaces risky, manual command-line troubleshooting with a single, intelligent **"Safe Push"** action.

---

## Features

### 🛡️ One-Click Safe Push
Trigger `GitGuard: Safe Push` directly from the editor title bar, Source Control panel navigation, or Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).

### 🤖 3-Agent Autonomous Pipeline
* **Agent 1 (Inspector):** Executes zero-latency local scans on staged files, `git status`, and `git diff` to intercept hardcoded API keys (`sk_live_...`, `AKIA...`), database files (`.db`, `.sqlite`), unignored `.env` files, and oversized binaries before they leave your machine.
* **Agent 2 (Architect / IBM Bob 2.0):** Intercepts raw terminal failures and diagnostic outputs. It synthesizes complex Git errors (`fatal: empty ident name`, missing upstreams) into plain-English explanations presented in an interactive VS Code notification modal.
* **Agent 3 (Remediator):** Automatically applies deterministic fixes upon confirmation—generating `.gitignore` rules, unstaging sensitive files via `git rm --cached`, setting upstream tracking branches, or refactoring hardcoded secrets into `process.env` variables.

---

## Requirements

* **Visual Studio Code:** Version `^1.85.0` or higher.
* **Git:** Local Git installation added to your system `PATH`.
* **IBM Bob 2.0 / Language Model API:** Required for Agent 2 AI solution synthesis and Agent 3 secret refactoring. Basic regex and local Git remediations run 100% offline with zero setup.

---

## Extension Settings

GitGuard contributes the following settings through VS Code configuration:

* `gitGuard.enableAutoScan`: Enable or disable automatic pre-flight scans prior to `git push` execution (Default: `true`).
* `gitGuard.maxFileSizeMB`: Maximum allowed file size in megabytes before Agent 1 flags the file as bloat (Default: `100`).
* `gitGuard.aiEngine`: Select the AI model backend for Agent 2 error analysis (Default: `IBM Bob 2.0`).

---

## Known Issues

* **Extension Host Isolation:** When running inside the VS Code `[Extension Development Host]` debug environment (`F5`), browser-based OAuth logins for GitHub may fail due to sandbox profile isolation. It is recommended to test using local Git repositories or set up remotes with Personal Access Tokens (`PAT`).
* **Interactive Rebase Conflicts:** Complex multi-file merge conflicts currently fall back to manual editor resolution with guidance provided by Agent 2.

---

## Release Notes

### 0.0.1 (Hackathon Initial Release)

* Initial release for the IBM Bob 2.0 Hackathon.
* Implemented 3-Agent Architecture (Inspector, Architect, Remediator).
* Added editor title bar and SCM navigation icon for `gitGuard.safePush`.
* Integrated automated `.gitignore` generation, local regex key detection, and IBM Bob 2.0 error synthesis.

---

## For More Information

* [IBM Bob 2.0 Hackathon Documentation](https://www.ibm.com)
* [VS Code Extension API Reference](https://code.visualstudio.com/api)

**Enjoy safe, zero-stress version control with GitGuard!**
