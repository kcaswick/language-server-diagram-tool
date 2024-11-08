/* eslint-disable dot-notation -- This file uses brackets a lot to access private members */
import * as lsp from "vscode-languageserver-protocol";

import { JsonStore } from "./lsif-server-modules/jsonStore";
import {
  Document,
  EdgeLabels,
  Id,
  ItemEdgeProperties,
  Moniker,
  PackageInformation,
  Project,
  Range,
  RangeTagTypes,
  Vertex,
  VertexLabels,
} from "lsif-protocol";
import { monikerUniqueShortForms } from "lsif-sqlite/lib/compress";
import { pino } from "pino";

type In = JsonStore["in"] & {
  attach: Map<Id, Moniker>;
  next: Map<Id, Vertex[]>;
  packageInformation: Map<Id, Moniker[]>;
};
type Out = JsonStore["out"] & {
  attach: Map<Id, Moniker>;
};

export interface IVertexContainers {
  document: Document;
  project: Project;
  range: Range;
  workspace: URL;
}

export class JsonStoreEnhanced extends JsonStore {
  protected get inEnhanced(): In {
    return this["in"] as In;
  }

  private logger;

  protected get outEnhanced() {
    return this["out"] as Out;
  }

  private superDoProcessEdge: (
    label: EdgeLabels,
    outV: Id,
    inV: Id,
    property?: ItemEdgeProperties | undefined,
  ) => void;

  constructor(
    logger: pino.Logger<
      pino.LoggerOptions & {
        customLevels: {
          debugJsonStore: number;
        };
      }
    >,
  ) {
    super();

    this.logger = logger;

    this.inEnhanced.attach = new Map();
    this.inEnhanced.next = new Map();
    this.inEnhanced.packageInformation = new Map();

    this.outEnhanced.attach = new Map<Id, Moniker>();

    this.superDoProcessEdge = this["doProcessEdge"];
    this["doProcessEdge"] = this.doProcessEdgeEnhanced;
  }

  private doProcessEdgeEnhanced(
    label: EdgeLabels,
    outV: Id,
    inV: Id,
    property?: ItemEdgeProperties,
  ): void {
    super["doProcessEdge"](label, outV, inV, property);
    const from: Vertex | undefined = this["vertices"].all.get(outV);
    const to: Vertex | undefined = this["vertices"].all.get(inV);
    if (from === undefined) {
      throw new Error(`No vertex found for Id ${outV}`);
    }

    if (to === undefined) {
      throw new Error(`No vertex found for Id ${inV}`);
    }

    let values: Vertex[] | undefined;
    switch (label) {
      case EdgeLabels.attach:
        this.inEnhanced.attach.set(to.id, from as Moniker);
        this.outEnhanced.attach.set(from.id, to as Moniker);
        break;

      case EdgeLabels.next:
        values = this.inEnhanced.next.get(to.id);
        if (values === undefined) {
          values = [];
          this.inEnhanced.next.set(to.id, values);
        }

        values.push(from);
        break;

      case EdgeLabels.packageInformation:
        values = this.inEnhanced.packageInformation.get(to.id);
        if (values === undefined) {
          values = [];
          this.inEnhanced.packageInformation.set(to.id, values as Moniker[]);
        }

        values.push(from as Moniker);
        break;

      default:
        break;
    }
  }

  public findFullRangesFromPosition(file: string, position: lsp.Position): Range[] | undefined {
    const value = this["indices"].documents.get(file);
    if (value === undefined) {
      return undefined;
    }

    const result: Range[] = [];
    for (const document of value.documents) {
      const { id } = document;
      const contains = this["out"].contains.get(id);
      if (contains === undefined || contains.length === 0) {
        return undefined;
      }

      let candidate: Range | undefined;
      for (const item of contains) {
        if (
          item.label !== VertexLabels.range ||
          item.tag === undefined ||
          !(
            item.tag.type === RangeTagTypes.definition ||
            item.tag.type === RangeTagTypes.declaration
          )
        ) {
          continue;
        }

        if (item.tag.text === "") {
          // Exclude the range that covers the entire document
          continue;
        }

        if (JsonStore["containsPosition"](item.tag.fullRange, position)) {
          if (!candidate) {
            candidate = item;
          } else if (JsonStore.containsRange(candidate, item.tag.fullRange)) {
            candidate = item;
          }
        }
      }

      if (candidate !== undefined) {
        result.push(candidate);
      }
    }

    return result.length > 0 ? result : undefined;
  }

  // Maybe   public /* private */ findRangesFromPosition(file: string, position: lsp.Position): Range[] | undefined {

  public getDocumentFromRange(range: Range) {
    const candidate = this["in"].contains.get(range.id);
    return Document.is(candidate) ? candidate : undefined;
  }

  public getLinkFromRange(range: Range) {
    return locationToString({ uri: this.getDocumentFromRange(range)?.uri ?? "", range }).split(
      " - ",
    )[0];
  }

  /**
   * Returns the monikers associated with the given package by a packageInformation edge.
   * @param pkg The package information or vertex to get the monikers for.
   * @returns An array of monikers associated with the package. Returns an empty array if no monikers are found.
   */
  public getMonikersForPackage(pkg: PackageInformation | Vertex) {
    const monikers = this["inEnhanced"].packageInformation.get(pkg.id);
    return monikers ?? [];
  }

  public getMonikerFromRange(range: Range) {
    const resultPath = this["getResultPath"](range.id, this["out"].references);
    this.logger.debugJsonStore(
      "resultPath.path",
      resultPath.path.map(
        (p) =>
          `vertex: ${p.vertex} -> moniker: #${p.moniker?.id} scheme: ${p.moniker?.scheme} '${p.moniker?.identifier}' kind: ${p.moniker?.kind} unique: ${p.moniker?.unique}`,
      ),
      "resultPath.result",
      resultPath.result,
    );
    if (resultPath.result === undefined) {
      return;
    }

    const mostSpecificMoniker = this["getMostSpecificMoniker"](resultPath);
    return mostSpecificMoniker;
  }

