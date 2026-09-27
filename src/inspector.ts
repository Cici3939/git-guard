import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

// ── Diagnosis types ───────────────────────────────────────────────────────────

export type DiagnosisType =
    // Sync & state
    | 'OUT_OF_SYNC'
    | 'NO_UPSTREAM'
    | 'MERGE_CONFLICT'
    | 'DETACHED_HEAD'
    | 'REBASE_IN_PROGRESS'
    | 'CHERRY_PICK_IN_PROGRESS'
    | 'BISECT_IN_PROGRESS'
    | 'FORCE_PUSH_REJECTED'
    | 'SHALLOW_REPO'
    // Security & bloat
    | 'HARDCODED_SECRET'
    | 'UNTRACKED_SENSITIVE_FILES'
    | 'FILE_TOO_LARGE'
    | 'CERTIFICATE_FILE'
    | 'REPO_PROTECTED'
    // Corruption & pack
    | 'CORRUPT_OBJECT'
    | 'PACK_ERROR'
    | 'SUBMODULE_ERROR'
    // Auth & network
    | 'AUTH_FAILED'
    | 'NETWORK_ERROR'
    // Config & setup
    | 'MISSING_GIT_CONFIG'
    | 'NOT_A_GIT_REPO'
    | 'LOCKED_INDEX'
    // Unknown
    | 'UNKNOWN_ERROR';

export interface Diagnosis {
    type: DiagnosisType;
    rawError: string;
    targetFiles?: string[];
    /** Branch name, populated when type is NO_UPSTREAM */
    branchName?: string;
}

// ── Proactive warning types ───────────────────────────────────────────────────

export type ProactiveWarningType =
    | 'COMMITTING_NODE_MODULES'
    | 'COMMITTING_BUILD_ARTIFACTS'
    | 'COMMITTING_OS_JUNK'
    | 'COMMITTING_IDE_CONFIG'
    | 'COMMITTING_CERTIFICATES'
    | 'COMMITTING_PYTHON_CACHE'
    | 'CONFLICT_MARKERS_IN_FILES'
    | 'DEBUG_STATEMENTS_IN_CODE'
    | 'PUSHING_TO_MAIN_DIRECTLY'
    | 'EMPTY_OR_VAGUE_COMMIT_MSG'
    | 'TOO_MANY_FILES_STAGED'
    | 'HARDCODED_SECRET_IN_DIFF';

export interface ProactiveWarning {
    type: ProactiveWarningType;
    message: string;
    /** Specific files that triggered this warning */
    affectedFiles: string[];
    /** Whether this is safe to bypass (false = must fix) */
    canContinue: boolean;
}

// ── Agent 1a: Reactive failure inspector ─────────────────────────────────────

/**
 * Called AFTER git commit/push fails.
 * Classifies the raw stderr into a structured Diagnosis using local rules,
 * a filesystem scan, and Bob 2.0 as a final fallback.
 */
