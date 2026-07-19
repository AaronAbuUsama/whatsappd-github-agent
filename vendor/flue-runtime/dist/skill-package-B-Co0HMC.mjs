import { c as parseValibot, l as valibotToJsonSchema, o as isTopLevelObjectSchema } from "./tool-C2CuUqYC.mjs";
import { c as composeTimeoutSignal } from "./sandbox-tx-XM70E.mjs";
import { Type } from "@earendil-works/pi-ai";
import { FAILSAFE_SCHEMA, load } from "js-yaml";
//#region src/event-redaction.ts
/**
* Sentinel that replaces raw base64 image bytes in event payloads. Events keep
* an image's presence and `mimeType` visible without carrying the payload
* itself, so observers and persisted run history never retain image bytes.
* Session history (model context) is unaffected and retains the real bytes.
*/
const IMAGE_DATA_OMITTED = "[image data omitted from event]";
/**
* Return `event` with raw image bytes replaced by `IMAGE_DATA_OMITTED` in
* every message-bearing payload field.
*
* Copy-on-write: events without image content pass through unchanged, and
* redaction never mutates the input. The message objects carried by these
* events are the live objects in the agent harness state — mutating them in
* place would corrupt the model context and persisted session history.
*/
function redactEventImages(event) {
	switch (event.type) {
		case "message_start":
		case "message_end": {
			const message = redactMessageImages(event.message);
			return message === event.message ? event : {
				...event,
				message
			};
		}
		case "turn_messages": {
			const message = redactMessageImages(event.message);
			const toolResults = redactEachMessageImages(event.toolResults);
			if (message === event.message && toolResults === event.toolResults) return event;
			return {
				...event,
				message,
				toolResults
			};
		}
		case "agent_end": {
			const messages = redactEachMessageImages(event.messages);
			return messages === event.messages ? event : {
				...event,
				messages
			};
		}
		case "tool": {
			const result = redactToolResultImages(event.result);
			return result === event.result ? event : {
				...event,
				result
			};
		}
		default: return event;
	}
}
function redactMessageImages(message) {
	const content = message.content;
	if (!Array.isArray(content)) return message;
	const redacted = redactContentImages(content);
	return redacted === content ? message : {
		...message,
		content: redacted
	};
}
function redactEachMessageImages(messages) {
	let changed = false;
	const redacted = messages.map((message) => {
		const result = redactMessageImages(message);
		if (result !== message) changed = true;
		return result;
	});
	return changed ? redacted : messages;
}
/**
* Redact `content` blocks of an `AgentToolResult`-shaped tool result. The
* tool-specific `details` payload is arbitrary and is passed through as-is;
* adapter tools should not copy raw image bytes into `details`.
*/
function redactToolResultImages(result) {
	if (result === null || typeof result !== "object") return result;
	const content = result.content;
	if (!Array.isArray(content)) return result;
	const redacted = redactContentImages(content);
	return redacted === content ? result : {
		...result,
		content: redacted
	};
}
function redactObservationDetailImages(detail) {
	if (!detail || !Object.hasOwn(detail, "effectiveResult")) return detail;
	const effectiveResult = redactContentValueImages(detail.effectiveResult);
	return effectiveResult === detail.effectiveResult ? detail : {
		...detail,
		effectiveResult
	};
}
function redactContentValueImages(value) {
	if (!Array.isArray(value)) return value;
	return redactContentImages(value);
}
function redactContentImages(content) {
	let changed = false;
	const redacted = content.map((block) => {
		if (block === null || typeof block !== "object") return block;
		const { type, data } = block;
		if (type === "image" && typeof data === "string" && data !== "[image data omitted from event]") {
			changed = true;
			return {
				...block,
				data: IMAGE_DATA_OMITTED
			};
		}
		return block;
	});
	return changed ? redacted : content;
}
//#endregion
//#region src/tool-adapter.ts
const preparedToolAdapter = Symbol("flue.preparedToolAdapter");
function registerPreparedToolAdapter(tool, adapter) {
	Object.defineProperty(tool, preparedToolAdapter, {
		value: Object.freeze(adapter),
		enumerable: true
	});
}
function getPreparedToolAdapter(tool) {
	return tool[preparedToolAdapter];
}
//#endregion
//#region src/agent.ts
const MAX_READ_LINES = 2e3;
const MAX_READ_BYTES = 50 * 1024;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_LINE_LENGTH = 500;
const MAX_GLOB_RESULTS = 1e3;
const BASE64_READ_LINE_LENGTH = 76;
const PACKAGED_SKILLS_ROOT = "/.flue/packaged-skills/";
const READ_SKILL_RESOURCE_TOOL_NAME = "read_skill_resource";
function createTools(env, options) {
	const tools = [
		createReadTool(env, options?.packagedSkills ?? {}),
		createWriteTool(env),
		createEditTool(env),
		createBashTool(env),
		createGrepTool(env),
		createGlobTool(env)
	];
	if (options?.task) tools.push(createTaskTool(options.task, options.subagents ?? {}));
	return tools;
}
const ReadParams = Type.Object({
	path: Type.String({ description: "Path to the file to read" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" }))
});
function createPackagedSkillReadTool(packagedSkills) {
	return {
		name: READ_SKILL_RESOURCE_TOOL_NAME,
		label: "Read Skill Resource",
		description: "Read a packaged skill supporting file by its advertised path.",
		parameters: ReadParams,
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const content = readPackagedSkillFile(packagedSkills, params.path);
			if (content === void 0) throw new Error(`[flue] Packaged skill file not found: ${params.path}`);
			return formatReadContent(params.path, content, params.offset, params.limit);
		}
	};
}
function createReadTool(env, packagedSkills) {
	return {
		name: "read",
		label: "Read File",
		description: "Read a file. Output is truncated to 2000 lines or 50KB — use offset/limit for large files.",
		parameters: ReadParams,
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const packagedFile = readPackagedSkillFile(packagedSkills, params.path);
			if (packagedFile !== void 0) return formatReadContent(params.path, packagedFile, params.offset, params.limit);
			if (params.path.startsWith(PACKAGED_SKILLS_ROOT)) throw new Error(`[flue] Packaged skill file not found: ${params.path}`);
			const content = await env.readFile(params.path);
			return formatReadContent(params.path, content, params.offset, params.limit);
		}
	};
}
const WriteParams = Type.Object({
	path: Type.String({ description: "Path to the file to write" }),
	content: Type.String({ description: "Content to write to the file" })
});
function createWriteTool(env) {
	return {
		name: "write",
		label: "Write File",
		description: "Write content to a file. Creates the file and parent directories if they do not exist.",
		parameters: WriteParams,
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			await env.writeFile(params.path, params.content);
			return {
				content: [{
					type: "text",
					text: `Successfully wrote ${params.content.length} bytes to ${params.path}`
				}],
				details: {
					path: params.path,
					size: params.content.length
				}
			};
		}
	};
}
const EditParams = Type.Object({
	path: Type.String({ description: "Path to the file to edit" }),
	oldText: Type.String({ description: "Exact text to find (must be unique)" }),
	newText: Type.String({ description: "Replacement text" }),
	replaceAll: Type.Optional(Type.Boolean({ description: "Replace all occurrences" }))
});
function createEditTool(env) {
	return {
		name: "edit",
		label: "Edit File",
		description: "Edit a file using exact text replacement. The oldText must match a unique region of the file. Use replaceAll to replace all occurrences.",
		parameters: EditParams,
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			if (params.oldText === "") throw new Error("oldText must be a non-empty string.");
			const content = await env.readFile(params.path);
			if (params.replaceAll) {
				const newContent = content.replaceAll(params.oldText, params.newText);
				if (newContent === content) throw new Error(`Could not find the text in ${params.path}. No changes made.`);
				await env.writeFile(params.path, newContent);
				const count = content.split(params.oldText).length - 1;
				return {
					content: [{
						type: "text",
						text: `Replaced ${count} occurrences in ${params.path}`
					}],
					details: {
						path: params.path,
						replacements: count
					}
				};
			}
			const occurrences = countOccurrences(content, params.oldText);
			if (occurrences === 0) throw new Error(`Could not find the exact text in ${params.path}. Make sure your oldText matches exactly, including whitespace and indentation.`);
			if (occurrences > 1) throw new Error(`Found ${occurrences} occurrences of the text in ${params.path}. Provide more surrounding context to make the match unique, or use replaceAll.`);
			const newContent = content.replace(params.oldText, params.newText);
			await env.writeFile(params.path, newContent);
			return {
				content: [{
					type: "text",
					text: `Successfully edited ${params.path}`
				}],
				details: { path: params.path }
			};
		}
	};
}
const BashParams = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" }))
});
function createBashTool(env) {
	return {
		name: "bash",
		label: "Run Command",
		description: "Execute a bash command. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB.",
		parameters: BashParams,
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const timeoutMs = typeof params.timeout === "number" ? params.timeout * 1e3 : void 0;
			const { timeoutSignal, mergedSignal: execSignal } = composeTimeoutSignal(timeoutMs, signal);
			const timedOut = () => formatBashResult({
				stdout: "",
				stderr: `[flue] Command timed out after ${params.timeout} seconds.`,
				exitCode: 124
			}, params.command);
			try {
				const result = await env.exec(params.command, {
					timeoutMs,
					signal: execSignal
				});
				if (timeoutSignal?.aborted && !signal?.aborted) return timedOut();
				return formatBashResult(result, params.command);
			} catch (err) {
				if (timeoutSignal?.aborted && !signal?.aborted) return timedOut();
				throw err;
			}
		}
	};
}
const TaskParams = Type.Object({
	description: Type.Optional(Type.String({ description: "Short human-readable label for the delegated work" })),
	prompt: Type.String({ description: "Focused instructions for the child agent" }),
	agent: Type.Optional(Type.String({ description: "Declared subagent to use for the child agent" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child agent. AGENTS.md and skills are discovered from here." })),
	attachments: Type.Optional(Type.Array(Type.Object({ id: Type.String({ description: "Attachment ID shown in the current conversation" }) }), { description: "Images from this conversation to include in the child agent prompt" }))
});
/** Build Flue's framework-owned `task` tool. */
function createTaskTool(runTask, subagents) {
	const agentEntries = Object.entries(subagents);
	return {
		name: "task",
		label: "Run Task",
		description: "Delegate a focused task to a detached child agent with its own context. Use this for independent research, file exploration, or parallel work. Pass attachment IDs shown in the conversation to include those images. The task returns only its final answer to this conversation." + (agentEntries.length > 0 ? `\nAvailable agents:\n${agentEntries.map(([name, profile]) => profile.description ? `- ${name}: ${profile.description}` : `- ${name}`).join("\n")}` : " No subagents are currently defined."),
		parameters: TaskParams,
		async execute(toolCallId, params, signal) {
			throwIfAborted(signal);
			return runTask(params, signal, toolCallId);
		}
	};
}
function createActivateSkillTool(skillNames, activate) {
	const sortedNames = [...skillNames].sort();
	const [firstName] = sortedNames;
	if (!firstName) throw new Error("[flue] Cannot create activate_skill tool without available skills.");
	const NameSchema = sortedNames.length === 1 ? Type.Literal(firstName) : Type.Union(sortedNames.map((name) => Type.Literal(name)));
	return {
		name: "activate_skill",
		label: "Activate Skill",
		description: "Load the full instructions for one available skill before performing work that matches its description. Supporting resources remain lazy until explicitly read.",
		parameters: Type.Object({ name: NameSchema }),
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const name = typeof params === "object" && params !== null && "name" in params && typeof params.name === "string" ? params.name : "";
			return {
				content: [{
					type: "text",
					text: await activate(name, signal)
				}],
				details: { skill: name }
			};
		}
	};
}
function formatBashResult(result, command) {
	const { text: output } = truncateTail((result.stdout + (result.stderr ? `\n${result.stderr}` : "")).trim(), MAX_READ_LINES, MAX_READ_BYTES);
	const exitLine = `Command exited with code ${result.exitCode}`;
	return {
		content: [{
			type: "text",
			text: result.exitCode === 0 ? output || "(no output)" : `${output || "(no output)"}\n\n${exitLine}`
		}],
		details: {
			command,
			exitCode: result.exitCode
		}
	};
}
const GrepParams = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: .)" })),
	include: Type.Optional(Type.String({ description: "Glob filter, e.g. \"*.ts\"" })),
	literal: Type.Optional(Type.Boolean({ description: "Match the pattern as literal text" }))
});
const grepBackends = /* @__PURE__ */ new WeakMap();
function resolveGrepBackend(env) {
	let backend = grepBackends.get(env);
	if (!backend) {
		backend = env.exec("rg --version", { timeoutMs: 1e4 }).then((result) => result.exitCode === 0 ? "rg" : "grep").catch(() => "grep");
		grepBackends.set(env, backend);
	}
	return backend;
}
function createGrepTool(env) {
	return {
		name: "grep",
		label: "Search Files",
		description: "Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.",
		parameters: GrepParams,
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const searchPath = params.path || ".";
			const backend = await resolveGrepBackend(env);
			let cmd;
			if (backend === "rg") cmd = `rg --line-number --with-filename --color never${params.literal ? " --fixed-strings" : ""}${params.include ? ` --glob ${shellQuote(params.include)}` : ""} -- ${shellQuote(params.pattern)} ${shellQuote(searchPath)}`;
			else cmd = `grep -rnH ${params.literal ? "-F" : "-E"}${params.include ? ` --include=${shellQuote(params.include)}` : ""} -- ${shellQuote(params.pattern)} ${shellQuote(searchPath)}`;
			const result = await env.exec(cmd, { signal });
			if (result.exitCode === 1 && !result.stdout.trim()) return {
				content: [{
					type: "text",
					text: "No matches found."
				}],
				details: { matchCount: 0 }
			};
			if (result.exitCode > 1) throw new Error(`grep failed: ${result.stderr}`);
			const lines = result.stdout.trim().split("\n");
			let finalOutput = lines.slice(0, MAX_GREP_MATCHES).map((line) => line.length > MAX_GREP_LINE_LENGTH ? `${line.slice(0, MAX_GREP_LINE_LENGTH)}...` : line).join("\n");
			if (lines.length > MAX_GREP_MATCHES) finalOutput += `\n\n[Showing ${MAX_GREP_MATCHES} of ${lines.length} matches. Narrow your search.]`;
			return {
				content: [{
					type: "text",
					text: finalOutput
				}],
				details: { matchCount: Math.min(lines.length, MAX_GREP_MATCHES) }
			};
		}
	};
}
const GlobParams = Type.Object({
	pattern: Type.String({ description: "Filename pattern, e.g. \"*.ts\"" }),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: .)" }))
});
function createGlobTool(env) {
	return {
		name: "glob",
		label: "Find Files",
		description: "Find files by filename pattern using shell find -name semantics. Returns matching file paths.",
		parameters: GlobParams,
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const cmd = `find ${shellQuote(params.path || ".")} -type f -name ${shellQuote(params.pattern)} 2>/dev/null | head -${MAX_GLOB_RESULTS}`;
			const result = await env.exec(cmd, { signal });
			if (result.exitCode !== 0 && !result.stdout.trim()) return {
				content: [{
					type: "text",
					text: "No files found matching pattern."
				}],
				details: { matchCount: 0 }
			};
			const paths = result.stdout.trim().split("\n").filter(Boolean);
			if (paths.length === 0) return {
				content: [{
					type: "text",
					text: "No files found matching pattern."
				}],
				details: { matchCount: 0 }
			};
			return {
				content: [{
					type: "text",
					text: paths.join("\n")
				}],
				details: { matchCount: paths.length }
			};
		}
	};
}
function throwIfAborted(signal) {
	if (signal?.aborted) throw new Error("Operation aborted");
}
function readPackagedSkillFile(skills, path) {
	for (const skill of Object.values(skills)) for (const [filePath, file] of Object.entries(skill.files)) {
		if (path !== packagedSkillReadPath(skill.id, filePath)) continue;
		return file.kind === "binary" ? wrapBase64ForReading(file.content) : new TextDecoder().decode(Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0)));
	}
}
function wrapBase64ForReading(content) {
	const lines = [];
	for (let offset = 0; offset < content.length; offset += BASE64_READ_LINE_LENGTH) lines.push(content.slice(offset, offset + BASE64_READ_LINE_LENGTH));
	return lines.join("\n");
}
function formatReadContent(path, content, offset, limit) {
	const allLines = content.split("\n");
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= allLines.length) throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	const endLine = limit ? startLine + limit : allLines.length;
	const { text: truncatedText, wasTruncated } = truncateHead(allLines.slice(startLine, endLine), MAX_READ_LINES, MAX_READ_BYTES);
	let output = truncatedText;
	if (wasTruncated) {
		const shownEnd = startLine + truncatedText.split("\n").length;
		output += `\n\n[Showing lines ${startLine + 1}-${shownEnd} of ${allLines.length}. Use offset=${shownEnd + 1} to continue.]`;
	}
	return {
		content: [{
			type: "text",
			text: output
		}],
		details: {
			path,
			lines: allLines.length
		}
	};
}
function formatPackagedSkillFilePath(skillId, filePath) {
	return packagedSkillReadPath(skillId, filePath);
}
function packagedSkillReadPath(skillId, filePath) {
	return `/.flue/packaged-skills/${encodeURIComponent(skillId)}/${filePath}`;
}
function countOccurrences(str, substr) {
	let count = 0;
	let pos = str.indexOf(substr, 0);
	while (pos !== -1) {
		count++;
		pos = str.indexOf(substr, pos + Math.max(substr.length, 1));
	}
	return count;
}
function shellQuote(arg) {
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}
function truncateHead(lines, maxLines, maxBytes) {
	let result = "";
	let lineCount = 0;
	let wasTruncated = false;
	for (const line of lines) {
		if (lineCount >= maxLines) {
			wasTruncated = true;
			break;
		}
		const next = lineCount === 0 ? line : `\n${line}`;
		if (result.length + next.length > maxBytes) {
			wasTruncated = true;
			break;
		}
		result += next;
		lineCount++;
	}
	return {
		text: result,
		wasTruncated
	};
}
function truncateTail(text, maxLines, maxBytes) {
	const lines = text.split("\n");
	if (lines.length <= maxLines && text.length <= maxBytes) return {
		text,
		wasTruncated: false
	};
	let result = lines.slice(-maxLines).join("\n");
	if (result.length > maxBytes) result = result.slice(-maxBytes);
	return {
		text: result,
		wasTruncated: true
	};
}
//#endregion
//#region src/skill-frontmatter.ts
function parseSkillMarkdown(content, options) {
	const match = content.replace(/^\uFEFF/, "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/);
	if (!match) throw new Error(`[flue] Skill ${options.path} is missing YAML frontmatter. Start SKILL.md with "---", include "name" and "description", then close the block with "---".`);
	let raw;
	try {
		raw = load(match[1] ?? "", { schema: FAILSAFE_SCHEMA });
	} catch (error) {
		const detail = error instanceof Error ? ` ${error.message}` : "";
		throw new Error(`[flue] Skill ${options.path} has invalid YAML frontmatter.${detail}`);
	}
	if (!isRecord(raw)) throw new Error(`[flue] Skill ${options.path} frontmatter must be a YAML mapping.`);
	const name = requireString(raw.name, options.path, "name");
	validateSkillName(name, options);
	const description = requireString(raw.description, options.path, "description");
	if ([...description].length > 1024) throw new Error(`[flue] Skill ${options.path} frontmatter description exceeds the 1024-character Agent Skills limit. Shorten "description" to a concise one-line summary.`);
	const license = optionalString(raw.license, options.path, "license");
	const compatibility = optionalString(raw.compatibility, options.path, "compatibility");
	if (compatibility !== void 0 && [...compatibility].length > 500) throw new Error(`[flue] Skill ${options.path} compatibility must be at most 500 characters.`);
	return {
		name,
		description,
		body: (match[2] ?? "").trim(),
		license,
		compatibility,
		metadata: parseMetadata(raw.metadata, options.path),
		allowedTools: parseAllowedTools(raw["allowed-tools"], options.path)
	};
}
function validateSkillName(name, options) {
	if (name.length > 64) throw new Error(`[flue] Skill ${options.path} name must be at most 64 characters.`);
	if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`[flue] Skill ${options.path} frontmatter name "${name}" must contain only lowercase ASCII letters, numbers, and hyphens. Use a spec-compliant value such as "review-pr".`);
	if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) throw new Error(`[flue] Skill ${options.path} frontmatter name "${name}" must not start or end with a hyphen or contain consecutive hyphens. Use a spec-compliant value such as "review-pr".`);
	if (name !== options.directoryName) throw new Error(`[flue] Skill ${options.path} declares frontmatter name "${name}", but Agent Skills requires it to match directory "${options.directoryName}"; names must match. Rename the directory or change "name" so they match.`);
}
function requireString(value, path, field) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`[flue] Skill ${path} must define frontmatter ${field} as a non-empty string.`);
	return value.trim();
}
function optionalString(value, path, field) {
	if (value === void 0 || value === null) return void 0;
	if (typeof value !== "string") throw new Error(`[flue] Skill ${path} frontmatter ${field} must be a string when provided.`);
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function parseMetadata(value, path) {
	if (value === void 0 || value === null) return void 0;
	if (!isRecord(value)) throw new Error(`[flue] Skill ${path} frontmatter metadata must be a string-to-string mapping.`);
	const entries = Object.entries(value).map(([key, metadataValue]) => {
		if (metadataValue === null) return [key, ""];
		if (typeof metadataValue !== "string") throw new Error(`[flue] Skill ${path} frontmatter metadata must be a string-to-string mapping.`);
		return [key, metadataValue];
	});
	return Object.fromEntries(entries);
}
function parseAllowedTools(value, path) {
	if (value === void 0 || value === null) return void 0;
	if (typeof value !== "string") throw new Error(`[flue] Skill ${path} frontmatter allowed-tools must be a string when provided.`);
	const tools = value.trim().split(/\s+/).filter(Boolean);
	return tools.length > 0 ? tools : void 0;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region src/result.ts
/**
* Names of the framework-injected tools used to capture structured results.
* Reserved at custom-tool validation time; not part of the public API.
*/
const FINISH_TOOL_NAME = "finish";
const GIVE_UP_TOOL_NAME = "give_up";
/** Footer appended to user prompts/skill bodies when a `result` schema is set. */
function buildResultFooter() {
	return [
		"",
		`When the task is complete, call the \`${FINISH_TOOL_NAME}\` tool with your final answer as its arguments. The arguments are validated against the required schema; if validation fails you will receive an error and may try again.`,
		`If you determine that you cannot complete the task or cannot produce a result that conforms to the required schema, call the \`${GIVE_UP_TOOL_NAME}\` tool with a clear \`reason\`.`,
		`Do not respond with the answer in plain text — only a successful \`${FINISH_TOOL_NAME}\` (or \`${GIVE_UP_TOOL_NAME}\`) call counts.`
	].join("\n");
}
/** Follow-up prompt sent when the LLM ends a turn without calling `finish` or `give_up`. */
function buildResultFollowUpPrompt() {
	return [`You ended your turn without calling \`${FINISH_TOOL_NAME}\` or \`${GIVE_UP_TOOL_NAME}\`.`, `Either call \`${FINISH_TOOL_NAME}\` with your final answer, or call \`${GIVE_UP_TOOL_NAME}\` with a reason if you cannot determine the answer.`].join(" ");
}
function buildPackagedSkillPrompt(reference, directory, args, schema) {
	const skillFile = directory.files["SKILL.md"];
	if (!skillFile) throw new Error(`[flue] Packaged skill "${reference.name}" is missing SKILL.md.`);
	const skill = parseSkillMarkdown(new TextDecoder().decode(Uint8Array.from(atob(skillFile.content), (character) => character.charCodeAt(0))), {
		directoryName: reference.name,
		path: `${reference.name}/SKILL.md`
	});
	const parts = [
		`Run the skill named "${reference.name}".`,
		"",
		"<skill_instructions>",
		skill.body,
		"</skill_instructions>"
	];
	const resources = Object.keys(directory.files).filter((filePath) => filePath !== "SKILL.md").sort();
	if (resources.length > 0) parts.push("", "Supporting skill resources are available but are not loaded into context unless needed:", "<skill_resources>", ...resources.map((filePath) => `- ${filePath} → ${READ_SKILL_RESOURCE_TOOL_NAME} ${formatPackagedSkillFilePath(reference.id, filePath)}`), "</skill_resources>");
	if (args && Object.keys(args).length > 0) parts.push("", "Arguments:", JSON.stringify(args, null, 2));
	if (schema) parts.push(buildResultFooter());
	return parts.join("\n");
}
function buildWorkspaceSkillPrompt(name, directory, skillMdPath, raw) {
	const skill = parseSkillMarkdown(raw, {
		directoryName: name,
		path: skillMdPath
	});
	return [
		`Run the skill named "${name}".`,
		"",
		"<skill_instructions>",
		skill.body,
		"</skill_instructions>",
		"",
		"Supporting skill resources are available relative to this workspace skill directory but are not loaded into context unless needed:",
		"<skill_resources>",
		`- Base directory: ${directory}`,
		"- Resolve relative resource paths from this directory and read only the files you need.",
		"</skill_resources>"
	].join("\n");
}
/** Build the existing name-only prompt for runtime-discovered sandbox skills. */
function buildSkillByPathlessNamePrompt(name, args, schema) {
	const parts = [`Run the skill named "${name}".`];
	if (args && Object.keys(args).length > 0) parts.push("", "Arguments:", JSON.stringify(args, null, 2));
	if (schema) parts.push(buildResultFooter());
	return parts.join("\n");
}
function buildPromptText(text, schema) {
	const parts = [text];
	if (schema) parts.push(buildResultFooter());
	return parts.join("\n");
}
const resultToolPreparers = /* @__PURE__ */ new WeakMap();
function prepareResultTool(tool, params) {
	return resultToolPreparers.get(tool)?.(params);
}
/**
* Produce the per-call `finish` and `give_up` tool pair for a given valibot schema.
*
* - `finish`'s parameters are derived from the schema via `@valibot/to-json-schema`.
*   Non-object top-level schemas are wrapped in a `{ result: <schema> }` envelope
*   because every LLM provider expects tool arguments to be a top-level object.
* - Pi-agent-core validates args against the JSON Schema before calling `execute`.
*   Inside `execute` we additionally run `valibot.safeParse` to enforce
*   valibot-specific refinements and to obtain the parsed output (transforms,
*   defaults, coercion). On valibot failure we throw — pi-agent-core surfaces
*   the throw as a tool-error tool-result, so the LLM can self-correct.
* - First successful `finish` (or `give_up`) call wins. Subsequent calls return
*   a tool error rather than throwing, to keep the conversation transcript natural.
* - Successful calls set `terminate: true` so pi-agent-core ends the loop after
*   the current tool batch.
*/
function createResultTools(schema) {
	let outcome = { type: "pending" };
	const wrapped = needsEnvelope(schema);
	const innerJsonSchema = valibotToJsonSchema(schema);
	const finishParameters = wrapped ? {
		type: "object",
		properties: { result: innerJsonSchema },
		required: ["result"],
		additionalProperties: false
	} : innerJsonSchema;
	const finishDescription = `Call this tool when the task is complete. Provide your final answer as the arguments. The arguments are validated against the required schema; if validation fails you will receive an error message and may try again. The first successful \`${FINISH_TOOL_NAME}\` call wins — once the task is finished, do not call \`${FINISH_TOOL_NAME}\` again.`;
	const giveUpDescription = "Call this tool only if you have determined that you cannot complete the task or cannot produce a result that conforms to the required schema. Provide a clear `reason`. This ends the task with a failure.";
	const finishTool = {
		name: FINISH_TOOL_NAME,
		label: FINISH_TOOL_NAME,
		description: finishDescription,
		parameters: finishParameters,
		async execute(_toolCallId, params) {
			if (outcome.type !== "pending") return alreadyDoneToolError(outcome);
			const parsed = parseValibot(schema, wrapped ? params.result : params);
			if (!parsed.success) {
				const issues = parsed.issues.map((issue) => issue.path ? `${issue.message} (at ${formatIssuePath(issue.path)})` : issue.message).join("; ");
				throw new Error(`Result does not match the required schema: ${issues}. Please call \`${FINISH_TOOL_NAME}\` again with a corrected payload.`);
			}
			outcome = {
				type: "finished",
				value: parsed.output
			};
			return {
				content: [{
					type: "text",
					text: "Result accepted. The task is complete."
				}],
				details: {
					tool: FINISH_TOOL_NAME,
					result: parsed.output
				},
				terminate: true
			};
		}
	};
	resultToolPreparers.set(finishTool, (params) => {
		if (outcome.type !== "pending") return {
			args: params,
			run: async () => alreadyDoneToolError(outcome),
			result: resultToolValue
		};
		const parsed = parseValibot(schema, wrapped ? params.result : params);
		if (!parsed.success) {
			const issues = parsed.issues.map((issue) => issue.path ? `${issue.message} (at ${formatIssuePath(issue.path)})` : issue.message).join("; ");
			throw new Error(`Result does not match the required schema: ${issues}. Please call \`${FINISH_TOOL_NAME}\` again with a corrected payload.`);
		}
		return {
			args: parsed.output,
			run: async () => {
				outcome = {
					type: "finished",
					value: parsed.output
				};
				return {
					content: [{
						type: "text",
						text: "Result accepted. The task is complete."
					}],
					details: {
						tool: FINISH_TOOL_NAME,
						result: parsed.output
					},
					terminate: true
				};
			},
			result: resultToolValue
		};
	});
	const giveUpTool = {
		name: GIVE_UP_TOOL_NAME,
		label: GIVE_UP_TOOL_NAME,
		description: giveUpDescription,
		parameters: {
			type: "object",
			properties: { reason: {
				type: "string",
				minLength: 1,
				description: "A clear explanation of why the task cannot be completed."
			} },
			required: ["reason"],
			additionalProperties: false
		},
		async execute(_toolCallId, params) {
			if (outcome.type !== "pending") return alreadyDoneToolError(outcome);
			const reason = params.reason;
			if (typeof reason !== "string" || reason.trim().length === 0) throw new Error(`\`${GIVE_UP_TOOL_NAME}\` requires a non-empty \`reason\` string.`);
			outcome = {
				type: "gave_up",
				reason
			};
			return {
				content: [{
					type: "text",
					text: "Acknowledged."
				}],
				details: {
					tool: GIVE_UP_TOOL_NAME,
					reason
				},
				terminate: true
			};
		}
	};
	resultToolPreparers.set(giveUpTool, (params) => {
		if (outcome.type !== "pending") return {
			args: params,
			run: async () => alreadyDoneToolError(outcome),
			result: resultToolValue
		};
		const reason = params.reason;
		if (typeof reason !== "string" || reason.trim().length === 0) throw new Error(`\`${GIVE_UP_TOOL_NAME}\` requires a non-empty \`reason\` string.`);
		return {
			args: { reason },
			run: async () => {
				outcome = {
					type: "gave_up",
					reason
				};
				return {
					content: [{
						type: "text",
						text: "Acknowledged."
					}],
					details: {
						tool: GIVE_UP_TOOL_NAME,
						reason
					},
					terminate: true
				};
			},
			result: resultToolValue
		};
	});
	return {
		tools: [finishTool, giveUpTool],
		getOutcome: () => outcome
	};
}
function resultToolValue(value) {
	const details = value.details;
	if ("result" in details) return details.result;
	if ("reason" in details) return details.reason;
	return value.content.length === 1 && value.content[0]?.type === "text" ? value.content[0].text : value.content;
}
function needsEnvelope(schema) {
	return !isTopLevelObjectSchema(schema);
}
function formatIssuePath(path) {
	return path.map((key) => typeof key === "number" ? `[${key}]` : `.${String(key)}`).join("").replace(/^\./, "");
}
function alreadyDoneToolError(outcome) {
	return {
		content: [{
			type: "text",
			text: `${outcome.type === "finished" ? "A result was already submitted; the task is complete." : "The task was already given up; it cannot be resumed."} Do not call this tool again.`
		}],
		details: { alreadyDone: true }
	};
}
/**
* Thrown when the LLM calls the `give_up` tool, indicating it cannot produce a
* result that conforms to the required schema. Carries the LLM-supplied
* `reason` and the assistant transcript leading up to the give-up.
*/
var ResultUnavailableError = class extends Error {
	reason;
	assistantText;
	constructor(reason, assistantText) {
		super(`The agent gave up: ${reason}`);
		this.reason = reason;
		this.assistantText = assistantText;
		this.name = "ResultUnavailableError";
	}
};
//#endregion
//#region src/skill-package.ts
const directoryKey = Symbol.for("@flue/runtime/packaged-skill/v1");
const encoder = new TextEncoder();
function buildPackagedSkill(input) {
	const entries = [...input.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	const hashInput = [];
	const files = Object.create(null);
	for (const entry of entries) {
		const pathBytes = encoder.encode(entry.path);
		const content = new Uint8Array(entry.content);
		const lengths = new Uint8Array(8);
		const view = new DataView(lengths.buffer);
		view.setUint32(0, pathBytes.byteLength);
		view.setUint32(4, content.byteLength);
		hashInput.push(lengths, pathBytes, content);
		files[entry.path] = Object.freeze({
			encoding: "base64",
			kind: isTextContent(content) ? "text" : "binary",
			content: encodeBase64(content)
		});
	}
	return Object.freeze({
		id: `skill:${input.name}:${sha256Hex(concatBytes(hashInput)).slice(0, 16)}`,
		name: input.name,
		description: input.description,
		files: Object.freeze(files)
	});
}
function createSkillReference(directory) {
	const reference = {
		__flueSkillReference: true,
		id: directory.id,
		name: directory.name,
		description: directory.description
	};
	Object.defineProperty(reference, directoryKey, { value: directory });
	return Object.freeze(reference);
}
function getSkillReferenceDirectory(reference) {
	return reference[directoryKey];
}
function isTextContent(content) {
	if (content.includes(0)) return false;
	try {
		new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: false
		}).decode(content);
		return true;
	} catch {
		return false;
	}
}
function encodeBase64(bytes) {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
	return btoa(binary);
}
function concatBytes(parts) {
	const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}
function sha256Hex(input) {
	const constants = new Uint32Array([
		1116352408,
		1899447441,
		3049323471,
		3921009573,
		961987163,
		1508970993,
		2453635748,
		2870763221,
		3624381080,
		310598401,
		607225278,
		1426881987,
		1925078388,
		2162078206,
		2614888103,
		3248222580,
		3835390401,
		4022224774,
		264347078,
		604807628,
		770255983,
		1249150122,
		1555081692,
		1996064986,
		2554220882,
		2821834349,
		2952996808,
		3210313671,
		3336571891,
		3584528711,
		113926993,
		338241895,
		666307205,
		773529912,
		1294757372,
		1396182291,
		1695183700,
		1986661051,
		2177026350,
		2456956037,
		2730485921,
		2820302411,
		3259730800,
		3345764771,
		3516065817,
		3600352804,
		4094571909,
		275423344,
		430227734,
		506948616,
		659060556,
		883997877,
		958139571,
		1322822218,
		1537002063,
		1747873779,
		1955562222,
		2024104815,
		2227730452,
		2361852424,
		2428436474,
		2756734187,
		3204031479,
		3329325298
	]);
	const length = input.byteLength;
	const paddedLength = Math.ceil((length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(input);
	padded[length] = 128;
	const view = new DataView(padded.buffer);
	const bitLength = BigInt(length) * 8n;
	view.setUint32(paddedLength - 8, Number(bitLength >> 32n));
	view.setUint32(paddedLength - 4, Number(bitLength & 4294967295n));
	const state = new Uint32Array([
		1779033703,
		3144134277,
		1013904242,
		2773480762,
		1359893119,
		2600822924,
		528734635,
		1541459225
	]);
	const words = new Uint32Array(64);
	const word = (index) => words[index] ?? 0;
	const constant = (index) => constants[index] ?? 0;
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
		for (let index = 16; index < 64; index++) {
			const a = word(index - 15);
			const b = word(index - 2);
			const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ a >>> 3;
			const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ b >>> 10;
			words[index] = word(index - 16) + s0 + word(index - 7) + s1 >>> 0;
		}
		let a = state[0] ?? 0;
		let b = state[1] ?? 0;
		let c = state[2] ?? 0;
		let d = state[3] ?? 0;
		let e = state[4] ?? 0;
		let f = state[5] ?? 0;
		let g = state[6] ?? 0;
		let h = state[7] ?? 0;
		for (let index = 0; index < 64; index++) {
			const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = e & f ^ ~e & g;
			const temporary1 = h + sum1 + choice + constant(index) + word(index) >>> 0;
			const temporary2 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) + (a & b ^ a & c ^ b & c) >>> 0;
			h = g;
			g = f;
			f = e;
			e = d + temporary1 >>> 0;
			d = c;
			c = b;
			b = a;
			a = temporary1 + temporary2 >>> 0;
		}
		state[0] = wordFrom(state, 0) + a >>> 0;
		state[1] = wordFrom(state, 1) + b >>> 0;
		state[2] = wordFrom(state, 2) + c >>> 0;
		state[3] = wordFrom(state, 3) + d >>> 0;
		state[4] = wordFrom(state, 4) + e >>> 0;
		state[5] = wordFrom(state, 5) + f >>> 0;
		state[6] = wordFrom(state, 6) + g >>> 0;
		state[7] = wordFrom(state, 7) + h >>> 0;
	}
	return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}
function wordFrom(words, index) {
	return words[index] ?? 0;
}
function rotateRight(value, amount) {
	return value >>> amount | value << 32 - amount;
}
//#endregion
export { IMAGE_DATA_OMITTED as C, registerPreparedToolAdapter as S, redactObservationDetailImages as T, createPackagedSkillReadTool as _, GIVE_UP_TOOL_NAME as a, formatBashResult as b, buildPromptText as c, buildWorkspaceSkillPrompt as d, createResultTools as f, createActivateSkillTool as g, READ_SKILL_RESOURCE_TOOL_NAME as h, FINISH_TOOL_NAME as i, buildResultFollowUpPrompt as l, parseSkillMarkdown as m, createSkillReference as n, ResultUnavailableError as o, prepareResultTool as p, getSkillReferenceDirectory as r, buildPackagedSkillPrompt as s, buildPackagedSkill as t, buildSkillByPathlessNamePrompt as u, createTaskTool as v, redactEventImages as w, getPreparedToolAdapter as x, createTools as y };
