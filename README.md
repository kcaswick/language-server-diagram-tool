# language-server-diagram-tool [![NPM version][npm-image]][npm-url]

> A tool to export diagrams of programs, read via language servers or LSIF (language server index format)

## Installation

```sh
$ npm install --save-dev language-server-diagram-tool
```

## Usage

```sh
lsif tsc -p ../vscode-lsif-extension/tsconfig.json --package ../vscode-lsif-extension/package.json --out temp/vscode-lsif-extension.lsif.jsonl
ts-node ./lsif/extract-react-component-diagram.mts temp/vscode-lsif-extension.lsif.jsonl
```

## License

MIT © [Kevin C.]()

[npm-image]: https://badge.fury.io/js/language-server-diagram-tool.svg
[npm-url]: https://npmjs.org/package/language-server-diagram-tool