export async function inspectFailure(rootPath: string, rawError: string): Promise<Diagnosis> {
    const err = rawError.toLowerCase();

    // ── 1. Sync & state errors ────────────────────────────────────────────────
    if (rawError.includes('non-fast-forward') || rawError.includes('fetch first') ||
        rawError.includes('Updates were rejected because the remote contains work')) {
        return { type: 'OUT_OF_SYNC', rawError };
    }

    if (rawError.includes('no tracking information') || rawError.includes('has no upstream branch') ||
        rawError.includes('There is no tracking information')) {
        const branchName = await getCurrentBranch(rootPath);
        return { type: 'NO_UPSTREAM', rawError, branchName };
    }

    if (rawError.includes('Automatic merge failed') || rawError.includes('CONFLICT')) {
        return { type: 'MERGE_CONFLICT', rawError };
    }

    if (err.includes('detached head') || err.includes('not on a branch') ||
        rawError.includes('HEAD detached')) {
        return { type: 'DETACHED_HEAD', rawError };
    }

    if (err.includes('rebase in progress') || err.includes('rebase-merge') ||
        fs.existsSync(path.join(rootPath, '.git', 'rebase-merge')) ||
        fs.existsSync(path.join(rootPath, '.git', 'rebase-apply'))) {
        return { type: 'REBASE_IN_PROGRESS', rawError };
    }

    if (err.includes('cherry-pick') && (err.includes('in progress') || err.includes('unfinished'))) {
        return { type: 'CHERRY_PICK_IN_PROGRESS', rawError };
    }

    if (err.includes('bisect') && err.includes('in progress')) {
        return { type: 'BISECT_IN_PROGRESS', rawError };
    }

    if (err.includes('rejected') && (err.includes('force') || err.includes('non-fast-forward')) &&
        err.includes('protected')) {
        return { type: 'REPO_PROTECTED', rawError };
    }

    if (err.includes('[rejected]') && err.includes('stale info') ||
        (err.includes('rejected') && err.includes('would clobber'))) {
        return { type: 'FORCE_PUSH_REJECTED', rawError };
    }

    if (err.includes('shallow') || err.includes('unrelated histories') ||
        err.includes('--allow-unrelated-histories')) {
        return { type: 'SHALLOW_REPO', rawError };
    }

    // ── 2. Security & file bloat errors ──────────────────────────────────────
    if (rawError.includes('pre-receive hook declined') || rawError.includes('GH007') ||
        rawError.includes('secret scanning') || rawError.includes('secret')) {
        return { type: 'HARDCODED_SECRET', rawError };
    }

    if (rawError.includes('exceeds GitHub') || rawError.includes('file size limit') ||
        rawError.includes('LFS')) {
        const targetFiles = parseLargeFileNames(rawError);
        return { type: 'FILE_TOO_LARGE', rawError, targetFiles };
    }

    if (err.includes('branch is protected') || err.includes('push to protected branch') ||
        err.includes('cannot push to a protected branch')) {
        return { type: 'REPO_PROTECTED', rawError };
    }

    // ── 3. Corruption & pack errors ───────────────────────────────────────────
    if (err.includes('corrupt') || err.includes('bad object') || err.includes('invalid object')) {
        return { type: 'CORRUPT_OBJECT', rawError };
    }

    if (err.includes('pack') && (err.includes('error') || err.includes('failed') ||
        err.includes('missing'))) {
        return { type: 'PACK_ERROR', rawError };
    }

    if (err.includes('submodule') && (err.includes('error') || err.includes('failed') ||
        err.includes('not initialized'))) {
        return { type: 'SUBMODULE_ERROR', rawError };
    }

    // ── 4. Auth & network errors ──────────────────────────────────────────────
    if (rawError.includes('Authentication failed') || rawError.includes('Permission to') ||
        rawError.includes('denied to') || err.includes('403')) {
        return { type: 'AUTH_FAILED', rawError };
    }

    if (rawError.includes('Could not resolve host') || rawError.includes('Failed to connect') ||
        rawError.includes('unable to access') || err.includes('connection refused') ||
        err.includes('timed out') || err.includes('network is unreachable')) {
        return { type: 'NETWORK_ERROR', rawError };
    }

    // ── 5. Config & repository setup errors ──────────────────────────────────
    if (rawError.includes('Please tell me who you are') || rawError.includes('Author identity unknown') ||
        rawError.includes('user.email') || rawError.includes('user.name')) {
        return { type: 'MISSING_GIT_CONFIG', rawError };
    }

    if (rawError.includes('not a git repository')) {
        return { type: 'NOT_A_GIT_REPO', rawError };
    }

    if (rawError.includes('index.lock') || rawError.includes('Another git process')) {
        return { type: 'LOCKED_INDEX', rawError };
    }

    // ── 6. Filesystem scan fallback ───────────────────────────────────────────
    const { stdout: status } = await execAsync('git status --porcelain', { cwd: rootPath })
        .catch(() => ({ stdout: '' }));

    if (/\.(db|sqlite|env)(\s|$)/i.test(status) || status.includes('node_modules')) {
        return { type: 'UNTRACKED_SENSITIVE_FILES', rawError };
    }

    const { stdout: diff } = await execAsync('git diff HEAD', { cwd: rootPath })
        .catch(() => ({ stdout: '' }));

    // Secret patterns in diff
    if (/(sk_live_[0-9a-zA-Z]{24}|AKIA[0-9A-Z]{16}|ghp_[0-9a-zA-Z]{36}|-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY)/g.test(diff)) {
        return { type: 'HARDCODED_SECRET', rawError };
    }

    // Certificate/key files in diff header
    if (/\+\+\+ b\/.*\.(pem|key|p12|pfx|crt|cer)/i.test(diff)) {
        return { type: 'CERTIFICATE_FILE', rawError };
    }

    // ── 7. Bob 2.0 LLM classification (last resort) ───────────────────────────
    try {
        const llmType = await classifyWithBob(rawError);
        if (llmType) {
            return { type: llmType, rawError };
        }
    } catch {
        // LLM unavailable — fall through
    }

    return { type: 'UNKNOWN_ERROR', rawError };
}

// ── Agent 1b: Proactive pre-commit scanner ────────────────────────────────────

