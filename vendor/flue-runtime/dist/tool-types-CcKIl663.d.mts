import * as v from "valibot";

//#region src/json-snapshot.d.ts
type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
//#endregion
//#region src/tool-types.d.ts
type ToolInputSchema = v.GenericSchema<Record<string, unknown>, unknown>;
type ToolOutputSchema = v.GenericSchema<any, NonNullable<unknown> | null>;
type ToolContext<S extends ToolInputSchema | undefined> = {
  readonly signal?: AbortSignal;
} & (S extends ToolInputSchema ? {
  readonly input: v.InferOutput<S>;
} : Record<never, never>);
type ToolRunResult<S extends ToolOutputSchema | undefined> = S extends ToolOutputSchema ? v.InferInput<S> : JsonValue | undefined;
interface ToolDefinition<TInput extends ToolInputSchema | undefined = ToolInputSchema | undefined, TOutput extends ToolOutputSchema | undefined = ToolOutputSchema | undefined> {
  readonly name: string;
  readonly description: string;
  readonly input: TInput;
  readonly output: TOutput;
  run(context: ToolContext<TInput>): ToolRunResult<TOutput> | Promise<ToolRunResult<TOutput>>;
}
type ToolInput<TTool extends ToolDefinition> = TTool extends ToolDefinition<infer TInput, any> ? TInput extends ToolInputSchema ? v.InferInput<TInput> : never : never;
type ToolOutput<TTool extends ToolDefinition> = TTool extends ToolDefinition<any, infer TOutput> ? TOutput extends ToolOutputSchema ? v.InferOutput<TOutput> : unknown : never;
//#endregion
export { ToolOutput as a, ToolInputSchema as i, ToolDefinition as n, ToolOutputSchema as o, ToolInput as r, JsonValue as s, ToolContext as t };