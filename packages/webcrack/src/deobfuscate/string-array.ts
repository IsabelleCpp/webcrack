import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import {
  inlineArrayElements,
  isReadonlyObject,
  renameFast,
  undefinedMatcher,
} from '../ast-utils';
const generate = require('@babel/generator').default;

export interface StringArray {
  path: NodePath<t.Node>;
  references: NodePath<t.Node>[];
  name: string;
  originalName: string;
  length: number;
  definition?: string;
  foundBy?: 'function' | 'variable' | 'call' | 'expression';
}

function isSelfAssigningEmptyFunction(fn: t.FunctionDeclaration): boolean {
  if (!fn.id) return false;
  const body = fn.body;
  if (!t.isBlockStatement(body)) return false;
  if (body.body.length !== 1) return false;
  const stmt = body.body[0];
  if (!t.isExpressionStatement(stmt)) return false;
  const expr = stmt.expression;
  if (!t.isAssignmentExpression(expr)) return false;
  if (!t.isIdentifier(expr.left)) return false;
  if (expr.left.name !== fn.id.name) return false;
  if (!t.isFunctionExpression(expr.right)) return false;
  const rightFn = expr.right;
  if (!t.isBlockStatement(rightFn.body)) return false;
  if (rightFn.body.body.length !== 0) return false;
  return true;
}

function removeEmptyFunctionWrapper(ast: t.Node) {
  traverse(ast, {
    FunctionDeclaration(path) {
      const node = path.node;
      if (!isSelfAssigningEmptyFunction(node)) return;
      const fnName = node.id!.name;
      const binding = path.scope.getBinding(fnName);
      if (!binding || !binding.referencePaths || binding.referencePaths.length === 0) return;
      for (const refPath of binding.referencePaths.slice()) {
        const parent = refPath.parentPath;
        if (!parent) continue;
        if (parent.isCallExpression() && parent.node.callee === refPath.node) {
          const callExprPath = parent as NodePath<t.CallExpression>;
          const callParent = callExprPath.parentPath;
          if (!callParent) continue;
          if (callParent.isExpressionStatement()) {
            const args = callExprPath.node.arguments;
            const replacementStmts: t.Statement[] = [];
            for (const arg of args) {
              replacementStmts.push(t.expressionStatement(arg as t.Expression));
            }
            if (replacementStmts.length > 0) {
              callParent.replaceWithMultiple(replacementStmts);
            }
          }
        }
      }
      path.remove();
    },
  });
}

function inlineConstArrayAccesses(ast: t.Node) {
  traverse(ast, {
    MemberExpression(path) {
      const node = path.node;
      if (!node.computed) return;
      if (!t.isIdentifier(node.object)) return;

      const objName = node.object.name;
      const objBinding = path.scope.getBinding(objName);
      if (!objBinding) return;
      const bindingPath = objBinding.path;
      if (!bindingPath.isVariableDeclarator()) return;
      const parentDecl = bindingPath.parentPath;
      if (!parentDecl || !parentDecl.isVariableDeclaration()) return;
      if (parentDecl.node.kind !== 'const') return;
      const declarator = bindingPath.node;
      const init = declarator.init;
      if (!init || !t.isArrayExpression(init)) return;

      let idx: number | null = null;
      if (t.isNumericLiteral(node.property)) {
        idx = node.property.value;
      } else if (
        t.isUnaryExpression(node.property) &&
        node.property.operator === '-' &&
        t.isNumericLiteral(node.property.argument)
      ) {
        idx = -node.property.argument.value;
      } else {
        return;
      }

      const element = init.elements[idx];
      if (!element) return;

      path.replaceWith(t.cloneNode(element as t.Expression, true));
    },
  });

  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      if (!t.isIdentifier(id)) return;
      const name = id.name;
      const parentDecl = path.parentPath;
      if (!parentDecl || !parentDecl.isVariableDeclaration()) return;
      if (parentDecl.node.kind !== 'const') return;
      const init = path.node.init;
      if (!init || !t.isArrayExpression(init)) return;

      path.scope.crawl();
      const binding = path.scope.getBinding(name);

      if (!binding || binding.referencePaths.length === 0) {
        const declParent = parentDecl.isVariableDeclaration() ? parentDecl : null;
        path.remove();
        if (declParent && declParent.node && declParent.node.declarations.length === 0) {
          declParent.remove();
        }
      }
    },
  });
}

