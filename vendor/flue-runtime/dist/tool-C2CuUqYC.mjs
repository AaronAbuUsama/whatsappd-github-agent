import { B as ToolOutputSerializationError, L as ToolInputValidationError, R as ToolLegacyDefinitionError, V as ToolOutputValidationError } from "./errors-DUgRtE8e.mjs";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
//#region src/schema.ts
const jsonSchemas = /* @__PURE__ */ new WeakMap();
function isStandardSchema(value) {
	if (!value || typeof value !== "object") return false;
	const marker = value["~standard"];
	return typeof marker === "object" && marker !== null;
}
function isValibotSchema(value) {
	if (!isStandardSchema(value)) return false;
	const schema = value;
	return schema.kind === "schema" && typeof schema.type === "string" && typeof schema.async === "boolean" && typeof schema["~run"] === "function" && schema["~standard"].version === 1 && schema["~standard"].vendor === "valibot" && typeof schema["~standard"].validate === "function";
}
function isTopLevelObjectSchema(schema) {
	const type = schema.type;
	return [
		"object",
		"strict_object",
		"loose_object",
		"object_with_rest"
	].includes(type ?? "");
}
function valibotToJsonSchema(schema) {
	assertValibotSchema(schema);
	const cached = jsonSchemas.get(schema);
	if (cached) return cached;
	const { $schema: _schema, ...jsonSchema } = toJsonSchema(schema, { errorMode: "ignore" });
	const frozen = deepFreeze(jsonSchema);
	jsonSchemas.set(schema, frozen);
	return frozen;
}
function deepFreeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}
function parseValibot(schema, value) {
	assertValibotSchema(schema);
	const parsed = v.safeParse(schema, value);
	if (parsed.success) return {
		success: true,
		output: parsed.output
	};
	return {
		success: false,
		issues: parsed.issues.map(normalizeValibotIssue)
	};
}
function assertValibotSchema(value) {
	if (!isValibotSchema(value)) throw new TypeError("[flue] Expected a Valibot schema.");
}
function normalizeValibotIssue(issue) {
	const path = issue.path?.map((segment) => segment.key).filter((key) => key !== void 0 && key !== null);
	return path && path.length > 0 ? {
		message: issue.message,
		path
	} : { message: issue.message };
}
//#endregion
//#region src/json-snapshot.ts
function cloneJsonSerializable(value, label) {
	assertJsonLike(value, label, /* @__PURE__ */ new WeakSet());
	let json;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		throw new Error(`[flue] ${label} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
	}
	return JSON.parse(json);
}
function assertJsonLike(value, path, seen) {
	if (value === null) return;
	const type = typeof value;
	if (type === "string" || type === "number" || type === "boolean") {
		if (type === "number" && !Number.isFinite(value)) throw new Error(`[flue] ${path} must not contain non-finite numbers.`);
		return;
	}
	if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") throw new Error(`[flue] ${path} must not contain ${type} values.`);
	if (typeof value !== "object") return;
	if (seen.has(value)) throw new Error(`[flue] ${path} must not contain circular references.`);
	seen.add(value);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) assertJsonLike(value[i], `${path}[${i}]`, seen);
		seen.delete(value);
		return;
	}
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error(`[flue] ${path} must contain only plain JSON objects, arrays, strings, numbers, booleans, or null.`);
	for (const [key, child] of Object.entries(value)) {
		if (child === void 0) continue;
		assertJsonLike(child, `${path}.${key}`, seen);
	}
	seen.delete(value);
}
//#endregion
//#region src/tool.ts
function defineTool(options) {
	assertToolDefinition(options, "defineTool()");
	return Object.freeze({
		name: options.name,
		description: options.description,
		input: options.input,
		output: options.output,
		run: options.run
	});
}
function assertToolDefinition(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`[flue] ${label} requires a tool definition object.`);
	const legacyFields = ["parameters", "execute"].filter((field) => Object.hasOwn(value, field));
	if (legacyFields.length > 0) throw new ToolLegacyDefinitionError({ fields: legacyFields });
	const tool = value;
	assertNonEmptyString(tool.name, `${label} name`);
	assertNonEmptyString(tool.description, `${label} description`);
	if (tool.input !== void 0) {
		if (!isValibotSchema(tool.input)) throw new Error(`[flue] ${label} input must be a Valibot schema.`);
		if (!isTopLevelObjectSchema(tool.input)) throw new Error(`[flue] ${label} input must be a top-level object schema.`);
	}
	if (tool.output !== void 0 && !isValibotSchema(tool.output)) throw new Error(`[flue] ${label} output must be a Valibot schema.`);
	if (typeof tool.run !== "function") throw new Error(`[flue] ${label} run must be a function.`);
}
function parseToolInput(tool, input, signal) {
	if (!tool.input) return {
		context: { signal },
		input: void 0
	};
	const parsedInput = parseValibot(tool.input, input === void 0 ? {} : input);
	if (!parsedInput.success) throw new ToolInputValidationError({
		tool: tool.name,
		issues: parsedInput.issues
	});
	return {
		context: {
			input: parsedInput.output,
			signal
		},
		input: parsedInput.output
	};
}
function validateToolOutput(tool, result) {
	let output = result;
	if (tool.output) {
		const parsedOutput = parseValibot(tool.output, result);
		if (!parsedOutput.success) throw new ToolOutputValidationError({
			tool: tool.name,
			issues: parsedOutput.issues
		});
		output = parsedOutput.output;
	}
	if (output === void 0 && !tool.output) return void 0;
	if (output === void 0) throw new ToolOutputSerializationError({ tool: tool.name });
	try {
		return cloneJsonSerializable(output, `Tool "${tool.name}" output`);
	} catch (cause) {
		throw new ToolOutputSerializationError({
			tool: tool.name,
			cause
		});
	}
}
function assertNonEmptyString(value, label) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`[flue] ${label} must be a non-empty string.`);
}
//#endregion
export { cloneJsonSerializable as a, parseValibot as c, validateToolOutput as i, valibotToJsonSchema as l, defineTool as n, isTopLevelObjectSchema as o, parseToolInput as r, isValibotSchema as s, assertToolDefinition as t };
