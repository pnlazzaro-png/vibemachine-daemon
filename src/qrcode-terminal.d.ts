// qrcode-terminal ships no types; the one call lan.ts makes.
declare module "qrcode-terminal" {
  export function generate(text: string, opts: { small: boolean }, cb: (code: string) => void): void;
}
