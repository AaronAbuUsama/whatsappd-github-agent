declare module "qrcode-terminal" {
  const qrCode: {
    generate(value: string, options: { small: boolean }, callback: (output: string) => void): void;
  };
  export default qrCode;
}