function getGlobalDefinitionsIncludingLaterAssignments(ast: t.Node): string {
  const defs: Map<string, t.Node> = new Map();
  const orderedKeys: string[] = [];

  function isWeakVarDecl(node: t.Node): boolean {
    if (!t.isVariableDeclaration(node)) return false;
    return node.declarations.every(d => !d.init);
  }

  function isStrongDefinition(node: t.Node): boolean {
    if (t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) return true;
    if (t.isVariableDeclaration(node)) {
      return node.declarations.some(d => !!d.init);
    }
    if (t.isExpressionStatement(node) && t.isAssignmentExpression(node.expression)) return true;
    return false;
  }

  traverse(ast, {
    Program(path) {
      for (const node of path.node.body) {
        if (t.isVariableDeclaration(node)) {
          for (const decl of node.declarations) {
            if (!t.isIdentifier(decl.id)) continue;
            const name = decl.id.name;
            if (!defs.has(name)) {
              defs.set(name, node);
              orderedKeys.push(name);
            } else {
              const existing = defs.get(name);
              if (existing && isWeakVarDecl(existing) && isStrongDefinition(node)) {
                defs.set(name, node);
              } else if (existing && t.isVariableDeclaration(existing) && node.kind === 'var') {
                defs.set(name, node);
              }
            }
          }
          continue;
        }

        if (t.isFunctionDeclaration(node) && node.id && t.isIdentifier(node.id)) {
          const name = node.id.name;
          if (!defs.has(name)) {
            defs.set(name, node);
            orderedKeys.push(name);
          } else {
            const existing = defs.get(name);
            if (existing && isWeakVarDecl(existing)) {
              defs.set(name, node);
            }
          }
          continue;
        }

        if (t.isClassDeclaration(node) && node.id && t.isIdentifier(node.id)) {
          const name = node.id.name;
          if (!defs.has(name)) {
            defs.set(name, node);
            orderedKeys.push(name);
          } else {
            const existing = defs.get(name);
            if (existing && isWeakVarDecl(existing)) {
              defs.set(name, node);
            }
          }
          continue;
        }

        if (t.isExpressionStatement(node) && t.isAssignmentExpression(node.expression)) {
          const assign = node.expression;
          if (t.isIdentifier(assign.left)) {
            const name = assign.left.name;
            if (!defs.has(name)) {
              defs.set(name, node);
              orderedKeys.push(name);
            } else {
              const existing = defs.get(name);
              if (existing && isWeakVarDecl(existing)) {
                defs.set(name, node);
              }
            }
            continue;
          }
          if (t.isMemberExpression(assign.left) && t.isIdentifier(assign.left.object) && !assign.left.computed) {
            const name = assign.left.object.name;
            if (!defs.has(name)) {
              defs.set(name, node);
              orderedKeys.push(name);
            } else {
              const existing = defs.get(name);
              if (existing && isWeakVarDecl(existing)) {
                defs.set(name, node);
              }
            }
            continue;
          }
        }

        if (t.isExportNamedDeclaration(node) || t.isExportDefaultDeclaration(node)) {
          if (node.declaration) {
            if (t.isVariableDeclaration(node.declaration)) {
              for (const decl of node.declaration.declarations) {
                if (!t.isIdentifier(decl.id)) continue;
                const name = decl.id.name;
                if (!defs.has(name)) {
                  defs.set(name, node.declaration);
                  orderedKeys.push(name);
                } else {
                  const existing = defs.get(name);
                  if (existing && isWeakVarDecl(existing) && isStrongDefinition(node.declaration)) {
                    defs.set(name, node.declaration);
                  }
                }
              }
            } else if ((t.isFunctionDeclaration(node.declaration) || t.isClassDeclaration(node.declaration)) && node.declaration.id) {
              const name = node.declaration.id.name;
              if (!defs.has(name)) {
                defs.set(name, node.declaration);
                orderedKeys.push(name);
              } else {
                const existing = defs.get(name);
                if (existing && isWeakVarDecl(existing)) {
                  defs.set(name, node.declaration);
                }
              }
            }
          } else {
            const code = generate(node).code;
            const key = `__export_${orderedKeys.length}`;
            defs.set(key, t.identifier(code) as unknown as t.Node);
            orderedKeys.push(key);
          }
        }
      }
      path.stop();
    },
  });

  const out: string[] = [];
  for (const key of orderedKeys) {
    const node = defs.get(key);
    if (!node) continue;
    if ((node as any).type === 'Identifier' && typeof (node as any).name === 'string' && (node as any).name.startsWith('export')) {
      out.push((node as any).name);
      continue;
    }
    out.push(generate(node).code);
  }

  return out.join('\n\n');
}



