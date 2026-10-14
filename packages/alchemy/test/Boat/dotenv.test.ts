import { describe, expect, test } from "alchemy-test";
import { formatEnvContents, parseEnvContents } from "@/Boat/dotenv";

describe("Boat environment contents", { tags: ["unit", "local"] }, () => {
  test("round-trips values that need quoting", () => {
    const vars = {
      PLAIN: "abc-123_./:@%+,=",
      EMPTY: "",
      SPACES: "hello world",
      QUOTES: 'say "hi"',
      BACKSLASH: "C:\\path\\to",
      MULTILINE: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
      HASH: "value # not a comment",
    };
    expect(parseEnvContents(formatEnvContents(vars))).toEqual(vars);
  });

  test("writes one sorted line per variable", () => {
    expect(formatEnvContents({ B: "2", A: "1 2" })).toBe('A="1 2"\nB=2');
  });

  test("reads what people write by hand", () => {
    expect(
      parseEnvContents(
        [
          "# comment",
          "",
          "export TOKEN=abc",
          "SINGLE='raw $value'",
          'DOUBLE="line\\nbreak"',
          "TRAILING=bare # comment",
          "not a variable",
        ].join("\n"),
      ),
    ).toEqual({
      TOKEN: "abc",
      SINGLE: "raw $value",
      DOUBLE: "line\nbreak",
      TRAILING: "bare",
    });
  });
});
