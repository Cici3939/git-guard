import * as vscode from 'vscode';
import { Diagnosis, ProactiveWarning, selectBestModel } from './inspector';

export interface UserFacingExplanation {
    title: string;
    detail: string;
}

// ── Fallback explanations (used when vscode.lm is unavailable) ────────────────

const REACTIVE_FALLBACKS: Record<string, UserFacingExplanation> = {
    OUT_OF_SYNC: {
        title: 'Remote Repository Has New Changes',
        detail: 'Your GitHub repository has commits your machine doesn\'t have yet. '
            + 'GitGuard will safely pull those changes without losing your work, then retry the push.',
    },
    NO_UPSTREAM: {
        title: 'Branch Has No Remote Target',
        detail: 'This branch has never been pushed to GitHub before, so Git doesn\'t know where to send it. '
            + 'GitGuard will link it to GitHub and push automatically.',
    },
    MERGE_CONFLICT: {
        title: 'Merge Conflict Detected',
        detail: 'The same lines were changed both here and on GitHub, and Git can\'t decide which to keep. '
            + 'VS Code will open the conflict editor so you can choose. No push will happen until you resolve them.',
    },
    DETACHED_HEAD: {
        title: 'Not On Any Branch',
        detail: 'Your repository is in "detached HEAD" state — you\'re not on a branch, so Git doesn\'t know where to push. '
            + 'GitGuard will create a new branch from your current position so your work is saved.',
    },
    REBASE_IN_PROGRESS: {
        title: 'Rebase Is Still in Progress',
        detail: 'A previous rebase operation was never completed. You need to finish or abort it before pushing. '
            + 'GitGuard can abort the rebase and restore your branch to its state before it started.',
    },
    CHERRY_PICK_IN_PROGRESS: {
        title: 'Cherry-Pick Is Still in Progress',
        detail: 'A cherry-pick operation started but wasn\'t finished. '
            + 'GitGuard can abort it or help you complete it so you can push.',
    },
    BISECT_IN_PROGRESS: {
        title: 'Git Bisect Session Is Active',
        detail: 'You started a "git bisect" debugging session that\'s still running. '
            + 'GitGuard will end the bisect session and restore your branch so you can push.',
    },
    FORCE_PUSH_REJECTED: {
        title: 'Push Rejected — Would Overwrite Remote Changes',
        detail: 'Your push was blocked because it would erase work that already exists on GitHub. '
            + 'Pull the remote changes first, resolve any conflicts, then push again.',
    },
    SHALLOW_REPO: {
        title: 'Repository History Is Incomplete',
        detail: 'This repository was cloned with limited history (a "shallow" clone) which is '
            + 'preventing the push. GitGuard will download the full history to fix this.',
    },
    REPO_PROTECTED: {
        title: 'This Branch Is Protected',
        detail: 'The repository rules prevent direct pushes to this branch. '
            + 'You need to create a new branch and open a Pull Request to merge your changes.',
    },
    HARDCODED_SECRET: {
        title: 'Exposed API Key or Secret Detected',
        detail: 'A private key, token, or credential was found in the files you\'re trying to push. '
            + 'Pushing this would make it public and compromise your account. '
            + 'GitGuard will move it to a .env file, hide that file from Git, and clean your commit history.',
    },
    UNTRACKED_SENSITIVE_FILES: {
        title: 'Database or .env File Is Being Committed',
        detail: 'A local database (.db/.sqlite) or config file (.env) was about to be uploaded to GitHub. '
            + 'These usually contain private settings. GitGuard will untrack them and add them to .gitignore.',
    },
    FILE_TOO_LARGE: {
        title: 'File Exceeds GitHub\'s 100 MB Limit',
        detail: 'One or more files in your commit are too large for GitHub to accept. '
            + 'GitGuard will remove them from the commit and add their type to .gitignore.',
    },
    CERTIFICATE_FILE: {
        title: 'Certificate or Private Key File Detected',
        detail: 'A .pem, .key, or certificate file was found in your commit. '
            + 'These contain cryptographic secrets and must never be pushed to GitHub. '
            + 'GitGuard will untrack them and add them to .gitignore.',
    },
    CORRUPT_OBJECT: {
        title: 'Git Repository Has Corrupt Data',
        detail: 'Git found damaged data in your repository\'s history. '
            + 'GitGuard will run a repair scan and attempt to fix the corruption automatically.',
    },
    PACK_ERROR: {
        title: 'Git Pack File Error',
        detail: 'A Git internal storage file is broken or missing. '
            + 'GitGuard will attempt a repair with git gc to fix it.',
    },
    SUBMODULE_ERROR: {
        title: 'Git Submodule Is Not Initialised',
        detail: 'This project uses a submodule (a linked repository) that hasn\'t been set up on your machine. '
            + 'GitGuard will initialise and update all submodules automatically.',
    },
    AUTH_FAILED: {
        title: 'GitHub Authentication Failed',
        detail: 'Git couldn\'t log in to GitHub — your credentials may be missing, expired, or incorrect. '
            + 'Please sign in to GitHub through VS Code and retry.',
    },
    NETWORK_ERROR: {
        title: 'Cannot Reach GitHub',
        detail: 'Git couldn\'t connect to github.com. '
            + 'Please check your internet connection, then try pushing again.',
    },
    MISSING_GIT_CONFIG: {
        title: 'Git Identity Not Configured',
        detail: 'Git doesn\'t know your name or email, so it can\'t stamp the commit with an author. '
            + 'GitGuard will ask for your details and configure Git for you.',
    },
    NOT_A_GIT_REPO: {
        title: 'This Folder Is Not a Git Repository',
        detail: 'Git hasn\'t been set up in this project folder yet. '
            + 'GitGuard can initialise it for you with a single click.',
    },
    LOCKED_INDEX: {
        title: 'Git Is Locked by Another Process',
        detail: 'A previous Git operation didn\'t finish cleanly and left a lock file behind. '
            + 'GitGuard will remove the stale lock and retry automatically.',
    },
    UNKNOWN_ERROR: {
        title: 'Unexpected Git Error',
        detail: 'Something went wrong that GitGuard doesn\'t recognise. '
            + 'The raw error is shown below. You can try again or resolve it manually.',
    },
};

