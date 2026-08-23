// Host-independent restart handoff protocol shared by the Web plugin and the
// standalone guard CLI.  The parent must not infer readiness from a child pid:
// an incompatible CLI can spawn successfully and then die on argument parsing.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export const RESTART_HELPER_READY_TYPE = "@1e0zj/dsh-plugin-mall:restart-helper-ready";
export const RESTART_HELPER_PROTOCOL_VERSION = 1;
export const RESTART_RESPONSE_DRAIN_MS = 1000;

// cmd.exe metacharacters. Rather than "escaping" these for a cmd round trip
// (cmd's quoting rules are famously inconsistent), the launch wrapper refuses
// them outright — a dsh invocation never needs them.
export const CMD_METACHAR_RE = /[&|<>^%!\r\n]/;

/**
 * Quote one token for a %ComSpec% /d /s /c command line. Follows the MSVCRT /
 * CommandLineToArgvW rules (backslashes before a quote or the closing quote are
 * doubled, quotes become \") and rejects cmd metacharacters instead of trying
 * to escape them. The command after `--` is never concatenated unquoted.
 */
export function quoteCmdArg(token) {
  const value = String(token ?? "");
  if (value.length === 0) return '""';
  if (CMD_METACHAR_RE.test(value)) {
    throw new Error(`cannot quote safely for cmd.exe (shell metacharacter present): ${JSON.stringify(value)}`);
  }
  const escaped = value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

export function createRestartHelperReadyMessage(awaitExitPid) {
  return {
    type: RESTART_HELPER_READY_TYPE,
    protocol: RESTART_HELPER_PROTOCOL_VERSION,
    awaitExitPid,
  };
}

function describeExit(code, signal) {
  if (typeof code === "number") return ` with code ${code}`;
  if (signal) return ` from signal ${signal}`;
  return "";
}

/**
 * Keep the outgoing Host alive until the detached helper explicitly confirms
 * that it parsed the current protocol and is waiting for that Host's pid.
 *
 * The returned disposer is suitable for ctx.effect(): unloading the plugin
 * cancels every timer, removes listeners, and terminates the waiting helper.
 */
export function superviseRestartHelper(child, {
  awaitExitPid,
  handshakeTimeoutMs = 2000,
  stabilityMs = 600,
  responseDelayMs = RESTART_RESPONSE_DRAIN_MS,
  onHostExit = () => process.exit(0),
  onFailure = () => {},
} = {}) {
  let phase = "handshake";
  let timer;
  let readySettled = false;
  let resolveReady;
  const ready = new Promise((resolvePromise) => { resolveReady = resolvePromise; });

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const removeListeners = () => {
    child.removeListener("message", onMessage);
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
  };
  const terminateChild = () => {
    if (child.exitCode !== null && child.exitCode !== undefined) return;
    if (child.signalCode !== null && child.signalCode !== undefined) return;
    if (child.killed === true) return;
    try { child.kill(); } catch { /* already gone */ }
  };
  const settleReady = (result) => {
    if (readySettled) return;
    readySettled = true;
    resolveReady(result);
  };
  const fail = (message, { terminate = false } = {}) => {
    if (phase === "failed" || phase === "disposed" || phase === "committed") return;
    const afterReady = readySettled;
    phase = "failed";
    clearTimer();
    removeListeners();
    if (terminate) terminateChild();
    settleReady({ ok: false, error: message });
    try { onFailure(message, { afterReady }); } catch { /* diagnostics are best effort */ }
  };

  function onError(error) {
    fail(`restart helper failed to start: ${error?.message ?? String(error)}`);
  }
  function onExit(code, signal) {
    fail(`restart helper exited before handoff${describeExit(code, signal)}`);
  }
  function onMessage(message) {
    if (phase !== "handshake" || message?.type !== RESTART_HELPER_READY_TYPE) return;
    if (message.protocol !== RESTART_HELPER_PROTOCOL_VERSION || message.awaitExitPid !== awaitExitPid) {
      fail(
        `restart helper protocol mismatch (expected v${RESTART_HELPER_PROTOCOL_VERSION} for pid ${awaitExitPid})`,
        { terminate: true },
      );
      return;
    }
    phase = "stability";
    clearTimer();
    // A successful helper is blocked in --await-exit until this Host leaves.
    // Observe it briefly so a parse/startup failure cannot masquerade as an
    // accepted handoff merely because the IPC message won a scheduling race.
    timer = setTimeout(() => {
      if (phase !== "stability") return;
      phase = "accepted";
      try {
        if (child.connected === true) child.disconnect();
      } catch { /* the ready message already proved the channel worked */ }
      try { child.unref(); } catch { /* ChildProcess-compatible fakes may omit it */ }
      settleReady({ ok: true });
      // Preserve the old implementation's one-second response-drain window.
      // The RPC layer does not expose a response-flushed callback. The exit
      // listener remains active: if the helper dies here, the timer is
      // cancelled and the old Host stays.
      timer = setTimeout(() => {
        if (phase !== "accepted") return;
        phase = "committed";
        timer = undefined;
        removeListeners();
        try {
          onHostExit();
        } catch (error) {
          phase = "failed";
          try { onFailure(`could not exit old Host: ${error?.message ?? String(error)}`, { afterReady: true }); } catch { /* best effort */ }
        }
      }, responseDelayMs);
    }, stabilityMs);
  }

  child.on("message", onMessage);
  child.once("error", onError);
  child.once("exit", onExit);
  timer = setTimeout(() => {
    fail(`restart helper did not acknowledge protocol v${RESTART_HELPER_PROTOCOL_VERSION} within ${handshakeTimeoutMs}ms`, { terminate: true });
  }, handshakeTimeoutMs);

  const dispose = () => {
    if (phase === "failed" || phase === "disposed" || phase === "committed") return;
    phase = "disposed";
    clearTimer();
    removeListeners();
    terminateChild();
    settleReady({ ok: false, error: "restart handoff cancelled because the plugin unloaded" });
  };

  return {
    ready,
    dispose,
    state: () => phase,
  };
}

// ── restart plan & file-channel handoff (Windows visible console) ────────────
//
// A visible restart launches the guard through `cmd /c start`: the guard runs
// in a brand-new console as a grandchild, so neither stdio nor an IPC channel
// connects it back to the old Host. The launch plan travels as a JSON file
// (never concatenated into the cmd command line), and readiness is
// acknowledged through a second file with the same semantics the IPC message
// carries.

export const RESTART_PLAN_TYPE = "@1e0zj/dsh-plugin-mall:restart-plan";
export const RESTART_PLAN_VERSION = 1;

/**
 * Validate the payload of a restart plan file. Structural checks only:
 * profile-name safety is enforced where the name builds paths (the guard's
 * profileDirOf / the plugin's assertSafeProfileName), not here.
 */
export function validateRestartPlanPayload(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "restart plan is not a JSON object" };
  }
  if (value.version !== RESTART_PLAN_VERSION) {
    return { ok: false, error: `restart plan version ${JSON.stringify(value.version)} is not supported (expected ${RESTART_PLAN_VERSION})` };
  }
  if (value.type !== RESTART_PLAN_TYPE) {
    return { ok: false, error: `restart plan type ${JSON.stringify(value.type)} does not match ${RESTART_PLAN_TYPE}` };
  }
  for (const key of ["profile", "logPath", "readyFile", "cwd", "command"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      return { ok: false, error: `restart plan field ${JSON.stringify(key)} must be a non-empty string` };
    }
  }
  if (!Number.isInteger(value.awaitExitPid) || value.awaitExitPid <= 0) {
    return { ok: false, error: `restart plan awaitExitPid ${JSON.stringify(value.awaitExitPid)} must be a positive integer` };
  }
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.some((entry) => typeof entry !== "string")) {
    return { ok: false, error: "restart plan args must be a non-empty array of strings" };
  }
  return { ok: true, plan: value };
}

