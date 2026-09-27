import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Diagnosis, ProactiveWarning } from './inspector';

const execAsync = promisify(exec);

// ── Agent 3a: Reactive fixer ──────────────────────────────────────────────────

/**
 * Executes an automated repair for a diagnosed git failure.
 * Returns true  → fix applied, retry `git push`
 * Returns false → fix either already pushed, requires manual action, or is advisory only
 */
export async function executeFix(rootPath: string, diagnosis: Diagnosis): Promise<boolean> {
    switch (diagnosis.type) {

        // ── Sync & state ──────────────────────────────────────────────────────

        case 'OUT_OF_SYNC': {
            await execAsync('git stash', { cwd: rootPath });
            await execAsync('git pull --rebase', { cwd: rootPath });
            try { await execAsync('git stash pop', { cwd: rootPath }); } catch { /* nothing to pop */ }
            return true;
        }

        case 'NO_UPSTREAM': {
            const branch = diagnosis.branchName ?? await getCurrentBranch(rootPath);
            if (!branch) { throw new Error('Could not determine current branch name.'); }
            await execAsync(`git push --set-upstream origin ${branch}`, { cwd: rootPath });
            return false; // push already succeeded above
        }

        case 'MERGE_CONFLICT': {
            await vscode.commands.executeCommand('git.openMergeEditor');
            vscode.window.showWarningMessage(
                'GitGuard: Conflicts are open in the editor. Resolve them, save, then run Safe Push again.'
            );
            return false;
        }

        case 'DETACHED_HEAD': {
            const branchName = await vscode.window.showInputBox({
                prompt: 'You are in a "detached HEAD" state. Enter a name for a new branch to save your work:',
                placeHolder: 'e.g. my-work-branch',
                validateInput: v => /^[a-zA-Z0-9_\-./]+$/.test(v.trim()) ? null : 'Use letters, numbers, hyphens, underscores or dots only',
            });
            if (!branchName) { return false; }
            await execAsync(`git switch -c ${branchName}`, { cwd: rootPath });
            return true;
        }

        case 'REBASE_IN_PROGRESS': {
            const choice = await vscode.window.showWarningMessage(
                'GitGuard: A rebase is in progress. What would you like to do?',
                { modal: true },
                'Abort Rebase',
                'Continue Rebase'
            );
            if (choice === 'Abort Rebase') {
                await execAsync('git rebase --abort', { cwd: rootPath });
                return true;
            }
            if (choice === 'Continue Rebase') {
                await execAsync('git rebase --continue', { cwd: rootPath });
                return true;
            }
            return false;
        }

        case 'CHERRY_PICK_IN_PROGRESS': {
            const choice = await vscode.window.showWarningMessage(
                'GitGuard: A cherry-pick is in progress. What would you like to do?',
                { modal: true },
                'Abort Cherry-Pick',
                'Continue Cherry-Pick'
            );
            if (choice === 'Abort Cherry-Pick') {
                await execAsync('git cherry-pick --abort', { cwd: rootPath });
                return true;
            }
            if (choice === 'Continue Cherry-Pick') {
                await execAsync('git cherry-pick --continue', { cwd: rootPath });
                return true;
            }
            return false;
        }

        case 'BISECT_IN_PROGRESS': {
            await execAsync('git bisect reset', { cwd: rootPath });
            vscode.window.showInformationMessage('GitGuard: Bisect session ended. You can now push.');
            return true;
        }

        case 'FORCE_PUSH_REJECTED': {
            vscode.window.showWarningMessage(
                'GitGuard: Your push was rejected because it would overwrite remote changes. '
                + 'Run `git pull --rebase` first, resolve any conflicts, then push again.'
            );
            return false;
        }

        case 'SHALLOW_REPO': {
            await execAsync('git fetch --unshallow', { cwd: rootPath }).catch(() => {});
            return true;
        }

        case 'REPO_PROTECTED': {
            vscode.window.showWarningMessage(
                'GitGuard: This branch is protected and cannot be pushed to directly. '
                + 'Create a new branch and open a Pull Request instead.'
            );
            return false;
        }

        // ── Security & file bloat ─────────────────────────────────────────────

        case 'HARDCODED_SECRET':
        case 'UNTRACKED_SENSITIVE_FILES': {
            // Use the full secret refactor: scan files, extract keys, create .env, rewrite code
            const refactored = await refactorSecretsToEnv(rootPath);
            if (!refactored) {
                // Fallback: at minimum untrack sensitive files and gitignore them
                await basicSecretCleanup(rootPath);
            }
            return true;
        }

        case 'FILE_TOO_LARGE': {
            const gitignorePath = path.join(rootPath, '.gitignore');
            const files = diagnosis.targetFiles ?? [];
            let entries = '\n# GitGuard: large file auto-exclusion\n';
            for (const file of files) {
                await execAsync(`git rm --cached --ignore-unmatch "${file}"`, { cwd: rootPath }).catch(() => {});
                const ext = path.extname(file);
                if (ext) { entries += `*${ext}\n`; }
            }
            fs.appendFileSync(gitignorePath, entries);
            await execAsync('git add .gitignore', { cwd: rootPath });
            await execAsync('git commit --amend --no-edit', { cwd: rootPath }).catch(() => {});
            return true;
        }

        case 'CERTIFICATE_FILE': {
            const gitignorePath = path.join(rootPath, '.gitignore');
            const entries = '\n# GitGuard: certificate & key files\n*.pem\n*.key\n*.p12\n*.pfx\n*.crt\n*.cer\n*.jks\n*.keystore\n';
            fs.appendFileSync(gitignorePath, entries);
            for (const ext of ['pem', 'key', 'p12', 'pfx', 'crt', 'cer', 'jks', 'keystore']) {
                await execAsync(`git rm --cached -r --ignore-unmatch "*.${ext}"`, { cwd: rootPath }).catch(() => {});
            }
            await execAsync('git add .gitignore', { cwd: rootPath });
            await execAsync('git commit --amend --no-edit', { cwd: rootPath }).catch(() => {});
            return true;
        }

        // ── Corruption & pack ─────────────────────────────────────────────────

        case 'CORRUPT_OBJECT':
        case 'PACK_ERROR': {
            await execAsync('git fsck --full', { cwd: rootPath }).catch(() => {});
            await execAsync('git gc --aggressive --prune=now', { cwd: rootPath }).catch(() => {});
            vscode.window.showInformationMessage(
                'GitGuard: Ran git fsck and gc to repair the repository. Try pushing again.'
            );
            return true;
        }

        case 'SUBMODULE_ERROR': {
            await execAsync('git submodule update --init --recursive', { cwd: rootPath }).catch(() => {});
            return true;
        }

        // ── Auth & network ────────────────────────────────────────────────────

        case 'AUTH_FAILED': {
            await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
            return true;
        }

        case 'NETWORK_ERROR': {
            vscode.window.showWarningMessage(
                'GitGuard: No network connection detected. Check your internet and run Safe Push again.'
            );
            return false;
        }

        // ── Config & repo setup ───────────────────────────────────────────────

        case 'MISSING_GIT_CONFIG': {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter your full name for Git commits',
                placeHolder: 'e.g. Jane Smith',
                validateInput: v => v.trim().length === 0 ? 'Name is required' : null,
            });
            if (!name) { return false; }

            const email = await vscode.window.showInputBox({
                prompt: 'Enter your email address for Git commits',
                placeHolder: 'e.g. jane@example.com',
                validateInput: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Enter a valid email address',
            });
            if (!email) { return false; }

            await execAsync(`git config user.name "${name.replace(/"/g, '\\"')}"`, { cwd: rootPath });
            await execAsync(`git config user.email "${email.replace(/"/g, '\\"')}"`, { cwd: rootPath });
            return true;
        }

        case 'NOT_A_GIT_REPO': {
            await execAsync('git init', { cwd: rootPath });
            vscode.window.showInformationMessage('GitGuard: Git initialised. Add a remote and try again.');
            return false;
        }

        case 'LOCKED_INDEX': {
            const lockFile = path.join(rootPath, '.git', 'index.lock');
            if (fs.existsSync(lockFile)) { fs.unlinkSync(lockFile); }
            return true;
        }

        default:
            throw new Error(`No automated remediation available for error type: ${diagnosis.type}`);
    }
}

