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
  UniquenessLevel,
  Vertex,
  VertexLabels,
  item,
  moniker,
  next,
  textDocument_hover,
  textDocument_references,
} from "lsif-protocol";
import path from "node:path";
import pino from "pino";
import readline from "readline";
import { A, M } from "ts-toolbelt";
import { Hover, MarkupContent, MarkedString } from "vscode-languageserver-protocol";
import yargs, { Arguments } from "yargs";
import { hideBin } from "yargs/helpers";
import { $, fs } from "zx";

import { noopTransformer } from "./lsif-server-modules/database";
import { JsonStoreEnhanced, locationToLink, locationToString } from "./jsonStoreEnhanced";
import { SymbolKind } from "vscode-languageserver";

/**
 * Regular expression used to match folder names in a file path or moniker.
 * Matches either "Dir", "_dir", "/", or "\" followed by the end of the string or a colon.
 * @example "lib/packages/items/FeatureFlags:Feature" -> ["lib", "packages", "items"]
 */
const folderRegex = /(?:Dir|_dir|\/|\\)(?:$|(?=.*:))/g;

const typeSymbolKinds = [
  SymbolKind.Class,
  SymbolKind.Interface,
  SymbolKind.Struct,
  SymbolKind.Enum,
  SymbolKind.TypeParameter,
];
const typeElementKinds = symbolKindsAsElementKinds(typeSymbolKinds);

const typeAliasKind = "type-alias" as ElementKind;

const scopeTag = "scope" as Tag;
const typeTag = "type" as Tag;

/**
 * Regular expression used to match test files in a project.
 * Matches files with names ending in `.test.js`, `.test.jsx`, `.spec.js`, `.spec.jsx`, `.test.ts`, `.test.tsx`, `.spec.ts`, or `.spec.tsx`.
 * Also matches files located in a `__tests__` directory.
 */
const testRegex =
  /(?:\/__tests__\/.*?\/?[^/]*\.[jt]sx?)|(?:\/?([^/]*\.)+(stories|spec|test)\.[jt]sx?)/;
const testFolderRegex = /__tests__|Tests|__mocks__|MocksDir|[Ss]toriesDir/;

const logger = pino({
  hooks: {
    logMethod(args, method, _level) {
      if (args.length > 1 && typeof args[0] === "string" && !args[0].includes("%")) {
        args[0] += " %O".repeat(args.length - 1);
        method.apply(this, args)
      } else {
        method.apply(this, args)
      }
    },
  },
  transport: {
    target: "pino-pretty",
    options: {
      destination: process.stderr.fd,
    },
  },
});

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
  logger.debug(`addElementsForScopes '${parent}'`, childEntries.length);
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
        kind: (name.endsWith("Pkg")
          ? "package"
          : folderRegex.test(name)
          ? "folder"
          : "scope") as ElementKind,
        title: titleize(underscore(name.replace("Pkg", "Package").replace(folderRegex, "Folder"))),
        description: parent
          .split(".")
          .concat(name)
          .map((n) =>
            n
              .replace("Pkg", ":")
              .replace(/(?<=^|[/\\])At(?!\p{Lower})/gu, "@")
              .replace(folderRegex, "/"),
          )
          .join(name.endsWith("Pkg") || folderRegex.test(name) ? "" : "."),
        technology: null,
        tags,
        links: null,
      });
    }

    addElementsForScopes(model, AsFqn(name, parent), child);
  }
};

function buildPackageMap(store: JsonStoreEnhanced) {
  const packages = store.getVerticesWithLabel(VertexLabels.packageInformation);

  packages.forEach((pkg) => {
    const monikers = store.getMonikersForPackage(pkg);

    const match = monikers
      .sort((a, b) => a.identifier.length - b.identifier.length)
      .find((moniker) => {
        if (moniker.scheme === "npm") {
          return updatePackageMap(moniker);
        }

        logger.warn(`Unexpected moniker scheme ${moniker.scheme} for ${moniker.identifier}`);
        return false;
      });

    // This doesn't make sense, how would we know the package name to use?
    // if (!match) {
    //   const containers = inputStore.getContainersForMoniker(monikers[0]);
    //   if (containers !== undefined) {
    //     if (
    //       containers.project &&
    //       containers.project.resource &&
    //       path.dirname(containers.project.resource).length > 1
    //     ) {
    //       packageRootMap.set(packageName, path.dirname(containers.project.resource));
    //       logger.debug(
    //         `packageRootMap.set('${packageName}', '${packageRoot}') ${pathName} ${sourcePathName}`,
    //       );
    //     }
    //   }
    // }
  });

  logger.debug(
    "packageRootMap",
    [...packageRootMap.entries()].map(
      ([k, v]) => `${k} -> base '${packageBaseMap.get(k)}' root ${v}`,
    ),
  );
}

