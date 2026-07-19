import { i as ToolInputSchema, n as ToolDefinition, o as ToolOutputSchema } from "./tool-types-CcKIl663.mjs";

//#region src/tool.d.ts
declare function defineTool<const TInput extends ToolInputSchema | undefined = undefined, const TOutput extends ToolOutputSchema | undefined = undefined>(options: {
  name: string;
  description: string;
  input?: TInput;
  output?: TOutput;
  run: ToolDefinition<TInput, TOutput>['run'];
}): ToolDefinition<TInput, TOutput>;
//#endregion
export { defineTool as t };