/**
 * Atomically publish the helper-ready handshake as a file: write a sibling
 * .tmp, then rename onto the final path (nonce-unique, so it does not exist
 * yet), so the parent never observes half-written JSON. The parent — and only
 * the parent — deletes the file after consuming it; the writer never touches
 * it again, which is what keeps a healthy handoff from racing its own cleanup.
 */
export function writeRestartHelperReadyFile(readyFile, { awaitExitPid, guardPid }) {
  const message = {
    type: RESTART_HELPER_READY_TYPE,
    protocol: RESTART_HELPER_PROTOCOL_VERSION,
    awaitExitPid,
    guardPid,
  };
  const tmp = `${readyFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(message)}\n`);
  renameSync(tmp, readyFile);
}

/** Read a ready file; a missing or unparseable file reads as "not yet". */
export function readRestartHelperReadyFile(readyFile) {
  let text;
  try {
    text = readFileSync(readyFile, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function defaultProbePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true; // exists, not ours to signal
    // ESRCH — and anything unprobeable — reads as gone: fail closed and keep
    // the old Host rather than trusting an uncertain probe.
    return false;
  }
}

/**
 * File-channel twin of superviseRestartHelper, phase for phase: handshake
 * (poll the ready file) → stability (probe the guard pid) → accepted (the RPC
 * may answer now — but keep probing) → committed (onHostExit). Continuing to
 * probe through accepted mirrors the IPC version's live exit listener: a guard
 * that dies after the RPC answered still cancels the old Host's exit instead
 * of leaving it gone with no successor.
 *
 * The guard pid is only ever killed from a payload whose type identifies it
 * as one of our restart helpers; garbage or unrelated files never turn into a
 * kill of an unrelated (possibly recycled) pid. `failFast` lets the caller
 * surface an early external failure (e.g. cmd itself exited nonzero before
 * the guard ever started) without waiting out the handshake timeout.
 */
export function superviseRestartHelperFile({
  readyFile,
  awaitExitPid,
  handshakeTimeoutMs = 5000,
  stabilityMs = 600,
  responseDelayMs = RESTART_RESPONSE_DRAIN_MS,
  pollMs = 100,
  probe = defaultProbePid,
  kill = (pid) => process.kill(pid),
  onHostExit = () => process.exit(0),
  onFailure = () => {},
} = {}) {
  let phase = "handshake";
  let deadlineTimer;
  let pollTimer;
  let probeTimer;
  let guardPid;
  let readySettled = false;
  let resolveReady;
  const ready = new Promise((resolvePromise) => { resolveReady = resolvePromise; });

  const clearTimers = () => {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    // pollTimer included: a terminal state must leave no polling interval
    // behind, or the Host process can never exit naturally.
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (probeTimer !== undefined) {
      clearInterval(probeTimer);
      probeTimer = undefined;
    }
  };
  const bestEffortUnlink = () => {
    try { unlinkSync(readyFile); } catch { /* nonce-named residue is inert */ }
  };
  const settleReady = (result) => {
    if (readySettled) return;
    readySettled = true;
    resolveReady(result);
  };
  const terminateGuard = () => {
    if (guardPid === undefined) return;
    try { kill(guardPid); } catch { /* already gone */ }
  };
  const fail = (message, { terminate = false } = {}) => {
    if (phase === "failed" || phase === "disposed" || phase === "committed") return;
    const afterReady = readySettled;
    phase = "failed";
    clearTimers();
    if (terminate) terminateGuard();
    bestEffortUnlink();
    settleReady({ ok: false, error: message });
    try { onFailure(message, { afterReady }); } catch { /* diagnostics are best effort */ }
  };

  function acceptHandshake(message) {
    phase = "stability";
    clearTimers(); // the handshake deadline no longer applies
    guardPid = message.guardPid;
    bestEffortUnlink(); // the parent owns the ready file's lifecycle
    probeTimer = setInterval(() => {
      if (phase !== "stability" && phase !== "accepted") return;
      if (!probe(message.guardPid)) {
        fail(
          `restart helper (pid ${message.guardPid}) exited ${phase === "stability" ? "during the stability window" : "after the handoff was accepted"}`,
        );
      }
    }, pollMs);
    deadlineTimer = setTimeout(() => {
      if (phase !== "stability") return;
      phase = "accepted";
      settleReady({ ok: true });
      // Keep watching until committed; a death here cancels the pending exit.
      deadlineTimer = setTimeout(() => {
        if (phase !== "accepted") return;
        phase = "committed";
        clearTimers();
        try {
          onHostExit();
        } catch (error) {
          phase = "failed";
          try { onFailure(`could not exit old Host: ${error?.message ?? String(error)}`, { afterReady: true }); } catch { /* best effort */ }
        }
      }, responseDelayMs);
    }, stabilityMs);
  }

  function pollOnce() {
    if (phase !== "handshake") return;
    const message = readRestartHelperReadyFile(readyFile);
    if (message?.type !== RESTART_HELPER_READY_TYPE) return; // missing/half-written/unrelated
    if (!Number.isInteger(message.guardPid) || message.guardPid <= 0) return;
    if (message.protocol !== RESTART_HELPER_PROTOCOL_VERSION || message.awaitExitPid !== awaitExitPid) {
      // Identified as one of our helpers but speaking the wrong protocol or
      // waiting for a different Host: stop it rather than let it linger.
      guardPid = message.guardPid;
      fail(
        `restart helper protocol mismatch (expected v${RESTART_HELPER_PROTOCOL_VERSION} for pid ${awaitExitPid})`,
        { terminate: true },
      );
      return;
    }
    acceptHandshake(message);
  }

  deadlineTimer = setTimeout(() => {
    if (phase !== "handshake") return;
    fail(`restart helper did not write ${readyFile} within ${handshakeTimeoutMs}ms`);
  }, handshakeTimeoutMs);
  pollTimer = setInterval(pollOnce, pollMs);
  pollOnce(); // an already-present ready file must not wait out one interval

  const dispose = () => {
    if (phase === "failed" || phase === "disposed" || phase === "committed") return;
    phase = "disposed";
    clearTimers();
    terminateGuard();
    bestEffortUnlink();
    settleReady({ ok: false, error: "restart handoff cancelled because the plugin unloaded" });
  };

  return {
    ready,
    dispose,
    failFast: (message) => fail(message, { terminate: true }),
    state: () => phase,
  };
}