// ── Agent 3b: Proactive fixer ─────────────────────────────────────────────────

/**
 * Fixes a proactive warning detected before commit.
 * Returns true  → warning resolved, commit can proceed
 * Returns false → user must act manually before committing
 */
export async function fixProactiveWarning(rootPath: string, warning: ProactiveWarning): Promise<boolean> {
    const gitignorePath = path.join(rootPath, '.gitignore');

    switch (warning.type) {

        case 'COMMITTING_NODE_MODULES': {
            fs.appendFileSync(gitignorePath, '\n# GitGuard\nnode_modules/\n');
            await execAsync('git rm --cached -r --ignore-unmatch node_modules', { cwd: rootPath }).catch(() => {});
            return true;
        }

        case 'COMMITTING_BUILD_ARTIFACTS': {
            const entries = '\n# GitGuard: build artifacts\ndist/\nout/\nbuild/\ntarget/\n.next/\n.nuxt/\ncoverage/\n.cache/\n*.class\n*.o\n*.obj\n*.pyc\n*.pyo\n*.so\n*.dll\n*.dylib\n*.exe\n*.wasm\n';
            fs.appendFileSync(gitignorePath, entries);
            for (const f of warning.affectedFiles) {
                await execAsync(`git rm --cached --ignore-unmatch "${f}"`, { cwd: rootPath }).catch(() => {});
            }
            return true;
        }

        case 'COMMITTING_OS_JUNK': {
            fs.appendFileSync(gitignorePath, '\n# GitGuard: OS files\n.DS_Store\nThumbs.db\ndesktop.ini\n.Spotlight-V100\n.Trashes\nehthumbs.db\n');
            for (const f of warning.affectedFiles) {
                await execAsync(`git rm --cached --ignore-unmatch "${f}"`, { cwd: rootPath }).catch(() => {});
            }
            return true;
        }

        case 'COMMITTING_IDE_CONFIG': {
            fs.appendFileSync(gitignorePath, '\n# GitGuard: IDE config\n.idea/\n.vscode/settings.json\n.vscode/launch.json\n.eclipse/\nnbproject/\n');
            for (const f of warning.affectedFiles) {
                await execAsync(`git rm --cached --ignore-unmatch "${f}"`, { cwd: rootPath }).catch(() => {});
            }
            return true;
        }

        case 'COMMITTING_CERTIFICATES': {
            fs.appendFileSync(gitignorePath, '\n# GitGuard: certificates & keys\n*.pem\n*.key\n*.p12\n*.pfx\n*.crt\n*.cer\n*.jks\n*.keystore\n');
            for (const f of warning.affectedFiles) {
                await execAsync(`git rm --cached --ignore-unmatch "${f}"`, { cwd: rootPath }).catch(() => {});
            }
            return true;
        }

        case 'COMMITTING_PYTHON_CACHE': {
            fs.appendFileSync(gitignorePath, '\n# GitGuard: Python cache\n__pycache__/\n*.pyc\n*.pyo\n');
            await execAsync('git rm --cached -r --ignore-unmatch __pycache__ "*.pyc" "*.pyo"', { cwd: rootPath }).catch(() => {});
            return true;
        }

        case 'HARDCODED_SECRET_IN_DIFF': {
            // Full secret refactor: extract keys from source, create .env, rewrite references
            const refactored = await refactorSecretsToEnv(rootPath);
            if (!refactored) {
                vscode.window.showErrorMessage(
                    'GitGuard: Could not auto-refactor secrets. Remove the secret from your code '
                    + 'and store it in a .env file manually before pushing.'
                );
                return false;
            }
            return true;
        }

        case 'CONFLICT_MARKERS_IN_FILES': {
            vscode.window.showErrorMessage(
                `GitGuard: Resolve the conflict markers in: ${warning.affectedFiles.join(', ')}`
            );
            return false;
        }

        case 'DEBUG_STATEMENTS_IN_CODE':
        case 'PUSHING_TO_MAIN_DIRECTLY':
        case 'EMPTY_OR_VAGUE_COMMIT_MSG':
        case 'TOO_MANY_FILES_STAGED': {
            // Advisory only — user chose to continue
            return true;
        }

        default:
            return true;
    }
}

