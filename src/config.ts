import { defaultDeserializeError, defaultSerializeError, type SerializedError } from "./errors.ts";
import type { FlowrunConfig } from "./types.ts";

let serializeError: (err: unknown) => SerializedError = defaultSerializeError;
let deserializeError: (e: SerializedError) => unknown = defaultDeserializeError;

export function configure(options: FlowrunConfig): void {
	if (options.serializeError) {
		serializeError = options.serializeError;
	}
	if (options.deserializeError) {
		deserializeError = options.deserializeError;
	}
}

export function resetConfig(): void {
	serializeError = defaultSerializeError;
	deserializeError = defaultDeserializeError;
}

export function getSerializeError(): (err: unknown) => SerializedError {
	return serializeError;
}

export function getDeserializeError(): (e: SerializedError) => unknown {
	return deserializeError;
}