/**
 * Get the name of the enum value from the given enum object.
 * @param enumObject - The enum object to search.
 * @param value - The value to find the name of.
 * @returns The name of the enum value, or undefined if not found.
 */
function getNameFromValue(enumObject: Record<string, number>, value: number) {
  return Object.entries(enumObject).find((entry) => entry[1] === value)?.[0];
}

/**
 * Returns the relative URL of a given URI with respect to the workspace root URL.
 * If the URI is not within the workspace root, the URI is returned as-is.
 * @param uri - The URI to get the relative URL for.
 * @param workspaceRoot - The workspace root URL.
 * @returns The relative URL of the given URI with respect to the workspace root URL.
 */
function getRelativeUrl(uri: string, workspaceRoot: URL) {
  // Note: workspaceRoot.href does not include the trailing slash
  if (uri.startsWith(workspaceRoot.href)) {
    return uri.substring(workspaceRoot.href.length + 1);
  }

  const url = new URL(uri);
  if (url.protocol === workspaceRoot.protocol && url.host === workspaceRoot.host) {
    const pathname = path.relative(workspaceRoot.pathname, url.pathname);
    return pathname;
  }

  return uri;
}

/**
 * Get the name of the given symbol kind.
 * @param kind The symbol kind to get the name of.
 * @returns The name of the symbol kind, or undefined if the kind is not recognized.
 */
function getSymbolKindName(kind: SymbolKind): string | undefined {
  return getNameFromValue(SymbolKind, kind);
}

/**
 * Converts a Hover object to a string representation of the documentation.
 * Note: Excludes any lines that are embedded code.
 * @param hover The Hover object to convert.
 * @returns A string representation of the Hover object.
 */
