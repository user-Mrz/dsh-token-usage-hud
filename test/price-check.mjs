// Verify the SHIPPED price table (cordis.patch.yml) against the current real
// session, and compare with the previous (pre-update) official prices.
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFold, syncFold, finalizeFold, isPeakHour } from "../lib/index.js";

// js-yaml resolves from this repo first, then from the local DSH profile
// (path derived at runtime — never hardcoded, so the file stays portable).
function loadYaml() {
	const require = createRequire(import.meta.url);
	try {
		return require("js-yaml");
	} catch {
		const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
		return createRequire(join(dshHome, "profiles", "web", "package.json"))("js-yaml");
	}
}
const yaml = loadYaml();

// --- read the shipped config ----------------------------------------------
const patchFile = new URL("../cordis.patch.yml", import.meta.url);
const doc = yaml.load(readFileSync(patchFile, "utf8"));
const row = doc.find((entry) => entry?.insert?.some((r) => r.id === "dsh-token-usage-hud"));
const config = row.insert.find((r) => r.id === "dsh-token-usage-hud").config;
console.log("shipped balance config:", JSON.stringify(config.balance));
console.log("shipped offpeakDates:", JSON.stringify(config.offpeakDates));
console.log("shipped price models:", Object.keys(config.prices).join(", "));
console.log("shipped deepseek-v4-flash:", JSON.stringify(config.prices["deepseek-v4-flash"]));
console.log("shipped deepseek-flash:", JSON.stringify(config.prices["deepseek-flash"]));

// --- previous (pre-update) prices for comparison --------------------------
const oldPrices = {
	default: { peak: { input: 3.0, cacheRead: 0.1, cacheWrite: 3.0, output: 9.0 }, offpeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 } },
	"deepseek-v4-flash": { peak: { input: 3.0, cacheRead: 0.1, cacheWrite: 3.0, output: 9.0 }, offpeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 } }
};

// --- decode the real session ----------------------------------------------
const ZSTD_MAGIC = 4247762216;
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) break;
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error("bad magic");
		offset += 4;
		if (offset === buffer.length) break;
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error("reserved");
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
			if (blockType === 3) throw new Error("bad block");
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

const file = process.argv[2];
const src = readFileSync(file);
let out = Buffer.alloc(0);
for (const f of scanZstdFrames(src)) out = Buffer.concat([out, zstdDecompressSync(src.subarray(f.start, f.end))]);
const lines = out.toString("utf8").split("\n").filter(Boolean);
const events = lines.slice(1).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const fold = createFold(config.offpeakDates ?? []);
syncFold(fold, events);

const now = finalizeFold(fold, config.prices, config.currency);
const before = finalizeFold(fold, oldPrices, config.currency);
console.log("\n当前会话:", now.steps, "步, 总 tokens", now.totals.total.toLocaleString());
console.log("模型归账:", now.models.map((m) => `${m.model}(${m.steps}步)`).join(", "));
console.log("period:", now.period);
console.log("新价费用: ¥" + now.cost + "   (旧价: ¥" + before.cost + ")");
console.log("降幅:", Math.round((1 - now.cost / before.cost) * 100) + "%");

// per-model period split sanity
const peakSteps = events.filter((e) => e.type === "assistant/message" && e.data?.usage && isPeakHour(new Date(e.time), config.offpeakDates)).length;
console.log("高峰步数:", peakSteps, "空闲步数:", (now.steps ?? 0) - peakSteps);
