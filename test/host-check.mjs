// Dev-time verification: drive the host plugin's apply() with a simulated
// cordis ctx (sessions store + webServer.register + on/effect), serve the
// route with a fake req/res over the REAL current session log, and assert the
// JSON response. Not shipped.
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { apply } from "../lib/index.js";

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
const frames = scanZstdFrames(src);
let out = Buffer.alloc(0);
for (const f of frames) out = Buffer.concat([out, zstdDecompressSync(src.subarray(f.start, f.end))]);
const lines = out.toString("utf8").split("\n").filter(Boolean);
const header = JSON.parse(lines[0]);
const events = lines.slice(1).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const sessionId = header.id;

const sessions = new Map();
const fakeSession = {
	id: sessionId,
	events: Object.freeze(events)
};
sessions.set(sessionId, fakeSession);

let route = null;
const unload = [];
const fakeCtx = {
	sessions: {
		list: () => [...sessions.values()],
		get: (id) => sessions.get(id)
	},
	// 对话框下方上下文占用显示的投影数据源（模拟 token-meter 注册的
	// contextPressure 单位），用于验证 context 块。
	get(name) {
		if (name === "sessionProjections") {
			return {
				snapshot(session) {
					if (session?.id !== sessionId) return { asOfSeq: -1, values: {} };
					return {
						asOfSeq: events.length - 1,
						values: {
							contextPressure: { pressureTokens: 950000, projectedTokens: 964000, contextWindow: 1000000 }
						}
					};
				}
			};
		}
		return undefined;
	},
	webServer: {
		register(reg) {
			route = reg;
			return () => { route = null; };
		}
	},
	on: () => () => {},
	logger: { info: () => {}, warn: (...a) => console.warn(...a) },
	effect(fn) {
		const disposer = fn();
		if (typeof disposer === "function") unload.push(disposer);
		return disposer;
	}
};

const config = {
	enabled: true,
	currency: "CNY",
	position: "top-right",
	pollMs: 1500,
	visible: true,
	prices: {
		default: {
			peak: { input: 3.0, cacheRead: 0.1, cacheWrite: 3.0, output: 9.0 },
			offpeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 }
		},
		"deepseek-v4-flash": {
			peak: { input: 3.0, cacheRead: 0.1, cacheWrite: 3.0, output: 9.0 },
			offpeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 }
		}
	}
};

apply(fakeCtx, config);
if (route === null) throw new Error("route not registered");
console.log("route:", route.kind, route.path);
if (route.kind !== "exact" || route.path !== "/api/token-usage/stats") throw new Error("bad route");

// serve the route like the webserver would
const req = {
	method: "GET",
	url: "/api/token-usage/stats?session=" + encodeURIComponent(sessionId),
	socket: { remoteAddress: "127.0.0.1" },
	headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" }
};
let status = 0, body = null;
const res = {
	writeHead(code) { status = code; },
	end(payload) { body = JSON.parse(payload); }
};
await route.handler(req, res);
console.log("status:", status);
console.log("exists:", body.exists, "hasUsage:", body.hasUsage, "steps:", body.steps);
console.log("totals:", JSON.stringify(body.totals));
console.log("cost:", body.cost, "currency:", body.currency);
console.log("models:", JSON.stringify(body.models));
console.log("estimatedTokens:", body.estimatedTokens);

if (status !== 200) throw new Error("bad status");
if (body.sessionId !== sessionId) throw new Error("bad session id echo");
if (!body.hasUsage || body.steps < 90) throw new Error("usage missing");
if (body.totals.total <= 0) throw new Error("empty totals");
if (body.cost <= 0) throw new Error("empty cost");
if (body.period !== "peak" && body.period !== "offpeak") throw new Error("period missing");
console.log("period:", body.period);

// context block: mirrors the composer's token display below the dialog box
if (body.context === null || typeof body.context !== "object") throw new Error("context missing");
console.log("context:", JSON.stringify(body.context));
if (body.context.usedTokens !== 964000) throw new Error("usedTokens wrong");
if (body.context.contextWindow !== 1000000) throw new Error("contextWindow wrong");
if (body.context.model !== "deepseek-v4-flash") throw new Error("context model wrong");
// expected: 964000 / 1e6 * input price of current period (peak=3.0, offpeak=1.5)
const period = body.context.period;
const expectedCost = Math.round(964000 / 1e6 * (period === "peak" ? 3.0 : 1.5) * 1e6) / 1e6;
if (Math.abs(body.context.cost - expectedCost) > 1e-6) throw new Error(`context cost mismatch: ${body.context.cost} vs ${expectedCost}`);

// unknown session
await route.handler({ method: "GET", url: "/api/token-usage/stats?session=nope", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" } }, res);
if (body.exists !== false) throw new Error("unknown session should report exists:false");

// non-loopback rejected
await route.handler({ method: "GET", url: "/api/token-usage/stats?session=" + sessionId, socket: { remoteAddress: "10.0.0.5" }, headers: { host: "evil.example" } }, res);
if (status !== 403) throw new Error("non-loopback should be 403");

// unload cleanly
for (const d of unload) d();
console.log("HOST APPLY OK");
