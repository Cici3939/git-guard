import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { inspectFailure } from './inspector';
import { buildExplanation, askBobForFix } from './architect';
import { executeFix } from './fixer';

const execAsync = promisify(exec);

const MAX_RETRIES = 3;

/**
 * Coordinator – wires all three agents together with a test-fix-retest loop.
 * Shows progress spinners for every long-running step.
 */
export async function handleGitFailure(
    rootPath: string,
    rawError: string,
    depth: number = 0
): Promise<boolean> {
    if (depth >= MAX_RETRIES) {
        vscode.window.showErrorMessage(
            `GitGuard: Unable to fix after ${MAX_RETRIES} attempts. ` +
            `Please resolve manually.\n\nLast error: ${rawError}`
        );
        return false;
    }

    // ── Agent 1 + 2: Diagnose and explain ────────────────────────────────────
    const { diagnosis, explanation } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GitGuard', cancellable: false },
        async progress => {
            progress.report({ message: '🔍 Analysing error…' });
            const diagnosis = await inspectFailure(rootPath, rawError);
            progress.report({ message: '🤖 Asking Bob 2.0 to explain…' });
            const explanation = await buildExplanation(diagnosis);
            return { diagnosis, explanation };
        }
    );

    // ── Determine buttons ─────────────────────────────────────────────────────
    const isManual =
        diagnosis.type === 'MERGE_CONFLICT' ||
        diagnosis.type === 'NETWORK_ERROR' ||
        diagnosis.type === 'FORCE_PUSH_REJECTED' ||
        diagnosis.type === 'REPO_PROTECTED';

    const isUnknown = diagnosis.type === 'UNKNOWN_ERROR';

    let buttons: string[];
    if (isManual)       { buttons = ['OK']; }
    else if (isUnknown) { buttons = ['Let Bob Fix It', 'Cancel']; }
    else                { buttons = ['Fix & Push', 'Cancel']; }

    // ── Modal UI ──────────────────────────────────────────────────────────────
    const choice = await vscode.window.showWarningMessage(
        `⚠️ Git Error: ${explanation.title}`,
        { modal: true, detail: `${explanation.detail}\n\nRaw error:\n${rawError}` },
        ...buttons
    );

    if (choice === 'OK' || choice === 'Cancel' || choice === undefined) {
        vscode.window.showInformationMessage('GitGuard: Push cancelled.');
        return false;
    }

    // ── UNKNOWN_ERROR: Bob generates fix commands ─────────────────────────────
    if (choice === 'Let Bob Fix It') {
        return runBobGeneratedFix(rootPath, rawError, depth);
    }

    // ── Known fix: Agent 3 ────────────────────────────────────────────────────
    const shouldRetry = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GitGuard', cancellable: false },
        async progress => {
            progress.report({ message: `🔧 Applying fix: ${explanation.title}…` });
            try {
                return await executeFix(rootPath, diagnosis);
            } catch (e: any) {
                vscode.window.showErrorMessage(`GitGuard: Fix failed — ${e.message}`);
                return null; // null = error
            }
        }
    );

    if (shouldRetry === null) { return false; }
    if (!shouldRetry) { return false; } // NO_UPSTREAM already pushed, or manual

    // ── Retry push ────────────────────────────────────────────────────────────
    const pushResult = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GitGuard', cancellable: false },
        async progress => {
            progress.report({ message: '🚀 Retrying push…' });
            try {
                await execAsync('git push', { cwd: rootPath });
                return { ok: true, error: '' };
            } catch (e: any) {
                return { ok: false, error: e.message ?? String(e) };
            }
        }
    );

    if (pushResult.ok) {
        vscode.window.showInformationMessage('🚀 GitGuard: Successfully pushed to GitHub!');
        return true;
    }

    const newError = pushResult.error;
    if (newError === rawError) {
        vscode.window.showErrorMessage(
            `GitGuard: Fix applied but the same error persists. Manual resolution required.\n\n${newError}`
        );
        return false;
    }

    vscode.window.showWarningMessage(
        `GitGuard: Push failed again (attempt ${depth + 1}/${MAX_RETRIES}). Re-analysing…`
    );
    return handleGitFailure(rootPath, newError, depth + 1);
}

// ── Bob-generated fix ─────────────────────────────────────────────────────────

