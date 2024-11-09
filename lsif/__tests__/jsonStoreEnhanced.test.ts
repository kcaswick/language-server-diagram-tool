import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as lsp from 'vscode-languageserver-protocol';
import { JsonStoreEnhanced } from '../jsonStoreEnhanced';
import { JsonStore } from '../lsif-server-modules/jsonStore';
import { Document, EdgeLabels, ElementTypes, Id, ItemEdgeProperties, Moniker, PackageInformation, Project, Range, RangeTagTypes, UniquenessLevel, Vertex, VertexLabels } from 'lsif-protocol';
import { pino } from 'pino';

describe('JsonStoreEnhanced', () => {
  let jsonStoreEnhanced: JsonStoreEnhanced;
  let logger: pino.Logger<
    pino.LoggerOptions & {
      customLevels: {
        debugJsonStore: number;
      };
      level: string;
    }
  >;

  beforeEach(() => {
    logger = pino({
        customLevels: {
          debugJsonStore: pino.levels.values.debug - 20,
        },
        level: "silent",
      }) as pino.Logger<
        pino.LoggerOptions & { customLevels: { debugJsonStore: number }; level: string }
      >;
    jsonStoreEnhanced = new JsonStoreEnhanced(logger);
  });

  it('should process edges correctly and update maps', () => {
    const fromVertex = { id: 1, label: VertexLabels.moniker } as Vertex;
    const toVertex = { id: 2, label: VertexLabels.moniker } as Vertex;
    jsonStoreEnhanced['vertices'].all.set(1, fromVertex);
    jsonStoreEnhanced['vertices'].all.set(2, toVertex);

    jsonStoreEnhanced['doProcessEdgeEnhanced'](EdgeLabels.attach, 1, 2);

    expect(jsonStoreEnhanced['inEnhanced'].attach.get(2)).toBe(fromVertex);
    expect(jsonStoreEnhanced['outEnhanced'].attach.get(1)).toBe(toVertex);
  });

  it('should find full ranges from position correctly', () => {
    const range = { id: 1, label: VertexLabels.range, tag: { type: RangeTagTypes.definition, fullRange: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } } } as Range;
    jsonStoreEnhanced['indices'].documents.set('testFile', { hash: 'testHash', documents: [{ id: 1, label: VertexLabels.document, languageId: 'testLanguage', type: ElementTypes.vertex, uri: 'testUri' }] });
    jsonStoreEnhanced['out'].contains.set(1, [range]);

    const result = jsonStoreEnhanced.findFullRangesFromPosition('testFile', { line: 0, character: 0 });

    expect(result).toContain(range);
  });

  it('should return correct document for a given range', () => {
    const document = { id: 1, label: VertexLabels.document, languageId: 'testLanguage', type: ElementTypes.vertex, uri: 'testUri' } as Document;
    const range = { id: 2 } as Range;
    jsonStoreEnhanced['in'].contains.set(2, document);

    const result = jsonStoreEnhanced.getDocumentFromRange(range);

    expect(result).toBe(document);
  });

  it('should return correct link for a given range', () => {
    const document = {
      id: 1,
      type: ElementTypes.vertex,
      label: VertexLabels.document,
      languageId: "typescript",
      uri: "testUri",
    } as Document;
    const rangeStart = { line: 0, character: 0 };
    const rangeEnd = { line: 1, character: 0 };
    const range = {
      id: 2,
      type: ElementTypes.vertex,
      label: VertexLabels.range,
      start: rangeStart,
      end: rangeEnd,
      tag: {
        type: "definition",
        text: "React",
        kind: 7,
        fullRange: { start: { line: 34, character: 0 }, end: { line: 3147, character: 1 } },
      },
    } as Range;
    jsonStoreEnhanced['in'].contains.set(2, document);

    const result = jsonStoreEnhanced.getLinkFromRange(range);

    expect(result).toBe('testUri:1:1');
  });

  it('should return correct monikers for a given package', () => {
    const moniker = { id: 1 } as Moniker;
    const pkg = { id: 2 } as PackageInformation;
    jsonStoreEnhanced['inEnhanced'].packageInformation.set(2, [moniker]);

    const result = jsonStoreEnhanced.getMonikersForPackage(pkg);

    expect(result).toContain(moniker);
  });

  it('should return correct moniker for a given range', () => {
    const moniker = {
      id: 1,
      scheme: "npm",
      identifier: "testPackage:1.0.0",
      type: ElementTypes.vertex,
      label: VertexLabels.moniker,
      key: "hash",
      unique: UniquenessLevel.scheme,
    } as Moniker & { key: string; };
    const range = { id: 2, type: ElementTypes.vertex, label: VertexLabels.range } as Range;
    jsonStoreEnhanced['out'].moniker.set(2, moniker);
    jsonStoreEnhanced['getResultPath'] = vi.fn().mockReturnValue({ path: [], result: { value: [moniker], moniker } });

    const result = jsonStoreEnhanced.getMonikerFromRange(range);

    expect(result).toBe(moniker);
  });

  it('should return correct alternate monikers for a given moniker', () => {
    const moniker = { id: 1 } as Moniker;
    const alternateMoniker = { id: 2 } as Moniker;
    jsonStoreEnhanced['inEnhanced'].attach.set(1, alternateMoniker);

    const result = jsonStoreEnhanced.getAlternateMonikers(moniker);

    expect(result).toContain(alternateMoniker);
  });

  it('should return correct containers for a given moniker', () => {
    const moniker = { id: 1 } as Moniker;
    const range = { id: 2 } as Range;
    const document = { id: 3, uri: 'testUri' } as Document;
    const project = { id: 4, name: 'testProject' } as Project;
    jsonStoreEnhanced['getRangesForMoniker'] = vi.fn().mockReturnValue([range]);
    jsonStoreEnhanced['getDocumentFromRange'] = vi.fn().mockReturnValue(document);
    jsonStoreEnhanced['in'].contains.set(3, project);

    const result = jsonStoreEnhanced.getContainersForMoniker(moniker);

    expect(result.range).toBe(range);
    expect(result.document).toBe(document);
    expect(result.project).toBe(project);
  });

  it('should return correct ranges for a given moniker', () => {
    const moniker = { id: 1, type: ElementTypes.vertex, label: VertexLabels.moniker } as Moniker;
    const range = {
      id: 2,
      type: ElementTypes.vertex,
      label: VertexLabels.range,
      start: { line: 0, character: 0 },
      end: { line: 1, character: 0 },
    } as Range;
    jsonStoreEnhanced['in'].moniker.set(2, [moniker]);
    jsonStoreEnhanced['findVerticesForMoniker'] = vi.fn().mockReturnValue([{ id: 3 }]);
    jsonStoreEnhanced['followAttachEdgesReversed'] = vi.fn().mockReturnValue([{ id: 3 }]);
    jsonStoreEnhanced['getResultPath'] = vi.fn().mockReturnValue({ path: [], result: { value: [range] } });

    const result = jsonStoreEnhanced.getRangesForMoniker(moniker);

    expect(result).toContain(range);
  });

  it('should return most unique moniker correctly', () => {
    const moniker = {
      id: 1,
      unique: UniquenessLevel.document,
      scheme: "tsc",
      identifier: "test",
      type: ElementTypes.vertex,
      label: VertexLabels.moniker,
    } as Moniker;
    const alternateMoniker = {
      id: 2,
      unique: UniquenessLevel.project,
      type: ElementTypes.vertex,
      label: VertexLabels.moniker,
    } as Moniker;
    jsonStoreEnhanced['getAlternateMonikers'] = vi.fn().mockReturnValue([alternateMoniker]);

    const result = jsonStoreEnhanced.getMostUniqueMoniker(moniker);

    expect(result).toBe(alternateMoniker);
  });

  it('should return correct vertices for a given label', () => {
    const vertex = { id: 1, label: VertexLabels.moniker } as Vertex;
    jsonStoreEnhanced['vertices'].all.set(1, vertex);

    const result = jsonStoreEnhanced.getVerticesWithLabel(VertexLabels.moniker);

    expect(result).toContain(vertex);
  });
});