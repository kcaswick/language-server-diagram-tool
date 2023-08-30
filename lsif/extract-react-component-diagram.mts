#!/usr/bin/env zx
import readline from "readline";
import { A, M } from "ts-toolbelt";
import yargs, { Arguments } from "yargs";
import { hideBin } from "yargs/helpers";
import { $, fs } from "zx";

export const readJsonl = async function* (
  path: fs.PathLike,
  options?: A.Compute<Parameters<typeof fs.createReadStream>[1]>,
) {
  const lineReader = readline.createInterface({ input: fs.createReadStream(path, options) });

  for await (const line of lineReader) {
    console.debug("line", line);
    yield (line ? JSON.parse(line) : null) as M.JSON.Value;
  }
};

const argv = yargs(hideBin(process.argv))
  .command("$0 <input>", "Extract React component diagram from LSIF file", (yargs) =>
    yargs
      .positional("input", {
        type: "string",
        describe: "LSIF file to extract from",
        normalize: true,
        coerce(input: string | undefined) {
          if (input && input !== "-" && input !== ".") {
            // If input is a file path, read from the file
            return readJsonl(input, "utf8");
          }

          if ((input && (input === "-" || input === ".")) || argv.stdin) {
            // If filename is `-` or --stdin flag is set, read from stdin
            // const stdin = fs.readFileSync(process.stdin.fd, "utf8");
            return readJsonl("-", { fd: process.stdin.fd, encoding: "utf8" });
          }
        },
      })
      .option("stdin", {
        description: "Reads the LSIF from stdin.",
        boolean: true,
        conflicts: ["input"],
      }),
  )
  .scriptName("extract-react-component-diagram")
  .usage("Usage: $0 [options] <input>")
  .help()
  .alias("h", "help")
  .version()
  .alias("v", "version")
  .parseSync() as Arguments<{
  input: ReturnType<typeof readJsonl>;
  stdin: boolean;
}>;

console.debug("argv", argv);

for await (const line of argv.input) {
  console.debug("line", line);
}
