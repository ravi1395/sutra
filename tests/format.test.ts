import { test } from "node:test";
import assert from "node:assert/strict";
import { formatContent } from "../src/format.ts";
import { isFormattableExt } from "../src/format-ext.ts";

test("isFormattableExt matches the six beautify-on-save types", () => {
  assert.equal(isFormattableExt("json"), true);
  assert.equal(isFormattableExt("yaml"), true);
  assert.equal(isFormattableExt("yml"), true);
  assert.equal(isFormattableExt("xml"), true);
  assert.equal(isFormattableExt("html"), true);
  assert.equal(isFormattableExt("htm"), true);
  assert.equal(isFormattableExt("toml"), true);
  assert.equal(isFormattableExt("rs"), false);
  assert.equal(isFormattableExt("md"), false);
});

test("formatContent formats valid json", async () => {
  const result = await formatContent("json", '{"b":2,"a":1}');
  assert.equal(result, '{ "b": 2, "a": 1 }\n');
});

test("formatContent returns null for invalid json", async () => {
  const result = await formatContent("json", "{not valid json");
  assert.equal(result, null);
});

test("formatContent formats valid yaml", async () => {
  const result = await formatContent("yaml", "a:   1\nb:   2\n");
  assert.ok(result !== null);
  assert.equal(result, "a: 1\nb: 2\n");
});

test("formatContent returns null for invalid yaml", async () => {
  const result = await formatContent("yaml", "a: [1, 2\n  b: broken");
  assert.equal(result, null);
});

test("formatContent formats valid html", async () => {
  const result = await formatContent("html", "<div><p>hi</p></div>");
  assert.ok(result !== null);
  assert.ok(result!.includes("<div>"));
});

test("formatContent formats valid xml", async () => {
  const result = await formatContent("xml", "<a><b>1</b></a>");
  assert.ok(result !== null);
  assert.ok(result!.includes("<a>"));
});

test("formatContent returns null for invalid xml", async () => {
  const result = await formatContent("xml", "<a><b>1</a>");
  assert.equal(result, null);
});

test("formatContent formats valid toml", async () => {
  const result = await formatContent("toml", 'a="1"\nb  =  2\n');
  assert.ok(result !== null);
  assert.ok(result!.includes("a"));
});

test("formatContent returns null for invalid toml", async () => {
  const result = await formatContent("toml", "a = = broken");
  assert.equal(result, null);
});

test("formatContent returns null for unsupported extension", async () => {
  const result = await formatContent("rs", "fn main() {}");
  assert.equal(result, null);
});
