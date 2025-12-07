import { expression } from '@babel/template';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import {
  inlineVariable,
  renameFast
} from '../ast-utils';

/**
 * Inline computed accesses of const arrays within a given path.
 * Example: const A = ["a","b"]; ... A[1] -> "b"
 *
 * Only inlines when:
 * - The object is an Identifier
 * - The identifier resolves to a VariableDeclarator whose kind is 'const'
 * - The initializer is an ArrayExpression
 * - The property is a numeric literal or a simple unary negative numeric literal
 */
function inlineConstArrayAccesses(root: NodePath<t.Node>) {
  root.traverse({
    MemberExpression(path) {
      const node = path.node;
      if (!node.computed) return;
      if (!t.isIdentifier(node.object)) return;

      const objName = node.object.name;
      const objBinding = path.scope.getBinding(objName);
      if (!objBinding) return;

      // Ensure the binding is a const variable declarator with an array initializer
      const bindingPath = objBinding.path;
      if (!bindingPath.isVariableDeclarator()) return;

      // Check parent variable declaration kind is const
      const parentDecl = bindingPath.parentPath;
      if (!parentDecl || !parentDecl.isVariableDeclaration()) return;
      if (parentDecl.node.kind !== 'const') return;

      const declarator = bindingPath.node;
      const init = declarator.init;
      if (!init || !t.isArrayExpression(init)) return;

      // resolve numeric index (supports simple unary negative)
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

      // support out-of-range checks: if element undefined, skip inlining
      const element = init.elements[idx];
      if (!element) return;

      // replace with the array element (clone to avoid reusing nodes)
      path.replaceWith(t.cloneNode(element as t.Expression, /* deep */ true));
    },
  });
}

/**
 * A function that is called with >= 1 numeric/string arguments
 * and returns a string from the string array. It may also decode
 * the string with Base64 or RC4.
 */
export class Decoder {
  originalName: string;
  name: string;
  path: NodePath<t.FunctionDeclaration>;
  calleePath: NodePath<t.FunctionDeclaration> | null;
  dependencyPaths: NodePath<t.FunctionDeclaration>[];

  constructor(
    originalName: string,
    name: string,
    path: NodePath<t.FunctionDeclaration>,
    calleePath: NodePath<t.FunctionDeclaration> | null = null,
    dependencyPaths: NodePath<t.FunctionDeclaration>[] = [],
  ) {
    this.originalName = originalName;
    this.name = name;
    this.path = path;
    this.calleePath = calleePath;
    this.dependencyPaths = dependencyPaths;
  }

