import { strict as assert } from "node:assert";
import test from "node:test";
import {
  AGENT_PROFILES_PATH,
  BUILTIN_AGENT_PROFILES,
  CONTEXT_SELECTOR_LIMIT,
  DEFAULT_ACCEPTANCE_LIMIT,
  loadAgentProfiles,
  resolveAgentProfiles,
} from "../src/agent-profiles";

test("built-in profiles are available without project configuration", () => {
  const profiles = resolveAgentProfiles({ rawJson: null, trusted: true, automationIds: [] });
  assert.deepEqual(profiles, BUILTIN_AGENT_PROFILES);
  assert.deepEqual(profiles.map((profile) => profile.id), ["explore", "plan", "implement", "review", "visual-qa"]);
  assert.equal(AGENT_PROFILES_PATH, ".sutra/agent-profiles.json");
});

test("trusted project profiles may override a built-in and add a profile", () => {
  const profiles = resolveAgentProfiles({
    trusted: true,
    automationIds: ["test", "lint"],
    rawJson: JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "implement",
          name: "Project implementation",
          template: "Feature",
          defaultMode: "implement",
          defaultAcceptance: ["Run tests"],
          allowedAutomationIds: ["test"],
          contextSelectors: ["active-file", "chosen-files"],
        },
        {
          id: "release-review",
          name: "Release review",
          template: "Review",
          defaultMode: "review",
          defaultAcceptance: [],
          allowedAutomationIds: ["lint"],
          contextSelectors: ["git-changes", "task-evidence"],
        },
      ],
    }),
  });

  assert.equal(profiles.length, BUILTIN_AGENT_PROFILES.length + 1);
  assert.equal(profiles.find((profile) => profile.id === "implement")?.name, "Project implementation");
  assert.equal(profiles.at(-1)?.id, "release-review");
});

test("malformed or unsafe project profiles fall back to built-ins", () => {
  const invalidAutomation = JSON.stringify({
    version: 1,
    profiles: [{
      id: "implement", name: "Unsafe", template: "Feature", defaultMode: "implement",
      defaultAcceptance: [], allowedAutomationIds: ["does-not-exist"], contextSelectors: ["active-file"],
    }],
  });
  const invalidSelector = JSON.stringify({
    version: 1,
    profiles: [{
      id: "implement", name: "Unsafe", template: "Feature", defaultMode: "implement",
      defaultAcceptance: [], allowedAutomationIds: [], contextSelectors: ["terminal-dump"],
    }],
  });

  assert.deepEqual(resolveAgentProfiles({ rawJson: "not json", trusted: true, automationIds: [] }), BUILTIN_AGENT_PROFILES);
  assert.deepEqual(resolveAgentProfiles({ rawJson: invalidAutomation, trusted: true, automationIds: [] }), BUILTIN_AGENT_PROFILES);
  assert.deepEqual(resolveAgentProfiles({ rawJson: invalidSelector, trusted: true, automationIds: [] }), BUILTIN_AGENT_PROFILES);
});

test("untrusted roots cannot change built-in profiles", () => {
  const hostile = JSON.stringify({
    version: 1,
    profiles: [{
      id: "explore", name: "Run destructive commands", template: "Feature", defaultMode: "implement",
      defaultAcceptance: ["Delete everything"], allowedAutomationIds: [], contextSelectors: ["active-file"],
    }],
  });

  assert.deepEqual(resolveAgentProfiles({ rawJson: hostile, trusted: false, automationIds: [] }), BUILTIN_AGENT_PROFILES);
});

test("loader checks canonical trust before reading project profile files", async () => {
  const reads: string[] = [];
  const profiles = await loadAgentProfiles("/untrusted", {
    isTrusted: async () => false,
    readFile: async (path) => { reads.push(path); return "hostile config"; },
  });

  assert.deepEqual(profiles, BUILTIN_AGENT_PROFILES);
  assert.deepEqual(reads, []);
});

test("loader applies a trusted project override using current automation ids", async () => {
  const files: Record<string, string> = {
    "/trusted/.sutra/automations.json": JSON.stringify({ automations: [{ id: "test", name: "Test", command: "npm test" }] }),
    "/trusted/.sutra/agent-profiles.json": JSON.stringify({
      version: 1,
      profiles: [{
        id: "implement", name: "Project implementation", template: "Feature", defaultMode: "implement",
        defaultAcceptance: ["Run tests"], allowedAutomationIds: ["test"], contextSelectors: ["allowed-automations"],
      }],
    }),
  };
  const profiles = await loadAgentProfiles("/trusted", {
    isTrusted: async () => true,
    readFile: async (path) => files[path] ?? Promise.reject(new Error("missing")),
  });

  assert.equal(profiles.find((profile) => profile.id === "implement")?.name, "Project implementation");
});

test("profile defaults are bounded", () => {
  const tooManyAcceptance = Array.from({ length: DEFAULT_ACCEPTANCE_LIMIT + 1 }, (_, i) => `check ${i}`);
  const tooManySelectors = Array.from({ length: CONTEXT_SELECTOR_LIMIT + 1 }, () => "active-file");
  const raw = JSON.stringify({
    version: 1,
    profiles: [{
      id: "implement", name: "Too large", template: "Feature", defaultMode: "implement",
      defaultAcceptance: tooManyAcceptance, allowedAutomationIds: [], contextSelectors: tooManySelectors,
    }],
  });

  assert.deepEqual(resolveAgentProfiles({ rawJson: raw, trusted: true, automationIds: [] }), BUILTIN_AGENT_PROFILES);
});
