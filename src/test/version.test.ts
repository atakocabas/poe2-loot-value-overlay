import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isNewerVersion } from "../shared/version";

describe("isNewerVersion", () => {
  test("the same version is not newer", () => {
    assert.equal(isNewerVersion("0.2.0", "0.2.0"), false);
  });

  test("a higher patch, minor or major is newer", () => {
    assert.equal(isNewerVersion("0.2.1", "0.2.0"), true);
    assert.equal(isNewerVersion("0.3.0", "0.2.9"), true);
    assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  });

  test("a lower version is not newer", () => {
    assert.equal(isNewerVersion("0.1.9", "0.2.0"), false);
    assert.equal(isNewerVersion("0.2.0", "1.0.0"), false);
  });

  test("segments compare numerically, not as text", () => {
    // The bug this guards: "0.10.0" < "0.9.0" under a string comparison.
    assert.equal(isNewerVersion("0.10.0", "0.9.0"), true);
    assert.equal(isNewerVersion("0.9.0", "0.10.0"), false);
  });

  // The two sides are spelled differently by construction: the release workflow tags `v0.2.0`
  // while `app.getVersion()` returns `0.2.0`.
  test("a leading v is tolerated on either side", () => {
    assert.equal(isNewerVersion("v0.3.0", "0.2.0"), true);
    assert.equal(isNewerVersion("0.3.0", "v0.2.0"), true);
    assert.equal(isNewerVersion("v0.2.0", "v0.2.0"), false);
  });

  test("a missing segment reads as zero", () => {
    assert.equal(isNewerVersion("1.2", "1.2.0"), false);
    assert.equal(isNewerVersion("1.2.0", "1.2"), false);
    assert.equal(isNewerVersion("1.2.1", "1.2"), true);
    assert.equal(isNewerVersion("2", "1.9.9"), true);
  });

  test("a prerelease sits below the release it precedes", () => {
    assert.equal(isNewerVersion("1.0.0-rc.1", "1.0.0"), false);
    assert.equal(isNewerVersion("1.0.0", "1.0.0-rc.1"), true);
    assert.equal(isNewerVersion("1.0.0-rc.1", "0.9.0"), true);
  });

  // Never invent an update out of a string this couldn't read — the check runs unattended, so a
  // false positive would be permanent and unexplained.
  test("unparseable input is never newer", () => {
    assert.equal(isNewerVersion("", "0.2.0"), false);
    assert.equal(isNewerVersion("latest", "0.2.0"), false);
    assert.equal(isNewerVersion("0.3.0", "not-a-version"), false);
    assert.equal(isNewerVersion("nightly-build", "also-not"), false);
  });
});
