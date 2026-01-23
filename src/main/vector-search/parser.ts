import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import CSharp from 'tree-sitter-c-sharp';
import type { ChunkType, SymbolType } from '../../shared/types';

export interface ParsedChunk {
  content: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
}

export interface ParsedSymbol {
  name: string;
  symbolType: SymbolType;
  line: number;
  column: number;
  signature: string | null;
  parentName: string | null;
}

export interface ParseResult {
  chunks: ParsedChunk[];
  symbols: ParsedSymbol[];
}

const parsers: Map<string, Parser> = new Map();

function getParser(language: string): Parser | null {
  if (parsers.has(language)) {
    return parsers.get(language)!;
  }

  const parser = new Parser();
  let lang: any;

  switch (language) {
    case 'typescript':
      lang = TypeScript.typescript;
      break;
    case 'tsx':
      lang = TypeScript.tsx;
      break;
    case 'javascript':
      lang = JavaScript;
      break;
    case 'python':
      lang = Python;
      break;
    case 'c_sharp':
      lang = CSharp;
      break;
    default:
      return null;
  }

  parser.setLanguage(lang);
  parsers.set(language, parser);
  return parser;
}

export function parseCode(content: string, language: string): ParseResult {
  const parser = getParser(language);

  if (!parser) {
    return fallbackParse(content);
  }

  const tree = parser.parse(content);
  const chunks: ParsedChunk[] = [];
  const symbols: ParsedSymbol[] = [];

  extractNodes(tree.rootNode, content, chunks, symbols, language);

  // If no chunks found, use fallback
  if (chunks.length === 0) {
    return fallbackParse(content);
  }

  return { chunks, symbols };
}

function extractNodes(
  node: Parser.SyntaxNode,
  content: string,
  chunks: ParsedChunk[],
  symbols: ParsedSymbol[],
  language: string,
  parentName: string | null = null
): void {
  const nodeTypes = getRelevantNodeTypes(language);

  if (nodeTypes.functions.includes(node.type)) {
    const name = getNodeName(node, language);
    const signature = getSignature(node, content);

    if (name) {
      symbols.push({
        name,
        symbolType: 'function',
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        signature,
        parentName,
      });
    }

    chunks.push({
      content: node.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      chunkType: 'function',
    });
    return; // Don't recurse into functions
  }

  if (nodeTypes.classes.includes(node.type)) {
    const name = getNodeName(node, language);

    if (name) {
      symbols.push({
        name,
        symbolType: 'class',
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        signature: null,
        parentName,
      });

      // Recurse with class name as parent
      for (const child of node.children) {
        extractNodes(child, content, chunks, symbols, language, name);
      }
    }

    chunks.push({
      content: node.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      chunkType: 'class',
    });
    return;
  }

  if (nodeTypes.methods.includes(node.type)) {
    const name = getNodeName(node, language);
    const signature = getSignature(node, content);

    if (name) {
      symbols.push({
        name,
        symbolType: 'method',
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        signature,
        parentName,
      });
    }

    chunks.push({
      content: node.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      chunkType: 'method',
    });
    return;
  }

  if (nodeTypes.interfaces.includes(node.type)) {
    const name = getNodeName(node, language);

    if (name) {
      symbols.push({
        name,
        symbolType: 'interface',
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        signature: null,
        parentName,
      });
    }

    chunks.push({
      content: node.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      chunkType: 'interface',
    });
    return;
  }

  // Recurse into children
  for (const child of node.children) {
    extractNodes(child, content, chunks, symbols, language, parentName);
  }
}

function getRelevantNodeTypes(language: string): {
  functions: string[];
  classes: string[];
  methods: string[];
  interfaces: string[];
} {
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
      return {
        functions: ['function_declaration', 'arrow_function', 'function_expression'],
        classes: ['class_declaration'],
        methods: ['method_definition'],
        interfaces: ['interface_declaration', 'type_alias_declaration'],
      };
    case 'python':
      return {
        functions: ['function_definition'],
        classes: ['class_definition'],
        methods: ['function_definition'], // Methods are also function_definition in Python
        interfaces: [],
      };
    case 'c_sharp':
      return {
        functions: ['method_declaration', 'local_function_statement'],
        classes: ['class_declaration', 'struct_declaration'],
        methods: ['method_declaration'],
        interfaces: ['interface_declaration'],
      };
    default:
      return { functions: [], classes: [], methods: [], interfaces: [] };
  }
}

function getNodeName(node: Parser.SyntaxNode, language: string): string | null {
  // Try common name field patterns
  const nameNode = node.childForFieldName('name') ??
                   node.children.find(c => c.type === 'identifier' || c.type === 'property_identifier');

  return nameNode?.text ?? null;
}

function getSignature(node: Parser.SyntaxNode, content: string): string | null {
  // Get first line as signature (simplified)
  const firstLineEnd = node.text.indexOf('\n');
  if (firstLineEnd === -1) return node.text;
  return node.text.substring(0, firstLineEnd).trim();
}

function fallbackParse(content: string): ParseResult {
  const lines = content.split('\n');
  const chunks: ParsedChunk[] = [];
  const CHUNK_SIZE = 50;

  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    const chunkLines = lines.slice(i, i + CHUNK_SIZE);
    chunks.push({
      content: chunkLines.join('\n'),
      startLine: i + 1,
      endLine: Math.min(i + CHUNK_SIZE, lines.length),
      chunkType: 'block',
    });
  }

  return { chunks, symbols: [] };
}
