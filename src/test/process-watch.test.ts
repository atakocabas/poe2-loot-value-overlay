import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessWatcher, matchRunningProcess } from "../main/process-watch";

const NAMES = ["PathOfExileSteam.exe", "PathOfExile.exe", "PathOfExile_x64Steam.exe"];

/** `tasklist /NH /FO CSV` output shaped like a real listing, including unrelated processes. */
const FOUND = [
  '"svchost.exe","1234","Services","0","12,345 K"',
  '"Exiled Exchange 2.exe","26280","Console","7","163,984 K"',
  '"PathOfExileSteam.exe","29772","Console","7","11,039,616 K"'
].join("\r\n");

const NOT_FOUND = ['"svchost.exe","1234","Services","0","12,345 K"'].join("\r\n");

function watcherWithFixedOutputs(outputs: string[]): ProcessWatcher {
  let call = 0;
  const listProcesses = async () => outputs[Math.min(call++, outputs.length - 1)];
  return new ProcessWatcher(NAMES, listProcesses);
}

test("matches whichever candidate executable is actually running", () => {
  assert.equal(matchRunningProcess(FOUND, NAMES), "PathOfExileSteam.exe");
});

test("matching the image name is case-insensitive", () => {
  const csv = '"PATHOFEXILESTEAM.EXE","29772","Console","7","11,039,616 K"';
  assert.equal(matchRunningProcess(csv, NAMES), "PATHOFEXILESTEAM.EXE");
});

test("an unrelated process listing matches nothing", () => {
  assert.equal(matchRunningProcess(NOT_FOUND, NAMES), null);
});

test("the name is matched against the image-name column, not the whole row", () => {
  // A process whose memory column or window title merely contains the name must not count.
  const csv = '"notepad.exe","999","Console","1","PathOfExile.exe"';
  assert.equal(matchRunningProcess(csv, NAMES), null);
});

test("emits started once with the matched image name, even across repeated polls", async () => {
  const watcher = watcherWithFixedOutputs([NOT_FOUND, FOUND, FOUND, FOUND]);
  const started: string[] = [];
  watcher.on("started", (imageName) => started.push(imageName));

  await watcher.checkOnce(); // not found
  await watcher.checkOnce(); // found -> started
  await watcher.checkOnce(); // still found -> no duplicate
  await watcher.checkOnce(); // still found -> no duplicate

  assert.deepEqual(started, ["PathOfExileSteam.exe"]);
});

test("emits stopped once after the process disappears", async () => {
  const watcher = watcherWithFixedOutputs([FOUND, FOUND, NOT_FOUND, NOT_FOUND]);
  const events: string[] = [];
  watcher.on("started", () => events.push("started"));
  watcher.on("stopped", () => events.push("stopped"));

  await watcher.checkOnce(); // found -> started
  await watcher.checkOnce(); // still found -> nothing
  await watcher.checkOnce(); // gone -> stopped
  await watcher.checkOnce(); // still gone -> nothing

  assert.deepEqual(events, ["started", "stopped"]);
});

test("a failed process listing does not flip state or emit anything", async () => {
  const watcher = new ProcessWatcher(NAMES, async () => {
    throw new Error("tasklist unavailable");
  });
  const events: string[] = [];
  watcher.on("started", () => events.push("started"));
  watcher.on("stopped", () => events.push("stopped"));

  await watcher.checkOnce();
  await watcher.checkOnce();

  assert.deepEqual(events, []);
});
