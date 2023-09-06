#!/usr/bin/env zx
/* eslint-disable new-cap */
import { AsFqn, InvalidModelError, ModelIndex, nameFromFqn, parentFqn } from "@likec4/core";
import type {
  Element as C4Element,
  ElementKind,
  Fqn,
  Relation,
  RelationID,
  Tag,
} from "@likec4/core";
import { camelize, dasherize, humanize, titleize, underscore } from "inflection";
import {
  DefinitionRange,
  Edge,
  EdgeLabels,
  GraphElement,
  HoverResult,
  ItemEdgeProperties,
  Moniker,
  Range,
  RangeTagTypes,
  Vertex,
  VertexLabels,
  item,
  moniker,
  next,
  textDocument_hover,
  textDocument_references,
} from "lsif-protocol";
import readline from "readline";
import { A, M } from "ts-toolbelt";
import { Hover, MarkupContent, MarkedString } from "vscode-languageserver-protocol";
import yargs, { Arguments } from "yargs";
import { hideBin } from "yargs/helpers";
import { $, fs } from "zx";

import { noopTransformer } from "./lsif-server-modules/database";
import { JsonStoreEnhanced, locationToString } from "./jsonStoreEnhanced";

/**
 * Regular expression used to match folder names in a file path or moniker.
 * Matches either "Dir", "_dir", "/", or "\" followed by the end of the string or a colon.
 * @example "lib/packages/items/FeatureFlags:Feature" -> ["lib", "packages", "items"]
 */
const folderRegex = /(?:Dir|_dir|\/|\\)(?:$|(?=.*:))/g;

const scopeTag = "scope" as Tag;

/**
 * Regular expression used to match test files in a project.
 * Matches files with names ending in `.test.js`, `.test.jsx`, `.spec.js`, `.spec.jsx`, `.test.ts`, `.test.tsx`, `.spec.ts`, or `.spec.tsx`.
 * Also matches files located in a `__tests__` directory.
 */
const testRegex = /(?:\/__tests__\/.*?\/?[^/]*\.[jt]sx?)|(?:\/?([^/]*\.)+(spec|test)\.[jt]sx?)/;
const testFolderRegex = /__tests__|Tests/;

/**
 * Adds a new element to the given LikeC4 model index.
 * @param model - The model to add the element to.
 * @param element - The element to add to the model.
 */
export const addElement = (model: ModelIndex, element: C4Element) => {
  model.addElement(element);
};

/**
 * Represents the trie data structure used internally by {@link ModelIndex} for storing elements.
 */
interface ElementTrie {
  /**
   * The LikeC4 element stored at this trie node.
   */
  el?: C4Element;
  /**
   * The children of this trie node, stored as a dictionary with the local name as strings and values as ElementTrie objects.
   */
  children: Record<string, ElementTrie>;
}

export const addElementsForScopes = (
  model: ModelIndex,
  parent: Fqn = "" as Fqn,
  trie?: ElementTrie,
): void => {
  if (!trie) {
    // eslint-disable-next-line dot-notation
    trie = model["root"];
  }

  const childEntries = Object.entries<ElementTrie>(trie?.children ?? {});
  console.debug(`addElementsForScopes '${parent}'`, childEntries.length);
  for (const [name, child] of childEntries) {
    if (!child.el) {
      const tags: [Tag, ...Tag[]] = [
        scopeTag,
        `level-${parent === "" ? 0 : parent.split(".").length}` as Tag,
      ];
      if (Object.keys(child.children).length === 1) {
        tags.push("single-child" as Tag);
      }

      if (testFolderRegex.test(name)) {
        tags.push("test" as Tag);
      }

      addElement(model, {
        id: AsFqn(name, parent),
        kind: (folderRegex.test(name) ? "folder" : "scope") as ElementKind,
        title: titleize(underscore(name.replace(folderRegex, "Folder"))),
        description: parent
          .split(".")
          .concat(name)
          .map((n) => n.replace(folderRegex, "/"))
          .join(folderRegex.test(name) ? "" : "."),
        technology: null,
        tags,
        links: null,
      });
    }

    addElementsForScopes(model, AsFqn(name, parent), child);
  }
};

/**
 * Converts a Hover object to a string representation of the documentation.
 * @param hover The Hover object to convert.
 * @returns A string representation of the Hover object.
 */
export const hoverToString = (hover: Hover) => {
  if (MarkupContent.is(hover.contents)) {
    return hover.contents.value;
  }

  if (MarkedString.is(hover.contents)) {
    return markedStringToString(hover.contents);
  }

  if (Array.isArray(hover.contents) && hover.contents.every(MarkedString.is)) {
    return hover.contents.map(markedStringToString).join("\n");
  }
};