  collectCalls(): NodePath<t.CallExpression>[] {
    const calls: NodePath<t.CallExpression>[] = [];

    // Inline const-array accesses inside the decoder's function scope first
    inlineConstArrayAccesses(this.path);

    const literalArgument: m.Matcher<t.Expression> = m.or(
      m.binaryExpression(
        m.anything(),
        m.matcher((node) => literalArgument.match(node)),
        m.matcher((node) => literalArgument.match(node)),
      ),
      m.unaryExpression(
        '-',
        m.matcher((node) => literalArgument.match(node)),
      ),
      m.numericLiteral(),
      m.stringLiteral(),
    );

    const literalCall = m.callExpression(
      m.identifier(this.name),
      m.arrayOf(literalArgument),
    );
    const expressionCall = m.callExpression(
      m.identifier(this.name),
      m.arrayOf(m.anyExpression()),
    );

    const conditional = m.capture(m.conditionalExpression());
    const conditionalCall = m.callExpression(m.identifier(this.name), [
      conditional,
    ]);

    const buildExtractedConditional = expression`TEST ? CALLEE(CONSEQUENT) : CALLEE(ALTERNATE)`;

    const binding = this.path.scope.getBinding(this.name)!;
    for (const ref of binding.referencePaths) {
      // Also inline const-array accesses at each reference's parent scope to catch arrays declared outside
      if (ref.parentPath) inlineConstArrayAccesses(ref.parentPath);

      if (conditionalCall.match(ref.parent)) {
        // decode(test ? 1 : 2) -> test ? decode(1) : decode(2)
        const [replacement] = ref.parentPath!.replaceWith(
          buildExtractedConditional({
            TEST: conditional.current!.test,
            CALLEE: ref.parent.callee,
            CONSEQUENT: conditional.current!.consequent,
            ALTERNATE: conditional.current!.alternate,
          }),
        );
        replacement.scope.crawl();
        continue;
      } else if (literalCall.match(ref.parent)) {
        calls.push(ref.parentPath as NodePath<t.CallExpression>);
      } else if (expressionCall.match(ref.parent)) {
        // After inlining const arrays above, try again to inline member expressions inside this call
        ref.parentPath!.traverse({
          MemberExpression(path) {
            const node = path.node;
            // only handle computed member expressions with identifier object
            if (!node.computed || !t.isIdentifier(node.object)) return;

            const objName = node.object.name;
            const objBinding = path.scope.getBinding(objName);
            if (!objBinding) return;

            const declarator = objBinding.path.node;
            if (!t.isVariableDeclarator(declarator)) return;
            const init = declarator.init;
            if (!t.isArrayExpression(init)) return;

            // resolve numeric index (supports simple unary negative)
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

            // replace with the array element (clone to avoid reusing nodes)
            path.replaceWith(t.cloneNode(element as t.Expression, /* deep */ true));
          },
        });

        // Then: inline simple variables so decode(n) -> decode(1)
        ref.parentPath!.traverse({
          ReferencedIdentifier(path) {
            const varBinding = path.scope.getBinding(path.node.name)!;
            if (!varBinding) return;
            inlineVariable(varBinding, literalArgument, true);
          },
        });

        if (literalCall.match(ref.parent)) {
          calls.push(ref.parentPath as NodePath<t.CallExpression>);
        }
      } else if (ref.parentPath?.isExpressionStatement()) {
        // `decode;` may appear on it's own in some forked obfuscators
        ref.parentPath.remove();
      }
    }

    // Inline const-array accesses in callee and dependency paths as well so the IIFE cloning sees literals
    if (this.calleePath) inlineConstArrayAccesses(this.calleePath);
    for (const dep of this.dependencyPaths) inlineConstArrayAccesses(dep);
    
    // If we have a calleePath (the actual function that does decoding) or at least the decoder function path,
    // prepare a FunctionExpression and dependency clones to inline at each call site.
    const calleeFnPath = this.calleePath ?? (this.path.isFunctionDeclaration() ? (this.path as NodePath<t.FunctionDeclaration>) : null);
    let calleeFnNode: t.FunctionDeclaration | null = null;
    if (calleeFnPath && t.isFunctionDeclaration(calleeFnPath.node)) {
      calleeFnNode = calleeFnPath.node;
    } else if (this.path && t.isFunctionDeclaration(this.path.node)) {
      calleeFnNode = this.path.node;
    }

    // Helper to collect dependency function declarations (cloned)
    const clonedDependencies: t.FunctionDeclaration[] = [];
    for (const depPath of this.dependencyPaths) {
      if (depPath && t.isFunctionDeclaration(depPath.node)) {
        clonedDependencies.push(t.cloneNode(depPath.node, /* deep */ true) as t.FunctionDeclaration);
      }
    }

  // Ensure we have the callee path/node
  if (calleeFnPath && calleeFnNode) {
    // Clone dependency declarations (FunctionDeclaration nodes)
    const clonedDepDecls = clonedDependencies.map((fnDecl) =>
      t.cloneNode(fnDecl, /* deep */ true) as t.FunctionDeclaration,
    );

    // Build a new BlockStatement for the callee that starts with the cloned deps
    const originalBody = (calleeFnNode.body as t.BlockStatement).body;
    const newBody = t.blockStatement([...clonedDepDecls, ...originalBody]);

    // Create a replacement function node that preserves flags (async/generator) and id/params
    let replacementFn: t.FunctionDeclaration | t.FunctionExpression;

    if (t.isFunctionDeclaration(calleeFnNode)) {
      replacementFn = t.functionDeclaration(
        // keep the same id (name)
        calleeFnNode.id ? t.cloneNode(calleeFnNode.id, true) as t.Identifier : null,
        // clone params
        calleeFnNode.params.map((p) => t.cloneNode(p, true) as t.Identifier | t.Pattern),
        // new body
        newBody,
        // generator
        calleeFnNode.generator,
        // async
        calleeFnNode.async,
      );
      // Replace the original callee node in-place
      calleeFnPath.replaceWith(replacementFn);
    }
  }
    return calls;
  }
}

