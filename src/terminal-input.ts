// Pure classifier for xterm onData chunks: distinguishes literal typed text from
// non-printable control bytes (readline shortcuts like Ctrl+A/U/K/W, and ANSI
// escape/report sequences — arrows, function keys, focus in/out CSI I/O) that
// arrive through the same onData channel but must never be tracked as shell input.

/** True when `d` starts with a non-printable control byte rather than literal typed text. */
export function isControlSequence(d: string): boolean {
  if (d.length === 0) return false;
  const code = d.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}