const PROACTIVE_FALLBACKS: Record<string, UserFacingExplanation> = {
    COMMITTING_NODE_MODULES: {
        title: 'node_modules Is Being Committed',
        detail: 'The node_modules folder contains thousands of dependency files managed by npm/yarn — '
            + 'it should never be in Git. GitGuard will untrack it and add it to .gitignore.',
    },
    COMMITTING_BUILD_ARTIFACTS: {
        title: 'Build Output Files Detected',
        detail: 'Compiled or generated files (dist/, out/, *.class, etc.) are about to be committed. '
            + 'These are produced automatically by your build tool and don\'t belong in version control. '
            + 'GitGuard will add them to .gitignore.',
    },
    COMMITTING_OS_JUNK: {
        title: 'System Junk Files Detected',
        detail: 'Files like .DS_Store or Thumbs.db are created by your operating system, not your code. '
            + 'They\'re meaningless to other developers and clutter the repository. '
            + 'GitGuard will remove and ignore them.',
    },
    COMMITTING_IDE_CONFIG: {
        title: 'IDE Settings Files Detected',
        detail: 'Files in .idea/ or .vscode/ contain editor settings tied to your personal setup. '
            + 'Committing them can break teammates\' configurations. '
            + 'GitGuard will add them to .gitignore.',
    },
    COMMITTING_CERTIFICATES: {
        title: 'Certificate or Key File Detected — Critical',
        detail: 'A .pem, .key, or certificate file is about to be committed. '
            + 'This is a critical security risk — these files contain private cryptographic secrets. '
            + 'GitGuard will block this commit and add the files to .gitignore.',
    },
    COMMITTING_PYTHON_CACHE: {
        title: 'Python Cache Files Detected',
        detail: '__pycache__ and .pyc files are generated automatically by Python and change constantly. '
            + 'Committing them bloats your repository. GitGuard will remove and ignore them.',
    },
    CONFLICT_MARKERS_IN_FILES: {
        title: 'Unresolved Conflict Markers in Code',
        detail: 'One or more files contain <<<<<<< / ======= / >>>>>>> conflict markers from a merge that wasn\'t finished. '
            + 'Committing these will break your code. You must resolve all conflicts before pushing.',
    },
    DEBUG_STATEMENTS_IN_CODE: {
        title: 'Debug Statements Found in Staged Code',
        detail: 'console.log(), debugger, or similar debug statements were found in your changes. '
            + 'These are usually temporary. You can continue, but consider removing them first.',
    },
    PUSHING_TO_MAIN_DIRECTLY: {
        title: 'Pushing Directly to Main Branch',
        detail: 'You\'re about to push directly to main/master. '
            + 'If something breaks it will affect the whole project immediately. '
            + 'Consider using a feature branch and a Pull Request instead.',
    },
    EMPTY_OR_VAGUE_COMMIT_MSG: {
        title: 'Commit Message Is Too Vague',
        detail: 'A good commit message tells collaborators (and your future self) what changed and why. '
            + 'Something like "fix: resolve login crash on empty password" is much better than "fix" or "update". '
            + 'You can continue, but improving the message is strongly recommended.',
    },
    TOO_MANY_FILES_STAGED: {
        title: 'Unusually Large Number of Files Staged',
        detail: 'A large number of files are about to be committed at once. '
            + 'This sometimes means generated or ignored files were accidentally included. '
            + 'Review the staged file list before continuing.',
    },
    HARDCODED_SECRET_IN_DIFF: {
        title: 'Potential Secret Found in Staged Changes',
        detail: 'An API key, password, or token pattern was detected in your code changes. '
            + 'Pushing this — even to a private repo — is a serious security risk. '
            + 'Move the secret to a .env file and reference it via an environment variable.',
    },
};