/* --- findDecoders: call inlineConstArrayAccesses early so decoder detection sees literal array elements --- */

export interface StringArray {
  path: NodePath<t.Node>;
  references: NodePath<t.Node>[];
  name: string; // e.g. '__STRING_ARRAY__'
  originalName: string; // e.g. 'rPex3CI'
  length: number;
  /** Optional JS source string that defines the array, e.g. `var __STRING_ARRAY__ = ["a","b"];` */
  definition?: string;
  foundBy?: 'function' | 'variable' | 'call' | 'expression';
}

export function findDecoders(
  stringArray: StringArray,
  logger?: (msg: string) => void,
): Decoder[] {
  const decoders: Decoder[] = [];
  logger?.(`findDecoders: starting; originalName=${stringArray.originalName}, currentName=${stringArray.name}, refs=${stringArray.references.length}`);

  function getFunctionName(fnPath: NodePath<t.Node>): string | null {
    if (fnPath.isFunctionDeclaration() && fnPath.node && t.isFunctionDeclaration(fnPath.node) && fnPath.node.id && t.isIdentifier(fnPath.node.id)) {
      return fnPath.node.id.name;
    }
    const parent = fnPath.parentPath;
    if (parent && parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
      return parent.node.id.name;
    }
    return null;
  }

  function isMemberAccessWithParam(node: t.Node | null | undefined, paramName: string): node is t.MemberExpression {
    if (!node) return false;
    if (!t.isMemberExpression(node)) return false;
    if (node.computed) {
      return t.isIdentifier(node.property) && node.property.name === paramName;
    }
    return t.isIdentifier(node.property) && node.property.name === paramName;
  }

  function matchesStringArrayObject(obj: t.Expression | t.PrivateName | null | undefined, scope: NodePath['scope']): boolean {
    if (!obj) return false;
    if (!t.isIdentifier(obj)) return false;

    if (obj.name === stringArray.originalName || obj.name === stringArray.name) {
      logger?.(`matchesStringArrayObject: name match (${obj.name})`);
      return true;
    }

    try {
      const objBinding = scope.getBinding(obj.name);
      const arrBindingByOriginal = scope.getBinding(stringArray.originalName);
      const arrBindingByCurrent = scope.getBinding(stringArray.name);

      if (objBinding && (arrBindingByOriginal && objBinding === arrBindingByOriginal)) {
        logger?.(`matchesStringArrayObject: binding matches originalName (${stringArray.originalName})`);
        return true;
      }
      if (objBinding && (arrBindingByCurrent && objBinding === arrBindingByCurrent)) {
        logger?.(`matchesStringArrayObject: binding matches currentName (${stringArray.name})`);
        return true;
      }

      if (stringArray.path && t.isIdentifier((stringArray.path.node as any).id)) {
        const arrId = (stringArray.path.node as any).id as t.Identifier;
        const arrBinding = stringArray.path.scope.getBinding(arrId.name);
        if (objBinding && arrBinding && objBinding === arrBinding) {
          logger?.(`matchesStringArrayObject: binding matches stringArray.path binding (${arrId.name})`);
          return true;
        }
      }
    } catch (e) {
      logger?.(`matchesStringArrayObject: binding check error: ${(e as Error).message}`);
    }

    logger?.(`matchesStringArrayObject: no match for object ${obj.name}`);
    return false;
  }

  for (const ref of stringArray.references) {
    logger?.(`findDecoders: examining reference node type=${ref.node.type} at ${ref.node.start ?? 'unknown'}`);

    // Inline const-array accesses at the reference site to make subsequent detection easier
    if (ref.parentPath) inlineConstArrayAccesses(ref.parentPath);

    const fnPath = ref.findParent((p) =>
      p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression(),
    ) as NodePath<t.Node> | null;

    if (!fnPath) {
      logger?.('findDecoders: no enclosing function for this reference');
      continue;
    }

    logger?.(`findDecoders: found enclosing function node type=${fnPath.node.type}`);

    const params = (fnPath.node as any).params as t.Function['params'] | undefined;
    if (!params || params.length === 0) {
      logger?.('findDecoders: function has no params — skipping');
      continue;
    }
    const firstParam = params[0];
    if (!t.isIdentifier(firstParam)) {
      logger?.('findDecoders: first param is not identifier — skipping');
      continue;
    }
    const paramName = firstParam.name;
    logger?.(`findDecoders: function param name=${paramName}`);

    let found = false;
    let decoderCalleeName: string | null = null;
    let calleePath: NodePath<t.FunctionDeclaration> | null = null;
    const dependencyPaths: NodePath<t.FunctionDeclaration>[] = [];

    // New approach: scan function body for calls that take array access (now possibly inlined) as argument
    if (fnPath.node && t.isBlockStatement((fnPath.node as any).body)) {
      const stmts = ((fnPath.node as any).body as t.BlockStatement).body;

      for (let i = 0; i < stmts.length && !found; i++) {
        const stmt = stmts[i];

        let stop = false;
        (function traverseNode(node: t.Node) {
          if (stop) return;
          if (t.isCallExpression(node)) {
            const argIsArrayAccess = node.arguments.find((a) => {
              if (!t.isMemberExpression(a)) return false;
              const ma = a as t.MemberExpression;
              if (!t.isIdentifier(ma.object)) return false;
              return matchesStringArrayObject(ma.object, ref.scope);
            });

            if (argIsArrayAccess) {
              if (t.isIdentifier(node.callee)) {
                decoderCalleeName = node.callee.name;
                logger?.(`findDecoders: decoder call ${decoderCalleeName} detected`);
                found = true;
                stop = true;
                return;
              } else if (t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property)) {
                decoderCalleeName = node.callee.property.name;
                logger?.(`findDecoders: decoder call (member) ${decoderCalleeName} detected`);
                found = true;
                stop = true;
                return;
              }
            }
          }

          for (const key of Object.keys(node) as (keyof t.Node)[]) {
            const child = (node as any)[key];
            if (Array.isArray(child)) {
              for (const c of child) {
                if (c && typeof c.type === 'string') traverseNode(c);
                if (stop) return;
              }
            } else if (child && typeof child.type === 'string') {
              traverseNode(child);
              if (stop) return;
            }
          }
        })(stmt);
      }
    }

    if (!found) {
      logger?.('findDecoders: no decoder pattern found in this function (new scan)');
      continue;
    }

    // Resolve callee binding and dependencies (same as previous logic)
    if (decoderCalleeName) {
      try {
        const calleeBinding = fnPath.scope.getBinding(decoderCalleeName);
        if (calleeBinding && calleeBinding.path && (calleeBinding.path.isFunctionDeclaration() || calleeBinding.path.isFunctionExpression())) {
          if (calleeBinding.path.isFunctionDeclaration()) {
            calleePath = calleeBinding.path as NodePath<t.FunctionDeclaration>;
          } else {
            // best-effort: try to find a function declaration equivalent or leave calleePath null
            const parent = calleeBinding.path.parentPath;
            if (parent && parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
              const maybeFnDecl = parent.scope.getBinding(parent.node.id.name);
              if (maybeFnDecl && maybeFnDecl.path && maybeFnDecl.path.isFunctionDeclaration()) {
                calleePath = maybeFnDecl.path as NodePath<t.FunctionDeclaration>;
              } else {
                calleePath = null;
              }
            }
          }
        }
      } catch (e) {
        logger?.(`findDecoders: error resolving callee binding: ${(e as Error).message}`);
      }
    }

    if (calleePath) {
      try {
        calleePath.traverse({
          CallExpression(callPath) {
            const callee = callPath.node.callee;
            if (t.isIdentifier(callee)) {
              const depBinding = callPath.scope.getBinding(callee.name);
              if (depBinding && depBinding.path) {
                if (depBinding.path.isFunctionDeclaration()) {
                  dependencyPaths.push(depBinding.path as NodePath<t.FunctionDeclaration>);
                } else if (depBinding.path.isVariableDeclarator()) {
                  const init = depBinding.path.node.init;
                  if (init && t.isFunctionExpression(init)) {
                    const maybeDecl = depBinding.path.scope.getBinding(depBinding.path.node.id && t.isIdentifier(depBinding.path.node.id) ? depBinding.path.node.id.name : '');
                    if (maybeDecl && maybeDecl.path && maybeDecl.path.isFunctionDeclaration()) {
                      dependencyPaths.push(maybeDecl.path as NodePath<t.FunctionDeclaration>);
                    }
                  }
                }
              }
            }
          },
        });
      } catch (e) {
        logger?.(`findDecoders: error scanning callee for dependencies: ${(e as Error).message}`);
      }
    }

    const oldName = getFunctionName(fnPath);
    const newName = `__DECODE_${decoders.length}__`;

    if (oldName) {
      const binding = fnPath.scope.getBinding(oldName);
      if (binding) {
        logger?.(`findDecoders: renaming decoder ${oldName} -> ${newName}`);
        renameFast(binding, newName);

        let calleePathToStore: NodePath<t.FunctionDeclaration> | null = null;
        if (decoderCalleeName) {
          const calleeBinding = fnPath.scope.getBinding(decoderCalleeName);
          if (calleeBinding && calleeBinding.path && calleeBinding.path.isFunctionDeclaration()) {
            const calleeOldName = decoderCalleeName;
            const calleeNewName = `__DECODE_CALLEE_${decoders.length}__`;
            logger?.(`findDecoders: renaming callee ${calleeOldName} -> ${calleeNewName}`);
            renameFast(calleeBinding, calleeNewName);
            calleePathToStore = calleeBinding.path as NodePath<t.FunctionDeclaration>;
          }
        }

        const depPathsToStore: NodePath<t.FunctionDeclaration>[] = [];
        for (const dep of dependencyPaths) {
          if (dep && dep.node && t.isFunctionDeclaration(dep.node) && dep.node.id && t.isIdentifier(dep.node.id)) {
            const depBinding = dep.scope.getBinding(dep.node.id.name);
            if (depBinding) {
              const depNewName = `__DECODE_DEP_${decoders.length}_${dep.node.id.name}`;
              logger?.(`findDecoders: renaming dependency ${dep.node.id.name} -> ${depNewName}`);
              renameFast(depBinding, depNewName);
              const updated = dep.scope.getBinding(depNewName);
              if (updated && updated.path && updated.path.isFunctionDeclaration()) {
                depPathsToStore.push(updated.path as NodePath<t.FunctionDeclaration>);
              }
            }
          }
        }

        decoders.push(new Decoder(oldName, newName, fnPath as NodePath<t.FunctionDeclaration>, calleePathToStore, depPathsToStore));
        continue;
      }
    }

    const fallbackOldName = oldName ?? decoderCalleeName ?? `decoder_${decoders.length}`;
    logger?.(`findDecoders: pushing decoder (fallback name) ${fallbackOldName} -> ${newName}`);

    let calleePathToStore: NodePath<t.FunctionDeclaration> | null = null;
    if (decoderCalleeName) {
      try {
        const calleeBinding = fnPath.scope.getBinding(decoderCalleeName);
        if (calleeBinding && calleeBinding.path && calleeBinding.path.isFunctionDeclaration()) {
          const calleeNewName = `__DECODE_CALLEE_${decoders.length}__`;
          logger?.(`findDecoders: renaming callee ${decoderCalleeName} -> ${calleeNewName}`);
          renameFast(calleeBinding, calleeNewName);
          calleePathToStore = calleeBinding.path as NodePath<t.FunctionDeclaration>;
        }
      } catch (e) {
        logger?.(`findDecoders: error renaming callee: ${(e as Error).message}`);
      }
    }

    const depPathsToStore: NodePath<t.FunctionDeclaration>[] = [];
    for (const dep of dependencyPaths) {
      if (dep && dep.node && t.isFunctionDeclaration(dep.node) && dep.node.id && t.isIdentifier(dep.node.id)) {
        const depBinding = dep.scope.getBinding(dep.node.id.name);
        if (depBinding) {
          const depNewName = `__DECODE_DEP_${decoders.length}_${dep.node.id.name}`;
          logger?.(`findDecoders: renaming dependency ${dep.node.id.name} -> ${depNewName}`);
          renameFast(depBinding, depNewName);
          const updated = dep.scope.getBinding(depNewName);
          if (updated && updated.path && updated.path.isFunctionDeclaration()) {
            depPathsToStore.push(updated.path as NodePath<t.FunctionDeclaration>);
          }
        }
      }
    }

    decoders.push(new Decoder(fallbackOldName, newName, fnPath as NodePath<t.FunctionDeclaration>, calleePathToStore, depPathsToStore));
  } // end for references

  logger?.(`findDecoders: finished; found ${decoders.length} decoder(s)`);
  return decoders;
}
