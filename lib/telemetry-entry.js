// src/host/telemetry/product-telemetry.ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve as resolve2 } from "node:path";

// src/host/dsh-home.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
function resolveDshHome(env = process.env, homeDir = homedir()) {
  const configured = env.DSH_HOME?.trim();
  if (configured === void 0 || configured.length === 0) return join(homeDir, ".dsh");
  if (configured === "~") return homeDir;
  if (configured.startsWith("~/")) return join(homeDir, configured.slice(2));
  return resolve(configured);
}

// src/host/telemetry/product-telemetry.ts
var TELEMETRY_STATE_VERSION = 1;
var TELEMETRY_TIMEOUT_MS = 5e3;
function resolveTelemetryStatePath(input = {}) {
  const env = input.env ?? process.env;
  return resolve2(resolveDshHome(env, input.homeDir), "telemetry", "dsh-univer-office", "state.json");
}
function telemetryEndpointFor(input) {
  const env = input.env ?? process.env;
  const override = env.UNIVER_TELEMETRY_ENDPOINT;
  if (override !== void 0) {
    const trimmed = override.trim();
    return trimmed.length === 0 ? "" : trimmed;
  }
  const fromBuildInfo = input.buildInfo.telemetryEndpoint?.trim();
  return fromBuildInfo === void 0 || fromBuildInfo.length === 0 ? "" : fromBuildInfo;
}
function readBundledBuildInfo() {
  try {
    const value = JSON.parse(
      readFileSync(new URL("build-info.json", import.meta.url), "utf8")
    );
    if (!isRecord(value)) return {};
    return {
      ...typeof value.telemetryEndpoint === "string" && value.telemetryEndpoint.length > 0 ? { telemetryEndpoint: value.telemetryEndpoint } : {},
      ...typeof value.commit === "string" ? { commit: value.commit } : {},
      ...typeof value.version === "string" ? { version: value.version } : {}
    };
  } catch {
    return {};
  }
}
async function captureTelemetry(input) {
  const env = input.env ?? process.env;
  if (isDoNotTrack(env)) return { reason: "do-not-track", status: "skipped" };
  if (input.endpoint.length === 0) return { reason: "missing-endpoint", status: "skipped" };
  const now = input.now ?? /* @__PURE__ */ new Date();
  const statePath = input.statePath ?? resolveTelemetryStatePath({ env });
  const state = await readOrCreateTelemetryState({
    path: statePath,
    ...input.randomId === void 0 ? {} : { randomId: input.randomId },
    ...input.stateIo === void 0 ? {} : { stateIo: input.stateIo }
  });
  if (state.disabled === true) return { reason: "disabled", status: "skipped" };
  const next = markTelemetryEvent({ event: input.event, now, state });
  if (next === void 0) return { reason: alreadyReason(input.event), status: "skipped" };
  const persisted = await writeTelemetryState({
    path: statePath,
    state: next,
    ...input.stateIo === void 0 ? {} : { stateIo: input.stateIo }
  });
  if (!persisted) return { reason: "state-unavailable", status: "skipped" };
  const nodeMajor = readNodeMajorVersion(process.versions.node);
  const capture = {
    distinctId: next.anonymousInstallId,
    event: input.event,
    properties: {
      arch: process.arch,
      build_commit: input.buildInfo.commit ?? "",
      event_source: input.source,
      // The proxy rejects unknown or non-scalar values wholesale, so an
      // unavailable version is omitted instead of sent as a placeholder.
      ...nodeMajor === void 0 ? {} : { node_major_version: nodeMajor },
      package_name: "dsh-univer-office",
      package_version: input.buildInfo.version ?? "",
      platform: process.platform,
      telemetry_state_version: TELEMETRY_STATE_VERSION
    }
  };
  try {
    const send = input.transport ?? fetchTelemetryTransport;
    await send({ body: capture, endpoint: input.endpoint });
    return { status: "captured" };
  } catch {
    return { reason: "capture-failed", status: "skipped" };
  }
}
var fetchTelemetryTransport = async ({ body, endpoint }) => {
  const response = await fetch(endpoint, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`telemetry proxy responded with status ${response.status}`);
};
function markTelemetryEvent(input) {
  const { event: event2, now, state } = input;
  if (event2 === "dsh_plugin_uninstall_hook") return state;
  if (event2 === "dsh_plugin_daily_active") {
    const date = localDate(now);
    if (state.dailyActiveSentDate === date) return void 0;
    return { ...state, dailyActiveSentDate: date, version: TELEMETRY_STATE_VERSION };
  }
  if (event2 === "dsh_plugin_activated" && state.activatedAttemptedAt !== void 0) return void 0;
  return {
    ...state,
    activatedAttemptedAt: now.toISOString(),
    version: TELEMETRY_STATE_VERSION
  };
}
function alreadyReason(event2) {
  return event2 === "dsh_plugin_daily_active" ? "already-sent-today" : "already-attempted";
}
function parseTelemetryState(json) {
  const value = JSON.parse(json);
  if (!isRecord(value) || value.version !== TELEMETRY_STATE_VERSION) {
    throw new Error("Invalid telemetry state version.");
  }
  if (typeof value.anonymousInstallId !== "string" || value.anonymousInstallId.length === 0) {
    throw new Error("Invalid telemetry anonymous install id.");
  }
  const activatedAttemptedAt = readTimestamp(value.activatedAttemptedAt);
  const dailyActiveSentDate = typeof value.dailyActiveSentDate === "string" && value.dailyActiveSentDate.length > 0 ? value.dailyActiveSentDate : void 0;
  return {
    anonymousInstallId: value.anonymousInstallId,
    ...activatedAttemptedAt === void 0 ? {} : { activatedAttemptedAt },
    ...value.disabled === true ? { disabled: true } : {},
    ...dailyActiveSentDate === void 0 ? {} : { dailyActiveSentDate },
    version: TELEMETRY_STATE_VERSION
  };
}
function serializeTelemetryState(state) {
  return `${JSON.stringify(state, null, 2)}
`;
}
async function readOrCreateTelemetryState(input) {
  const read = input.stateIo?.readFile ?? readFile;
  try {
    return parseTelemetryState(await read(input.path, "utf8"));
  } catch {
    return {
      anonymousInstallId: input.randomId?.() ?? randomUUID(),
      version: TELEMETRY_STATE_VERSION
    };
  }
}
async function writeTelemetryState(input) {
  const write = input.stateIo?.writeFile ?? writeFile;
  const move = input.stateIo?.rename ?? rename;
  const makeDir = input.stateIo?.mkdir ?? mkdir;
  const tempPath = `${input.path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await makeDir(dirname(input.path), { mode: 448, recursive: true });
    await write(tempPath, serializeTelemetryState(input.state), { encoding: "utf8", mode: 384 });
    await move(tempPath, input.path);
    return true;
  } catch {
    return false;
  }
}
function isDoNotTrack(env) {
  const value = env.DO_NOT_TRACK?.trim();
  return value !== void 0 && value.length > 0;
}
function localDate(now) {
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
function readTimestamp(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function readNodeMajorVersion(version) {
  const major = Number(version.split(".")[0]);
  return Number.isSafeInteger(major) && major > 0 ? major : void 0;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

// src/host/telemetry/entry.ts
var event = process.argv[3];
if (process.argv[2] === "capture" && event === "dsh_plugin_uninstall_hook") {
  try {
    const buildInfo = readBundledBuildInfo();
    await captureTelemetry({
      buildInfo,
      endpoint: telemetryEndpointFor({ buildInfo }),
      event,
      source: "uninstall-hook"
    });
  } catch {
  }
}