/**
 * Converts a `MarkedString` to a plain string.
 * @param markedString The `MarkedString` to convert.
 * @returns The plain string representation of the `MarkedString`.
 */
export const markedStringToString = (markedString: MarkedString) =>
  typeof markedString === "object"
    ? "" /* Instead of `markedString.value` because that usually has the type definition */
    : markedString;

/**
 * Converts a ModelIndex object to a LikeC4 DSL string.
 *
 * @param model - The ModelIndex object to convert.
 * @returns The DSL string representation of the ModelIndex object.
 */
export const modelIndexToDsl = (model: ModelIndex) => {
  const indentSize = 2;
  let indent = 0;

  // Write specification section
  const dsl = [`specification {`];
  indent++;

  const kinds = new Set(model.elements.map((el) => el.kind));
  dsl.push(...[...kinds].map((kind) => `  element ${kind}`));

  const tags = new Set(
    model.elements
      .flatMap((el) => el.tags ?? [])
      .concat(model.relations.flatMap((rel) => rel.tags ?? [])),
  );
  dsl.push(...[...tags].map((tag) => `  tag ${tag}`));

  indent--;
  dsl.push(`}`);

  // Write model section
  dsl.push(`model {`);
  indent++;

  const containerElements: C4Element[] = [];

  const toElementDsl = (el: C4Element, model: ModelIndex, indent = 0) => {
    const isBlock = el.tags;
    const dsl = [
      `${" ".repeat(indent * indentSize)}${nameFromFqn(el.id)} = ${el.kind} '${el.title}'${
        el.description || el.technology ? ` '${el.description}'` : ""
      }${el.technology ? ` '${el.technology}'` : ""}${isBlock ? " {" : ""}`,
    ];
    indent += 1;
    if (el.tags) {
      dsl.push(`${" ".repeat(indent * indentSize)}${el.tags.map((tag) => `#${tag}`).join(", ")}`);
    }

    el.links?.forEach((link) => {
      dsl.push(`${" ".repeat(indent * indentSize)}link ${encodeURI(link)}`);
    });

    // TODO: Write the rest of the element properties, if present

    // Write child elements, if present
    const children = model.children(el.id);
    if (children?.length > 0) {
      containerElements.push(el);
    }

    children.forEach((child) => {
      dsl.push(``);
      dsl.push(...toElementDsl(child, model, indent));
    });

    if (isBlock) {
      dsl.push(`${" ".repeat(indent * indentSize)}}`);
      dsl.push(``);
    }

    return dsl;
  };

  console.debug("model.rootElements()", model.rootElements());
  model.rootElements().forEach((el) => {
    dsl.push(...toElementDsl(el, model, indent));
  });

  dsl.push(
    ...model.relations.map(
      (rel) =>
        `${" ".repeat(indent * indentSize)}${rel.source} -> ${rel.target}${
          rel.title ? ` '${rel.title}'` : ""
        }${rel.tags ? ` {${rel.tags.map((tag) => `#${tag}`).join(", ")}}` : ""}`,
    ),
  );

  indent--;
  dsl.push(`${" ".repeat(indent * indentSize)}}`);
  dsl.push(``);

  // Write views section, at least an index view at a minimum
  dsl.push(`views {`);
  indent++;

  // TODO: Decide whether the index should be `of` the top level system, or globally scoped.
  dsl.push(`${" ".repeat(indent * indentSize)}view index {`);
  indent++;
  dsl.push(`${" ".repeat(indent * indentSize)}title 'Landscape'`);
  dsl.push(`${" ".repeat(indent * indentSize)}include *`);
  indent--;
  dsl.push(`${" ".repeat(indent * indentSize)}}`);
  dsl.push(``);

  if (argv.scopes) {
    dsl.push(`${" ".repeat(indent * indentSize)}view indexFlat {`);
    indent++;
    dsl.push(`${" ".repeat(indent * indentSize)}title 'Landscape (flat)'`);
    dsl.push(
      `${" ".repeat(indent * indentSize)}include ${["*"]
        .concat(
          containerElements.filter((el) => el.tags?.includes(scopeTag)).map((el) => `${el.id}.*`),
        )
        .join(", ")}`,
    );
    dsl.push(
      `${" ".repeat(
        indent * indentSize,
      )}exclude element.tag = #${scopeTag}\t// Comment this line to nest within scopes`,
    );
    indent--;
    dsl.push(`${" ".repeat(indent * indentSize)}}`);
    dsl.push(``);
  }

  containerElements.forEach((el) => {
    // Are there any containers we would not want a view of and should skip?
    dsl.push(
      `${" ".repeat(indent * indentSize)}view ${dasherize(
        (parentFqn(el.id) ?? "").replace(/\./g, "-") + el.title,
      )} of ${el.id} {`,
    );
    indent++;

    const viewType = (() => {
      switch (el.kind) {
        case "system":
        case "softwareSystem":
          // How do we get system context diagrams?
          return "Container";
        case "container":
          return "Component";
        case "component":
          return "Code";
        case "environment":
          return "Deployment";
        default:
          return "";
      }
    })();

    dsl.push(
      `${" ".repeat(indent * indentSize)}title '${el.title}${viewType ? " - " : ""}${viewType}'`,
    );
    dsl.push(`${" ".repeat(indent * indentSize)}include *`);

    indent--;
    dsl.push(`${" ".repeat(indent * indentSize)}}`);
  });

  indent--;
  dsl.push(`}`);
  dsl.push(``);

  return dsl.join("\n");
};

/**
 * Sanitizes a Moniker and converts it to a fully qualified name (FQN) string.
 * @param moniker The Moniker object to convert.
 * @param scopes - Whether to preserve scope separations
 * @returns The FQN string.
 */
export function monikerToFqn(moniker: Moniker, scopes: boolean) {
  const debug = true;

  let identifier = moniker.identifier.replace(/\.(?=[jt]sx?:)/, "_").replace(".", "_dot_");
  if (scopes) {
    identifier = identifier.replace(folderRegex, "_dir.");
  }

  if (debug) {
    console.debug(`monikerToFqn ${moniker.identifier} -> ${identifier} (scopes: ${scopes}))`);
  }

  const fqn = AsFqn(
    moniker.identifier
      ? camelize(identifier, true).replace(/:+/g, "_").replace(/[=+]/g, "_").replace(/^(\d)/, "_$1")
      : typeof moniker.id === "number"
      ? `_${moniker.id}`
      : moniker.id,
  );
  if (debug) {
    console.debug(`monikerToFqn ${moniker.identifier} -> ${fqn}`);
  }

  return fqn;
}

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

const coerceFile = (input: string | undefined) => {
  if (input && input !== "-" && input !== ".") {
    // If input is a file path, read from the file
    return { path: input, lines: readJsonl(input, "utf8") };
  }

  if ((input && (input === "-" || input === ".")) || argv.stdin) {
    // If filename is `-` or --stdin flag is set, read from stdin
    // const stdin = fs.readFileSync(process.stdin.fd, "utf8");
    return {
      path: "stdin",
      lines: readJsonl("-", { fd: process.stdin.fd, encoding: "utf8" }),
    };
  }

  throw new Error("No input file specified");
};

const argv = yargs(hideBin(process.argv))
  .command("$0 <input>", "Extract React component diagram from LSIF file", (yargs) =>
    yargs
      .positional("input", {
        type: "string",
        describe: "LSIF file to extract from",
        normalize: true,
        coerce: coerceFile,
      })
      .option("scopes", {
        default: true,
        description: "Include scopes (e.g. folders, packages, etc.) as elements in the model.",
        boolean: true,
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
  input: ReturnType<typeof coerceFile>;
  scopes: boolean;
  stdin: boolean;
}>;

console.debug("argv", argv);

const componentTypeRanges: Record<string, Range> = {};
const elements = [] as GraphElement[];
const outIndex: Map<number, Map<EdgeLabels | "undefined", number[]>> = new Map();
const itemIndexOut: Record<number, Record<ItemEdgeProperties | "undefined", number[]> | undefined> =
  {};
const model = new ModelIndex();
const monikerIndexIn: Record<number, number[]> = {};
const monikerIndexOut: Record<number, number[]> = {};
const nextIndexIn: Record<number, number[]> = {};
const nextIndexOut: Record<number, number[]> = {};
const textDocument_referencesIndexOut: Record<number, number> = {};
for await (const line of argv.input.lines) {
  if (GraphElement.is(line)) {
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
      const edge: next = line;
      if (nextIndexIn[edge.inV as number]) {
        nextIndexIn[edge.inV as number].push(edge.outV as number);
      } else {
        nextIndexIn[edge.inV as number] = [edge.outV as number];
      }

      if (nextIndexOut[edge.outV as number]) {
        nextIndexOut[edge.outV as number].push(edge.inV as number);
      } else {
        nextIndexOut[edge.outV as number] = [edge.inV as number];
      }
    } else if (textDocument_references.is(line)) {
      const edge: textDocument_references = line;
      textDocument_referencesIndexOut[edge.outV as number] = edge.inV as number;
    } else if (textDocument_hover.is(line)) {
      const edge: textDocument_hover = line;
      let edgeMap = outIndex.get(edge.outV as number);
      if (edgeMap === undefined) {
        edgeMap = new Map();
        outIndex.set(edge.outV as number, edgeMap);
      }

      let inArray = edgeMap.get(edge.label);
      if (inArray === undefined) {
        inArray = [];
        edgeMap?.set(edge.label, inArray);
      }

      inArray.push(edge.inV as number);
    } else if (item.is(line) && Edge.is1N(line)) {
      const it = line as unknown as item;
      const newItemEdgeMapEntries = (
        Object.keys(ItemEdgeProperties) as (keyof typeof ItemEdgeProperties | "undefined")[]
      )
        .map((key) => [key, [] as number[]])
        .concat([["undefined", []]]);
      // eslint-disable-next-line no-multi-assign
      const itemEdgeMap = (itemIndexOut[it.outV as number] ??= (() => {
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
        it.inVs as number[],
      );
    }
  } else if (line) {
    console.error("Unknown line type", line);
  }
}

// #region Processing functions
function processTypeDefinitionReferences(range: Range) {
  // {"id":584,"type":"vertex","label":"range","start":{"line":545,"character":14},"end":{"line":545,"character":31},"tag":{"type":"definition","text":"FunctionComponent","kind":11,"fullRange":{"start":{"line":545,"character":4},"end":{"line":551,"character":5}}}}
  const resultSetId = nextIndexOut[range.id as number][0]; // 581
  const referenceResultId = textDocument_referencesIndexOut[resultSetId]; // 930
  console.debug("referenceResultId", referenceResultId);

  // TODO: Make this a function, and also apply it to the referenceResults for ClassComponent, PureComponent, and ComponentType
  itemIndexOut[referenceResultId]?.references.forEach((referenceId) => {
    // [588,645, 4261, 7043, 9735, 15832, 30761, 42710, 47293, 54658, 55255, 62295,62324, 77085, 79022, 99738]
    const reference = elements[referenceId];
    if (reference && Range.is(reference) && reference.tag?.type === RangeTagTypes.reference) {
      console.debug("inner reference", inputStore.getLinkFromRange(reference), reference);

      // Find the surrounding fullRange on a range of type "definition"
      const definitionRanges = inputStore.findFullRangesFromPosition(
        inputStore.getDocumentFromRange(reference)?.uri ?? "",
        reference.start
      );
      console.debug(
        "definitionRanges",
        definitionRanges,
        definitionRanges?.map((r) => inputStore.getLinkFromRange(r))
      );

      // {"id":503,"type":"vertex","label":"range","start":{"line":32,"character":13},"end":{"line":32,"character":20},"tag":{"type":"definition","text":"Feature","kind":7,"fullRange":{"start":{"line":32,"character":13},"end":{"line":34,"character":19}}}}
      const definitionRange = definitionRanges?.[0];
      console.debug(`definitionRange for inner reference`, definitionRange);

      if (definitionRange === undefined || !DefinitionRange.is(definitionRange)) {
        console.error(
          `ERROR: No definition range found for ${reference.tag?.type}`,
          reference.tag?.text,
          `at ${reference.start.line}:${reference.start.character}`
        );
        return;
      }

      processDefinitionRange(definitionRange);
    }
  });
}

function processDefinitionRange(definitionRange: DefinitionRange) {
  const resultSetId = nextIndexOut[definitionRange.id as number][0]; // 497, 621

  if (resultSetIdsProcessed.has(resultSetId)) {
    console.warn(
      `Already processed resultSetId ${resultSetId} referenced by definition range [${
        definitionRange.id
      }](${inputStore.getLinkFromRange(definitionRange)})`,
    );
    return;
  }

  resultSetIdsProcessed.add(resultSetId);

  // {"id":498,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"lib/packages/items/FeatureFlags:Feature","unique":"workspace","kind":"export"}
  // TODO: Verify there is single element in array or handle multiple
  console.debug("resultSetId", resultSetId, "monikerIds", monikerIndexOut[resultSetId]);
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

  const hoverIDs = outIndex.get(resultSetId)?.get(EdgeLabels.textDocument_hover);
  console.debug("hoverIDs", hoverIDs);
  const hoverID = hoverIDs?.[0];
  console.debug("hoverID", hoverID);
  const hover = elements[hoverID as number] as HoverResult;

  const tscMoniker = tscMonikers[0];
  console.debug("tscMoniker", tscMoniker);

  const newId = monikerToFqn(tscMoniker, argv.scopes);
  const tags: [Tag, ...Tag[]] = ["widget" as Tag, "component" as Tag, "react" as Tag];

  if (testRegex.test(inputStore.getDocumentFromRange(definitionRange)?.uri ?? "")) {
    tags.push("test" as Tag);
  }

  addElement(model, {
    description: hoverToString(hover?.result) ?? "",
    links: null,
    kind: "widget" as ElementKind,
    id: newId,
    technology: "React component",
    title:
      definitionRange.tag?.text ??
      titleize(underscore(tscMoniker.identifier.split(":").pop() ?? "Unknown")),
    tags,
  });
  elementDefinitionRanges.set(newId, definitionRange);
}
// #endregion Processing functions

const inputStore = new JsonStoreEnhanced();
await inputStore.load(argv.input.path, () => noopTransformer);

// Process the model and add all React components to the model

const elementDefinitionRanges = new Map<Fqn, DefinitionRange>();
const resultSetIdsProcessed = new Set<number>();

// Go through all widget types and find everything implementing them

Object.values(componentTypeRanges).map(processTypeDefinitionReferences);

// Add all the references between elements that were included in the model as relationships

elementDefinitionRanges.forEach((reference, id) => {
  const referenceLocations = inputStore.references(
    inputStore.getDocumentFromRange(reference)?.uri ?? "",
    reference.start,
    {
      includeDeclaration: false,
    },
  );
  console.debug("referenceLocations", referenceLocations?.map(locationToString));

  referenceLocations?.forEach((referencePosition) => {
    const definitionRanges = inputStore.findFullRangesFromPosition(
      referencePosition.uri,
      referencePosition.range.start,
    );
    // Find the surrounding fullRange on a range of type "definition"
    console.debug(
      "definitionRanges",
      definitionRanges,
      definitionRanges?.map((r) => inputStore.getLinkFromRange(r)),
    );

    const definitionRange = definitionRanges?.[0];
    console.debug(`definitionRange around reference range`, definitionRange);

    if (definitionRange === undefined || !DefinitionRange.is(definitionRange)) {
      console.error(`ERROR: No definition range found for ${locationToString(referencePosition)}`);
      return;
    }

    if (definitionRange === reference) {
      // Skip self-references
      return;
    }

    const moniker = inputStore.getMonikerFromRange(definitionRange);

    if (moniker === undefined) {
      console.error(
        `ERROR: No moniker found for ${definitionRange.tag?.text} at ${inputStore.getLinkFromRange(
          definitionRange,
        )}`,
      );
      return;
    }

    const referenceId = monikerToFqn(moniker, argv.scopes);

    if (referenceId === id) {
      // Skip self-references

      // TODO: Skip imports without an error message

      console.error(
        `ERROR: Self-reference found for ${referenceId} from different ranges`,
        reference,
        inputStore.getLinkFromRange(reference),
        definitionRange,
        inputStore.getLinkFromRange(definitionRange),
      );
      return;
    }

    const newRelation: Relation = {
      source: referenceId,
      target: id,
      tags: [RangeTagTypes.reference as Tag],
      id: `${referenceId}_${RangeTagTypes.reference}_${id}` as RelationID,
      title: humanize(RangeTagTypes.reference, true),
    };
    try {
      model.addRelation(newRelation);
    } catch (e) {
      if (e instanceof InvalidModelError) {
        if (e.message.includes("Source of relation not found")) {
          const tags: [Tag, ...Tag[]] = ["unknown" as Tag];

          if (testRegex.test(inputStore.getDocumentFromRange(definitionRange)?.uri ?? "")) {
            tags.push("test" as Tag);
          }

          addElement(model, {
            description: "Unknown element added for relation to connect to",
            links: [
              inputStore.getLinkFromRange(definitionRange),
              locationToString(referencePosition),
            ],

            kind: "widget" as ElementKind,
            id: referenceId,
            technology: null,
            title:
              definitionRange.tag?.text ??
              titleize(underscore(moniker.identifier.split(":").pop() ?? "Unknown")),
            tags,
          });
          model.addRelation(newRelation);
        }
      }
    }
  });
});

if (argv.scopes) {
  addElementsForScopes(model);
}

console.debug("modelIndex as JSON", JSON.stringify(model, null, 2));

console.debug(
  "elements and relations as JSON",
  JSON.stringify({ elements: model.elements, relations: model.relations }, null, 2),
);

// Output the model

console.log("\nLikeC4 DSL\n", modelIndexToDsl(model));