export const hoverToString = (
  hover: Hover,
): [text: string, code: string | undefined] | undefined => {
  if (MarkupContent.is(hover.contents)) {
    return [hover.contents.value, undefined];
  }

  if (MarkedString.is(hover.contents)) {
    return [markedStringToString(hover.contents), undefined];
  }

  if (Array.isArray(hover.contents) && hover.contents.every(MarkedString.is)) {
    return [
      hover.contents.map(markedStringToString).join("\n"),
      hover.contents
        .map((o) => typeof o === "object" && o.value)
        .filter((v) => v !== false)
        .join("\n"),
    ];
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
  dsl.push(...[...kinds].sort().map((kind) => `  element ${kind}`));

  const tags = new Set(
    model.elements
      .flatMap((el) => el.tags ?? [])
      .concat(model.relations.flatMap((rel) => rel.tags ?? [])),
  );
  dsl.push(...[...tags].sort().map((tag) => `  tag ${tag}`));

  const clutterKinds = symbolKindsAsElementKinds([
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Property,
  ]).filter((k) => kinds.has(k as ElementKind));

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
    const children = model.children(el.id).sort((a, b) => a.id.localeCompare(b.id));
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

  logger.debug("model.rootElements()", model.rootElements());
  model
    .rootElements()
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((el) => {
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

  const containerElementsSorted = containerElements.sort((a, b) => a.id.localeCompare(b.id));

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
          containerElementsSorted
            .filter((el) => el.tags?.includes(scopeTag))
            .map((el) => `${el.id}.*`),
        )
        .join(", ")}`,
    );
    if (tags.has(scopeTag)) {
      dsl.push(
        `${" ".repeat(
          indent * indentSize,
        )}exclude element.tag = #${scopeTag}\t// Comment this line to nest within scopes`,
      );
    }

    indent--;
    dsl.push(`${" ".repeat(indent * indentSize)}}`);
    dsl.push(``);

    dsl.push(`${" ".repeat(indent * indentSize)}view indexShallow {`);
    indent++;
    const minLevel = 2;
    const maxLevel = 3;
    dsl.push(
      `${" ".repeat(indent * indentSize)}title 'Landscape (${
        maxLevel - minLevel + 1
      } levels of folders)'`,
    );
    dsl.push(
      `${" ".repeat(indent * indentSize)}include ${["*"]
        .concat(
          containerElementsSorted
            .filter((el) => el.tags?.includes(scopeTag))
            .map((el) => `${el.id}.*`),
        )
        .join(", ")}`,
    );
    if (tags.has(scopeTag)) {
      dsl.push(`${" ".repeat(indent * indentSize)}exclude element.tag = #${scopeTag}`);
    }

    if (kinds.has("package" as ElementKind)) {
      dsl.push(`${" ".repeat(indent * indentSize)}include element.kind = package`);
    }

    dsl.push(
      `${" ".repeat(indent * indentSize)}include ${[...Array(maxLevel - minLevel + 1).keys()]
        .map((i) => `element.tag = #level-${i + minLevel}`)
        .join(", ")}`,
    );

    if (tags.has("test" as Tag)) {
      dsl.push(`${" ".repeat(indent * indentSize)}exclude element.tag = #test`);
    }

    clutterKinds.forEach((kindName) => {
      dsl.push(`${" ".repeat(indent * indentSize)}exclude element.kind = ${kindName}`);
    });

    indent--;
    dsl.push(`${" ".repeat(indent * indentSize)}}`);
    dsl.push(``);
  }

  if (kinds.has("widget" as ElementKind)) {
    dsl.push(`${" ".repeat(indent * indentSize)}view indexWidgets {`);
    indent++;

    dsl.push(`${" ".repeat(indent * indentSize)}title 'Widgets'`);
    dsl.push(`${" ".repeat(indent * indentSize)}include element.kind = widget`);

    if (kinds.has("package" as ElementKind)) {
      dsl.push(`${" ".repeat(indent * indentSize)}include element.kind = package`);
    }

    // Include any classes or interfaces that are referenced by widgets
    if (tags.has(typeTag)) {
      dsl.push(
        `${" ".repeat(
          indent * indentSize,
        )}include element.kind = widget -> element.tag = #${typeTag}`,
      );
    } else if (kinds.has("function" as ElementKind)) {
      dsl.push(
        `${" ".repeat(
          indent * indentSize,
        )}include element.kind = widget -> element.kind != function`,
      );
    }

    indent--;
    dsl.push(`${" ".repeat(indent * indentSize)}}`);
    dsl.push(``);
  }

  containerElementsSorted.forEach((el) => {
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

  // Strip extensions and periods from the identifier
  const stripExtensions = (identifier: string) =>
    identifier.replace(/\.(?=[jt]sx?:)/, "_").replace(/\./g, "_dot_");

  let identifier = stripExtensions(moniker.identifier);

  if (moniker.scheme === "npm") {
    const [packageName, pathName] = moniker.identifier.split(":");

    identifier = identifier.replace(/@/g, "_at_").replace(/(?<=^[\w@/\\-]+):/, "_pkg.");

    if (packageRootMap.get(packageName) === undefined) {
      updatePackageMap(moniker);
    }
  } else if (
    moniker.unique !== UniquenessLevel.scheme &&
    moniker.unique !== UniquenessLevel.global
  ) {
    // Prefix identifier with project and document
    const containers = inputStore.getContainersForMoniker(moniker);
    if (containers === undefined) {
      throw new Error(`No containers found for moniker ${moniker.identifier}`);
    }

    let prefix = "";
    let packageRoot: URL | undefined;
    if (containers.project?.name) {
      prefix = containers.project.name + "_proj.";
      const packageName = projectPackageMap.get(containers.project.name);
      if (packageName !== undefined) {
        prefix = packageName.replace(/@/g, "_at_") + "_pkg.";

        const packageRootString = packageRootMap.get(packageName);
        if (packageRootString !== undefined) {
          packageRoot = new URL(packageRootString.replace(/\/$/, ""));
          prefix += packageBaseMap.get(packageName) ?? "";
        }
      }
    }

    identifier = `${prefix}${stripExtensions(
      `${
        // Get document path relative to workspace root
        containers.document && containers.workspace
          ? getRelativeUrl(containers.document.uri, packageRoot ?? containers.workspace)
          : containers.document?.uri ?? ""
      }:`,
    )}${identifier}`;
  }

  if (scopes) {
    identifier = identifier.replace(folderRegex, "_dir.");
  }

  if (debug) {
    logger.debug(`monikerToFqn ${moniker.identifier} -> ${identifier} (scopes: ${scopes}))`);
  }

  const fqn = AsFqn(
    moniker.identifier
      ? camelize(identifier, true).replace(/:+/g, "_").replace(/[=+]/g, "_").replace(/^(\d)/, "_$1")
      : typeof moniker.id === "number"
      ? `_${moniker.id}`
      : moniker.id,
  );
  if (debug) {
    logger.debug(`monikerToFqn ${moniker.identifier} -> ${fqn}`);
  }

  return fqn;
}

export const readJsonl = async function* (
  path: fs.PathLike,
  options?: A.Compute<Parameters<typeof fs.createReadStream>[1]>,
) {
  const lineReader = readline.createInterface({ input: fs.createReadStream(path, options) });

  for await (const line of lineReader) {
    // For extremely detailed debug output: logger.debug("line", line);
    yield (line ? JSON.parse(line) : null) as M.JSON.Value;
  }
};

/**
 * Converts a SymbolKind to an ElementKind.
 * @param kind The SymbolKind to convert.
 * @returns The corresponding ElementKind, or undefined if there is no match.
 */
function symbolKindAsElementKind(kind: SymbolKind): ElementKind | undefined {
  const kindName = getSymbolKindName(kind);
  return (kindName && dasherize(underscore(kindName))) as ElementKind | undefined;
}

/**
 * Maps an array of `SymbolKind` values to an array of `ElementKind` values.
 * @param list An array of `SymbolKind` values to map.
 * @returns An array of `ElementKind` values.
 */
function symbolKindsAsElementKinds(list: SymbolKind[]): ElementKind[] {
  return list.map(getSymbolKindName).filter((k) => k !== undefined) as ElementKind[];
}

/**
 * Updates the package map with the given path name and package name. Fetches the project name from the moniker location, and
 * updates the package root map if the path name is a suffix of the document uri.
 * @param pathName - The path name to remove from the file location.
 * @param packageName - The package name to update in the package map.
 */
function updatePackageMap(moniker: Moniker) {
  let isRootFound = false;
  const [packageName, pathName] = moniker.identifier.split(":");
  const containers = inputStore.getContainersForMoniker(moniker);
  if (containers !== undefined) {
    if (containers.document) {
      // Try to get the pathname without any lib/ or dist/ folder prefix
      // TODO: Handle more than one level of prefix
      const sourcePathName = pathName.split("/").slice(1).join("/");
      let packageRoot;

      if (sourcePathName.length > 1 && containers.document.uri.endsWith(sourcePathName)) {
        packageRoot = containers.document.uri.replace(sourcePathName, "");
        packageBaseMap.set(packageName, pathName.split("/")[0] + "/");
      }

      if (pathName.length > 1 && containers.document.uri.endsWith(pathName)) {
        packageRoot = containers.document.uri.replace(pathName, "");
      }

      // Too soon - if (
      //   packageRoot === undefined &&
      //   containers.project &&
      //   containers.project.resource &&
      //   path.dirname(containers.document.uri).endsWith(path.dirname(containers.project.resource))
      // ) {
      //   packageRoot = path
      //     .dirname(containers.document.uri)
      //     .replace(path.dirname(containers.project.resource), "");
      // }

      if (packageRoot) {
        packageRootMap.set(packageName, packageRoot);
        isRootFound = true;
        logger.debug(
          `packageRootMap.set('${packageName}', '${packageRoot}') ${pathName} ${sourcePathName}`,
        );

        if (containers.project) {
          packageProjectMap.set(packageName, containers.project.name);
          projectPackageMap.set(containers.project.name, packageName);
          logger.debug(
            `packageProjectMap.set('${packageName}', '${containers.project.name}') ${
              containers.range && inputStore.getLinkFromRange(containers.range)
            }`,
          );
        }
      }
    }
  }

  return isRootFound;
}

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
      .option("logLevel", {
        type: "string",
        default: "info",
        description: "Level of detail to log",
        choices: Object.values(pino.levels.labels)
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
  logLevel: pino.LevelWithSilent;
  scopes: boolean;
  stdin: boolean;
}>;

logger.level = argv.logLevel;

logger.debug("argv", argv);

const componentTypeRanges: Record<string, Range> = {};
const elements = [] as GraphElement[];
const outIndex: Map<number, Map<EdgeLabels | "undefined", number[]>> = new Map();
const itemIndexOut: Record<number, Record<ItemEdgeProperties | "undefined", number[]> | undefined> =
  {};
const model = new ModelIndex();
const monikerIndexIn: Record<number, number[]> = {};
const monikerIndexOut: Record<number, number[]> = {};

const packageBaseMap = new Map<string, string>();
const packageRootMap = new Map<string, string>();
const packageProjectMap = new Map<string, string>();
const projectPackageMap = new Map<string, string>();

const nextIndexIn: Record<number, number[]> = {};
const nextIndexOut: Record<number, number[]> = {};
const textDocument_referencesIndexOut: Record<number, number> = {};
for await (const line of argv.input.lines) {
  if (GraphElement.is(line)) {
    elements[line.id as number] = line;

    if (Range.is(line) && line.tag?.type === RangeTagTypes.definition) {
      if (line.tag.text === "FunctionComponent") {
        componentTypeRanges.FunctionComponent = line;
      } else if (line.tag.text === "FC") {
        componentTypeRanges.FC = line;
      } else if (line.tag.text === "ClassComponent") {
        componentTypeRanges.ClassComponent = line;
      } else if (line.tag.text === "PureComponent") {
        componentTypeRanges.PureComponent = line;
      } else if (line.tag.text === "ComponentType") {
        componentTypeRanges.ComponentType = line;
      } else if (line.tag.text === "Component") {
        componentTypeRanges.Component = line;
      } else if (line.tag.text === "Element") {
        componentTypeRanges.Element = line;
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
            logger.debug("newRecordEntries", newItemEdgeMapEntries);
          }
        }
      })() as Record<ItemEdgeProperties | "undefined", number[]>);
      itemEdgeMap[it.property ?? "undefined"] = itemEdgeMap[it.property ?? "undefined"].concat(
        it.inVs as number[],
      );
    }
  } else if (line) {
    logger.error("Unknown line type", line);
  }
}

