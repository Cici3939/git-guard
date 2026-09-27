import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { proactiveScan, ProactiveWarning, selectBestModel } from './inspector';
import { buildProactiveExplanation } from './architect';
import { fixProactiveWarning } from './fixer';
import { handleGitFailure } from './coordinator';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {

    // ── Diagnostic: show available AI models ─────────────────────────────────
    const diagDisposable = vscode.commands.registerCommand('gitGuard.checkModels', async () => {
        const all = await Promise.resolve(vscode.lm.selectChatModels({})).catch(() => []);
        if (all.length === 0) {
            vscode.window.showWarningMessage(
                'GitGuard: No language models found. Make sure GitHub Copilot is installed and you are signed in.'
            );
            return;
        }
        const best = await selectBestModel();
        const list = all.map((m: vscode.LanguageModelChat) => `• ${m.name} (id: ${m.id}, family: ${m.family})`).join('\n');
        vscode.window.showInformationMessage(
            `GitGuard: ${all.length} model(s) available. Using: ${best?.name ?? 'none'}\n\n${list}`,
            { modal: true },
            'OK'
        );
    });
    context.subscriptions.push(diagDisposable);

    // ── Main: Safe Push ───────────────────────────────────────────────────────
    const disposable = vscode.commands.registerCommand('gitGuard.safePush', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('GitGuard: No workspace folder open.');
            return;
        }
        const rootPath = workspaceFolders[0].uri.fsPath;

        // ── Step 1: Commit message ────────────────────────────────────────────
        const commitMsg = await vscode.window.showInputBox({
            prompt: 'Enter your commit message',
            placeHolder: 'e.g., feat: add authentication',
            validateInput: text => text.trim().length === 0 ? 'Commit message required!' : null,
        });
        if (!commitMsg) { return; }

        // ── Step 2: Proactive scan ────────────────────────────────────────────
        const warnings = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'GitGuard',
                cancellable: false,
            },
            async progress => {
                progress.report({ message: '🔍 Scanning for issues before commit…' });
                return proactiveScan(rootPath, commitMsg);
            }
        );

        if (warnings.length > 0) {
            const shouldContinue = await handleProactiveWarnings(rootPath, warnings, commitMsg);
            if (!shouldContinue) {
                vscode.window.showInformationMessage('GitGuard: Push cancelled. Issues were not resolved.');
                return;
            }
        }

        // ── Step 3: git add → commit → push ──────────────────────────────────
        const taggedMsg = `${commitMsg} [GitGuard]`;
        const success = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'GitGuard',
                cancellable: false,
            },
            async progress => {
                try {
                    progress.report({ message: '📦 Staging all changes…', increment: 20 });
                    await execAsync('git add .', { cwd: rootPath });

                    progress.report({ message: '✍️  Committing…', increment: 30 });
                    await execAsync(`git commit -m "${taggedMsg.replace(/"/g, '\\"')}"`, { cwd: rootPath });

                    progress.report({ message: '🚀 Pushing to GitHub…', increment: 40 });
                    await execAsync('git push', { cwd: rootPath });

                    progress.report({ message: '✅ Done!', increment: 10 });
                    return { ok: true, error: null };
                } catch (e: any) {
                    return { ok: false, error: e.message ?? String(e) };
                }
            }
        );

        if (success.ok) {
            vscode.window.showInformationMessage(`🚀 GitGuard: Successfully pushed! "${commitMsg}"`);
        } else {
            await handleGitFailure(rootPath, success.error!);
        }
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}

// ── Proactive warning handler ─────────────────────────────────────────────────

/**
 * Shows each warning modal and runs the fix. Re-stages after every fix so the
 * changed files (e.g. secrets rewritten) are included in the final commit.
 */
async function handleProactiveWarnings(
    rootPath: string,
    warnings: ProactiveWarning[],
    commitMsg: string
): Promise<boolean> {
    // Blockers first (canContinue=false), then advisories
    const ordered = [...warnings].sort((a, b) => (a.canContinue ? 1 : -1) - (b.canContinue ? 1 : -1));

    for (const warning of ordered) {
        const explanation = await buildProactiveExplanation(warning);

        const fileList = warning.affectedFiles.length > 0
            ? `\n\nAffected files:\n${warning.affectedFiles.slice(0, 5).join('\n')}` +
              (warning.affectedFiles.length > 5 ? `\n…and ${warning.affectedFiles.length - 5} more` : '')
            : '';

        const buttons: string[] = warning.canContinue
            ? ['Fix & Continue', 'Skip This Warning', 'Cancel Push']
            : ['Fix It', 'Cancel Push'];

        const choice = await vscode.window.showWarningMessage(
            `⚠️ GitGuard: ${explanation.title}`,
            { modal: true, detail: `${explanation.detail}${fileList}` },
            ...buttons
        );

        if (choice === 'Cancel Push') { return false; }

        if (choice === 'Fix & Continue' || choice === 'Fix It') {
            const fixed = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'GitGuard',
                    cancellable: false,
                },
                async progress => {
                    progress.report({ message: `🔧 Fixing: ${explanation.title}…` });
                    return fixProactiveWarning(rootPath, warning);
                }
            );

            if (!fixed && !warning.canContinue) { return false; }

            // Re-stage everything after fix — the fixer may have rewritten files
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'GitGuard',
                    cancellable: false,
                },
                async progress => {
                    progress.report({ message: '📦 Re-staging fixed files…' });
                    await execAsync('git add .', { cwd: rootPath }).catch(() => {});
                }
            );
        }
        // 'Skip This Warning' → fall through
    }

    return true;
}