export function findStringArray(ast: t.Node): StringArray | undefined {
  let result: StringArray | undefined;

  const functionName = m.capture(m.anyString());
  const arrayIdentifier = m.capture(m.identifier());
  const arrayExpression = m.capture(
    m.arrayExpression(m.arrayOf(m.or(m.stringLiteral(), undefinedMatcher))),
  );

  const functionAssignment = m.assignmentExpression(
    '=',
    m.identifier(m.fromCapture(functionName)),
    m.functionExpression(
      undefined,
      [],
      m.blockStatement([m.returnStatement(m.fromCapture(arrayIdentifier))]),
    ),
  );

  const variableDeclaration = m.variableDeclaration(undefined, [
    m.variableDeclarator(arrayIdentifier, arrayExpression),
  ]);

  const matcher = m.functionDeclaration(
    m.identifier(functionName),
    [],
    m.or(
      m.blockStatement([
        variableDeclaration,
        m.returnStatement(m.callExpression(functionAssignment)),
      ]),
      m.blockStatement([
        variableDeclaration,
        m.expressionStatement(functionAssignment),
        m.returnStatement(m.callExpression(m.identifier(functionName))),
      ]),
    ),
  );

  traverse(ast, {
    FunctionDeclaration(path) {
      if (!matcher.match(path.node)) return;
      const arrNode = arrayExpression.current!;
      const length = arrNode.elements.length;
      if (length === 0) return;
      const fnName = functionName.current!;
      const fnBinding = path.scope.getBinding(fnName);
      if (!fnBinding) return;
      const originalName = fnName;
      renameFast(fnBinding, '__STRING_ARRAY__');
      result = {
        path,
        references: fnBinding.referencePaths,
        originalName,
        name: '__STRING_ARRAY__',
        length,
        foundBy: 'function',
      };
      path.stop();
    },

    VariableDeclaration(path) {
      if (!variableDeclaration.match(path.node)) return;
      const arrNode = arrayExpression.current!;
      const length = arrNode.elements.length;
      if (length === 0) return;
      const arrIdName = arrayIdentifier.current!.name;
      const binding = path.scope.getBinding(arrIdName);
      if (!binding) return;
      const memberAccess = m.memberExpression(
        m.fromCapture(arrayIdentifier),
        m.numericLiteral(m.matcher((value) => value < length)),
      );
      if (!binding.referenced || !isReadonlyObject(binding, memberAccess)) return;
      inlineArrayElements(arrNode, binding.referencePaths);
      path.remove();
      result = {
        path: binding.path as NodePath<t.Node>,
        references: binding.referencePaths,
        originalName: arrIdName,
        name: '__STRING_ARRAY__',
        length,
        foundBy: 'variable',
      };
      path.stop();
    },

    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;
      const fnName = callee.name;
      const fnBinding = path.scope.getBinding(fnName);
      if (!fnBinding || !fnBinding.path.isFunctionDeclaration()) return;

      const argWithArray = path.node.arguments.find((arg) => {
        if (t.isAssignmentExpression(arg)) {
          const right = arg.right;
          if (!t.isArrayExpression(right)) return false;
          return right.elements.length > 0 && right.elements.every(
            (el) =>
              el === null ||
              t.isStringLiteral(el) ||
              (t.isTemplateLiteral(el) && el.quasis.length === 1 && el.expressions.length === 0),
          );
        }
        if (t.isArrayExpression(arg)) {
          return arg.elements.length > 0 && arg.elements.every(
            (el) =>
              el === null ||
              t.isStringLiteral(el) ||
              (t.isTemplateLiteral(el) && el.quasis.length === 1 && el.expressions.length === 0),
          );
        }
        return false;
      }) as t.AssignmentExpression | t.ArrayExpression | undefined;

      if (!argWithArray) return;

      let arrayArg: t.ArrayExpression | undefined;
      if (t.isAssignmentExpression(argWithArray) && t.isArrayExpression(argWithArray.right)) {
        arrayArg = argWithArray.right;
      } else if (t.isArrayExpression(argWithArray)) {
        arrayArg = argWithArray;
      } else {
        const found = path.node.arguments.find((a) => t.isArrayExpression(a)) as t.ArrayExpression | undefined;
        if (found) arrayArg = found;
      }

      if (!arrayArg) return;
      const arr = arrayArg;
      const length = arr.elements.length;
      if (length === 0) return;

      let arrayId: t.Identifier | undefined;
      if (t.isAssignmentExpression(argWithArray) && t.isIdentifier(argWithArray.left)) {
        arrayId = argWithArray.left;
      } else {
        const idArg = path.node.arguments.find((a) => t.isIdentifier(a)) as t.Identifier | undefined;
        if (idArg) arrayId = idArg;
      }

      const originalName = arrayId ? arrayId.name : '__STRING_ARRAY__';
      const arrayBinding = arrayId ? path.scope.getBinding(originalName) : null;
      if (arrayBinding) renameFast(arrayBinding, '__STRING_ARRAY__');

      let cacheOriginal: string | undefined;
      let cacheBinding: any = null;

      for (const arg of path.node.arguments) {
        if (t.isAssignmentExpression(arg)) {
          if (t.isObjectExpression(arg.right) && arg.right.properties.length === 0 && t.isIdentifier(arg.left)) {
            cacheOriginal = arg.left.name;
            cacheBinding = path.scope.getBinding(cacheOriginal);
            if (cacheBinding) renameFast(cacheBinding, '__STRING_ARRAY_CACHE__');
            break;
          }
        } else if (t.isIdentifier(arg)) {
          const b = path.scope.getBinding(arg.name);
          if (b && b.path.isVariableDeclarator()) {
            const init = (b.path.node as t.VariableDeclarator).init;
            if (t.isObjectExpression(init) && init.properties.length === 0) {
              cacheOriginal = arg.name;
              cacheBinding = b;
              renameFast(cacheBinding, '__STRING_ARRAY_CACHE__');
              break;
            }
          }
        }
      }

      const arrayCode = generate(arr).code;
      const varName = '__STRING_ARRAY__';
      let definitionString = `var ${varName} = ${arrayCode};`;
      if (cacheOriginal) {
        const cacheVar = '__STRING_ARRAY_CACHE__';
        definitionString = `var ${cacheVar} = {}; ${definitionString}`;
      }

      result = {
        path: arrayBinding!.path as NodePath<t.Node>,
        references: arrayBinding ? arrayBinding.referencePaths : [],
        originalName,
        name: varName,
        length,
        foundBy: 'call',
        definition: definitionString,
      };
      
      cacheBinding!.path.remove();
      path.remove();
      path.stop();
    },

    ExpressionStatement(path) {
      const expr = path.node.expression;
      const exprs: t.Expression[] = [];
      if (t.isSequenceExpression(expr)) {
        for (const e of expr.expressions) exprs.push(e);
      } else {
        exprs.push(expr);
      }

      const arrExpr = exprs.find((e) => {
        if (t.isAssignmentExpression(e) && t.isArrayExpression(e.right)) {
          const right = e.right;
          return right.elements.length > 0 && right.elements.every(
            (el) =>
              el === null ||
              t.isStringLiteral(el) ||
              (t.isTemplateLiteral(el) && el.quasis.length === 1 && el.expressions.length === 0),
          );
        }
        if (t.isArrayExpression(e)) {
          const right = e;
          return right.elements.length > 0 && right.elements.every(
            (el) =>
              el === null ||
              t.isStringLiteral(el) ||
              (t.isTemplateLiteral(el) && el.quasis.length === 1 && el.expressions.length === 0),
          );
        }
        return false;
      }) as t.Expression | undefined;

      if (!arrExpr) return;

      let arrayId: t.Identifier | undefined;
      if (t.isAssignmentExpression(arrExpr) && t.isIdentifier(arrExpr.left)) {
        arrayId = arrExpr.left;
      } else {
        const idExpr = exprs.find((e) => t.isIdentifier(e)) as t.Identifier | undefined;
        if (idExpr) arrayId = idExpr;
      }

      const arr = t.isAssignmentExpression(arrExpr) && t.isArrayExpression(arrExpr.right)
        ? arrExpr.right
        : (t.isArrayExpression(arrExpr) ? arrExpr : undefined);

      if (!arr) return;
      const length = arr.elements.length;
      if (length === 0) return;

      const originalName = arrayId ? arrayId.name : '__STRING_ARRAY__';
      const arrayBinding = arrayId ? path.scope.getBinding(originalName) : null;
      if (arrayBinding) {
        renameFast(arrayBinding, '__STRING_ARRAY__');
        const anchorPath = arrayBinding.path.isVariableDeclarator()
          ? (arrayBinding.path as NodePath<t.Node>)
          : path;
        result = {
          path: anchorPath,
          references: arrayBinding.referencePaths,
          originalName,
          name: '__STRING_ARRAY__',
          length,
          foundBy: 'expression',
        };
      } else {
        result = {
          path,
          references: [],
          originalName,
          name: '__STRING_ARRAY__',
          length,
          foundBy: 'expression',
        };
      }

      let cacheOriginal: string | undefined;
      let cacheBinding: any = null;

      for (const e of exprs) {
        if (t.isAssignmentExpression(e)) {
          if (t.isObjectExpression(e.right) && e.right.properties.length === 0 && t.isIdentifier(e.left)) {
            cacheOriginal = e.left.name;
            cacheBinding = path.scope.getBinding(cacheOriginal);
            if (cacheBinding) renameFast(cacheBinding, '__STRING_ARRAY_CACHE__');
            break;
          }
        } else if (t.isIdentifier(e)) {
          const b = path.scope.getBinding(e.name);
          if (b && b.path.isVariableDeclarator()) {
            const init = (b.path.node as t.VariableDeclarator).init;
            if (t.isObjectExpression(init) && init.properties.length === 0) {
              cacheOriginal = e.name;
              cacheBinding = b;
              renameFast(cacheBinding, '__STRING_ARRAY_CACHE__');
              break;
            }
          }
        }
      }

      if (cacheOriginal) {
        const arrayCode = generate(arr).code;
        const varName = '__STRING_ARRAY__';
        const cacheVar = '__STRING_ARRAY_CACHE__';
        const definitionString = `var ${cacheVar} = {}; var ${varName} = ${arrayCode};`;
        if (result) result.definition = definitionString;
      }

      path.stop();
    },
  });
  
  removeEmptyFunctionWrapper(ast);
  inlineConstArrayAccesses(ast);

  // const globalDefs = getGlobalDefinitionsIncludingLaterAssignments(ast);
  // if (globalDefs && globalDefs.trim().length && result) {
  //   result.definition += '\n\n' + globalDefs;
  // }

  return result;
}