// #region Processing functions
function processTypeDefinitionReferences(range: Range, tags: [Tag, ...Tag[]]) {
  // {"id":584,"type":"vertex","label":"range","start":{"line":545,"character":14},"end":{"line":545,"character":31},"tag":{"type":"definition","text":"FunctionComponent","kind":11,"fullRange":{"start":{"line":545,"character":4},"end":{"line":551,"character":5}}}}
  const resultSetId = nextIndexOut[range.id as number][0]; // 581
  const referenceResultId = textDocument_referencesIndexOut[resultSetId]; // 930
  logger.debug("referenceResultId", referenceResultId);

  // TODO: Make this a function, and also apply it to the referenceResults for ClassComponent, PureComponent, and ComponentType
  itemIndexOut[referenceResultId]?.references.forEach((referenceId) => {
    // [588,645, 4261, 7043, 9735, 15832, 30761, 42710, 47293, 54658, 55255, 62295,62324, 77085, 79022, 99738]
    const reference = elements[referenceId];
    if (reference && Range.is(reference) && reference.tag?.type === RangeTagTypes.reference) {
      logger.debug("inner reference", inputStore.getLinkFromRange(reference), reference);

      // Find the surrounding fullRange on a range of type "definition"
      const definitionRanges = inputStore.findFullRangesFromPosition(
        inputStore.getDocumentFromRange(reference)?.uri ?? "",
        reference.start,
      );
      logger.debug(
        "definitionRanges",
        definitionRanges,
        definitionRanges?.map((r) => inputStore.getLinkFromRange(r))
      );

      // {"id":503,"type":"vertex","label":"range","start":{"line":32,"character":13},"end":{"line":32,"character":20},"tag":{"type":"definition","text":"Feature","kind":7,"fullRange":{"start":{"line":32,"character":13},"end":{"line":34,"character":19}}}}
      const definitionRange = definitionRanges?.[0];
      logger.debug(`definitionRange for inner reference`, definitionRange);

      if (definitionRange === undefined || !DefinitionRange.is(definitionRange)) {
        logger.error(
          `ERROR: No definition range found for ${reference.tag?.type}`,
          reference.tag?.text,
          `at ${reference.start.line}:${reference.start.character}`,
        );
        return;
      }

      processDefinitionRange(definitionRange, {
        kind: "widget" as ElementKind,
        tags: tags.slice(0) as [Tag, ...Tag[]], // Clone the array to prevent mutation
        technology: "React component",
      });
    }
  });
}

