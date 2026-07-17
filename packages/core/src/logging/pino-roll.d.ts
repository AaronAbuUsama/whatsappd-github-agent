declare module "pino-roll" {
  import type { DestinationStream } from "pino";

  interface PinoRollOptions {
    readonly file: string;
    readonly size?: string;
    readonly frequency?: string | number;
    readonly extension?: string;
    readonly mkdir?: boolean;
    readonly limit?: { readonly count?: number };
  }

  const roll: (options: PinoRollOptions) => Promise<DestinationStream>;
  export default roll;
}
