/**
 * The little of the encoder's shape this file uses, declared here so the package
 * has no type-level dependency on it either.
 */
interface QrCode {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, column: number): boolean;
}
type QrCodeFactory = (typeNumber: number, errorCorrection: "L" | "M" | "Q" | "H") => QrCode;

/**
 * A QR code as text, so it can travel in a chat message.
 *
 * One character per module, two modules per row, using the half-block glyphs:
 * `█` both dark, `▀` top dark, `▄` bottom dark, ` ` neither. That is half the
 * height and a third of the width of the `██`/`  ` rendering, which keeps a
 * link-sized code inside a fenced block on a phone screen while staying
 * scannable — as long as the renderer keeps line-height at 1, which the TUI does
 * and a web code block does not.
 *
 * The encoder is an *optional* dependency, loaded lazily: a missing package must
 * cost the QR code, not the whole extension. `null` means "no code available".
 */

export const QR_MARGIN = 2;

let factory: QrCodeFactory | null | undefined;

async function loadFactory(): Promise<QrCodeFactory | null> {
  if (factory !== undefined) return factory;
  try {
    const module = (await import("qrcode-generator")) as unknown as { default?: QrCodeFactory };
    factory = module.default ?? null;
  } catch {
    factory = null;
  }
  return factory;
}

/** Whether a QR code can be drawn at all in this environment. */
export async function qrAvailable(): Promise<boolean> {
  return (await loadFactory()) !== null;
}

export function qrMatrix(make: QrCodeFactory, text: string, errorCorrection: "L" | "M" | "Q" | "H" = "M"): boolean[][] {
  const code = make(0, errorCorrection);
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  const matrix: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    const line: boolean[] = [];
    for (let column = 0; column < size; column++) line.push(code.isDark(row, column));
    matrix.push(line);
  }
  return matrix;
}

/** Rows of half-block characters, with a quiet zone around the code. */
export function renderHalfBlock(matrix: readonly boolean[][], margin: number = QR_MARGIN): string[] {
  const size = matrix.length;
  if (size === 0) return [];
  const width = matrix[0]?.length ?? 0;
  const pad = " ".repeat(margin);
  const lines: string[] = [];

  for (let row = 0; row < size; row += 2) {
    let line = pad;
    for (let column = 0; column < width; column++) {
      const top = matrix[row]?.[column] === true;
      const bottom = matrix[row + 1]?.[column] === true;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line + pad);
  }

  const blank = " ".repeat(width + margin * 2);
  return [...Array.from({ length: margin }, () => blank), ...lines, ...Array.from({ length: margin }, () => blank)];
}

/** The code as a fenced block, or null when the optional encoder is missing. */
export async function renderQrBlock(text: string, margin: number = QR_MARGIN): Promise<string | null> {
  const make = await loadFactory();
  if (!make) return null;
  return ["```text", ...renderHalfBlock(qrMatrix(make, text), margin), "```"].join("\n");
}
