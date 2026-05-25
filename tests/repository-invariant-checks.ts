import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";

export interface SourceTextFile {
  relativePath: string;
  text: string;
}

export interface LocalJavaScriptImportSpecifierViolation {
  relativePath: string;
  specifier: string;
  line: number;
  column: number;
}

export interface RepositoryInvariantViolations {
  disallowedJavaScriptFiles: string[];
  localJavaScriptImportSpecifiers: LocalJavaScriptImportSpecifierViolation[];
}

const EXCLUDED_DIRECTORY_PREFIXES = [
  ".git/",
  "coverage/",
  "dist/",
  "docs/",
  "node_modules/",
];
const DISALLOWED_JAVASCRIPT_FILE_PATTERN = /\.(?:cjs|mjs|js)$/u;
const TYPESCRIPT_FILE_PATTERN = /\.(?:cts|mts|tsx?)$/u;

export function findRepositoryInvariantViolations(
  repositoryRoot: string,
): RepositoryInvariantViolations {
  const repositoryFiles = listRepositoryFiles(repositoryRoot);
  const typeScriptTextFiles = repositoryFiles
    .filter(isTypeScriptFilePath)
    .map((relativePath) => {
      return {
        relativePath,
        text: readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
      };
    });

  return {
    disallowedJavaScriptFiles: findDisallowedJavaScriptFiles(repositoryFiles),
    localJavaScriptImportSpecifiers:
      findLocalJavaScriptImportSpecifiers(typeScriptTextFiles),
  };
}

export function findDisallowedJavaScriptFiles(
  relativePaths: string[],
): string[] {
  return sortUniquePaths(
    relativePaths.map(normalizeRepositoryPath).filter((relativePath) => {
      return (
        !isExcludedRepositoryPath(relativePath) &&
        DISALLOWED_JAVASCRIPT_FILE_PATTERN.test(relativePath)
      );
    }),
  );
}

export function findLocalJavaScriptImportSpecifiers(
  sourceTextFiles: SourceTextFile[],
): LocalJavaScriptImportSpecifierViolation[] {
  const violations: LocalJavaScriptImportSpecifierViolation[] = [];

  for (const sourceTextFile of sourceTextFiles) {
    const relativePath = normalizeRepositoryPath(sourceTextFile.relativePath);
    if (
      isExcludedRepositoryPath(relativePath) ||
      !isTypeScriptFilePath(relativePath)
    ) {
      continue;
    }

    const sourceFile = ts.createSourceFile(
      relativePath,
      sourceTextFile.text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(relativePath),
    );

    const reportSpecifier = (specifier: string, node: ts.Node): void => {
      if (!isLocalRelativeJavaScriptSpecifier(specifier)) {
        return;
      }

      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      violations.push({
        relativePath,
        specifier,
        line: line + 1,
        column: character + 1,
      });
    };

    const reportStaticSpecifierNode = (node: ts.Node): void => {
      const specifier = staticSpecifierText(node);
      if (specifier !== undefined) {
        reportSpecifier(specifier, node);
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        reportStaticSpecifierNode(node.moduleSpecifier);
      }

      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        reportStaticSpecifierNode(node.moduleSpecifier);
      }

      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0
      ) {
        reportStaticSpecifierNode(node.arguments[0]);
      }

      if (ts.isImportTypeNode(node)) {
        const argument = node.argument;
        if (ts.isLiteralTypeNode(argument)) {
          reportStaticSpecifierNode(argument.literal);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations.sort(compareLocalJavaScriptImportViolations);
}

function listRepositoryFiles(repositoryRoot: string): string[] {
  const listedFiles =
    listGitRepositoryFiles(repositoryRoot) ??
    walkRepositoryFiles(repositoryRoot);

  return sortUniquePaths(
    listedFiles
      .map(normalizeRepositoryPath)
      .filter((relativePath) => !isExcludedRepositoryPath(relativePath))
      .filter((relativePath) => isExistingFile(repositoryRoot, relativePath)),
  );
}

function listGitRepositoryFiles(repositoryRoot: string): string[] | undefined {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return output.split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
}

function walkRepositoryFiles(repositoryRoot: string): string[] {
  const files: string[] = [];

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRepositoryPath(
        path.relative(repositoryRoot, absolutePath),
      );

      if (isExcludedRepositoryPath(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };

  visit(repositoryRoot);
  return files;
}

function isExistingFile(repositoryRoot: string, relativePath: string): boolean {
  try {
    return statSync(path.join(repositoryRoot, relativePath)).isFile();
  } catch {
    return false;
  }
}

function normalizeRepositoryPath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isExcludedRepositoryPath(relativePath: string): boolean {
  const normalizedPath = normalizeRepositoryPath(relativePath);

  return EXCLUDED_DIRECTORY_PREFIXES.some((prefix) => {
    const directory = prefix.slice(0, -1);
    return normalizedPath === directory || normalizedPath.startsWith(prefix);
  });
}

function isTypeScriptFilePath(relativePath: string): boolean {
  return TYPESCRIPT_FILE_PATTERN.test(relativePath);
}

function isLocalRelativeJavaScriptSpecifier(specifier: string): boolean {
  return (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js")
  );
}

function staticSpecifierText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function scriptKindForPath(relativePath: string): ts.ScriptKind {
  if (relativePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  return ts.ScriptKind.TS;
}

function compareLocalJavaScriptImportViolations(
  left: LocalJavaScriptImportSpecifierViolation,
  right: LocalJavaScriptImportSpecifierViolation,
): number {
  return (
    left.relativePath.localeCompare(right.relativePath) ||
    left.line - right.line ||
    left.column - right.column ||
    left.specifier.localeCompare(right.specifier)
  );
}

function sortUniquePaths(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}
