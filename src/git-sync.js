/**
 * @developai/grounded-node-runtime / src/git-sync.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Best-effort git sync of a single file. Used by feedback submission so
 * newsroom-typed content reaches Paul's cohort dashboard within seconds
 * rather than waiting for the next Update.command cycle.
 *
 * Design constraints — failures must NOT bubble up:
 *   • A newsroom may not have git installed (only installs at first
 *     Update.command run). The function must detect and return cleanly.
 *   • The working tree may be dirty from other edits. We never `git add .`;
 *     we add only the specific file passed in.
 *   • Push may fail on network, auth, or non-fast-forward. We catch all
 *     of these and report them in the return value rather than throwing.
 *   • Everything has a hard timeout — the modal can't hang for 30s on
 *     a slow connection.
 *
 * Returns:
 *   { ok: true,  step: "pushed" }                       — synced cleanly
 *   { ok: true,  step: "committed_not_pushed" }         — local commit ok, push failed
 *   { ok: false, step: "no_git" | "no_repo" | "no_remote" | ..., reason }
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 8000;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        signal: err?.signal,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
        timedOut: err?.killed && err?.signal === "SIGTERM",
      });
    });
    child.on("error", () => { /* execFile callback will fire; nothing to do */ });
  });
}

/**
 * Stage, commit, and push a single file. All errors are caught.
 * @param {string} file - Absolute or cwd-relative path
 * @param {string} message - Commit message
 * @param {object} opts - { cwd?, timeout? }
 */
export async function syncFile(file, message, opts = {}) {
  if (!file) return { ok: false, step: "no_file", reason: "file path required" };
  if (!existsSync(file)) return { ok: false, step: "no_file", reason: "file does not exist" };

  // 1. git available?
  const gitCheck = await run("git", ["--version"], opts);
  if (!gitCheck.ok) {
    return { ok: false, step: "no_git", reason: "git not installed" };
  }

  // 2. inside a git repo?
  const repoCheck = await run("git", ["rev-parse", "--is-inside-work-tree"], opts);
  if (!repoCheck.ok || repoCheck.stdout !== "true") {
    return { ok: false, step: "no_repo", reason: "not a git repository" };
  }

  // 3. has an origin remote?
  const remoteCheck = await run("git", ["remote"], opts);
  if (!remoteCheck.ok || !remoteCheck.stdout.split("\n").includes("origin")) {
    return { ok: false, step: "no_remote", reason: "no 'origin' remote configured" };
  }

  // 4. stage the specific file (never `git add .`)
  const addResult = await run("git", ["add", file], opts);
  if (!addResult.ok) {
    return { ok: false, step: "add_failed", reason: addResult.stderr || `git add exit ${addResult.code}` };
  }

  // 5. commit — but tolerate "nothing to commit" (file may be unchanged)
  // Use --author so commits trace to the runtime rather than whatever
  // global git config says.
  const commitResult = await run("git", [
    "-c", "user.name=GROUNDED Node",
    "-c", "user.email=node@developai.local",
    "commit", "-m", message, "--only", file,
  ], opts);

  if (!commitResult.ok) {
    // "nothing to commit" produces a non-zero exit but is benign.
    const benign = /nothing to commit|no changes added/i.test(commitResult.stdout + commitResult.stderr);
    if (!benign) {
      return { ok: false, step: "commit_failed", reason: commitResult.stderr || commitResult.stdout || `git commit exit ${commitResult.code}` };
    }
  }

  // 6. push — best effort, timeout is the bigger constraint here
  const pushResult = await run("git", ["push", "origin", "HEAD"], {
    ...opts,
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
  });
  if (!pushResult.ok) {
    return {
      ok: true,                              // local commit succeeded
      step: "committed_not_pushed",
      reason: pushResult.timedOut ? "push timed out" : (pushResult.stderr || `git push exit ${pushResult.code}`),
    };
  }

  return { ok: true, step: "pushed" };
}

/**
 * Catchup push — fire-and-forget on boot to drain any commits made by
 * previous sync attempts that committed but couldn't push (offline at
 * the time, etc). Same failure handling as syncFile but no file arg.
 */
export async function catchupPush(opts = {}) {
  const gitCheck = await run("git", ["--version"], opts);
  if (!gitCheck.ok) return { ok: false, step: "no_git" };

  const repoCheck = await run("git", ["rev-parse", "--is-inside-work-tree"], opts);
  if (!repoCheck.ok || repoCheck.stdout !== "true") return { ok: false, step: "no_repo" };

  // Are we ahead of origin? If not, nothing to do — silent success.
  const aheadCheck = await run("git", ["rev-list", "--count", "@{u}..HEAD"], opts);
  if (!aheadCheck.ok) return { ok: false, step: "no_upstream" };
  if (aheadCheck.stdout === "0") return { ok: true, step: "nothing_to_push" };

  const pushResult = await run("git", ["push", "origin", "HEAD"], opts);
  return pushResult.ok
    ? { ok: true, step: "pushed", count: parseInt(aheadCheck.stdout, 10) }
    : { ok: false, step: "push_failed", reason: pushResult.stderr };
}
