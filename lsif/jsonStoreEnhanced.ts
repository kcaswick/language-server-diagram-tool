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
}