// ── Secret refactor engine ────────────────────────────────────────────────────

/**
 * A secret pattern definition.
 *
 * matchType:
 *   'value-only'   → the regex matches ONLY the quoted value (e.g. 'sk_live_...')
 *                    replacement = just the env call, e.g. os.environ.get('KEY')
 *   'assignment'   → the regex matches the full assignment (e.g. API_KEY = 'value')
 *                    replacement = VAR_NAME = os.environ.get('VAR_NAME')
 *                    varNameGroup = capture group index for the variable name
 *                    valueGroup   = capture group index for the secret value
 */
interface SecretPattern {
    regex: RegExp;
    varPrefix: string;
    matchType: 'value-only' | 'assignment';
    varNameGroup?: number;   // only for 'assignment'
    valueGroup: number;
}

const SECRET_PATTERNS: SecretPattern[] = [
    // ── Named key patterns (value-only) ──────────────────────────────────────
    // Stripe live key:  'sk_live_...'
    { regex: /(['"`])(sk_live_[0-9a-zA-Z]{24,})\1/g,    varPrefix: 'STRIPE_SECRET_KEY', matchType: 'value-only', valueGroup: 2 },
    // AWS access key:   'AKIA...'
    { regex: /(['"`])(AKIA[0-9A-Z]{16})\1/g,              varPrefix: 'AWS_ACCESS_KEY_ID', matchType: 'value-only', valueGroup: 2 },
    // GitHub PAT:       'ghp_...'
    { regex: /(['"`])(ghp_[0-9a-zA-Z]{36,})\1/g,          varPrefix: 'GITHUB_TOKEN',      matchType: 'value-only', valueGroup: 2 },
    // OpenAI key:       'sk-...'
    { regex: /(['"`])(sk-[a-zA-Z0-9]{32,})\1/g,           varPrefix: 'OPENAI_API_KEY',    matchType: 'value-only', valueGroup: 2 },
    // Google API key:   'AIza...'
    { regex: /(['"`])(AIza[0-9A-Za-z\-_]{35})\1/g,        varPrefix: 'GOOGLE_API_KEY',    matchType: 'value-only', valueGroup: 2 },

    // ── Generic assignment patterns (full line) ───────────────────────────────
    // JS/TS:  const apiKey = 'value'  /  let SECRET = "value"
    {
        regex: /(?:const|let|var)\s+([\w]*(?:key|token|secret|password|api_key|apikey|passwd)[\w]*)\s*=\s*(['"`])([^'"`\n]{6,})\2/gi,
        varPrefix: 'SECRET', matchType: 'assignment', varNameGroup: 1, valueGroup: 3,
    },
    // Python / generic:  API_KEY = 'value'  (bare assignment, any casing)
    {
        regex: /([\w]*(?:key|token|secret|password|api|passwd)[\w]*)\s*=\s*(['"`])([^'"`\n]{6,})\2/gi,
        varPrefix: 'SECRET', matchType: 'assignment', varNameGroup: 1, valueGroup: 3,
    },
];

// Extensions to scan for secrets
const SCAN_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.java', '.cs', '.php',
]);

/**
 * Scans all source files for hardcoded secrets/API keys, extracts each value
 * into a .env file, rewrites the source to use the language-appropriate env
 * variable reference, and adds .env to .gitignore.
 *
 * Returns true if at least one secret was found and refactored.
 */
export async function refactorSecretsToEnv(rootPath: string): Promise<boolean> {
    const envPath = path.join(rootPath, '.env');
    const gitignorePath = path.join(rootPath, '.gitignore');

    const existingEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const newEnvEntries: string[] = [];
    let totalFixed = 0;

    const sourceFiles = walkDir(rootPath, SCAN_EXTENSIONS);

    for (const filePath of sourceFiles) {
        let content: string;
        try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }

        const ext = path.extname(filePath).toLowerCase();
        let modified = content;
        let fileChanged = false;

        for (const pattern of SECRET_PATTERNS) {
            pattern.regex.lastIndex = 0;
            let match: RegExpExecArray | null;

            // Run against the original content so indices stay valid across patterns
            while ((match = pattern.regex.exec(content)) !== null) {
                const secretValue = match[pattern.valueGroup];
                if (!secretValue || secretValue.length < 6) { continue; }

                // Derive env var name
                let varName: string;
                if (pattern.matchType === 'assignment' && pattern.varNameGroup !== undefined) {
                    varName = (match[pattern.varNameGroup] ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '_') || pattern.varPrefix;
                } else {
                    varName = pattern.varPrefix;
                }

                // Add to .env if not already there
                const alreadyInEnv = existingEnv.includes(`${varName}=`) || newEnvEntries.some(e => e.startsWith(`${varName}=`));
                if (!alreadyInEnv) {
                    newEnvEntries.push(`${varName}=${secretValue}`);
                }

                // Build the correct replacement for this match
                const fullMatch = match[0];
                const replacement = buildReplacement(ext, varName, fullMatch, pattern.matchType);

                if (replacement !== fullMatch) {
                    // Replace ALL occurrences of this exact match in the file
                    modified = modified.split(fullMatch).join(replacement);
                    fileChanged = true;
                    totalFixed++;
                }
            }
        }

        if (fileChanged) {
            fs.writeFileSync(filePath, modified, 'utf8');
        }
    }

    if (newEnvEntries.length === 0 && totalFixed === 0) { return false; }

    // Write .env
    if (newEnvEntries.length > 0) {
        const header = existingEnv ? '' : '# GitGuard: auto-extracted secrets — DO NOT COMMIT THIS FILE\n';
        fs.appendFileSync(envPath, `${header}${newEnvEntries.join('\n')}\n`);
    }

    // Ensure .env is gitignored
    const gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (!gitignoreContent.includes('\n.env') && !gitignoreContent.startsWith('.env')) {
        fs.appendFileSync(gitignorePath, '\n# GitGuard: secret files\n.env\n.env.local\n.env.*.local\n');
    }

    // Untrack .env from git if it was previously tracked
    await execAsync('git rm --cached --ignore-unmatch .env .env.local', { cwd: rootPath }).catch(() => {});

    vscode.window.showInformationMessage(
        `GitGuard: Moved ${totalFixed} secret(s) to .env and updated source code references.`
    );
    return true;
}

/**
 * Builds the replacement string for a secret match.
 *
 * For 'value-only' patterns:  replaces just the quoted value with the env call
 * For 'assignment' patterns:  keeps "VAR_NAME = " and replaces only the value
 */
function buildReplacement(ext: string, varName: string, fullMatch: string, matchType: 'value-only' | 'assignment'): string {
    const envCall = envAccessSyntax(ext, varName);

    if (matchType === 'value-only') {
        // fullMatch = 'sk_live_...'  → replace entirely with the env call
        return envCall;
    }

    // matchType === 'assignment'
    // fullMatch = API_KEY = 'sk_live_...'
    // We keep "API_KEY = " and replace only the quoted value part
    // Find where the quoted value starts (after the = sign)
    const eqIndex = fullMatch.indexOf('=');
    if (eqIndex === -1) { return fullMatch; } // safety fallback
    const lhs = fullMatch.slice(0, eqIndex + 1); // "API_KEY ="
    return `${lhs} ${envCall}`;
}

/**
 * Returns the language-appropriate syntax for reading an env variable.
 */
function envAccessSyntax(ext: string, varName: string): string {
    switch (ext) {
        case '.py':               return `os.environ.get('${varName}')`;
        case '.rb':               return `ENV['${varName}']`;
        case '.java': case '.kt': return `System.getenv("${varName}")`;
        case '.php':              return `getenv('${varName}')`;
        case '.go':               return `os.Getenv("${varName}")`;
        case '.cs':               return `Environment.GetEnvironmentVariable("${varName}")`;
        default:                  return `process.env.${varName}`; // JS / TS
    }
}

/**
 * Minimal fallback: just gitignore and untrack sensitive files without code rewriting.
 */
async function basicSecretCleanup(rootPath: string): Promise<void> {
    const gitignorePath = path.join(rootPath, '.gitignore');
    fs.appendFileSync(gitignorePath, '\n# GitGuard: sensitive files\n.env\n*.db\n*.sqlite\nnode_modules/\n');
    for (const pattern of ['.env', '*.db', '*.sqlite']) {
        await execAsync(`git rm --cached -r --ignore-unmatch ${pattern}`, { cwd: rootPath }).catch(() => {});
    }
    await execAsync('git add .gitignore', { cwd: rootPath });
}

/**
 * Recursively walks a directory and returns all files with matching extensions.
 * Skips node_modules, .git, dist, out, build, coverage, .cache directories.
 */
function walkDir(dir: string, extensions: Set<string>, results: string[] = []): string[] {
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.cache', '.next', '.nuxt', 'target']);
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return results;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                walkDir(path.join(dir, entry.name), extensions, results);
            }
        } else if (entry.isFile()) {
            if (extensions.has(path.extname(entry.name).toLowerCase())) {
                results.push(path.join(dir, entry.name));
            }
        }
    }
    return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getCurrentBranch(rootPath: string): Promise<string | undefined> {
    try {
        const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: rootPath });
        return stdout.trim();
    } catch {
        return undefined;
    }
}
