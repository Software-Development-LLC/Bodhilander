/**
 * Finding Git Bash the way the Claude CLI does on Windows. The filesystem is
 * always a fake here. Run with: bun test <this file>
 */
import { describe, expect, test } from 'bun:test';

import { findGitBash } from '../git-bash';

const PROGRAM_FILES = String.raw`C:\Program Files\Git\bin\bash.exe`;
const PROGRAM_FILES_X86 = String.raw`C:\Program Files (x86)\Git\bin\bash.exe`;
const onDisk = (...paths: string[]) => (p: string) => paths.includes(p);

describe('findGitBash', () => {
  test('the override the CLI honours wins over every install', () => {
    const exists = onDisk(String.raw`D:\tools\bash.exe`, PROGRAM_FILES);
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: String.raw`D:\tools\bash.exe` }, exists)).toBe(String.raw`D:\tools\bash.exe`);
  });

  test('an override that is not a bash, or is not there, falls through', () => {
    const exists = onDisk(String.raw`D:\tools\zsh.exe`, PROGRAM_FILES);
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: String.raw`D:\tools\zsh.exe` }, exists)).toBe(PROGRAM_FILES);
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: String.raw`D:\gone\bash.exe` }, exists)).toBe(PROGRAM_FILES);
  });

  test('Program Files comes before the x86 install, and both before PATH', () => {
    const path = String.raw`D:\Git\cmd`;
    const gitOnPath = [String.raw`D:\Git\cmd\git.exe`, String.raw`D:\Git\bin\bash.exe`];
    expect(findGitBash({ PATH: path }, onDisk(PROGRAM_FILES, PROGRAM_FILES_X86, ...gitOnPath))).toBe(PROGRAM_FILES);
    expect(findGitBash({ PATH: path }, onDisk(PROGRAM_FILES_X86, ...gitOnPath))).toBe(PROGRAM_FILES_X86);
  });

  test('otherwise bash is two levels up from the first git on PATH', () => {
    const exists = onDisk(String.raw`D:\Git\cmd\git.exe`, String.raw`D:\Git\bin\bash.exe`, String.raw`E:\Git\bin\bash.exe`);
    expect(findGitBash({ Path: String.raw`C:\Windows;E:\Git\bin-less;D:\Git\cmd` }, exists)).toBe(String.raw`D:\Git\bin\bash.exe`);
  });

  test('a git on PATH with no bash beside it, or nothing at all, is null', () => {
    expect(findGitBash({ PATH: String.raw`D:\Git\cmd` }, onDisk(String.raw`D:\Git\cmd\git.exe`))).toBeNull();
    expect(findGitBash({ PATH: '' }, () => false)).toBeNull();
  });
});
