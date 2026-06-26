// Encodes a composed prompt for PTY stdin. Bracketed paste (DECSET 2004) keeps
// multi-line content as one block; the trailing CR (submit only) is sent by the
// caller AFTER a settle delay (see ipc.deliverToPty). Pure: no Tauri.
const ESC = "\x1b";

export function wrapForDelivery(text: string, submit: boolean): string {
  return `${ESC}[200~${text}${ESC}[201~` + (submit ? "\r" : "");
}
