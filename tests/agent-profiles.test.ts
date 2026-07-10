import { strict as assert } from "node:assert";
import test from "node:test";
import {
  AGENT_PROFILES_PATH,
  AUTOMATION_ID_LIMIT,
  BUILTIN_AGENT_PROFILES,
  CONTEXT_PACK_BYTE_CAP,
  CONTEXT_PACK_ITEM_CAP,
  CONTEXT_SELECTOR_LIMIT,
  DEFAULT_ACCEPTANCE_LIMIT,
  PROFILE_LIMIT,
  assembleContextPack,
  contextPackItemsFromChips,
  loadAgentProfiles,
  renderContextPackSummary,
  resolveAgentProfiles,
  summarizeContextPackFromChips,
  type ContextPackItem,
} from "../src/agent-profiles";
import type { RoutedChip } from "../src/prompt-builder";

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

test("profile count over PROFILE_LIMIT falls back to built-ins", () => {
  const tooManyProfiles = Array.from({ length: PROFILE_LIMIT + 1 }, (_, i) => ({
    id: `custom-${i}`, name: `Custom ${i}`, template: "Feature", defaultMode: "implement",
    defaultAcceptance: [], allowedAutomationIds: [], contextSelectors: ["active-file"],
  }));
  const raw = JSON.stringify({ version: 1, profiles: tooManyProfiles });

  assert.deepEqual(resolveAgentProfiles({ rawJson: raw, trusted: true, automationIds: [] }), BUILTIN_AGENT_PROFILES);
});

test("allowedAutomationIds over AUTOMATION_ID_LIMIT falls back to built-ins", () => {
  const tooManyAutomationIds = Array.from({ length: AUTOMATION_ID_LIMIT + 1 }, (_, i) => `automation-${i}`);
  const raw = JSON.stringify({
    version: 1,
    profiles: [{
      id: "implement", name: "Too many automations", template: "Feature", defaultMode: "implement",
      defaultAcceptance: [], allowedAutomationIds: tooManyAutomationIds, contextSelectors: ["active-file"],
    }],
  });

  assert.deepEqual(
    resolveAgentProfiles({ rawJson: raw, trusted: true, automationIds: tooManyAutomationIds }),
    BUILTIN_AGENT_PROFILES,
  );
});

// ── P3: bounded context-pack preview + task receipt ─────────────────────────

test("assembleContextPack caps by item count deterministically", () => {
  const items: ContextPackItem[] = Array.from({ length: CONTEXT_PACK_ITEM_CAP + 5 }, (_, i) => ({
    id: `item-${i}`, selector: "chosen-files", label: `@file${i}.ts`, content: "x",
  }));
  const first = assembleContextPack(items);
  const second = assembleContextPack(items);
  assert.deepEqual(first, second);
  assert.equal(first.includedIds.length, CONTEXT_PACK_ITEM_CAP);
  assert.equal(first.omittedIds.length, 5);
  assert.deepEqual(first.includedIds, items.slice(0, CONTEXT_PACK_ITEM_CAP).map((i) => i.id));
});

test("assembleContextPack caps by byte budget deterministically, exact fill allowed", () => {
  const big = "x".repeat(CONTEXT_PACK_BYTE_CAP); // fills the whole budget alone
  const items: ContextPackItem[] = [
    { id: "a", selector: "selection", label: "@a", content: big },
    { id: "b", selector: "selection", label: "@b", content: "y" }, // pushes over cap
  ];
  const pack = assembleContextPack(items);
  assert.deepEqual(pack.includedIds, ["a"]);
  assert.deepEqual(pack.omittedIds, ["b"]);
  assert.equal(pack.includedBytes, CONTEXT_PACK_BYTE_CAP);
  assert.deepEqual(assembleContextPack(items), pack); // determinism
});

test("renderContextPackSummary never leaks raw content — labels only", () => {
  const items: ContextPackItem[] = [
    { id: "a", selector: "chosen-files", label: "@secrets.env", content: "API_KEY=sk-abcdef123456\nterminal output dump" },
  ];
  const pack = assembleContextPack(items);
  const summary = renderContextPackSummary(items, pack);
  assert.ok(!summary.includes("sk-abcdef123456"));
  assert.ok(!summary.includes("terminal output dump"));
  assert.ok(summary.includes("@secrets.env"));
});

test("contextPackItemsFromChips only includes explicit context-routed file/selection chips", () => {
  const chips: RoutedChip[] = [
    { chip: { kind: "file", path: "src/a.ts" }, section: "context" },
    { chip: { kind: "selection", path: "src/b.ts", lang: "ts", startLine: 1, endLine: 5, text: "const x = 1;" }, section: "context" },
    { chip: { kind: "file", path: "src/c.ts" }, section: "task" }, // routed away from context — excluded
    { chip: { kind: "skill", invocation: "/foo" }, section: "context" }, // no selector identity — excluded
  ];
  const items = contextPackItemsFromChips(chips);
  assert.deepEqual(items.map((i) => i.label), ["@src/a.ts", "@src/b.ts:1-5"]);
  assert.deepEqual(items.map((i) => i.selector), ["chosen-files", "selection"]);
});

test("summarizeContextPackFromChips is deterministic and empty when nothing is attached", () => {
  assert.equal(summarizeContextPackFromChips([]), "");
  const chips: RoutedChip[] = [{ chip: { kind: "file", path: "src/a.ts" }, section: "context" }];
  const first = summarizeContextPackFromChips(chips);
  const second = summarizeContextPackFromChips(chips);
  assert.equal(first, second);
  assert.ok(first.includes("1 included, 0 omitted"));
});
