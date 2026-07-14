import { strict as assert } from "node:assert";
import test from "node:test";
import { runCliInstall, type CliInstallUiDeps } from "../src/menubar";

const adminCommand = "sudo printf '%s' 'shim' | sudo tee /usr/local/bin/sutra";

function deps(overrides: Partial<CliInstallUiDeps> = {}): CliInstallUiDeps {
  return {
    install: async () => ({ status: "requires_admin", command: adminCommand }),
    confirm: async () => false,
    copy: async () => {},
    notify: async () => {},
    ...overrides,
  };
}

test("administrator fallback is visible with Copy command and Close actions", async () => {
  let copied = "";
  let prompt = "";
  let options: Parameters<CliInstallUiDeps["confirm"]>[1] | undefined;
  const notifications: string[] = [];

  await runCliInstall(deps({
    confirm: async (message, nextOptions) => {
      prompt = message;
      options = nextOptions;
      return true;
    },
    copy: async (text) => { copied = text; },
    notify: async (message) => { notifications.push(message); },
  }));

  assert.match(prompt, /administrator permission/i);
  assert.match(prompt, new RegExp(adminCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(options?.okLabel, "Copy command");
  assert.equal(options?.cancelLabel, "Close");
  assert.equal(copied, adminCommand);
  assert.deepEqual(notifications, ["Command copied. Paste it into Terminal to install the Sutra CLI."]);
});

test("closing the administrator prompt does not write the clipboard", async () => {
  let copies = 0;
  await runCliInstall(deps({ copy: async () => { copies += 1; } }));
  assert.equal(copies, 0);
});

test("direct install and clipboard failure both produce visible outcomes", async () => {
  const installed: string[] = [];
  await runCliInstall(deps({
    install: async () => ({ status: "installed" }),
    notify: async (message) => { installed.push(message); },
  }));
  assert.deepEqual(installed, ["Sutra CLI installed. Run `sutra [path]` from a new terminal."]);

  const failed: string[] = [];
  await runCliInstall(deps({
    confirm: async () => true,
    copy: async () => { throw new Error("clipboard unavailable"); },
    notify: async (message) => { failed.push(message); },
  }));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /could not copy/i);
  assert.match(failed[0], new RegExp(adminCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("backend install failure produces a visible error", async () => {
  const notifications: string[] = [];
  await runCliInstall(deps({
    install: async () => { throw new Error("chmod denied"); },
    notify: async (message) => { notifications.push(message); },
  }));

  assert.deepEqual(notifications, ["Could not install the Sutra CLI: chmod denied"]);
});
