import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { generateRunId } from "../src/id.ts";

// `generateRunId` hand-packs a UUIDv7 (RFC 9562): a 48-bit big-endian
// millisecond timestamp followed by version/variant-tagged randomness. The
// fiddly byte arithmetic is exactly where a bug would hide, and the only prior
// coverage asserted that two ids differ. These tests pin the textual layout,
// the RFC-mandated bits, and — the entire reason for choosing v7 — the
// time-orderability of the timestamp prefix.

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Decode the leading 48 bits (first 6 bytes) as the embedded ms timestamp. */
function decodeTimestamp(id: string): number {
	const hex = id.replace(/-/g, "").slice(0, 12);
	return Number.parseInt(hex, 16);
}

describe("generateRunId", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("matches the canonical UUIDv7 string layout", () => {
		for (let i = 0; i < 100; i++) {
			expect(generateRunId()).toMatch(UUID_V7);
		}
	});

	test("sets the version nibble to 7", () => {
		// The 13th hex digit (group 3, first char) is the version.
		const id = generateRunId();
		expect(id.replace(/-/g, "")[12]).toBe("7");
	});

	test("sets the RFC 9562 variant bits (10xx -> 8/9/a/b)", () => {
		for (let i = 0; i < 100; i++) {
			// The 17th hex digit (group 4, first char) is the variant.
			const variant = generateRunId().replace(/-/g, "")[16]!;
			expect("89ab").toContain(variant);
		}
	});

	test("embeds the current wall-clock millisecond timestamp big-endian", () => {
		const fixed = 0x0192_3c4d_5e6f; // arbitrary 48-bit value
		vi.spyOn(Date, "now").mockReturnValue(fixed);
		expect(decodeTimestamp(generateRunId())).toBe(fixed);
	});

	test("encodes timestamp 0 as a zero prefix while keeping version/variant", () => {
		vi.spyOn(Date, "now").mockReturnValue(0);
		const id = generateRunId();
		expect(id.startsWith("00000000-0000-7")).toBe(true);
		expect(id).toMatch(UUID_V7);
	});

	test("is time-orderable: chronological order implies lexicographic order", () => {
		let clock = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);

		const ids: string[] = [];
		for (let i = 0; i < 50; i++) {
			ids.push(generateRunId());
			clock += 1; // strictly increasing wall clock
		}

		const sorted = [...ids].sort();
		expect(sorted).toEqual(ids);
	});

	test("produces unique ids within a single millisecond (random tail)", () => {
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			ids.add(generateRunId());
		}
		expect(ids.size).toBe(1000);
	});
});
