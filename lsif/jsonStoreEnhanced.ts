/* eslint-disable dot-notation -- This file uses brackets a lot to access private members */
import * as lsp from "vscode-languageserver-protocol";

import { JsonStore } from "./lsif-server-modules/jsonStore";
import { DeclarationRange, DefinitionRange, Document, Range, RangeTagTypes, VertexLabels } from "lsif-protocol";

export class JsonStoreEnhanced extends JsonStore {
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

  public getMonikerFromRange(range: Range) {
    const resultPath = this["getResultPath"](range.id, this["out"].references);
    // Debugging disabled- console.debug(
    //   "resultPath.path",
    //   resultPath.path.map(
    //     (p) =>
    //       `vertex: ${p.vertex} -> moniker: #${p.moniker?.id} scheme: ${p.moniker?.scheme} '${p.moniker?.identifier}' kind: ${p.moniker?.kind} unique: ${p.moniker?.unique}`,
    //   ),
    //   "resultPath.result",
    //   resultPath.result,
    // );
    if (resultPath.result === undefined) {
      return;
    }

    const mostSpecificMoniker = this["getMostSpecificMoniker"](resultPath);
    return mostSpecificMoniker;
  }
}

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
