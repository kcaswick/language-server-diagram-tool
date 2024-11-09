import { describe, it, expect, beforeEach, vi } from "vitest";
import { Element as C4Element, ModelIndex, ElementKind, Tag, Fqn, RelationID } from "@likec4/core";
import { default as fs } from "fs-extra";
import { Moniker, DefinitionRange } from "lsif-protocol";
import pino from "pino";
import readline from "readline";
import { SymbolKind, DocumentSymbol } from "vscode-languageserver-protocol";
import type { Arguments } from "yargs";

import type {
  addElement,
  addElementsForScopes,
  buildPackageMap,
  getElementDefaultsForSymbolKind,
  monikerToFqn,
  processDefinitionRange,
  processDocumentSymbol,
  modelIndexToDsl,
} from "../extract-react-component-diagram.mts";
import { JsonStoreEnhanced } from "../jsonStoreEnhanced";

describe("extract-react-component-diagram", () => {
  let model: ModelIndex;
  let logger: pino.Logger<
    pino.LoggerOptions & {
      customLevels: {
        debugJsonStore: number;
      };
      level: string;
    }
  >;
  let inputStore: JsonStoreEnhanced;

  beforeEach(() => {
    model = new ModelIndex();
    logger = pino({
      customLevels: {
        debugJsonStore: pino.levels.values.debug - 20,
      },
      level: "silent",
    }) as pino.Logger<
      pino.LoggerOptions & { customLevels: { debugJsonStore: number }; level: string }
    >;
    inputStore = new JsonStoreEnhanced(logger);
  });

  it("should add an element to the model", () => {
    const element: C4Element = {
      id: "testElement" as Fqn,
      kind: "component" as ElementKind,
      title: "Test Element",
      description: "A test element",
      technology: "TestTech",
      tags: ["test" as Tag],
      links: null,
    };
    addElement(model, element);
    expect(model.elements).toContainEqual(element);
  });

  it("should add elements for scopes correctly", () => {
    const trie = {
      children: {
        scope1: { children: {} },
        scope2: { children: {} },
      },
    };
    addElementsForScopes(model, "" as Fqn, trie);
    expect(model.elements).toHaveLength(2);
    expect(model.elements.map((el) => el.id)).toContain("scope1");
    expect(model.elements.map((el) => el.id)).toContain("scope2");
  });

  it("should build package map correctly", () => {
    // Mock inputStore methods and data
    inputStore.getVerticesWithLabel = vi
      .fn()
      .mockReturnValue([{ id: 1, label: "packageInformation", name: "testPackage" }]);
    inputStore.getMonikersForPackage = vi
      .fn()
      .mockReturnValue([{ id: 2, scheme: "npm", identifier: "testPackage:1.0.0" }]);
    buildPackageMap(inputStore);
    expect(inputStore.getVerticesWithLabel).toHaveBeenCalled();
    expect(inputStore.getMonikersForPackage).toHaveBeenCalled();
  });

  it("should return correct defaults for symbol kinds", () => {
    const defaults = getElementDefaultsForSymbolKind(SymbolKind.Class, "unknown" as ElementKind);
    expect(defaults.kind).toBe("class");
    expect(defaults.technology).toBe("Class");
  });

  it("should convert moniker to FQN correctly", () => {
    const moniker = { scheme: "npm", identifier: "testPackage:1.0.0" } as Moniker;
    const fqn = monikerToFqn(moniker, true);
    expect(fqn).toBe("testPackage_pkg.1_0_0");
  });

  it("should process definition range correctly", () => {
    const definitionRange = {
      id: 1,
      tag: { kind: SymbolKind.Class, text: "TestClass" },
    } as DefinitionRange;
    const result = processDefinitionRange(
      definitionRange,
      {
        kind: "class" as ElementKind,
        tags: ["test" as Tag],
        technology: "TestTech",
      },
      { defaultDescription: "Test Description" },
    );
    expect(result).toBe(true);
    expect(model.elements).toHaveLength(1);
    expect(model.elements[0].id).toBe("TestClass");
  });

  it("should process document symbol correctly", () => {
    const docInfo = { uri: "testUri", id: "testId", hash: "testHash" };
    const symbol = {
      name: "TestSymbol",
      kind: SymbolKind.Class,
      range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
    } as DocumentSymbol;
    processDocumentSymbol(docInfo, symbol);
    expect(model.elements).toHaveLength(1);
    expect(model.elements[0].id).toBe("TestSymbol");
  });

  it("should convert model index to DSL correctly", () => {
    const element: C4Element = {
      id: "testElement" as Fqn,
      kind: "component" as ElementKind,
      title: "Test Element",
      description: "A test element",
      technology: "TestTech",
      tags: ["test" as Tag],
      links: null,
    };
    addElement(model, element);
    const dsl = modelIndexToDsl(model);
    expect(dsl).toContain("testElement = component 'Test Element' 'A test element' 'TestTech'");
  });

  it("should run the entire script and generate the correct output", async () => {
    // Mock dependencies and functions
    vi.mock("fs-extra");
    vi.mock("readline");
    vi.mock("yargs");
    vi.mock("yargs/helpers");
    vi.mock("./jsonStoreEnhanced");
    vi.mock("@likec4/core");
    vi.mock("lsif-protocol");
    vi.mock("vscode-languageserver-protocol");
    vi.mock("pino");

    // Simulate command-line arguments
    const argv/* : Arguments<{
        include: RegExp | undefined;
        // input: ReturnType<typeof coerceFile>;
        logLevel: pino.LevelWithSilent;
        scopes: boolean;
        stdin: boolean;
      }> */ = {
      input: { path: "test.lsif", lines: [] },
      include: undefined,
      logLevel: "info",
      scopes: true,
      stdin: false,
    };
    vi.doMock("yargs");
    const yargs = require('yargs');
    vi.spyOn(yargs, "command").mockImplementation(() => {throw "Used mock";});
    vi.spyOn(yargs, "parseSync").mockReturnValue(argv);

    // Mock inputStore methods and data
    inputStore.load = vi.fn().mockResolvedValue(undefined);
    inputStore.getVerticesWithLabel = vi.fn().mockReturnValue([]);
    inputStore.getMonikersForPackage = vi.fn().mockReturnValue([]);
    inputStore.getDocumentInfos = vi.fn().mockReturnValue([]);
    inputStore.documentSymbols = vi.fn().mockReturnValue([]);
    inputStore.getRangesForMoniker = vi.fn().mockReturnValue([]);
    inputStore.references = vi.fn().mockReturnValue([]);
    inputStore.findFullRangesFromPosition = vi.fn().mockReturnValue([]);
    inputStore.getMonikerFromRange = vi.fn().mockReturnValue(undefined);
    inputStore.getMostUniqueMoniker = vi.fn().mockReturnValue({ identifier: "test:1.0.0" });
    inputStore.getLinkFromRange = vi.fn().mockReturnValue("testLink");
    inputStore.getAlternateMonikers = vi.fn().mockReturnValue([]);
    inputStore.getContainersForMoniker = vi.fn().mockReturnValue({});

    // Mock fs and readline
    vi.spyOn(fs, "createReadStream").mockReturnValue({} as any);
    vi.spyOn(readline, "createInterface").mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield JSON.stringify({
          id: 1,
          type: "vertex",
          label: "range",
          start: { line: 0, character: 0 },
          end: { line: 1, character: 0 },
          tag: { type: "definition", text: "TestComponent", kind: SymbolKind.Class },
        });
      },
    } as any);

    // Run the script
    await import("../extract-react-component-diagram.mts");

    // Verify the output
    expect(model.elements).toHaveLength(1);
    expect(model.elements[0].id).toBe("testComponent");
    expect(model.elements[0].kind).toBe("class");
    expect(model.elements[0].title).toBe("TestComponent");
    expect(model.elements[0].description).toBe("");
    expect(model.elements[0].technology).toBe("Class");
    expect(model.elements[0].tags).toContain("document-symbol");
  });
});
