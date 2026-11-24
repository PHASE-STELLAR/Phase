import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFlagFromEnv,
  flagEnvVar,
  FLAG_DEFINITIONS,
  FLAG_ENV_MAP,
  FLAG_SNAPSHOT,
  getFlagSnapshot,
  isTruthyFlagValue,
  resolveFlagId,
} from "../lib/flags/registry.ts";

test("canonical IDs and rollback aliases resolve to one feature", () => {
  assert.equal(resolveFlagId("phase-170"), "phase-170");
  assert.equal(resolveFlagId("phase-170:albedo-sunset"), "phase-180");
  assert.equal(resolveFlagId("phase-173:wallet-history"), "phase-183");
  assert.equal(resolveFlagId("phase-sep50-adapter"), "phase-217");
  assert.equal(resolveFlagId("does-not-exist"), null);
  assert.equal(flagEnvVar("phase-170:albedo-sunset"), "PHASE_FLAG_ALBEDO_SUNSET");
});

test("IDs, env vars and aliases are globally unique", () => {
  const ids = FLAG_DEFINITIONS.map((definition) => definition.id);
  const envVars = FLAG_DEFINITIONS.map((definition) => definition.envVar);
  const aliases = FLAG_DEFINITIONS.flatMap((definition) => [...definition.aliases]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(envVars).size, envVars.length);
  assert.equal(new Set(aliases).size, aliases.length);
  assert.equal(Object.keys(FLAG_ENV_MAP).length, ids.length + aliases.length);
});

test("env parsing is explicit and static snapshot is frozen", () => {
  assert.equal(isTruthyFlagValue("1"), true);
  assert.equal(isTruthyFlagValue(" TRUE "), true);
  assert.equal(isTruthyFlagValue("on"), true);
  assert.equal(isTruthyFlagValue("0"), false);
  assert.equal(isTruthyFlagValue(undefined), false);
  assert.equal(Object.isFrozen(FLAG_SNAPSHOT), true);
  assert.equal(getFlagSnapshot(), FLAG_SNAPSHOT);
});

test("flag off is decided by injected env, not by runtime mutation", () => {
  const offEnv = { PHASE_FLAG_SEP50_ADAPTER: "0" };
  const onEnv = { PHASE_FLAG_SEP50_ADAPTER: "1" };
  assert.equal(evaluateFlagFromEnv("phase-217", offEnv), false);
  assert.equal(evaluateFlagFromEnv("phase-sep50-adapter", onEnv), true);
  assert.equal(evaluateFlagFromEnv("phase-218", onEnv), false);

  const before = FLAG_SNAPSHOT["phase-217"];
  process.env.PHASE_FLAG_SEP50_ADAPTER = "1";
  assert.equal(FLAG_SNAPSHOT["phase-217"], before);
  delete process.env.PHASE_FLAG_SEP50_ADAPTER;
});
