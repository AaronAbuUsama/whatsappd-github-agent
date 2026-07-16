import { createRequire } from "node:module";

type QrRenderer = {
  generate(value: string, options: { readonly small: boolean }, callback: (rendered: string) => void): void;
};

export const renderQr = (
  value: string,
  write: (rendered: string) => void = (rendered) => process.stdout.write(rendered),
) => {
  const renderer = createRequire(import.meta.url)("qrcode-terminal") as QrRenderer;
  renderer.generate(value, { small: true }, (rendered) => write(`${rendered}\n`));
};
