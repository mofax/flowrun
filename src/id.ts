/** Generate a UUIDv7 (time-ordered, RFC 9562). */
export function generateRunId(): string {
	const timestamp = Date.now();
	const bytes = new Uint8Array(16);

	bytes[0] = (timestamp / 2 ** 40) & 0xff;
	bytes[1] = (timestamp / 2 ** 32) & 0xff;
	bytes[2] = (timestamp / 2 ** 24) & 0xff;
	bytes[3] = (timestamp / 2 ** 16) & 0xff;
	bytes[4] = (timestamp / 2 ** 8) & 0xff;
	bytes[5] = timestamp & 0xff;

	const random = crypto.getRandomValues(new Uint8Array(10));
	bytes[6] = (random[0]! & 0x0f) | 0x70;
	bytes[7] = random[1]!;
	bytes[8] = (random[2]! & 0x3f) | 0x80;
	bytes[9] = random[3]!;
	bytes[10] = random[4]!;
	bytes[11] = random[5]!;
	bytes[12] = random[6]!;
	bytes[13] = random[7]!;
	bytes[14] = random[8]!;
	bytes[15] = random[9]!;

	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
