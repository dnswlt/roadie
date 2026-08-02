// One place that writes to the clipboard, so every copy in the app reports
// success and failure the same way. navigator.clipboard needs a secure context
// (https, or localhost) and can be refused by permissions, so the failure path
// is real rather than defensive.

import { toast } from "./toast";

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast(`Couldn't copy ${what.toLowerCase()}`, true);
  }
}
