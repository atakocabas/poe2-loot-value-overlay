import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSteamLibraries, parseSteamPathFromRegQuery } from "../main/poe2-install";

// Verbatim output of `reg query HKCU\Software\Valve\Steam /v SteamPath` on a real install, blank
// leading line and all. Note the lowercase forward-slash path — Steam writes it that way.
const REG_QUERY_OUTPUT = `
HKEY_CURRENT_USER\\Software\\Valve\\Steam
    SteamPath    REG_SZ    c:/program files (x86)/steam

`;

// Shape of a real libraryfolders.vdf: two libraries, doubled backslashes, and PoE2's app id
// installed in the second one only.
const LIBRARY_FOLDERS_VDF = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"label"		""
		"contentid"		"1234567890"
		"totalsize"		"0"
		"apps"
		{
			"228980"		"117326386"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
		"label"		""
		"contentid"		"9876543210"
		"totalsize"		"1000202039296"
		"apps"
		{
			"2694490"		"150008042744"
			"440"		"18425730331"
		}
	}
}
`;

test("the Steam path is read out of reg query output", () => {
  assert.equal(parseSteamPathFromRegQuery(REG_QUERY_OUTPUT), "c:\\program files (x86)\\steam");
});

test("a registry value containing spaces is not truncated", () => {
  const output = "\n    InstallPath    REG_SZ    D:\\Games\\Steam Beta Client\n";
  assert.equal(parseSteamPathFromRegQuery(output), "D:\\Games\\Steam Beta Client");
});

test("a missing registry key reads as no path rather than an empty one", () => {
  const output = "ERROR: The system was unable to find the specified registry key or value.";
  assert.equal(parseSteamPathFromRegQuery(output), null);
});

test("library paths are unescaped from the vdf's doubled backslashes", () => {
  const libraries = parseSteamLibraries(LIBRARY_FOLDERS_VDF);

  assert.deepEqual(
    libraries.map((library) => library.path),
    ["C:\\Program Files (x86)\\Steam", "D:\\SteamLibrary"]
  );
});

test("each apps block is attributed to the library it sits under", () => {
  const libraries = parseSteamLibraries(LIBRARY_FOLDERS_VDF);

  // The whole point of slicing between "path" keys: PoE2 must land on D:, not on the first library
  // or on every library at once.
  assert.deepEqual(libraries[0].appIds, ["228980"]);
  assert.ok(libraries[1].appIds.includes("2694490"), "PoE2's app id belongs to the second library");
  assert.equal(libraries[0].appIds.includes("2694490"), false);
});

test("a vdf with no libraries yields none rather than throwing", () => {
  assert.deepEqual(parseSteamLibraries('"libraryfolders"\n{\n}\n'), []);
});