function processDefinitionRange(
  definitionRange: DefinitionRange,
  {
    kind,
    tags,
    technology,
  }: { kind: ElementKind; tags: [Tag, ...Tag[]]; technology: string | null },
  { defaultDescription }: { defaultDescription: string | null } = { defaultDescription: null },
): boolean {
  const resultSetId = nextIndexOut[definitionRange.id as number][0]; // 497, 621

  if (resultSetIdsProcessed.has(resultSetId)) {
    logger.warn(
      `Already processed resultSetId ${resultSetId} referenced by definition range [${
        definitionRange.id
      }](${inputStore.getLinkFromRange(definitionRange)})`,
    );
    return true;
  }

  resultSetIdsProcessed.add(resultSetId);
  logger.debug("processDefinitionRange resultSetId", resultSetId);

  const hoverIDs = outIndex.get(resultSetId)?.get(EdgeLabels.textDocument_hover);
  logger.debug("hoverIDs", hoverIDs);
  const hoverID = hoverIDs?.[0];
  logger.debug("hoverID", hoverID);
  const hover = elements[hoverID as number] as HoverResult;

  const tscMoniker = inputStore.getMonikerFromRange(definitionRange);
  logger.debug("tscMoniker", tscMoniker);
  if (tscMoniker === undefined) {
    throw new Error(
      `Expected a tsc moniker for [${definitionRange.id}](${inputStore.getLinkFromRange(
        definitionRange,
      )})`,
    );
  }

  logger.debug("getAlternateMonikers", inputStore.getAlternateMonikers(tscMoniker));

  const newId = monikerToFqn(inputStore.getMostUniqueMoniker(tscMoniker), argv.scopes);

  if (testRegex.test(inputStore.getDocumentFromRange(definitionRange)?.uri ?? "")) {
    tags.push("test" as Tag);
  }

  const [hoverText, hoverCode] = hoverToString(hover?.result) ?? [];

  const symbolName = definitionRange.tag?.text ?? tscMoniker.identifier.split(":").pop();

  logger.debug(
    `kind '${kind}' symbolName '${symbolName}' hoverText '${
      hoverCode ?? hoverText
    }' match ${Boolean(hoverCode && new RegExp(`type\\s+${symbolName}`).test(hoverCode))} kind ${
      kind === symbolKindAsElementKind(SymbolKind.Property) ? "===" : "!=="
    } '${symbolKindAsElementKind(SymbolKind.Property)}' hover.result '${JSON.stringify(
      hover?.result,
    )}'`,
  );
  if (typeElementKinds.includes(kind)) {
    tags.push(typeTag);
  } else if (
    hoverCode &&
    new RegExp(
      `type\\s+${symbolName}`, // Match TypeScript type aliases, which otherwise get marked as properties
    ).test(hoverCode)
  ) {
    tags.push(typeTag);

    kind = symbolName.startsWith("I")
      ? symbolKindAsElementKind(SymbolKind.Interface) ?? kind
      : typeAliasKind;

    if (technology === titleize(symbolKindAsElementKind(SymbolKind.Property) ?? "")) {
      technology = titleize(kind.replace("-", "_"));
    }
  }

  addElement(model, {
    description: hoverText && hoverText !== "" ? hoverText : defaultDescription ?? "",
    links: [inputStore.getLinkFromRange(definitionRange)],
    kind,
    id: newId,
    technology,
    title:
      definitionRange.tag?.text ??
      titleize(underscore(tscMoniker.identifier.split(":").pop() ?? "Unknown")),
    tags,
  });
  elementDefinitionRanges.set(newId, definitionRange);
  return true;
}
// #endregion Processing functions