// ── Agent 2: Solution Architect ───────────────────────────────────────────────

/**
 * Builds a plain-English explanation for a reactive git failure.
 * Tries Bob 2.0 (vscode.lm) first; falls back to the hard-coded table.
 */
export async function buildExplanation(diagnosis: Diagnosis): Promise<UserFacingExplanation> {
    try {
        return await explainWithBob(
            `Error type: ${diagnosis.type}\nRaw error:\n${diagnosis.rawError}`,
            'A git operation failed.'
        );
    } catch {
        return REACTIVE_FALLBACKS[diagnosis.type] ?? REACTIVE_FALLBACKS['UNKNOWN_ERROR'];
    }
}

/**
 * Builds a plain-English explanation for a proactive warning (pre-commit scan).
 * Tries Bob 2.0 first; falls back to the hard-coded table.
 */
export async function buildProactiveExplanation(warning: ProactiveWarning): Promise<UserFacingExplanation> {
    try {
        return await explainWithBob(
            `Warning type: ${warning.type}\nAffected files: ${warning.affectedFiles.join(', ') || 'none'}`,
            'A potential issue was detected before committing.'
        );
    } catch {
        return PROACTIVE_FALLBACKS[warning.type] ?? {
            title: 'Potential Issue Detected',
            detail: warning.message,
        };
    }
}

// ── Bob 2.0 LLM call ──────────────────────────────────────────────────────────

async function explainWithBob(context: string, situation: string): Promise<UserFacingExplanation> {
    const model = await selectBestModel();
    if (!model) { throw new Error('No language model available'); }

    const prompt =
        `You are GitGuard, a VS Code extension that helps beginner developers with Git problems.\n\n` +
        `${situation}\n${context}\n\n` +
        `Write a plain-English explanation for a complete beginner — no jargon. `
        + `Return ONLY valid JSON with exactly two string fields:\n`
        + `- "title": ≤8 words describing the problem\n`
        + `- "detail": 2-3 sentences explaining what went wrong and what GitGuard will do to fix it\n\n`
        + `JSON only, no markdown fences.`;

    const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {}
    );

    let raw = '';
    for await (const chunk of response.text) { raw += chunk; }

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { throw new Error('LLM returned unexpected format'); }

    const parsed = JSON.parse(jsonMatch[0]) as UserFacingExplanation;
    if (!parsed.title || !parsed.detail) { throw new Error('LLM response missing required fields'); }
    return parsed;
}

/**
 * Asks Bob 2.0 to suggest a sequence of git commands that fix the given raw error.
 * Returns an array of shell command strings, or empty array if LLM unavailable.
 */
export async function askBobForFix(rawError: string, rootPath: string): Promise<string[]> {
    const model = await selectBestModel();
    if (!model) { return []; }

    const prompt =
        `You are a Git expert helping a beginner fix a git error.\n\n` +
        `The following git error occurred in the repository at: ${rootPath}\n\n` +
        `Error:\n${rawError}\n\n` +
        `Provide a list of shell commands to fix this error. ` +
        `Return ONLY a JSON array of command strings, nothing else. ` +
        `Commands should be safe and reversible where possible. ` +
        `Maximum 5 commands. Example: ["git fetch origin", "git rebase origin/main"]\n\n` +
        `JSON array only, no markdown fences, no explanation.`;

    try {
        const response = await model.sendRequest(
            [vscode.LanguageModelChatMessage.User(prompt)],
            {}
        );
        let raw = '';
        for await (const chunk of response.text) { raw += chunk; }
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) { return []; }
        const cmds = JSON.parse(match[0]) as string[];
        return Array.isArray(cmds) ? cmds.filter(c => typeof c === 'string') : [];
    } catch {
        return [];
    }
}
