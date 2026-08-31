// Keep the code-point limit aligned with normalizeLabels in internal/store.
// String.length / HTML maxlength count UTF-16 units, not Unicode code points.
const LABEL_MAX_CODE_POINTS = 64;

export function parseLabelInput(input: string): { value: string } | { error: string } {
  // Format characters such as the emoji joiner are allowed; controls and
  // line/paragraph separators are not useful in a single-line label editor.
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(input)) {
    return { error: "Labels cannot contain line breaks or control characters." };
  }
  const value = input.trim().replace(/\p{Zs}+/gu, " ");
  if (Array.from(value).length > LABEL_MAX_CODE_POINTS) {
    return { error: `Use at most ${LABEL_MAX_CODE_POINTS} Unicode code points per label.` };
  }
  return { value };
}
