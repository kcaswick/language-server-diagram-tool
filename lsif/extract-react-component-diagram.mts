#!/usr/bin/env zx
import { M } from "ts-toolbelt";
import yargs, { Arguments, Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import { $, fs } from "zx";

const argv = yargs(hideBin(process.argv))
  .command("$0 <input>", "Extract React component diagram from LSIF file", (yargs) =>
    yargs
      .positional("input", {
        type: "string",
        describe: "LSIF file to extract from",
        normalize: true,
        coerce(input: string | undefined): M.JSON.Array | undefined {
          if (input && input !== "-") {
            // If input is a file path, read from the file
            return fs.readJsonSync(input, "utf8");
          }

          if (argv.stdin || (input && input === "-")) {
            // If filename is `-` or --stdin flag is set, read from stdin
            // const stdin = fs.readFileSync(process.stdin.fd, "utf8");
            return fs.readJsonSync(process.stdin.read(), "utf8");
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
  input: M.JSON.Array;
  stdin: boolean;
}>;

console.debug("argv", argv);
