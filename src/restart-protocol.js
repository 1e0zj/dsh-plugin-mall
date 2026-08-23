// Host-independent restart handoff protocol shared by the Web plugin and the
// standalone guard CLI.  The parent must not infer readiness from a child pid:
// an incompatible CLI can spawn successfully and then die on argument parsing.

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
