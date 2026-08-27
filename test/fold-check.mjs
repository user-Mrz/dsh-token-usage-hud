// Dev-time verification: fold the CURRENT real session log through the plugin's
// pure accounting and print totals + cost under both flat and peak/off-peak
// pricing. Not shipped.
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { createFold, syncFold, finalizeFold, estimateSessionTokens, isPeakHour } from "../lib/index.js";

const ZSTD_MAGIC = 4247762216;
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) break;
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error("bad magic at " + offset);
		offset += 4;
		if (offset === buffer.length) break;
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error("reserved bit");
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) break;
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) break;
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error("reserved block type");
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) break;
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) offset += 4;
		frames.push({ start, end: offset });
	}
	return frames;
}

// --- isPeakHour unit checks (Beijing time) --------------------------------
// 2026-03-09 is a Monday (UTC+8). 10:00 Mon = peak; 13:00 Mon = off-peak;
// 15:00 Mon = peak; Saturday/Sunday = off-peak.
const cases = [
	["2026-03-09T02:00:00Z", true, "Mon 10:00 CST -> peak"],
	["2026-03-09T05:00:00Z", false, "Mon 13:00 CST -> off-peak"],
	["2026-03-09T07:00:00Z", true, "Mon 15:00 CST -> peak"],
	["2026-03-09T12:00:00Z", false, "Mon 20:00 CST -> off-peak"],
	["2026-03-14T02:00:00Z", false, "Sat 10:00 CST -> off-peak"],
	["2026-03-15T07:00:00Z", false, "Sun 15:00 CST -> off-peak"]
];
for (const [iso, expected, label] of cases) {
	const got = isPeakHour(new Date(iso));
	if (got !== expected) throw new Error(`isPeakHour ${label}: expected ${expected}, got ${got}`);
	console.log(`isPeakHour ok: ${label}`);
}

// --- fold over the real session log ----------------------------------------
const file = process.argv[2];
const src = readFileSync(file);
const frames = scanZstdFrames(src);
let out = Buffer.alloc(0);
for (const f of frames) out = Buffer.concat([out, zstdDecompressSync(src.subarray(f.start, f.end))]);
const lines = out.toString("utf8").split("\n").filter(Boolean);
const events = lines.slice(1).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log("events:", events.length);

const fold = createFold();
syncFold(fold, events);

// independent manual sum
let mInput = 0, mCacheRead = 0, mOutput = 0, mSteps = 0;
for (const e of events) {
	if (e.type === "assistant/message" && e.data?.usage) {
		mInput += e.data.usage.inputTokens ?? 0;
		mCacheRead += e.data.usage.cacheReadTokens ?? 0;
		mOutput += e.data.usage.outputTokens ?? 0;
		mSteps += 1;
	}
}
console.log("manual sum:", { mInput, mCacheRead, mOutput, mSteps });

// flat pricing (both periods equal)
const flatPrices = {
	default: { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 8 }
};
const flat = finalizeFold(fold, flatPrices, "CNY");
console.log("flat cost:", flat.cost, "steps:", flat.steps, "period:", flat.period);
let expectedFlat = (mInput / 1e6) * 2 + (mCacheRead / 1e6) * 0.5 + (mOutput / 1e6) * 8;
expectedFlat = Math.round(expectedFlat * 1e6) / 1e6;
if (Math.abs(flat.cost - expectedFlat) > 1e-6) throw new Error(`flat cost mismatch: ${flat.cost} vs ${expectedFlat}`);

// official dual-tier pricing, billed by the event's own time
const dualPrices = {
	default: {
		peak: { input: 3.0, cacheRead: 0.1, cacheWrite: 3.0, output: 9.0 },
		offpeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 }
	}
};
const dual = finalizeFold(fold, dualPrices, "CNY");
console.log("dual cost:", dual.cost, "period:", dual.period);
let expectedDual = 0;
let peakSteps = 0, offpeakSteps = 0;
for (const e of events) {
	if (e.type !== "assistant/message" || !e.data?.usage) continue;
	const usage = e.data.usage;
	const period = isPeakHour(new Date(e.time ?? Date.now())) ? "peak" : "offpeak";
	const price = dualPrices.default[period];
	const stepCost = (usage.inputTokens ?? 0) / 1e6 * price.input
		+ (usage.cacheReadTokens ?? 0) / 1e6 * price.cacheRead
		+ (usage.cacheWriteTokens ?? 0) / 1e6 * price.cacheWrite
		+ (usage.outputTokens ?? 0) / 1e6 * price.output;
	expectedDual += stepCost;
	if (period === "peak") peakSteps += 1; else offpeakSteps += 1;
}
expectedDual = Math.round(expectedDual * 1e6) / 1e6;
if (Math.abs(dual.cost - expectedDual) > 1e-6) throw new Error(`dual cost mismatch: ${dual.cost} vs ${expectedDual}`);
console.log("billing split: peak steps", peakSteps, "offpeak steps", offpeakSteps);

// totals consistency
const ok = dual.totals.input === mInput && dual.totals.cacheRead === mCacheRead && dual.totals.output === mOutput && dual.steps === mSteps;
console.log("totals consistent:", ok);
if (!ok) process.exit(1);

console.log("FOLD CHECK OK");