/**
 * Called BEFORE git add/commit runs.
 * Scans staged files + the working tree for silent user mistakes that Git
 * would happily accept but that will cause problems later.
 * Returns an array of warnings — empty means "all clear".
 */
export async function proactiveScan(rootPath: string, commitMsg: string): Promise<ProactiveWarning[]> {
    const warnings: ProactiveWarning[] = [];

    // Get all files that WILL be staged by `git add .` — includes untracked + modified
    const { stdout: statusRaw } = await execAsync('git status --porcelain', { cwd: rootPath })
        .catch(() => ({ stdout: '' }));
    const stagedFiles = statusRaw
        .split('\n')
        .filter(l => l.trim())
        .map(l => l.slice(3).trim()); // strip XY status prefix

    // Use working-tree diff (not --cached) because nothing is staged yet at scan time.
    // Also grab any already-staged content so we cover both cases.
    const { stdout: diffCached } = await execAsync('git diff --cached', { cwd: rootPath })
        .catch(() => ({ stdout: '' }));
    const { stdout: diffWorking } = await execAsync('git diff', { cwd: rootPath })
        .catch(() => ({ stdout: '' }));
    const diffRaw = diffCached + diffWorking;

    // ── Check: node_modules ───────────────────────────────────────────────────
    const nodeModulesFiles = stagedFiles.filter(f => f.startsWith('node_modules'));
    if (nodeModulesFiles.length > 0) {
        warnings.push({
            type: 'COMMITTING_NODE_MODULES',
            message: 'node_modules/ is being committed. This folder contains thousands of dependency files '
                + 'that shouldn\'t be in Git — they can be restored with `npm install`. '
                + 'GitGuard will add node_modules/ to .gitignore and untrack it.',
            affectedFiles: nodeModulesFiles.slice(0, 5),
            canContinue: false,
        });
    }

    // ── Check: build artifacts ────────────────────────────────────────────────
    const buildPatterns = /^(dist|out|build|target|\.next|\.nuxt|coverage|\.cache)\//;
    const buildExtensions = /\.(class|o|obj|pyc|pyo|so|dll|dylib|exe|bin|wasm)$/i;
    const buildFiles = stagedFiles.filter(f => buildPatterns.test(f) || buildExtensions.test(f));
    if (buildFiles.length > 0) {
        warnings.push({
            type: 'COMMITTING_BUILD_ARTIFACTS',
            message: 'Compiled or generated build files are being committed. These are produced by your '
                + 'build tool and shouldn\'t be tracked — they\'ll be regenerated automatically. '
                + 'GitGuard will add them to .gitignore.',
            affectedFiles: buildFiles.slice(0, 5),
            canContinue: true,
        });
    }

    // ── Check: OS junk files ──────────────────────────────────────────────────
    const osJunkFiles = stagedFiles.filter(f =>
        /^(\.DS_Store|Thumbs\.db|desktop\.ini|\.Spotlight-V100|\.Trashes|ehthumbs\.db)$/i.test(path.basename(f))
    );
    if (osJunkFiles.length > 0) {
        warnings.push({
            type: 'COMMITTING_OS_JUNK',
            message: 'System-generated files (like .DS_Store or Thumbs.db) are being committed. '
                + 'These are created by your operating system and serve no purpose in a shared repository. '
                + 'GitGuard will remove and ignore them.',
            affectedFiles: osJunkFiles,
            canContinue: true,
        });
    }

    // ── Check: IDE config ─────────────────────────────────────────────────────
    const ideFiles = stagedFiles.filter(f =>
        /^(\.idea\/|\.vscode\/settings\.json|\.vscode\/launch\.json|\.eclipse\/|nbproject\/)/i.test(f)
    );
    if (ideFiles.length > 0) {
        warnings.push({
            type: 'COMMITTING_IDE_CONFIG',
            message: 'IDE configuration files are being committed. These contain settings specific to your '
                + 'computer and can cause problems for teammates using different setups. '
                + 'GitGuard will add them to .gitignore.',
            affectedFiles: ideFiles.slice(0, 5),
            canContinue: true,
        });
    }

    // ── Check: certificate / private key files ────────────────────────────────
    const certFiles = stagedFiles.filter(f =>
        /\.(pem|key|p12|pfx|crt|cer|jks|keystore)$/i.test(f)
    );
    if (certFiles.length > 0) {
        warnings.push({
            type: 'COMMITTING_CERTIFICATES',
            message: 'Private key or certificate files are being committed. Pushing these to GitHub '
                + 'would expose your credentials publicly and is a critical security risk. '
                + 'GitGuard will untrack them immediately and add them to .gitignore.',
            affectedFiles: certFiles,
            canContinue: false,
        });
    }

    // ── Check: Python cache ───────────────────────────────────────────────────
    const pyFiles = stagedFiles.filter(f =>
        f.includes('__pycache__') || f.endsWith('.pyc') || f.endsWith('.pyo')
    );
    if (pyFiles.length > 0) {
        warnings.push({
            type: 'COMMITTING_PYTHON_CACHE',
            message: 'Python bytecode cache files (__pycache__ / .pyc) are being committed. '
                + 'These are auto-generated by Python and have no place in version control. '
                + 'GitGuard will remove them and add the patterns to .gitignore.',
            affectedFiles: pyFiles.slice(0, 5),
            canContinue: true,
        });
    }

    // ── Check: unresolved conflict markers ────────────────────────────────────
    const { stdout: conflictCheck } = await execAsync(
        'git diff --cached -G"^(<<<<<<<|=======|>>>>>>>)" --name-only',
        { cwd: rootPath }
    ).catch(() => ({ stdout: '' }));
    const conflictFiles = conflictCheck.split('\n').filter(f => f.trim());
    if (conflictFiles.length > 0) {
        warnings.push({
            type: 'CONFLICT_MARKERS_IN_FILES',
            message: 'One or more files still contain Git conflict markers (<<<<<<< / ======= / >>>>>>>). '
                + 'This means a merge conflict was not fully resolved. Committing this will break your code. '
                + 'You must resolve these before pushing.',
            affectedFiles: conflictFiles,
            canContinue: false,
        });
    }

    // ── Check: debug statements ───────────────────────────────────────────────
    const debugPattern = /^\+.*(console\.log\(|debugger;|print\(f?["']DEBUG|pdb\.set_trace\(\)|binding\.pry|var_dump\(|dd\()/;
    const debugFiles: string[] = [];
    let currentFile = '';
    for (const line of diffRaw.split('\n')) {
        if (line.startsWith('+++ b/')) { currentFile = line.slice(6); }
        if (debugPattern.test(line) && currentFile && !debugFiles.includes(currentFile)) {
            debugFiles.push(currentFile);
        }
    }
    if (debugFiles.length > 0) {
        warnings.push({
            type: 'DEBUG_STATEMENTS_IN_CODE',
            message: 'Debug statements (console.log, debugger, pdb.set_trace, etc.) were found in your '
                + 'staged changes. These are usually temporary and shouldn\'t be committed to the main branch.',
            affectedFiles: debugFiles.slice(0, 5),
            canContinue: true,
        });
    }

    // ── Check: pushing directly to main/master ────────────────────────────────
    const currentBranch = await getCurrentBranch(rootPath);
    if (currentBranch === 'main' || currentBranch === 'master') {
        warnings.push({
            type: 'PUSHING_TO_MAIN_DIRECTLY',
            message: 'You are about to commit and push directly to the main branch. '
                + 'This is risky — if something goes wrong it affects everyone using the repo. '
                + 'Consider creating a feature branch instead.',
            affectedFiles: [],
            canContinue: true,
        });
    }

    // ── Check: empty / vague commit message ──────────────────────────────────
    const vagueMessages = /^(update|fix|wip|test|temp|tmp|asdf|qwerty|\.{1,3}|changes?|stuff|misc|commit)$/i;
    if (!commitMsg.trim() || vagueMessages.test(commitMsg.trim())) {
        warnings.push({
            type: 'EMPTY_OR_VAGUE_COMMIT_MSG',
            message: `The commit message "${commitMsg}" is too vague to be useful. `
                + 'Good commit messages describe what changed and why '
                + '(e.g., "fix: resolve login crash on empty password").',
            affectedFiles: [],
            canContinue: true,
        });
    }

    // ── Check: too many files staged ─────────────────────────────────────────
    if (stagedFiles.length > 100) {
        warnings.push({
            type: 'TOO_MANY_FILES_STAGED',
            message: `${stagedFiles.length} files are about to be committed in one go. `
                + 'Large commits are hard to review and debug. Check that you\'re not accidentally '
                + 'committing generated or ignored files.',
            affectedFiles: [],
            canContinue: true,
        });
    }

    // ── Check: hardcoded secrets in staged diff ───────────────────────────────
    // Strip the leading '+' diff prefix before testing so regexes match normally
    const secretPattern = /(sk_live_[0-9a-zA-Z]{24,}|AKIA[0-9A-Z]{16}|ghp_[0-9a-zA-Z]{36,}|-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY|AIza[0-9A-Za-z\-_]{35}|(?:[\w]*(?:key|token|secret|password|api_key|apikey|passwd)[\w]*)\s*=\s*['"`][^'"`\n]{6,}['"`])/gi;
    // Also scan the raw file list directly — diff may be empty for new untracked files
    const addedLines = diffRaw.split('\n')
        .filter(l => l.startsWith('+') && !l.startsWith('+++'))
        .map(l => l.slice(1)); // strip the leading +
    // For new untracked files that aren't in the diff yet, read them directly
    const newFiles = stagedFiles.filter(f => statusRaw.match(new RegExp(`^\\?\\? .*${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm')));
    const newFileContent = newFiles.map(f => {
        try { return require('fs').readFileSync(require('path').join(rootPath, f), 'utf8'); } catch { return ''; }
    }).join('\n');
    const contentToScan = addedLines.join('\n') + '\n' + newFileContent;
    const secretFound = secretPattern.test(contentToScan);
    if (secretFound) {
        warnings.push({
            type: 'HARDCODED_SECRET_IN_DIFF',
            message: 'A potential API key, password, or token was found in your changes. '
                + 'Pushing this to GitHub — even a private repo — is a serious security risk. '
                + 'GitGuard will extract it to a .env file and rewrite your code to use it safely.',
            affectedFiles: [],
            canContinue: false,
        });
    }

    return warnings;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function getCurrentBranch(rootPath: string): Promise<string | undefined> {
    try {
        const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: rootPath });
        return stdout.trim();
    } catch {
        return undefined;
    }
}

function parseLargeFileNames(errorText: string): string[] {
    const matches = errorText.match(/File\s+(.+?)\s+is\s+[\d.]+\s+MB/g) ?? [];
    return matches.map(m => m.replace(/^File\s+/, '').replace(/\s+is\s+[\d.]+\s+MB$/, '').trim());
}

/**
 * Picks the best available language model.
 *
 * vscode.lm.selectChatModels returns a Thenable (not Promise), so we wrap with
 * Promise.resolve(). We try families in preference order and fall back to
 * whatever model is available — this ensures it works with any Copilot plan.
 */
export async function selectBestModel(): Promise<vscode.LanguageModelChat | undefined> {
    // First: enumerate all models so we can log what's available for debugging
    const all = await Promise.resolve(vscode.lm.selectChatModels({}))
        .catch(() => [] as vscode.LanguageModelChat[]);

    if (all.length === 0) { return undefined; }

    // Try preferred families in order
    for (const family of ['gpt-4o', 'gpt-4.1', 'gpt-4', 'claude-sonnet-4', 'claude-sonnet', 'gemini-2.0-flash']) {
        const match = all.find(m => m.family === family || m.id.toLowerCase().includes(family.toLowerCase()));
        if (match) { return match; }
    }

    // Return the first available model as final fallback
    return all[0];
}

/**
 * Asks Bob 2.0 to classify a raw git error into one of our DiagnosisType values.
 */
async function classifyWithBob(rawError: string): Promise<DiagnosisType | undefined> {
    const model = await selectBestModel();
    if (!model) { return undefined; }

    const validTypes: DiagnosisType[] = [
        'OUT_OF_SYNC', 'NO_UPSTREAM', 'MERGE_CONFLICT', 'DETACHED_HEAD',
        'REBASE_IN_PROGRESS', 'CHERRY_PICK_IN_PROGRESS', 'BISECT_IN_PROGRESS',
        'FORCE_PUSH_REJECTED', 'SHALLOW_REPO', 'HARDCODED_SECRET',
        'UNTRACKED_SENSITIVE_FILES', 'FILE_TOO_LARGE', 'CERTIFICATE_FILE',
        'REPO_PROTECTED', 'CORRUPT_OBJECT', 'PACK_ERROR', 'SUBMODULE_ERROR',
        'AUTH_FAILED', 'NETWORK_ERROR', 'MISSING_GIT_CONFIG',
        'NOT_A_GIT_REPO', 'LOCKED_INDEX', 'UNKNOWN_ERROR',
    ];

    const prompt =
        `You are a Git expert. Classify the following git error into exactly ONE of these types:\n` +
        `${validTypes.join(', ')}\n\n` +
        `Respond with ONLY the type string, nothing else.\n\nError:\n${rawError}`;

    const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {}
    );

    let result = '';
    for await (const chunk of response.text) { result += chunk; }
    const candidate = result.trim() as DiagnosisType;
    return validTypes.includes(candidate) ? candidate : 'UNKNOWN_ERROR';
}
