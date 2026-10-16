import { spawn } from 'cross-spawn';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitArguments } from '../kernel/templates.js';

export type EditorOutcome =
  | { readonly text: string }
  | { readonly code: string; readonly detail: string };

function detailOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'detail' in error && typeof error.detail === 'string') return error.detail;
  return error instanceof Error ? error.message : String(error);
}

function failure(code: string, detail: string): EditorOutcome {
  return { code, detail };
}

function runEditor(program: string, args: string[], path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args, path], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal === null ? `editor exited with code ${String(code)}` : `editor stopped by ${signal}`));
    });
  });
}

export async function editInExternalEditor(command: string, content: string): Promise<EditorOutcome> {
  let commandParts: string[];
  try {
    commandParts = splitArguments(command);
  } catch (error) {
    return failure('tui_editor_command_unbalanced', detailOf(error));
  }
  const [program, ...args] = commandParts;
  if (program === undefined || program === '') {
    return failure('tui_editor_command_invalid', 'EDITOR must contain a program name');
  }

  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), 'ligule-editor-'));
  } catch (error) {
    return failure('tui_editor_file_create_failed', detailOf(error));
  }
  const path = join(directory, 'draft.md');
  let outcome: EditorOutcome | undefined;
  try {
    try {
      await writeFile(path, content, 'utf8');
    } catch (error) {
      outcome = failure('tui_editor_file_write_failed', detailOf(error));
    }
    if (outcome === undefined) {
      try {
        await runEditor(program, args, path);
      } catch (error) {
        outcome = failure('tui_editor_failed', detailOf(error));
      }
    }
    if (outcome === undefined) {
      try {
        const text = await readFile(path, 'utf8');
        outcome = { text: text.replace(/(?:\r\n|\n)$/, '') };
      } catch (error) {
        outcome = failure('tui_editor_file_read_failed', detailOf(error));
      }
    }
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      const cleanupDetail = detailOf(error);
      const priorDetail = outcome !== undefined && 'code' in outcome
        ? `${outcome.code}: ${outcome.detail}; `
        : '';
      outcome = failure('tui_editor_cleanup_failed', `${priorDetail}cleanup: ${cleanupDetail}`);
    }
  }
  return outcome ?? { code: 'tui_editor_failed', detail: 'editor did not finish' };
}
