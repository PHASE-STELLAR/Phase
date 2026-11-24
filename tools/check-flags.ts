/**
 * CI guard against duplicate / ambiguous flag IDs.
 *
 * Run with: npm run flags:check
 * Exits non-zero on any violation so CI fails the build.
 */
import {
  FLAG_DEFINITIONS,
  FLAG_ENV_MAP,
  FLAG_ENV_PREFIX,
  FLAG_SNAPSHOT,
  isTruthyFlagValue,
  resolveFlagId,
} from "../lib/flags/registry.ts";

const problems: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) problems.push(message);
}

const seenIds = new Set<string>();
const seenEnvVars = new Set<string>();
const seenAliases = new Set<string>();

for (const definition of FLAG_DEFINITIONS) {
  check(seenIds.has(definition.id) === false, `duplicate flag id: ${definition.id}`);
  seenIds.add(definition.id);

  check(
    seenEnvVars.has(definition.envVar) === false,
    `duplicate env var: ${definition.envVar}`,
  );
  seenEnvVars.add(definition.envVar);

  check(
    definition.envVar.startsWith(FLAG_ENV_PREFIX),
    `env var ${definition.envVar} must start with ${FLAG_ENV_PREFIX}`,
  );
  check(
    /^[A-Z][A-Z0-9_]*$/.test(definition.envVar.slice(FLAG_ENV_PREFIX.length)),
    `env var ${definition.envVar} has an invalid suffix`,
  );

  check(definition.feature.length > 0, `flag ${definition.id} has no feature description`);
  check(definition.rollback.length > 0, `flag ${definition.id} has no rollback row`);
  check(
    definition.aliases.length > 0,
    `flag ${definition.id} has no rollback alias`,
  );

  for (const alias of definition.aliases) {
    check(seenAliases.has(alias) === false, `duplicate flag alias: ${alias}`);
    seenAliases.add(alias);
    check(
      seenIds.has(alias) === false,
      `alias ${alias} collides with a canonical flag id`,
    );
    const entry = FLAG_ENV_MAP[alias];
    check(entry !== undefined, `alias ${alias} missing from FLAG_ENV_MAP`);
    check(entry?.id === definition.id, `alias ${alias} resolves to the wrong flag`);
    check(entry?.envVar === definition.envVar, `alias ${alias} has the wrong env var`);
    check(entry?.canonical === false, `alias ${alias} must not be canonical`);
  }

  const canonical = FLAG_ENV_MAP[definition.id];
  check(canonical !== undefined, `flag ${definition.id} missing from FLAG_ENV_MAP`);
  check(canonical?.canonical === true, `flag ${definition.id} must be canonical`);
  check(canonical?.envVar === definition.envVar, `flag ${definition.id} env var mismatch`);
  check(resolveFlagId(definition.id) === definition.id, `flag ${definition.id} does not self-resolve`);
  check(
    typeof FLAG_SNAPSHOT[definition.id] === "boolean",
    `flag ${definition.id} missing from static snapshot`,
  );
}

check(isTruthyFlagValue("1") && isTruthyFlagValue("TRUE"), "truthy parsing is broken");
check(
  isTruthyFlagValue("0") === false && isTruthyFlagValue(undefined) === false,
  "falsy parsing is broken",
);

if (problems.length > 0) {
  console.error(`FLAG INTEGRITY CHECK FAILED (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `FLAG INTEGRITY OK: ${FLAG_DEFINITIONS.length} unique ids, ` +
    `${seenEnvVars.size} unique env vars, ${seenAliases.size} rollback aliases.`,
);
