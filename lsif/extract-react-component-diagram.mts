#!/usr/bin/env zx
/* eslint-disable new-cap */
import { AsFqn, ModelIndex } from "@likec4/core";
import type { Element as C4Element, ElementKind, Tag } from "@likec4/core";
import {
  DefinitionRange,
  Edge,
  Element,
  ItemEdgeProperties,
  Moniker,
  Range,
  RangeTagTypes,
  Vertex,
  VertexLabels,
  item,
  moniker,
  next,
  textDocument_references,
} from "lsif-protocol";
import readline from "readline";
import { A, M } from "ts-toolbelt";
import yargs, { Arguments } from "yargs";
import { hideBin } from "yargs/helpers";
import { $, fs } from "zx";

/**
 * Adds a new element to the given LikeC4 model index.
 * @param model - The model to add the element to.
 * @param element - The element to add to the model.
 */
export const addElement = (model: ModelIndex, element: C4Element) => {
  model.addElement(element);
};

export const readJsonl = async function* (
  path: fs.PathLike,
  options?: A.Compute<Parameters<typeof fs.createReadStream>[1]>,
) {
  const lineReader = readline.createInterface({ input: fs.createReadStream(path, options) });

  for await (const line of lineReader) {
    // For extremely detailed debug output: console.debug("line", line);
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

const componentTypeRanges: Record<string, Range> = {};
const elements = [] as Element[];
const itemIndexOut: Record<number, Record<ItemEdgeProperties | "undefined", number[]> | undefined> =
  {};
const model = new ModelIndex();
const monikerIndexIn: Record<number, number[]> = {};
const monikerIndexOut: Record<number, number[]> = {};
const nextIndexIn: Record<number, number[]> = {};
const nextIndexOut: Record<number, number[]> = {};
const textDocument_referencesIndexOut: Record<number, number> = {};
for await (const line of argv.input) {
  if (Element.is(line)) {
    elements[line.id as number] = line;

    if (Range.is(line) && line.tag?.type === RangeTagTypes.definition) {
      if (line.tag.text === "FunctionComponent") {
        componentTypeRanges.FunctionComponent = line;
      } else if (line.tag.text === "ClassComponent") {
        componentTypeRanges.ClassComponent = line;
      } else if (line.tag.text === "PureComponent") {
        componentTypeRanges.PureComponent = line;
      } else if (line.tag.text === "ComponentType") {
        componentTypeRanges.ComponentType = line;
      }
    } else if (moniker.is(line)) {
      if (monikerIndexIn[line.inV as number]) {
        monikerIndexIn[line.inV as number].push(line.outV as number);
      } else {
        monikerIndexIn[line.inV as number] = [line.outV as number];
      }

      if (monikerIndexOut[line.outV as number]) {
        monikerIndexOut[line.outV as number].push(line.inV as number);
      } else {
        monikerIndexOut[line.outV as number] = [line.inV as number];
      }
    } else if (next.is(line)) {
      if (nextIndexIn[line.inV as number]) {
        nextIndexIn[line.inV as number].push(line.outV as number);
      } else {
        nextIndexIn[line.inV as number] = [line.outV as number];
      }

      if (nextIndexOut[line.outV as number]) {
        nextIndexOut[line.outV as number].push(line.inV as number);
      } else {
        nextIndexOut[line.outV as number] = [line.inV as number];
      }
    } else if (textDocument_references.is(line)) {
      textDocument_referencesIndexOut[line.outV as number] = line.inV as number;
    } else if (item.is(line) && Edge.is1N(line)) {
      const it = line as unknown as item;
      const newItemEdgeMapEntries = (
        Object.keys(ItemEdgeProperties) as (keyof typeof ItemEdgeProperties | "undefined")[]
      )
        .map((key) => [key, [] as number[]])
        .concat([["undefined", []]]);
      // eslint-disable-next-line no-multi-assign
      const itemEdgeMap = (itemIndexOut[line.outV as number] ??= (() => {
        try {
          return Object.fromEntries(newItemEdgeMapEntries);
        } catch (e) {
          if (e instanceof Error) {
            e.message = `${e.message}\nwhile processing ${JSON.stringify(newItemEdgeMapEntries)}`;
          } else {
            console.debug("newRecordEntries", newItemEdgeMapEntries);
          }
        }
      })() as Record<ItemEdgeProperties | "undefined", number[]>);
      itemEdgeMap[it.property ?? "undefined"] = itemEdgeMap[it.property ?? "undefined"].concat(
        line.inVs as number[],
      );
    }
  } else if (line) {
    console.error("Unknown line type", line);
  }
}

// {"id":584,"type":"vertex","label":"range","start":{"line":545,"character":14},"end":{"line":545,"character":31},"tag":{"type":"definition","text":"FunctionComponent","kind":11,"fullRange":{"start":{"line":545,"character":4},"end":{"line":551,"character":5}}}}
const resultSetId = nextIndexOut[componentTypeRanges.FunctionComponent.id as number][0]; // 581
const referenceResultId = textDocument_referencesIndexOut[resultSetId]; // 930
console.debug("referenceResultId", referenceResultId);
itemIndexOut[referenceResultId]?.references.forEach((referenceId) => {
  // [588,645, 4261, 7043, 9735, 15832, 30761, 42710, 47293, 54658, 55255, 62295,62324, 77085, 79022, 99738]
  const reference = elements[referenceId];
  if (reference && Range.is(reference) && reference.tag?.type === RangeTagTypes.reference) {
    console.debug("inner reference", reference);
    // TODO: Find the surrounding fullRange on a range of type "definition"

    // {"id":503,"type":"vertex","label":"range","start":{"line":32,"character":13},"end":{"line":32,"character":20},"tag":{"type":"definition","text":"Feature","kind":7,"fullRange":{"start":{"line":32,"character":13},"end":{"line":34,"character":19}}}}
    const definitionRange: DefinitionRange = elements[
      referenceId === 588 ? 503 : referenceId === 645 ? 627 : 0
    ] as DefinitionRange;

    const resultSetId = nextIndexOut[definitionRange.id as number][0]; // 497

    // {"id":498,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"lib/packages/items/FeatureFlags:Feature","unique":"workspace","kind":"export"}
    // TODO: Verify there is single element in array or handle multiple
    console.debug("monikerIds", monikerIndexOut[resultSetId]);
    console.debug(
      "monikers",
      monikerIndexOut[resultSetId].map((monikerId) => ({
        element: elements[monikerId],
        isMoniker: Moniker.is(elements[monikerId]),
      })),
    );
    const tscMonikers = monikerIndexOut[resultSetId]
      .map((monikerId) => elements[monikerId])
      .filter(
        (moniker) =>
          (moniker as Vertex).label === VertexLabels.moniker &&
          (moniker as Moniker)?.scheme === "tsc",
      ) as Moniker[];
    if (tscMonikers.length !== 1) {
      throw new Error(`Expected a single tsc moniker but found ${JSON.stringify(tscMonikers)}`);
    }

    const tscMoniker = tscMonikers[0];
    console.debug("tscMoniker", tscMoniker);

    addElement(model, {
      description: "React component",
      links: null,
      kind: "widget" as ElementKind,
      id: AsFqn(tscMoniker.id.toString()),
      technology: "react",
      title: tscMoniker.identifier,
      tags: ["widget" as Tag, "component" as Tag, "react" as Tag],
    });
  }
});

console.log("modelIndex as JSON", JSON.stringify(model, null, 2));

console.log(
  "elements and relations as JSON",
  JSON.stringify({ elements: model.elements, relations: model.relations }, null, 2),
);
