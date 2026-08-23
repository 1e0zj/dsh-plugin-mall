// Job logs are rendered as plain text in the browser. Child processes such as
// pnpm may still emit terminal colour controls when their stdio is piped (for
// example when FORCE_COLOR is inherited), which the browser shows as `[96m`.
// Keep the sanitizer dependency-free and limited to CSI sequences: those cover
// pnpm's colours/progress controls without deleting ordinary user text.

const ANSI_CSI_RE = new RegExp("\\u001b\\[[0-?]*[ -/]*[@-~]", "g");

export function stripTerminalControlSequences(value) {
  return String(value ?? "").replace(ANSI_CSI_RE, "");
}
