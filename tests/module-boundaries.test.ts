import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const coreDirectory = resolve(root, 'packages/core/src');

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) :
      entry.isFile() && ['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(extname(path)) ? [path] : [];
  }));
  return nested.flat().sort();
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function visit(node: ts.Node, action: (node: ts.Node) => void): void {
  action(node);
  node.forEachChild(child => visit(child, action));
}

function moduleSpecifiers(source: ts.SourceFile): string[] {
  const result: string[] = [];
  visit(source, node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      result.push(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0];
      assert.ok(argument && ts.isStringLiteralLike(argument), 'Dynamic module paths are not allowed in pure core.');
      result.push(argument.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)) result.push(node.argument.literal.text);
  });
  return result;
}

test('core has only local domain imports and the approved date library', async () => {
  const paths = await sourceFiles(coreDirectory);
  assert.ok(paths.length > 0, 'The domain source must exist.');
  for (const path of paths) {
    const source = parse(path, await readFile(path, 'utf8'));
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier === 'luxon') continue;
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'),
        relative(root, path) + ' must not depend on ' + specifier);
      const destination = resolve(dirname(path), specifier);
      const scoped = relative(coreDirectory, destination);
      assert.ok(scoped !== '..' && !scoped.startsWith('..' + sep) && !resolve(destination).startsWith('\\\\'),
        'Core import escapes its domain directory: ' + specifier);
    }
  }
  const manifest = JSON.parse(await readFile(resolve(root, 'packages/core/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const dependency of Object.keys({
    ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies,
  })) {
    assert.equal(dependency, 'luxon', 'Core must not acquire an infrastructure dependency.');
  }
});

test('core cannot perform HTTP, browser, database, or environment-driven work through globals', async () => {
  const forbidden = new Set([
    'fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest',
    'process', 'Deno', 'Bun', 'navigator', 'document', 'window',
    'eval', 'Function',
  ]);
  for (const path of await sourceFiles(coreDirectory)) {
    const source = parse(path, await readFile(path, 'utf8'));
    visit(source, node => {
      if (ts.isIdentifier(node) && forbidden.has(node.text)) {
        assert.fail(relative(root, path) + ' references forbidden infrastructure global ' + node.text);
      }
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) &&
          forbidden.has(node.argumentExpression.text)) {
        assert.fail(relative(root, path) + ' accesses forbidden infrastructure global ' + node.argumentExpression.text);
      }
    });
  }
});

test('real company and Notion adapters remain unconditional disabled stubs', async () => {
  const cases = [
    { file: 'company.ts', name: 'UnverifiedCompanyAdapter', methods: ['listMembers'] },
    { file: 'notion.ts', name: 'UnverifiedNotionAdapter',
      methods: ['ensureMemberPage', 'awaitTemplate', 'fillMemberPage', 'readMembers', 'isMemberPageReady', 'readCalendar', 'writeCalendar'] },
  ];
  for (const entry of cases) {
    const path = resolve(root, 'packages/engine/src', entry.file);
    const source = parse(path, await readFile(path, 'utf8'));
    const declaration = source.statements.find(statement =>
      ts.isClassDeclaration(statement) && statement.name?.text === entry.name);
    assert.ok(declaration && ts.isClassDeclaration(declaration), entry.name + ' must exist.');
    assert.ok(!declaration.heritageClauses?.some(clause => clause.token === ts.SyntaxKind.ExtendsKeyword),
      'Disabled adapters must not run an inherited connection constructor.');
    const methodNames: string[] = [];
    for (const member of declaration.members) {
      assert.ok(ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name),
        'Disabled adapters must contain only their fail-closed methods.');
      methodNames.push(member.name.text);
      assert.equal(member.body?.statements.length, 1);
      const statement = member.body!.statements[0]!;
      assert.ok(ts.isThrowStatement(statement) && statement.expression &&
        ts.isNewExpression(statement.expression) &&
        ts.isIdentifier(statement.expression.expression) &&
        statement.expression.expression.text === 'ExternalAdapterDisabledError',
      entry.name + '.' + member.name.text + ' must throw before doing any work.');
      assert.equal(statement.expression.arguments?.length ?? 0, 0);
    }
    assert.deepEqual(methodNames.sort(), [...entry.methods].sort());
  }
});

test('the mock mode guard rejects real mode and external enablement without accessing real environment or adapters', async () => {
  const path = resolve(root, 'packages/engine/src/ports.ts');
  const source = parse(path, await readFile(path, 'utf8'));
  const selected = source.statements.filter(statement =>
    (ts.isClassDeclaration(statement) && statement.name?.text === 'ExternalAdapterDisabledError') ||
    (ts.isFunctionDeclaration(statement) && statement.name?.text === 'assertMockMode'));
  assert.equal(selected.length, 2, 'The disabled error and mode guard must exist.');
  // Evaluate only the two declarations read above in a sandbox with synthetic env.
  // No engine imports, database initialization, network APIs, or host env are exposed.
  const declarations = selected.map(statement => statement.getText(source).replace(/^export\s+/, '')).join('\n');
  const javascript = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText + '\nassertMockMode();';
  for (const environment of [{}, { ADAPTER_MODE: 'mock', EXTERNAL_CONNECTIONS_ENABLED: 'false' }]) {
    assert.doesNotThrow(() => runInNewContext(javascript, { process: { env: environment } }, { timeout: 1_000 }));
  }
  for (const environment of [
    { ADAPTER_MODE: 'real' },
    { ADAPTER_MODE: 'production' },
    { EXTERNAL_CONNECTIONS_ENABLED: 'true' },
    { ADAPTER_MODE: 'mock', EXTERNAL_CONNECTIONS_ENABLED: 'true' },
  ]) {
    assert.throws(() => runInNewContext(javascript, { process: { env: environment } }, { timeout: 1_000 }),
      (error: unknown) => typeof error === 'object' && error !== null &&
        'name' in error && error.name === 'ExternalAdapterDisabledError');
  }
});