  public getAlternateMonikers(moniker: Moniker) {
    const results: Moniker[] = [];
    this.followAttachEdges(moniker, results);

    // Check for additional resultSets
    const resultSets = this["in"].moniker.get(moniker.id);
    this.logger.debugJsonStore("resultSets", resultSets);
    const resultSetFilter = (v: Vertex): boolean => v.label === VertexLabels.resultSet;
    resultSets?.forEach((resultSet) => {
      const nextResultSets = (this.inEnhanced.next.get(resultSet.id) ?? []).filter(resultSetFilter);
      this.logger.debugJsonStore("nextResultSets", nextResultSets);
      while (nextResultSets.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- We just checked the array has elements above
        const nextResultSet = nextResultSets.pop()!;
        if (nextResultSet.label !== VertexLabels.resultSet) {
          continue;
        }

        const moniker = this["out"].moniker.get(nextResultSet.id);
        // Disable debug output -
        this.logger.debugJsonStore("moniker", moniker);
        if (moniker !== undefined) {
          results.push(moniker);
          this.followAttachEdges(moniker, results);
        }

        nextResultSets.push(
          ...(this.inEnhanced.next.get(nextResultSet.id) ?? []).filter(resultSetFilter),
        );
        this.logger.debugJsonStore("nextResultSets after push", nextResultSets);
      }
    });

    return results;
  }

  protected followAttachEdges(moniker: Moniker, results: Moniker[]) {
    let nextMoniker: Moniker | undefined = moniker;
    while ((nextMoniker = this.inEnhanced.attach.get(nextMoniker.id)) !== undefined) {
      results.push(nextMoniker);
    }
  }

  private followAttachEdgesReversed(moniker: Moniker, vertices: Vertex[] | undefined) {
    let prevMoniker = this.outEnhanced.attach.get(moniker.id);
    while (prevMoniker !== undefined && vertices === undefined) {
      vertices = this["findVerticesForMoniker"]({ key: "", ...prevMoniker });
      prevMoniker = this.outEnhanced.attach.get(prevMoniker.id);
    }

    return vertices;
  }

  public getContainersForMoniker(moniker: Moniker) {
    const containers: Partial<IVertexContainers> = {
      workspace: this.getWorkspaceRoot(),
    };

    this.getRangesForMoniker(moniker).forEach((range) => {
      containers.range = range;
      containers.document = this.getDocumentFromRange(range);
      if (containers.document !== undefined) {
        containers.project = this["in"].contains.get(containers.document.id) as Project;
      }

      this.logger.debugJsonStore("containers", {
        document: String(containers.document?.uri),
        project: String(containers.project?.name),
        workspace: String(containers.workspace?.href),
      });
    });

    return containers;
  }

  public getRangesForMoniker(moniker: Moniker): Range[] {
    let vertices = this["findVerticesForMoniker"]({ key: "", ...moniker });
    if (vertices === undefined) {
      // Does not work for the npm moniker, so go to a previous one
      vertices = this.followAttachEdgesReversed(moniker, vertices);
    }

    // Debugging disabled-
    // this.logger.debugJsonStore("vertices", vertices);
    if (vertices === undefined) {
      return [];
    }

    return vertices.flatMap((vertex) => {
      const resultPath = this["getResultPath"](vertex.id, this.inEnhanced.next);
      // Debugging disabled-
      // this.logger.debugJsonStore(
      //   `getRangesForMoniker '${moniker.identifier}' vertex`,
      //   vertex,
      //   "resultPath.path",
      //   resultPath.path.map(
      //     (p) =>
      //       `vertex: ${p.vertex} -> moniker: #${p.moniker?.id} scheme: ${p.moniker?.scheme} '${p.moniker?.identifier}' kind: ${p.moniker?.kind} unique: ${p.moniker?.unique}`,
      //   ),
      //   "resultPath.result",
      //   resultPath.result,
      // );
      if (resultPath.result === undefined) {
        return [];
      }

      return resultPath.result.value.filter(Range.is).map((v) => {
        return v as Range;
      });
    });
  }

  public getMostUniqueMoniker(moniker: Moniker) {
    const alternateMonikers = this.getAlternateMonikers(moniker);
    if (alternateMonikers.length === 0) {
      return moniker;
    }

    const mostUniqueMoniker = alternateMonikers.reduce((a, b) =>
      (monikerUniqueShortForms.get(a.unique) ?? -1) > (monikerUniqueShortForms.get(b.unique) ?? -1)
        ? a
        : b,
    );
    return mostUniqueMoniker;
  }

  public getVerticesWithLabel(label: VertexLabels) {
    return Array.from(this["vertices"].all.values()).filter((v: Vertex) => v.label === label);
  }
} // End of class JsonStoreEnhanced

/**
 * Converts a given location object to a link.
 * @param r The location object to convert.
 * @returns The link portion of the string representation of the location.
 */
export const locationToLink = (r: lsp.Location) => locationToString(r).split(" - ")[0];

/**
 * Converts a location object to a string in the format "uri:startLine:startCharacter:endLine:endCharacter".
 * @param r The location object to convert.
 * @returns A string representation of the location object.
 */
export const locationToString = (r: lsp.Location) =>
  `${r.uri}:${r.range.start.line + 1}:${r.range.start.character + 1} - ${r.range.end.line + 1}:${
    r.range.end.character + 1
  }`;