const inputStore = new JsonStoreEnhanced();
await inputStore.load(argv.input.path, () => noopTransformer);

// Process the model and add all React components to the model

const elementDefinitionRanges = new Map<Fqn, DefinitionRange>();
const resultSetIdsProcessed = new Set<number>();

buildPackageMap(inputStore);

// Go through all widget types and find everything implementing them

Object.values(componentTypeRanges).map((r) =>
  processTypeDefinitionReferences(r, ["widget" as Tag, "component" as Tag, "react" as Tag]),
);

// Add all remaining elements to the model
inputStore.getDocumentInfos().forEach((docInfo) => {
  // TODO: Add documents themselves

  inputStore.documentSymbols(docInfo.uri)?.forEach((symbol) => {
    const symbolLink = locationToLink({ uri: docInfo.uri, range: symbol.range });
    logger.debug("document symbol", symbol, symbolLink);
    const definitionRanges = inputStore.findFullRangesFromPosition(docInfo.uri, symbol.range.start);

    logger.debug(
      "definitionRanges",
      definitionRanges,
      definitionRanges?.map((r) => inputStore.getLinkFromRange(r)),
    );

    const definitionRange = definitionRanges?.[0];
    logger.debug(`definitionRange for document symbol`, definitionRange);

    if (definitionRange === undefined || !DefinitionRange.is(definitionRange)) {
      logger.error(
        `ERROR: No definition range found for document symbol`,
        symbol.name,
        `at ${symbolLink}`,
      );
      return;
    }

    const kindName = underscore(getSymbolKindName(symbol.kind) ?? "document-symbol");
    processDefinitionRange(definitionRange, {
      kind: dasherize(kindName) as ElementKind,
      tags: ["document-symbol" as Tag],
      technology: titleize(kindName),
    });
  });
});