async function runBobGeneratedFix(
    rootPath: string,
    rawError: string,
    depth: number
): Promise<boolean> {

    // Get fix commands from Bob (with sign-in fallback)
    let commands = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GitGuard', cancellable: false },
        async progress => {
            progress.report({ message: '🤖 Asking Bob 2.0 to generate a fix…' });
            return askBobForFix(rawError, rootPath);
        }
    );

    if (commands.length === 0) {
        const signed = await promptCopilotSignIn();
        if (!signed) { return false; }

        commands = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'GitGuard', cancellable: false },
            async progress => {
                progress.report({ message: '🤖 Asking Bob 2.0 again after sign-in…' });
                return askBobForFix(rawError, rootPath);
            }
        );

        if (commands.length === 0) {
            vscode.window.showErrorMessage(
                'GitGuard: Bob still couldn\'t generate a fix. '
                + 'Make sure the GitHub Copilot extension is installed and try again.'
            );
            return false;
        }
    }

    // Show the user what will run and get confirmation
    const preview = commands.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const confirm = await vscode.window.showWarningMessage(
        'GitGuard: Bob suggests these commands to fix the error:',
        { modal: true, detail: `${preview}\n\nRun these commands?` },
        'Run Commands',
        'Cancel'
    );
    if (confirm !== 'Run Commands') { return false; }

    // Execute each command with a live spinner
    for (const cmd of commands) {
        const cmdResult = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'GitGuard', cancellable: false },
            async progress => {
                progress.report({ message: `⚙️  Running: ${cmd}` });
                try {
                    await execAsync(cmd, { cwd: rootPath });
                    return { ok: true, error: '' };
                } catch (e: any) {
                    return { ok: false, error: e.message ?? String(e) };
                }
            }
        );
        if (!cmdResult.ok) {
            vscode.window.showErrorMessage(
                `GitGuard: Command failed: \`${cmd}\`\n${cmdResult.error}`
            );
            return false;
        }
    }

    // After Bob's commands, stage and commit the changes before pushing
    const commitResult = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GitGuard', cancellable: false },
        async progress => {
            try {
                progress.report({ message: '📦 Staging changes made by fix…' });
                await execAsync('git add .', { cwd: rootPath });

                // Only commit if there is something staged
                const { stdout: statusOut } = await execAsync(
                    'git diff --cached --name-only', { cwd: rootPath }
                ).catch(() => ({ stdout: '' }));

                if (statusOut.trim()) {
                    progress.report({ message: '✍️  Committing fixed changes…' });
                    await execAsync(
                        'git commit -m "fix: auto-remediation by GitGuard [GitGuard]"',
                        { cwd: rootPath }
                    );
                }

                progress.report({ message: '🚀 Pushing…' });
                await execAsync('git push', { cwd: rootPath });
                return { ok: true, error: '' };
            } catch (e: any) {
                return { ok: false, error: e.message ?? String(e) };
            }
        }
    );

    if (commitResult.ok) {
        vscode.window.showInformationMessage('🚀 GitGuard: Successfully pushed to GitHub!');
        return true;
    }

    const newError = commitResult.error;
    vscode.window.showWarningMessage(
        `GitGuard: Bob's fix ran but push still failed (attempt ${depth + 1}/${MAX_RETRIES}). Re-analysing…`
    );
    return handleGitFailure(rootPath, newError, depth + 1);
}

// ── GitHub / Copilot sign-in ──────────────────────────────────────────────────

async function promptCopilotSignIn(): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
        '⚠️ GitGuard: GitHub Copilot Not Available',
        {
            modal: true,
            detail:
                'Bob 2.0 needs GitHub Copilot to analyse and fix this error, but no AI model was found.\n\n'
                + 'This usually means you are not signed into GitHub, or the GitHub Copilot extension '
                + 'is not installed.\n\n'
                + 'Click "Sign In to GitHub" to connect your account and try again.',
        },
        'Sign In to GitHub',
        'Cancel'
    );

    if (choice !== 'Sign In to GitHub') { return false; }

    try {
        const session = await vscode.authentication.getSession(
            'github',
            ['read:user'],
            { createIfNone: true }
        );
        return !!session;
    } catch {
        vscode.window.showErrorMessage(
            'GitGuard: GitHub sign-in failed or was cancelled. '
            + 'Please sign in manually via the Accounts menu (bottom-left of VS Code) and try again.'
        );
        return false;
    }
}
