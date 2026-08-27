// Dev-time verification: evaluate the client bundle under the __ModuleLoader__
// contract (no DOM), confirm the factory registers and exports apply+inject.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
let registration = null;
let timerId = 0;
const sandbox = {
	window: {},
	console,
	Symbol,
	Object,
	document: undefined,
	setInterval: () => { timerId += 1; return timerId; },
	clearInterval: () => {},
	__ModuleLoader__: {
		load(reg) {
			registration = reg;
		}
	}
};
sandbox.window.__ModuleLoader__ = sandbox.__ModuleLoader__;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

if (registration === null) throw new Error("no registration");
console.log("registered id:", registration.id);
if (registration.id !== "dsh-token-usage-hud") throw new Error("bad id");

const exportsObj = registration.factory((spec) => {
	throw new Error("unexpected require: " + spec);
});
console.log("exports:", Object.keys(exportsObj));
if (typeof exportsObj.apply !== "function") throw new Error("apply missing");
if (!Array.isArray(exportsObj.inject) || !exportsObj.inject.includes("sessions")) throw new Error("inject missing sessions");
console.log("inject:", exportsObj.inject);

// apply must not throw with a minimal guarded-ish ctx (no DOM). The disposer
// is registered through ctx.effect (cordis semantics), not returned by apply.
let effectRan = false;
let disposer = null;
const fakeCtx = {
	effect(fn, label) {
		effectRan = true;
		disposer = fn();
		return disposer;
	},
	get(name) {
		if (name === "sessions") return undefined;
		return undefined;
	}
};
exportsObj.apply(fakeCtx, { position: "top-right", pollMs: 1000, visible: true });
console.log("apply ok, effectRan:", effectRan, "disposer:", typeof disposer, "timerId:", timerId);
if (typeof disposer !== "function") throw new Error("disposer expected");
disposer();
console.log("CLIENT BUNDLE OK");