// Add all the references between elements that were included in the model as relationships

elementDefinitionRanges.forEach((reference, id) => {
  const referenceLocations = inputStore.references(
    inputStore.getDocumentFromRange(reference)?.uri ?? "",
    reference.start,
    {
      includeDeclaration: false,
    },
  );
  logger.debug("referenceLocations", referenceLocations?.map(locationToString));

  referenceLocations?.forEach((referencePosition) => {
    const definitionRanges = inputStore.findFullRangesFromPosition(
      referencePosition.uri,
      referencePosition.range.start,
    );
    // Find the surrounding fullRange on a range of type "definition"
    logger.debug(
      "definitionRanges",
      definitionRanges,
      definitionRanges?.map((r) => inputStore.getLinkFromRange(r)),
    );

    const definitionRange = definitionRanges?.[0];
    logger.debug(`definitionRange around reference range`, definitionRange);

    if (definitionRange === undefined || !DefinitionRange.is(definitionRange)) {
      logger.error(
        `ERROR: No definition range found for reference to ${id} "${reference.tag
          ?.text}" at ${locationToString(referencePosition)}`,
      );
      return;
    }

    if (definitionRange === reference) {
      // Skip self-references
      return;
    }

    const moniker = inputStore.getMonikerFromRange(definitionRange);

    if (moniker === undefined) {
      logger.error(
        `ERROR: No moniker found for ${definitionRange.tag?.text} at ${inputStore.getLinkFromRange(
          definitionRange,
        )}`,
      );
      return;
    }

    const referenceId = monikerToFqn(inputStore.getMostUniqueMoniker(moniker), argv.scopes);

    if (referenceId === id) {
      // Skip self-references

      // TODO: Skip imports without an error message

      logger.error(
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

          const kindName =
            symbolKindAsElementKind(definitionRange.tag.kind) ?? ("unknown" as ElementKind);
          const description = `Unknown element added for relation to ${id} "${reference.tag?.text}" to connect from`;

          if (
            !processDefinitionRange(
              definitionRange,
              {
                kind: kindName,
                tags,
                technology: kindName === "unknown" ? null : titleize(kindName),
              },
              {
                defaultDescription: description,
              },
            )
          ) {
            addElement(model, {
              description,
              links: [
                inputStore.getLinkFromRange(definitionRange),
                locationToString(referencePosition),
              ],

              kind: "unknown" as ElementKind,
              id: referenceId,
              technology: null,
              title:
                definitionRange.tag?.text ??
                titleize(underscore(moniker.identifier.split(":").pop() ?? "Unknown")),
              tags,
            });
          }

          model.addRelation(newRelation);
        }
      }
    }
  });
});

if (argv.scopes) {
  addElementsForScopes(model);
}

logger.debug("modelIndex as JSON", JSON.stringify(model, null, 2));

logger.debug(
  "elements and relations as JSON",
  JSON.stringify({ elements: model.elements, relations: model.relations }, null, 2),
);

// Output the model

console.log(`\n// LikeC4 DSL for ${argv.input.path}`)
console.log(modelIndexToDsl(model));
